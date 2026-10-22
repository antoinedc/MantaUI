# Optimizer: sticky trims, priced per model (fix the cache-busting masker)

Status: FINAL r3 (after astra reviews #1 and #2) · Branch: `feat/optimizer-sticky-trims` · Date: 2026-10-20

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
- **Tiers:** if the record has `tiers[]` (`{tier:{type:"context",size}, …}`),
  they are authoritative and `context_over_200k` is ignored. Only when there is
  no `tiers[]` is `context_over_200k` used, as a single tier with `size:200000`.
  A tier applies when the estimated prompt tokens are **strictly greater** than
  its `size`; the highest applying tier wins. A field missing from a tier
  inherits the base record's value.
- **1-hour cache:** 1-hour write pricing is used ONLY when both (a) the model
  is one Manta configures for the 1-hour cache (the existing `cacheTtl:"1h"`
  setting, which applies to Anthropic-SDK models only — see
  `selectCacheTtlTargets` in `src/server/providers.mjs`) and (b) a 1-hour
  write price is known: the record's own (`cache_write_1h` or equivalent) or,
  since models.dev carries no such field and (a) restricts this to
  Anthropic-SDK models, Anthropic's published 1-hour tariff of 2 × that
  tier's input price. Never infer a tariff from an observed TTL, and never
  apply the 2× rule outside (a). (Amended during review: the catalog has no
  1-hour field, so without this every 1h-configured Anthropic model was
  unpriced.)
- Catalog copy older than **7 days** → treat source 2 as absent. The plugin
  also enforces this locally from `fetchedAt` when its refreshes fail.
- The price cache is a **separate, versioned file**
  (`statePath("model-prices.json")`, `{version:1, fetchedAt, providers:{…raw
  cost records…}}`); the routing catalog cache format is untouched.
  `fetchedAt` advances only on a successful, validated fetch.

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

`src/server/modelCatalog.mjs` already fetches `models.dev/api.json` every 6 h.
On each successful fetch it ALSO writes the raw provider-keyed cost records
(including `tiers`, `context_over_200k`, 1-hour write) to the separate price
cache above. Existing `buildPriceMap` behaviour for routing is unchanged.

### 3.4 Unpriced providers in Settings

The providers card (Settings → Providers) shows, for a connected provider with
any unpriced model: "No prices — the optimizer won't trim these models", with
an optional per-model form: input, output, cache read, cache write ($/Mtok).
**input and output are required** (opencode's config schema requires both);
cache fields optional. Saved through a NEW narrow writer (C6) — never through
`upsertProviderBlock`, which rebuilds provider blocks and would clobber a
built-in provider.

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

### 4.3 Per-request algorithm — plan on the untouched input, then commit, then apply

The request history is NOT mutated until step 4. All planning reads the
untouched input; original lengths are captured there.

1. **Plan transitions** from the untouched input + committed state, using the
   transition table below. Clear needs no prices and no discovery.
2. **Discovery (only for a possible grow):** authoritative policy, enabled,
   priced model, known previous-prompt boundary (§4.4). Subject to the existing
   part-count and time-budget bail-outs; a bail-out means "no grow", never
   "no replay". Eligibility is evaluated on a **virtual** history = untouched
   input with the committed map's replacements applied (placeholders count as
   their replacement length in the tail; already-trimmed ids are never
   candidates). Shadow discovery uses its own virtual history built from
   `shadow` and its own cooldown state; it never touches the real request.
3. **Commit:** if the plan changes `real` or `shadow`, build the new state,
   write it synchronously (§4.5). Only on success does it replace the
   in-memory committed state. On write failure: keep the previous committed
   state, report `change:"none"`, log once.
4. **Apply:** replace every part whose id is in the (now) committed `real` with
   its stored text. Replay is O(parts) lookups, outside the scan budget, and
   NOT subject to the part-count bail-out. Ids absent from the history are
   dropped at the next commit (compaction/revert). If applying throws, log once
   and send the request untouched (accepted rare flip).
5. **Record** this request's boundary (§4.4) and report (§5.1).

Transition table (P = authoritative policy, prov = provisional):

| Policy | `real` | `shadow` |
|---|---|---|
| prov / default | unchanged (applied as-is) | unchanged |
| P, enabled | may grow via gate | cleared |
| P, disabled, `real` non-empty | **clear** → request goes out untrimmed; reported as `change:"clear"` | — |
| P, disabled | — | may grow via gate; never applied |

Turning the switch on starts `real` empty (shadow is not adopted).

### 4.4 Gate (D3)

Per candidate batch (all current candidates at once):

- **Previous-prompt boundary.** After every request the plugin records, in
  memory per session, `boundary = {messageCount, lastMessageKey}` for the
  history it just sent (`lastMessageKey`: V1 `info.id`; V2 the message id if
  the shape has one, else a hash of the last message's serialized content —
  implementer pins it in a test). A boundary is valid for the next request iff
  the history has ≥ `messageCount` messages and the message at
  `messageCount − 1` has the same key. **No valid boundary (first request in
  this process, compaction, revert) → no live-cache growth** this request;
  dead-cache growth is still allowed (it needs no `T`).
- `R` = net tokens removed = Σ (original − replacement) over candidates.
- `T` = tokens of the virtual history from the earliest candidate up to the
  boundary — the part that was cached and will now be re-written. Content
  after the boundary is excluded (written anyway). Token estimates use the
  existing `ceil(chars/4)`, counting text, tool inputs and tool outputs.
- `T_clear` (for a clear) = original tokens from the earliest trimmed part to
  the boundary; if no valid boundary, to the end of the history (upper bound).
- Rates `r` (cache read) and `w` (cache write, 1h if applicable) from §3 at the
  tier for the current prompt size.
- `extraCost = T × (w − r)`; `benefitPerRequest = R × r`;
  `breakEven = extraCost / benefitPerRequest`.
- `N` = completed assistant messages in the history since the last compaction
  (one per model call). **Heuristic, labelled as such:** expected remaining
  requests ≈ `min(N, 200)`.
- `reqCount` = a per-session counter the plugin increments on every request it
  sees (monotonic, independent of history length; persisted in the trim file
  at each commit, restored on load).
- **Grow iff** `R ≥ batchTokens` **and** `min(N,200) ≥ margin × breakEven`
  **and** `reqCount ≥ nextGrowthAllowedAt`.
- On an accepted live-cache growth: `nextGrowthAllowedAt = reqCount +
  ceil(breakEven of THAT growth)` — the previous trim must have had time to pay
  back before any further growth, however cheap the next batch looks.
  On a dead-cache growth: `nextGrowthAllowedAt = reqCount + 1`. A clear or a
  detected compaction (history shorter than the boundary's `messageCount`)
  resets it to `reqCount`.
- **Cache known dead** → grow iff `R ≥ batchTokens` and cooldown allows (the
  re-write happens anyway). "Known dead" requires a reliable completion time:
  V1 only = last assistant `time.completed` in the history, older than the
  model's cache TTL. **V2: never known dead** (its lowered messages carry no
  completion times and `time.updated` does not prove a cache operation) — V2
  uses the live-cache rule only. Unknown freshness = **live**.
- **Model switch:** if the previous request used a different
  `(providerID, modelID)`, the boundary is invalid for pricing purposes (the
  new model has no cache yet) and the request counts as known dead for V1 and
  V2 alike — this is the cheapest moment to trim.
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
  reqCount:number, nextGrowthAllowedAt:number, shadowNextGrowthAllowedAt:number,
  lastModel:string|null, updatedAt:number}`.
- **Writes are synchronous** (temp + rename, temp removed on failure) and happen
  only on grow/clear/shadow-change — rare by design — and **before** the
  request is sent (§4.3 step 3), so a crash can never lose a trim already sent
  upstream. `reqCount` / `lastModel` are persisted opportunistically with those
  writes and otherwise live in memory (a restart may undercount `reqCount`,
  which only delays growth). One opencode process per box is assumed
  (documented); writes for a session are serialized by construction
  (synchronous, single-threaded).
- Cold load: synchronous read the first time a session is seen in a process;
  refuse files > 4 MB (treat as empty, log once). Corrupt → empty, log once.
- Caps: 5 000 entries per map — at cap, stop growing (never evict a live
  replacement). In-memory LRU 512 sessions (file remains).
- Pruning: while a session is in use, touch the file mtime at most once per
  hour; the plugin deletes files with mtime > 14 days, at most once per hour.

## 5. Counting (D4)

### 5.1 Report (contract C2) — one per request when any map is non-empty or changed

```
{ v: 3, sessionID, ts,
  providerID?, modelID?,               // required for pricing; absent → unpriced
  rates?: { cacheRead, cacheWrite, source: "config"|"catalog", fetchedAt },
                                       // the exact $/Mtok rates the gate used (tier/TTL applied)
  applied:  { trimmedTokens, trimmedParts },      // net tokens actually removed from THIS request
  shadow:   { trimmedTokens, trimmedParts },      // simulated, never sent
  change:   "none" | "grow" | "clear",            // what happened to `real`
  shadowChange: "none" | "grow",
  rewarmTokens: number,                // T (grow) or T_clear (clear) when cache live, else 0
  shadowRewarmTokens: number }
