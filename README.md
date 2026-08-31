# dsh-tool-folder

Fold the DSH tool surface down to what each request actually needs.
Per-agent core + BM25 dynamic loading + heat feedback + CN-intent aliases.
Shrinks per-turn schema tokens ~80-90% while keeping (or improving) tool
selection accuracy — the RAG-MCP / BoR / SEP-1576 methodology, implemented as
a plain cordis plugin for the DeepSeek Harness host.

## Mechanism (verified against DSH 0.1.1-rc.1 sources)

```
SystemPrompt.assemble() → assembly = { sections, contexts, tools, variables }
ctx.waterfall(scope, "system-prompt/assemble", assembly, ctx, () => assembly)
    ← this plugin listens here and returns {...assembly, tools: filtered}
buildRequest(turn, step, assembly.tools, ...)   ← tools field of the API request
```

`assembly.tools` is the ONLY source of the API request's tools. Returning a
replaced object is authoritative (model-selection plugin does the same).
Execution is NOT gated on the current turn's tools — folded tools still
resolve through the full registry — so folding never removes capability.

Feedback and the firewall bind to the *execution* events, not the prompt
assembly:
- `tools/pre-execute` — listener receives `(exec, next)`. Return
  `{ kind: "deny", reason }` to refuse the call, or call `next()` to allow.
  `exec = { callId, name, arguments, agent, signal }` (there is no `.deny()`
  method on exec — the contract is the returned decision object).
- `tools/post-execute` — listener receives `(exec, result, next)` and fires
  once per executed tool; `exec.name` / `exec.arguments` feed heat counting,
  exfil-chain detection, coverage recording and session persistence.
  (`agent/pre-step` carries `{ messages, position, signal }` only — no
  toolCalls — so it cannot drive feedback; verified against dsh-agent-loop.)

## Six layers — all implemented

| Layer | Mechanism | Status |
|---|---|---|
| L1 schema compression | conservative description/param trimming (no $ref — provider-incompatible), `compressEnabled` | ✅ dyn segment only |
| L2 dynamic loading | per-agent core + BM25 top-K + CN-alias server route | ✅ core |
| L3 selection metrics | `selectionCoverage` per session + offline `retrievalMetrics` | ✅ recorded to feedback.json |
| L4 execution side | folded tools stay executable + heat promotion + `tools_search` tool | ✅ |
| L5 cache discipline | deterministic ordering (core by config, hot/dyn by name) = byte-stable prefix | ✅ |

## Three-segment layout

| Segment | Content | Cost |
|---|---|---|
| core | per-agent core + heat-promoted tools, full schema | small, constant |
| dyn | BM25 top-K for the current query + CN-alias server top-K | small, per request |
| folded | everything else — dropped from the schema | zero |

An alias hit no longer pulls the whole server in: the matched server's tools
are ranked by BM25 (with the matched alias keywords bridged into the query to
cross the CN/EN gap) and the top `min(3, serverSize)` are loaded. When the
query yields no lexical signal at all, a stable name-order subset is loaded so
the alias still helps.

Optionally (`catalogEnabled: true`, default) folded tools are listed as a
one-line catalog section so the model still knows they exist and can call them
by name (execution-side fallback still works).

## Install

Official (needs the dsh CLI / pnpm):
```
dsh plugin --profile desktop add file:E:/DSH-Data/dsh-tool-folder
# or, after publishing: dsh plugin --profile desktop add github:<owner>/dsh-tool-folder
```

Manual fallback: put the package where the profile loader can resolve
`dsh-tool-folder`, then add to `profiles/<name>/cordis.patch.yml`:
```yaml
- insert:
    - id: tool-folder
      name: 'dsh-tool-folder'
      config:
        enabled: true
        core: [tool-bash, tool-pwsh]
        topK: 6
        hotThreshold: 3
```
(Manual install is not yet end-to-end verified — the loader resolution path
for a locally-added bundle is the one open question.)

## Rollback

Set `enabled: false` (or remove the insert row) and restart DSH. Folded tools
were never unregistered, so nothing else changes.

