// real-check.js — full-pipeline quality check on the REAL 45-tool set.
import fs from "node:fs";
import { apply } from "./lib/index.js";

const real = JSON.parse(fs.readFileSync("tools-public.json", "utf8"));
const handlers = {};
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {} }),
  on: (e, f) => { handlers[e] = f; return () => {}; },
  tools: { register: () => {} },
};
const cfg = {
  enabled: true, core: ["tool-bash", "tool-pwsh"], topK: 5, hotThreshold: 3,
  toolSearchEnabled: true, catalogEnabled: false, maxFoldMs: 50,
};
apply(ctx, cfg);

const cases = [
  "delegate a coding task to openhands",
  "帮我记住这个事实",
  "查记忆 记住 回忆",
  "fetch library documentation",
  "start a learning session",
  "复杂推理任务 深度思考",
  "搜索代码 semantic search",
];

console.log("=== 插件完整流程（BM25 + 别名）真实 45 工具 ===");
for (const q of cases) {
  const assembly = { sections: [], contexts: [], tools: real, variables: {} };
  const out = await handlers["system-prompt/assemble"](
    assembly,
    { agent: { id: "standard" }, signal: { userMessage: { content: q } } },
    async () => assembly,
  );
  const names = out.tools.map((t) => t.name);
  console.log(`\nQ: ${q}`);
  console.log(`  visible(${names.length}): ${names.join(", ")}`);
}
