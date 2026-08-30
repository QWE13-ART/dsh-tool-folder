/**
 * schema.js — L1 schema compression + description normalization.
 *
 * DO NOT deduplicate with JSON $ref: OpenAI/ARK function-calling providers do
 * not reliably resolve $ref in tool parameters, so a broken schema would
 * silently kill a tool. Instead we trim what is provably redundant:
 *   - tool description beyond the level's `descLimit`
 *   - parameter description beyond the level's `paramDescLimit`
 *   - `aggressive` additionally drops OPTIONAL parameters — properties are
 *     rebuilt from the required list, so `required ⊆ properties` holds
 *     constructively (host contract C8: providers reject a schema whose
 *     required names are not all declared in properties).
 *
 * Compression applies ONLY to dynamically-loaded tools; core tools are
 * operator-chosen and left untouched. Off by default (`compressLevel: "off"`).
 *
 * normalizeDescription() sanitizes injection markers, normalizes whitespace,
 * keeps the first sentence, and truncates at 300 chars. It also applies only
 * to the dynamic segment (core/hot descriptions are never rewritten).
 */

const LEVELS = {
  light: { descLimit: 500, paramDescLimit: Infinity, dropOptional: false },
  standard: { descLimit: 200, paramDescLimit: 120, dropOptional: false },
  aggressive: { descLimit: 120, paramDescLimit: 60, dropOptional: true },
};

/**
 * Compress one tool's schema at a given level.
 * @param {object} tool  tool definition {name, description, parameters, ...}
 * @param {{level?: "off"|"light"|"standard"|"aggressive"}} [opts]
 * @returns {object} a shallow copy of the tool; the original is never mutated.
 */
export function compressTool(tool, { level = "off" } = {}) {
  if (level === "off") return tool;
  const t = LEVELS[level] ?? LEVELS.standard;
  const out = { ...tool };

  if (typeof out.description === "string" && out.description.length > t.descLimit) {
    out.description = out.description.slice(0, t.descLimit) + " …";
  }

  const params = out.parameters;
  if (
    !params ||
    typeof params !== "object" ||
    !params.properties ||
    typeof params.properties !== "object"
  ) {
    // Non object-root (array-root / no properties): trim the description only.
    return out;
  }

  const required = Array.isArray(params.required)
    ? params.required.filter((n) => typeof n === "string")
    : [];
  // Constructive guarantee (C8): properties are rebuilt from the required list
  // under `dropOptional`, so `required ⊆ properties` holds by construction.
  // Required properties are NEVER dropped (missing required → ToolArgsError).
  const keep = new Set(t.dropOptional ? required : Object.keys(params.properties));
  const props = {};
  for (const [key, raw] of Object.entries(params.properties)) {
    if (!keep.has(key)) continue;
    const p = { ...raw }; // never touch $ref/oneOf/items/properties deep structure
    if (typeof p.description === "string" && p.description.length > t.paramDescLimit) {
      p.description = p.description.slice(0, t.paramDescLimit) + " …";
    }
    props[key] = p;
  }
  out.parameters = { ...params, properties: props };
  if (t.dropOptional) {
    // C3d / C8: malformed inputs may list `required` names that name no
    // property at all (JSON Schema allows it, e.g. required:["ghost"] with
    // properties:{real:{...}}). After the aggressive rebuild those names are
    // gone from properties, so an unfiltered required would violate
    // `required ⊆ properties` and providers (ARK/OpenAI) could reject the
    // tool. Filter the emitted required list down to the kept property names
    // so the guarantee holds for ANY input, well-formed or not.
    out.parameters.required = required.filter((n) => Object.hasOwn(props, n));
  }
  return out;
}

/** Injection / prompt-leak markers removed from tool descriptions. */
const INJECTION_MARKERS = [
  /\bignore\s+(all\s+)?(previous|prior|above)\b/i,
  /\bsystem\s*:/,
  /\[\s*\/?\s*system\s*\]/i,
  /^\s*(你|you)\s*(现在|现在开始|are)\b/i,
];

/**
 * Normalize a tool description: strip injection markers, collapse whitespace,
 * keep the first sentence, truncate at 300 chars.
 * @param {string} desc
 * @param {{firstSentence?: boolean}} [opts]
 * @returns {string}
 */
export function normalizeDescription(desc, { firstSentence = true } = {}) {
  let s = String(desc || "");
  for (const re of INJECTION_MARKERS) s = s.replace(re, " "); // injection sanitize
  s = s.replace(/\s+/g, " ").replace(/[。．.!！]{2,}/g, "。").trim();
  if (firstSentence) {
    const m = s.match(/^.{1,120}?[。.!?；;]/);
    if (m) s = m[0];
  }
  return s.length > 300 ? s.slice(0, 300) + " …" : s;
}

/**
 * Deep-sanitize a value into lossless JSON (host contract C4: -0/NaN/Infinity
 * are rejected by the host's lossless JSON validation). Numbers are mapped to
 * a finite non-negative-zero value; plain objects/arrays are walked; strings,
 * booleans, null pass through untouched.
 * @param {unknown} v
 * @returns {unknown} a plain JSON-safe projection
 */
export function sanitizeLossless(v) {
  if (typeof v === "number") {
    return Number.isFinite(v) && !Object.is(v, -0) ? v : 0;
  }
  if (Array.isArray(v)) return v.map(sanitizeLossless);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = sanitizeLossless(v[k]);
    return out;
  }
  return v; // string / boolean / null / undefined (undefined never enters a plain object walk)
}
