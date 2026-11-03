# Seat placement: spend the quota that expires first — design (v3)

Status: v3 — reviewed (Astra, 3 rounds): ready with Should fixes, applied below · 2026-11-03 · branch `limit-usage`

v3 (after review round 2): slack is no longer a priority key (a non-slack
seat expiring sooner must go first — see the counter-example in §2.5); an
unstarted 5h window starts now; window roles are fixed by kind, not
freshness; the 5h-only case runs the legacy policy whole; the request's
model drives the decision exactly as the code does today; `models` falls
back to `scope`; routing filters by the candidate's endpoint key; the
attribution log is per request (not bucketed); `K` is estimated from a new
paired-observation series, never from the legacy history, and never fitted
for model caps; the replay vendors the full pure closure at a pinned commit.

v1 (same file, commit 7da1face) was reviewed and found not ready: its
binding-window formula picked the wrong window, "doomed" headroom was used as
a rescuable benefit, priced cross-org moves and the calibrator were not
implementable from the data the box has, and the replay did not exercise the
real decision functions. v2 narrows the scope to what is implementable now and
measurable in a week, and defers the rest to follow-up specs.

Amends `2026-10-08-multi-account-subscriptions-design.md` §5.3 (automatic
mode rules 1, 3, 4), `2026-10-12-seat-org-affinity.md` (rule tiers),
`2026-10-15-model-scoped-seat-limits.md` (extends the applicability rule to
routing). Pacing (`optimizer/pacing.mjs`) is **untouched** in this spec.

## 0. Goals / non-goals

Goals (v2, this spec)
1. Place and rebalance conversations so that the least **weekly** headroom
   expires unused at a reset, while packing the 5h window where that costs
   nothing.
2. Make "which models draw from this window" a field the usage adapter
   reports, read by every applicability check (seat placement **and** model
   routing), instead of a name-token match in one place.
3. Record, per request, which seat and model served which conversation — the
   attribution the next steps (price-of-a-move, per-model cost, pool pacing)
   need and that the box does not keep today.
4. Measure `K` — how many full 5h windows a weekly window holds — from the
   readings the box already stores, with a safe default until it is trusted.
5. A replay harness that runs the REAL pure decision functions (current and
   proposed) over a committed trace, as the regression guard.

Deferred to follow-up specs (explicitly NOT here): priced cross-org moves
(needs §3 attribution + a demand forecast); per-model quota cost `μ` (Fable
burns the weekly faster) and pool-level pacing; the credits-based Fable of
Pro/standard-Team seats beyond representing it in the contract; manual mode
changes (manual stays "every conversation on the active seat").

## 1. Facts this design rests on

All measured on this box (10 Claude seats = 2 orgs × 5 × `Team · Max 5x`),
from `~/.manta/usage-history.json`, `~/.manta/seat-assignments.json` and the
opencode V2 ledger, 2026-10-08 → 11-03. The replay is
`scripts/seats/replay.mjs` (§8; `node scripts/seats/replay.mjs --policy both --scale 0.6`).

1. **The weekly binds, not the 5h.** One full 5h window costs 12–15 % of a
   weekly (`K` ≈ 6.6–8.1, i.e. ≈ 7.5 of the 33.6 5h windows in a week).
   Weekly readings exist for one seat since Oct 9 and for all seats only since
   Nov 2, so `K` is a thin measurement (hence goal 4).
2. **Demand ≈ 1.8× the weekly pool** (≈ 13,400 vs ≈ 7,500 5h-points/week).
   Any placement rule leaves ≈ ⅓ unserved at that demand; the gains below are
   real when demand is at or under capacity, and small above it.
3. **Weekly headroom expires unused today** (seat 8: 98 % left 12 h before
   reset, ≤ 38 % spendable; seat 2: 96 % left 18 h before). The current
   "highest window %" load rule ranks them like every other seat.
4. **Same-org moves keep the prompt cache** (cache reused on the first request
   after a move in 65 of 90 cases); a cross-org move re-sends the history
   (≈ 890k tokens in the one case checked). The current same-org-first tiers
   and the once-per-5h cross-org cap are kept unchanged.
5. **55 of 73 automatic moves last week were `reset-soon`** — chasing a 5h
   reset while the weekly binds — which spends nothing that would otherwise be
   lost.
6. **Fable** (Anthropic support, 2026-11-03): on Max / Ultra / premium Team
   seats a Fable request draws from the shared 5h, the shared weekly (faster
   per token), and a Fable cap = 50 % of the weekly. On Pro / standard Team
   seats it runs on usage credits, outside the weekly. The seat-level
   applicability rule already exists for placement (Oct 15 spec);
   `marginalCost` in routing still treats ANY live window at 100 % as the
   endpoint exhausted (`src/shared/marginalCost.mjs:169`), so a full Fable cap
   excludes Opus from routing today.

## 2. The model

### 2.1 Terms

