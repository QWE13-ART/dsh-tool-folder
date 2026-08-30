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
