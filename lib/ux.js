/**
 * ux.js — P0 折叠体验改进（2026-08-30 第二轮调研落地，来源见 AGENTS.md §0.3）。
 *
 * 四个纯函数/工厂，全部不触碰注入面（每轮 prompt 字节零变化，兼容红线保持）：
 *   ① expandQuery       中文高频意图 → 追加英文检索词（只加词不改原词；BM25 召回
 *                        更宽，精确名匹配 prioritizeExact 仍用原 query，不受影响）
 *   ② fallbackCatalog   tools_search 零匹配时回退的全量轻目录（name + 80 字描述，
 *                        按名字典序稳定排序）——根治「搜词不对就以为没有」
 *   ③ createSearchCache 同 query 内容指纹的结果缓存（固定 TTL + LRU 上限）——
 *                        同会话重复搜索返回同一结果集（漂移的最小修）
 *   ④ recordDiscoveries 发现率统计（name→count，落盘可恢复）——低频工具名单
 *                        反哺描述改进（官方「监控发现率」建议的本地等价物）
 *   P1 ⑤ siblingClosure 同 server 兄弟闭包 ⑥ buildSchemaResponse tools_schema
 *                        输出契约（单数/批量/siblings/missing 全分支，可单测）
 */
import { sanitizeLossless } from "./schema.js";

/* ------------------------- ① query 扩展词表 ------------------------- */

/** 中文高频意图 → 英文检索词。只做「包含即追加」，不做分词/替换。 */
const EXPAND = {
  搜索: "search find lookup",
  查找: "search find lookup",
  文件: "file files read write edit",
  图片: "image picture photo vision ocr",
  截图: "screenshot screen capture image",
  识别: "ocr recognize extract text",
  文字: "text ocr recognize",
  数据库: "database db sql query",
  查询: "query select fetch search",
  网络: "network web http fetch url",
  浏览器: "browser chrome page navigate",
  下载: "download fetch get",
  上传: "upload put push",
  发布: "publish deploy release",
  部署: "deploy release publish",
  测试: "test run verify",
  运行: "run execute start",
  执行: "run execute command",
  命令: "command shell exec terminal",
  安装: "install setup configure",
  配置: "config configure setup",
  错误: "error fail exception debug",
  修复: "fix repair patch debug",
  删除: "delete remove rm",
  创建: "create new make init",
  修改: "edit update modify change",
  查看: "view show list inspect read",
  列表: "list enumerate show",
  记忆: "memory remember recall viking",
  技能: "skill search catalog",
  工具: "tool search schema",
  定时: "schedule cron timer",
  提醒: "remind schedule alert",
  邮件: "email mail send",
  键盘: "keyboard type input",
  鼠标: "mouse click move",
  窗口: "window open close",
  进程: "process task list kill",
  服务: "service server daemon",
  日志: "log trace tail",
  监控: "monitor watch observe",
  版本: "version release tag git",
  提交: "commit push git",
  分支: "branch git merge",
  仓库: "repo repository git",
  会话: "session agent",
  对话: "chat session message",
};

/**
 * 中文意图 → 扩展查询串：命中的每个中文词追加其英文同义词组到尾部。
 * 无中文（或词表未命中）时原样返回——旧行为零变化。
 * @param {string} q
 * @returns {string}
 */
export function expandQuery(q) {
  const s = String(q || "").trim();
  if (!s) return s;
  const extra = [];
  for (const [cn, en] of Object.entries(EXPAND)) {
    if (s.includes(cn)) extra.push(en);
  }
  return extra.length ? `${s} ${extra.join(" ")}` : s;
}

/* ------------------------- ② 零匹配回退轻目录 ------------------------- */

/**
 * 轻目录：按名字典序排序取前 limit 个（name + 描述截 80 + server）。
 * limit<=0 → []（关闭回退，行为与旧版一致）。
 * @param {Array<{name:string,description?:string}>} allTools
 * @param {number} limit
 * @param {(name:string)=>string} [serverOf]
 * @returns {Array<{name:string,description:string,server:string}>}
 */
export function fallbackCatalog(allTools, limit, serverOf) {
  const lim = Math.max(0, Number(limit) || 0);
  if (!lim || !Array.isArray(allTools) || allTools.length === 0) return [];
  const svc = typeof serverOf === "function" ? serverOf : () => "";
  return [...allTools]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, lim)
    .map((t) => ({
      name: String(t.name || ""),
      description: String(t.description || "").slice(0, 80),
      server: svc(t.name),
    }));
}

/* ------------------------- ③ 检索结果缓存 ------------------------- */

/**
 * 结果缓存工厂：同 key 在 TTL 内返回同一结果（确定性），超 TTL 或超上限逐出。
 * @param {number} [maxSize]  LRU 上限（默认 200）
 * @param {number} [ttlMs]    有效期（默认 60s）
 */
export function createSearchCache(maxSize = 200, ttlMs = 60000) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return null;
      if (Date.now() - e.ts > ttlMs) {
        map.delete(key);
        return null;
      }
      return e.value;
    },
    set(key, value) {
      map.set(key, { ts: Date.now(), value });
      if (map.size > maxSize) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    size() {
      return map.size;
    },
  };
}

/* ------------------------- ④ 发现率统计 ------------------------- */

/**
 * 记录一次发现的工具名（name→count）。
 * @param {Map<string,number>} stats
 * @param {Array<string>} names
 * @returns {number} 当前去重工具数
 */