- **Applicable windows** of seat `s` for model `m`: `W(s,m)` = the seat's
  windows that are active (`active !== false`), fresh (`stale !== true`), and
  apply to `m` (`windowAppliesToModel`, §5.1). `m = null` (unknown) ⇒ only
  unscoped windows, as today.
- **Roles are fixed by `kind`, independent of freshness or activity**: the
  **short window** is the seat's `session` window (5 h), whether or not it is
  stale, started or reported; the **long windows** are its `weekly` and
  `weekly_scoped:*` windows. A seat's long windows for model `m` =
  `long(W(s,m))` (applicable ones only). Span: the reported `resetsAt − startedAt`
  when both are present and plausible (1 h … 31 d); else the provider's
  documented default for the kind (`session` = 5 h, `weekly*` = 7 d for
  claude / codex / kimi — a table in `seatChoice.mjs`); else **unknown**, and
  every slack computation that needs it is `null`.
- `K_w` — full short windows per long window `w`. Per provider and window
  kind, from the calibration store (§6); defaults: `weekly` 7.5 (Claude),
  model caps `0.5 · K_weekly` (a 50 % sub-cap, with no per-model multiplier
  until a later spec measures one), providers with no weekly: none.

### 2.2 Eligibility — can seat `s` serve model `m` right now?

```
eligible(s, m) ⇔ s.usable                                   (signed in, readable creds)
               ∧ ¬limited(s)                                 (no fresh 429 mark)
               ∧ ¬s.exhausted                                (adapter flag)
               ∧ ∀ w ∈ W(s,m): pct(w) < 100
```

and, for a seat to be a **target** (new placement or move), additionally the
short window has room: `pct(short) < MOVE_AT_PCT` (95). A seat with no
reading at all is eligible with unknown load and ranks after every seat with
a reading (unchanged from `seatChoice.rank`).

### 2.3 Slack — headroom that cannot be spent before it resets

For a long window `w` on seat `s` at time `t`, with `w` resetting at `R`.
The short window's state is one of:

- **running**: fresh reading, `resetsAt = r > t` → room now `100 − pct(short)`,
  next fresh window at `r`;
- **not started**: fresh reading, no `resetsAt` (Anthropic reports no reset
  for an idle 5h window) → room now `100`, and the window that a request
  would open now resets at `r = t + span(short)`;
- **unknown**: no reading, or stale (`resetsAt ≤ t` and not yet re-read) →
  slack is **unknown** (`null`).

```
n(w)        = max(0, ⌈(R − r) / span(short)⌉)        // fresh short windows that fit after r, before R
capPts(w)   = roomNow(short) + 100 · n(w)             // 5h-points spendable before R, upper bound
roomPts(w)  = (100 − pct(w)) · K_w                     // 5h-points w still holds
slackPts(w) = roomPts(w) − capPts(w)                   // > 0 ⇒ some of w's room is unreachable
```

`capPts` is an **upper bound** (instantaneous consumption, no demand
limit). `slackPts` is `null` — "unknown, treated as not slack" — when the
short window is unknown, `K_w` is `null`, `R` is unknown, or `w` is stale.
Check on the double-count case: not started, `R = t + 1 h` → `r = t + 5 h`,
`n = 0`, `capPts = 100` (not 200). `seatSlackPts(s,m) = max over
long(W(s,m))` of the known `slackPts`, else `null`.

