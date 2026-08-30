/**
 * budget.js — 分级披露预算（v0.2.2，借鉴 Letter2025/dsh-tool-search）。
 *
 * 现状背景：折叠后工具面大小 = core + hot + 动态 topK(6)，固定裁剪，无预算感知。
 * 本模块引入 `disclosureBudget`：开启后（>0），当可见工具 schema 的估算字节
 * 超过预算时，按「溢出降级」：

 *   层级1（默认）  完整 schema（当前行为）
 *   层级2          name + description（描述压缩至 100 字符）
 *   层级3          name（一行一个）
 *   层级4          整组折叠进 catalog（不注入，靠 tools_search 发现）

 * 关键约定（P0 红线）：
 *   - 降级只作用于「动态段」（dynTools）；core/hot 永不降级（由调用方把
 *     core+hot 名字传作 protectedNames）。
 *   - 全部可降级工具按同一全局层级降级（"降级层级"语义）。即使层级 4 仍超预算，
 *     也绝不降级 protected——预算是对动态段的软约束，core/hot 恒为层级 1。
 *   - budget <= 0（含 undefined）视为「关闭」，全部返回层级 1（行为不变）。
 *
 * 字节估算（本模块的实现选择，写进注释作为契约）：
 *   - 层级1：JSON.stringify(tool).length（完整 schema 序列化字节数）
 *   - 层级2：name.length + min(desc,100).length + 2（引号/空格开销）
 *   - 层级3：name.length + 1（一行一个 name）
 *   - 层级4：0（折叠进 catalog，本体不注入）
 * 说明：JSON 序列化（而非 str_len 估算）更贴近实际 token 成本，选它作为层级1
 * 的主衡准；层级2/3 是压缩形态，直接用字段长度。
 */

/** 层级 2 描述截断上限 */
const DESC_CAP = 100;

/**
 * 估算一批工具在给定层级的注入字节数。
 * @param {Array<object>} tools  tool defs（含 name/description）
 * @param {number} tier 1|2|3|4
 * @returns {number}
 */
export function estimateBytes(tools, tier) {
  let total = 0;
  for (const t of tools) {
    if (tier === 1) {
      try {
        total += JSON.stringify(t).length;
      } catch {
        total += String(t.name || "").length + 4;
      }
    } else if (tier === 2) {
      total += String(t.name || "").length + Math.min(String(t.description || "").length, DESC_CAP) + 2;
    } else if (tier === 3) {
      total += String(t.name || "").length + 1;
    }
    // tier 4 → 0 字节（不注入）
  }
  return total;
}

/**
 * 计算可见工具面的降级层级与每工具层级。
 * @param {Array<object>} visible        折叠后的可见工具（可能已达 core+hot+动态）
 * @param {number} [budget]              disclosureBudget（<=0 = 关闭）
 * @param {Set<string>|Array<string>} [protectedNames] core+hot 名字，永不降级
 * @returns {{tier: number, byName: Record<string, number>}}
 */
export function tierForBudget(visible, budget, protectedNames = []) {
  const list = Array.isArray(visible) ? visible : [];
  const prot = new Set(Array.isArray(protectedNames) ? protectedNames : Array.from(protectedNames || []));
  const degrade = list.filter((t) => !prot.has(t.name));

  const byName = {};
  for (const t of list) byName[t.name] = 1;

  // budget <= 0 = 关闭 → 不降级
  if (!(budget > 0)) return { tier: 1, byName };

  const protectedTools = list.filter((t) => prot.has(t.name));

  // 无可降级的动态段（全 core/hot）→ 无从降级，恒层级 1
  if (degrade.length === 0) return { tier: 1, byName };

  // 全量仍在预算内 → 层级 1
  if (estimateBytes(list, 1) <= budget) return { tier: 1, byName };

  // 从层级 2 起逐级找第一个放得下的层级（层级 4 恒允许——折叠本体不注入）
  for (let tier = 2; tier <= 3; tier++) {
    const cost = estimateBytes(protectedTools, 1) + estimateBytes(degrade, tier);
    if (cost <= budget) {
      for (const t of degrade) byName[t.name] = tier;
      return { tier, byName };
    }
  }
  // 层级 4：动态段整体折叠
  for (const t of degrade) byName[t.name] = 4;
  return { tier: 4, byName };
}
