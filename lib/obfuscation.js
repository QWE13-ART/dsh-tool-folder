/**
 * obfuscation.js — anti-obfuscation detection for ChainGuard (2026-08-30).
 *
 * ChainGuard's hard-block layer is regex over the argv text. Attackers (and
 * red-team prompts) routinely bypass literal patterns with:
 *   - string concatenation   `"ne"+"t user"` / 'r'+'m' / `r``m`
 *   - encoded commands       `powershell -enc <base64>` / `-EncodedCommand`
 *   - decoder chains         `certutil -decode in.b64 out.exe && out.exe`
 *   - download-exec          `bitsadmin /transfer /download` (+ /start)
 *   - embedded payloads      base64 blob near iex / iwr | iex / & / cmd /c
 *   - homoglyph/full-width   ｃｕｒｌ / c̶u̶r̶l (combining marks)
 *
 * This module is pure string math: zero dependencies, synchronous, safe in
 * any sandbox. `verdict()` in chainguard.js calls it as the second leg —
 * first the literal patterns on the raw text, then this layer on the
 * de-obfuscated text and on the encoded shapes.
 */

/* ------------------------------------------------------------------ */
/* 1. De-obfuscation: rebuild concatenated strings into plain text     */
/* ------------------------------------------------------------------ */

/**
 * Collapse quoted concatenations: "ne"+"t" / 'ne'+'t' / "ne" + 't' →
 * "net". Iterates until fixpoint (nested joins). Returns the rebuilt text
 * or the original when nothing changed.
 */
export function deobfuscate(text) {
  let s = String(text || "");
  let prev = "";
  let guard = 0;
  while (s !== prev && guard++ < 8) {
    prev = s;
    // double-quoted pairs: "a" + "b"
    s = s.replace(/"([^"\n]{0,60})"\s*\+\s*"([^"\n]{0,60})"/g, '"$1$2"');
    // single-quoted pairs: 'a' + 'b'
    s = s.replace(/'([^'\n]{0,60})'\s*\+\s*'([^'\n]{0,60})'/g, "'$1$2'");
    // mixed quotes: "a" + 'b'
    s = s.replace(/"([^"\n]{0,60})"\s*\+\s*'([^'\n]{0,60})'/g, '"$1$2"');
    s = s.replace(/'([^'\n]{0,60})'\s*\+\s*"([^"\n]{0,60})"/g, '"$1$2"');
    // PowerShell backtick escape joins: r``m or r`+`m style is rarer; skip.
    // PowerShell -join: ('a','b') -join '' → ab (only when -join '' or "")
    s = s.replace(/\(\s*'([^'\n]*?)'\s*(?:,\s*'([^'\n]*?)'\s*)+\)\s*-join\s*(''|"")/g, (_m, first, rest) => {
      const parts = [first];
      if (rest) parts.push(rest);
      return `'${parts.join("")}'`;
    });
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* 2. Encoded / decoder-chain shapes                                    */
/* ------------------------------------------------------------------ */

// PowerShell -enc / -EncodedCommand followed by a base64 payload.
const RE_ENC = /(?:-enc(?:odedcommand)?|--encodedcommand)\s*[=: ]\s*([A-Za-z0-9+/]{16,}={0,2})/i;

// certutil decode chain (Windows LOLBin): decodes a file, then the decoded
// artifact is executable in the same command.
const RE_CERTUTIL = /certutil\s+(?:-[a-z]*decode(?:hex)?\s+[^\s|;&]+|.*-decode(?:hex)?\s+[^\s|;&]+\s+[^\s|;&]+)/i;

// bitsadmin transfer + start (download → execute without touching disk).
const RE_BITSADMIN = /bitsadmin\s+\/transfer\s+\S+\s+\/download/i;

// A long base64 blob co-located with an execution verb in the same command.
const RE_B64_PAYLOAD = /[A-Za-z0-9+/]{40,}={0,2}/;
// Path fingerprint: >=3 camel-case segments joined by '/' (C:/Users/L/AppData/...).
// '/' is a base64 char, so long Windows/URL paths form fake base64 runs; real
// base64 payloads almost never contain 3+ `/Upper`-word segments. Fixed 2026-09-02
// (measured: 57-char WinGet path run + `2>&1` was blocked as base64-embedded-command).
const RE_PATHISH_RUN = /(?:\/[A-Z][A-Za-z]{1,}){3,}/;
// Exec verb used by the b64/hex legs. NOTE: no bare `&` — `2>&1` redirection
// and `& ` call operators are not payload-exec evidence by themselves; the
// verb must be an actual command word (fixed 2026-09-02, fp-repro 2/5).
const EXEC_VERB = /(?:iex|invoke-expression|invoke-command|iwr|irm|start-process|start-job|&\s*(?:iex|invoke|iwr|irm|cmd|powershell|pwsh|sh|bash|python|node|mshta|rundll32|regsvr32|wscript|cscript)|cmd\s*\/[cC]|sh\s+-c|bash\s+-c|python\s+-[cC]|node\s+-e|powershell|pwsh|mshta|rundll32|regsvr32|wscript|cscript)\b/i;

// Full-width Latin letters (ｃｕｒｌ) — never legit in a command line.
const RE_FULLWIDTH = /[\uFF21-\uFF3A\uFF41-\uFF5A]/;

// Combining diacritical marks (homoglyph mangling: c̶u̶r̶l).
const RE_COMBINING = /[\u0300-\u036F\u1AB0-\u1AFF\u20D0-\u20FF]/;

// Escaped hex byte sequences (e.g. \x63\x75\x72\x6c) co-located with exec.
const RE_HEXBYTES = /(?:\\x[0-9a-fA-F]{2}){3,}/;

/**
 * Detect encoded / obfuscated command shapes.
 * @param {string} rawText      original argv text
 * @param {string} [cleanText]  de-obfuscated text (pass to avoid double work)
 * @returns {null | {label: string, detail?: string}}
 */
export function detectObfuscation(rawText, cleanText) {
  const raw = String(rawText || "");
  const clean = cleanText === undefined ? deobfuscate(raw) : cleanText;
  const probe = clean !== raw ? clean : raw;

  const enc = RE_ENC.exec(probe);
  if (enc) {
    return { label: "encoded-command", detail: `-enc base64 载荷（前 24 字符 ${enc[1].slice(0, 24)}…）` };
  }
  if (RE_CERTUTIL.test(probe)) {
    return { label: "certutil-decode-chain", detail: "certutil 解码 + 执行链" };
  }
  if (RE_BITSADMIN.test(probe)) {
    return { label: "bitsadmin-download-exec", detail: "bitsadmin /transfer 下载执行" };
  }
  const b64Run = RE_B64_PAYLOAD.exec(probe);
  if (b64Run && !RE_PATHISH_RUN.test(b64Run[0]) && EXEC_VERB.test(probe)) {
    return { label: "base64-embedded-command", detail: "长 base64 载荷 + 执行动词共存" };
  }
  if (RE_FULLWIDTH.test(raw)) {
    return { label: "fullwidth-homoglyph", detail: "全角字母（命令混淆）" };
  }
  if (RE_COMBINING.test(raw)) {
    return { label: "combining-mark-obfuscation", detail: "组合变音标记（同形符混淆）" };
  }
  if (RE_HEXBYTES.test(probe) && EXEC_VERB.test(probe)) {
    return { label: "hex-encoded-command", detail: "\\xNN 字节编码 + 执行动词" };
  }
  return null;
}
