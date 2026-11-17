# Background work budget — one budget for shared knowledge and the background CTO

Status: rev 3 (2026-11-17) — two review rounds, round 2 found no blockers. **§17 amends earlier sections and wins on any conflict.** User approved (2026-11-17): one API-key cap with the 60 % batch ceiling; level caps bound overnight work on plans; overnight jobs pinned to the default model.
Owner: box server (`src/server/`), desktop renderer (`src/renderer/`)

## 1. Problem

Two subsystems spend model calls the user did not ask for:

- **Shared knowledge** (`src/server/knowledge/`, PR #1688): capture, curator batches, corrections pass,
  weekly tidy, skill trials. Bounded by knowledge `dailyCapUsd` (default $1/day, `knowledge/budget.mjs`).
- **Background CTO**: ambient work bounded by `ctoAmbientCap` ($2.50/day, `ctoBudget.mjs`), overnight
  jobs bounded by a plan-window reserve or, without a windowed plan, `ctoNightCapUsd` ($5/night); the
  history backfill has its own one-off $3 cap (`ctoBackfill.mjs`).

Everything is priced in dollars at list price. On a subscription plan (Claude Max, ChatGPT Pro, Kimi)
those dollars are fictional: the real cost is plan quota, which is either spare (wasted at the reset) or
scarce (taken from the user). A dollar cap is too tight when quota is idle and blind when the user is
about to run out. On a pay-per-token key the dollars are real and a dollar cap is right.

Bugs in the overnight budget seam (`src/server/index.mjs`, `adaptiveCtoOvernight.budget`, confirmed):

1. It filters snapshots on `s.windowed === true`; `windowed` exists on adapter objects
   (`usageAdapters/claude.mjs`), never on snapshots, so no plan is ever treated as windowed.
2. It passes the window's `pct` (percent USED) as `remainingPct` and picks the provider with the
   highest used pct as the one with "most headroom".
3. The windowless fallback's `find(s => s.windowed === false)` never matches either, so the provider is
   always the hard-coded `"anthropic"`.

The overnight scheduler only runs jobs today because of bug 1: the windowless path yields
`spendableFrac: null` (treated as 1), while a correctly computed windowed `spendableFrac` (≤ 0.4 with the
≥ 60 % fallback reserve) would reject every candidate, whose `predictedCost` is 1 (`ctoOvernight.mjs`
`selectPortfolio`). Fixing the bugs therefore requires replacing the selection unit (§7.3).

## 2. Goal and decisions

User decisions (2026-11-17):

- **One budget** governs all background work of shared knowledge and the background CTO (ambient,
  overnight, backfill). Routines keep their own controls (out of scope).
- **Subscription plans** are budgeted as a share of plan quota windows, through one setting
  **Background work on plans: Off / Light / Normal**, default **Normal**.
- **Pay-per-token** (API keys, credit accounts) keeps a dollar cap, **$5/day by default**, user-editable.
- On a plan, background work uses **spare quota only**, prefers running while the user is away, and runs
  its weekly batch jobs close to a reset when that quota would otherwise be wasted.
- Plan usage is shown in plan terms ("2% of your Claude week").

Decisions made by this spec (flag them in the PR body):

- **The CTO's night cap and ambient cap fold in.** `ctoNightCapUsd`, `ctoAmbientCap` and knowledge
  `dailyCapUsd` are retired; one daily dollar cap covers all background work on pay-per-token. Old values
  are not carried over (fresh $5 default), except that an older desktop saving knowledge `dailyCapUsd`
  sets the new cap (§9).
- **Batch work may not use the whole budget.** Batch work (weekly passes, trials, overnight jobs,
  backfill) stops at 60 % of each cap; the last 40 % is kept for continuous work (capture, curation, CTO
  ambient). Reason: one overnight job could otherwise spend the whole $5 at 01:00, or the whole weekly
  plan share on Monday, and starve capture for the rest of the day/week.
- **On plans the level caps also bound overnight work**, replacing the reserve fraction as the selection
  bound (the reserve stays as a Health-card forecast). This makes overnight work on a plan at most 5 % of
  a week / 10 % of a 5-hour window on Normal — far less than the old reserve intended. That follows from
  the user's level choice; the PR body says so.
- **Gates fail closed** (today the CTO gate fails open): when the budget cannot decide, background work
  waits.

## 3. Definitions

- **Background work**: every model call or job started by shared knowledge or the background CTO rather
  than the user. Each has a **work type** and a **class** (continuous / batch), §5.1.
- **Billing mode** of a call: `plan` or `payg`, from the model the call will use (§4).
- **Window**: a `UsageWindow` of an adapter's aggregate usage snapshot (`usage.mjs`): `kind`, `pct`
  (percent USED, 0–100), `resetsAt`, optional `startedAt`, `stale`, `active`, `models`.
- **Weekly-kind window**: `kind === "weekly"` or `kind.startsWith("weekly")` (e.g. `weekly_scoped:*`).
  Every other kind ("session" = 5-hour, daily, …) is a **short window**.
- **Background share** `bgPct` of a window: pct-points of that window consumed by background work since
  the window started (§6).
- **Level caps** (share of a window background work may use):

  | Level | weekly-kind window | short window |
  |---|---|---|
  | Off | 0 % | 0 % |
  | Light | 2 % | 5 % |
  | Normal (default) | 5 % | 10 % |

- **Batch ceiling** = 60 % of a cap (`BATCH_SHARE = 0.6`): payg `0.6 × dailyCapUsd`, plan
  `0.6 × levelCap(kind)` per window.

## 4. Billing mode

For a call on `{providerID, modelID}` (a `null` model = the box default model, resolved the same way the
runner dispatches it):

1. `adapter = adapterForProviderID(providerID)`. None → **payg**.
2. The adapter's aggregate snapshot from `listSnapshots()`. `snapshot.kind === "credit"` → **payg**.
   Otherwise (`"subscription"`, or absent kind with at least one window) → **plan**; a subscription that
   also reports a balance (codex) is plan.
3. Snapshot missing (never fetched, adapter failing) → **payg with `fallback: true`**: the dollar cap
   governs and the UI says why (§10). This keeps the work bounded without silently pretending.

Governing windows of a plan call: the snapshot's windows with `active !== false` that apply to the model
(reuse `windowAppliesToModel` — do not copy it).

## 5. The shared module

New `src/server/backgroundBudget.mjs`, dependency-injected like `ctoBudget.mjs`, created once in
`index.mjs` and handed to the knowledge engine, the CTO engine, the overnight scheduler and the backfill.
It replaces `knowledge/budget.mjs`'s cap logic and `ctoBudget.mjs`'s ambient/night cap logic.

### 5.1 Work types

| Work type | Owner | Class |
|---|---|---|
| `knowledge-capture`, `curator-notes`, `curator-rules`, `curator-skills` | knowledge | continuous |
| `knowledge-corrections` (weekly pass), `knowledge-tidy`, `knowledge-trial` | knowledge | batch |
| `cto-ambient` (every ambient model call) | CTO | continuous |
| `cto-overnight` (overnight delegate jobs), `cto-backfill` | CTO | batch |

The knowledge briefing and tools make no model calls and are never gated. The curator's 24
batches/project/day limit stays. The backfill keeps its one-off lifetime $3 ceiling in addition.

### 5.2 API

```
createBackgroundBudget({
  store,                // JSON state, atomic writes + mutex (jsonStore + the ctoStores.patchStore pattern)
  log,                  // append-only evidence log (§11), delegateLivenessLog.mjs pattern
  configGet,            // reads `backgroundWork`
  listSnapshots,        // usage.mjs
  providerTokenTotals,  // modelLedger.mjs ({sinceMs}) → {byProvider} | null
  getPrices, bandOf,    // pricing (§5.5)
  userAway,             // () => boolean (§8)
  resolveDefaultModel,  // () => {providerID, modelID} | null — the box default
  now,
})
→ {
  check({ workType, model, estimateUsd?, estimateTokens? }) → Promise<Decision>
  record({ workType, model, usage?, usd?, inLedger }) → Promise<{usd, priced, mode}>
  goodMomentForBatch({ workType, model, dueSince }) → Promise<{ok, rule|null, reason|null}>
  tick()                // §6.2; runs on its own 10-min poller AND on usage.updated
  status() → Promise<BudgetStatus>   // UI (§10)
  usdToday({ workType?, mode? }) → number
}
Decision   = { ok, mode: "plan"|"payg", fallback: boolean, reason: null|ReasonCode, window?: {key, pct, bgPct, cap, resetsAt}, resumesAt: number|null }
ReasonCode = "off" | "level-cap" | "window-busy" | "projected-high" | "exhausted" | "usd-cap" | "unavailable"
```

`check` and `record` never throw. If `check` cannot read its own state it refuses with `unavailable`.
`record` logs and drops on a store failure (the call already happened). Every refusal is written to the
evidence log (§11).

### 5.3 Decision rule (`check`)

`cap(workType)` = the full cap for continuous work, the batch ceiling for batch work.

**payg**: refuse `usd-cap` when `usdToday({mode:"payg"}) + (estimateUsd ?? 0) >= cap`. `dailyCapUsd = 0`
means no background work on pay-per-token. `resumesAt` = next local midnight.

**plan**, per governing window (all must pass; the first failure is reported):

1. level `off` → `off`.
2. `snapshot.exhausted` or `pct >= 100` → `exhausted` (`resumesAt = resetsAt`).
3. `bgPct + inFlightPct + estimatePct >= cap` → `level-cap` (`resumesAt = resetsAt`). `estimatePct` =
   `estimateTokens / tokensPerPct` when both are known, else 0.
4. Short window, not stale, `pct > 70` → `window-busy` (`resumesAt = resetsAt`).
5. Weekly-kind window, not stale: if `projectedPct` (§6.5) is known and `> 80` → `projected-high`;
   if unknown, apply rule 4's `pct > 70` instead (`window-busy`).

A `stale` window (its reset passed, the provider has not published the new window) is treated as a fresh
window: rules 4–5 skipped, `bgPct = 0`.

Thresholds (70, 80), `BATCH_SHARE` and the level caps are exported constants.

### 5.4 Recording

`record` is called with REAL usage (the runner's `usage`, never its size estimate `tokens`):

- prices it at list price (§5.5) and adds it to the day's total per work type and mode;
- in plan mode adds `tokensSent(usage)` to `bgTokensSinceTick` of every governing window, and when
  `inLedger === false` also to `bgNotInLedgerSinceTick` (§6.2). `tokensSent` is exported from
  `modelLedger.mjs` and reused (input + output + cacheRead + cacheWrite);
- keeps per-work-type daily totals (calls, usd, tokens) for 60 days.

Who records what:

- Ephemeral runs (knowledge and CTO ambient, both through `ctoSessions.runEphemeral`): after the run,
  `inLedger: false` — ephemeral sessions are deleted after the call and the ledger drops deleted sessions.
- Overnight delegate jobs: INCREMENTALLY, from the delegate sweep's usage fold (the place that updates
  `jobProgress.usage`): each sweep records the delta of `jobProgress.usage.tokens` since the last record
  (approximating `tokensSent`; it includes reasoning) and of `costUsd` when not partial (else priced),
  `inLedger: true` (the job's session persists). A final record at the terminal transition catches the rest.
- Backfill: as its runs finish, like ephemeral runs.

The knowledge subsystem keeps writing its own `budget_ledger` rows for its per-class report; the CTO keeps
writing `budget.json` day buckets (the ROI roll reads them), now with the shared price.

### 5.5 Pricing

One path for both subsystems: move `normalizeTokens`, `priceTokens`, `resolveRates` from
`knowledge/budget.mjs` into the shared module (an unpriced model is charged at the dearest priced model of
its band, so the cap always applies). `ctoBudget.priceTokens` (unpriceable → $0) stops being used for
spend; the ROI month totals change accordingly (noted in the PR body). A recorded `usd` from a session is
used as-is.

## 6. Background share of a window

Plan usage is reported per account. Background work's share is attributed proportionally to token counts
measured the same way on both sides.

### 6.1 State per window key `"<adapter>:<kind>"`

```
{ resetsAt, windowStart: number|null, bgPct, bgTokensSinceTick, bgNotInLedgerSinceTick,
  lastTick: {at, pct} | null, tokensPerPct: number|null }
```

### 6.2 Tick (`tick()`: a 10-minute poller, plus on every `usage.updated`)

For each plan window of each snapshot:

1. **Reset**: the stored `resetsAt` has passed (`now >= stored.resetsAt`) OR the new `resetsAt` is more
   than 1 hour later than the stored one. (Codex reports `resetsAt = now + reset_after`, which drifts by
   seconds every poll; multi-seat aggregates can drop pct when the seat switches — neither is a reset, so
   pct drops alone are ignored.) On reset: `windowStart` = the old `resetsAt` (or the window's own
   `startedAt` when present), `bgPct = 0`, both token counters `= 0`, `lastTick = {at: now, pct}`; stop.
   First sighting: `windowStart = startedAt ?? null`, `lastTick = {at: now, pct}`; stop.
2. `L` = `providerTokenTotals({sinceMs: lastTick.at})` summed over the snapshot's `providerIDs`;
   `null` → skip this window this tick (counters carry forward).
3. `T = L + bgNotInLedgerSinceTick` — all tokens of these providers since the last tick, background ones
   counted exactly once.
4. `dPct = pct - lastTick.pct`. If `dPct <= 0`: keep `lastTick` and both counters (pct moves in coarse
   steps; the tokens are attributed when it moves). Stop.
5. If `T > 0`: `bgPct += dPct × min(1, bgTokensSinceTick / T)`, and `tokensPerPct = T / dPct` when
   `dPct >= 1` (else keep the previous). If `T = 0` the movement came from another device or the
   provider's web app: nothing is attributed.
6. `lastTick = {at: now, pct}`, both counters `= 0`.

### 6.3 Between ticks

`inFlightPct = bgTokensSinceTick / tokensPerPct` when `tokensPerPct` is known (fall back to the optimizer
pacing state's `pressureWindows()[key].tokensPerPct`), else 0 (the next tick catches up; overnight jobs
record incrementally, so overshoot is bounded by roughly one sweep plus one tick of background work).

### 6.4 Known limits (stated in the UI help, not hidden)

- Attribution is by raw token share; cache reads count fully on both sides. Background work with large
  cached contexts is over-counted relative to quota weighting — the error is conservative.
- On first install or first sighting of a window, the share starts at 0 mid-window.

### 6.5 Projected end of a weekly window

`projectedPct = pct × span / elapsed` with `span = resetsAt - windowStart`, `elapsed = now - windowStart`,
known only when `windowStart` is known and `elapsed >= 0.2 × span`. This counts idle time in the rate
(unlike `optimizer/forecast.forecastAtReset`, which extrapolates the median ACTIVE burn rate and on this
box's history exceeds 80 % in most windows that actually ended below it). Not used for short windows.

## 7. Background CTO integration

### 7.1 Gate placement — the model is only known inside the runner

`ctoSessions.runEphemeral` gains a `preflight({taskClass, tier, model})` dependency, called after model
resolution and before each dispatch attempt (including failover and tier escalation); a `null` model is
passed as `resolveDefaultModel()`. A refusing preflight ends the run with `{ok:false, code:"budget",
reason}` and makes no model call. The knowledge runner (`knowledge/integration.mjs`) and the CTO ambient
runner both pass a preflight that calls `check({workType, model})`.

Callers' existing early gates (`capture`, `curator`, `corrections`, `skills`, `trial`, CTO
`beginEphemeral`) stay, as cheap early exits, calling `check` with the model their class resolves to
(`resolveModelForClass`, or the default model when the class is unpinned). The preflight is authoritative.

### 7.2 Ambient

- `beginEphemeral`'s cap test (`budget.isCapHit` + `budgetAmbientCapUsd`) becomes the early `check`.
  Only `usd-cap` and `level-cap` refusals flip thrifty mode (`setThrifty(true, {reason:"cap_hit"})`);
  `window-busy`, `projected-high`, `exhausted`, `unavailable` refuse the call without flipping thrifty
  (thrifty only clears at local midnight, so a transient condition must not shed rollups all day). The
  error code stays `cto_cap_hit` for compatibility; the ledger row carries the reason.
- The usage-burn watcher (`ctoEngine.mjs` ~:1493, `ctoWatchers.mjs`) and the A2 watchdog read
  `usdToday({workType:"cto-ambient", mode:"payg"})`-based figures; the watchdog's floor uses
  `dailyCapUsd / 24`. On a plan the watchdog sees no payg spend and stays quiet — runaway protection there
  is the level cap.

### 7.3 Overnight

- Selection: the overnight portfolio no longer uses `spendableFrac` as a budget fraction against
  `predictedCost: 1`. `adaptiveCtoOvernight.budget` returns `spendableFrac: null` (select by the
  scheduler's own limits) when `check({workType:"cto-overnight", model, estimateUsd})` passes, and `0`
  when it refuses. `estimateUsd` = the existing `nightModelCost` × the candidate's estimated tokens.
- The overnight job's model is pinned: dispatch passes the model the budget checked (the configured
  default model, today's `nightModelCost` source) to `startDelegateJob`, so the checked provider is the
  billed one.
- Every overnight tick re-evaluates; a refusal stops dispatching until a later tick passes (a 23:00
  `window-busy` does not cancel a night whose 5-hour window resets at 01:00).
- The reserve: `computeSpendable` still runs for the Health card, with the §1 bugs fixed — plan
  providers are those whose snapshot is plan mode (§4), the binding window is the governing window with
  the highest `pct`, `remainingPct = 100 - pct`, and the provider is that snapshot's adapter (no
  hard-coded `"anthropic"`). `nightCapUsd()`, `overnightSpendUsd()`, the windowless night-cap branch and
  the `cto.overnight.night_cap_hit` row are removed; a refusal is ledgered once per night as
  `cto.overnight.budget_refused {reason}`.
- Overnight dispatch also requires `goodMomentForBatch` (§8); at night rule 1 normally holds.

## 8. Timing: spare quota, presence, near-reset

`userAway()` = the desktop is not `present` (`push.desktopState`) AND no user-started turn on the box in
the last 15 minutes (the CTO engine's last-user-prompt time; a phone user counts as present).

- **Continuous work** runs whenever `check` passes.
- **Batch work** becomes due on its existing schedule (`TIDY_EVERY_MS`, `corrections.shouldRun`, the
  trial queue, the overnight window, backfill) but only STARTS when `check` passes AND one of:
  1. `userAway()`;
  2. plan mode and a governing weekly-kind window resets within 24 h (spare quota about to be wasted);
  3. the job has been due for more than 48 h (it must not starve).
  A refused batch job stays due and is retried by its own poller (no new scheduler). Each start is logged
  with the rule that admitted it (§11).

## 9. Configuration and migration

New config key (`local.mjs` defaults):

```
backgroundWork: { level: "normal", dailyCapUsd: 5 }
```

- `config:update` (`rpc.mjs`) gains validation for this key: `level ∈ {off, light, normal}`,
  `dailyCapUsd` a number 0–100 rounded to cents; a partial object is MERGED into the stored one (today's
  `configUpdate` is a shallow replace, which would drop `dailyCapUsd` when only `level` is sent); an
  invalid value is rejected with a message the UI shows. Invalid stored values read as defaults.
- Retired keys `ctoAmbientCap`, `ctoAmbientCapUsd`, `ctoNightCapUsd`: no longer read; stripped from the
  config by `config:update`; a write of them from an older desktop is ignored (not an error — an error
  would fail the whole config save).
- Knowledge settings: `dailyCapUsd` leaves the schema; `applyPatch` keeps a `case "dailyCapUsd"` that sets
  `backgroundWork.dailyCapUsd` (an older desktop's cap input keeps working and means the same thing now).
  The settings read still returns `dailyCapUsd` mirroring `backgroundWork.dailyCapUsd` so an older
  desktop's card renders; `MAX_DAILY_CAP_USD` moves to the shared module.
- No user action on upgrade (defaults apply on first read).

Readers to update (from review): `ctoHealth.mjs` (cap row), `index.mjs` health/cto config payload
(~:5763), `knowledge/engine.mjs` (status `capUsd`/`capReached`, notice copy), `ctoBackfill.mjs`,
`ctoWatchers.mjs`, renderer `CtoPanel.tsx`, `ctoView.ts`, `settings/KnowledgeCard.tsx`,
`knowledgeFormat.ts`, `types.ts`, `api.ts`, and the tests `knowledge/contract.test.mjs`, `ctoBudget`,
`ctoEngine.overnight`, `ctoHealth`, `ctoView`, `ctoSettingsTau`. The iOS app and the opencode plugins do
not reference these keys.

## 10. UI

**Home: Settings → Models**, a `BackgroundWorkCard` next to the Optimizer card (the full controls). The
Knowledge card and the CTO pane show a one-line status from the same data plus a "Change" link that opens
that card, and their own work types' share (`byWork`).

Card contents:

- **Background work on plans** (shown only when at least one plan provider exists, listing them):
  Off / Light / Normal — the existing `Segmented` control (native radio semantics; modern-web-guidance
  guides `forms`, `accessibility`, `brand-consistent-forms`). Help: "Uses spare plan quota only: up to 5%
  of a week and 10% of a 5-hour window on Normal. Background work pauses while you're using a window
  heavily."
- **API keys: daily cap** (shown when at least one pay-per-token provider exists, listing them, or when a
  plan is in fallback): dollar input; "0 turns background work off on API keys". Shows today and
  month-to-date: "$1.20 of $5.00 today · $18.40 this month".
- **Status**, one row per plan provider: "Background work used 2% of your Claude week · 4% of this 5-hour
  window". When paused, the reason and when it resumes:
  - `level-cap`: "Reached this week's background limit (5%) — resumes Thu 09:00"
  - `window-busy`: "Paused — your 5-hour window is 74% used — resumes at 14:00 or when you ease off"
  - `projected-high`: "Paused — this week is on track to end at 86% — resumes Mon 09:00"
  - `exhausted`: "Your Claude week is used up — resumes Mon 09:00"
  - `off`: "Off on plans"
  - `usd-cap`: "Reached today's $5.00 API-key cap — resumes at midnight"
  - `unavailable`: "Background work is waiting — the budget couldn't be read"
  - fallback: "Claude usage unavailable — limited by the $5 daily cap until it returns"
  - due batch job waiting: "Weekly tidy waiting for a quiet moment"
- The CTO thrifty banner shows the reason in the same words, not a bare "cap hit".
- Every control reports its outcome (AGENTS.md "never stub a control").

Wire: `background:status` rpc → `BudgetStatus`; settings through `configGet` / `config:update`. Refetch on
open + 30 s while visible.

```
BudgetStatus = {
  level, dailyCapUsd, payg: { providers: string[], usdToday, usdMonth },
  plans: [{ adapter, planLabel?, fallback: boolean,
            windows: [{key, kind, label, pct, bgPct, cap, projectedPct|null, resetsAt}],
            paused: null | {reason, windowKey?, value?, resumesAt|null} }],
  waitingBatch: [{workType, dueSince}],
  byWork: [{workType, calls, usd, tokens}]   // today
}
```

## 11. Evidence log (for the follow-up routine)

Append-only `~/.manta/background-budget.jsonl` (state path; rotated/pruned to 60 days, the
`delegateLivenessLog.mjs` pattern). Rows:

- `refused {ts, workType, reason, key, pct, projectedPct, bgPct, count}` — coalesced per
  (workType, reason, hour) with a count;
- `batch-start {ts, workType, rule, desktopState, userAway, hoursToReset, pct, projectedPct, dueForH}`;
- `spend {ts, workType, mode, tokens, usd, key}`;
- `tick {ts, key, dPct, T, bgTokens, bgPct, tokensPerPct}`;
- `window-close {ts, key, finalPct, bgPct, cap, hit100At|null}` — written at reset.

## 12. Libraries considered

| Need | Chosen | Considered, and why not |
|---|---|---|
| Budget gate / quota accounting | own module | `bottleneck` 2.19.5 (MIT, 15.5M/wk, last publish 2019-08), `rate-limiter-flexible` 11.5.0 (ISC, 4.7M/wk, 2026-11): request rate / concurrency limiters; neither models a share of an externally reported quota window. `p-limit` 7.3.3: concurrency only. |
| Usage windows | existing `usage.mjs` poller | — |
| Tokens per pct | measured in §6.2, falling back to `optimizer/pacing.mjs` | Using pacing's `tokensPerPct` as the primary: its numerator comes from the ledger, which excludes deleted ephemeral sessions — the very background work being measured. |
| End-of-window projection | own linear projection (§6.5) | `optimizer/forecast.forecastAtReset`: extrapolates active-only burn, pessimistic on idle boxes (measured on this box's history). `ctoForecast` forecasts next-day demand, not end-of-window. |
| Presence | `push.desktopState` + CTO last-prompt time | — |
| Persistence | `jsonStore` atomic writes + store mutex; JSONL evidence log on the existing pattern | `lowdb` 7.0.1 (MIT, 2.1M/wk, last publish 2023-12): extra dependency for what the atomic writer already does. |
| Pricing | knowledge pricing moved to the shared module | `ctoBudget.priceTokens`: prices unpriceable models at $0. |
| Level control | existing `Segmented` | — |

## 13. Tests

Server (`node:test`, injected I/O):

- `backgroundBudget.test.mjs`: billing mode (no adapter, credit, subscription, codex with balance,
  missing snapshot → fallback); every rule and reason incl. stale windows, unknown projection, batch
  ceiling vs continuous, estimates; payg cap incl. 0; tick: reset by passed resetsAt and by > 1 h jump,
  NOT by codex drift or a pct drop; dPct ≤ 0 carries counters; `L = null` skips; not-in-ledger tokens in
  the denominator once; T = 0; projection gating (< 20 % elapsed, unknown start); in-flight estimate;
  `goodMomentForBatch` rules 1–3 and refusal; `userAway` with phone activity; store round trip; evidence
  rows and coalescing; pricing fallback.
- `ctoSessions`: preflight runs per attempt (failover, escalation), refuses before any call, `null` model
  → default.
- knowledge: gates through `check`; settings mirror + legacy `dailyCapUsd` write.
- CTO: thrifty only on `usd-cap`/`level-cap`; overnight seam (plan detection, `remainingPct = 100 - pct`,
  binding window, adapter provider, pinned model, a default-cost job IS selected when `check` passes);
  incremental overnight recording; watchdog floor.
- `rpc` `config:update`: merge, validation, retired-key stripping.

Renderer (vitest): status copy for every reason incl. fallback and waiting batch; payg line with month;
visibility rules for the two controls; save error path.

Heavy verification runs on Freestyle VMs (`~/.local/bin/fs-run.sh`), never on the dev box.

## 14. Follow-up routine

Created when the PR merges (`routine_create`, weekly for 3 weeks, then disables itself): reads
`background-budget.jsonl` and the usage history; reports per window per week the background share, each
pause reason's frequency, which rule admitted batch starts (away / near reset / overdue), and any week the
user hit 100 % while background work had spent in the preceding 24 h. Informs: adjusting the level caps,
`BATCH_SHARE`, the 70/80 thresholds.

## 15. Review changes (rev 1 → rev 2)

Attribution counts deleted ephemeral sessions (`inLedger`), carries counters over flat ticks, and
detects resets by `resetsAt` only; the gate moved into the runner (preflight) because the model is
resolved there; overnight selection stops using `spendableFrac` against unit costs; the active-burn
forecast was replaced by a time-weighted projection for weekly windows; batch ceiling at 60 %; thrifty only
on cap refusals; watchdog on payg ambient spend; presence includes phone activity; config merge and
validation; older-desktop compatibility; UI home in Settings with status lines in the panes; evidence log.

## 16. Out of scope

Routines; the CTO effort tier; the optimizer's pacing and routing; per-seat budgets (the aggregate
snapshot governs).


## 17. Rev 3 amendments (normative — these override earlier sections)

**Gate and runner**

1. One `createCtoRunner` wrapper (shape of `createKnowledgeRunner`) injects `preflight` and `reportCost`
   into `runEphemeral`; ALL CTO call sites use it (`index.mjs` ~2785, ~2827, ~3324, ~3420
   `gatedSuggestionEphemeral` — which today records nothing —, `ctoEngine.mjs` ~1228, the backfill
   runner). `runEphemeral` without a preflight refuses (`code:"budget"`, reason `unavailable`) — tested.
2. Preflight refusal code `budget` joins `ctoRunOutcome` `CODES` (no `unknown-error` rows) and is a local
   failure (no failover/escalation). Knowledge callers map it to their existing cap path
   (`{status:"cap"}` + `noteCapReached`; trial `cap-reached`), never "failed"/retry-with-skip.
3. Thrifty is flipped by the engine-supplied preflight, only on `usd-cap` and a WEEKLY-kind `level-cap`
   (a short-window `level-cap` clears within hours; thrifty clears only at midnight). `beginEphemeral`
   drops its budget test (it has no task class); it keeps its rate limits.
4. An `estimated` run (no real usage) records its size estimate rather than nothing.

**Accounting**

5. Batch work is tracked separately: per window `batchPct` (plan) and per day `batchUsd` (payg), alongside
   the totals. Batch is refused when `batch ≥ 0.6 × cap` OR `total ≥ cap`. Within 24 h of a governing
   weekly-kind window's reset the batch ceiling lifts to the full cap.
6. §6.2 step 4: `dPct === 0` carries counters; `dPct < 0` (seat switch) rebases
   `lastTick = {at: now, pct}` and zeroes both counters, keeping `bgPct`.
7. Absent `resetsAt`: stored absent + new present = first sighting; `resumesAt = null`; no reset detection
   without `resetsAt`.
8. Weekly-kind `windowStart` when unknown: `resetsAt − 7 days` (`weekly_scoped:*` included). Short windows
   keep `null`.
9. Tokens recorded while a plan is in fallback (snapshot missing) are kept per adapter and added to that
   adapter's windows' counters at the next successful tick.
10. Near the end of a week (≤ 24 h to reset) the weekly projection rule is replaced by
    `pct + (levelCap − bgPct) ≤ 95`.
11. `projected-high` `resumesAt = min(resetsAt, windowStart + (pct / 80) × span)` (when usage stays flat).

**Overnight**

12. No cost estimates (`estimateUsd`/`estimateTokens` are removed from the API): the seam has no
    candidate and the only token figure is a prompt-size estimate. `check` runs in `dispatchPlan` per
    dispatch. A running job is never interrupted on crossing a cap; caps bound new dispatches.
13. Model pin: the box default model if it is in the subagent-approved (ticked) set, else the candidate's
    `modelHint` if ticked, else do not dispatch and ledger `cto.overnight.budget_refused {reason:
    "no-model"}`. PR body states that pinning turns Auto routing off for overnight jobs.
14. Incremental recording: the delegate record gets `budgetWorkType` (set for overnight dispatches —
    `actor:"cto"` alone does not identify them) and a persisted cursor `budgetRecorded: {tokens, usd}`.
    A hook at both usage-fold sites (`delegate.mjs` ~2660 and ~4999), invoked OUTSIDE the jobs lock,
    records the delta past the cursor and advances it; restart-safe, no double count.
15. Watchdog: both measured burn and the expected baseline read the shared module's `cto-ambient` payg
    daily totals (not `budget.json`, which also holds plan-mode and overnight spend).

**Presence and timing**

16. `lastUserPromptAt`: a small in-memory tracker on manta-server's opencode event pump — a user message
    in any session that is not background (ephemeral, delegate job, routine run, CTO conversation) sets
    it. Exposed to the budget; after a restart it is 0.
17. Weekly batch jobs (`knowledge-corrections`, `knowledge-tidy`) in plan mode become due at
    `resetsAt − 24 h` of the governing weekly window once their own interval has elapsed; the 48 h overdue
    rule counts from that moment. (Payg: their existing schedule.)

**Config and compatibility**

18. One exported validate-and-merge function for `backgroundWork`, used by `config:update` AND by the
    knowledge settings legacy `dailyCapUsd` case; it calls `syncState.applyConfig` like other writes.
19. Knowledge settings wire mirrors `spentTodayUsd` as payg background spend only (so an older desktop
    never shows "waits until tomorrow" for plan-mode list-price spend). Older desktops' CTO cap inputs
    revert silently — accepted for the short version-skew window, noted in the PR body.

**Status and copy**

20. `BudgetStatus`: each plan row and the payg block carry `paused` (continuous work, box default model)
    AND `batchPaused`. Copy for batch: "Larger jobs paused — they've used their share of this week (3%);
    capture continues."
21. Copy fixes: `window-busy` short → "Paused — your 5-hour window is 74% used. Resumes at 14:00, when it
    resets."; weekly fallback → "this week is 74% used"; `projected-high` → "…on track to end at 86% —
    resumes around Sat 06:00 if usage stays flat"; a projection above 100 is shown as "on track to run out
    before the reset".

**Evidence log**

22. `refused` rows add `class`, `cap`, `ceiling` (true when the batch ceiling, not the cap, refused);
    `spend` rows add `class`, `fallback`; `tick` and `window-close` add `batchPct`; window state keeps
    `hit100At` (first tick with `pct ≥ 100`) for `window-close`.
