// semantic-cache 内容指纹增量差分 单元测试（v0.2.2 新加）
// 运行: node --test test/semantic-incremental.test.js（workdir = dsh-tool-folder）
// 设计：注入 embed 函数 + 注入 cacheFile（临时目录），不碰真实 ~/.dsh/state。
// 覆盖：全新建→全量嵌入；部分变化→只嵌入变化的；model 变化→全量重建。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSemanticIndex, configureSemantic } from "../lib/semantic.js";

// 计数型 embed stub：记录每次被嵌入的文本，返回定长假向量（规避真实 Ollama）。
function makeStub() {
  const state = { calls: [] };
  state.embed = async (text) => {
    state.calls.push(text);
    return [0.5, 0.5];
  };
  return state;
}

function tmpCacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sem-incr-"));
  return path.join(dir, "semantic-cache.json");
}

const docs = [
  { id: "t1", text: "tool one alpha" },
  { id: "t2", text: "tool two beta" },
  { id: "t3", text: "tool three gamma" },
];

test("全新建（空缓存）→ 全量嵌入所有 doc，且落缓存", async () => {
  const st = makeStub();
  const f = tmpCacheFile();
  const idx = await buildSemanticIndex(docs, 300, { embed: st.embed, cacheFile: f });
  assert.equal(idx.available, true);
  assert.equal(idx.vectors.size, 3);
  assert.equal(st.calls.length, 3, "3 个新 doc 全量嵌入");
  const cached = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.ok(cached.docs, "新格式缓存应含 per-doc docs 表");
  assert.equal(Object.keys(cached.docs).length, 3);
});

test("部分变化 → 只嵌入变化的 doc，未变化复用缓存向量", async () => {
  const st = makeStub();
  const f = tmpCacheFile();
  await buildSemanticIndex(docs, 300, { embed: st.embed, cacheFile: f });
  const firstCalls = st.calls.length; // 3

  // 改 t2 的文本 → 只有 t2 指纹变 → 只重嵌 t2
  const changed = [
    { id: "t1", text: "tool one alpha" },
    { id: "t2", text: "tool two BETA-CHANGED-xx" },
    { id: "t3", text: "tool three gamma" },
  ];
  const idx2 = await buildSemanticIndex(changed, 300, { embed: st.embed, cacheFile: f });
  assert.equal(idx2.available, true);
  assert.equal(st.calls.length, firstCalls + 1, "第二轮只嵌入变化的 1 个（t2）");
});

test("工具移除 → 缓存里残留 doc 被丢弃，不重新嵌入未变部分", async () => {
  const st = makeStub();
  const f = tmpCacheFile();
  await buildSemanticIndex(docs, 300, { embed: st.embed, cacheFile: f });
  const firstCalls = st.calls.length;
  // 只剩 t1/t3（t2 移除）
  const subset = [
    { id: "t1", text: "tool one alpha" },
    { id: "t3", text: "tool three gamma" },
  ];
  await buildSemanticIndex(subset, 300, { embed: st.embed, cacheFile: f });
  assert.equal(st.calls.length, firstCalls, "未变部分不再嵌入");
  const cached = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(Object.keys(cached.docs).length, 2, "缓存应只剩 2 个 doc");
  assert.ok(!Object.values(cached.docs).some((d) => d.id === "t2"), "被移除的 t2 不在缓存");
});

test("embed 全失败（Ollama 离线）→ 增量重建时 available=false 且不落缓存覆盖", async () => {
  const st = makeStub();
  const f = tmpCacheFile();
  await buildSemanticIndex(docs, 300, { embed: st.embed, cacheFile: f });
  // 先记录缓存原状
  const before = fs.readFileSync(f, "utf8");
  const failing = async () => null; // 模拟离线
  const idx = await buildSemanticIndex([{ id: "tNew", text: "brand new" }], 300, {
    embed: failing, cacheFile: f,
  });
  assert.equal(idx.available, false);
  assert.equal(idx.vectors.size, 0);
  assert.equal(fs.readFileSync(f, "utf8"), before, "失败时不得覆盖/损坏已有缓存");
});

test("model/base 变化 → 全量失效重建（liveness 检测）", async () => {
  const st = makeStub();
  const f = tmpCacheFile();
  await buildSemanticIndex(docs, 300, { embed: st.embed, cacheFile: f });
  assert.equal(st.calls.length, 3);

  // 切到另一个 embed model → 缓存记录与现模型不一致 → 全量重建
  configureSemantic({ embedModel: "bge-m3-other" });
  try {
    const st2 = makeStub();
    await buildSemanticIndex(docs, 300, { embed: st2.embed, cacheFile: f });
    assert.equal(st2.calls.length, 3, "model 变化应全量嵌入 3 个");
  } finally {
    // 恢复默认，避免影响同文件后续测试
    configureSemantic({ embedModel: "bge-m3" });
  }
});
