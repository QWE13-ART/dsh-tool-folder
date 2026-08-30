/**
 * dsh-tool-folder — fold the DSH tool surface down to what each request needs.
 *
 * Six layers (L0-L5), all implemented here:
 *   L1 schema compression  — conservative description trimming for dyn tools
 *   L2 dynamic loading     — per-agent core + BM25 top-K + CN-alias servers
 *   L3 selection metrics   — selectionCoverage / retrievalMetrics recorded
 *   L4 execution side      — folded tools stay executable + heat promotion +
 *                            `tools_search` tool for on-demand discovery
 *   L5 cache discipline    — stable ordering (core by config, hot/dyn sorted
 *                            by name) so the prompt prefix stays byte-stable
 *   (L0 description rewrite is a separate offline batch — see README)
 *
 * Mechanism (verified against DSH 0.1.1-rc.1 sources, 2026-08-24):
 *   assembly = { sections, contexts, tools, variables } and the waterfall
 *   `system-prompt/assemble` lets a plugin REPLACE the object authoritatively;
 *   buildRequest uses assembly.tools as the ONLY source of the API tools field.
 *   Execution is NOT gated on the current turn's tools, so folding never
 *   removes capability.
 *   `tools/pre-execute`  — listener receives (exec, next); return
 *     { kind: "deny", reason } to refuse, or call next() to allow.
 *     exec = { callId, name, arguments, agent, signal } (no .deny() method).
 *   `tools/post-execute` — listener receives (exec, result, next); fires once
 *     per executed tool. exec.name/exec.arguments feed the L3/L4 feedback
 *     loop. (`agent/pre-step` carries { messages, position, signal } only —
 *     no toolCalls — so it is useless for feedback.)
 *
 * Safety: any error falls back to the untouched assembly. Performance: BM25
 * in-memory + sync; a maxFoldMs hard cap keeps the full list if we overrun.
 */
import fs from "node:fs";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { buildIndex, search } from "./bm25.js";
import { compressTool, normalizeDescription, sanitizeLossless } from "./schema.js";
import { selectionCoverage } from "./metrics.js";
import { ChainGuard, verdict } from "./chainguard.js";
import { matchCategory } from "./category.js";
import { toonifyValue } from "./toonify.js";
import { configureSemantic, buildSemanticIndex, searchSemantic, rrfFuse } from "./semantic.js";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "tool-folder";
export const inject = ["systemPrompt", "agents", "tools"];

/**
 * Schemastery configuration schema — renders the plugin's settings form in the
 * DSH settings UI (per cordis `runtime.Config["~standard"]`). Mirrors DEFAULTS
 * below; the UI exposes every toggle/knob this plugin has.
 * Same pattern as @deepseek-ai/dsh-tool-todo (z.object + .default()).
 */
