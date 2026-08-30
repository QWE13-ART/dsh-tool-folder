// storage.js 配置三级持久化（JSON 落盘原语） 单元测试（v0.2.2 新加）
// 运行: node --test test/storage.test.js（workdir = dsh-tool-folder）
// 覆盖：写读回环 / 目录不可写降级 / 损坏 JSON 返回默认值。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeState, readState } from "../lib/storage.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-storage-"));
  return path.join(dir, "state.json");
}

test("writeState + readState 回环：数据完整往返", () => {
  const f = tmpFile();
  const data = { warm: ["a", "b"], stats: { injections: 3, ts: 1780000000000 } };
  assert.equal(writeState(f, data), true, "写入成功返回 true");
  const back = readState(f, {});
  assert.deepEqual(back, data, "读回与写入一致");
});

test("readState: 文件不存在 → 返回默认值（降级，不抛错）", () => {
  const f = path.join(os.tmpdir(), "definitely-missing-" + Math.random() + ".json");
  const def = { warm: [] };
  assert.deepEqual(readState(f, def), def);
});

test("readState: 损坏 JSON → 返回默认值（不抛错）", () => {
  const f = tmpFile();
  fs.writeFileSync(f, "{ not valid json !!", "utf8");
  const def = { warm: [] };
  assert.deepEqual(readState(f, def), def, "损坏内容降级到默认值");
});

test("readState: 空文件 / 无读权限 → 返回默认值", () => {
  const f = tmpFile();
  fs.writeFileSync(f, "", "utf8");
  assert.deepEqual(readState(f, { x: 1 }), { x: 1 }, "空串解析失败 → 默认值");
});

test("writeState: 目录不可写 → 返回 false 而不抛错（降级）", () => {
  const badDir = os.tmpdir() + "/__dsh__unwritable__" + Math.random();
  // 用文件路径占据目录位，让 mkdir 失败（跨平台简单且确定性）
  const blocker = path.join(os.tmpdir(), "__dsh_blocker" + Math.random());
  fs.writeFileSync(blocker, "x", "utf8");
  const f = path.join(blocker, "sub", "state.json");
  const ok = writeState(f, { a: 1 });
  assert.equal(ok, false, "不可写路径应返回 false（降级到下一级）");
});

test("writeState: 自动创建父目录", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-storage-nested-"));
  const f = path.join(dir, "a", "b", "state.json"); // 深层多级
  assert.equal(writeState(f, { n: 1 }), true);
  assert.ok(fs.existsSync(f), "父目录应被自动创建");
});

test("readState: 返回的是新对象，不与默认值共享引用", () => {
  const f = tmpFile();
  assert.equal(writeState(f, { list: [1, 2] }), true);
  const def = { list: [] };
  const got = readState(f, def);
  got.list.push(99);
  assert.equal(def.list.length, 0, "读回对象应是独立副本");
});