Worked examples (today's readings, `K` = 7.5): seat 1 weekly 100 % left,
`R` in 48 h, `r` in 40 min → `n` = 10, `capPts` = 97 + 1000 = 1097, `roomPts`
= 750 → not slack. Seat 8 weekly 98 % left, `R` in 12 h → `n` = 3, `capPts`
≈ 384, `roomPts` = 735 → **slack ≈ 350** 5h-points (47 % of its week) are
unreachable by any policy. Slack is reported (seat view, activity log) and
used as a tie-break (§2.4); it is NOT a priority over an earlier deadline.

### 2.4 Deadline and rank

```
deadline(s,m) = min resetsAt over fresh long(W(s,m)) with a known resetsAt   // null if none
rank(s,m)     = ( deadline(s,m) ?? +Infinity,          // earliest weekly reset first (known before unknown)
                  −max(0, seatSlackPts(s,m) ?? 0),     // among equal deadlines, the seat losing more (unknown = 0)
                  loadRank(s,m),                       // seatChoice.rank: known load < no reading < exhausted
                  s.seatId === activeSeatId ? 0 : 1 )
```

lexicographic. Deadline ties are NOT pairwise: `bestSeatByRank` takes the
earliest known deadline `d0` and treats every seat with `deadline ≤ d0 +
RESET_TIE_MS` as the tie group (the anchoring `soonestResettingSeat` already
uses), then orders the group by the remaining keys — a transitive order. **Legacy
mode**: when, for the provider and model, no seat has a fresh long window
with a known `resetsAt` (a 5h-only provider; every weekly inactive or
unknown), the WHOLE legacy policy runs — `chooseSeat`'s escape-route tiers,
`decideMove`'s tiers and `resetSoonMove` — byte-for-byte (`legacyMode(snaps,
model)` is one pure predicate evaluated per decision; the legacy functions
are kept, not re-derived). So 5h-only behaviour is unchanged by
construction, and the existing tests for it keep running against the same
code.

### 2.5 Why this order (and what is NOT claimed)

Weekly headroom is perishable stock with a known expiry; serving from the
stock that expires first is the FIFO/EDF issuing policy of perishable
inventory (Pierskalla & Roach 1972). That result holds for one pool with
exogenous demand and free transfer. Our problem has staggered replenishment,
org-restricted transfer with a cost, per-model eligibility and a 5h side
constraint, so **no optimality is claimed** and no "cannot hurt" property
either: the rule is a heuristic whose value is established by the replay
(§8). The counter-example that killed v2's slack-first key: seat A has 300
points of weekly room but can only spend 200 before its reset in 6 h (slack
100); seat B has 50 points expiring in 1 h. Demand: 50 now, 100 at hour 2,
100 after hour 5. Serving A first loses B's 50 (serves 200); serving B first
serves 250. Earliest deadline gets this right; the v2 rule did not. The
replay includes this case as a scripted scenario.

## 3. Rules (automatic mode) — the decision table

A conversation is its ROOT session; sub-agents inherit the root's seat and
decide with their own model but never change the stored root model
(unchanged, `place()` in `seatAssignment.mjs`). Every decision below runs
inside the existing mutex, once per request, with `m` = the request's model
(or the stored root model for a server-side re-decision).

Target predicates (seat `x ≠ s`, model `m`):
- `softTarget(x)`: `eligible(x,m)` ∧ short window known ∧ `pct(short) < 95`.
- `hardTarget(x)`: `eligible(x,m)` (short window may be unknown or up to 99).
- `blocked(x)`: `left[x]` within `MOVE_BACK_BLOCK_MS`.
- `crossOK`: the cross-org cap allows an other-org move (unchanged rule:
  soft moves only, `crossOrgMovedAt` older than `CROSS_ORG_CAP_MS`).
- `best(pool)`: `argmin rank` over `pool`; the tier ordering of today's
  `decideMove` is kept and only the within-tier order changes from
  least-loaded to `rank`.

Rows are evaluated top to bottom; the first whose condition holds decides.

| # | Condition | Decision |
|---|---|---|
| R0 | `legacyMode` (§2.4) | the unchanged legacy `chooseSeat` / `decideMove` / `resetSoonMove`. |
| R1 | no assignment, or `s` no longer exists | `best(softTarget ∧ ¬blocked)` → `best(softTarget)` → `best(hardTarget)` → least-loaded usable seat → none (`live: true`). The escape-route tier of the org-affinity spec is dropped outside legacy mode (deadline order makes the same-org sibling the natural escape; a test keeps the "Org A {10,90}, Org B {30,30}" case and documents its new answer). |
| R2 | `¬s.usable` (dead) | tiers with `¬blocked` applied to EVERY tier: `best(same org ∧ hardTarget)` → `best(other org ∧ hardTarget ∧ load<70)` → `best(other org ∧ hardTarget)`; nothing → the same three tiers again over `blocked` seats; nothing → least-loaded usable seat over ALL others, full or not (today's fallback). Reason `unusable`. |
| R3 | `¬eligible(s,m)` (a window of `W(s,m)` at 100, `limited`, or `exhausted`) | same tiers as R2 without the final fallback; reason `exhausted`. None → **stay** (the retry watch re-decides, as today). |
| R4 | `pct(short) ≥ 95` (soft pressure) | `best(same org ∧ softTarget ∧ ¬blocked)` → if `crossOK`, `best(other org ∧ softTarget ∧ load<70 ∧ ¬blocked)` → **stay** (finish the window). Reason `load`. |
| R5 | ∃ same-org `x` with `softTarget(x) ∧ ¬blocked(x) ∧ betterByMargin(x, s)` and `t − lastAutoMoveAt(conv) ≥ MIN_DWELL_MS` | **Rebalance** to `best` of them (reason `rebalance`, same org only, free). |
| R6 | otherwise | **Stay**. |

`betterByMargin(x, s)`: `deadline(x)` is finite and (`deadline(s)` is null
or `deadline(x) ≤ deadline(s) − SAME_ORG_REBALANCE_MS`). Two unknown
deadlines never rebalance; a known one beats an unknown one only when the
target's is known. Slack is not part of the margin test.

Every move (R2–R5) records `left[s] = t` and `lastAutoMoveAt = t`
(`movedAt`, already stored). `MIN_DWELL_MS` bounds **optional** moves only
(R5): a forced move (R2–R4) may follow a rebalance within the dwell, and a
forced move may return to a recently-left seat as a last resort — both are
today's behaviour. What is guaranteed: R5 fires at most once per
`MIN_DWELL_MS` per conversation, never toward a seat left within
`MOVE_BACK_BLOCK_MS`, and only toward a strictly earlier known deadline — so
two seats cannot trade a conversation back and forth under R5 (the second
move would need the first seat's deadline to be earlier by the margin, the
opposite of what let the first move happen, until a reset — and then the
dwell and the block apply). `lastAutoMoveAt` for a conversation that has
never moved is its `assignedAt`.

**Which model decides (unchanged from the code):** `place()` decides with
the REQUEST's model (`requestModel ?? existing.model`), for a root and a
sub-agent alike, and stores only a root request's model. So a sub-agent on a
capped model whose cap is full on the seat moves the whole conversation
(R3) — exactly what happens today, and the right call: the alternative is a
sub-agent retrying forever on a seat another seat could serve. v2's R9 is
withdrawn.

Invariants preserved (each is an existing test that must stay green): manual
mode identical; `model = null` ignores scoped windows; a dead seat always
releases its conversation; two concurrent first requests of one conversation
land on one seat; a soft move never targets a seat at ≥ 95; cross-org cap
and 5h move-back block unchanged; legacy mode byte-identical.

Announcements: every automatic move is recorded `{movedFrom, movedAt, reason,
trigger, crossOrg}` and passed to `onMoved`. `rebalance` is **silent** in the
chat (the role `reset-soon` had) and logged in the optimizer activity log with
`evidence: {reason, deadlineFrom, deadlineTo, slackFrom, slackTo}`.

## 4. Routing applicability (closes the Oct 15 gap)

One shared pure helper, `applicableLiveWindows(account, candidate)` in
`src/shared/marginalCost.mjs`: `account.windows` filtered to `stale !== true`
∧ `active !== false` ∧ `windowAppliesToModel(w, candidateModelId)`, where
the model id is the candidate's `modelID ?? id` — the same field
`endpointKey` reads (`src/shared/endpointKey.mjs`), never a guess. Three
call sites use it and nothing else: the exhaustion test in `marginalCost`
(`pct >= 100` over the applicable set), the pace-curve / pacing pricing in
the subscription branch (the same set), and the `resetsAt` in
`modelRouter.mjs` line ~174 ("usable again at" = max `resetsAt` over the
applicable full windows — one filter, so exhaustion and recovery time can
never disagree). `quotaScarcity` keeps reading every live window (it is a
tier hint, not an exclusion) — noted as a Nit for the follow-up. Pacing's
`pressureFor` is unchanged (deferred). Tests use real candidate objects
(`{providerID, modelID}` as `listModels` returns them).

## 5. Contract

### 5.1 `UsageWindow.models` (`src/shared/types.ts`, `usageAdapters/normalizeWindow.mjs`)

```ts
models?: string[]   // model-name tokens this window applies to (lowercase,
                    // alphanumeric — the same token form windowAppliesToModel
                    // matches against the model id). Absent ⇒ all models.