const COMPRESS_LEVELS = ["off", "light", "standard", "aggressive"];
export const Config = z.object({
  enabled: z.boolean().default(true).description("总开关：启用工具折叠"),
  core: z.array(z.string()).default([]).description("每轮恒显示的工具（平台核心，永不折叠）"),
  perAgent: z.dict(z.object({
    core: z.array(z.string()).default([]).description("该 agent 的常驻工具覆盖（未列出 agent 回退到全局 core）"),
  })).default({}).description("按 agent 覆盖常驻工具：{\"standard\": {\"core\": [...]}}"),
  deny: z.array(z.string()).default([]).description("禁用工具：精确名或 prefix* 前缀，命中不注入+拒绝执行"),
  topK: z.number().min(0).max(50).default(6).description("BM25 动态检索每轮最多注入的工具数"),
  hotThreshold: z.number().min(1).default(3).description("被折叠工具调用几次后自动晋升为常驻"),
  catalogEnabled: z.boolean().default(true).description("折叠安全网：把被藏工具列表写进提示词，模型知道它们存在"),
  compressLevel: z.union(COMPRESS_LEVELS).default("off").description("L1 schema 压缩级别：off 不压缩 / light 裁描述 / standard 裁描述+参数说明 / aggressive 删可选参数"),
  compressEnabled: z.boolean().default(false).description("兼容开关：compressLevel=off 且此开=true 时按 standard 处理"),
  schemaToolEnabled: z.boolean().default(true).description("注册 tools_schema 元工具：按名称展开任意工具的完整参数 schema"),
  normalizeDescriptions: z.boolean().default(false).description("描述标准化：注入消毒+首句提取+300 字符（只作用于动态段）"),
  category: z.dict(z.array(z.string())).default({}).description("意图路由：{\"记忆/回忆\": [\"mcp__viking\"]}，优先级 category > aliases > BM25"),
  include: z.array(z.string()).default([]).description("白名单：[\"mcp__openhands*\"]，空=全部（deny 仍优先，meta 工具豁免）"),
  toonifyResults: z.boolean().default(false).description("长 JSON 结果紧凑化（删空字段/截长串，默认关）"),
  toolSearchEnabled: z.boolean().default(true).description("注册 tools_search 元工具：检索被折叠的工具目录"),
  firewallEnabled: z.boolean().default(true).description("ChainGuard 防火墙：高危命令硬拦截+外泄链检测"),
  maxFoldMs: z.number().min(0).max(1000).default(50).description("折叠超时上限（ms），超时回退完整工具列表"),
  feedbackFile: z.string().default("").description("反馈数据落盘路径（空=DSH_HOME/logs/tool-folder/）"),
  aliases: z.dict(z.array(z.string())).default({}).description("中文意图→server 别名表"),
  semanticEnabled: z.boolean().default(true).description("语义检索腿（本地 Ollama bge-m3）：tools_search 用 BM25+语义 RRF 混合，中英跨语言命中"),
  ollamaBase: z.string().default("http://127.0.0.1:11434").description("Ollama 地址（semanticEnabled 时使用）"),
  embedModel: z.string().default("bge-m3").description("embedding 模型（semanticEnabled 时使用）"),
});

const DEFAULTS = {
  enabled: true,
  perAgent: {},
  core: [],
  deny: [], // never inject + refuse execution (exact name or "prefix*")
  topK: 6,
  hotThreshold: 3,
  catalogEnabled: true, // safety net: folded tools stay discoverable by name
  compressEnabled: false, // deprecated compat: compressLevel "off" + true → "standard"
  compressLevel: "off", // "off" | "light" | "standard" | "aggressive"
  schemaToolEnabled: true, // P0-1: register the tools_schema meta tool
  normalizeDescriptions: false, // P1-2: sanitize+first-sentence+300 dyn descriptions
  category: {}, // P1-1: { "记忆/回忆": ["mcp__viking"], ... } intent routing
  include: [], // P2-1: whitelist ("prefix*" or exact name); empty = all (minus deny)
  toonifyResults: false, // P2-2: compact long JSON results (default off)
  toolSearchEnabled: true,
  firewallEnabled: true, // ChainGuard: high-risk hard block + exfil chain warn
  maxFoldMs: 50,
  feedbackFile: "",
  aliases: {
    "mcp__viking": ["记忆", "记住", "回忆", "remember", "memory"],
    "mcp__openhands": ["写代码", "编程", "编码", "开发", "coding", "code", "openhands", "委派", "delegate"],
    "mcp__context7": ["文档", "api 文档", "库文档", "documentation", "docs", "context7"],
    "mcp__deeptutor": ["学习", "课程", "教学", "tutor", "study", "learn"],
    "mcp__reasonix": ["推理", "复杂任务", "深度思考", "reasoning", "reasonix"],
    "mcp__open-design": ["设计", "design"],
    "mcp__serena": ["代码搜索", "搜代码", "search code", "serena"],
  },
  semanticEnabled: true, // P0-1: bge-m3 semantic leg for tools_search (RRF hybrid)
  ollamaBase: "http://127.0.0.1:11434",
  embedModel: "bge-m3",
};

