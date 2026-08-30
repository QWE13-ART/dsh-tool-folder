/**
 * ux.test.js — P0 折叠体验改进单测（expandQuery / fallbackCatalog /
 * createSearchCache / recordDiscoveries 序列化往返）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandQuery,
  fallbackCatalog,
  createSearchCache,
  recordDiscoveries,
  serializeDiscoveries,
  deserializeDiscoveries,
  siblingClosure,
  buildSchemaResponse,
} from "../lib/ux.js";

/* ---------- ① expandQuery ---------- */

test("expandQuery: 中文意图追加英文同义词", () => {
  const out = expandQuery("搜索数据库的工具");
  assert.ok(out.includes("搜索数据库的工具"));
  assert.ok(out.includes("search find lookup"));
  assert.ok(out.includes("database db sql query"));
});

test("expandQuery: 无中文/词表未命中时原样返回", () => {
  assert.equal(expandQuery("openhands session"), "openhands session");
  assert.equal(expandQuery(""), "");
});

test("expandQuery: 多词命中全部追加、不重复计算", () => {
  const out = expandQuery("测试并修复");
  assert.ok(out.includes("test run verify"));
  assert.ok(out.includes("fix repair patch debug"));
});

/* ---------- ② fallbackCatalog ---------- */

const FAKE = [
  { name: "zeta_tool", description: "z desc ".repeat(30) },
  { name: "alpha_tool", description: "a desc" },
  { name: "mid_tool", description: "m desc" },
];

test("fallbackCatalog: 名字典序稳定 + limit 截断 + 描述截 80", () => {
  const out = fallbackCatalog(FAKE, 2, (n) => `srv_${n}`);
  assert.deepEqual(
    out.map((r) => r.name),
    ["alpha_tool", "mid_tool"],
  );
  assert.equal(out[0].server, "srv_alpha_tool");
  assert.ok(out[0].description.length <= 80);
});

test("fallbackCatalog: limit<=0 或空输入 → []", () => {
  assert.deepEqual(fallbackCatalog(FAKE, 0), []);
  assert.deepEqual(fallbackCatalog([], 5), []);
  assert.deepEqual(fallbackCatalog(null, 5), []);
});

test("fallbackCatalog: serverOf 缺省安全", () => {
  const out = fallbackCatalog([{ name: "x" }], 1);
  assert.equal(out[0].server, "");
});

/* ---------- ③ createSearchCache ---------- */

test("searchCache: TTL 内同 key 命中，超 TTL 失效", () => {
  const c = createSearchCache(10, 100);
  c.set("k", { v: 1 });
  assert.deepEqual(c.get("k"), { v: 1 });
  return new Promise((res) =>
    setTimeout(() => {
      assert.equal(c.get("k"), null);
      res();
    }, 150),
  );
});

test("searchCache: LRU 超上限逐出最旧", () => {
  const c = createSearchCache(2, 60000);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3); // 逐出 a
  assert.equal(c.get("a"), null);
  assert.equal(c.get("b"), 2);
  assert.equal(c.size(), 2);
});

/* ---------- ④ recordDiscoveries 序列化往返 ---------- */

test("discoveries: 计数 + 降序序列化 + cap", () => {
  const m = new Map();
  recordDiscoveries(m, ["a", "b", "a", "a", "c", "b"]);
  const s = serializeDiscoveries(m, 2);
  assert.deepEqual(s, [
    { name: "a", count: 3 },
    { name: "b", count: 2 },
  ]);
});

test("discoveries: 落盘→恢复 往返 + 坏条目跳过", () => {
  const m = new Map();
  recordDiscoveries(m, ["x", "x", "y"]);
  const list = serializeDiscoveries(m);
  list.push({ name: "bad", count: -1 }, { name: "", count: 5 }, null);
  const back = deserializeDiscoveries(list);
  assert.equal(back.get("x"), 2);
  assert.equal(back.get("y"), 1);
  assert.equal(back.size, 2); // 坏条目被跳过
});

test("discoveries: deserialize 空/垃圾输入 fail-safe", () => {
  assert.equal(deserializeDiscoveries(null).size, 0);
  assert.equal(deserializeDiscoveries([{ name: "n", count: "x" }]).size, 0);
});

/* ---------- P1: siblingClosure ---------- */

const TOOLS = [
  { name: "mcp__viking__remember", description: "store a memory" },
  { name: "mcp__viking__search", description: "find memories" },
  { name: "mcp__viking__delete", description: "remove a memory" },
  { name: "mcp__github__create_issue", description: "make an issue" },
  { name: "mcp__github__list_issues", description: "list issues" },
  { name: "plain_tool", description: "no server prefix" },
];

test("siblingClosure: 同 server 兄弟按字典序取前 limit，排除已展开", () => {
  const out = siblingClosure(TOOLS, ["mcp__viking__remember"], 2);
  assert.deepEqual(
    out.map((s) => s.name),
    ["mcp__viking__delete", "mcp__viking__search"],
  );
  assert.ok(out[0].description.length <= 120);
});

