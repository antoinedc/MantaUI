# Seat placement by binding-window deadline, priced moves, pool pacing — design

Status: DRAFT for review · 2026-11-03 · branch `limit-usage`

Amends `2026-10-08-multi-account-subscriptions-design.md` §5.3 (automatic
mode rules 1, 3, 4), `2026-10-12-seat-org-affinity.md`,
`2026-10-15-model-scoped-seat-limits.md`. Touches the optimizer pacing
controller (`src/server/optimizer/pacing.mjs`, `src/shared/quotaPressure.mjs`).

## 0. Goals / non-goals

Goals
- Spend the **weekly** quota of a multi-seat provider as fully as possible:
  place work so that the least weekly headroom expires unused at a reset.
- Keep the 5h window packed where it costs nothing, and respect it where it
  binds.
- Move a conversation between orgs only when the quota it saves is worth the
  history re-send, measured in the same unit.
- Make the window structure (which models draw from which window, sub-caps
  such as "Fable ≤ 50% of the weekly") **data reported by the provider
  adapter**, not assumptions in the placement code, so Codex / Kimi / future
  Anthropic changes need an adapter edit only.
- Give pacing a signal that describes the **pool** of seats, not one seat.

Non-goals (v1): moving a turn mid-stream; compaction on move; sharing seats
across boxes; manual mode changes (manual stays "every conversation on the
active seat"); the standard-Team / Pro "Fable on usage credits" variant beyond
representing it in the contract.

## 1. Findings (this box, 10 Claude seats = 2 orgs × 5 × `Team · Max 5x`)

All numbers from `~/.manta/usage-history.json` (per-seat window readings
since 2026-10-08), `~/.manta/seat-assignments.json`, and the opencode V2
message ledger. The replay script is
`/mnt/HC_Volume_105783934/dev-cache/opencode-tmp/seatsim.js` (to be moved
into `scripts/seats/` by the implementation — see §9).

1. **The weekly binds, not the 5h.** One full 5h window costs **12–15 %** of
   the weekly (seat 7 over three weekly episodes: 1/6.6; all seats over the
   first 15 h of weekly data: 1/8.1). So a seat can fill **K ≈ 7.5** of its
   **33.6** possible 5h windows per week. Call `K` the *5h windows per weekly
   window*; it is a measured per-provider (per-plan) constant.
2. **Demand ≈ 1.8× the weekly pool.** Past demand (Oct 12 – Nov 2) was
   ≈ 13,400 5h-points/week; the pool's weekly capacity is ≈ 10 seats × 100 × K
   ≈ 7,500. Caveat: most seats only started reporting a weekly window on
   Nov 2 (the adapter fix), so K rests on little data, and past demand was
   generated under the old, looser behaviour.
3. **Weekly headroom is expiring unused today**: seat 8 had 98 % of its week
   left 12 h before reset (≤ 38 % spendable even flat out), seat 2 had 96 %
   left 18 h before. Placement does not prefer them: both read "16 % loaded"
   by the current highest-window rule.
4. **Same-org moves keep the cache**: on the first request after a same-org
   move the cache was reused in 65 of 90 cases. The one cross-org move
   checked re-sent ≈ 890k tokens.
5. **A cross-org re-send is cheap in quota**: at API price weights a 500k
   re-send ≈ 1.1–1.5 % of a 5h window ≈ 0.15–0.2 % of a week. Seat moves are
   ≈ 2 % of all cache-write volume; cache writes are ≈ 35 % of all quota
   spent (last 3 days: 660M written vs 13.7B read; median context 290k, p90
   594k) — mostly cache expiry during idle gaps, out of scope here but the
   larger lever.
6. **Most automatic moves spend the wrong window**: 55 of 73 moves in the
   last week were `reset-soon` (chase a 5h window about to reset). That is
   worth nothing while the weekly binds.
7. **Pacing sees one seat.** `aggregateSnapshot` hands the pacing controller
   the least-loaded seat as "the provider" (3 % right now), so pool pressure
   is invisible until every seat is high, and a change of which seat is
   least-loaded looks like a reset.
8. **Fable (confirmed by Anthropic support, 2026-11-03):** on Max / Ultra /
   premium Team seats a Fable request is deducted from the **shared 5h**, from
   the **shared weekly** (faster than other models per token), **and** from a
   Fable cap that is **50 % of the weekly**. On Pro / standard Team seats
   Fable does not touch the plan's weekly at all (usage credits). Our seats
   are premium. The history agrees: seat 7's weekly grew 0.149 pts per
   5h-point in hours with Fable usage vs 0.151 without.

## 2. The model

### 2.1 Units

Every quantity below is in **5h-points of one seat** (1 % of a 5h window).
A weekly point of a seat = `K` 5h-points. A Fable-cap point = `0.5 · K`
5h-points (the cap is 50 % of the weekly). Converting everything to one unit
is what lets a cross-org re-send be compared with weekly headroom.

### 2.2 Windows

A seat reports windows `w` with: `kind`, `pct`, `resetsAt`, `startedAt?`,
`active`, and (new, §5.1) `models` — which model ids draw from it — and
`subCapOf?` + `fraction?` for a cap defined as a share of another window. A
model `m` on seat `s` draws from `W(s, m) = { w : m ∈ w.models }`.

| Seat type | Opus / Sonnet draw from | Fable draws from |
|---|---|---|
| Max, Ultra, premium Team | 5h, weekly | 5h, weekly, fable (= 50 % of weekly) |
| Pro, standard Team | 5h, weekly | 5h, credits (separate; not a plan window) |

### 2.3 Binding window and deadline

For seat `s`, model `m`, now `t`:

- `room(w)` — what is left of `w`, in 5h-points: `(100 − pct) · unit(w)`
  where `unit(5h) = 1`, `unit(weekly) = K`, `unit(fable) = 0.5 · K`.
- `spendable(w)` — the most of `w` that can still be spent before it resets,
  given the other windows: for the weekly, `n = ⌈(R − r)/5h⌉` 5h windows fit
  before its reset `R` (`r` = the 5h reset), so
  `spendable(weekly) = min(room(weekly), room(5h) + 100·n)`; for the 5h,
  `spendable(5h) = min(room(5h), room(weekly))`; for a sub-cap,
  `min(room(cap), spendable(parent))`.
- **Binding window** `b(s, m) = argmin_w spendable(w)` over `W(s, m)`;
  **deadline** `D(s, m) = resetsAt(b)`.
- **Doomed headroom** of a window: `room(w) − spendable(w)` — lost whatever we
  do. Today: seat 1 weekly room 100 pts vs spendable 133 → nothing doomed;
  seat 8 room 98 vs spendable 38 → 60 doomed. Doomed headroom is what the
  placement order minimises.

### 2.4 Why earliest deadline

Weekly headroom is perishable stock with a known expiry. Serving demand from
the stock that expires first minimises spoilage (Pierskalla & Roach 1972,
"Optimal issuing policies for perishable inventory"; the FIFO/EDF result).
The unavoidable loss over a horizon is

```
Loss_min = max_k [ Σ_{s : R_s ≤ R_k} spendable_s − demand(t, R_k) ]⁺
```

and no ordering does better. Replayed on this box's demand trace (§1,
`seatsim.js`, real weekly reset phases, 5h windows starting on first use,
demand split over 6 conversations):

