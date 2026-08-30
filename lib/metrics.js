/**
 * metrics.js — L3 retrieval-quality evaluation (ported from the smart
 * retriever's `retrieval_metrics`, now in JS for the plugin runtime).
 *
 * Two kinds of measurement:
 *   1. retrievalMetrics(relevant, retrieved, k) — offline precision@k /
 *      recall@k / hit / F1 against a ground-truth list. Ground truth may be
 *      full names or substrings (domain/tool-name fragments).
 *   2. selectionCoverage(visible, calls) — online: of the tools the model
 *      actually called this turn, how many were in the injected set. A low
 *      coverage means the fold is hiding tools the model needs — the signal
 *      that drives heat-promotion and alias tuning.
 */

function norm(s) {
  return String(s || "").toLowerCase().replace(/[?#].*$/, "");
}

/**
 * Round to 3 decimals and normalize -0 to +0. DSH's lossless JSON validation
 * rejects -0 (a value that survives JSON round-trips as "0" but fails a
 * strict Object.is check), so every public metric must never emit -0.
 */
function round3(x) {
  const r = Math.round(x * 1000) / 1000;
  return r === 0 ? 0 : r;
}

export function retrievalMetrics(relevant, retrieved, k = null) {
  const top = k ? retrieved.slice(0, k) : retrieved;
  const rel = relevant.map(norm).filter(Boolean);
  if (rel.length === 0) {
    return { precision: 0, recall: 0, hit: false, f1: 0, n: top.length };
  }
  let tp = 0;
  for (const item of top) {
    const ni = norm(item);
    if (rel.some((r) => ni === r || ni.includes(r) || r.includes(ni))) tp++;
  }
  const precision = top.length ? tp / top.length : 0;
  const recall = tp / rel.length;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    precision: round3(precision),
    recall: round3(recall),
    hit: tp > 0,
    f1: round3(f1),
    n: top.length,
  };
}

export function selectionCoverage(visibleNames, calledNames) {
  const vis = new Set(visibleNames.map(norm));
  const calls = calledNames.map(norm).filter(Boolean);
  if (calls.length === 0) return { coverage: 1, uncovered: [] };
  const uncovered = calls.filter((c) => !vis.has(c));
  return {
    coverage: round3((calls.length - uncovered.length) / calls.length),
    uncovered,
  };
}

/**
 * Hot-promotion gate with sliding-window decay (v0.2.1).
 * feedback.calls entries may be:
 *   - new shape { n, ts } — n calls, ts = last call epoch ms;
 *   - legacy shape (number) — pre-v0.2.1 counts with no timestamp.
 * A tool is hot when n >= hotThreshold AND (windowMs <= 0 OR the last call
 * is inside the window). Legacy numbers carry ts=0 → outside any positive
 * window → not hot (a tool that hasn't been called since the upgrade
 * naturally loses its historical heat — this is the decay the old code
 * lacked). windowMs=0 keeps the legacy forever-hot behavior for opt-out.
 * @param {object|null} calls - feedback.calls map.
 * @param {string} name - tool name.
 * @param {number} hotThreshold - min calls to be hot.
 * @param {number} windowMs - decay window; <=0 disables time checks.
 * @returns {boolean}
 */
export function isHotTool(calls, name, hotThreshold, windowMs) {
  if (!calls || typeof calls !== "object") return false;
  const v = calls[name];
  if (v == null) return false;
  const n = typeof v === "number" ? v : v.n;
  const ts = typeof v === "number" ? 0 : v.ts;
  if (!(n >= hotThreshold)) return false;
  if (windowMs > 0 && !(ts > 0 && Date.now() - ts <= windowMs)) return false;
  return true;
}

/**
 * Deterministic retrieval priority (v0.2.1, borrowed from Hermes-style
 * "exact name > name token > description" fallback chains): the query's
 * exact tool-name match always ranks first; a ≥4-char query that is a
 * substring of a tool name is pulled ahead of BM25/semantic hits. Everything
 * else keeps the given hit order, deduplicated.
 * @param {Array<{name: string}>} docs - the tool corpus (allTools).
 * @param {string} q - the search query.
 * @param {Array<{id: string, score: number}>} hits - ranked hits.
 * @returns {Array<{id: string, score: number}>} re-ordered hits.
 */
export function prioritizeExact(docs, q, hits) {
  const query = String(q || "").trim().toLowerCase();
  if (!query || !Array.isArray(docs) || !Array.isArray(hits)) return hits;
  const ordered = [];
  const seen = new Set();
  const exact = docs.find((d) => String(d.name || "").toLowerCase() === query);
  if (exact) {
    ordered.push({ id: exact.name, score: 0 });
    seen.add(exact.name);
  }
  if (query.length >= 4) {
    for (const d of docs) {
      if (seen.has(d.name)) continue;
      if (String(d.name || "").toLowerCase().includes(query)) {
        ordered.push({ id: d.name, score: 0 });
        seen.add(d.name);
      }
    }
  }
  for (const h of hits) {
    if (!h || seen.has(h.id)) continue;
    ordered.push(h);
    seen.add(h.id);
  }
  return ordered;
}
