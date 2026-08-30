# DSH 外来插件加载方式调研（2026-08-24）

## 背景
dsh-tool-folder 插件已完整开发（L1-L5，15 项测试 + 真实数据检测全过），
但手动安装三轮受阻。DSH 桌面端弹出「加载外来插件来源」对话框，
手输本地路径 `E:\DSH-Data\dsh-tool-folder` 报「无法加载该来源」。

## 桌面端外来插件加载机制（源码调研结论）

### 1. 来源类型（plugin-manager 源码实证）
- 插件 source 只有两种 kind：**npm** / **git**（`lib/client.js:1085` 校验
  `source.kind !== "npm" && source.kind !== "git"` 报 invalid）
- 安装走 `gateway.install(row.source.spec)`（`lib/client.js:1313`）
- 来源输入支持：npm 包名、`github:owner/repo`、HTTPS（git 协议）

### 2. 本地目录的正确姿势（对话框文案是关键）
- 对话框原文：「**本地 file.link.workspace 目录请用上方系统选择器**」
- → **本地目录必须用系统选择器（文件夹选择对话框），不能手输路径**
- 手输 `E:\DSH-Data\dsh-tool-folder` 被拒 = 「无法加载该来源」的最可能原因
- 系统选择器选目录后，桌面端会解析为 file:/link:/workspace 协议来源

### 3. 隔离恢复会话机制
- 对话框文案：「Desktop 会在下一步显示本机确认，**并只在隔离恢复会话中加载**」
- 桌面端对**外来插件**的安全策略：不直接进宿主，而是开隔离会话
  （workspace 指向插件目录），让 AI/用户验证后再决定是否常驻
- 这与 `dsh-client-ui-plugin-manager` 的 repair 流程一致
  （`create workspace at pluginRoot` + `connectWorkspace`，lib/client.js:1381-1382）

### 4. 为什么宿主 bundle 加载会弹窗（本次事故根因复盘）
- `dsh.profile.bundles` 加外部插件 → cordis 从宿主 node_modules 解析
  （不在宿主 → Module not found → boot 中断 → UI 打不开，已证实）
- 即使放宿主 → 桌面端检测到「外来 bundle」→ 弹「外来插件来源」确认框
- **桌面端对外来插件一律走确认流程，不自动加载**

## 可行路径（按优先级）

### 路径 A：系统选择器选目录（首选，零成本）
1. 在「加载外来插件来源」对话框，点「上方系统选择器」（文件夹选择）
2. 浏览选择 `E:\DSH-Data\dsh-tool-folder`
3. 点「在隔离恢复会话中加载此来源」→ 本机确认
4. 隔离会话里验证插件（AI 检查包结构）→ 通过后应可进入对话页并使用

### 路径 B：Git 来源（若 A 失败）
- 本地 git 仓库：在 E:\DSH-Data\dsh-tool-folder 执行 `git init` + commit，
  然后来源填 `file:///E:/DSH-Data/dsh-tool-folder` 或 git+file 协议
- 或推 GitHub 后用 `github:owner/dsh-tool-folder`（用户无发布渠道，备选）

### 路径 C：npm 来源（需发布，成本高）
- `npm publish` 到 registry 后填包名——个人使用不建议

### 路径 D：等官方机制（观察）
- DSH 生态 1500+ 插件零命中工具折叠（R2 调研），官方无先例；
  若路径 A/B 走通即成为生态首例，可反向贡献

## 已验证的事实（避免重复踩坑）
- cordis bundle 加载器从**宿主** `app.asar.unpacked/node_modules` 解析插件名
  （不是 profile node_modules）——外部插件必须放宿主
- profile node_modules 的 pnpm link 在 Windows 会建空目录（pnpm 11.22）
- `desktop-plugins.lock.json` 的 enabled 不影响 cordis 加载（product-subagents
  也 false 且 mcp-* 不在 lock 也生效）
- 插件代码本身无问题：宿主 import OK、dsh-tools 可解析、defineTool 契约通过、
  L1-L5 测试 15/15 + 真实 45 工具 7 查询全过

## 下一步
1. 用户按路径 A 用系统选择器选 `E:\DSH-Data\dsh-tool-folder`
2. 观察隔离会话加载结果：成功 → 验证折叠；失败 → 收集错误信息定位
3. 若「隔离恢复会话」流程复杂，回退到「手动放宿主 + 用户接受弹窗确认」组合
