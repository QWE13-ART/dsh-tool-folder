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
import { compressTool, normalizeDescription } from "./schema.js";
import { selectionCoverage, isHotTool, prioritizeExact, touchWarm, evictWarm, missingMetaTools } from "./metrics.js";
import { tierForBudget } from "./budget.js";
import { readState, writeState } from "./storage.js";
import { expandQuery, fallbackCatalog, createSearchCache, recordDiscoveries, serializeDiscoveries, deserializeDiscoveries, siblingClosure, buildSchemaResponse } from "./ux.js";
import { ChainGuard, verdict, isExecTool } from "./chainguard.js";
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
  hotWindowDays: z.number().min(0).max(365).default(3)
    .description("hot 热度的滑动窗口（天）：窗口内达标才常驻，超窗自动衰减；0=永不过期"),
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
  embedTimeoutMs: z.number().min(100).default(8000).description("embedding 请求超时（毫秒；Ollama 慢时可调大）"),
  disclosureBudget: z.number().min(0).max(200000).default(0)
    .description("分级披露预算（字节）：0=关闭。开启后可见工具 schema 估算字节超预算时，动态段按 完整schema→name+desc→仅name→折叠进catalog 逐级降级（core/hot 永不降级）"),
  maxWarmTools: z.number().min(0).max(50).default(0)
    .description("warm LRU 上限：tools_search/schema 发现或折叠后被调用的工具进入 warm 集合，下一轮注入（完整 schema）；达上限逐出最久未用；0=关闭（默认关，无配置升级逐字节等价，显式开启才启用）"),
  fallbackCatalogSize: z.number().min(0).max(200).default(30)
    .description("P0: tools_search 零匹配时回退的轻目录条数（name+80字描述，名字典序）；0=关闭回退（返回空=旧行为）"),
  queryExpandEnabled: z.boolean().default(true)
    .description("P0: 中文意图→英文同义词扩展（只加词不改原词，扩大 BM25/语义召回；精确名匹配不受影响）"),
  closureSize: z.number().min(0).max(20).default(0)
    .description("P1: tools_schema 展开时附带同 server 兄弟工具的轻目录条数（name+120字描述，名字典序）；0=关闭（默认关=无配置升级输出逐字段等价，显式开启才启用，与 maxWarmTools 先例一致）"),
});

