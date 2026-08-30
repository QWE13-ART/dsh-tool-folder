// heat + 检索优先级 单元测试（2026-08-30 建立，v0.2.1 提准提稳）
// 运行: node --test test/heat.test.js（workdir = dsh-tool-folder）
// 覆盖：isHotTool 窗口衰减 / 旧格式兼容 / windowMs=0 永不过期 / prioritizeExact 精确名优先
import { test } from "node:test";
import assert from "node:assert/strict";
import { isHotTool, prioritizeExact, missingMetaTools } from "../lib/metrics.js";

const DAY = 86400000;

/* ---------------- isHotTool：hot 晋升的滑动窗口衰减 ---------------- */

test("isHotTool: 窗口内达标 → hot", () => {
  const calls = { "mcp__viking": { n: 3, ts: Date.now() } };
  assert.equal(isHotTool(calls, "mcp__viking", 3, 3 * DAY), true);
});

test("isHotTool: 超窗不 hot（热度衰减）", () => {
  const calls = { "mcp__viking": { n: 99, ts: Date.now() - 4 * DAY } };
  assert.equal(isHotTool(calls, "mcp__viking", 3, 3 * DAY), false, "累计 99 次但 4 天没用 → 不 hot");
});

test("isHotTool: 旧格式 number（无 ts）→ 不 hot（未再调用的历史热度作废）", () => {
  const calls = { "mcp__viking": 5 };
  assert.equal(isHotTool(calls, "mcp__viking", 3, 3 * DAY), false);
});

test("isHotTool: windowMs=0 永不过期（兼容旧行为）", () => {
  const calls = { "mcp__viking": { n: 3, ts: Date.now() - 30 * DAY } };
  assert.equal(isHotTool(calls, "mcp__viking", 3, 0), true);
  assert.equal(isHotTool({ "mcp__viking": 3 }, "mcp__viking", 3, 0), true, "旧 number 在 windowMs=0 时仍 hot");
});

test("isHotTool: 未达阈值不 hot", () => {
  assert.equal(isHotTool({ "mcp__viking": { n: 2, ts: Date.now() } }, "mcp__viking", 3, 3 * DAY), false);
});

test("isHotTool: 无记录 / 空对象不 hot", () => {
  assert.equal(isHotTool({}, "mcp__viking", 3, 3 * DAY), false);
  assert.equal(isHotTool(null, "mcp__viking", 3, 3 * DAY), false);
});

/* ---------------- prioritizeExact：精确名 > 名子串 > 检索命中 ---------------- */

test("prioritizeExact: 精确名永远第一", () => {
  const docs = [{ name: "mcp__viking__remember" }, { name: "mcp__serena__find" }];
  const hits = [{ id: "mcp__viking__remember", score: 1 }];
  const out = prioritizeExact(docs, "mcp__serena__find", hits);
  assert.equal(out[0].id, "mcp__serena__find", "精确名命中排第一");
  assert.equal(out.length, 2, "检索命中不丢");
});

test("prioritizeExact: 名子串（q≥4）前置", () => {
  const docs = [{ name: "mcp__viking__remember" }, { name: "mcp__serena__find" }];
  const out = prioritizeExact(docs, "serena", [{ id: "mcp__viking__remember", score: 1 }]);
  assert.equal(out[0].id, "mcp__serena__find");
});

test("prioritizeExact: 短 q（<4）不做子串优先（只精确名）", () => {
  const docs = [{ name: "mcp__viking__remember" }, { name: "mcp__serena__find" }];
  const hits = [{ id: "mcp__viking__remember", score: 1 }];
  const out = prioritizeExact(docs, "mem", hits);
  assert.deepEqual(out.map((x) => x.id), ["mcp__viking__remember"], "短 q 不干扰原排序");
});

test("prioritizeExact: 去重（精确名已在 hits 中不重复）", () => {
  const docs = [{ name: "mcp__serena__find" }, { name: "mcp__viking__remember" }];
  const hits = [
    { id: "mcp__serena__find", score: 1 },
    { id: "mcp__viking__remember", score: 2 },
  ];
  const out = prioritizeExact(docs, "mcp__serena__find", hits);
  assert.deepEqual(out.map((x) => x.id), ["mcp__serena__find", "mcp__viking__remember"]);
});

test("prioritizeExact: 空查询 / 空 hits 原样返回", () => {
  const docs = [{ name: "mcp__viking__remember" }];
  const hits = [{ id: "mcp__viking__remember", score: 1 }];
  assert.deepEqual(prioritizeExact(docs, "", hits), hits);
  assert.deepEqual(prioritizeExact(docs, "x", []), []);
});

/* ---------------- missingMetaTools：fail-open 门 ---------------- */

test("missingMetaTools: 全部在位 → 空（不触发 fail-open）", () => {
  assert.deepEqual(missingMetaTools(new Set(["tools_search", "tools_schema"]), { tools_search: true, tools_schema: true }), []);
});

test("missingMetaTools: 启用的元工具缺失 → 列出（触发 fail-open）", () => {
  const missing = missingMetaTools(new Set(["tools_search"]), { tools_search: true, tools_schema: true });
  assert.deepEqual(missing, ["tools_schema"]);
});

test("missingMetaTools: 禁用的不算缺失", () => {
  assert.deepEqual(missingMetaTools(new Set([]), { tools_search: false, tools_schema: false }), []);
  assert.deepEqual(missingMetaTools(new Set(["tools_search"]), { tools_search: true, tools_schema: false }), []);
});

test("missingMetaTools: 数组输入兼容", () => {
  assert.deepEqual(missingMetaTools(["tools_search"], { tools_search: true, tools_schema: true }), ["tools_schema"]);
});
