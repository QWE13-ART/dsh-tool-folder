/**
 * category.js — P1-1 intent-category routing for the dynamic tool segment.
 *
 * Operator-configurable `category` map: `{ "记忆/回忆/remember": ["mcp__viking"], ... }`
 * The key is a `/`-separated list of intent words (OR semantics — any word
 * contained in the query matches). The value is a list of server prefixes to
 * load per-server top-K tools from.
 *
 * Pure function, zero dependencies, unit-testable without the plugin context.
 */

/**
 * Match a lowercased query against the category map.
 * @param {string} queryLower  pre-lowercased user query
 * @param {object} category    `{ "word1/word2": ["serverPrefix", ...], ... }`
 * @returns {{matched: boolean, matches: Array<{server: string, keywords: string[]}>}}
 *   `matches` entries carry the server prefix and the hit keywords (used to
 *   bridge CN intent words into the per-server BM25 scoring).
 */
export function matchCategory(queryLower, category) {
  const matches = [];
  for (const [key, servers] of Object.entries(category || {})) {
    const keywords = String(key)
      .split(/[/,，、]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const hit = keywords.filter((k) => queryLower.includes(k));
    if (hit.length === 0 || !Array.isArray(servers)) continue;
    for (const server of servers) {
      matches.push({ server: String(server), keywords: hit });
    }
  }
  return { matched: matches.length > 0, matches };
}