export function recordDiscoveries(stats, names) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  for (const n of list) stats.set(n, (stats.get(n) || 0) + 1);
  return stats.size;
}

/**
 * 序列化为按 count 降序的数组（cap 截断），供落盘。
 * @param {Map<string,number>} stats
 * @param {number} [cap]
 */
export function serializeDiscoveries(stats, cap = 200) {
  return [...stats.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, cap))
    .map(([name, count]) => ({ name, count }));
}

/**
 * 从落盘数组恢复 Map；坏条目跳过（fail-safe）。
 * @param {Array<{name:string,count:number}>} [list]
 */
export function deserializeDiscoveries(list) {
  const m = new Map();
  for (const e of list || []) {
    if (e && typeof e.name === "string" && e.name.length > 0 && Number.isFinite(e.count) && e.count > 0) {
      m.set(e.name, e.count);
    }
  }
  return m;
}

/* ------------------------- P1: 依赖闭包 ------------------------- */

/**
 * 同 server 兄弟闭包（graph-tool-call 的本地简化：server 前缀 = 依赖分组代理）。
 * 展开目标工具时顺带返回同 server 的其它工具轻目录（name+120 字描述），
 * 模型看到兄弟名字后可批量展开——减少「展开 A 发现还要 B」的往返税。
 * ponytail: server 前缀是粗粒度依赖近似；精确 producer 图需要宿主工具元数据，
 * 真需要时再按参数类型启发补。
 * @param {Array<{name:string,description?:string}>} allTools
 * @param {Array<string>} expandedNames 已展开的工具名
 * @param {number} limit 附带兄弟总数上限（0=关闭）
 * @param {(name:string)=>string} [serverOf] server 前缀提取
 * @returns {Array<{name:string,description:string}>}
 */
export function siblingClosure(allTools, expandedNames, limit, serverOf) {
  const lim = Math.max(0, Number(limit) || 0);
  if (!lim || !Array.isArray(allTools) || !Array.isArray(expandedNames) || expandedNames.length === 0) return [];
  const svc = typeof serverOf === "function" ? serverOf : (n) => String(n).split("__").slice(0, 2).join("__");
  const servers = new Set(expandedNames.map((n) => svc(String(n))).filter(Boolean));
  if (servers.size === 0) return [];
  const skip = new Set(expandedNames);
  const out = [];
  for (const t of [...allTools].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (out.length >= lim) break;
    const nm = String(t.name || "");
    if (!nm || skip.has(nm)) continue;
    if (servers.has(svc(nm))) {
      out.push({ name: nm, description: String(t.description || "").slice(0, 120) });
    }
  }
  return out;
}

/* ------------------------- P1: tools_schema 输出契约 ------------------------- */

const defaultServerOf = (name) => String(name).split("__").slice(0, 2).join("__");

/**
 * tools_schema 的纯输出构造（从 index.js execute 提取，契约可单测——single 判定
 * 写反曾逃过 87 条纯函数测试，根因是 execute 无测试；提取后契约分支全部可钉死）。
 * 单数调用（name 或 names 单元素，去重后 1 个）→ 旧版逐字段结构；
 * 批量（去重后 >1 个）→ { found, results: [...], siblings?, missing? }。
 * @param {Array<{name:string,description?:string,parameters?:object}>} allTools
 * @param {{name?:string,names?:Array<string>,closure?:boolean}} args
 * @param {{closureSize?:number,serverOf?:Function}} [opts]
 */
export function buildSchemaResponse(allTools, args, opts = {}) {
  const closureSize = Math.max(0, Number(opts.closureSize) || 0);
  const svc = typeof opts.serverOf === "function" ? opts.serverOf : defaultServerOf;
  const primary = String(args?.name || "");
  const batch = (Array.isArray(args?.names) ? args.names : []).map((n) => String(n)).filter(Boolean);
  const want = [...new Set([...batch, ...(primary ? [primary] : [])])];
  if (want.length === 0) return { found: false, reason: "no name" };
  const expanded = [];
  const missing = [];
  for (const n of want) {
    const t = (allTools || []).find((x) => x && x.name === n);
    if (!t) {
      missing.push(n);
      continue;
    }
    expanded.push({
      name: t.name,
      server: svc(t.name),
      description: t.description || "",
      // C4 defense: even a schema containing `const: -0` must come back as
      // lossless JSON.
      parameters: sanitizeLossless(t.parameters ?? {}),
      required: Array.isArray(t.parameters?.required) ? t.parameters.required : [],
    });
  }
  // ⚠️ 判定只看 want.length——旧实现用 !primary 导致只传 name 的调用误走批量结构。
  const single = want.length === 1;
  if (single) {
    if (expanded.length === 0) return { name: want[0], found: false, reason: "unknown tool" };
    const e = expanded[0];
    const out = {
      name: e.name,
      found: true,
      server: e.server,
      description: e.description,
      parameters: e.parameters,
      required: e.required,
    };
    if (closureSize > 0 && args?.closure !== false) {
      out.siblings = siblingClosure(allTools, [e.name], closureSize, svc);
    }
    return out;
  }
  const out = {
    found: expanded.length > 0,
    ...(expanded.length > 0
      ? {
          results: expanded,
          ...(closureSize > 0 && args?.closure !== false
            ? { siblings: siblingClosure(allTools, expanded.map((e) => e.name), closureSize, svc) }
            : {}),
        }
      : {}),
    ...(missing.length > 0 ? { missing } : {}),
  };
  return out;
}