```

- `normalizeWindow`: when `raw.models` is a non-empty string array, keep the
  normalised tokens; else when `raw.scope` is set, `models = [normalize(scope)]`;
  else absent. `scope` and `kind: "weekly_scoped:<name>"` are kept as they are
  for every existing consumer (UI labels, history keys).
- `windowAppliesToModel(w, model)` precedence: (1) a non-empty `models`
  array whose normalised tokens are non-empty; (2) else the legacy `scope` /
  `weekly_scoped:<name>` token (today's rule, kept verbatim — so an older
  server's snapshot, a fixture, or a renderer cache without `models` keeps
  its cap scoped and never applies it to Opus or to an unknown model); (3)
  else "all models". With `model` null, any scoped window (by (1) or (2))
  does not apply. A `models` array that normalises to no tokens is treated as
  absent (falls to (2)). Byte-identical results for every window the Claude
  adapter emits today.
- The Claude adapter sets `models` from `scope.model.display_name`; Codex and
  Kimi set nothing. No `subCapOf` / `fraction` / credits representation in v2
  — the 50 % relation is a calibration default (§2.1), not a contract field,
  until the per-model cost spec needs it.

### 5.2 `src/shared/seatChoice.mjs` (pure; shared with the renderer)

```ts
export function windowSpanMs(w): number                                  // by kind; 5h / 7d
export function shortWindowState(snap, {nowMs}): {state:"running"|"not-started"|"unknown", roomNow:number|null, nextResetAt:number|null}
export function longWindows(snap, {model}): w[]                          // applicable, by kind
export function windowSlackPts(snap, w, {nowMs, K}): number | null       // null = unknown
export function seatSlackPts(snap, {nowMs, model, kFor}): number | null
export function seatDeadlineAt(snap, {nowMs, model}): number | null
export function legacyMode(snaps, {nowMs, model}): boolean
export function seatRank(snap, {nowMs, model, kFor, activeSeatId}): [number, number, number, 0|1]
export function bestSeatByRank(snaps, {nowMs, model, kFor, activeSeatId, tieMs}): snap | null
```

`kFor(kind) → number | null` is a **provider-bound** reader: the server
builds it per provider from the calibration store
(`calibration.readerFor(provider)`), the renderer from the
`usage:calibration` RPC. `nowMs` is always the caller's clock, threaded (no
`Date.now()` in shared code). `leastLoadedSeat`, `seatLoad`,
`isSeatExhausted`, `nextResetAt`, `soonestResettingSeat`, `aggregateSnapshot`
are unchanged. `nextSeatFor({…, nowMs, kFor})` and `moveTargetFor({…, nowMs,
kFor})` in `accountsViews.mjs` gain both arguments (today `nextSeatFor` passes
no clock, which is why reset-soon never showed in the hint); `buildProviderView`
threads them. The move hint stays labelled hypothetical in the UI copy ("would
move to") — it evaluates a conversation with no move history.

### 5.3 `src/server/seatAssignment.mjs`

- Two exported dispatchers are the ONLY entry points anyone calls:
  `placementFor(args)` (R0 → legacy `chooseSeat`, else `chooseSeatByDeadline`)
  and `moveFor(args)` (R0 → legacy `decideMove`, else `decideMoveByDeadline`).
  `decideSeat` uses them; `nextSeatFor` / `moveTargetFor` in
  `accountsViews.mjs` call the SAME two, so a hint can never run the legacy
  chooser while the resolver runs the new one. `chooseSeat` / `decideMove` /
  `resetSoonMove` stay exported for their tests but have no other caller.
- Constants kept: `MOVE_AT_PCT`, `MOVE_TARGET_BELOW_PCT` (the "< 70" tier),
  `MOVE_BACK_BLOCK_MS`, `CROSS_ORG_CAP_MS`, `RESET_SOON_MS`,
  `LIMITED_MARK_MS`. Added: `SAME_ORG_REBALANCE_MS = 6 h`,
  `MIN_DWELL_MS = 60 min`.
- `createSeatAssigner` gains `kFor(provider) → (kind) → number|null`
  (default: the calibration store) and `attribution` (§5.5 writer, default:
  the jsonl appender). Both optional; absent `kFor` ⇒ `null` for every kind
  ⇒ slack unknown everywhere; deadlines still order.
- `describeSeatMove`: `rebalance` → "Moved a conversation from X to Y (Y's
  weekly resets sooner — spending that first)"; slack case → "(X's weekly
  will not be used up before it resets)". `seatMoveActivityEntry` adds the
  evidence fields of §3.

### 5.4 Calibration store — `~/.manta/usage-calibration.json`

```json
{ "version": 1,
  "providers": { "claude": {
      "kByKind": { "weekly": { "value": 7.4, "samples": 212, "seats": 9, "updatedAt": 1793700000000 } },
      "defaults": { "weekly": 7.5 } } } }
