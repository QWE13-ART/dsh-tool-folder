# dsh-tool-folder 全方位强化方案（2026-08-25，3 轮调研产出）

> 调研方式：deep-skill-finder（社区经验）+ WebSearch（最新实践）+ 多引擎搜索
> + GitHub 热门项目 + **mcp-compressor 0.31.8 源码解包实证** + **langgraph-bigtool 0.0.3 源码解包实证**

---

## 一、3 轮调研结论汇总

### 顶级做法全景（含证据出处）

| 方案 | 出处 | 核心机制 | 可借鉴点 |
|---|---|---|---|
| **mcp-compressor** | Atlassian Labs，Rust+Py+TS | 2 个元工具 `get_tool_schema`+`invoke_tool` 替代全部工具列表；压缩级别 low/medium/high/max；`compress_tool_listing`；70-97% 缩减 | ①**按需展开完整 schema**（我们只有 tools_search 名称列表，没有完整参数 schema！）②压缩级别分级 ③include/exclude 工具过滤 |
| **langgraph-bigtool** | LangChain 官方 544⭐ | 注册表 + semantic search 检索 top-K + **可插拔 retrieve_tools_function（含 category 类别路由）**；limit 参数；检索失败 fallback | ①**类别路由显式化**（我们靠别名隐式路由，可加 category 字段）②limit 语义（我们 topK 已有）③检索失败安全网（我们已有 fallback） |
| **SEP-1576** | 华为，MCP 官方提案 | ①$ref schema 去重 ②可选字段自适应裁剪 ③响应粒度 ④embedding 相似度检索 | ①**可选字段裁剪**（输出 schema 等非必要字段可裁）②描述标准化信号 |
| **Anthropic Code Execution** | Anthropic 工程博客 | 代码即工具，98.7% 节省 | 远期方向（需沙箱），本期不落地 |
| **OpenAI tool search / Lazy Hydration / Progressive Disclosure** | 官方实践 | <20 tools + tool search；动态加载 -91%/-98.7% | 印证我们"折叠+检索"主路径正确 |
| **Adaline / NVIDIA When2Call** | 学术+工程 | **描述是选择信号**：描述>参数名>顺序；描述详细度需标准化 | ①描述重写模板（做什么/何时用/何时不用）②L0 描述标准化 |
| **ReCache / 字节稳定前缀** | 工程 | KV 缓存 97.8% 命中 | 我们 L5 稳定排序已实现，保留 |
| **MintMCP** | 社区 | 新工具默认禁用 | 我们 deny 配置已实现（0.1.4） |
| **DeepSkillFinder 社区** | Meyo | token-budget-guard / context-engineering-diagnostic-optimizer | 概念印证：预算分配+渐进披露+动态装载 |

### 核心认知（3 轮调研反复印证）
1. **折叠/压缩只解决 token 层，不解决选择层**——每轮只暴露少量工具才是主路径（我们已做到）
2. **mcp-compressor 是唯一"把完整 schema 藏起来按需展开"的成熟实现**——我们缺这个
3. **描述即选择信号**——描述质量直接决定工具选择准确率（NVIDIA/Adaline 实证）
4. **顶级实现都有显式类别路由**（bigtool 的 category）或等价机制（我们的别名）

---

## 二、强化方案（P0/P1/P2 分级）

### P0-1【最重要】按需展开完整 schema 的元工具 `tools_schema`
- **现状**：`tools_search` 只返回工具名+描述前 160 字符，模型查到工具后**看不到完整参数 schema**，只能盲猜参数
- **借鉴**：mcp-compressor 的 `get_tool_schema(tool_name)` 返回完整 JSON schema
- **落地**：新增元工具 `tools_schema(name)`，返回该工具完整 `parameters` schema + 完整 description
  - 恒可见（同 tools_search，防被自己折叠）
  - 与 tools_search 互补：search 找名字 → schema 拿参数
- **收益**：模型可以只凭名称+描述做初选，需要时再取参数——完整 schema 不进每轮 prompt

