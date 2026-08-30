# dsh-tool-folder v0.1.5 强化实现规格（最终版）

> 评审人：架构师高见远。依据：ENHANCEMENT-PLAN-2026-08-25.md + 当前代码（index.js/schema.js/bm25.js/metrics.js/chainguard.js/test.js）+ 宿主 `@deepseek-ai/dsh-tools@0.1.1-rc.1`（app.asar.unpacked）源码实证。
> 本文档是工程师直接实施规格。所有行号基于当前 lib/index.js。

---

## 0. 宿主契约实证结论（评审核心，全部已对照源码验证）

| # | 契约 | 证据 | 对实施的影响 |
|---|---|---|---|
| C1 | defineTool 签名 | dsh-tools lib/index.js:836-882 | 字段：`name/description/parameters/output{schema,render}/isConcurrencySafe?/timeoutMs?/execute(args,exec)`。**output 必填**（:839 直接取 `options.output.render`，缺则 TypeError）。execute 被包装：先 `validateJsonSchemaValue` 校验 args，违规抛 `ToolArgsError`（:862-866） |
| C2 | parameters 是"属性映射 DSL" | :800-808 `parameterSchemaSpecToJsonSchema` → `compilePropertyMap`(:754) | 每条属性用 `{ type, required: true, description, enum, const, default, examples, title }`（ANNOTATION_KEYS :535-540 + required）。`description` 合法 |
| C3 | 输出 schema 支持 `type:"json"` | :686-689 + :441-444 | `type:"json"` 编译为纯注解 schema，校验时只查 lossless JSON（:442）。**tools_schema 的 output 必须用 `{schema:{type:"json"}}`**——动态返回任意工具 schema，若用严格 object schema + additionalProperties:false 会触发 "is not a declared property" → ToolOutputError |
| C4 | lossless JSON 边界 | `isJsonNumber` :125-127（`!Object.is(value,-0)`）；ToolOutputError "value is not lossless JSON" :2468；structuredClone(parameters) dsh-system-prompt :257 | **-0/NaN/Infinity/非纯对象/稀疏数组都会被拒**。裁剪与 tools_schema 返回值必须只产 plain JSON。metrics.js 的 round3 已是先例 |
| C5 | assembly.tools 只含 {name,description,parameters} | dsh-system-prompt :254-258 | 裁剪只作用于这 3 个字段；执行侧按 name 走注册表原始 schema 校验（:862），**折叠/裁剪永远不影响执行** |
| C6 | 执行侧校验器不检查 format/min/max/pattern | checkValue :445-510 | aggressive 可安全丢弃 format/minimum/maximum/pattern 等，不影响执行合法性；**但 required 属性不能删**（缺 required → ToolArgsError "missing required property" :454） |
| C7 | 元工具恒可见机制 | index.js :320-325（当前唯一 "meta" 逻辑） | 注册进 registry 的工具会出现在 assembled.tools（:254-258 经 toolProviders）。折叠后把 meta 从 `tools` 找回来 push 进 visible。**tools_schema 必须进同一块** |
| C8 | 裁剪 schema 不被宿主二次校验 | dsh-system-prompt assemble 只在 plugin 前 structuredClone(:257)，plugin 返回值直接进 buildRequest | 但 ARK/OpenAI 会校验 JSON Schema：**required 必须 ⊆ properties**（否则 provider 拒工具）。裁剪须构造性保证 |

---

## 1. 实施范围与"不做"边界

做：P0-1 tools_schema、P0-2 compressLevel 分级、P1-1 category、P1-2 描述标准化、P2-1 include、P2-2 toonify（默认 off）。
不做（红线，沿用 0.1.4）：
- **不做 $ref** 解析/去重（C8 + OpenAI/ARK 不解析 → 杀工具）
- **core 工具永不裁剪/标准化**（只动 dyn 段）
- **错误路径永远 fallback 全量**（现有 try/catch `return next()`，:350-352 保留）
- 执行侧不因 include/折叠 gate 任何工具（只有 deny + 防火墙 `{kind:"deny"}`，C5）
- 本期不引入 embedding/语义检索（BM25 保留，category 补意图路由）
- toonify 默认**不缩短 key**（改 key 破坏消费者语义）

