# Seat placement: spend the quota that expires first — design (v2)

Status: DRAFT v2 for review · 2026-11-03 · branch `limit-usage`

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
`scripts/seats/replay-draft.mjs` (draft; §8 replaces it).

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
- **Short window**: the applicable window with the shortest span (the 5h).
  **Long windows**: every other applicable window (the weekly; a model cap).
  Span = `resetsAt − startedAt` when both are reported, else inferred from
  `kind` (`session` = 5 h, `weekly*` = 7 d); a window with neither is treated
  as long with unknown span and never slack (§2.3).
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

For a long window `w` on seat `s`, at time `t`, with the short window
resetting at `r` (`r = t` if the short window has not started, i.e. no
`resetsAt`; `r = resetsAt(short)` otherwise) and `w` resetting at `R`:

```
n(w)        = number of fresh short windows that fit before R
            = max(0, ⌈(R − r) / span(short)⌉)
capPts(w)   = (100 − pct(short)) + 100 · n(w)      // 5h-points spendable before R, upper bound
roomPts(w)  = (100 − pct(w)) · K_w                  // 5h-points the window still holds
slack(w)    = roomPts(w) > capPts(w)                 // some of w's room is unreachable
```

`capPts` is an **upper bound** on what the seat can accept before `R`
(instantaneous consumption, no demand limit). A window with unknown `K_w`,
unknown `R`, or unknown span is **never slack** (conservative: it is treated
as a normal perishable window). `seatSlack(s,m) = ∃ w ∈ long(W(s,m)): slack(w)`.