## Config

| key | default | meaning |
|---|---|---|
| enabled | true | master switch |
| perAgent | {} | `{agentId: {core: [...]}}` overrides |
| core | [] | always-loaded tools (fallback for unknown agents) |
| deny | [] | never inject + refuse execution: exact name, or `prefix*` matches a whole server. Deny wins over core, include and the catalog too. |
| topK | 6 | BM25 dynamic segment size |
| hotThreshold | 3 | folded tool called N times → auto-promote to core |
| catalogEnabled | true | append one-line catalog section for folded tools (fold safety net) |
| schemaToolEnabled | true | register the `tools_schema` meta tool (full parameter schema of one tool by name) |
| compressLevel | off | L1 compression tier: `off` \| `light` \| `standard` \| `aggressive`. `standard` trims descriptions to 200 chars + param descriptions to 120; `aggressive` additionally drops optional parameters (required ⊆ properties guaranteed constructively). Applies to dyn segment only — core/hot never trimmed. |
| compressEnabled | false | deprecated compat: `compressLevel: off` + `compressEnabled: true` is treated as `standard` |
| normalizeDescriptions | false | dyn-segment description hygiene: injection-marker removal + whitespace normalization + first-sentence keep + 300-char cap |
| category | {} | intent routing `{ "记忆/回忆/remember": ["mcp__viking"], ... }`. Key words are `/`-separated (OR). Category wins over aliases; each matched server loads per-server top-3. |
| include | [] | whitelist: exact name or `prefix*`. Non-empty → only matching tools are injected (meta tools exempt; deny still wins). Execution is NOT gated by include. |
| toonifyResults | false | compact long JSON results after execution (drop empty fields + truncate strings; only when the text block is >2000 chars and parses as JSON) |
| maxFoldMs | 50 | hard cap; beyond this keep the full list |
| semanticEnabled | true | **v0.1.8**: tools_search semantic leg — BM25 + local bge-m3 (Ollama) RRF hybrid. Chinese intents hit English-only tools (the documented BM25 gap). Index lazily built + disk-cached (`~/.dsh/state/semantic-cache.json`); Ollama offline/timeout degrades to BM25-only, never slower or worse. |
| ollamaBase | http://127.0.0.1:11434 | Ollama endpoint for the semantic leg |
| embedModel | bge-m3 | embedding model for the semantic leg |
| feedbackFile | '' | feedback JSON path (default `$DSH_HOME/logs/tool-folder/`) |
| aliases | built-in | CN-intent keyword → server prefix table (per-server top-K) |

## Files

- `lib/bm25.js` — zero-dep BM25 (k1=1.2, b=0.75; CN bigrams + EN tokens)
- `lib/semantic.js` — v0.2.0 semantic leg: local bge-m3 embeddings (Ollama) + RRF fusion, disk-cached
- `lib/chainguard.js` — ChainGuard firewall: literal patterns + exfil-chain detection + deobfuscation
- `lib/obfuscation.js` — v0.2.0 anti-obfuscation: concat rebuild, `-enc`/certutil/bitsadmin shapes, homoglyphs
- `lib/schema.js` — L1 tiered compression (`compressLevel`) + description normalization + lossless-JSON sanitizer
- `lib/category.js` — P1-1 intent-category routing (pure function, unit-testable)
- `lib/metrics.js` — heat/feedback persistence (fold promotion signals)
- `lib/toonify.js` — P2-2 long JSON result compaction (pure function)
- `lib/index.js` — assemble hook, three-segment fold, heat feedback, safety
- `cordis.patch.yml` — bundle insert declaration
- `test.js` — simulated-cordis harness: `node test.js`

## Known limits

- BM25 cannot cross the CN-query / EN-description language gap on its own; the
  alias table covers common CN intents and now bridges its EN keywords into the
  per-server BM25 scoring. A future query-rewrite leg (ARK LLM, proven in the
  GPT Researcher smart retriever) removes this entirely.