```

Written by §6 through `jsonStore.writeJsonAtomic` (statePath), read lazily
with a 60 s memo. `kFor(provider, kind)`: a measured value when its guards
pass, else the default, else `null`. Model-cap kinds (`weekly_scoped:*`)
resolve to `0.5 · kFor("weekly")` unless measured.

### 5.5 Attribution log — `~/.manta/seat-attribution/<provider>.jsonl`

Written from `resolve()` — every path, including the single-seat fast path
and the no-seat path — one line per request whose `(sessionID, seatId,
model)` differs from the LAST line written for that `sessionID`, plus one
heartbeat line per `(sessionID)` per 10 minutes while unchanged. That keeps
an A→B→A within a bucket, records the child session itself (`session`) and
its root, and bounds a busy conversation to ≈ 6 lines/h. `reconsider()`
writes a line with `reason: "reconsider"` only when it moved.

```json
{"t":1793700000000,"session":"ses_child","root":"ses_root","seat":"seat-8","model":"claude-opus-5-5","reason":"kept"}
```

`seat` is `null` on the no-seat path; `reason` ∈ `assigned | kept |
moved:<why> | single | none | reconsider | gap`. When the bounded queue
drops lines, the writer resets its per-session dedupe state and the next
line written is `{"t", "reason":"gap", "dropped": n}` so a reader can tell a
dropped transition from a long unchanged interval; readers must treat the
interval before a `gap` as unattributed. **Fail-open**: the writer is
called after the decision is returned to the caller's promise chain
(`queueMicrotask`), swallows every error (one `console.warn` per minute),
and keeps an in-memory queue bounded at 1,000 lines — overflow drops the
oldest and increments a counter exposed on `usage:calibration`. Append and
rotation are serialised through the existing `createMutex`; rotation at 8 MB
keeps 4 files (`<provider>.jsonl`, `.1` … `.3`), 0600. A torn last line is
skipped by readers. Never contains content, only ids and the model. A test
proves that a throwing writer never rejects `resolve()`. This is coarse but
request-accurate placement telemetry; the follow-up specs read it.

### 5.6 RPC

- `usage:calibration` → `{providers: {<id>: {kByKind, defaults}}}` (read).
- `accounts:seat-view` (existing provider view) gains per seat
  `{slack: boolean, deadlineAt: number|null}` so the seat list can show why
  a seat is preferred; the renderer's `nextSeatFor` hint already follows
  the shared functions.

## 6. Measuring `K` (`src/server/usageCalibration.mjs`)

Identifiable from readings alone — no tokens, no attribution needed — but
NOT from `usage-history.json`: that store keeps `{ts, pct}` only, at ≥ 15-min
spacing, with no `resetsAt` / `stale`, so its intervals cannot be validated.
`K` therefore gets its own series:

- **Paired observations** `~/.manta/usage-calibration-samples.json`
  (`{version:1, seats: {"<provider>:<seatId>": [{t, short:{pct,resetsAt,stale}, long:{kind,pct,resetsAt,stale}[]}]}}`),
  appended from a new `onPolled(seatSnapshots)` hook in `createUsagePoller`
  that fires after EVERY successful tick (the existing `observe` hook fires
  only when the content key changes, so it cannot give a cadence), carrying
  each seat's real `fetchedAt`; a carried-forward reading (same object as
  last tick, i.e. a failed fetch) is skipped. Pruned to 14 days,
  debounced-saved like the history.
- For each seat and the **`weekly` kind only** (model caps are never fitted —
  Opus traffic moves the short window without moving a Fable cap, so the
  ratio is not identifiable from mixed traffic; `weekly_scoped:*` keeps
  `0.5 · K_weekly`): walk consecutive observations; an interval qualifies
  when both windows are fresh at both ends, both `resetsAt` are unchanged
  across it (no reset crossed), both deltas are ≥ 0 (a negative delta is a
  missed reset or a provider correction: reject and break the run), and the
  interval is ≤ 20 min. Qualifying intervals that are contiguous form a
  **run**; a run's `ΣΔshort` and `ΣΔlong` are accumulated together (a
  zero-`Δlong` interval stays in its run — with rounded percentages the
  weekly often lags the 5h by several intervals, and dropping those would
  bias `K` low). A run contributes to the seat's sums only when its
  `ΣΔlong ≥ 1`.
- `K_seat = ΣΔshort / ΣΔlong`; provider `K = median over seats`.
- Guards: `ΣΔlong ≥ 20` points per seat, ≥ 3 seats, and
  `(p90 − p10) / median ≤ 0.2` across seats; otherwise the default, and the
  dashboard shows the spread. A measured value is also discarded (default
  restored) when fewer than 3 seats remain in the 14-day window.
- Bias: with Fable in the mix `Δlong` grows faster per 5h-point than under
  Opus alone, so the measured `K` is **lower** than the Opus-only `K`. A
  lower `K` shrinks `roomPts`, which only ever makes a seat read as LESS
  slack; since slack is a tie-break and never a priority (§2.4), a biased `K`
  cannot change which seat has the earliest deadline. That is the whole
  reason v3 demotes slack: the one measured constant can be wrong by a
  bounded, known direction without changing a placement. Reading lag (a
  reading up to 10 min old) shifts both deltas alike and cancels in the
  ratio over ≥ 20 points.
- Runs from the sampler, debounced to once per hour, and on boot; pure
  `estimateK(samples, {nowMs})` tested with synthetic series (including
  quantised low-rate usage where the weekly increments every third
  interval).

Validation (part of acceptance, manual, documented in the PR): a 30-minute
single-model run on one seat for Opus, reading the three windows before and
after, matches the estimate within ±25 %. Until the series has 14 days the
default 7.5 is used — nothing in the placement depends on `K` being
measured.

## 7. Tunables

| Name | Default | Why |
|---|---|---|
| `MOVE_AT_PCT` | 95 | unchanged — pack the 5h |
| `SAME_ORG_REBALANCE_MS` | 6 h | rebalance only for a materially earlier weekly reset |
| `MIN_DWELL_MS` | 60 min | at most one OPTIONAL (R5) move per conversation per hour |
| `MOVE_BACK_BLOCK_MS` | 5 h | unchanged |
| `CROSS_ORG_CAP_MS` | 5 h | unchanged |
| `RESET_TIE_MS` | 60 s | unchanged |
| `K` defaults | weekly 7.5; model caps 0.5·K | until measured (§6) |

## 8. Replay harness — `scripts/seats/replay.mjs`

`scripts/seats/replay.mjs` (it replaced the draft). Two policies, both the REAL pure code:

- **before**: `src/server/seatAssignment.mjs` and `src/shared/seatChoice.mjs`
  from the pinned pre-change commit (`f95bfe2b`, recorded in
  `scripts/seats/baseline/PINNED.md`) into `scripts/seats/baseline/`:
  `seatChoice.mjs` verbatim; `seatAssignment.mjs` with the service half
  (`createSeatAssigner` and its `jsonStore` / `paths` / `accounts` imports)
  removed and `ACCOUNT_PROVIDERS = ["claude","codex"]` inlined — the pure
  functions above `// The service` are the closure of `decideSeat`. A test
  diffs the vendored pure section against `git show f95bfe2b:…` to prove it
  is unmodified. `decideSeat` is
  pure; the harness reproduces `place()`'s record updates (`left`,
  `crossOrgMovedAt`, `movedAt`, `model`) in ~30 lines, shared by both
  policies, with the two policy-specific fields (`lastAutoMoveAt`) handled
  by the policy adapter.