Worked examples (today's readings, `K` = 7.5): seat 1 weekly 100 % left,
`R` in 48 h, `r` in 40 min → `n` = 10, `capPts` = 97 + 1000 = 1097, `roomPts`
= 750 → not slack. Seat 8 weekly 98 % left, `R` in 12 h → `n` = 3, `capPts`
≈ 384, `roomPts` = 735 → **slack**: ≈ 350 5h-points (47 % of its week) are
unreachable by any policy; what we CAN do is make sure the reachable 384 are
used, which is why slack seats go first.

### 2.4 Deadline and rank

```
deadline(s,m) = min resetsAt over long(W(s,m))     // Infinity if none
rank(s,m)     = ( seatSlack(s,m) ? 0 : 1,          // slack seats first
                  deadline(s,m),                   // then earliest weekly reset
                  load(s,m),                       // then least loaded (today's seatLoad)
                  s.seatId === activeSeatId ? 0 : 1 )
```

lexicographic, `deadline` compared with `RESET_TIE_MS` (60 s) tolerance.
With no long windows at all (a 5h-only provider, or every long window
inactive/unknown) the first two keys are constant and rank reduces to today's
least-loaded order — the 5h-only behaviour is unchanged, including the old
"reset-soon" preference, which §3 R5 keeps for that case only.

### 2.5 Why this order (and what is NOT claimed)

Weekly headroom is perishable stock with a known expiry; serving from the
stock that expires first is the FIFO/EDF issuing policy of perishable
inventory (Pierskalla & Roach 1972). That result holds for one pool with
exogenous demand and free transfer. Our problem has staggered replenishment,
org-restricted transfer with a cost, per-model eligibility and a 5h side
constraint, so **no optimality is claimed**; the rule is a heuristic whose
value is established by the replay (§8), which must show it never serves less
than today's rule on the committed trace and wastes less weekly headroom when
demand is at or under capacity. The one exact statement: a seat's slack
headroom is unreachable by any policy, so serving a slack seat first never
costs another seat anything it could have used.

## 3. Rules (automatic mode) — the decision table

A conversation is its ROOT session; sub-agents inherit the root's seat and
decide with their own model but never change the stored root model
(unchanged, `place()` in `seatAssignment.mjs`). Every decision below runs
inside the existing mutex, once per request, with `m` = the request's model
(or the stored root model for a server-side re-decision).

| # | State of the conversation's seat `s` | Decision |
|---|---|---|
| R1 | **No assignment** | `target = argmin rank` over eligible target seats. None eligible → the least-loaded usable seat (today's fallback). None usable → no seat (`live: true`, today). |
| R2 | `eligible(s,m)` and `pct(short) < 95` | **Stay**, unless a same-org rebalance applies (R3). |
| R3 | as R2, and ∃ same-org `s'`, eligible target, `s'` not left within `MOVE_BACK_BLOCK_MS`, with `rankBetterByMargin(s', s)` and `t − lastMovedAt(conv) ≥ MIN_DWELL_MS` | **Rebalance** to the best such `s'` (reason `rebalance`, free, same org only). |
| R4 | `eligible(s,m)` and `pct(short) ≥ 95` (soft pressure) | Same-org eligible target with `pct(short) < 95`, best rank → move (reason `load`); else other-org eligible target with `load < 70` if the cross-org cap allows → move (`load`, `crossOrg`); else **stay** (finish the 5h window). |
| R5 | `¬eligible(s,m)` because a window of `W(s,m)` is full, `limited`, or `exhausted` | Hard move: same-org eligible target (any `pct(short)` < 100) → other-org eligible with `load < 70` → other-org eligible, each tier ordered by rank; recently-left seats last resort; reason `exhausted`. None → **stay** (the retry watch keeps re-deciding, as today). |
| R6 | `¬s.usable` (dead seat) | As R5 with reason `unusable`; if nothing is found, least-loaded usable seat over ALL other seats, full or not (today's dead-seat fallback, unchanged). |
| R7 | `s` no longer exists | Re-place as R1 (unchanged). |

`rankBetterByMargin(s', s)`: `seatSlack(s')` and `¬seatSlack(s)`; **or**
neither slack and `deadline(s') ≤ deadline(s) − SAME_ORG_REBALANCE_MS`. A
slack seat is never rebalanced away from (its surplus is already lost; moving
only risks a second loss). Rebalance moves record `left[s] = t`, exactly like
pressure moves — v1's "optional moves leave no block" is dropped in favour of
one uniform rule plus `MIN_DWELL_MS`, which together make ping-pong
impossible: a conversation moves at most once per dwell period, and never
back within the block.

R8 (**reset-soon, 5h-only providers**): when `long(W(s,m))` is empty, today's
`resetSoonMove` applies unchanged (same-org seat whose short window resets
within `RESET_SOON_MS` and is under 70). When a long window exists it is
removed: with the weekly binding, a 5h remainder has no value of its own.

R9 (**model change**): a root whose model changes re-decides under R2–R6 at
its next request with the new model. A sub-agent on another model decides
its own request's eligibility with its model but moves the root only through
R5/R6 (a seat that cannot serve the sub-agent's model but can serve the
root's keeps the root; the sub-agent's request is the one that fails and
retries, exactly today's behaviour for a scoped cap).

Invariants preserved (each is an existing test that must stay green): manual
mode identical; `model = null` ignores scoped windows; a dead seat always
releases its conversation; two concurrent first requests of one conversation
land on one seat; a soft move never targets a seat at ≥ 95; cross-org cap
and 5h move-back block unchanged.

Announcements: every automatic move is recorded `{movedFrom, movedAt, reason,
trigger, crossOrg}` and passed to `onMoved`. `rebalance` is **silent** in the
chat (the role `reset-soon` had) and logged in the optimizer activity log with
`evidence: {reason, deadlineFrom, deadlineTo, slackFrom, slackTo}`.

## 4. Routing applicability (closes the Oct 15 gap)

`marginalCost` (`src/shared/marginalCost.mjs`) and the exhaustion branch in
`modelRouter.mjs` (line 173) receive the candidate model already; they filter
`account.windows` through `windowAppliesToModel(w, model.modelID)` before
the `pct >= 100` test and before pacing/pace-curve pricing. The
"usable again at" instant is the max reset over the **applicable** full
windows. Everything else in routing is unchanged. (Pacing's `pressureFor`
has no model argument and keeps reading all windows — deferred.)

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
- `windowAppliesToModel(w, model)`: absent `models` ⇒ true; `model` null ⇒
  false when `models` present; else true iff some token of the model id equals
  a listed token. Byte-identical results for every window the Claude adapter
  emits today (its `models` is exactly `[normalize(scope)]`).
- The Claude adapter sets `models` from `scope.model.display_name`; Codex and
  Kimi set nothing. No `subCapOf` / `fraction` / credits representation in v2
  — the 50 % relation is a calibration default (§2.1), not a contract field,
  until the per-model cost spec needs it.

### 5.2 `src/shared/seatChoice.mjs` (pure; shared with the renderer)

```ts
export function windowSpanMs(w): number | null
export function shortWindow(windows): w | null
export function longWindows(windows): w[]
export function windowSlackPts(snap, w, {nowMs, K}): number | null   // roomPts − capPts, null = unknown
export function seatSlack(snap, {nowMs, model, kFor}): boolean
export function seatDeadlineAt(snap, {nowMs, model}): number           // Infinity if none
export function seatRank(snap, {nowMs, model, kFor, activeSeatId}): [0|1, number, number, 0|1]
export function bestSeatByRank(snaps, {nowMs, model, kFor, activeSeatId, tieMs}): snap | null
```

`kFor(kind) → number | null` is injected (the calibration store on the
server, the `usage:calibration` RPC on the renderer). `leastLoadedSeat`,
`seatLoad`, `isSeatExhausted`, `nextResetAt`, `soonestResettingSeat`,
`aggregateSnapshot` are unchanged; `nextSeatFor` / `moveTargetFor` in
`accountsViews.mjs` call the new functions through `chooseSeat` /
`decideMove` exactly as they do today, so the "next seat" hint cannot
disagree with the server.

### 5.3 `src/server/seatAssignment.mjs`

- `chooseSeat` → R1 (tiers: eligible targets by rank → usable least-loaded).
- `decideMove` → R2–R8; `resetSoonMove` kept, gated on "no long window".
- Constants: delete `MOVE_TARGET_BELOW_PCT` **only if** no caller remains
  (it is used by R4/R5's "< 70" cross-org tier — keep it, it is that number).
  Add `SAME_ORG_REBALANCE_MS = 6 h`, `MIN_DWELL_MS = 60 min`. Keep
  `MOVE_AT_PCT`, `MOVE_BACK_BLOCK_MS`, `CROSS_ORG_CAP_MS`, `RESET_SOON_MS`,
  `LIMITED_MARK_MS`.
- `createSeatAssigner` gains `kFor` (injected reader, default: the
  calibration store) and `attribution` (§5.5 writer, default: the jsonl
  appender). Both optional; absent `kFor` ⇒ `null` for every kind ⇒ no seat
  is ever slack and only the deadline key orders.
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

One line per **(root, seat, model, 10-minute bucket)** — written from
`place()` after the decision, NOT per request (a busy conversation would
otherwise write hundreds of lines per hour):

```json
{"t":1793700000000,"root":"ses_…","seat":"seat-8","model":"claude-opus-5-5","reason":"kept"}
```

`reason` ∈ `assigned | kept | moved:<why>`. Rotated at 8 MB (keep 4 files),
0600, append with `fs.appendFile` (atomicity per line is not required — a torn
last line is skipped by readers). Never contains content, only ids. This is
the record the follow-up specs read; nothing in v2 reads it except a test.

### 5.6 RPC

- `usage:calibration` → `{providers: {<id>: {kByKind, defaults}}}` (read).
- `accounts:seat-view` (existing provider view) gains per seat
  `{slack: boolean, deadlineAt: number|null}` so the seat list can show why
  a seat is preferred; the renderer's `nextSeatFor` hint already follows
  the shared functions.

## 6. Measuring `K` (`src/server/usageCalibration.mjs`)

Identifiable from readings alone — no tokens, no attribution needed:

- Input: `usage-history.json` per-seat series for the short kind and each
  long kind (already recorded every ≤ 10 min, ≥ 28 days).
- For each seat and long kind: walk consecutive readings; an interval
  qualifies when both series are present at both ends, neither crosses a
  reset (`pct` did not drop by > `RESET_DELTA` = 10 and `resetsAt` did not
  pass between the ends), neither end is stale, and the interval is ≤ 20 min.
  Accumulate `Δshort` and `Δlong` over qualifying intervals of the last 14
  days.
- `K_seat = ΣΔshort / ΣΔlong`; provider `K = median over seats`.
- Guards: `ΣΔlong ≥ 20` points per seat; ≥ 3 seats; else the default. Known
  bias: intervals with Fable traffic inflate `Δlong` and lower `K`, which
  makes fewer seats read as slack — the conservative direction. The dashboard
  shows "K: 7.4 (measured, 9 seats)" or "K: 7.5 (default — calibrating)".
- Runs from the usage poller's observe tap, debounced to once per hour, and
  on boot; pure function `estimateK(history, {nowMs, kinds})` tested with
  synthetic series.

Validation (part of acceptance, manual, documented in the PR): a 30-minute
single-model run on one seat for Opus, reading the three windows before and
after, matches the estimate within ±25 %.

## 7. Tunables

| Name | Default | Why |
|---|---|---|
| `MOVE_AT_PCT` | 95 | unchanged — pack the 5h |
| `SAME_ORG_REBALANCE_MS` | 6 h | rebalance only for a materially earlier weekly reset |
| `MIN_DWELL_MS` | 60 min | at most one automatic move per conversation per hour |
| `MOVE_BACK_BLOCK_MS` | 5 h | unchanged |
| `CROSS_ORG_CAP_MS` | 5 h | unchanged |
| `RESET_TIE_MS` | 60 s | unchanged |
| `K` defaults | weekly 7.5; model caps 0.5·K | until measured (§6) |

## 8. Replay harness — `scripts/seats/replay.mjs`

Replaces `replay-draft.mjs`. It imports the REAL pure functions —
`decideSeat` from `seatAssignment.mjs` for both the current rule (git HEAD
before this change, vendored into the fixture dir as `decideSeat.before.mjs`
at implementation time) and the new one — and drives them with identical
state: a committed anonymised trace
(`src/server/fixtures/seat-demand-trace.json`: 3 weeks, 10 seats, per-10-min
demand in 5h-points, real weekly reset phases), conversations arriving as
Poisson with a measured context-size distribution, window readings updated
from the simulated seat state (so `stale`/`active` are exercised), and the
same `K`. Output per policy: served %, weekly points expired unused per
seat-week, moves by reason and org crossing, re-sent tokens.

Acceptance (a test, `scripts/seats/replay.test.mjs`): at demand scales 0.4,
0.6, 0.8, 1.0 the new rule serves ≥ the old rule's share − 0.5 pt at every
scale, and expires ≤ 60 % of the old rule's weekly headroom at 0.4 and 0.6.
Sensitivity rows (not gated, printed): stream count 2/6/12, `K` 6/7.5/9,
reading lag 0/10 min, 20 % of traffic Fable.

Simplifications stated in the script header: observed usage is a lower bound
on offered demand; transfers are instantaneous; the trace's reset phases are
this box's. The draft script's numbers (v1 table) are kept in git history
only.

## 9. Libraries considered

| Need | Chosen | Considered / why rejected |
|---|---|---|
| Ranking, slack arithmetic | own code in `seatChoice.mjs` (~120 lines pure) | nothing models quota windows; a lexicographic sort by a tuple |
| `K` estimate | own code (`estimateK`, a ratio of sums with interval filters, ~60 lines) | `simple-statistics` 8.0.0 (ISC, 0 deps, 1.46M/wk, 2026-10-28) would give `linearRegression`; a through-origin ratio of filtered sums is the estimator wanted here (no intercept, interval weighting by Δ) and the filters are the work, not the fit. Revisit when `μ`/`τ` (multivariate) arrive in the follow-up spec. |
| Attribution log rotation | own appender (~40 lines) | `rotating-file-stream` 3.2.10 (MIT, 0 deps, 414k/wk, 2026-08-13): a stream abstraction for one `appendFile` + rename is more surface than the need; `pino` rotation needs the pino pipeline. |
| Persistence | existing `jsonStore.mjs` | unchanged |
| Replay | own script | mirrors `scripts/optimizer/backtest-trims.mjs` |
| Poisson arrivals / sampling in the replay | own 15 lines (inverse-CDF with a seeded PRNG) | `seedrandom` 3.0.5 (MIT, 0 deps, 13.3M/wk, last publish 2019-09) for the PRNG — stable but a dependency for a dev script; a 10-line mulberry32 is standard. |

## 10. Tests

- `seatChoice.test.ts`: `windowSpanMs` (reported / inferred / unknown);
  `windowSlackPts` — seat 8 case (slack ≈ 350), seat 1 case (not slack),
  short window not started (`r = t`), `R` unknown → null, `K` null → null,
  stale long window excluded, inactive excluded, Fable cap in `W` for Fable
  only; `seatRank` ordering (slack beats earlier deadline; equal deadlines →
  load; active-seat tie); `bestSeatByRank` with no long windows equals
  `leastLoadedSeat`.
- `seatAssignment.test.mjs`: R1 picks seat 8 for Opus and for Fable; with
  seat 8's Fable cap at 100, Fable picks seat 2 and Opus still seat 8; R3
  rebalances for a 7 h earlier deadline, not for 5 h; never away from a slack
  seat; `MIN_DWELL_MS` blocks a second move; `left` block honoured; R4/R5/R6
  tiers reproduce the existing org-affinity tests (unchanged expectations
  where the long windows are absent); R8 reset-soon only with no long window
  (existing reset-soon tests re-run with the weekly window removed, and
  asserted NOT to move when it is present); manual-mode suite unchanged;
  sub-agent/root model rules.
- `marginalCost.test`, `modelRouter.test`: a full Fable cap does not
  exhaust an Opus endpoint; does exhaust a Fable endpoint; unknown model ⇒
  scoped windows ignored.
- `normalizeWindow.test`, `claude.test`: `models` derived from `scope`;
  explicit `models` wins; Codex/Kimi unchanged.
- `usageCalibration.test.mjs`: synthetic series with known `K` recovered
  within 3 %; reset-crossing and stale intervals rejected; guards.
- `seatAttribution.test.mjs`: one line per bucket; rotation; torn-line read.
- `scripts/seats/replay.test.mjs`: §8 acceptance.

## 11. Rollout

1. Contract (`models`), routing applicability (§4), attribution log,
   calibration store + `K` estimator + RPC. No placement change — `kFor` is
   wired but `decideMove`/`chooseSeat` still run the old rules. Ships first;
   observe the attribution log and the measured `K` for ≥ 3 days.
2. Placement rules R1–R9 + replay harness, in automatic mode (already the
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