| Demand vs past | Policy | Served | Weekly wasted / seat-week | Cross-org moves |
|---|---|---|---|---|
| 0.6× | today | 99.0 % | 15 % | 159 |
| 0.6× | EDF within org | 99.8 % | **7 %** | **3** |
| 0.8× | today | 82.0 % | 8 % | 507 |
| 0.8× | EDF within org | 83.6 % | 6 % | 550 |
| 1.0× | today | 67.1 % | 6 % | 567 |
| 1.0× | EDF within org | 68.3 % | 4 % | 724 |

When demand fits, EDF halves the waste and nearly removes cross-org moves.
At past demand (1.8× the pool) a third of the work cannot be served under any
order — only cheaper spending (§4) or more seats help.

### 2.5 Price of a move

A move from seat `a` to seat `b` costs, in 5h-points of `b`:

```
cost(a→b) = 0                              if org(a) = org(b)   (shared cache)
          = C · (ω_write − ω_read) / τ     otherwise
```

`C` = the conversation's context size at its last request (input + cache read
+ cache write of the last assistant message in the ledger), `ω_write` /
`ω_read` = the provider's relative weight of a cache write / read in quota
terms (defaults from API list prices: 1.25 / 0.1 of input; measured later,
§6), `τ` = tokens per 5h-point for the provider (the pacing controller's
`tokensPerPct`, already measured). With no measurement for `τ`, use
`τ = 0.5M` (this box, §1.5) as the provider default.

