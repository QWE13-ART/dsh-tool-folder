/**
 * toonify.js — P2-2 long JSON result compaction (opt-in, default off).
 *
 * Recursively drops empty fields (null/undefined/""/[]/{}) and truncates
 * strings longer than `maxStr`. Keys are NEVER shortened — renaming keys
 * would break consumer semantics, so the default behavior only shrinks
 * values. Output is built from plain literals, so it stays lossless JSON
 * (no -0 / NaN / sparse arrays, host contract C4).
 */

/**
 * Compact a JSON value: drop empty fields, truncate long strings.
 * @param {unknown} value
 * @param {{maxStr?: number}} [opts]
 * @returns {unknown} `undefined` signals "drop this field"; otherwise a
 *   lossless-JSON-safe projection.
 */
export function toonifyValue(value, { maxStr = 200 } = {}) {
  if (value === null || value === undefined) return undefined; // drop empty
  if (typeof value === "string") {
    const s = value.trim();
    return s.length === 0 ? undefined : s.length > maxStr ? s.slice(0, maxStr) + "…" : s;
  }
  if (Array.isArray(value)) {
    const out = value.map((v) => toonifyValue(v, { maxStr })).filter((v) => v !== undefined);
    return out.length === 0 ? undefined : out;
  }
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      const v = toonifyValue(value[k], { maxStr });
      if (v !== undefined) out[k] = v;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return value; // number / boolean unchanged (no -0 arithmetic here)
}
