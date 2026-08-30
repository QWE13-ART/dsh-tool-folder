/**
 * semantic.js — local semantic retrieval leg via Ollama bge-m3 (2026-08-30).
 *
 * Complements the BM25 lexical leg (bm25.js) with a cross-lingual semantic
 * leg: Chinese intents can hit English-only tool/skill descriptions that
 * share no surface tokens (the documented BM25 gap). Uses the machine's
 * local Ollama (`http://127.0.0.1:11434/api/embed`, model bge-m3 — 1024 dims,
 * ~1.2GB, already installed per ~/.dsh config). No npm deps, no network egress.
 *
 * Hard-fail design: every external path (fetch, fs cache) is optional. If
 * Ollama is down, the cache is unreadable, or anything throws, callers get
 * null/[] and their existing BM25 path just keeps working.
 *
 * Cache: document embeddings are keyed by text and persisted to
 * `~/.dsh/state/semantic-cache.json` (fingerprint = hash of all doc texts), so
 * the ~10s cold start for 300+ tools happens once, not per session.
 * Query embeddings are cached in memory only (per-process, tiny).
 */

const OLLAMA_BASE = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "bge-m3";
const EMBED_TIMEOUT_MS = 8000;
const CACHE_FILE = ".dsh/state/semantic-cache.json";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/* ------------------------------------------------------------------ */
/* hash + fs helpers (all fail-safe)                                   */
/* ------------------------------------------------------------------ */

/** FNV-1a 32-bit hex — fast, dependency-free fingerprint. */
function hash(text) {
  let h = 0x811c9dc5;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** sha1 hex — per-doc content fingerprint for incremental diff (v0.2.2). */
function sha1(text) {
  try {
    return crypto.createHash("sha1").update(String(text || ""), "utf8").digest("hex");
  } catch {
    return hash(text); // node:crypto 不可用时的降级指纹
  }
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function defaultCachePath() {
  return homeDir() + "/" + CACHE_FILE;
}

function readCacheFileAt(p) {
  try {
    if (!p || !fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return j;
  } catch {
    /* unreadable → miss */
  }
  return null;
}

function writeCacheFileAt(p, obj) {
  try {
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj), "utf8");
  } catch {
    /* cache write is best-effort */
  }
}

/* ------------------------------------------------------------------ */
/* Ollama embedding (fail-safe fetch)                                  */
/* ------------------------------------------------------------------ */

let _model = DEFAULT_MODEL;
let _base = OLLAMA_BASE;

/**
 * Configure the endpoint (called by plugin apply with cfg.ollamaBase/model).
 * @param {{ollamaBase?: string, embedModel?: string}} cfg
 */
export function configureSemantic(cfg = {}) {
  if (cfg && typeof cfg === "object") {
    if (typeof cfg.ollamaBase === "string" && cfg.ollamaBase) _base = cfg.ollamaBase;
    if (typeof cfg.embedModel === "string" && cfg.embedModel) _model = cfg.embedModel;
  }
}

/** One embedding vector for a text, or null on any failure. */
export async function embedText(text, timeoutMs = EMBED_TIMEOUT_MS) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(_base + "/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: _model, input: s }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const j = await res.json();
      const v = j?.embeddings?.[0];
      return Array.isArray(v) && v.length > 0 ? v : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null; // offline / timeout / bad response → lexical leg only
  }
}

/** Cosine similarity in [0,1] (both vectors plain arrays). */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ------------------------------------------------------------------ */
/* Semantic index with persistent doc-embedding cache                  */
/* ------------------------------------------------------------------ */

/**
 * Build a semantic index over docs with content-fingerprint incremental diff
 * (v0.2.2). Doc embeddings come from the on-disk cache when the per-doc
 * fingerprint (sha1 of id+text) matches; otherwise they are recomputed and
 * the cache is patched incrementally — tools that didn't change are never
 * re-embedded (the old code rebuilt the whole index on any set change).
 *
 * Any failure returns an index whose vectors are simply empty (lexical leg
 * still works). Short-circuits on an overall deadline and only persists the
 * cache on full success, so a half-built/offline run can never corrupt the
 * prior cache.
 *
 * @param {Array<{id: string, text: string}>} docs
 * @param {number} [timeoutMs] per-embed timeout
 * @param {{embed?: Function, cacheFile?: string}} [opts]
 *   - embed:      injectable embedding fn(text, timeoutMs)->vector|null (tests);
 *                 defaults to embedText (real Ollama).
 *   - cacheFile:  explicit cache path (tests use a temp file; never touch the
 *                 real ~/.dsh/state unless omitted).
 * @returns {Promise<{vectors: Map<string, number[]>, available: boolean}>}
 */
