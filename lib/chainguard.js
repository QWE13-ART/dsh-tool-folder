import { deobfuscate, detectObfuscation } from "./obfuscation.js";

// ChainGuard — session-level tool-call firewall (ported from xiaowan tool_firewall T3).
//
// Two layers:
//  1. ChainGuard.check()  — high-risk command verdict (AEGIS-style hard block list).
//  2. ChainGuard.record() — session window of tool calls; ChainGuard.checkChain()
//     detects "sensitive read → external exfil" chains (Invariant-style: a single
//     call is harmless, the SEQUENCE is the attack).
//
// Zero dependencies, pure regex + window buffer. Runs in the cordis plugin sandbox.
//
// v0.1.8 (2026-08-30): obfuscation leg. verdict() now runs the literal
// patterns on the raw text, then de-obfuscates (quoted concatenation /
// -join) and re-runs them, then checks encoded shapes (-enc base64,
// certutil/bitsadmin decoder chains, base64 payload + exec verb, full-width
// and combining-mark homoglyphs, hex-escaped bytes).

const HIGH_RISK_PATTERNS = [
  // destructive filesystem
  [/rm\s+-rf\s+[\\/]?[A-Za-z]:[\\/]|rm\s+-rf\s+\/|rm\s+-rf\s+[*?]/i, "recursive root delete"],
  [/format\s+[A-Za-z]:|format\s+\/q/i, "disk format"],
  [/del\s+\/f\s+\/s\s+\/q/i, "force recursive delete"],
  // download → execute chain
  [/(wget|curl|powershell|pwsh).{0,80}(\||;|&&).{0,30}(sh|bash|powershell|pwsh|cmd|start)\b/i, "download-pipe-execute"],
  [/invoke-expression|iex\s*\(|iwr\s+.*\|.*iex/i, "powershell download-exec"],
  // command substitution download → execute (bash $() and backticks; no pipe,
  // so the download-pipe pattern above cannot see it). Added 2026-09-02.
  [/\$\s*\(\s*(?:curl|wget|iwr)[^)]{0,120}\)|\`(?:curl|wget|iwr)[^\`]{0,120}\`/i, "download-exec via command substitution"],
  // credential / exfil
  // NOTE: `\\+` (one-or-more literal backslashes) instead of `\\` — argv text
  // reaches verdict() both as a raw string (single backslash) and as
  // JSON.stringify(object) (backslash escaped to `\\`). A bare `\\` only
  // matches the raw path, silently missing JSON-encoded calls (NEW-1).
  [/(net\s+user|whoami\s+\/all|reg\s+query\s+HKLM\\+SAM)/i, "credential harvest"],
  [/copy\s+.*\\+system32\\+config|type\s+.*\\+(ntuser\.dat|SAM|SYSTEM)/i, "system file exfil"],
  // shadow / persistence
  [/schtasks\s+\/create|reg\s+add\s+.*\\+run/i, "persistence install"],
];

// Tools that READ sensitive local state (file system, memory, secrets).
const SENSITIVE_READ = new Set([
  "read", "glob", "grep", "edit",
  "mcp__viking__find", "mcp__viking__glob", "mcp__viking__read",
  "ssh_download", "ssh_list", "job_output", "describe_image", "read_image",
]);

// Tools that SEND data to an external surface (network, memory writes, uploads).
const EXTERNAL_SEND = new Set([
  "mcp__viking__remember", "mcp__viking__add_resource", "mcp__viking__forget",
  "ssh_upload", "send_message", "web_search",
  "mcp__openhands__openhands_create_conversation",
]);

function matchHighRisk(text) {
  for (const [re, label] of HIGH_RISK_PATTERNS) {
    if (re.test(text)) {
      return { blocked: true, label, pattern: String(re) };
    }
  }
  return null;
}

/**
 * 是否「执行类工具」——参数是真实要执行的命令/脚本，需要高危硬拦。
 * 内容类工具（write/edit/read/apply_patch 等）的参数是文件内容/文本，
 * 本身不执行，含危险命令字面量（讨论/测试/文档）不应触发硬拦。
 *
 * 2026-08-30: 修复 ChainGuard 对所有工具参数跑高危正则导致的误拦。
 * 2026-09-02 (red-team F1): bare-name matching let MCP-prefixed exec tools
 * (`mcp__windows__Cmd`) bypass the gate — tokenize the full name and match
 * every segment against the verb list. Over-recognition is ~free here: the
 * gate only decides "run this argv past the firewall", and a non-command
 * argv has no high-risk literals to trip; missing one tool is a bypass.
 * @param {string} name - full tool name (mcp__<server>__<tool> or bare).
 */
export function isExecTool(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  const EXEC_TOKENS = new Set([
    "cmd", "command", "console", "terminal", "shell", "bash", "pwsh", "powershell",
    "exec", "execute", "executor", "run", "runner", "sh", "zsh", "script", "ps1",
  ]);
  // Legacy fast paths kept for bare names and native prefixes.
  const EXEC_NAMES = ["pwsh", "shell", "bash", "cmd", "exec", "terminal", "run", "console"];
  if (EXEC_NAMES.includes(n)) return true;
  if (n.endsWith("__app")) return true; // mcp__windows__App：launch_executable 模式可启动任意可执行文件
  if (n.startsWith("run_") || n.startsWith("exec_") || n.startsWith("execute_")) return true;
  if (n.startsWith("ssh_") || n.startsWith("wsl")) return true;
  // Segment match: tokenize on mcp__ separator and _ - . (runbook-style names).
  // All segments except the `mcp` marker participate — a server name carrying
  // an exec word (e.g. `pwsh` in mcp__pwsh__list_tools) is itself an exec
  // signal, while `mcp__github__get_file_contents` has none. Over-recognition
  // is ~free (gate only); under-recognition is a bypass.
  const tokens = n.split(/__|_|-|\./).filter((t) => t.length > 0);
  const meaningful = n.startsWith("mcp") && tokens[0] === "mcp" ? tokens.slice(1) : tokens;
  if (meaningful.length === 0) return false;
  return meaningful.some((t) => EXEC_TOKENS.has(t));
}

export function verdict(argvText) {
  if (!argvText) return null;

  // Leg 1: literal patterns on the raw text (fast path).
  const direct = matchHighRisk(argvText);
  if (direct) return direct;

  // Leg 2: de-obfuscated text (quoted concatenation / -join rebuild), then
  // re-run the literal patterns — `"ne"+"t user"` must land like `net user`.
  const clean = deobfuscate(argvText);
  if (clean !== argvText) {
    const rebuilt = matchHighRisk(clean);
    if (rebuilt) {
      return {
        blocked: true,
        label: rebuilt.label + "（拼接混淆还原后命中）",
        pattern: String(rebuilt.pattern) + " | deobfuscated",
      };
    }
  }

  // Leg 3: encoded shapes that no literal pattern can see.
  const obf = detectObfuscation(argvText, clean);
  if (obf) {
    return { blocked: true, label: obf.label, detail: obf.detail };
  }

  return { blocked: false };
}

export class ChainGuard {
  constructor({ window = 30 } = {}) {
    this.window = window;
    this.history = []; // [{tool, argv, ts}]
  }

  record(tool, argv = "") {
    this.history.push({ tool, argv: String(argv || "").slice(0, 300), ts: Date.now() });
    if (this.history.length > this.window) {
      this.history.splice(0, this.history.length - this.window);
    }
  }

  // Sensitive read followed within 3 steps by an external send → exfil chain.
  checkChain() {
    if (this.history.length < 2) return null;
    for (let i = 0; i < this.history.length; i++) {
      const h = this.history[i];
      if (!SENSITIVE_READ.has(h.tool)) continue;
      const lookahead = this.history.slice(i + 1, i + 4);
      for (let j = 0; j < lookahead.length; j++) {
        if (EXTERNAL_SEND.has(lookahead[j].tool)) {
          return {
            risk: "high",
            label: "sensitive-read → external-send chain",
            chain: [
              `${h.tool}:${String(h.argv).slice(0, 60)}`,
              ...lookahead.slice(0, j + 1).map((x) => `${x.tool}:${String(x.argv).slice(0, 60)}`),
            ],
          };
        }
      }
    }
    return null;
  }

  reset() {
    this.history = [];
  }
}