## 2. 配置项 schema（新增，全部进 DEFAULTS + cordis.patch.yml）

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `schemaToolEnabled` | boolean | `true` | P0-1：注册 tools_schema 元工具 |
| `compressLevel` | `"off"\|"light"\|"standard"\|"aggressive"` | `"off"` | P0-2：L1 压缩分级 |
| `compressEnabled` | boolean | `false` | **废弃兼容**：`compressLevel==="off" && compressEnabled===true` → 按 "standard" 处理（一行兼容，标记 deprecated） |
| `normalizeDescriptions` | boolean | `false` | P1-2：dyn 段描述清洗+消毒+截断 |
| `category` | object | `{}` | P1-1：`{ "记忆/回忆/remember": ["mcp__viking"], ... }`，key 用 `/` 分隔意图词（OR），value 是 server 前缀数组 |
| `include` | string[] | `[]` | P2-1：白名单，`"prefix*"` 或精确名；非空时只注入匹配工具 |
| `toonifyResults` | boolean | `false` | P2-2：长 JSON 结果紧凑化（删空字段），默认 off |

apply() 内归一化（放 DEFAULTS 合并后）：
```js
const VALID_LEVELS = ["off","light","standard","aggressive"];
const compressLevel = VALID_LEVELS.includes(cfg.compressLevel) ? cfg.compressLevel : "off";
const effectiveLevel = compressLevel !== "off" ? compressLevel : (cfg.compressEnabled ? "standard" : "off");
const includePatterns = (cfg.include || []).map((n) => String(n).trim()).filter(Boolean);
const includeAll = includePatterns.length === 0;
const categoryCfg = (cfg.category && typeof cfg.category === "object") ? cfg.category : {};
```

## 3. 文件清单

改：`lib/index.js`、`lib/schema.js`、`test.js`、`package.json`（0.1.4→0.1.5）、`cordis.patch.yml`、`README.md`（配置文档）。
新：`lib/category.js`、`lib/toonify.js`。
不动：`lib/bm25.js`、`lib/metrics.js`、`lib/chainguard.js`。无新增依赖。

---

## 4. P0-1 tools_schema（最重要）

### 4.1 注册（lib/index.js，接在 tools_search 注册块之后，:275 后）
```js
if (cfg.schemaToolEnabled) {
  const schemaTool = defineTool({
    name: "tools_schema",
    description:
      "Get the complete parameter schema of one tool by name. Use after " +
      "tools_search narrows candidates, or before calling a tool whose exact " +
      "arguments you need. Returns the full JSON schema of parameters plus the " +
      "full description.",
    parameters: {
      name: { type: "string", required: true,
        description: "Exact tool name, e.g. 'mcp__viking__remember'." },
    },
    output: { schema: { type: "json" },
      render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const name = String(args?.name || "");
      const t = allTools.find((x) => x.name === name);
      if (!t) return { name, found: false, reason: "unknown tool" }; // 永不 throw
      return {
        name: t.name, found: true, server: serverOf(t.name),
        description: t.description || "",
        parameters: sanitizeLossless(t.parameters ?? {}),
        required: Array.isArray(t.parameters?.required) ? t.parameters.required : [],
      };
    },
  });
  try { ctx.tools.register(schemaTool); logger.info("tools_schema registered"); }
  catch (e) { logger.warn("tools_schema register failed: %s", e?.message); }
}
```
- **output 必须 `type:"json"`**（C3）；description 里同时写 tools_search 的名字建立互补指引。
- 只搜 `allTools`（= 折叠池，已过 deny/include 过滤）→ **被 deny 的工具 schema 不泄露**。
- 未 assemble 时 `allTools` 为空 → 走 `found:false`（不会 throw，不会 isError）。

### 4.2 恒可见（替换 :320-325）
```js
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
```

### 4.3 sanitizeLossless（lib/schema.js 新增导出）
```js
export function sanitizeLossless(v) {
  if (typeof v === "number") return (Number.isFinite(v) && !Object.is(v, -0)) ? v : 0;
  if (Array.isArray(v)) return v.map(sanitizeLossless);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = sanitizeLossless(v[k]);
    return out;
  }
  return v; // string/boolean/null/undefined(丢弃路径不进入)
}
```
C4 防线：即便原 schema 含 `const:-0`，返回体也必为 lossless JSON（测试用例 17）。

---

## 5. P0-2 compressLevel（重写 lib/schema.js）

