// fp-repro.mjs — ChainGuard 误伤复现（2026-09-02 实测：合法安全工具调用被拦）
// 场景：gitleaks（密钥扫描）通过其 WinGet 安装路径被调用的 argv 文本，
//       被 detectObfuscation 判为 base64-embedded-command；含触发词字面的
//       任意命令被判 download-pipe-execute / powershell download-exec。
// 用法: node test/fp-repro.mjs
import { detectObfuscation, deobfuscate } from "../lib/obfuscation.js";
import { verdict } from "../lib/chainguard.js";

const gitleaksPath = "C:/Users/L/AppData/Local/Microsoft/WinGet/Packages/Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe/gitleaks.exe";

const samples = {
  "gitleaks-dir-scan": `& '${gitleaksPath}' dir 'E:\\DSH-Data\\dsh-skills' --no-banner --redact`,
  "gitleaks-staged": `& '${gitleaksPath}' git --staged --no-banner 'E:\\DSH-Data\\dsh-skills' 2>&1 | Select-Object -Last 12`,
  "copy-exe-short-path": `Copy-Item '${gitleaksPath}' (Join-Path $env:TEMP 'gl.exe') -Force`,
  "normal-pwsh-list": "Get-ChildItem 'E:\\DSH-Data\\dsh-skills' -Directory | Select-Object -First 3",
  "detector-source-in-argv": "node -e \"const re = /(?:iex|invoke-expression|start-process|&)/i; console.log(re)\"",
};

let fp = 0;
const RE_B64 = /[A-Za-z0-9+/]{40,}={0,2}/;
const RE_EXEC = /(?:iex|invoke-expression|invoke-command|iwr|irm|start-process|start-job|&|cmd\s*\/[cC]|sh\s+-c|bash\s+-c|python\s+-[cC]|node\s+-e|powershell|pwsh|mshta|rundll32|regsvr32|wscript|cscript)\b/i;
for (const [name, cmd] of Object.entries(samples)) {
  const v = verdict(cmd);
  const o = detectObfuscation(cmd);
  const flag = v?.blocked || o ? "⚠️ FALSE POSITIVE" : "ok";
  if (v?.blocked || o) fp++;
  console.log(`[${flag}] ${name}`);
  if (v?.blocked) console.log(`    chainguard: ${v.label}${v.detail ? " | " + v.detail : ""}`);
  if (o && !v?.blocked) console.log(`    obfuscation: ${o.label}`);
  // 命中段定位
  const b64 = cmd.match(RE_B64);
  const evm = cmd.match(RE_EXEC);
  if (b64) console.log(`    b64-run: len=${b64[0].length} '${b64[0].slice(0, 40)}...'`);
  if (evm) console.log(`    exec-verb: '${evm[0]}'`);
}
console.log(`\n误伤 ${fp}/${Object.keys(samples).length}（全部合法调用应 ok）`);