### P0-2 压缩级别分级（激活死配置 compressEnabled）
- **现状**：`compressEnabled: false` 是死配置（L1 从未激活）
- **借鉴**：mcp-compressor 的 low/medium/high/max 分级
- **落地**：`compressLevel: "off" | "light" | "standard" | "aggressive"`
  - light：只裁 description 超长（>500 字符截断）
  - standard：裁 description + 裁可选参数（非 required 参数保留，description 截断 200）
  - aggressive：mcp-compressor 式——只留 name+一行描述+required 参数列表
  - **铁律（沿用 0.1.4 教训）**：不做 $ref（OpenAI/ARK 不解析会杀工具），只做保守字段裁剪
- **收益**：L1 从死代码变分级可用

### P1-1 显式类别路由（category 配置）
- **现状**：别名命中→per-server top-K（0.1.4 已修），但"记忆"→viking 这种靠关键词猜
- **借鉴**：bigtool 的 `retrieve_tools_function` 支持 category 参数（Literal 类型）
- **落地**：config 加 `category: { "记忆/回忆/remember": ["mcp__viking"], "写代码/编码": ["mcp__openhands"], ... }`
  - 比 aliases 更结构化：key 是意图词，value 是目标 server 列表
  - 与 aliases 并存：category 优先，aliases 兜底
  - 命中 category 后同样走 per-server top-K（不整包拉）

### P1-2 描述标准化（L0 落地）
- **现状**：MCP server 的描述质量参差（openviking 单工具 2527 字符、context7 描述冗长）
- **借鉴**：Adaline（描述是决策信号）+ NVIDIA（描述详细度需标准化）
- **落地**：`normalizeDescriptions: true` 时对 dyn 段工具描述做模板化
  - 模板：`{name}。{一句话功能}。适用：{场景}。`
  - 裁剪：description > 300 字符截断到 300，去掉冗余空行/标点堆砌
  - **只作用于 dyn 段**（core 工具不动，防核心能力受损）
  - **注入消毒**：描述裁剪同时吸收注入（与 0.1.4 的"描述重写=消毒"原则一致）

### P2-1 include 白名单（对称 deny）
- **现状**：有 deny（黑名单），无 include（白名单）
- **借鉴**：mcp-compressor 的 `include_tools`
- **落地**：`include: ["prefix*", "exact"]`——配置后**只注入匹配工具**（白名单模式），其余全折叠
- **收益**：极端场景（只想用某 server 时）直接白名单

### P2-2 结果 toonify（可选，低优先）
- **借鉴**：mcp-compressor 的 TOON 输出格式
- **落地**：`toonifyResults: true` 时对长 JSON 结果做紧凑化（删空字段/缩短 key）
- **注意**：与 DSH 执行侧结果处理可能冲突，默认 off，先实现后验证

---

## 三、实施顺序与验收标准

| 顺序 | 项 | 验收标准 |
|---|---|---|
| 1 | P0-1 tools_schema | 元工具注册成功、恒可见、返回完整参数 schema；测试覆盖 |
| 2 | P0-2 compressLevel | 4 档可用；aggressive 档 token 显著下降；不破坏工具可执行 |
| 3 | P1-1 category | 意图词命中→对应 server top-K；与 aliases 兼容 |
| 4 | P1-2 描述标准化 | dyn 段描述模板化；core 不动；注入样例被消毒 |
| 5 | P2-1 include | 白名单模式只注入匹配工具 |
| 6 | P2-2 toonify | 开关可控；不影响结果语义（默认 off） |

## 四、风险与红线
1. **不做 $ref**（OpenAI/ARK 不解析，会杀工具）——0.1.4 已验证
2. **core 工具永不裁剪**（描述标准化只动 dyn 段）
3. **错误路径永远 fallback 全量**（既有安全设计，保留）
4. **防火墙契约不回归**（0.1.4 修好的 {kind:'deny'} 保持）
5. **压缩后工具必须仍可执行**（折叠不删能力）
6. 版本升至 0.1.5，测试从 33 项扩展
