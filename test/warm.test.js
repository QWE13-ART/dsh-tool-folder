// warm LRU 预热集合 单元测试（v0.2.2 新加）
// 运行: node --test test/warm.test.js（workdir = dsh-tool-folder）
// 覆盖：touch 新增/刷新顺序/逐出最久未用/上限 0 关闭。
import { test } from "node:test";
import assert from "node:assert/strict";
import { touchWarm, evictWarm } from "../lib/metrics.js";

// 造一个 LRU 顺序可观测的 warm Map：name -> { last: 递增序号 }
function warmMap(entries) {
  const m = new Map();
  for (const [name, last] of entries) m.set(name, { last });
  return m;
}

test("touchWarm: 新增即入集合，last 单调递增", () => {
  const m = new Map();
  touchWarm(m, ["tool_a"], 10, 5);
  touchWarm(m, ["tool_b"], 10, 5);
  assert.equal(m.size, 2);
  assert.ok(m.get("tool_a").last < m.get("tool_b").last, "后 touch 的 last 更大");
});

test("touchWarm: 已存在则刷新顺序（重新变最新，不重复）", () => {
  const m = warmMap([["a", 1], ["b", 2], ["c", 3]]);
  touchWarm(m, ["a"], 10, 5); // 刷新 a → last 最大
  assert.equal(m.size, 3, "刷新不新增条目");
  assert.ok(m.get("a").last > m.get("c").last, "a 刷新后最新");
});

test("touchWarm: 一次可批量加多个名字", () => {
  const m = new Map();
  touchWarm(m, ["x", "y", "z"], 10, 5);
  assert.equal(m.size, 3);
  for (const n of ["x", "y", "z"]) assert.ok(m.has(n));
});

test("evictWarm: 超出 max 逐出最久未用", () => {
  // 顺序：a(1) 最久，b(2), c(3) 最新
  const m = warmMap([["a", 1], ["b", 2], ["c", 3]]);
  evictWarm(m, 2);
  assert.equal(m.size, 2);
  assert.equal(m.has("a"), false, "最久未用 a 被逐出");
  const rest = [...m.keys()].sort();
  assert.deepEqual(rest, ["b", "c"]);
});

test("evictWarm: 连续多次触摸后逐出顺序正确", () => {
  const m = new Map();
  // 依次 touch，a,b,c 各自刷新，c 最新
  touchWarm(m, ["a"], 10, 10);
  touchWarm(m, ["b"], 10, 10);
  touchWarm(m, ["c"], 10, 10);
  touchWarm(m, ["a"], 10, 10); // a 再次刷新 → a 最新
  const first = evictWarm(m, 2); // 逐 1 个，应逐出 b（a 刷新过最新，c 次新）
  assert.equal(m.size, 2);
  assert.equal(m.has("b"), false);
  assert.ok(first === null || Array.isArray(first), "返回值兼容（可为空数组/名称）");
});

test("evictWarm: max<=0 关闭（不逐出任意）", () => {
  const m = warmMap([["a", 1], ["b", 2], ["c", 3]]);
  evictWarm(m, 0);
  assert.equal(m.size, 3, "max=0 关闭 LRU");
});

test("evictWarm: max>=size 时不做任何逐出", () => {
  const m = warmMap([["a", 1], ["b", 2]]);
  evictWarm(m, 5);
  assert.equal(m.size, 2);
});

test("evictWarm: touch 超限时逐出（touch+evict 组合） ", () => {
  const m = warmMap([["a", 1], ["b", 2], ["c", 3]]);
  touchWarm(m, ["d"], 10, 3); // add d, then evict to max 3 → 逐出最久 a
  assert.equal(m.size, 3);
  assert.equal(m.has("a"), false);
  assert.equal(m.has("d"), true);
});
