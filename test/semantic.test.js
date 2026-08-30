// semantic.js 单元测试（2026-08-30 建立）
// 运行: node --test test/semantic.test.js（workdir = dsh-tool-folder）
// 设计：纯函数部分全测；网络部分测「硬失败降级」（mock fetch 抛错），
// 不依赖 Ollama 在线（CI/离线环境也必须全绿）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cosine, rrfFuse, embedText, buildSemanticIndex, searchSemantic } from "../lib/semantic.js";

test("cosine: 相同向量 = 1，正交 = 0", () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(cosine([1, 2, 3], [1, 2, 3]) > 0.999);
  assert.equal(cosine([], []), 0, "空向量 = 0");
  assert.equal(cosine([1, 2], [1]), 0, "长度不等 = 0");
});

test("cosine: 相似度随夹角递减", () => {
  const a = [1, 0];
  const b = [0.9, 0.1];
  const c = [0.5, 0.5];
  assert.ok(cosine(a, b) > cosine(a, c), "小夹角分数更高");
});

test("rrfFuse: 两腿共同命中的排最前", () => {
  const bm25 = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const sem = [{ id: "c" }, { id: "a" }];
  const fused = rrfFuse(bm25, sem, 3);
  assert.equal(fused[0].id, "a", "双命中应排最前");
  assert.equal(fused[1].id, "c");
  assert.equal(fused[2].id, "b");
  assert.match(fused[0].from, /bm25/);
  assert.match(fused[0].from, /sem/);
});

test("rrfFuse: topK 截断 + 空腿容错", () => {
  assert.equal(rrfFuse([{ id: "a" }, { id: "b" }], [], 1).length, 1);
  assert.equal(rrfFuse([], [], 5).length, 0);
  // topK<=0 回退默认 5（与 searchSkills 容错语义一致），双命中去重后 1 条
  assert.equal(rrfFuse([{ id: "a" }], [{ id: "a" }], 0).length, 1);
});

test("embedText: Ollama 离线时返回 null（硬失败降级）", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("simulated offline");
  };
  try {
    const v = await embedText("测试文本", 500);
    assert.equal(v, null, "离线必须返回 null 而不是抛错");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("buildSemanticIndex: 全部 embed 失败 → available=false 且不落缓存", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("simulated offline");
  };
  try {
    const idx = await buildSemanticIndex(
      [{ id: "t1", text: "工具一" }, { id: "t2", text: "tool two" }],
      300,
    );
    assert.equal(idx.available, false);
    assert.equal(idx.vectors.size, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("searchSemantic: 空索引/空查询安全返回空数组", async () => {
  const v = await searchSemantic(new Map(), [{ id: "a", text: "x" }], "q");
  assert.deepEqual(v, []);
  const v2 = await searchSemantic(new Map([["a", [1]]]), [{ id: "a", text: "x" }], "  ");
  assert.deepEqual(v2, []);
});