### 5.1 compressTool 分级（替换现有函数，保留旧 opts 兼容可删）
```js
const LEVELS = {
  light:      { descLimit: 500, paramDescLimit: Infinity, dropOptional: false },
  standard:   { descLimit: 200, paramDescLimit: 120,      dropOptional: false },
  aggressive: { descLimit: 120, paramDescLimit: 60,       dropOptional: true  },
};
export function compressTool(tool, { level = "off" } = {}) {
  if (level === "off") return tool;
  const t = LEVELS[level] ?? LEVELS.standard;
  const out = { ...tool };
  if (typeof out.description === "string" && out.description.length > t.descLimit)
    out.description = out.description.slice(0, t.descLimit) + " …";
  const params = out.parameters;
  if (!params || typeof params !== "object" || !params.properties ||
      typeof params.properties !== "object") return out; // 非 object-root → 只裁描述
  const required = Array.isArray(params.required)
    ? params.required.filter((n) => typeof n === "string") : [];
  const keep = new Set(t.dropOptional ? required : Object.keys(params.properties));
  const props = {};
  for (const [key, raw] of Object.entries(params.properties)) {
    if (!keep.has(key)) continue;
    const p = { ...raw }; // 不动 $ref/oneOf/items/properties 深层结构（红线）
    if (typeof p.description === "string" && p.description.length > t.paramDescLimit)
      p.description = p.description.slice(0, t.paramDescLimit) + " …";
    props[key] = p;
  }
  out.parameters = { ...params, properties: props };
  return out;
}
```
执行安全论证（C5/C6/C8）：
- `dropOptional` 时 properties 只由 required 名字构造 → **required ⊆ properties 构造性成立**。
- 只删可选属性 → 模型少传可选参数，注册表原始校验仍通过（缺 optional 不违规）。
- **required 属性绝不被删**（缺 → ToolArgsError）。
- 属性保留 `type/enum/const/items/properties/required/oneOf/$ref` 原样（执行相关结构）；只裁 description。
- aggressive 下 `required=[]` → `properties={}`（工具变成无参黑盒，mcp-compressor 同款激进语义，opt-in）。
- 纯 slice/字面量构建 → 无 -0/NaN 风险。

### 5.2 接线（lib/index.js :316 替换）
```js
const trimmed = effectiveLevel !== "off" || cfg.normalizeDescriptions
  ? dynTools.map((t) => {
      let out = t;
      if (cfg.normalizeDescriptions && typeof t.description === "string")
        out = { ...out, description: normalizeDescription(t.description) };
      return effectiveLevel !== "off" ? compressTool(out, { level: effectiveLevel }) : out;
    })
  : dynTools;
```
core/hot 段（:311-312）完全不经过此管道。

---

## 6. P1-2 描述标准化（lib/schema.js 新增）

```js
const INJECTION_MARKERS = [
  /\bignore\s+(all\s+)?(previous|prior|above)\b/i,
  /\bsystem\s*:/, /\[\s*\/?\s*system\s*\]/i,
  /^\s*(你|you)\s*(现在|现在开始|are)\b/i,
];
export function normalizeDescription(desc, { firstSentence = true } = {}) {
  let s = String(desc || "");
  for (const re of INJECTION_MARKERS) s = s.replace(re, " "); // 注入消毒
  s = s.replace(/\s+/g, " ").replace(/[。．.!！]{2,}/g, "。").trim();
  if (firstSentence) {
    const m = s.match(/^.{1,120}?[。.!?；;]/);
    if (m) s = m[0];
  }
  return s.length > 300 ? s.slice(0, 300) + " …" : s;
}
```
- 只作用于 dyn 段（见 5.2 接线）；core 不动。
- **方案偏差（诚实声明）**：计划中的模板 `{name}。{一句话功能}。适用：{场景}。` 需要外部场景知识，当前无数据源，落地为"首句提取 + 空白归一 + 注入消毒 + 300 截断"。模板化留待有描述元数据时再做。

---

## 7. P1-1 category（新 lib/category.js + index.js 重构）

### 7.1 lib/category.js（纯函数，可单测）
```js
export function matchCategory(queryLower, category) {
  const matches = [];
  for (const [key, servers] of Object.entries(category || {})) {
    const keywords = String(key).split(/[/,，、]/)
      .map((s) => s.trim().toLowerCase()).filter(Boolean);
    const hit = keywords.filter((k) => queryLower.includes(k));
    if (hit.length === 0 || !Array.isArray(servers)) continue;
    for (const server of servers)
      matches.push({ server: String(server), keywords: hit });
  }
  return { matched: matches.length > 0, matches };
}
```