- **after**: the live modules.

Workload: a committed anonymised trace (`src/server/fixtures/seat-demand-trace.json`:
3 weeks, 10 seats, per-10-min demand in 5h-points, real weekly reset
phases). Conversations arrive by Poisson (seeded mulberry32, 5 fixed seeds),
each with a duration and a share of the bin's demand drawn once per seed,
so every policy sees the **identical offered work** per seed. Window
readings are produced from the simulated seat state by a simulated poller
(10-min cadence, 0 or 10 min lag), so `stale` / `active` / not-started are
exercised. Initial state: seats empty, weekly resets at the trace's phases;
the first 7 days are warm-up and excluded from every metric; at the end,
unexpired headroom is NOT counted as waste. Metrics per policy and seed:
served %, weekly points expired unused per seat-week, moves by reason and
org crossing, re-sent tokens; reported as mean ± sd over seeds.

Acceptance (`src/server/seatReplayAcceptance.test.mjs` — `scripts/` is outside the test globs; seeds fixed): at demand scales
0.4, 0.6, 0.8, 1.0 the new rule's mean served share ≥ the old rule's − 0.5
pt, and at 0.4 and 0.6 its mean expired headroom ≤ 60 % of the old rule's,
with the sd of the difference reported; the §2.5 counter-example runs as a
scripted scenario and must serve 250. Sensitivity rows (printed, not gated):
stream count 2/6/12, `K` 6/7.5/9, lag 0/10 min, 20 % of traffic Fable.

