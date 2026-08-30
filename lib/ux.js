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
 */

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