A move is made when the doomed headroom it rescues exceeds its cost:

```
move  iff  rescue(b) − rescue(a) > cost(a→b) + H
```

`rescue(x)` = the headroom on `x` that this conversation's expected demand
until `D(x)` would consume and that is otherwise doomed; `H` is a hysteresis
margin (§7) that replaces the fixed once-per-5h cross-org cap.

## 3. Placement rules (automatic mode)

Replaces §5.3 rules 1, 3, 4 of the multi-account design and the whole of the
org-affinity amendment's tier tables. Manual mode is unchanged.

R1. **New conversation** (model `m` known, else `m = null` ⇒ model-scoped
windows ignored, as today): among usable seats with 5h room (`room(5h) >
MOVE_AT` margin, i.e. load of the 5h window < 95), pick the **earliest
`D(s, m)`**; ties (within `RESET_TIE_MS`) → fewest doomed points → least
loaded → active seat. Seats with no reading rank after seats with one; full
seats last (unchanged ranking from `seatChoice`).
The org-affinity "escape route" tier is dropped: with EDF the same-org
sibling that resets next is the natural escape, and the replay shows
cross-org moves fall, not rise.

R2. **Stay.** A conversation stays on its seat while that seat can serve it
(`spendable(b(s,m)) > 0` and 5h load < 95) **and** no same-org seat has an
earlier deadline by more than `SAME_ORG_REBALANCE_MS` (6 h, tunable). The
5h window is deliberately packed to 95–100: when the weekly binds, finishing
the 5h costs nothing extra and avoids a move.