Simplifications in the script header: observed usage is a lower bound on
offered demand; transfers are instantaneous; the trace's reset phases are
this box's. The numbers are produced by the harness, not quoted here — run
`node scripts/seats/replay.mjs --policy both --scale <s>` (`--sensitivity` for
the sensitivity rows, `--no-retry` for the model without the retry below); the
measured table is under "Measured (implementation)".

### Measured (implementation)

`node scripts/seats/replay.mjs --policy both --scale <s>`, 5 seeds, 6 streams,
lag 0, K 7.5 (policy told 7.5), 7-day warm-up excluded; mean ± sd over seeds,
the last column the paired per-seed difference `after − baseline`. Offered
demand is 72 / 107 / 143 / 179 % of weekly capacity at scales 0.4 / 0.6 / 0.8 / 1.0.

Harness semantics that matter for reading it: a request that fills its seat is
re-decided once on fresh readings (the live `reconsider` after a limit error),
for both policies. Without that, a request overflowing a 5h window is lost, which
charges the policy that packs the 5h window for a loss the live system does not
have (no-retry, scale 0.4 / 0.6: served −0.7 / −1.5 pt; `--no-retry` reproduces it).

| scale | served % baseline → after (Δ) | expired weekly, % per seat-wk (Δ) | moves (rebalance) | cross-org moves | re-sent Mtok |
|---|---|---|---|---|---|
| 0.4 | 100.0 → 100.0 (−0.0 ± 0.0) | 33.7 → 30.8 (−2.8 ± 1.0; 92 % of baseline) | 616 → 312 (78) | 0 → 0 | 0.0 → 0.1 |
| 0.6 | 99.4 → 99.9 (+0.5 ± 0.4) | 3.1 → 0.1 (−3.1 ± 0.5; 2 % of baseline) | 461 → 490 (68) | 80 → 6 | 26.9 → 1.8 |
| 0.8 | 74.4 → 78.6 (+4.1 ± 0.4) | 0.0 → 0.1 | 554 → 707 (41) | 229 → 351 | 81.2 → 125.3 |
| 1.0 | 60.1 → 59.9 (−0.2 ± 0.3) | 0.0 → 0.0 | 639 → 704 (39) | 368 → 424 | 130.5 → 151.1 |

Reading: the served gate holds at every scale; the §2.5 counter-example serves
250 under `after` (200 under the baseline). The 60 % expiry gate holds at 0.6
(2 %) and **does not hold at 0.4 (92 %)**: at 0.4 the offered work is 72 % of
capacity, so at least ≈ 28 % of the weekly headroom must expire under any policy
and the baseline is already within ≈ 5 pt of that floor — 60 % of the baseline
(20 %) is below the floor. Above capacity (0.8, 1.0) the rule serves more at 0.8
(+4 pt) and the same at 1.0, at the price of more cross-org moves (+123 / +56
per run) and more re-sent history (+44 / +21 Mtok), because it concentrates load
on the seat that expires first and moves more often through `exhausted`.

## 9. Libraries considered

