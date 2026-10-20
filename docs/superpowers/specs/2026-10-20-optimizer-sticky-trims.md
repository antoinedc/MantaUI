# Optimizer: sticky trims, priced per model (fix the cache-busting masker)

Status: draft r2 (after astra review #1) · Branch: `feat/optimizer-sticky-trims` · Date: 2026-10-20

## 1. Problem (measured)

The masking half of the optimizer replaces old tool outputs with a placeholder
before each model request. On the dev box it cost more than it saved.
Evidence from opencode's message ledger, 2026-10-17 09:00–13:00 UTC:

- 985 assistant requests; **145 (15%) re-cached their entire history**
  (cache read ≤ the system prefix, cache write > 100k), carrying **41.9M of the
  43.9M cache-write tokens (95%)**.
- Busiest sub-agent (`ses_eb7419…`): requests alternate between an ~800k
  unmasked history (read from cache) and a ~280k masked one, re-written in full
  almost every time (`273k write → 272k write → 803k read → 273k write`).

Defects, present in BOTH plugin copies (`docs/opencode-plugins/manta-optimizer.ts`
= V1, installed today; `docs/opencode-plugins-v2/manta-optimizer/` = V2 twin)
and the shared pure copy `src/shared/maskPlan.mjs`:

- **D1 — one policy slot per process.** Parallel sessions evict each other; a
  miss returns `DEFAULT_POLICY` (`enabled:false`), so a session's requests flip
  between masked and unmasked.
- **D2 — masks are recomputed per request.** Each new tool call moves the
  eligibility line by one output, changing the history at an early position →
  never a cache hit. `decideApply` stays true once crossed, so nothing batches.
- **D3 — fixed economics.** No notion of what a re-cache costs for the model in
  use. Opus 5.5 (the main model here) is 25× write/read, not the 12.5× the
  design implicitly assumed; other providers have no write premium at all.
- **D4 — the re-warm counter is fiction.** Reported on every request whether or
  not anything changed; the dashboard's savings are unreliable both ways.
- Minor: plugins never pass `directory` to the policy route (tuner table never
  applies); `maskPlan.mjs` has drifted from V1 (no `maxTailAtMask`).

## 2. Goal / non-goals

Goal: keep trimming, but only when it pays for the model actually in use, and
keep a trimmed history byte-identical across requests until the next
deliberate, priced trim. Works for any opencode provider without naming one.

Non-goals: changing eligibility rules (tail / recency / skill exclusions stay);
compaction, pacing, routing, tuner logic (beyond receiving `directory`);
OpenRouter-style per-provider price adapters; cleaning leftover `*.tmp-*` files
in `~/.manta/` (separate ticket). Assumption (owner decision 2026-10-20):
**subscription usage is priced at list price** — the optimizer treats quota as
if it were credits.

## 3. Prices

### 3.1 Resolution (server, provider-agnostic)

For a request on `(providerID, modelID)` — opencode's own ids, e.g.
`openrouter` / `deepseek/deepseek-v4-flash` — resolve a price record:

1. **User-declared** `cost` in opencode config
   (`provider.<providerID>.models.<modelID>.cost` in `opencode.jsonc`). This is
   opencode's own standard and covers private/custom providers.
2. **models.dev provider-keyed table** (`api.json[providerID].models[modelID].cost`),
   from Manta's own cached copy (§3.3).
3. Otherwise **unpriced**.

Rules:
- Never use opencode's live `/provider` cost: it reports $0 for
  subscription-authenticated providers (OpenAI here), contradicting the
  list-price assumption.
- Never borrow another provider's price for the same model (hosts differ, some
  don't cache). Lookup is exact on `(providerID, modelID)`.
- A price record is **usable** iff `input > 0` and `cacheRead > 0`. A missing
  or zero `cacheWrite` means "no write premium": `cacheWrite := input`.
- **Tiers:** if the record has `tiers[]` (`{tier:{type:"context",size}, …}`) or
  `context_over_200k`, the rates applying to the request's estimated prompt
  size are used.
- **1-hour cache:** when the session's effective cache TTL is > 5 min, use the
  record's 1-hour write price if present, else `2 × input`.
- Catalog copy older than **7 days** → treat source 2 as absent.

### 3.2 Plugin delivery (contract C1)

`GET /api/optimizer/prices` (bearer-gated) →
```
{ fetchedAt: number,            // ms epoch of the catalog copy used (0 if none)
  models: { "<providerID>/<modelID>": {
      input: number, cacheRead: number, cacheWrite: number, cacheWrite1h?: number,
      tiers?: [{ minPromptTokens: number, input, cacheRead, cacheWrite, cacheWrite1h? }],
      source: "config" | "catalog" } } }
```
Only usable records appear (already normalized: $/Mtok, `cacheWrite` defaulted,
tiers sorted ascending). The plugin caches it process-wide, refreshes in the
background every 10 min, never awaits it. **Model not in the map → no growth**
(replay continues). Cold map → same.

### 3.3 Catalog refresh

Extend `src/server/modelCatalog.mjs` (already polls `models.dev/api.json` every
6 h into `model-catalog.json`) to also persist the raw provider-keyed cost table
(including tiers/`context_over_200k`/1h write) and its `fetchedAt`. Existing
`buildPriceMap` behaviour for routing is unchanged.

### 3.4 Unpriced providers in Settings

The provider card (Settings → Providers) shows, for a connected provider whose
models resolve to unpriced: "No prices — the optimizer won't trim this
provider", with an optional per-model form (input / cache read / cache write,
$/Mtok) that writes `cost` into opencode config via the existing
`PATCH /global/config` writer.

