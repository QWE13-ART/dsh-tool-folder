/**
 * tokenize.test.js — regression guard for the hyphen/underscore sub-word fix.
 *
 * Tool names are the reason this matters here: every MCP tool is named
 * `mcp__<server>__<tool>`, so before the fix each name was ONE index term and
 * querying "playwright" or "codegraph" scored zero against it. Measured on a
 * real 12-tool sample: sub-word recall went 0/10 -> 10/10 while exact-name
 * top-1 stayed 12/12. These tests fail if the split is removed or narrowed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, buildIndex, search } from "../lib/bm25.js";

test("MCP tool name splits into server and tool words", () => {
  const t = tokenize("mcp__codegraph__codegraph_explore");
  assert.ok(t.includes("mcp__codegraph__codegraph_explore"), "whole token kept");
  assert.ok(t.includes("codegraph"), "server word — used to be unreachable");
  assert.ok(t.includes("explore"), "tool word");
});

test("hyphenated server names split as well", () => {
  const t = tokenize("mcp__sequential-thinking__sequentialthinking");
  for (const w of ["mcp", "sequential", "thinking", "sequentialthinking"]) {
    assert.ok(t.includes(w), `sub-word ${w} missing`);
  }
});

test("plain snake_case tool names split", () => {
  assert.deepEqual(tokenize("web_search"), ["web_search", "web", "search"]);
  assert.deepEqual(tokenize("lesson_save"), ["lesson_save", "lesson", "save"]);
});

test("single-character fragments are not emitted", () => {
  assert.deepEqual(tokenize("a-b"), ["a-b"]);
  assert.deepEqual(tokenize("utf-8"), ["utf-8", "utf"]);
});

test("non-compound names are unchanged", () => {
  assert.deepEqual(tokenize("sequentialthinking"), ["sequentialthinking"]);
});

test("end-to-end: server-name query retrieves the tool", () => {
  const docs = [
    { id: "mcp__playwright__browser_snapshot", text: "mcp__playwright__browser_snapshot accessibility snapshot of a page" },
    { id: "mcp__codegraph__codegraph_explore", text: "mcp__codegraph__codegraph_explore verbatim source of relevant symbols" },
    { id: "web_search", text: "web_search Search the web for current information" },
  ];
  const idx = buildIndex(docs);
  for (const [q, want] of [
    ["playwright", "mcp__playwright__browser_snapshot"],
    ["codegraph", "mcp__codegraph__codegraph_explore"],
    ["search", "web_search"],
  ]) {
    const hits = search(idx, q, 3).map((i) => docs[i].id);
    assert.ok(hits.includes(want), `query "${q}" should find ${want}, got [${hits}]`);
  }
});

test("exact tool name still ranks itself first", () => {
  const docs = [
    { id: "mcp__github__search_repositories", text: "mcp__github__search_repositories Find GitHub repositories by name" },
    { id: "mcp__github__search_code", text: "mcp__github__search_code Fast and precise code search across GitHub" },
  ];
  const idx = buildIndex(docs);
  const top = search(idx, "mcp__github__search_repositories", 1).map((i) => docs[i].id)[0];
  assert.equal(top, "mcp__github__search_repositories");
});

test("CJK descriptions keep working (tool descriptions are bilingual here)", () => {
  const t = tokenize("mcp__security-audit__scan_config 扫描配置文件安全错配");
  assert.ok(t.includes("security"), "sub-word");
  assert.ok(t.includes("扫描"), "CJK bigram");
});