| Need | Chosen | Considered / why rejected |
|---|---|---|
| Ranking, slack arithmetic | own code in `seatChoice.mjs` (~120 lines pure) | nothing models quota windows; a lexicographic sort by a tuple |
| `K` estimate | own code (`estimateK`, a ratio of sums with interval filters, ~60 lines) | `simple-statistics` 8.0.0 (ISC, 0 deps, 1.46M/wk, 2026-10-28) would give `linearRegression`; a through-origin ratio of filtered sums is the estimator wanted here (no intercept, interval weighting by Δ) and the filters are the work, not the fit. Revisit when `μ`/`τ` (multivariate) arrive in the follow-up spec. |
| Attribution log rotation | own appender (~60 lines incl. the bounded queue) | `rotating-file-stream` 3.2.10 (MIT, 0 deps, 414k/wk, 2026-08-13): a stream abstraction for one `appendFile` + rename is more surface than the need; `pino` rotation needs the pino pipeline. |
| Persistence | existing `jsonStore.mjs` | unchanged |
| Replay | own script | mirrors `scripts/optimizer/backtest-trims.mjs` |
| Poisson arrivals / sampling in the replay | own 15 lines (inverse-CDF with a seeded PRNG) | `seedrandom` 3.0.5 (MIT, 0 deps, 13.3M/wk, last publish 2019-09) for the PRNG — stable but a dependency for a dev script; a 10-line mulberry32 is standard. |

## 10. Tests

- `seatChoice.test.ts`: `shortWindowState` (running / not-started /
  unknown / stale); `windowSlackPts` — seat 8 case (≈ 350), seat 1 (not
  slack), not-started with `R` in 1 h → `capPts` 100, `R` unknown → null,
  `K` null → null, stale long window → null, inactive excluded, Fable cap in
  `W` for Fable only, a stale SHORT window does not change which window is
  long; `seatRank` ordering (earlier deadline beats more slack; equal
  deadlines → more slack; → load; active-seat tie; unknown deadline last);
  `legacyMode` true for 5h-only and for all-inactive weeklies; `Infinity`
  deadlines never satisfy `betterByMargin`.
- `seatAssignment.test.mjs`: R1 picks seat 8 for Opus and for Fable; with
  seat 8's Fable cap at 100, Fable picks seat 2 and Opus still seat 8; R5
  rebalances for a 7 h earlier deadline, not for 5 h, never between two
  unknown deadlines; `MIN_DWELL_MS` blocks a second R5 but not an R3; a
  forced move may return to a blocked seat as last resort; R0: every existing
  `chooseSeat` / `decideMove` / `resetSoonMove` test runs unchanged (their
  fixtures have no weekly `resetsAt`, so they are legacy mode) and is
  duplicated with a weekly window added to assert the new answer; the
  org-affinity "{10,90} vs {30,30}" case documented under both modes;
  manual-mode suite unchanged; the sub-agent-on-capped-model case moves the
  root (today's behaviour, now asserted).
- `marginalCost.test`, `modelRouter.test`: a full Fable cap does not
  exhaust an Opus endpoint; does exhaust a Fable endpoint; unknown model ⇒
  scoped windows ignored.
- `normalizeWindow.test`, `claude.test`: `models` derived from `scope`;
  explicit `models` wins; Codex/Kimi unchanged.
- `usageCalibration.test.mjs`: synthetic paired series with known `K`
  recovered within 3 %; reset-crossing, stale, negative-delta intervals
  rejected; dispersion guard; model caps never fitted; legacy history
  ignored.
- `seatAttribution.test.mjs`: a line per change + heartbeat; A→B→A within
  10 min yields three lines; child session recorded; single-seat and no-seat
  paths recorded; throwing writer never rejects `resolve()`; queue bound;
  rotation serialised; torn-line read.
- `src/server/seatReplayAcceptance.test.mjs`: §8 acceptance (plus `seatReplayHarness.test.mjs`: trace, workload, vendored baseline).

## 11. Rollout

1. Contract (`models`), routing applicability (§4), attribution log,
   calibration store + `K` estimator + RPC. No placement change — `kFor` is
   wired but `decideMove`/`chooseSeat` still run the old rules. Ships first;
   after ≥ 3 days check that the attribution log and the paired-observation
   series are filling (collection validation). The measured `K` itself needs
   the 14-day series and is accepted later; the default serves until then.
2. Placement rules R0–R6 + replay harness, in automatic mode (already the
   opt-in). The activity log carries every decision's evidence; the seat
   view shows slack/deadline per seat.
3. (Follow-up specs) priced cross-org moves; per-model cost `μ`; pool pacing.

Each step is one PR and independently revertible. Rollback of step 2 is a
revert — the attribution log and calibration store are additive.

## 12. Open questions

- Does `K` differ between the two orgs or across plan tiers? §6 reports it
  per seat; the dashboard should show the spread, and a > 20 % spread is the
  trigger for per-seat `K`.
- Should `rebalance` be announced in the chat? v2 says no (it is a routine
  optimisation, as `reset-soon` was); the activity log has it.
- Is the 5h window weighted per model like the weekly (support only said
  "same bucket")? Only matters for the follow-up `μ` spec.
