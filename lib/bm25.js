/**
 * bm25.js — zero-dependency BM25 lexical search for tool retrieval.
 *
 * Design (ported from the xiaowan agent's ToolBM25Index idea; the algorithm is
 * the reference, this code is a clean-room JS implementation):
 *   - BM25 with standard k1=1.2, b=0.75 (RAG-MCP / BoR validated the
 *     retrieval-first approach; BM25 is the cheap lexical leg).
 *   - Tokenizer handles mixed CN/EN: ASCII words + CJK bigrams. No jieba, no
 *     network, no dependencies — must run inside the DSH plugin runtime.
 *   - Synchronous and fast: indexing ~50 tools is <1ms, a query <1ms.
 *
 * Cordis sandbox note: this module only does string/number math. It never
 * touches fs/net/process, so it is safe in any host or sandbox context.
 */

const K1 = 1.2;
const B = 0.75;

const EN_STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "at", "by", "from", "as", "is", "are", "was", "were", "be", "been",
  "it", "this", "that", "these", "those", "i", "you", "he", "she", "we",
  "they", "do", "does", "did", "have", "has", "had", "not", "no", "yes",
  "will", "would", "can", "could", "should", "may", "might", "must",
  "your", "my", "our", "their", "its", "all", "any", "some", "each",
]);

/** Tokenize mixed CN/EN text into lowercase tokens. */
function tokenize(text) {
  const out = [];
  const s = String(text || "").toLowerCase();
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_+-]{1,}/g)) {
    const t = m[0];
    if (!EN_STOP.has(t)) out.push(t);
    // Sub-words of hyphen/underscore compounds. Without this, a tool name like
    // "mcp__open-design__start_run" is ONE term, so querying "design" scores
    // zero. The whole token is kept too, so exact-name matches and existing
    // IDF are unchanged; sub-words only ADD recall.
    if (t.length > 2 && (t.includes("-") || t.includes("_"))) {
      for (const part of t.split(/[-_]+/)) {
        if (part.length > 1 && part !== t && !EN_STOP.has(part)) out.push(part);
      }
    }
  }
  // CJK bigrams: "开源框架" -> "开源","源框","框架". Bigrams beat single
  // chars for short tool descriptions and are dependency-free.
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, "");
  if (cjk.length >= 2) {
    for (let i = 0; i + 2 <= cjk.length; i++) out.push(cjk.slice(i, i + 2));
  }
  return out;
}

/** Build a BM25 index over an array of docs. Each doc: {id, text, ...}. */
function buildIndex(docs) {
  const n = docs.length;
  const docTokens = [];
  const df = new Map(); // term -> #docs containing it
  let totalLen = 0;

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    docTokens.push(tokens);
    totalLen += tokens.length;
    const seen = new Set();
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) || 0) + 1);
      }
    }
  }
  const avgdl = n > 0 ? totalLen / n : 1;

  return { n, docTokens, df, avgdl };
}

/** Score one doc's token list against the query's IDF map. */
function score(tokens, queryIdf, n, avgdl) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  let acc = 0;
  const dl = tokens.length;
  for (const [term, idf] of queryIdf) {
    const f = tf.get(term);
    if (!f) continue;
    acc += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * dl) / avgdl)));
  }
  return acc;
}

/**
 * Search an index. Returns up to topK doc ids sorted by BM25 score desc.
 * @param index   result of buildIndex
 * @param query   raw query string (mixed CN/EN ok)
 * @param topK    max results (default 10)
 * @param opts    {filter: (docId) => boolean}
 */
function search(index, query, topK = 10, opts = {}) {
  const { n, docTokens, df, avgdl } = index;
  if (!n || !query) return [];
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return [];

  const queryIdf = new Map();
  for (const t of qTerms) {
    const d = df.get(t) || 0;
    // BM25+ style: add 1 inside the log to keep IDF positive for unseen terms.
    queryIdf.set(t, Math.log((n - d + 0.5) / (d + 0.5) + 1));
  }

  const scored = [];
  for (let i = 0; i < n; i++) {
    const s = score(docTokens[i], queryIdf, n, avgdl);
    if (s > 0 && (!opts.filter || opts.filter(i))) scored.push([i, s]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, topK).map(([i]) => i);
}

export { tokenize, buildIndex, search, score };