test("siblingClosure: limit=0 / 空输入 → []", () => {
  assert.deepEqual(siblingClosure(TOOLS, ["mcp__viking__remember"], 0), []);
  assert.deepEqual(siblingClosure([], ["x"], 2), []);
  assert.deepEqual(siblingClosure(TOOLS, [], 2), []);
});

test("siblingClosure: 多 server 展开时各自取兄弟、无前缀工具不进闭包", () => {
  const out = siblingClosure(TOOLS, ["mcp__viking__remember", "mcp__github__create_issue"], 10);
  const names = out.map((s) => s.name);
  assert.ok(names.includes("mcp__viking__search"));
  assert.ok(names.includes("mcp__github__list_issues"));
  assert.ok(!names.includes("plain_tool"));
});

test("siblingClosure: 自定义 serverOf 生效", () => {
  const out = siblingClosure([{ name: "a.b.c", description: "x" }, { name: "a.b.d", description: "y" }, { name: "z.z", description: "w" }], ["a.b.c"], 5, (n) => n.split(".").slice(0, 2).join("."));
  assert.deepEqual(
    out.map((s) => s.name),
    ["a.b.d"],
  );
});

/* ---------- P1: buildSchemaResponse（tools_schema 输出契约） ---------- */

const RESP_TOOLS = [
  { name: "mcp__viking__remember", description: "store", parameters: { type: "object", properties: { text: { type: "string" } } }, },
  { name: "mcp__viking__search", description: "find", parameters: {} },
  { name: "mcp__github__create_issue", description: "make", parameters: { required: ["title"] } },
];

test("schemaResp: 只传 name（旧调用形态）→ 旧版逐字段结构", () => {
  const r = buildSchemaResponse(RESP_TOOLS, { name: "mcp__viking__remember" }, { closureSize: 0 });
  assert.equal(r.name, "mcp__viking__remember");
  assert.equal(r.found, true);
  assert.equal(r.server, "mcp__viking");
  assert.equal(r.description, "store");
  assert.ok(r.parameters.properties.text);
  assert.deepEqual(r.required, []);
  assert.equal(r.results, undefined); // 不得是批量结构
  assert.equal(r.siblings, undefined); // closureSize=0 无 siblings 键
});

test("schemaResp: names 单元素 → 与旧结构等价", () => {
  const r = buildSchemaResponse(RESP_TOOLS, { names: ["mcp__viking__remember"] }, { closureSize: 0 });
  assert.equal(r.name, "mcp__viking__remember");
  assert.equal(r.found, true);
});

test("schemaResp: names 批量 → results 数组 + siblings 闭包", () => {
  const r = buildSchemaResponse(RESP_TOOLS, { names: ["mcp__viking__remember", "mcp__github__create_issue"] }, { closureSize: 2 });
  assert.equal(r.found, true);
  assert.equal(r.results.length, 2);
  assert.deepEqual(r.results[1].required, ["title"]);
  const sib = r.siblings.map((s) => s.name);
  assert.ok(sib.includes("mcp__viking__search")); // viking 的兄弟
  assert.ok(!sib.includes("mcp__viking__remember")); // 已展开排除
});

test("schemaResp: name+names 同时传 → 去重后批量", () => {
  const r = buildSchemaResponse(RESP_TOOLS, { name: "mcp__viking__remember", names: ["mcp__viking__remember", "mcp__viking__search"] }, { closureSize: 0 });
  assert.deepEqual(
    r.results.map((x) => x.name),
    ["mcp__viking__remember", "mcp__viking__search"],
  ); // 去重后 2 个 → 批量
});

test("schemaResp: closure:false 显式关闭 siblings", () => {
  const r = buildSchemaResponse(RESP_TOOLS, { name: "mcp__viking__remember", closure: false }, { closureSize: 4 });
  assert.equal(r.siblings, undefined);
});

test("schemaResp: 未知名 → 旧版 unknown 结构（单数）/ missing（批量）", () => {
  const single = buildSchemaResponse(RESP_TOOLS, { name: "nope" }, { closureSize: 0 });
  assert.deepEqual(single, { name: "nope", found: false, reason: "unknown tool" });
  const batch = buildSchemaResponse(RESP_TOOLS, { names: ["nope", "also_nope"] }, { closureSize: 0 });
  assert.equal(batch.found, false);
  assert.deepEqual(batch.missing, ["nope", "also_nope"]);
});

test("schemaResp: 空参数 fail-safe", () => {
  assert.deepEqual(buildSchemaResponse(RESP_TOOLS, {}), { found: false, reason: "no name" });
  assert.deepEqual(buildSchemaResponse(null, { name: "x" }), { name: "x", found: false, reason: "unknown tool" });
});
