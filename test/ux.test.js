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