## 4. Plugin design

### 4.1 Per-session policy (D1)

- Policy client keeps `Map<sessionID, {policy, at, authoritative}>` (LRU, 512).
  Fresh (< 60 s) → use; stale → use + background refresh. Never awaits.
- Cold session: **provisional** policy = last policy fetched for any session,
  else `DEFAULT_POLICY`; `authoritative:false`; refresh fired.
- Refresh passes `directory`: V1 from the plugin init argument `directory`
  (opencode instantiates plugins per project instance); V2 from
  `ctx.session.get` (`directory`), cached per session. Implementer must verify
  both against the pinned binaries; if unavailable, omit (tuner not applied).

### 4.2 Trim state (D2)

Per session: `real` and `shadow` maps, `id → exact replacement text`.

- **Identity** = the tool-call id shared by the call and its result. V1:
  `part.callID` (required; no id → never trimmed). V2 lowered: `tool-result.id`.
  V2 timeline: the implementer pins the field after checking, in the
  `scripts/opencode-v2` harness, which id is stable across consecutive
  requests, and records that in a test.
- **The replacement text is stored**, not re-rendered, so replay is
  byte-identical regardless of input-ordering or format changes. File carries
  `renderVersion` for future format changes; old entries keep their text.

### 4.3 Per-request algorithm

1. **Replay (mandatory, always):** replace every part whose id is in `real`
   with its stored text. O(parts) lookups, no token estimation, outside the
   scan budget, and NOT subject to the part-count bail-out. Ids absent from
   the history are dropped from `real` (compaction/revert). If replay throws,
   log once and send the request untouched (accepted rare flip).
2. **Discovery (optional):** only with an authoritative policy and a priced
   model; subject to the existing part-count and time-budget bail-outs. A
   bail-out skips discovery only — replay already happened. Eligibility is
   evaluated on the **post-replay** history (placeholders count as their real
   length in the tail; already-trimmed parts are never candidates).
3. **Gate (§4.4)** → grow, or do nothing.
4. **Transition table** (P = authoritative policy, prov = provisional):

| Policy | `real` | `shadow` |
|---|---|---|
| prov / default | replay only | untouched |
| P, enabled | replay; may grow via gate | cleared |
| P, disabled, `real` non-empty | **clear** (prefix change, reported) | — |
| P, disabled | — | discovery + gate on shadow; never applied |

Turning the switch on starts `real` empty (shadow is not adopted).

### 4.4 Gate (D3)

Per candidate batch (all current candidates at once):

- `R` = net tokens removed = Σ (original − replacement) over candidates.
- `T` = tokens from the earliest candidate to the end of the **previous
  request's prompt**, post-trim — the part that was cached and will now be
  re-written. Content appended since the previous request is excluded (it is
  written anyway). Token estimates use the existing `ceil(chars/4)`, counting
  text, tool inputs and tool outputs.
