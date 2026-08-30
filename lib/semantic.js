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

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function readCacheFile() {
  try {
    const p = homeDir() + "/" + CACHE_FILE;
    if (!p || !fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return j;
  } catch {
    /* unreadable → miss */
  }
  return null;
}

function writeCacheFile(obj) {
  try {
    const p = homeDir() + "/" + CACHE_FILE;
    const dir = p.slice(0, p.lastIndexOf("/"));
    fs.mkdirSync(dir, { recursive: true });
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
 * Build a semantic index over docs. Doc embeddings come from the on-disk
 * cache when the fingerprint matches; otherwise they are computed once and
 * persisted. Never blocks forever: total batch time is bounded and a failure
 * returns an index whose vectors are simply empty (lexical leg still works).
 *
 * @param {Array<{id: string, text: string}>} docs
 * @param {number} [timeoutMs] per-embed timeout
 * @returns {Promise<{vectors: Map<string, number[]>, available: boolean}>}
 */
export async function buildSemanticIndex(docs, timeoutMs = EMBED_TIMEOUT_MS) {
  const out = { vectors: new Map(), available: false };
  const list = Array.isArray(docs) ? docs.filter((d) => d && d.id && d.text) : [];
  if (list.length === 0) return out;

  // Fast path: cache hit.
  const fp = hash(list.map((d) => d.id + "\u0000" + d.text).join("\u0001"));
  const cache = readCacheFile();
  const cached = cache && cache.fp === fp && cache.vec && typeof cache.vec === "object" ? cache.vec : null;
  if (cached) {
    for (const d of list) {
      const v = cached[d.id];
      if (Array.isArray(v) && v.length > 0) out.vectors.set(d.id, v);
    }
    if (out.vectors.size === list.length) {
      out.available = true;
      return out;
    }
  }

  // Miss: embed each doc (sequential — CPU-bound local model, avoids
  // overloading Ollama), bounded by an overall deadline.
  const deadline = Date.now() + 60_000;
  const fresh = {};
  let ok = 0;
  for (const d of list) {
    if (Date.now() > deadline) break;
    const v = await embedText(d.text, timeoutMs);
    if (v) {
      fresh[d.id] = v;
      out.vectors.set(d.id, v);
      ok++;
    }
  }
  if (ok === list.length) {
    out.available = true;
    writeCacheFile({ fp, vec: fresh }); // persist only on full success
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