### 7.2 index.js：抽公共 per-server top-K 助手 + buildDynamicSet 重构（替换 :173-210）
```js
function addPerServerTopK(dyn, tools, serverPrefix, bridgedQuery, maxK) {
  const serverIndices = [];
  for (let i = 0; i < tools.length; i++)
    if (tools[i].name.startsWith(serverPrefix)) serverIndices.push(i);
  if (serverIndices.length === 0) return;
  const k = Math.min(maxK, serverIndices.length);
  let ranked = [];
  if (index) {
    ranked = search(index, bridgedQuery, serverIndices.length,
      { filter: (i) => tools[i].name.startsWith(serverPrefix) });
  }
  if (ranked.length === 0) { // 无词法信号 → 稳定名字序兜底（沿用 :201-204）
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
  const cat = matchCategory(q, categoryCfg);
  if (cat.matched) {                    // category 优先
    for (const m of cat.matches)
      addPerServerTopK(dyn, tools, m.server, `${query} ${m.keywords.join(" ")}`, 3);
  } else {                              // aliases 兜底（现有行为原样保留）
    for (const [prefix, keywords] of Object.entries(cfg.aliases || {})) {
      const matched = keywords.filter((k) => q.includes(String(k).toLowerCase()));
      if (matched.length === 0) continue;
      addPerServerTopK(dyn, tools, prefix, `${query} ${matched.join(" ")}`, 3);
    }
  }
  if (cfg.topK > 0 && index)             // 通用 BM25 最后并入（∪，结果集不变）
    for (const i of search(index, query, cfg.topK)) dyn.add(tools[i].name);
  return dyn;
}
```
- **优先级**：category 命中 → 只走 category 的 per-server top-K + 通用 BM25；**跳过 aliases**。category 未命中 → 现有 BM25+aliases 原样。
- 行为兼容：最终 visible 按名字排序（:313），dyn 是并集，BM25 从"先加"改"后加"不改变结果集。
- category 与 aliases 并存互不干扰；默认 `{}` 时完全无行为变化（回归测试 11）。

---

## 8. P2-1 include 白名单（lib/index.js）

### 8.1 提取公共模式匹配器（替换 :159-171 的 isDenied 实现）
```js
function matchesAnyPattern(name, patterns) {
  if (!name || !patterns || patterns.length === 0) return false;
  const n = String(name);
  for (const p of patterns) {
    if (p.endsWith("*")) { if (n.startsWith(p.slice(0, -1))) return true; }
    else if (n === p) return true;
  }
  return false;
}
const isDenied = (n) => matchesAnyPattern(n, denyPatterns);
```

### 8.2 池过滤（替换 :285）
```js
const isMetaTool = (n) => n === "tools_search" || n === "tools_schema";
const tools = assembledTools.filter((t) =>
  !isDenied(t?.name) &&
  (isMetaTool(t?.name) || includeAll || matchesAnyPattern(t?.name, includePatterns)));
```
- 语义：include 非空 → 白名单模式，只有匹配工具进入池（注入面 + catalog + tools_search/tools_schema 检索范围）；**执行不 gate**（C5，pre-execute 只查 deny/防火墙）。
- **meta 工具豁免 include**（否则白名单把 tools_schema 自己也滤掉 → 恒可见失效）。
- deny 仍优先（同时被 deny+include → deny 赢）。

---

## 9. P2-2 toonify（新 lib/toonify.js + 可选接线）

### 9.1 lib/toonify.js（纯函数）
```js
export function toonifyValue(value, { maxStr = 200 } = {}) {
  if (value === null || value === undefined) return undefined; // 删空
  if (typeof value === "string") {
    const s = value.trim();
    return s.length === 0 ? undefined : (s.length > maxStr ? s.slice(0, maxStr) + "…" : s);
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
  return value; // number/boolean 原样（无 -0 改动）
}
```
- 只删空字段 + 截长串；**不缩短 key**（默认，改 key 破坏语义）。
- 输出仍为 lossless JSON（纯字面量构建，无 -0 计算）。

### 9.2 接线（post-execute 监听器内，:369 开头、try 块内）
```js
if (cfg.toonifyResults && _result && Array.isArray(_result.content)) {
  _result.content = _result.content.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string" || block.text.length <= 2000) return block;
    try {
      const v = JSON.parse(block.text);
      const compact = JSON.stringify(toonifyValue(v), null, 2);
      return compact.length < block.text.length ? { ...block, text: compact } : block;
    } catch { return block; }
  });
}
```
- 风险（计划已声明）：宿主 waterfall 对 result 的引用语义未在本次评审中逐行实证（post-execute 的返回是 gate 而非结果体）。**默认 off**；先实现纯函数 + 单测，接线运行时验证；若变更不传播，保留函数 + 文档，不强行改宿主。