- Alias hits load the server's top-3 relevant tools, not the whole server. A
  server whose most relevant tool ranks low on a bridged CN query may miss it —
  the `tools_search` meta-tool and heat promotion are the recovery paths.
- `catalogEnabled` render behavior needs one runtime verification pass
  (section render is verified; the catalog text itself is standard).
- `toonifyResults` mutation of the result object in the host's post-execute
  waterfall is not yet proven end-to-end (the listener's return is a gate, not
  the result body) — the pure function + unit tests are in; runtime propagation
  needs one verification pass. Default off until then.
- `aggressive` compression hides optional parameters from the model, so a
  model that would have used them can't (execution still validates against the
  registry's original schema — C6). `standard` is the safe default tier;
  `aggressive` is opt-in.

## Changelog

### v0.2.4 — P1: batch tools_schema + sibling closure (2026-08-31)
1. **Batch expand** — `tools_schema` accepts `names: [...]` to expand several
   tools in one call (`{ found, results: [...] }`); a single `name` keeps the
   legacy 6-field shape byte-for-byte.
2. **Sibling closure** (`closureSize`, default 0 = off, mirrors the
   `maxWarmTools` compat precedent): when enabled, expanding a tool also lists
   lightweight sibling entries (name + 120-char description) from the same
   server prefix, so the model can batch-expand what it actually needs —
   kills the "expanded A, now I need B" round-trip. `closure: false` opts out
   per call.
3. Output contract moved to a pure function (`buildSchemaResponse`, ux.js) —
   11 new tests pin single/batch/missing/siblings branches (94 total green).
4. Two-axis audit (Standards + Spec): 1 Critical fixed during review — the
   single/batch routing condition was inverted (old `name`-only calls would
   have returned the batch shape); contract tests now catch that class
   instantly. `siblingClosure` dead code removed.

### v0.2.3 — fold-ux: search fallback catalog + query expansion + stable results + discovery stats (2026-08-30)
1. **Zero-match fallback catalog** (`fallbackCatalogSize`, default 30): when
   `tools_search` finds nothing, it returns a name-sorted lightweight catalog
   (name + 80-char description) instead of an empty list — the model never
   concludes a capability doesn't exist just because its wording missed.
   `total` reports the real catalog size (not the listed slice); the output
   carries `fallback: true`. `0` restores the legacy empty result.
2. **CN→EN query expansion** (`queryExpandEnabled`, default on): a 48-term
   high-frequency intent table appends English synonyms to the search text
   (search/find, file, image/ocr, database, deploy, schedule…). Only adds
   terms, never rewrites the original query; exact-name priority still uses
   the raw query, so precise lookups are byte-identical to v0.2.2.
3. **Stable results** (`createSearchCache`, 60s TTL / LRU 200): the same query
   returns the same result set across turns — kills per-turn candidate drift.