R3. **Same-org move** (free): when R2's deadline test fails, or the seat is
full / unusable, move to the same-org seat with the earliest `D(s', m)` that
has 5h room. No `left` block for same-org moves (an optional free move must
not shrink a later forced move's options — kept from rule 4).

R4. **Cross-org move** (priced): only when no same-org seat can serve (full /
unusable / all at 5h ≥ 95), or when the §2.5 inequality holds with the
conversation's real `C`. The fixed `CROSS_ORG_CAP_MS` goes away; the price
plus `H` is the cap. A seat left within `MOVE_BACK_BLOCK_MS` (5 h) is still a
last resort only (unchanged).

R5. **`reset-soon` is removed** as a rule and replaced by the general case:
a 5h window's remainder has value only when the seat's weekly cannot
otherwise be emptied (`room(weekly) > spendable(weekly) − room(5h)/K`).
That falls out of the deadline computation: when the 5h binds, `b = 5h` and
EDF prefers the 5h that resets soonest, exactly the old behaviour; when the
weekly binds, the 5h reset is irrelevant and no move is made.

R6. **Model change** (a conversation switches to / from a capped model): the
next request re-decides with the new model under R2–R4; no special case.

R7. **Sub-cap seats and Opus.** Because Fable's cap is a share of the weekly,
a Fable-heavy seat exhausts its cap before its weekly. R1/R3 handle this
through `D(s, m)` alone; the only cross-model effect is that an Opus
conversation ranks a seat whose Fable cap is full or inactive equal to any
other (the cap is not in `W(s, opus)`), so Opus does not avoid those seats
and Fable conversations keep the seats where they can still run. No explicit
rule is needed — it is a property of per-model window sets, and a test pins
it.

Every automatic move is still recorded `{movedFrom, movedAt, reason, trigger,
crossOrg}` and announced via `onMoved`, with reasons `deadline` (R3),
`exhausted`, `unusable`, `priced` (R4). The activity-log entry gains
`evidence.rescuedPts` / `evidence.costPts` for a priced move.

## 4. Pool pacing

The pacing controller (`createPacingState`) today observes the provider
**aggregate** (least-loaded seat). It changes to observe **per-seat**
windows and derive pool quantities:

- Pool key `"<provider>:<kind>"` as today, but the observed `pct` is replaced
  by the **pool deficit**: `Σ_s doomed_s(w) / Σ_s room_s(w)` and the
  **pool fill**: `Σ_s used_s(w) / Σ_s capacity_s(w)` in 5h-points, weighted by
  plan (`Max 20x` = 20, `5x` = 5, `Pro` = 1 — the same weights as the dial's
  `combinedSeatWindows`). A seat whose weekly resets does not look like a
  pool reset: the pool fill drops by that seat's share only.
- `pressureFor(providerID)` keeps its return shape
  (`{lambda, tokensPerPct, deficit, ecoLevel, protection}`); `deficit` is
  computed by `advanceDeficit` over the pool fill, so the Lyapunov /
  shadow-price math in `quotaPressure.mjs` is untouched.
- **Per-model cost multiplier** `μ_m`: weekly points per token of model `m`
  relative to the provider's base model, measured from the ledger (§6) — for
  Fable, `μ = (0.5 · ΔFable%) / Δweekly%_opus` per equal token volume. The
  router's cost stage multiplies a model's quota cost by `μ_m` when the
  optimizer switch is on, so at eco level ≥ 1 the expensive model is the first
  traded down. On standard / Pro seats Fable has `μ = 0` against the weekly
  (credits are a separate pool the router prices from the credit reading).
- The dashboard's pressure chips read the pool numbers; no UI change beyond
  the numbers themselves.

## 5. Contract

### 5.1 `UsageWindow` (`src/shared/types.ts`, `usageAdapters/normalizeWindow.mjs`)

New optional fields, written by adapters, defaulted by `normalizeWindow`:

```ts
models?: "all" | string[]   // model ids (or display-name tokens, matched as
                            // windowAppliesToModel does today) that draw from
                            // this window. Absent ⇒ "all". A scoped window
                            // (`scope`) defaults to [scope].
subCapOf?: string           // kind of the window this is a share of
fraction?: number           // the share (0–1), e.g. 0.5 for the Fable cap
```

`windowAppliesToModel` reads `models` first and falls back to today's `scope`
token match. `seatLoad` / `seatLoadWindow` / `isSeatFull` / `nextResetAt`
are unchanged in signature.

The Claude adapter sets `models: ["fable"]`, `subCapOf: "weekly"`,
`fraction: 0.5` on the Fable weekly when the seat's plan is Max / Ultra /
premium Team (the plan string we already parse for the dial weights), and
`models: ["fable"]` with no `subCapOf` (and `kind: "credits_scoped:fable"`,
`unit` from the reading) on standard / Pro seats. Codex / Kimi adapters set
nothing new (all windows "all").

### 5.2 `src/shared/seatChoice.mjs` (pure, shared with the renderer)

```ts
windowUnit(w, {K}): number                       // 5h-points per pct of w
roomPts(w, {K}): number
spendablePts(snap, w, {nowMs, K, model}): number
bindingWindow(snap, {nowMs, K, model}): {kind, resetsAt, spendable, doomed} | null
deadlineAt(snap, {nowMs, K, model}): number       // Infinity when unknown
doomedPts(snap, {nowMs, K, model}): number
earliestDeadlineSeat(snaps, {nowMs, K, model, activeSeatId, tieMs}): snap|null
```

`K` comes from the provider's measured constant (§6), default 7.5 for Claude
and `Infinity` (= "weekly never binds") for a provider with no weekly window.

### 5.3 `src/server/seatAssignment.mjs`

- `chooseSeat` → R1; `decideMove` → R2–R4; `resetSoonMove` deleted;
  `RESET_SOON_MS`, `CROSS_ORG_CAP_MS`, `MOVE_TARGET_BELOW_PCT` deleted;
  `SAME_ORG_REBALANCE_MS = 6h`, `MOVE_PRICE_MARGIN_PTS = 2` (`H`) added.
- `decideMove` takes `{contextTokens, tokensPerPct, cacheWeights}` from new
  injected readers: `contextTokensFor(sessionId)` (the ledger's latest row for
  the session, already cached by `latestLedgerRowsBySession`) and the pacing
  state's `tokensPerPct`. All optional; absent ⇒ a cross-org move only when
  no same-org seat can serve (today's hard-move behaviour).
- `describeSeatMove` wording: `deadline` → "(its seat's weekly resets later
  than Seat N's — spending the earlier one first)"; `priced` → "(saves ≈ X %
  of a week, history re-sent ≈ Y %)".

### 5.4 `src/server/optimizer/pacing.mjs`

`observe(snapshots, seatSnapshots)` — second argument added at the single
tap in `startUsagePoller`; with seats present the pool math of §4 applies,
without seats behaviour is byte-identical. `pressureFor` unchanged in shape.
`modelMultiplierFor(providerID, modelID)` added, read by
`routingServices.mjs` next to `pressureFor`.

### 5.5 Measured constants store

`~/.manta/usage-calibration.json` (statePath, atomic): per provider
`{K, tau, omegaWrite, omegaRead, mu: {<model>: μ}, samples, updatedAt}`.
Written by the calibrator (§6), read by seat assignment and pacing with the
defaults above when absent. Never a hard dependency: every reader works with
defaults.

## 6. Measurement (calibrator)

A box-side job (`src/server/usageCalibration.mjs`, run from the usage
poller's observe tap, debounced) regresses per-seat window deltas on the
ledger's per-model token deltas for the same seat and interval:

```
Δweekly% · K = Σ_m μ_m · tokens_m / τ            (per interval)
Δ5h%          = Σ_m tokens_m / τ
```

with `ω` weights applied to the token kinds (input, cache write, cache read,
output). Non-negative least squares over the last 14 days of intervals with
one dominant model gives `τ`, `K`, `μ_fable`, and the `ω` pair. The seat a
request used is known (`seat-assignments.json` + the ledger's session id),
so the regression is per seat, aggregated per provider. Guard: ≥ 20
intervals and R² ≥ 0.7 before a constant replaces its default; otherwise
the default stays and the dashboard shows "calibrating".

Validation to run before the constants are trusted (part of the
implementation's acceptance): a 30-minute single-model run on one seat for
Opus and one for Fable, read the three windows before/after, compare with
the regression's prediction (±20 %).

## 7. Tunables

| Name | Default | Why |
|---|---|---|
| `MOVE_AT_PCT` | 95 | unchanged: pack the 5h |
| `SAME_ORG_REBALANCE_MS` | 6 h | a free move still re-reads the file / churns state; only rebalance for a materially earlier deadline |
| `MOVE_PRICE_MARGIN_PTS` (`H`) | 2 | hysteresis for priced moves, in 5h-points |
| `MOVE_BACK_BLOCK_MS` | 5 h | unchanged |
| `RESET_TIE_MS` | 60 s | unchanged |
| `K`, `τ`, `ω`, `μ` | 7.5, 0.5M, 1.25/0.1, 1 | defaults until calibrated |

## 8. Libraries considered

| Need | Chosen | Considered / why rejected |
|---|---|---|
| Earliest-deadline ordering, binding-window arithmetic | own code (`seatChoice.mjs`, ~150 lines pure) | No library models quota windows with sub-caps; the ordering is a sort by one key. Scheduling libraries (`node-schedule`, `bree`) solve a different problem (running jobs). |
| Deficit / shadow price | existing `quotaPressure.mjs` | unchanged |
| Regression for `K`, `τ`, `μ`, `ω` | **`simple-statistics` 8.0.0** (ISC, 0 deps, 1.46M weekly downloads, published 2026-10-28) — `linearRegression` + a small NNLS via its matrix helpers is not provided; use its `linearRegression` per constant with one dominant model per interval (the guard in §6 keeps intervals univariate), avoiding a multivariate solver | `ml-regression-simple-linear` 3.0.1 (MIT, 155k/wk, last publish 2024-05): smaller, fine, but single-purpose; `regression` 2.0.1 (MIT, 251k/wk, last publish 2017): unmaintained. A multivariate NNLS package (`ml-matrix` + hand NNLS) rejected: the univariate-interval guard makes it unnecessary. |
| Persistence of calibration / assignments | existing `jsonStore.mjs` | unchanged |
| Replay / backtest | own script `scripts/seats/replay.mjs` (the §1 simulation, moved in) | mirrors `scripts/optimizer/backtest-trims.mjs`; no library |
| Plan-weight parsing | existing `combinedSeatWindows` weights (renderer) → moved to `src/shared/planWeights.mjs` so server and renderer share one table | — |

## 9. Tests

Pure (`src/shared/seatChoice.test.ts`, `src/server/seatAssignment.test.mjs`,
`src/server/optimizer/pacing.test.mjs`, `src/server/usageCalibration.test.mjs`):

- `spendablePts` / `bindingWindow`: weekly binds (K = 7.5, 5h at 0 %, weekly
  at 30 %, 100 h to reset → binding = weekly); 5h binds (weekly reset in 3 h,
  5h at 90 %); sub-cap binds (Fable 90 %, weekly 20 %); inactive and stale
  windows ignored; `models` filtering (Fable cap absent from an Opus set).
- Doomed points: seat 8's case (98 % left, 12 h) → 60 doomed; seat 1's → 0.
- R1 picks seat 8 over seat 1 for Opus today; picks seat 8 for Fable too;
  with seat 8's Fable cap full, Fable picks seat 1 and Opus still picks 8 (R7).
- R2: no move for a 2 h earlier same-org deadline; move for 8 h.
- R4: priced move made when rescue − cost > H with C = 20k; not made with
  C = 600k; made regardless when no same-org seat can serve; `left` block
  honoured as last resort.
- R5 equivalence: when the weekly cannot bind (K = ∞), decisions equal the
  old `reset-soon` outcomes on the three fixture cases from the current tests.
- Model unknown ⇒ scoped windows ignored (existing tests kept).
- Pacing: pool fill with two seats, one resetting — no false reset; eco level
  monotonic; `modelMultiplierFor` returns 1 uncalibrated, μ when calibrated.
- Calibrator: synthetic intervals with known `K, τ, μ` recovered within 5 %;
  guard holds below 20 intervals.
- Replay: `scripts/seats/replay.mjs` on the committed trace fixture
  (`src/server/fixtures/seat-demand-trace.json`, anonymised, 3 weeks) asserts
  EDF wastes ≤ half of today's policy at 0.6× demand and ≥ today's served
  share at every scale — the regression guard for future rule changes.

## 10. Rollout

1. Contract + adapters + `seatChoice` additions (no behaviour change: nothing
   reads the new fields yet).
2. Calibrator + store + dashboard "calibrating" state; observe for a week.
3. Placement rules R1–R7 behind the existing automatic mode (no new switch —
   automatic mode is already the opt-in). Activity log shows the new reasons.
4. Pool pacing + `μ` in the router's cost stage, behind the optimizer switch.

Each step ships alone and is revertible by itself.

## 11. Open questions

- Does the 5h window weight Fable tokens more than Opus tokens too (support
  only said "same bucket")? The calibrator answers it (`τ` per model); the
  design does not depend on the answer.
- Is `K` stable across the two orgs and across the week (a Team org may have
  pooled or tiered weeklies)? The calibrator computes it per seat and the
  dashboard should show the spread.
- Should the conversation's expected demand until `D` (used by `rescue`) be
  its own recent rate or the pool's mean? v1: the conversation's own rate
  over the last 24 h from the ledger, falling back to the pool mean.