const DEFAULTS = {
  enabled: true,
  perAgent: {},
  core: [],
  deny: [], // never inject + refuse execution (exact name or "prefix*")
  topK: 6,
  hotThreshold: 3,
  hotWindowDays: 3, // v0.2.1: sliding-window heat decay (0 = never expire)
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
  embedTimeoutMs: 8000, // P3-2: embedding 请求超时（毫秒）
  disclosureBudget: 0, // v0.2.2: 分级披露预算（0=关闭）
  maxWarmTools: 0, // v0.2.2: warm LRU 上限（0=关闭，默认关=无配置升级逐字节等价）
  fallbackCatalogSize: 30, // P0: 零匹配回退轻目录条数（0=关闭）
  queryExpandEnabled: true, // P0: 中文→英文 query 扩展
  closureSize: 0, // P1: tools_schema 同 server 兄弟闭包（默认关=逐字段等价，显式开启）
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
  configureSemantic({ ollamaBase: cfg.ollamaBase, embedModel: cfg.embedModel, embedTimeoutMs: cfg.embedTimeoutMs });
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

  /* ------------------------------------------------------------------ */
  /* v0.2.2: warm LRU + 配置三级持久化                                    */
  /* ------------------------------------------------------------------ */
  // warm：Map<name, {last}>，LRU 顺序由 last 单调递增序号决定。被
  // tools_search 搜到 / tools_schema 展开 / 折叠后仍被调用的工具进入集合，
  // 下一轮注入完整 schema。maxWarmTools=0 时整个 warm 失效（仍不 touch）。
  const warm = new Map();
  const warmEnabled = cfg.maxWarmTools > 0;
  const touchWarmNames = (names) => {
    if (!warmEnabled || !Array.isArray(names) || names.length === 0) return;
    touchWarm(warm, names, Date.now(), cfg.maxWarmTools);
    persistWarmState();
  };

  // 三级持久化：① feedbackPath 同目录（首选）→ ② ~/.dsh/state/ → ③ 进程内。
  // ⚠️ 绝不写 cordis.patch.yml（宿主配置，插件只读宿主、只落自有 state 文件）。
  const primaryStateFile = () => path.join(path.dirname(fbPath), "tool-folder-state.json");
  const fallbackStateFile = () => {
    const home = process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME || "";
    return home ? `${home}/.dsh/state/tool-folder-state.json` : "tool-folder-state.json";
  };
  let activeStateFile = primaryStateFile();
  const restoreWarm = () => {
    if (!warmEnabled) return; // 关闭态绝不载入磁盘残留（Spec 2: maxWarmTools=0=彻底关闭）
    let cloud = readState(activeStateFile, null);
    if (!cloud) {
      activeStateFile = fallbackStateFile();
      cloud = readState(activeStateFile, null);
    }
    if (cloud && Array.isArray(cloud.warm)) {
      for (const [name, meta] of cloud.warm) {
        if (typeof name === "string" && meta && typeof meta.last === "number") {
          warm.set(name, { last: meta.last });
        }
      }
      evictWarm(warm, cfg.maxWarmTools); // 载入即按上限裁剪
    }
  };
  const persistWarmState = () => {
    if (!warmEnabled) return;
    // merge 写：与 discoveries 共用 state 文件，整写会互抹（Standards 轴 P1）。
    const payload = { ...readState(activeStateFile, {}), warm: [...warm.entries()], ts: Date.now() };
    let ok = writeState(activeStateFile, payload);
    if (!ok) {
      // 首选目录不可写 → 降到 ~/.dsh/state/
      activeStateFile = fallbackStateFile();
      writeState(activeStateFile, payload);
    }
  };
  restoreWarm();

  // P0-④: 发现率统计（独立于 warm 门控——maxWarmTools=0 时统计照常工作）。
  // 与 warm 共用同一个 state 文件；落盘节流 30s（工具输出非注入面，频率低）。
  let discoveries = new Map();
  let lastPersistTs = 0;
  const restoreDiscoveries = () => {
    let cloud = readState(activeStateFile, null);
    if (!cloud) {
      activeStateFile = fallbackStateFile();
      cloud = readState(activeStateFile, null);
    }
    discoveries = deserializeDiscoveries(cloud && Array.isArray(cloud.discoveries) ? cloud.discoveries : null);
  };
  const persistDiscoveries = () => {
    const now = Date.now();
    if (now - lastPersistTs < 30000) return; // 节流：30s 内只写一次
    lastPersistTs = now;
    // merge 写：与 warm 共用 state 文件，整写会互抹（Standards 轴 P1）。
    const payload = { ...readState(activeStateFile, {}), discoveries: serializeDiscoveries(discoveries), ts: now };
    let ok = writeState(activeStateFile, payload);
    if (!ok) {
      activeStateFile = fallbackStateFile();
      writeState(activeStateFile, payload);
    }
  };
  restoreDiscoveries();
  if (discoveries.size > 0) {
    const top = serializeDiscoveries(discoveries, 5).map((e) => `${e.name}(${e.count})`).join(", ");
    logger.info("discovery stats restored: %d tools, top: %s", discoveries.size, top);
  }

  // P0-②: 检索结果缓存（同 query 60s 内稳定；LRU 200 条；进程级共享）。
  const searchCache = createSearchCache(200, 60000);

  // serverOf is the module-level one (L194): mcp__server__tool → "mcp__server",
  // openhands_* → "openhands", plain native tools → "native". P3-1 (2026-09-02):
  // the previous apply-local copy (split("__").slice(0,2)) let plain tools be
  // their own "server", diverging from catalogText grouping and making sibling
  // closure useless for native/openhands families. One definition, one口径.

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
        fallback: { type: "boolean", description: "true = 零匹配，结果回退为按名字典序的轻目录" },
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
        // 整体 fail-open 兜底（Spec 轴 P2）：任何未来 helper 意外抛错 → 空结果
        // 而非硬失败，保持"折叠绝不误伤能力"的底线。
        try {
          const q = String(args.query || "");
          const lim = args.limit ?? 8;
          if (!index) return { query: q, results: [], total: 0 };
        // P0-②: 同 query 内容指纹的结果缓存——重复搜索返回同一结果集（漂移的
        // 最小修）。进程级共享（非单会话隔离）；空 query（"*" 语义）不走缓存。
        const cacheKey = `${lim}|${q}`;
        if (q) {
          const cached = searchCache.get(cacheKey);
          if (cached) return cached;
        }
        // P0-③: 中文意图→英文同义词扩展（只加词不改原词；精确名匹配用原 q）。
        const eq = cfg.queryExpandEnabled !== false ? expandQuery(q) : q;
        // v0.2.1: exact-name > name-substring > BM25 priority (deterministic
        // fallback chain, borrowed from Hermes-style tool search).
        const bm25Hits = prioritizeExact(
          allTools,
          q,
          search(index, eq, lim * 2).map((i) => ({ id: allTools[i].name })),
        );
        let fused = bm25Hits;
        // Semantic leg (P0-1): RRF-fuse BM25 with local bge-m3 similarity.
        // Any failure (Ollama down / timeout / cache miss on error) degrades
        // to BM25-only — the hybrid must never be slower or worse than today.
        if (cfg.semanticEnabled !== false) {
          try {
            const sem = await getSemanticIndex();
            if (sem?.available) {
              const docs = allTools.map((t) => ({ id: t.name, text: `${t.name} ${t.description || ""}` }));
              const semHits = await searchSemantic(sem.vectors, docs, eq);
              fused = rrfFuse(bm25Hits, semHits.slice(0, lim * 2), lim);
            }
          } catch (e) {
            logger.warn("semantic leg failed (%s) — BM25 only", e?.message);
          }
        }
        const byName = new Map(allTools.map((t) => [t.name, t]));
        let results = fused.map((h) => {
          const t = byName.get(h.id) || {};
          return {
            name: h.id,
            description: (t.description || "").slice(0, 160),
            server: serverOf(h.id),
          };
        });
        // P0-①: 零匹配回退轻目录（name+80字描述，名字典序）——根治「搜词不对
        // 就以为没有该能力」。fallbackCatalogSize=0 关闭（返回空=旧行为）。
        // total 在回退时=全量目录大小（而非列出条数），避免模型误以为目录总容量=limit。
        let fallback = false;
        if (results.length === 0 && cfg.fallbackCatalogSize > 0) {
          results = fallbackCatalog(allTools, cfg.fallbackCatalogSize, serverOf);
          fallback = true;
        }
        // v0.2.2: 被搜到的工具名进入 warm 集合，下一轮注入完整 schema。
        touchWarmNames(results.map((r) => r.name));
        // P0-④: 发现率统计（节流落盘，低频工具名单反哺描述改进）。
        recordDiscoveries(discoveries, results.map((r) => r.name));
        persistDiscoveries();
        const out = {
          query: q,
          results,
          total: fallback ? allTools.length : results.length,
          ...(fallback ? { fallback: true } : {}),
        };
        if (q) searchCache.set(cacheKey, out);
        return out;
        } catch (e) {
          logger.warn("tools_search failed (%s) — empty results", e?.message);
          return { query: String(args.query || ""), results: [], total: 0 };
        }
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
        "Get the complete parameter schema of one or more tools by name. Use after " +
        "tools_search narrows candidates, or before calling a tool whose exact " +
        "arguments you need. Returns the full JSON schema of parameters plus the " +
        "full description; sibling tools from the same server are listed alongside " +
        "(lightweight) so you can batch-expand what you need.",
      parameters: {
        name: {
          type: "string",
          description: "Exact tool name, e.g. 'mcp__viking__remember' (either name or names).",
        },
        names: {
          type: "array",
          items: { type: "string" },
          description: "Batch: exact tool names to expand in one call (either name or names).",
        },
        closure: {
          type: "boolean",
          description: "Include lightweight sibling tools from the same server (default true).",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        // P1: 批量展开（names 数组）+ 同 server 兄弟闭包（closureSize 条轻目录）。
        // 输出契约全部在 buildSchemaResponse（纯函数，lib/ux.js 可单测）。
        const res = buildSchemaResponse(allTools, args, { closureSize: cfg.closureSize, serverOf });
        // v0.2.2: 展开过 schema 的工具名进入 warm 集合，下一轮保持注入。
        touchWarmNames(
          Array.isArray(res.results) ? res.results.map((r) => r.name) : res.found && res.name ? [res.name] : [],
        );
        return res;
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
      // v0.2.1: hot = sliding-window decay (hotWindowDays). Tools not called
      // inside the window lose their historical heat — the old code promoted
      // forever, which slowly nullified the fold.
      const hotNames = new Set(
        Object.keys(feedback.calls || {}).filter((n) =>
          isHotTool(feedback.calls, n, cfg.hotThreshold, cfg.hotWindowDays * 86400000)),
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

      // v0.2.2: warm 集合名（只取当前工具池里存在的，避免引用已不存在的工具）。
      const warmNamesSet = new Set(
        [...warm.keys()].filter((n) => tools.some((t) => t.name === n)),
      );

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
            !warmNamesSet.has(t.name) &&
            dynNames.has(t.name),
        )
        .sort((a, b) => (a.name < b.name ? -1 : 1));

      // v0.2.2: warm = 上一轮被 tools_search/schema 发现或折叠后被调用的工具。
      // 属主动晋升（接近 hot），完整 schema 注入，不作为 budget 可降级段。
      const warmTools = tools
        .filter(
          (t) =>
            !coreNames.has(t.name) &&
            !hotNames.has(t.name) &&
            warmNamesSet.has(t.name),
        )
        .sort((a, b) => (a.name < b.name ? -1 : 1));

      // L1: schema compression + description normalization on the dynamic
      // segment only. core/hot/warm never pass through this pipe (P0 red line).
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

      // v0.2.2 分级披露预算：动态段（trimmed）是唯一可降级段。core/hot/warm
      // 作为 protected 恒层级 1。tierForBudget 返回每个可见名字的降级层级；
      // 层级 2/3 组装压缩形态，层级 4 不再注入（由 catalog 兜底发现）。
      let visible = [...coreTools, ...hotTools, ...warmTools, ...trimmed];
      if (cfg.disclosureBudget > 0) {
        const protectedNames = new Set([
          ...coreNames,
          ...hotNames,
          ...warmNamesSet,
          // meta 工具永远完整可见
          "tools_search",
          "tools_schema",
        ]);
        const tiers = tierForBudget(visible, cfg.disclosureBudget, protectedNames);
        // Effective budget = min(disclosureBudget, context estimate). We do not
        // separately measure context here, so the hard disclosureBudget stands.
        // Rebuild visible honoring per-tool tiers (they are already ordered).
        visible = visible.map((t) => {
          const tier = tiers.byName[t.name] || 1;
          if (tier === 1) return t; // 完整 schema
          if (tier === 2) {
            // name + description（描述压缩至 100 字符）
            return {
              name: t.name,
              description: String(t.description || "").slice(0, 100),
            };
          }
          if (tier === 3) {
            // 仅 name（一行一个）
            return { name: t.name };
          }
          return null; // 层级 4：折叠进 catalog，不注入
        }).filter(Boolean);
      }

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

      // v0.2.2 fail-open 硬保证（借鉴 fan56/dsh-mcp-adapter）：启用的发现
      // 元工具仍缺失（注册失败/名冲突/部分启动）→ 折叠后工具不可发现，
      // 比不折叠更糟——显式回退官方全量工具列表，绝不静默吞掉发现路径。
      const missingMeta = missingMetaTools(
        new Set(visible.map((t) => t.name)),
        { tools_search: cfg.toolSearchEnabled, tools_schema: cfg.schemaToolEnabled },
      );
      if (missingMeta.length > 0) {
        logger.warn(
          "fail-open: meta tool(s) %s missing after fold — falling back to full tool list",
          missingMeta.join(","),
        );
        return next();
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
            !warmNamesSet.has(t.name) &&
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

        // Heat counting (L4 feedback). v0.2.1: upgrade to { n, ts } so the
        // hot gate can decay stale heat; legacy number entries are kept
        // readable by isHotTool (ts=0 → outside any positive window).
        const prev = feedback.calls[name];
        feedback.calls[name] = {
          n: (typeof prev === "number" ? prev : prev?.n || 0) + 1,
          ts: Date.now(),
        };

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
          // v0.2.2: 折叠后仍被调用的工具名也进 warm，下一轮避免再折叠。
          touchWarmNames(cov.uncovered);
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