function feedbackPath(cfg) {
  if (cfg.feedbackFile) return cfg.feedbackFile;
  // Host-side plugins run in the real Node runtime (not the dynamic sandbox),
  // so process.env is available. Guarded anyway: fall back to a relative path.
  try {
    const home = process.env.DSH_HOME || "";
    if (home) return `${home}/logs/tool-folder/feedback.json`;
    return `${process.env.APPDATA || "."}/dsh/logs/tool-folder/feedback.json`;
  } catch {
    return "tool-folder/feedback.json";
  }
}

function loadFeedback(file, log) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log?.warn?.("feedback load failed (%s) — starting empty", e?.message);
  }
  return { calls: {}, sessions: [] };
}

function persistFeedback(file, fb, log) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fb, null, 2), "utf8");
  } catch (e) {
    log?.warn?.("feedback persist failed (%s) — non-fatal", e?.message);
  }
}

/** Serialize an exec.arguments payload (object) into text for firewall verdicts. */
function execArgumentsText(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function extractQuery(context) {
  const signal = context && context.signal;
  if (!signal) return "";
  try {
    const s = signal.userMessage?.content ?? signal.query ?? signal.prompt;
    if (typeof s === "string") return s;
    if (Array.isArray(signal.messages)) {
      for (let i = signal.messages.length - 1; i >= 0; i--) {
        const m = signal.messages[i];
        if (m && m.role === "user" && typeof m.content === "string") return m.content;
      }
    }
  } catch {
    /* unknown shape */
  }
  return "";
}

function serverOf(name) {
  // "mcp__github__get_repo" → "mcp__github"; "openhands_create_conversation" → "openhands";
  // native tools with underscores ("read_file", "search_for_pattern") → "native".
  const m = name.match(/^(mcp__[^_]+(?:_[^_]+)?)/);
  if (m) return m[1];
  if (/^openhands_/.test(name)) return "openhands";
  return "native";
}

/**
 * 是否「执行类工具」——参数是真实要执行的命令/脚本，需要高危硬拦。
 * 内容类工具（write/edit/read/apply_patch 等）的参数是文件内容/文本，
 * 本身不执行，含危险命令字面量（讨论/测试/文档）不应触发硬拦。
 * 2026-08-30：修复 ChainGuard 对所有工具参数跑高危正则导致的误拦。
 */
function isExecTool(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  const EXEC_NAMES = ["pwsh", "shell", "bash", "cmd", "exec", "terminal", "run", "console"];
  if (EXEC_NAMES.includes(n)) return true;
  if (n.includes("powershell")) return true; // mcp__windows__PowerShell 等（参数即命令）
  if (n.endsWith("__app")) return true; // mcp__windows__App：launch_executable 模式可启动任意可执行文件
  if (n.startsWith("run_") || n.startsWith("exec_") || n.startsWith("execute_")) return true;
  if (n.startsWith("ssh_") || n.startsWith("wsl")) return true;
  return false;
}

function summarizeCaps(tools) {
  // Pull the first few distinct capability keywords from descriptions.
  const seen = new Set();
  const caps = [];
  for (const t of tools) {
    const d = (t.description || "").replace(/\s+/g, " ").trim();
    const head = d.split(/[—,;:]/)[0].slice(0, 60);
    if (head && !seen.has(head)) {
      seen.add(head);
      caps.push(head);
    }
    if (caps.length >= 3) break;
  }
  return caps.join(" | ") || "capabilities unknown";
}

function catalogText(tools) {
  // Affordance fix: group folded tools by server and emit a capability
  // summary per server (not a callable-looking name list). The model must
  // expand arguments via tools_schema before calling a folded tool.
  const byServer = new Map();
  for (const t of tools) {
    const s = serverOf(t.name);
    if (!byServer.has(s)) byServer.set(s, []);
    byServer.get(s).push(t);
  }
  const lines = [...byServer.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([server, ts]) => `- [${server}]: ${ts.length} tools — ${summarizeCaps(ts)}`);
  return [
    "Additional tools exist but are not loaded for this request. " +
      "They are grouped by server below. To call one: first expand its " +
      "arguments with tools_schema (exact tool name), then call it by name.",
    ...lines,
  ].join("\n");
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };

  // T01: normalize the v0.1.5 config surface right after the DEFAULTS merge.
  //   - compressLevel accepts only the four valid tiers; anything else → "off".
  //   - compressEnabled is the deprecated compat switch: "off" + true → "standard".
  //   - include patterns are trimmed/non-empty; empty list = include-all.
  //   - category must be a plain object; malformed values are ignored.
  const VALID_LEVELS = ["off", "light", "standard", "aggressive"];
  const compressLevel = VALID_LEVELS.includes(cfg.compressLevel) ? cfg.compressLevel : "off";
  const effectiveLevel = compressLevel !== "off" ? compressLevel : (cfg.compressEnabled ? "standard" : "off");
  const includePatterns = (cfg.include || []).map((n) => String(n).trim()).filter(Boolean);
  const includeAll = includePatterns.length === 0;
  const categoryCfg = (cfg.category && typeof cfg.category === "object") ? cfg.category : {};

  const logger = ctx.logger("tool-folder");
  if (!cfg.enabled) {
    logger.info("disabled by config");
    return;
  }

  // Semantic leg (P0-1): point the shared module at our config; the index is
  // built lazily on first tools_search call (doc embeddings cached on disk,
  // so the ~10s cold start happens once, then it's a cache hit).
  configureSemantic({ ollamaBase: cfg.ollamaBase, embedModel: cfg.embedModel });
  let semIndexPromise = null;
  const getSemanticIndex = () => {
    if (!semIndexPromise) {
      semIndexPromise = (async () => {
        const docs = allTools.map((t) => ({ id: t.name, text: `${t.name} ${t.description || ""}` }));
        return buildSemanticIndex(docs);
      })();
    }
    return semIndexPromise;
  };

  const fbPath = feedbackPath(cfg);
  const feedback = loadFeedback(fbPath, logger);
  let index = null;
  let indexStamp = null;
  let allTools = [];
  let lastVisible = { agentId: "", names: [], ts: 0 };
  const disposers = [];
  const chain = new ChainGuard({ window: 30 }); // firewall: exfil-chain + high-risk

  // "mcp__viking__remember" → "mcp__viking"; plain tools ("tool-bash") stay
  // as themselves (single segment survives slice(0,2)).
  const serverOf = (name) => String(name).split("__").slice(0, 2).join("__");

  // Pattern matching shared by deny (P0) and include (P2-1): exact name or
  // "prefix*" matches any tool starting with that prefix.
  function matchesAnyPattern(name, patterns) {
    if (!name || !patterns || patterns.length === 0) return false;
    const n = String(name);
    for (const p of patterns) {
      if (p.endsWith("*")) {
        if (n.startsWith(p.slice(0, -1))) return true;
      } else if (n === p) {
        return true;
      }
    }
    return false;
  }
  // deny config: exact name, or "prefix*" matches any tool starting with it.
  // Deny wins over core, include and the catalog (a denied tool is not listed).
  const denyPatterns = (cfg.deny || []).map((n) => String(n).trim()).filter(Boolean);
  const isDenied = (n) => matchesAnyPattern(n, denyPatterns);

  // Per-server top-K: rank the matched server's tools by BM25 relevance with
  // the matched intent keywords bridged into the query. When there is no
  // lexical signal at all, fall back to a stable name-order subset so the
  // intent route still helps. Used by both aliases and category routing.
  function addPerServerTopK(dyn, tools, serverPrefix, bridgedQuery, maxK) {
    const serverIndices = [];
    for (let i = 0; i < tools.length; i++) {
      if (tools[i].name.startsWith(serverPrefix)) serverIndices.push(i);
    }
    if (serverIndices.length === 0) return;
    const k = Math.min(maxK, serverIndices.length);
    let ranked = [];
    if (index) {
      ranked = search(index, bridgedQuery, serverIndices.length, {
        filter: (i) => tools[i].name.startsWith(serverPrefix),
      });
    }
    if (ranked.length === 0) {
      // No lexical signal at all → stable name order so the route still helps.
      serverIndices.sort((a, b) => (tools[a].name < tools[b].name ? -1 : 1));
      for (const i of serverIndices.slice(0, k)) dyn.add(tools[i].name);
    } else {
      for (const i of ranked.slice(0, k)) dyn.add(tools[i].name);
    }
  }

  function buildDynamicSet(tools, query) {
    const dyn = new Set();
    if (!query) return dyn;
    const q = query.toLowerCase();
    // P1-1: category wins over aliases. When a category key matches, only the
    // category's servers are routed per-server top-K; the aliases branch is
    // skipped. The generic BM25 leg is still merged as a union afterwards.
    const cat = matchCategory(q, categoryCfg);
    if (cat.matched) {
      for (const m of cat.matches) {
        addPerServerTopK(dyn, tools, m.server, `${query} ${m.keywords.join(" ")}`, 3);
      }
    } else {
      // aliases fallback — narrowed to a single representative tool per
      // matching server (topK=1). A whole-server injection cancels the fold
      // budget; the rest of the server stays discoverable via tools_search
      // and the grouped catalog.
      for (const [prefix, keywords] of Object.entries(cfg.aliases || {})) {
        const matched = keywords.filter((k) => q.includes(String(k).toLowerCase()));
        if (matched.length === 0) continue;
        addPerServerTopK(dyn, tools, prefix, `${query} ${matched.join(" ")}`, 1);
      }
    }
    // Generic BM25 last as a union (result set unchanged vs. previous order).
    if (cfg.topK > 0 && index) {
      for (const i of search(index, query, cfg.topK)) dyn.add(tools[i].name);
    }
    return dyn;
  }

  // L4: `tools_search` — model-driven discovery of folded tools.
  if (cfg.toolSearchEnabled) {
    const outputSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", required: true },
        results: {
          type: "array",
          required: true,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", required: true },
              description: { type: "string", required: true },
              server: { type: "string", required: true },
            },
          },
        },
        total: { type: "integer", required: true },
      },
    };
    const toolsSearch = defineTool({
      name: "tools_search",
      description:
        "Search the full tool catalog for a task. Use when the tools loaded " +
        "for this request may not cover what you need — e.g. a server-specific " +
        "capability — and you want to know if a matching tool exists. " +
        "Returns matching tool names and descriptions; you may then call any " +
        "returned tool directly by name.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "Search keywords, e.g. 'openhands session' or 'context7 documentation'.",
        },
        limit: { type: "number", description: "Max results. Default 8." },
      },
      output: { schema: outputSchema, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        const q = String(args.query || "");
        const lim = args.limit ?? 8;
        if (!index || !q) return { query: q, results: [], total: 0 };
        const bm25Hits = search(index, q, lim * 2).map((i) => ({ id: allTools[i].name }));
        let fused = bm25Hits;
        // Semantic leg (P0-1): RRF-fuse BM25 with local bge-m3 similarity.
        // Any failure (Ollama down / timeout / cache miss on error) degrades
        // to BM25-only — the hybrid must never be slower or worse than today.
        if (cfg.semanticEnabled !== false) {
          try {
            const sem = await getSemanticIndex();
            if (sem?.available) {
              const docs = allTools.map((t) => ({ id: t.name, text: `${t.name} ${t.description || ""}` }));
              const semHits = await searchSemantic(sem.vectors, docs, q);
              fused = rrfFuse(bm25Hits, semHits.slice(0, lim * 2), lim);
            }
          } catch (e) {
            logger.warn("semantic leg failed (%s) — BM25 only", e?.message);
          }
        }
        const byName = new Map(allTools.map((t) => [t.name, t]));
        return {
          query: q,
          results: fused.map((h) => {
            const t = byName.get(h.id) || {};
            return {
              name: h.id,
              description: (t.description || "").slice(0, 160),
              server: serverOf(h.id),
            };
          }),
          total: fused.length,
        };
      },
    });
    try {
      ctx.tools.register(toolsSearch);
      logger.info("tools_search registered");
    } catch (e) {
      logger.warn("tools_search register failed: %s", e?.message);
    }
  }

  // L4: `tools_schema` — model-driven full-schema discovery for one tool.
  // Complementary to tools_search: search narrows candidates, this returns the
  // exact parameter schema + full description of one named tool.
  // RED LINE (C3): output MUST be `{ schema: { type: "json" } }` — the return
  // value is an arbitrary tool schema, and a strict object schema with
  // additionalProperties:false would fail the host's "declared property"
  // validation (ToolOutputError). The `type:"json"` annotation schema only
  // checks lossless JSON (C4).
  if (cfg.schemaToolEnabled) {
    const schemaTool = defineTool({
      name: "tools_schema",
      description:
        "Get the complete parameter schema of one tool by name. Use after " +
        "tools_search narrows candidates, or before calling a tool whose exact " +
        "arguments you need. Returns the full JSON schema of parameters plus the " +
        "full description.",
      parameters: {
        name: {
          type: "string",
          required: true,
          description: "Exact tool name, e.g. 'mcp__viking__remember'.",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const name = String(args?.name || "");
        const t = allTools.find((x) => x.name === name);
        if (!t) return { name, found: false, reason: "unknown tool" }; // never throw
        return {
          name: t.name,
          found: true,
          server: serverOf(t.name),
          description: t.description || "",
          // C4 defense: even a schema containing `const: -0` must come back as
          // lossless JSON.
          parameters: sanitizeLossless(t.parameters ?? {}),
          required: Array.isArray(t.parameters?.required) ? t.parameters.required : [],
        };
      },
    });
    try {
      ctx.tools.register(schemaTool);
      logger.info("tools_schema registered");
    } catch (e) {
      logger.warn("tools_schema register failed: %s", e?.message);
    }
  }

  disposers.push(
    ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const t0 = Date.now();
    try {
      const assembled = await next();
      const assembledTools = assembled.tools || [];
      if (!Array.isArray(assembledTools)) return assembled;
      // P2-1 include whitelist + deny config remove tools from the injected
      // surface BEFORE folding. Semantics: include non-empty → whitelist mode,
      // only matching tools enter the pool (injection surface + catalog +
      // tools_search/tools_schema search scope); execution is NOT gated here
      // (C5 — pre-execute only checks deny + firewall). Deny still wins.
      // Meta tools are exempt from include so a whitelist can never hide the
      // discovery tools themselves (that would break the always-visible loop).
      const isMetaTool = (n) => n === "tools_search" || n === "tools_schema";
      const tools = assembledTools.filter(
        (t) =>
          !isDenied(t?.name) &&
          (isMetaTool(t?.name) || includeAll || matchesAnyPattern(t?.name, includePatterns)),
      );
      if (tools.length === 0) return { ...assembled, tools };

      const agentId = context?.agent?.id || "default";
      const coreNames = new Set(cfg.perAgent?.[agentId]?.core || cfg.core || []);
      const hotNames = new Set(
        Object.entries(feedback.calls || {})
          .filter(([, c]) => c >= cfg.hotThreshold)
          .map(([n]) => n),
      );

      const stamp = tools.map((t) => t.name).join("\u0001");
      if (indexStamp !== stamp) {
        // V4 document expansion (measured 0.1.7→0.1.8): the tool corpus is
        // pure-English, so Chinese queries always get df=0 and BM25 scores
        // nothing (measured recall 0/26). Inject per-tool aliases from
        // cfg.aliases (prefix-matched) into the index text — CN recall
        // 0%→88%, EN +15pp, both from the same expansion.
        index = buildIndex(
          tools.map((t) => {
            const aliasWords = [];
            for (const [prefix, keywords] of Object.entries(cfg.aliases || {})) {
              if (t.name.startsWith(prefix)) aliasWords.push(...keywords);
            }
            return {
              id: t.name,
              text: `${t.name} ${t.description || ""} ${aliasWords.join(" ")}`,
            };
          }),
        );
        indexStamp = stamp;
        allTools = tools;
        logger.info("index rebuilt: %d tools (doc-expansion enabled)", tools.length);

      }

      const query = extractQuery(context);
      const dynNames = buildDynamicSet(tools, query);

      // L5: stable ordering — core by config order, hot by name, dyn by name.
      // A deterministic byte order keeps the prompt prefix cacheable.
      const coreTools = tools.filter((t) => coreNames.has(t.name));
      const hotTools = tools
        .filter((t) => !coreNames.has(t.name) && hotNames.has(t.name))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const dynTools = tools
        .filter(
          (t) =>
            !coreNames.has(t.name) &&
            !hotNames.has(t.name) &&
            dynNames.has(t.name),
        )
        .sort((a, b) => (a.name < b.name ? -1 : 1));

      // L1: schema compression + description normalization on the dynamic
      // segment only. core/hot never pass through this pipe (P0 red line).
      const trimmed =
        effectiveLevel !== "off" || cfg.normalizeDescriptions
          ? dynTools.map((t) => {
              let out = t;
              if (cfg.normalizeDescriptions && typeof t.description === "string") {
                out = { ...out, description: normalizeDescription(t.description) };
              }
              return effectiveLevel !== "off"
                ? compressTool(out, { level: effectiveLevel })
                : out;
            })
          : dynTools;

      const visible = [...coreTools, ...hotTools, ...trimmed];

      // The meta-tools must always stay visible or the model can never ask
      // for folded tools (they would be hidden by their own fold).
      const META_TOOLS = [
        { name: "tools_search", enabled: cfg.toolSearchEnabled },
        { name: "tools_schema", enabled: cfg.schemaToolEnabled },
      ];
      for (const m of META_TOOLS) {
        if (m.enabled && !visible.some((t) => t.name === m.name)) {
          const meta = tools.find((t) => t.name === m.name);
          if (meta) visible.push(meta);
        }
      }

      const visibleNames = visible.map((t) => t.name);
      lastVisible = { agentId, names: visibleNames, ts: Date.now() };

      let sections = assembled.sections;
      if (cfg.catalogEnabled) {
        const folded = tools.filter(
          (t) =>
            !isMetaTool(t.name) &&
            !coreNames.has(t.name) &&
            !hotNames.has(t.name) &&
            !dynNames.has(t.name),
        );
        if (folded.length > 0) {
          sections = [...(assembled.sections || []), {
            name: "tool-folder-catalog",
            text: catalogText(folded),
          }];
        }
      }

      logger.info(
        "inject=%d/%d agent=%s dyn=%d hot=%d q=%s",
        visible.length, tools.length, agentId, dynNames.size, hotNames.size,
        query ? query.slice(0, 40) : "(none)",
      );

      return { ...assembled, tools: visible, sections };
    } catch (e) {
      logger.warn("fold failed (%s) — falling back to full tool list", e?.message);
      return next();
    } finally {
      const dt = Date.now() - t0;
      if (dt > cfg.maxFoldMs) logger.warn("assemble fold took %dms (> %dms)", dt, cfg.maxFoldMs);
    }
    }),
  );

  // L3 + L4: heat feedback, coverage recording, and folded-call detection.
  // Bound to `tools/post-execute` — payload = (exec, result), exec.name /
  // exec.arguments are available. (`agent/pre-step` was the original hook but
  // its payload is { messages, ...position, signal } — no toolCalls — so the
  // feedback loop had no data. Verified against dsh-agent-loop preStep().)
  // This listener is deliberately side-effect only: it always returns next()
  // and never throws, so a feedback bug can never turn a tool result into
  // an isError (postExecute wraps a throwing listener as failure).
  disposers.push(
    ctx.on("tools/post-execute", (exec, _result, next) => {
      try {
        const name = exec?.name;
        if (!name) return next();

        // P2-2 toonify (opt-in, default off): compact long JSON text blocks in
        // the result (drop empty fields + truncate long strings). Only fires
        // when the text block is >2000 chars AND parses as JSON; any failure
        // leaves the original block untouched — a compaction bug can never
        // corrupt a tool result.
        if (cfg.toonifyResults && _result && Array.isArray(_result.content)) {
          _result.content = _result.content.map((block) => {
            if (
              block?.type !== "text" ||
              typeof block.text !== "string" ||
              block.text.length <= 2000
            ) {
              return block;
            }
            try {
              const v = JSON.parse(block.text);
              const compact = JSON.stringify(toonifyValue(v), null, 2);
              return compact.length < block.text.length ? { ...block, text: compact } : block;
            } catch {
              return block;
            }
          });
        }

        // Heat counting (L4 feedback).
        feedback.calls[name] = (feedback.calls[name] || 0) + 1;

        // Firewall: record the call sequence and flag exfil chains.
        if (cfg.firewallEnabled !== false) {
          chain.record(name, execArgumentsText(exec?.arguments));
          const exfil = chain.checkChain();
          if (exfil) {
            logger.warn(
              "[firewall] %s: %s",
              exfil.label, exfil.chain.join(" → "),
            );
            feedback.firewall = feedback.firewall || [];
            feedback.firewall.push({ ts: Date.now(), ...exfil });
            if (feedback.firewall.length > 20) {
              feedback.firewall.splice(0, feedback.firewall.length - 20);
            }
          }
        }

        // Folded-call detection: did the model call something we hid?
        const cov = selectionCoverage(lastVisible.names, [name]);
        if (cov.uncovered.length > 0) {
          logger.warn(
            "folded tools called (coverage=%.2f): %s — promoting via heat",
            cov.coverage, cov.uncovered.join(", "),
          );
        }

        // L3: record the last 50 sessions for offline evaluation.
        feedback.sessions.push({
          ts: Date.now(),
          agent: lastVisible.agentId,
          visible: lastVisible.names,
          calls: [name],
          coverage: cov.coverage,
          uncovered: cov.uncovered,
        });
        if (feedback.sessions.length > 50) feedback.sessions.splice(0, feedback.sessions.length - 50);

        persistFeedback(fbPath, feedback, logger);
      } catch (e) {
        logger.warn("post-execute hook error (%s) — best-effort", e?.message);
      }
      return next();
    }),
  );

  // Firewall hard-block + deny config: refuse execution at tools/pre-execute.
  // Host contract (dsh-tools prepareExecution): the waterfall's gate is the
  // last value; return { kind: "deny", reason } to refuse, or next() to allow.
  // exec carries { callId, name, arguments, agent, signal } — no .deny().
  disposers.push(
    ctx.on("tools/pre-execute", (exec, next) => {
      try {
        const name = exec?.name;

        // deny config: refuse execution regardless of firewallEnabled.
        if (isDenied(name)) {
          logger.warn("[deny] tool disabled by config: %s", name);
          return { kind: "deny", reason: `[tool-folder] 工具 ${name} 已被禁用（deny 配置）。` };
        }

        if (cfg.firewallEnabled !== false) {
          // 2026-08-30 修复：高危硬拦只对「执行类工具」生效。
          // 原实现对所有工具的 arguments 跑高危正则，导致内容类工具
          // （write/edit/read 等参数是文件内容/文本）只要含危险命令的
          // 字面量（如讨论、测试、文档中的示例）就被误拦。
          // 执行类工具的参数才是真实要执行的命令，需要硬拦。
          if (isExecTool(name)) {
            const argvText = execArgumentsText(exec?.arguments);
            const v = verdict(argvText);
            if (v?.blocked) {
              logger.warn("[firewall] BLOCKED %s: %s", name, v.label);
              return { kind: "deny", reason: `[tool-folder firewall] 高危命令已拦截（${v.label}）。如需执行请人工确认。` };
            }
          }
        }
      } catch (e) {
        logger.warn("pre-execute hook error (%s) — best-effort", e?.message);
      }
      return next();
    }),
  );

  // Cleanup on plugin unload: no leaked listeners.
  return () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* already disposed */
      }
    }
  };
}