- Rates `r` (cache read) and `w` (cache write, 1h if applicable) from §3 at the
  tier for the current prompt size.
- `extraCost = T × (w − r)`; `benefitPerRequest = R × r`;
  `breakEven = extraCost / benefitPerRequest`.
- `N` = completed assistant messages in the history since the last compaction
  (one per model call). **Heuristic, labelled as such:** expected remaining
  requests ≈ `min(N, 200)`.
- **Grow iff** `R ≥ batchTokens` **and** `min(N,200) ≥ margin × breakEven`
  **and** at least `ceil(breakEven)` requests have passed since this session's
  last growth (cooldown — a session cannot re-qualify every turn).
- **Cache known dead** → grow iff `R ≥ batchTokens` (the re-write happens
  anyway). "Known dead" requires a reliable completion time: V1 = last
  assistant `time.completed` in the history; V2 = the session's `time.updated`
  fetched in the background, only if fetched after the previous request
  started. Unknown freshness = **live**.
- Defaults (policy, C3): `batchTokens` 20 000, `margin` 1.5.

Worked example (sub-agent above, Opus 5.5, 5 min TTL: r=0.2, w=5):
R≈520k, T≈280k → extraCost 1.34M·$, benefit 104k·$/req → breakEven ≈ 12.9;
margin 1.5 needs N ≥ 19.4. It had ~50 → trims once, then reads ~280k from cache
for every later request instead of ~800k.

### 4.5 Persistence

- Path: `<stateHome>/.manta/optimizer-trims/<sessionID>.json`, `stateHome`
  honouring `MANTA_STATE_HOME`. sessionID must match `^[A-Za-z0-9_-]{1,128}$`.
  Dir 0700, files 0600.
- Format C4: `{version:1, renderVersion:1, real:{[id]:text}, shadow:{[id]:text},
  lastGrowthSeq:number, updatedAt:number}`.
- **Writes are synchronous** (temp + rename, temp removed on failure) and happen
  only on grow/clear — rare by design — and **before** the trimmed request is
  sent, so a crash can never lose a trim already sent upstream. One opencode
  process per box is assumed (documented); writes for a session are
  serialized by construction (synchronous, single-threaded).
- Cold load: synchronous read the first time a session is seen in a process;
  refuse files > 4 MB (treat as empty, log once). Corrupt → empty, log once.
- Caps: 5 000 entries per map — at cap, stop growing (never evict a live
  replacement). In-memory LRU 512 sessions (file remains).
- Pruning: while a session is in use, touch the file mtime at most once per
  hour; the plugin deletes files with mtime > 14 days, at most once per hour.

## 5. Counting (D4)

### 5.1 Report (contract C2) — one per request when any map is non-empty or changed

```
{ v: 3, sessionID, ts, seq,            // seq = N (assistant msgs) — dedupe key
  providerID?, modelID?,               // required for pricing; absent → unpriced
  applied:  { trimmedTokens, trimmedParts },      // what was actually replaced in this request
  shadow:   { trimmedTokens, trimmedParts },      // simulated, never sent
  change:   "none" | "grow" | "clear",            // what happened to `real`
  shadowChange: "none" | "grow",
  rewarmTokens: number,                // T for grow/clear when cache live, else 0
  shadowRewarmTokens: number }
```
`applied` is what was actually replaced, independent of policy mode (a
provisional policy replaying `real` is still "applied"). Validator rejects
`rewarmTokens > 0` with `change:"none"` (same for shadow). Server dedupes on
`(sessionID, seq, v)` within the hour bucket (retries re-fire the hook).
Totals are labelled **estimates** in the UI (hook-time, not billing-verified).

### 5.2 Store v3 + pricing

- `counterfactual.mjs` → v3; v2 buckets AND the legacy `sessions` map are
  dropped on load. Buckets: `{ actual: {byModel:{[mk]:{trimmed, rewarm}}},
  potential: {byModel:{…}}, reports }` — actual and potential never pooled.
- v2-shaped reports (old plugin during rollout) are accepted with 200 and
  ignored.
