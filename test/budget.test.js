// disclosureBudget 分级披露预算 单元测试（v0.2.2 新加）
// 运行: node --test test/budget.test.js（workdir = dsh-tool-folder）
// 覆盖：预算充足→层级1；中等→动态段压缩；极小→动态段只剩名字；
//       core/hot 永不降级（P0 红线）；budget=0 关闭时行为不变。
import { test } from "node:test";
import assert from "node:assert/strict";
import { tierForBudget, estimateBytes } from "../lib/budget.js";

// helper: 造一个工具对象（schema 体积可控）
function mkTool(name, descLen = 50, params = {}) {
  return {
    name,
    description: "d".repeat(descLen),
    parameters: Object.keys(params).length
      ? { type: "object", properties: params }
      : { type: "object", properties: { arg: { type: "string" } } },
  };
}

function names(tiers, t) {
  return Object.keys(tiers).filter((n) => tiers[n] === t).sort();
}

test("estimateBytes: 完整 schema 用 JSON.stringify 字节估算", () => {
  const t = mkTool("tool_a", 10);
  // JSON round-trip 长度即估算
  assert.equal(estimateBytes([t], 1), JSON.stringify(t).length);
});

test("tierForBudget: 预算充足（>= 全量）→ 层级1，全部完整 schema", () => {
  const visible = [mkTool("core_a"), mkTool("hot_b"), mkTool("dyn_c")];
  const fullBytes = JSON.stringify(visible).length;
  const r = tierForBudget(visible, fullBytes, new Set(["core_a", "hot_b"]));
  assert.equal(r.tier, 1);
  assert.deepEqual(names(r.byName, 1), ["core_a", "dyn_c", "hot_b"]);
});

test("tierForBudget: budget<=0（关闭）→ 层级1，行为不变（不降级）", () => {
  const visible = [mkTool("dyn_c", 200)];
  for (const b of [0, -1, undefined]) {
    const r = tierForBudget(visible, b, new Set());
    assert.equal(r.tier, 1, "关闭/空预算不得降级");
    assert.equal(r.byName["dyn_c"], 1);
  }
});

test("tierForBudget: 预算中等 → 动态段压缩到层级2（name+desc≤100）", () => {
  const core = mkTool("core_a", 10);
  const dyn = mkTool("dyn_c", 500);
  const visible = [core, dyn];
  // 全量超预算，但层级2（desc 截 100）放得下
  const budget = JSON.stringify([core]).length + "x:".length + 100 + 100;
  const r = tierForBudget(visible, budget, new Set(["core_a"]));
  assert.equal(r.tier, 2, "动态段应降级到层级2");
  assert.equal(r.byName["core_a"], 1, "core 永不降级");
  assert.equal(r.byName["dyn_c"], 2, "动态段层级2");
});

test("tierForBudget: 预算极小 → 动态段只剩名字（层级3）", () => {
  const core = mkTool("core_a", 10);
  const dyn = mkTool("dyn_c", 500);
  const visible = [core, dyn];
  // 层级2 超预算（desc 100 太长），层级3（name only）放得下
  const budget = JSON.stringify([core]).length + "dyn_c".length + 1 + 1;
  const r = tierForBudget(visible, budget, new Set(["core_a"]));
  assert.equal(r.tier, 3);
  assert.equal(r.byName["core_a"], 1);
  assert.equal(r.byName["dyn_c"], 3, "动态段只剩名字");
});

test("tierForBudget: 预算连名字都放不下 → 动态段折叠进 catalog（层级4）", () => {
  const core = mkTool("core_a", 10);
  const dyn = mkTool("dyn_c", 500);
  const visible = [core, dyn];
  // 预算只够 core——动态段必须整体折叠
  const budget = JSON.stringify([core]).length;
  const r = tierForBudget(visible, budget, new Set(["core_a"]));
  assert.equal(r.tier, 4);
  assert.equal(r.byName["core_a"], 1, "core 永不降级");
  assert.equal(r.byName["dyn_c"], 4, "动态段折叠");
});

test("tierForBudget: core/hot 永不降级（P0 红线）即使预算为 0", () => {
  const visible = [mkTool("core_a"), mkTool("hot_b")];
  const r = tierForBudget(visible, 1, new Set(["core_a", "hot_b"]));
  assert.equal(r.byName["core_a"], 1);
  assert.equal(r.byName["hot_b"], 1);
  assert.equal(r.tier, 1);
});

test("tierForBudget: 无动态段时只受 core 体积影响，永不超降级", () => {
  const core = mkTool("core_a", 100);
  const r = tierForBudget([core], 10, new Set(["core_a"]));
  // 预算远小于 core 体积也不降级 core，返回层级1
  assert.equal(r.byName["core_a"], 1);
  assert.equal(r.tier, 1);
});