export async function buildSemanticIndex(docs, timeoutMs = EMBED_TIMEOUT_MS, opts = {}) {
  const out = { vectors: new Map(), available: false };
  const list = Array.isArray(docs) ? docs.filter((d) => d && d.id && d.text) : [];
  if (list.length === 0) return out;

  const embed = typeof opts.embed === "function" ? opts.embed : embedText;
  const cachePath = opts.cacheFile || defaultCachePath();

  // Per-doc content fingerprint: sha1 of id+text (name+description). A doc
  // whose text changed gets a new fp → only that doc is re-embedded.
  const fpOf = (d) => sha1(d.id + "\u0000" + d.text);

  const cache = readCacheFileAt(cachePath);
  // Liveness/lock: cache is only reusable if the provider/model that produced
  // it equals the currently configured ones. Any mismatch (or old whole-index
  // format, which has no .model) → full invalidation reconstruction.
  const modelMatch =
    cache && cache.model &&
    cache.model.model === _model && cache.model.base === _base &&
    cache.docs && typeof cache.docs === "object";
  const cachedDocs = modelMatch ? cache.docs : null;

  // Embed every doc whose fingerprint misses the cache; reuse cached vectors.
  const fresh = {}; // id -> vector, only for newly embedded
  const deadline = Date.now() + 60_000;
  for (const d of list) {
    if (Date.now() > deadline) break;
    let v = null;
    if (cachedDocs) {
      const hit = cachedDocs[fpOf(d)];
      if (hit && Array.isArray(hit.vec) && hit.vec.length > 0 && hit.id === d.id) {
        v = hit.vec; // unchanged → reuse cache, zero Ollama calls
      }
    }
    if (!v) {
      v = await embed(d.text, timeoutMs);
      if (v) fresh[d.id] = v;
    }
    if (v) out.vectors.set(d.id, v);
  }

  if (out.vectors.size === list.length) {
    out.available = true;
    // Rebuild the docs map: keep reusable cached entries + newly embedded,
    // dropping docs no longer in `list` (tool removal handled by set change).
    const newDocs = {};
    for (const d of list) {
      const fp = fpOf(d);
      const hit = cachedDocs && cachedDocs[fp];
      if (hit && Array.isArray(hit.vec) && hit.vec.length > 0) {
        newDocs[fp] = { id: d.id, vec: hit.vec };
      } else if (fresh[d.id]) {
        newDocs[fp] = { id: d.id, vec: fresh[d.id] };
      }
    }
    writeCacheFileAt(cachePath, { model: { base: _base, model: _model }, docs: newDocs });
  }
  return out;
}

/**
 * Rank docs by semantic similarity to a query.
 * @param {Map<string, number[]>} vectors  id → vector
 * @param {Array<{id: string, text: string}>} docs
 * @param {string} query
 * @returns {Promise<Array<{id: string, score: number}>>} sorted desc, score = cosine
 */
export async function searchSemantic(vectors, docs, query) {
  const q = String(query || "").trim();
  if (!q || !vectors || vectors.size === 0) return [];
  const qv = await embedText(q);
  if (!qv) return [];
  const scored = [];
  for (const d of docs) {
    const v = vectors.get(d.id);
    if (!v) continue;
    const c = cosine(qv, v);
    if (c > 0) scored.push({ id: d.id, score: c });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* ------------------------------------------------------------------ */
/* RRF hybrid: merge a BM25 ranking and a semantic ranking             */
/* ------------------------------------------------------------------ */

const RRF_K = 60;

/**
 * Reciprocal-rank fusion of two ranked id lists.
 * @param {Array<{id: string}>} bm25Ranked  BM25 hits in rank order
 * @param {Array<{id: string}>} semRanked   semantic hits in rank order
 * @param {number} topK
 * @returns {Array<{id: string, rrf: number, from: string}>} fused, sorted desc
 */
export function rrfFuse(bm25Ranked, semRanked, topK) {
  const scores = new Map();
  const from = new Map();
  bm25Ranked.forEach((h, i) => {
    const key = h.id;
    scores.set(key, (scores.get(key) || 0) + 1 / (RRF_K + i + 1));
    from.set(key, (from.get(key) || "") + "bm25 ");
  });
  semRanked.forEach((h, i) => {
    const key = h.id;
    scores.set(key, (scores.get(key) || 0) + 1 / (RRF_K + i + 1));
    from.set(key, (from.get(key) || "") + "sem ");
  });
  const k = Number(topK);
  const n = Number.isFinite(k) && k > 0 ? Math.floor(k) : 5;
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, r]) => ({ id, rrf: r, from: from.get(id)?.trim() || "" }));
}