- Pricing per model with the §3 resolver (shared server function, same
  numbers the plugin received): `saved = Σ trimmed × r − rewarm × (w − r)`.
  `savedUsd` must support cost-only windows (trimmed 0, rewarm > 0 → negative)
  — remove the early zero return. Unpriced models are reported as unpriced,
  never imputed.
- Chart: raw usage = sent + **actual** trimmed only; potential is a separate
  line. Card copy: "re-cache cost", net savings, shown negative when negative.

## 6. Contracts summary

- **C1** `GET /api/optimizer/prices` (§3.2).
- **C2** counterfactual report v3 (§5.1).
- **C3** policy route adds `margin` (1.5) and keeps `batchTokens`; accepts
  `directory`. `chunkTokens` / `rewriteCostRatio` from r1 are dropped (prices
  replace them).
- **C4** trim file (§4.5), plugin-owned; the server never reads or writes it.
- **C5** shared logic: `src/shared/maskPlan.mjs` exports
  `planRequest({messages, policy, authoritative, prices, state, now, lastCompletedMs, prevPromptTokens})
  → {replay, candidates, R, T, N, breakEven, decision:"none"|"grow"|"clear", reason}`
  plus `resolveRates(record, promptTokens, ttlMs)`. Both plugins port it
  verbatim; a test runs the V1 plugin's inlined copy and `maskPlan.mjs` over the
  same fixtures and asserts identical plans; V2 tests use the same fixtures.

## 7. Ownership

- **A — plugins + shared planner:** `src/shared/maskPlan.mjs` (+ `.d.mts`,
  tests), `docs/opencode-plugins/manta-optimizer.ts` (+ test),
  `docs/opencode-plugins-v2/manta-optimizer/**`,
  `scripts/opencode-v2/optimizer.test.mjs`.
- **B — server:** `src/shared/optimizerPolicy.mjs`, `src/shared/optimizerSavings.mjs`,
  `src/server/modelCatalog.mjs`, new `src/server/optimizer/prices.mjs`,
  `src/server/optimizer/{counterfactual,series,summary}.mjs`, routes in
  `src/server/index.mjs` (policy, prices, counterfactual, and the telemetry
  reader of report fields), `src/shared/types.ts` (optimizer types only), tests.
- **C — renderer:** `src/renderer/OptimizerCard.tsx`, the Settings providers
  card (unpriced notice + price form), tests.
- Nobody touches another owner's paths; all code against §6.

## 8. Tests (must exist)

- Interleaved sessions A,B,A,B: no session with an authoritative policy ever
  gets a default one; provisional never grows/clears.
- Restart (empty memory, file on disk) → byte-identical replay; crash between
  grow and send impossible (write precedes send).
- Bail-outs (> 4 000 parts, budget exhausted) keep existing replacements.
- 30 synthetic requests adding one tool call each: history identical between
  growths; growth only when the gate passes; cooldown honoured.
- Gate: worked example; no-write-premium provider (`cacheWrite` missing);
  tiered pricing above 272k; 1h write; unpriced model → no growth; unknown
  freshness treated as live.
- Price resolver: config beats catalog; `/provider` $0 ignored; exact
  `(provider, model)` lookup (no cross-provider borrowing); stale catalog → unpriced.
- Transition table rows, including on→off→on.
- Report validator; dedupe on `seq`; v2 reports ignored; store v3 drops v2 data;
  per-model actual vs potential never pooled; cost-only window negative.
- sessionID path validation rejects `../x`; oversized/corrupt file → empty.

## 9. Before merge: backtest (required)

`scripts/optimizer/backtest-trims.mjs` replays opencode's ledger for a chosen
window (default: 2026-10-17 09:00–13:00 UTC) through `planRequest`, using
recorded token counts, and prints per session: growths, simulated cache-write
vs the recorded cache-write, and net simulated savings at list prices. The PR
must include its output; net must be positive overall and no session may grow
more than a handful of times.

## 10. After merge (manual, dev box)

Switch on for one working day, then rerun the §1 ledger query: full-history
re-caches back near baseline (first requests + cache expiries + model
switches); card's net savings positive and consistent with ledger-derived read
savings. Otherwise switch off and revisit `margin` / `batchTokens`.

Rollout: next server release (plugins sync via self-update). Switch stays off
on the dev box until §10.
