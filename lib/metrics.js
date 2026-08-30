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
 * Fail-open gate (v0.2.2, borrowed from fan56/dsh-mcp-adapter): the discovery
 * meta-tools must be visible or folded tools become undiscoverable — which is
 * worse than not folding at all. Returns the names of ENABLED meta-tools that
 * are missing from the visible set (registration failure / name conflict).
 * @param {Set<string>|Array<string>} visibleNames - names in the folded surface.
 * @param {object} enabled - { toolName: boolean } enabled flags.
 * @returns {string[]} missing enabled meta-tool names ([] = all present).
 */
export function missingMetaTools(visibleNames, enabled) {
  const vis = visibleNames instanceof Set ? visibleNames : new Set(visibleNames || []);
  const out = [];
  for (const [n, on] of Object.entries(enabled || {})) {
    if (on && !vis.has(n)) out.push(n);
  }
  return out;
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

/* ------------------------------------------------------------------ */
/* warm LRU 预热集合（v0.2.2，借鉴 Letter2025/dsh-tool-search）        */
/*                                                                    */
/* 现状背景：折叠后模型用 tools_search / tools_schema 发现工具，但发现 */
/* 后该 schema 不保留在注入面，下一轮又折叠。warm 集合把「被搜到的」   */
/* 「被展开 schema 的」「被折叠却仍被调用的」工具名暂存进一个进程内    */
/* LRU Map，下一轮注入（完整或按当前降级层级）。                       */
/*                                                                    */
/* 数据结构：Map<name, { last: number }>——last 单调递增（用毫秒时间   */
/* 戳或调用方给的递增序号），LRU 即按 last 升序逐出最久未用。注意      */
/* Map 的自身插入序不可用作 LRU 序（Map 本身有序，但 touch 已存在键    */
/* 不改变插入位置），显式 last 字段才是判据。                          */
/* ------------------------------------------------------------------ */

/**
 * 把一组名字 touch 进 warm 集合。已存在则刷新 last（置为最新，不重复），
 * 不存在则新增。可随 last 一起把上限也一次收进来——调用方可在此后自行
 * evictWarm，或依赖后续 evictWarm。
 * @param {Map<string,{last:number}>} warm  进程内 warm Map
 * @param {Array<string>} names
 * @param {number} now  单调递增时钟（如 Date.now()）
 * @param {number} [max]  可选：touch 后若超限自动逐出
 */
export function touchWarm(warm, names, now, max) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  for (const n of list) {
    // 用「单调递增序号 = max(now, 上一次+1)」保证同一批内/跨批绝不并列：
    // 每次 touch 都取得严格大于 warm 里现有最大 last 的序号，LRU 判据稳定。
    let next = now;
    for (const v of warm.values()) {
      if (typeof v === "object" && typeof v.last === "number" && v.last >= next) next = v.last + 1;
    }
    warm.set(n, { last: next });
  }
  if (typeof max === "number" && max > 0 && warm.size > max) evictWarm(warm, max);
}

/**
 * 逐出最久未用直到 size <= max。max<=0 = 关闭（不逐出）。
 * @param {Map<string,{last:number}>} warm
 * @param {number} max
 * @returns {Array<string>} 被逐出的名字（仅信息用途）
 */
export function evictWarm(warm, max) {
  const evicted = [];
  if (!(max > 0)) return evicted;
  while (warm.size > max) {
    let oldest = null;
    let oldestLast = Infinity;
    for (const [name, v] of warm) {
      const l = v && typeof v.last === "number" ? v.last : 0;
      if (l < oldestLast) {
        oldestLast = l;
        oldest = name;
      }
    }
    if (oldest == null) break;
    warm.delete(oldest);
    evicted.push(oldest);
  }
  return evicted;
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