4. **Discovery stats** (`recordDiscoveries`): every found tool is counted and
   persisted (30s-throttled, merged into tool-folder-state.json); on restart
   the top-5 are logged so low-discovery tools can be identified and their
   descriptions improved (Anthropic's "monitor discovery rate" loop).
5. 83 tests green (11 new: ux module).
6. Three-axis audit (Standards / Spec / compatibility): 1 P1 fixed — warm and
   discovery state now merge-write the shared state file instead of clobbering
   each other; P2 hardening — `tools_search` execute got a whole-body
   fail-open catch, fallback `total` semantics clarified, comments corrected
   to process-level scope.

### v0.2.2 — tiered disclosure budget + warm LRU + incremental semantic cache (2026-08-30)
1. **Tiered disclosure budget** (`disclosureBudget`, default 0 = off): caps how
   many tool names + descriptions are disclosed per request. Over budget, tools
   are demoted tier by tier (T2 name+desc → T3 name-only → T4 hidden) instead
   of being dropped wholesale; core/hot/meta tools stay tier-1 and never demote.
2. **Warm LRU** (`maxWarmTools`, default 0 = off): recently used tools are kept
   visible within a bounded LRU, persisted to state so a restart keeps them
   warm. `0` keeps the exact legacy injection surface.
3. **Incremental semantic cache**: the bge-m3 embedding cache now diffs by
   content fingerprint — only docs whose text changed get re-embedded, and a
   model change rebuilds once. A failed refresh never clobbers a good cache.
4. **Config persistence**: `lib/storage.js` reads/writes state with a
   settings → state → memory fallback chain (never touches cordis.patch.yml).
5. **Explicit fail-open**: `missingMetaTools` gates meta-tool availability —
   any snapshot oddity returns the full tool list rather than a folded one.
6. 72 tests green (new: budget 8 / warm 8 / semantic-incremental 5 / storage 7
   / fail-open 4).

### v0.2.1 — heat decay + exact-name priority (2026-08-30)
1. **Hot heat decay** (`hotWindowDays`, default 3): a tool is promoted to
   always-visible only when its call count stays inside the sliding window —
   the old code promoted forever, so any tool used 3 times was permanently
   resident and the fold silently decayed to zero over time. Legacy
   `feedback.json` number entries are read as out-of-window → their stale
   heat expires naturally. Set `hotWindowDays: 0` to keep the old behavior.
2. **Exact-name priority in `tools_search`**: exact tool-name match always
   ranks first, a ≥4-char query that is a name substring is pulled ahead of
   BM25/semantic hits (deterministic fallback chain). Results stay
   deduplicated.
3. 40 tests green (11 new: window decay / legacy compat / priority order).

### v0.2.0 — first npm release (2026-08-30)
This is the first version published to npm. It bundles the v0.1.7 firewall
scope fix (exec-only hard block) and the v0.1.8 semantic leg +
anti-obfuscation work documented below. The 0.1.x line on npm predates all
of it; if you installed from npm before, upgrade to 0.2.0.

> The v0.1.7 / v0.1.8 entries below use local internal iteration numbers —
> the npm 0.1.x packages do NOT contain this work. Everything here ships in
> 0.2.0 only.

### v0.1.8 (internal) — semantic leg + anti-obfuscation (2026-08-30)
1. **tools_search semantic leg**: BM25 + local bge-m3 (Ollama) RRF hybrid —
   Chinese intents hit English-only tools that share no surface tokens (the
   documented BM25 gap, README Known limits). Doc embeddings are cached to
   `~/.dsh/state/semantic-cache.json` keyed by content fingerprint; the
   ~10s cold start for 300+ tools happens once. Any failure (Ollama down,
   timeout, cache unreadable) degrades to pure BM25.
2. **ChainGuard anti-obfuscation leg** (`lib/obfuscation.js`): `verdict()` now
   runs three legs — (a) literal patterns on the raw text; (b) de-obfuscated
   text (quoted concatenation `"ne"+"t user"` / `-join` rebuild) re-run
   through the literal patterns; (c) encoded shapes that no literal pattern
   can see: `-enc` base64, `certutil -decode` chains, `bitsadmin /transfer`,
   long base64 payload + exec verb, full-width homoglyphs (`ｃｕｒｌ`),
   combining-mark mangling, hex-escaped bytes. All pure regex/string math,
   zero deps, sync (pre-execute is a sync callback). Covered by 22 unit
   tests (all pass); harmless concatenation (`"Get"+"-ChildItem"`) still
   passes.
3. New config: `semanticEnabled` / `ollamaBase` / `embedModel`.

### v0.1.7 (internal) — ChainGuard false-positive fix (2026-08-30)
1. **P0 firewall scoped to exec tools**: `tools/pre-execute` high-risk hard
   block (`verdict()`) now applies ONLY to exec-type tools (`isExecTool`:
   pwsh/shell/bash/cmd/exec/run/terminal + `run_*`/`exec_*`/`ssh_*`/wsl
   prefixes). Previously it ran against EVERY tool's arguments, so
   content-type tools (write/edit/read — whose arguments are file contents or
   text) were hard-blocked whenever their payload merely CONTAINED dangerous
   command literals (e.g. writing a test script, a security analysis, or a
   doc that quotes dangerous command examples). Verified: content write with
   such literals was blocked before, is allowed after; exec tools still
   hard-block real dangerous commands. `isExecTool` classification covered by
   a 25-case unit check (all pass).
2. **Scope kept**: exfil-chain detection (`checkChain`, post-execute, warn-only)
   and `deny` config are unchanged — they never hard-blocked content tools.

### v0.1.6 — settings UI schema (2026-08-25)
1. **`Config` schema exported (schemastery)**: every toggle now renders as a
   native form in the DSH settings UI — no more hand-editing YAML. The schema
   mirrors `DEFAULTS` one-to-one (18 fields: enabled / core / deny / topK /
   hotThreshold / catalogEnabled / compressLevel / compressEnabled /
   schemaToolEnabled / normalizeDescriptions / category / include /
   toonifyResults / toolSearchEnabled / firewallEnabled / maxFoldMs /
   feedbackFile / aliases), with per-field Chinese descriptions and range
   constraints (topK 0-50, hotThreshold ≥1, maxFoldMs 0-1000). Invalid values
   are rejected with precise messages ("expected off | light | standard |
   aggressive but got X"). Same pattern as @deepseek-ai/dsh-tool-todo
   (`z.object` + `.default()`, schemastery `~standard` bridge).
2. **Dependencies**: `@deepseek-ai/schemastery` + `zod` (both `dependencies`,
   matching the official plugin pattern — the zod adapter is required by the
   `~standard` bridge).

### v0.1.5 — tools_schema + tiered compression + intent routing (2026-08-25)
1. **P0-1 `tools_schema` meta tool**: model-driven full-schema discovery for one
   tool by name (complement to `tools_search`). Output is `{schema:{type:"json"}}`
   (host contract C3 — a strict object schema would reject arbitrary tool
   schemas with "is not a declared property"). Its return value is deep-washed
   by `sanitizeLossless` (C4: `const:-0`/NaN can never leak). Meta tools are now
   managed by a shared `META_TOOLS` block that keeps both `tools_search` and
   `tools_schema` always visible.
2. **P0-2 `compressLevel` tiers**: `light`/`standard`/`aggressive` replace the
   single conservative trim. `aggressive` drops optional parameters and rebuilds
   `properties` from `required`, so `required ⊆ properties` holds constructively
   (C8). Required properties are never dropped; `$ref`/`oneOf`/`items` deep
   structure is never touched; non object-root parameter schemas get
   description-only trimming. `compressEnabled: true` remains as a deprecated
   compat alias for `standard`.
3. **P1-1 `category` intent routing**: `{ "记忆/回忆": ["mcp__viking"] }` routes a
   query to explicit server prefixes (per-server top-3, BM25-bridged) and wins
   over the alias table. Default `{}` = zero behavior change.
4. **P1-2 `normalizeDescriptions`**: dyn-segment descriptions are sanitized
   (prompt-injection markers removed), whitespace-collapsed, first-sentence
   kept, and capped at 300 chars. Core/hot descriptions are never touched.
5. **P2-1 `include` whitelist**: exact name or `prefix*`; non-empty → only
   matching tools enter the injection pool. Meta tools are exempt (a whitelist
   can never hide the discovery tools), deny still wins, and execution is never
   gated by include (C5).
6. **P2-2 `toonifyResults`** (default off): post-execute compaction of long JSON
   text blocks (>2000 chars) — drop empty fields, truncate long strings. Any
   parse/compact failure leaves the original result untouched. Pure function in
   `lib/toonify.js`; host waterfall propagation still to be confirmed at runtime
   (see Known limits).
7. **Tests**: 33 → comprehensive suite (~50+ checks) covering every new feature
   plus regression guards for the red lines ($ref untouched, core untouched,
   required ⊆ properties, lossless JSON, deny-wins-over-include).

### v0.1.4 — audit fixes (2026-08-25)
1. **P0 firewall contract fixed** (`tools/pre-execute`): the listener now
   returns `{ kind: "deny", reason }` to refuse (host contract verified:
   `prepareExecution` reads `gate.kind` / `gate.reason`; `exec` has
   `{ callId, name, arguments, agent, signal }` — the old `payload.deny()`
   call and `toolName/argv` fields never existed, so high-risk blocks silently
   never fired).
2. **P0 feedback loop revived** (`tools/post-execute`): heat counting,
   exfil-chain recording, coverage and session persistence moved off
   `agent/pre-step` (whose payload has no toolCalls) onto `tools/post-execute`
   (fires per executed tool with `exec.name`/`exec.arguments`). Feedback now
   actually persists and heat-promotes across restarts.
3. **P0 ESM crash removed**: `require("node:fs")` under `"type": "module"`
   threw ReferenceError and silently killed all feedback persistence; replaced
   with top-level `import fs` / `import path`. Also fixed a parameter-shadow
   bug (`path` param hid the `node:path` module in `persistFeedback`).
4. **P1 alias whole-server pull fixed**: alias hits now load a per-server
   BM25 top-K (`min(3, serverSize)`) with alias keywords bridged into the
   query, instead of dragging in every tool of a matched server.
5. **P1 deny config added**: `deny: []` (exact name or `prefix*`) removes a
   tool from the injected surface AND refuses its execution at
   `tools/pre-execute`. Deny wins over core and the catalog.
6. **P2 stopword over-removal fixed**: `list/get/set/make/use(ing)` removed
   from the EN stopword set — they are tool-name/description high-frequency
   terms (`list_sessions`, `get_config`) and were eroding retrieval signal.
7. **P2 -0 defense**: metrics now normalize `-0` → `0` (DSH lossless JSON
   rejects `-0`).
8. **P2 default flip**: `catalogEnabled` defaults to `true` (fold safety net —
   the model can see that hidden tools exist). `compressEnabled` stays off
   (L1 not fully verified).
9. **Tests**: suite extended 15 → 29 checks, covering the deny-return
   contract, `tools/post-execute` receiving `exec.name`, deny config
   (inject + execution), alias per-server top-K, no-`require` ESM hygiene, and
   no-`-0` metric outputs.
10. **NEW-1 (QA finding, LOW)**: three backslash-sensitive firewall regexes
    (`HKLM\SAM`, `\system32\config`, `\Run`) silently never matched when argv
    reached `verdict()` JSON-encoded (single backslash → `\\`). Changed `\\`
    to `\\+` so both raw-string and JSON-encoded paths are blocked. Added 4
    regression checks (suite now 33).

### v0.1.3 — initial release (2026-08-24)

## Quality check (2026-08-24, real 45-tool set)

Full-pipeline test with the REAL tool list (converted to DSH public names
`mcp__<server>__<tool>`), 7 typical queries:

| query | result | verdict |
|---|---|---|
| delegate a coding task to openhands | 7 openhands tools | ✅ |
| 帮我记住这个事实 / 查记忆 记住 回忆 | top-3 viking tools (alias, per-server top-K) | ✅ |
| fetch library documentation | 2 context7 tools | ✅ |
| start a learning session | top-3 deeptutor tools (alias, per-server top-K) | ✅ |
| 复杂推理任务 深度思考 | deeptutor deep_* + reasonix + openhands | ✅ |
| 搜索代码 semantic search | viking grep/glob + reasonix code | ✅ |

- Fold ratio: 45 tools → 2-18 visible per query (avg ~8) ≈ **-82% schema tokens**
- v0.1.4: alias hits are capped at the server's top-3 by relevance instead of
  pulling the whole server in (the v2 per-server top-K refinement is now live).
- BM25 shows minor lexical noise on some queries (e.g. `cancel_watch` on an
  openhands query) — the model filters this during synthesis.

### Bugs found & fixed during the check
1. **tools_search self-hide (real bug)**: the meta-tool was folded by its own
   filter, so the model could never see it. Now always kept visible.
2. **Test-data error (not a code bug)**: raw MCP tool names vs DSH public
   names (`mcp__<server>__<tool>`, verified in dsh-mcp-client
   `publicToolName`). The plugin's prefix logic was correct all along.