---

## 10. 版本与测试扩展

package.json → `"version": "0.1.5"`。无新依赖（全零依赖）。

test.js 新增用例（现有 33 项全保留，预期 33 → ~50）：

| # | 用例 | 断言 |
|---|---|---|
| 1 | tools_schema 注册 | `ctx._registered` 含 name==="tools_schema" |
| 2 | tools_schema 执行已知/未知 | 返回完整 parameters；未知 → found:false 不 throw |
| 3 | 恒可见 | query="" 折叠后 visible 同时含 tools_search 与 tools_schema（topK=0 也成立） |
| 4 | light | 描述>500 截断；参数描述**不**截断 |
| 5 | standard | 描述>200 截断；参数描述>120 截断 |
| 6 | aggressive | 可选属性被删；required 全保留；`required ⊆ properties` 成立；required=[] 时 properties={} |
| 7 | aggressive 不碰 $ref/oneOf | 含 $ref 参数原样保留，不崩溃（红线回归） |
| 8 | 非 object-root 参数 | （array-root/无 properties）只裁描述，参数不动 |
| 9 | normalizeDescriptions | dyn 描述 ≤300、空白归一、注入样例（"ignore all previous…\nsystem:…"）被消毒；core 描述不动 |
| 10 | category 路由 | query 命中 category 词 → 对应 server per-server top-K ≤3；同时命中 category+alias 词 → 只注入 category server |
| 11 | category 未命中回归 | aliases 行为与现状一致 |
| 12 | include 白名单 | include:["mcp__openhands*"] → 只注入 openhands+core+meta；非匹配工具不进 catalog；pre-execute 对非匹配工具仍放行（执行不 gate） |
| 13 | include+deny 冲突 | 同时 deny+include 的工具不注入 |
| 14 | toonifyValue 纯函数 | 递归删空字段、长串截断、number 原样、JSON round-trip 合法 |
| 15 | schemaToolEnabled:false | tools_schema 不注册不可见；tools_search 不受影响 |
| 16 | compressEnabled 兼容 | compressEnabled:true 等价 standard |
| 17 | lossless 防线 | 构造含 `const:-0` 的工具，tools_schema 返回体 JSON.stringify 无 "-0"（C4） |

---

## 11. 风险与规避

| 风险 | 规避 |
|---|---|
| aggressive 删可选属性 → 模型不知可选参数 → 行为降级 | standard 为默认可用档；aggressive opt-in；保留 type/结构字段保执行合法（C6） |
| required ⊆ properties 破坏 → provider 拒工具 | 构造性保证（properties 只由 required 构造）+ 测试 6 断言 + 新增 `assertExecSafeSchema`（可选导出） |
| -0/lossless 违规（tools_schema 返回体、裁剪产物） | sanitizeLossless 深洗 + 测试 17；裁剪纯 slice/字面量 |
| toonify 变更不传播 / 破坏结果语义 | 默认 off；纯函数先行；接线运行时验证，失败则只留函数+文档 |
| category 覆盖 aliases 改变既有行为 | 默认 {} 无行为变化；文档写明优先级；测试 11 回归 |
| normalize 误伤 core | 只走 dyn 管道（5.2）；测试 9 断言 core 不动 |
| include 滤掉 meta → 恒可见失效 | isMetaTool 豁免（8.2） |
| tools_schema 返回大 schema 的 token 成本 | 仅模型主动调用才发生；每轮 prompt 不携带（这正是收益） |

## 12. 实施顺序

P0-1 → P0-2(+P1-2) → P1-1(+P2-1) → P2-2(+文档)。每步保持 33 项旧测试全绿再合入。

## 13. Anything UNCLEAR

1. toonify 的 result 变更在宿主 post-execute waterfall 是否传播——需运行时实证（P2-2 已默认 off 兜底）。
2. 描述模板 `适用：{场景}` 缺数据源，本期降级为"首句+清洗+消毒"（见 §6 偏差声明）。
3. 宿主对 assembly.tools 的 provider 端 schema 校验细节（ARK 侧）无法本地实证——以"required⊆properties + 无 $ref + lossless"三条构造性保证兜底。
4. category 命中时是否也应 skip 通用 BM25（当前设计保留并集）——如需"纯 category 模式"可加 `categoryOnly: true`，本期不做。