```
`applied` is what was actually removed, independent of policy mode (a
provisional policy applying `real` is still "applied"); net = original −
replacement, using original lengths captured before applying. Validator
rejects `rewarmTokens > 0` with `change:"none"` (same for shadow). **No
dedupe** (owner decision): totals are labelled **estimates** in the UI
(hook-time, not billing-verified; a retried request may be counted twice).

### 5.2 Store v3 + pricing

- `counterfactual.mjs` → v3; v2 buckets AND the legacy `sessions` map are
  dropped on load. Bucket shape:
  `{ actual: {byModel:{[mk]:{trimmed, rewarm, usd, pricedReports, unpricedReports}}},
     potential: {byModel:{…same…}}, reports }` — actual and potential never pooled.
- v2-shaped reports (old plugin during rollout: no `v:3`) are accepted with 200
  and ignored.
- Each report is priced **at ingest** with its own `rates` (no re-pricing
  later): `usd = trimmed × r − rewarm × (w − r)` ($/Mtok × tokens / 1e6).
  A report without `rates` adds tokens but no usd and counts as unpriced.
- `savedUsd` (or its replacement) sums the stored usd; it must support
  cost-only windows (trimmed 0, rewarm > 0 → negative) — remove the early zero
  return. Unpriced share is reported, never imputed.
- Chart: raw usage = sent + **actual** trimmed only; potential is a separate
  line. Card copy: "re-cache cost", net savings, shown negative when negative,
  labelled "estimate".

## 6. Contracts summary

- **C1** `GET /api/optimizer/prices` (§3.2), bearer-gated, class-2 errors.
  Also exposed as RPC `optimizer:prices` (IPC key `optimizerPrices`) returning
  the same body plus `unpriced: string[]` — the connected models
  (`"<providerID>/<modelID>"`, from opencode's `/provider` connected list) that
  resolve to unpriced. Renderer method: `window.api.optimizerPrices()`.
- **C2** counterfactual report v3 (§5.1).
- **C3** policy route adds `margin` (default 1.5), keeps `batchTokens`, accepts
  `directory`. Unknown query params ignored.
- **C4** trim file (§4.5), plugin-owned; the server never reads or writes it.
- **C5** shared planner: `src/shared/maskPlan.mjs` exports (names pinned):
  - `resolveRates(record, promptTokens, {oneHour})` → `{cacheRead, cacheWrite}`
    or `null` (unpriced) per §3.1.
  - `planRequest({ messages, policy, authoritative, rates, state, boundary,
    model, now, lastCompletedMs })` → `{ decision: "none"|"grow"|"clear",
    add: {[id]: text}, R, T, N, breakEven, reason, applied:{tokens,parts},
    shadow:{decision, add, R, T, tokens, parts}, nextState }`
    where `state` = the committed C4 object and `nextState` is what to persist
    if any change. `messages` uses an adapter interface so both shapes work:
    the planner receives normalized units `{id, kind:"tool"|"text", tool?,
    input?, text, msgIndex}` produced by a per-shape adapter
    (`adaptV1(messages)` in the shared module; V2 has its own adapter in the
    V2 plugin). Applying replacements to the real request is done by the
    plugin via the adapter.
  - Both plugins port the shared logic verbatim (they cannot import the repo).
    A test loads the V1 plugin file's inlined copy and `maskPlan.mjs` over the
    same fixtures and asserts identical plans; V2 tests use the same fixtures.
- **C6** model-cost writer: RPC `opencode:set-model-cost`
  (IPC key `opencodeSetModelCost`), body
  `{providerID, modelID, cost:{input, output, cache_read?, cache_write?}}`
  ($/Mtok, finite ≥ 0; input/output required) → `{ok:true}` or
  `{ok:false, error}`. Server implementation: a new `setModelCost` in
  `src/server/providers.mjs` that PATCHes ONLY
  `{provider:{[providerID]:{models:{[modelID]:{cost}}}}}` via the existing
  `patchGlobalConfig` (deep-merge; never rebuilds the provider block). Ids
  validated (`^[A-Za-z0-9._:/@-]{1,200}$`). Renderer method:
  `window.api.opencodeSetModelCost(args)`. After success the price cache entry
  for that model flips to `source:"config"` on the next `optimizer:prices`.

## 7. Ownership

- **A — plugins + shared planner + backtest:** `src/shared/maskPlan.mjs`
  (+ `.d.mts`, tests), `docs/opencode-plugins/manta-optimizer.ts` (+ test),
  `docs/opencode-plugins-v2/manta-optimizer/**`,
  `scripts/opencode-v2/optimizer.test.mjs`,
  `scripts/optimizer/backtest-trims.mjs` (+ test).
- **B — server:** `src/shared/optimizerPolicy.mjs`, `src/shared/optimizerSavings.mjs`,
  `src/server/modelCatalog.mjs`, new `src/server/optimizer/prices.mjs`,
  `src/server/optimizer/{counterfactual,series,summary}.mjs`,
  `src/server/providers.mjs` (`setModelCost` only), `src/server/rpc.mjs`
  (the two new channels only), routes in `src/server/index.mjs` (policy,
  prices, counterfactual, and the telemetry reader of report fields),
  `src/shared/types.ts` (optimizer types + the two IPC keys only), tests.
- **C — renderer:** `src/renderer/OptimizerCard.tsx`, the Settings providers
  card (unpriced notice + price form), `src/shared/api.ts` (the two method
  signatures), `src/renderer/api/httpApi.ts` (the two methods), tests.
- Nobody touches another owner's paths; all code against §6.

## 8. Tests (must exist)

- Interleaved sessions A,B,A,B: no session with an authoritative policy ever
  gets a default one; provisional never grows/clears.
- Plan→commit→apply order: a clear sends an UNTRIMMED request; a failed write
  (ENOSPC / rename failure, injected) keeps the previous committed state and
  reports `change:"none"`.
- Restart (empty memory, file on disk) → byte-identical replay; no live-cache
  growth until a boundary exists.
- Bail-outs (> 4 000 parts, budget exhausted) keep existing replacements.
- 30 synthetic requests adding one tool call each: history identical between
  growths; growth only when the gate passes; cooldown uses the accepted
  growth's break-even (a cheap batch right after an expensive one is refused).
- Gate: worked example; no-write-premium provider (`cacheWrite` missing);
  `tiers` beat `context_over_200k`; strict `>` threshold; 1h only for
  1h-configured Anthropic models with a 1h price (else unpriced); unpriced →
  no growth; V2 never "known dead"; model switch → known dead.
- Price resolver: config beats catalog; `/provider` $0 ignored; exact
  `(provider, model)` lookup (no cross-provider borrowing); stale catalog →
  unpriced; price cache `fetchedAt` not advanced on a failed fetch.
- `setModelCost`: patch body contains only the cost subtree; input/output
  required; invalid ids rejected.
- Report validator; v2 reports ignored; store v3 drops v2 data and sessions;
  per-model actual vs potential never pooled; usd frozen at ingest; cost-only
  window negative.
- sessionID path validation rejects `../x`; oversized/corrupt file → empty.

## 9. Before merge: backtest (required, owner A)

`scripts/optimizer/backtest-trims.mjs` reads opencode's SQLite store
read-only (`message` + `part` tables, via `node:sqlite` — Node ≥ 22.5;
fall back to a clear "unsupported" exit), reconstructs each session's history
request by request (each assistant message = one request; its prompt = all
prior messages and parts), and runs `planRequest` over it with list prices from
Manta's price cache. Window: default 2026-10-17 09:00–13:00 UTC, with sessions
replayed from their start (warm-up) and only requests inside the window
counted. Cache model: a request's prefix up to the previous request's
boundary is a cache read iff the trimmed history up to that point is
identical to the previous request's and the gap since the previous request is
≤ the TTL; everything else is a write.

It prints, per session and in total, three columns at list prices:
**no trimming** / **recorded** (actual ledger cache read/write tokens) /
**sticky trimming (simulated)**, plus growths per session. Sessions with
missing parts are skipped and counted. **Pass criteria (in the PR body):**
simulated total cost < no-trimming total cost, and no session grows more than
**3** times in the window.

## 10. After merge (manual, dev box)

Switch on for one working day, then rerun the §1 ledger query: full-history
re-caches back near baseline (first requests + cache expiries + model
switches); card's net savings positive and consistent with ledger-derived read
savings. Otherwise switch off and revisit `margin` / `batchTokens`.

Rollout: next server release (plugins sync via self-update). Switch stays off
on the dev box until §10.
