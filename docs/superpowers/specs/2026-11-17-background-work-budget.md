# Background work budget — one budget for shared knowledge and the background CTO

Status: draft rev 2 (2026-11-17) — rev 1 reviewed by two Fable 5.2 reviewers; all Blocker/Should findings addressed.
Owner: box server (`src/server/`), desktop renderer (`src/renderer/`)

## 1. Problem

Two subsystems spend model calls the user did not ask for:

- **Shared knowledge** (`src/server/knowledge/`, PR #1688): capture, curator batches, the weekly
  corrections pass, the weekly tidy, skill trials. Bounded by knowledge `dailyCapUsd` ($1/day,
  `knowledge/budget.mjs`, `knowledge/settings.mjs`).
- **Background CTO**: ambient calls bounded by `ctoAmbientCap` ($2.50/day, `ctoBudget.mjs`); overnight
  jobs bounded by a plan-window reserve or `ctoNightCapUsd` ($5/night); the history backfill by its own
  one-off $3 (`ctoBackfill.mjs`).

Everything is priced in list-price dollars. On a subscription plan (Claude Max, ChatGPT Pro, Kimi) those
dollars are fictional: the real cost is plan quota, which is either spare (wasted at the window reset) or
scarce (taken from the user). A dollar cap is both too tight (stops useful work while quota idles) and too
loose (does not see the user running out). On a pay-per-token key the dollars are real.

Bugs in the overnight budget seam (`index.mjs`, `adaptiveCtoOvernight.budget`, ~2893-2945), confirmed by
review:

1. It filters snapshots on `s.windowed === true`; snapshots never carry `windowed` (only adapter objects
   do, e.g. `usageAdapters/claude.mjs`), so every plan is treated as windowless.
2. It passes the window's `pct` (percent **used**) as `remainingPct`, picking the most-used provider as
   "most headroom".
3. The windowless lookup `s?.windowed === false` never matches either, so the provider is always the
   hard-coded `"anthropic"`.

These bugs are why overnight jobs run today at all: the windowed path, if reached, yields a spendable
fraction ≤ 0.4 while every candidate job costs 1 (`ctoOvernight.mjs` `selectPortfolio`), so fixing the
bugs alone would stop overnight work on plans. §7.3 handles both.

## 2. Goal and decisions

User decisions (2026-11-17):

- **One budget** governs all background work of shared knowledge AND the background CTO (ambient,
  overnight, backfill). Routines keep their own controls (out of scope).
- **Plans** are budgeted as a share of plan quota windows; setting **Background work on plans:
  Off / Light / Normal**, default **Normal**.
- **Pay-per-token** (API keys, credit accounts) keeps a dollar cap, **$5/day** default, user-editable.
- Plans use **spare quota only**, prefer running while the user is away, and run weekly batch jobs close
  to a window reset when that quota would otherwise be wasted.
- Plan usage is shown in plan terms ("2% of your Claude week").

Decisions made in this spec (listed in the PR body for the user to veto):

- **D1 — The CTO night cap and ambient cap fold in.** `ctoAmbientCap`, `ctoNightCapUsd` (and the legacy
  `ctoAmbientCapUsd`) are retired. On pay-per-token there is ONE daily dollar cap for all background
  work; §5.4 keeps batch jobs from starving continuous work. Old values are not carried over.
- **D2 — On plans, the level caps replace the overnight reserve as the selection bound.** The reserve
  forecast keeps running for the Health card only. Consequence the user should know: overnight work on a
  plan is bounded by Normal = 5% of a week / 10% of a 5h window, far less than the reserve allowed.
- **D3 — Overnight CTO jobs pin their model** to the box default model (the model `nightModelCost`
  already prices) so their billing mode is known before dispatch.
- **D4 — The gate fails CLOSED** (today's CTO gate fails open): if the budget cannot read its own state,
  background work waits.
- **D5 — The pay-per-token cap and the plan level are independent.** "Off" stops plan background work
  only; `$0` stops pay-per-token background work. The UI names the providers each control governs and
  hides a control that governs nothing on this box.

## 3. Definitions

- **Background work**: a model call or job started by shared knowledge or the background CTO. Each has a
  **work type** and a **class** (§5.1).
- **Window**: a `UsageWindow` (`usage.mjs`): `kind`, `pct` = percent USED, `resetsAt`, optional
  `startedAt`, `stale`, `active`, `models`. **Weekly-kind** = `kind` starts with `"weekly"` (includes
  `weekly_scoped:*`); every other kind is **short** (5h session, daily…).
- **Window key**: `"<adapter>:<kind>"` (the key `usage.mjs` history and `optimizer/forecast.mjs` use).
- **bgPct**: pct-points of a window consumed by background work since the window started (§6).
- **Level caps**:

  | Level | weekly-kind | short |
  |---|---|---|
  | Off | 0 | 0 |
  | Light | 2 % | 5 % |
  | Normal (default) | 5 % | 10 % |

- **Batch ceiling**: batch-class work may only use the first **60 %** of a cap (plan: of each level cap;
  pay-per-token: of `dailyCapUsd`). Continuous work may use 100 %.
- **User away**: desktop presence is not `present` (`push.desktopState`) AND no user-started turn on the
  box in the last 15 minutes (the CTO engine's last-user-prompt signal, `ctoEngine.mjs` ~2919-2931;
  expose it to the budget as an injected `lastUserPromptAt()`). Covers a user working from the phone with
  the desktop closed.

## 4. Billing mode of a model

For `{providerID, modelID}`:

1. `adapter = adapterForProviderID(providerID)`. None → **pay-per-token**.
2. The adapter's aggregate snapshot in `listSnapshots()`. Missing (adapter failing, never fetched) →
   **pay-per-token with `fallback: true`** (the bounded option; the UI says why, §10).
3. `snapshot.kind === "credit"` → **pay-per-token**. Otherwise → **plan** (a subscription that also reports
   a balance, codex, is plan).

Governing windows of a plan call: the snapshot's windows with `active !== false` that apply to the model
(reuse `windowAppliesToModel`, `src/shared/seatChoice.mjs`; do not copy it).

A `null` model (non-strict classes resolve to "box default") is resolved to the box default model
(config `defaultModel`, else opencode's default) before classification.

## 5. The shared module

New `src/server/backgroundBudget.mjs`, dependency-injected, created once in `index.mjs`, passed to the
knowledge engine, the CTO engine, the overnight scheduler and the backfill. It replaces the cap logic of
`knowledge/budget.mjs` and the ambient/night-cap logic of `ctoBudget.mjs`.

### 5.1 Work types

| Work type | Owner | Class |
|---|---|---|
| `knowledge-capture`, `curator-notes`, `curator-rules`, `curator-skills` | knowledge | continuous |
| `knowledge-corrections`, `knowledge-tidy`, `knowledge-trial` | knowledge | batch |
| `cto-ambient` (every ambient model call) | CTO | continuous |
| `cto-overnight`, `cto-backfill` | CTO | batch |

The briefing and knowledge tools make no model calls and are never gated. The curator's 24 batches per
project per day stays. `cto-backfill` keeps its own one-off lifetime total ($3, `ctoBackfill.mjs`) in
addition to `check` — it is a one-time import ceiling, not a daily budget.

### 5.2 API

```
createBackgroundBudget({
  store,               // JSON state: jsonStore atomic writes under a mutex (ctoStores.patchStore pattern)
  log,                 // append-only JSONL evidence log (§11), delegateLivenessLog.mjs pattern
  configGet, listSnapshots, usageHistory /* getUsageHistory */,
  providerTokenTotals, // modelLedger.mjs
  getPrices, bandOf,   // pricing (§5.5)
  resolveDefaultModel, // () => {providerID, modelID} | null
  desktopState, lastUserPromptAt, now,
})
→ {
  check({ workType, model?, estimate? }) → Promise<Decision>
  record({ workType, model, usage?, usd?, inLedger, sessionId? }) → Promise<{usd, priced, mode}>
  goodMomentForBatch({ workType, model?, dueSince }) → Promise<{ok, reason, rule?}>   // §8
  tick()               // §6.2; run by its own 10-min poller AND on `usage.updated`
  status() → Promise<BudgetStatus>   // §10
  todayUsd({ workType?, mode? }) → number
}
Decision = { ok, mode: "plan"|"payg", fallback?: true, reason: null|ReasonCode, key?, resumesAt? }
ReasonCode = "off" | "level-cap" | "window-busy" | "projected-high" | "exhausted" | "usd-cap" | "unavailable"
```

- `model` omitted → the box default model (an advisory early check; see §5.6 for the authoritative one).
- `estimate` = `{usd?, tokens?}` for a batch job about to start (overnight uses `nightModelCost` × the
  job's estimated tokens; others omit it). Payg refuses when `spent + estimate.usd` exceeds the batch
  ceiling; plan refuses when `bgPct + estimate.tokens / tokensPerPct` exceeds it (skip when unknown).
- `check` and `record` never throw. `check` refuses with `unavailable` when its own state cannot be read
  (D4). `record` drops the spend on a store failure (logged; the call already happened).
- `resumesAt`: the window's `resetsAt` for plan refusals, next local midnight for `usd-cap`.

### 5.3 Decision rule (`check`)

Pay-per-token: `spent < cap` (cap = `dailyCapUsd`, or 60 % of it for batch); else `usd-cap`. Spend counted
is all background work in pay-per-token mode today (local day).

Plan — every governing window must pass:

1. level `off` → `off`.
2. `snapshot.exhausted` or `pct ≥ 100` → `exhausted`.
3. Short window, not `stale`, `pct > 70` → `window-busy`.
4. Weekly-kind window: `projected = projectedAtReset(window)` (§5.3.1). If known and `> 80` →
   `projected-high`. If unknown and `pct > 70` → `window-busy`.
5. `bgPct + inFlightPct ≥ cap` (level cap, or 60 % of it for batch) → `level-cap`.

A `stale` window (reset passed, new numbers not yet published) counts as fresh: rules 3–4 skipped, bgPct 0.
Thresholds 70/80, level caps and 60 % batch ceiling are exported constants.

#### 5.3.1 Projection (weekly-kind only)

`optimizer/forecast.forecastAtReset` is NOT used: it extrapolates the median of positive burn rates over
all remaining hours, ignoring idle time; replayed on this box's history it predicted > 80 % for ~2/3 of
windows that ended ≤ 80 % (review finding). Instead, time-weighted, idle time included:

```
start   = window.startedAt ?? accumulator.windowStart   // the previous resetsAt we observed (§6.1)
elapsed = (now - start) / (resetsAt - start)
projected = elapsed >= 0.2 ? pct / elapsed : null
```

No `start` known (first window after install, provider without `startedAt`) → `null`. Never guess a start
from an assumed window length (`UsageWindow` contract).

### 5.4 Recording

`record` is called with REAL usage (the runner's `usage` object, never the size estimate in `tokens`;
`ctoSessions.mjs` report hook) and:

- prices it (§5.5) and adds $ to today's totals per work type and per mode;
- plan mode: adds `tokensSent(usage)` (input + output + cacheRead + cacheWrite + reasoning — export
  `tokensSent` from `modelLedger.mjs` and add reasoning there too, so both sides use one formula) to the
  window accumulators of the call's adapter — to `bgLedgerTokens` when `inLedger`, else
  `bgOffLedgerTokens` (§6.2);
- appends a `spend` row to the evidence log (§11);
- keeps 60 days of daily totals.

`inLedger` is false for ephemeral sessions (they are deleted after each call, `ctoSessions.mjs` ~215;
`knowledge/trial.mjs` ~314; the ledger drops deleted sessions) and true for persistent sessions
(overnight delegate jobs).

Knowledge keeps writing its own `budget_ledger` rows for its per-class report (Knowledge card, measurement
routine); the CTO keeps writing `budget.json` day buckets for the ROI roll, using the usd returned by the
shared `record` (ROI moves to the shared pricing).

### 5.5 Pricing

One path: move `normalizeTokens`, `priceTokens`, `resolveRates` from `knowledge/budget.mjs` into the shared
module (an unpriced model is charged at the dearest priced model of its band, so caps always apply). A
recorded `usd` (opencode's own cost) is used as-is when present. `ctoBudget.priceTokens` (prices
unpriceable models at $0) is no longer used for budgets.

### 5.6 Where the gate runs

Callers do not know the model until the runner resolves it, and failover / tier escalation switch models
mid-run (`ctoSessions.mjs` ~263-314). So:

- **Authoritative gate**: `runEphemeral` (`ctoSessions.mjs`, used by both CTO ambient and every knowledge
  caller via `knowledge/integration.mjs`) gets a `deps.preflight({taskClass, model})` hook, called after
  model resolution (null → box default) and BEFORE `runEphemeralSession`, on every attempt. A refusal
  returns `{ok:false, code:"budget:<reason>"}` with no model call. Knowledge and CTO wire it to
  `check({workType, model})`.
- **Early gate** (cheap, avoids preparing work): existing `canSpend()` sites (`capture.mjs:435`,
  `curator.mjs:162/685`, `corrections.mjs:264/355`, `skills.mjs:419`, `trial.mjs:215`) and the CTO
  `beginEphemeral` gate call `check({workType, model: <class's resolved model if cheaply known, else
  omitted>})`.
- **Overnight**: model pinned (D3), passed explicitly to `startDelegateJob`; `check` + `goodMomentForBatch`
  before each dispatch.
- **Trials** (their own sessions, not `runEphemeral`) call `check` with their resolved model (resolved at
  `trial.mjs` ~240; move the gate after it).

## 6. Background share of a window (bgPct)

Plan usage is reported per account. Background share is attributed proportionally to tokens.

### 6.1 Accumulator per window key (persisted)

```
{ resetsAt, windowStart|null, bgPct, bgLedgerTokens, bgOffLedgerTokens,
  lastTick: {at, pct} | null, lastRatio: number|null /* tokens per pct */ }
```

### 6.2 Tick

Runs on its own 10-minute poller and on every `usage.updated` (which only fires on content changes), over
`listSnapshots()`. Per plan window:

1. **Reset**: a reset happened when `now ≥ accumulator.resetsAt` (old reset passed) or `resetsAt` advanced
   by more than 1 hour. (Codex computes `resetsAt = now + reset_after_seconds` every poll, and multi-seat
   aggregates drop pct on seat switches: neither a small `resetsAt` drift nor a pct drop alone is a
   reset.) On reset: `windowStart = old resetsAt` (if it is ≤ now), `bgPct = 0`, token counters 0,
   `lastTick = {at: now, pct}`, `resetsAt = new`. Append `window-close {key, finalPct: lastTick.pct, bgPct,
   cap, hit100At}` to the log. Stop.
2. No `lastTick` → set it, stop.
3. `L` = `providerTokenTotals({sinceMs: lastTick.at})` summed over the snapshot's `providerIDs`. `null`
   (ledger unavailable) → stop; keep everything for the next tick.
4. `T = L + bgOffLedgerTokens` (ephemeral background tokens are not in the ledger; persistent ones are,
   once). `B = bgLedgerTokens + bgOffLedgerTokens`. `dPct = pct - lastTick.pct`.
5. `dPct > 0` and `T > 0` → `bgPct += dPct × min(1, B / T)`, `lastRatio = T / dPct`, then
   `lastTick = {at: now, pct}` and token counters 0. Otherwise (no movement yet: pct moves in coarse
   steps) → keep `lastTick` and the counters so the tokens are attributed when pct moves. If `dPct ≤ 0`
   persists past 6 hours, reset `lastTick` and counters (nothing measurable happened).
6. Append `tick {key, dPct, T, B, bgPct, lastRatio}`.

### 6.3 Between ticks

`inFlightPct = (bgLedgerTokens + bgOffLedgerTokens) / ratio`, `ratio` = the optimizer pacing's measured
tokens-per-pct for the key (`optimizerPacing.pressureWindows()`), else `lastRatio`, else 0 (the next tick
catches up).

### 6.4 Known limits (stated in the card's help text)

- Attribution is by raw token share; cache reads count fully on both sides, so background work with large
  cached contexts is over-counted vs quota weighting — conservative.
- Usage from other devices / the provider's web app is attributed to nobody on this box (correct).
- On first install bgPct starts at 0 mid-window, and the weekly projection is unknown until one reset has
  been observed (unless the provider reports `startedAt`).

Rejected alternative: `bgPct = bgTokens / tokensPerPct` from the optimizer pacing alone. Its numerator
comes from the same ledger, which excludes deleted ephemeral sessions, so the conversion is biased exactly
where background work lives; it is used only for the between-ticks estimate.

## 7. Background CTO

### 7.1 Ambient

- `beginEphemeral`'s cap check (`budget.isCapHit` + `ambientCapUsd`) → early `check` (§5.6); the
  authoritative check is the runner preflight. Error code stays `cto_cap_hit` for compatibility; the reason
  goes in the ledger row.
- Thrifty mode flips only on `usd-cap` and `level-cap` (lasting conditions). `window-busy`,
  `projected-high`, `exhausted`, `unavailable` just refuse the call (they clear within hours; thrifty
  clears only at midnight).
- `reportAmbientSpend` → shared `record` with real usage, `inLedger:false`.
- Watchdog (`index.mjs` ~3590): measures `cto-ambient` **pay-per-token** dollars only, floor
  `dailyCapUsd / 24`. On plans the level caps bound runaway spend; list-price dollars there are not money
  and would false-trip the 2×/4× multiples.
- Readers of the retired caps updated: `ctoHealth.mjs` (~96, 143), `index.mjs` ~5763, the usage-burn
  watcher (`ctoEngine.mjs` ~1493, `ctoWatchers.mjs` ~186, 639), `ctoView.ts` ~127-149, `CtoPanel.tsx`.

### 7.2 Overnight

- Before each dispatch: `check({workType:"cto-overnight", model, estimate})` + `goodMomentForBatch`. A
  refusal stops dispatch for that tick only; the scheduler re-evaluates on its next tick. Only `off`,
  `usd-cap` and a weekly-kind `level-cap` end the night.
- Usage is recorded incrementally: the delegate sweep fold (`delegate.mjs` ~4988) already updates
  `jobProgress.usage = {tokens, costUsd, costPartial}`; for CTO overnight jobs it calls `record` with the
  DELTA since the last fold (`usage: {tokens: Δ}` treated as `tokensSent`, `usd: ΔcostUsd` when not
  partial, `inLedger:true`). So multi-hour jobs count in the ticks they run in.
- Removed: `overnightSpendUsd`, `nightCapUsd`, the windowless night-cap branch, the
  `cto.overnight.night_cap_hit` row. A refusal is ledgered `cto.overnight.budget_refused {reason}` once
  per reason per night.

### 7.3 Overnight seam

`adaptiveCtoOvernight.budget` becomes:

1. Resolve the pinned overnight model and its billing mode (§4).
2. Plan: binding window = the governing window with the highest `pct`;
   `computeSpendable({provider: adapter, remainingPct: 100 - pct, windowKind: kind, windowed: true})` for
   the Health card. The returned plan's `spendableFrac` is set to `null` (unbounded by fraction —
   selection is bounded by `check` per dispatch, D2).
3. Payg: `computeSpendable({windowed:false, provider: adapter ?? providerID})` for the Health card;
   `spendableFrac = 0` if `check` refuses, else `null`.
4. Tests pin: a subscription snapshot takes the windowed path; `remainingPct = 100 - used`; binding window
   = most used; a default-cost candidate is selected on a plan with headroom; nothing is selected after a
   `usd-cap` refusal.

## 8. Timing

- **Continuous work** runs whenever `check` passes.
- **Batch work** keeps its existing due schedule (`TIDY_EVERY_MS`, `corrections.shouldRun`, the trial
  queue, the overnight window, the backfill) but STARTS only when `goodMomentForBatch` is ok:
  `check` passes (batch ceiling) AND one of
  1. **away**: the user is away (§3);
  2. **near-reset** (plan): a governing weekly-kind window resets within 24 h — its unused quota is about
     to be lost;
  3. **overdue**: due for more than 48 h (must not starve; `check` still applies).
- A refused batch job stays due; its own poller retries (no new scheduler). Each start appends
  `batch-start {workType, rule, desktopState, hoursToReset, pct, projected, dueForH}`.

## 9. Configuration and migration

```
backgroundWork: { level: "normal", dailyCapUsd: 5 }      // ~/.manta/config.json, defaults in local.mjs
```

- `config:update` (`rpc.mjs` ~1057) gets a validating step for this key (`local.configUpdate` is a blind
  shallow merge): a partial `backgroundWork` patch is MERGED with the stored object; `level ∈ {off, light,
  normal}`; `dailyCapUsd` a number 0–100 rounded to cents; invalid values are rejected with a readable 400
  (the control shows it). The same step deletes `ctoAmbientCap`, `ctoAmbientCapUsd`, `ctoNightCapUsd` from
  the stored config on any write.
- Version skew (older desktop, newer box): a write of `ctoAmbientCap` / `ctoNightCapUsd` is dropped
  silently by that step (desktops auto-update; the window is short). Knowledge settings keep a
  `dailyCapUsd` case in `applyPatch` (it throws 400 on unknown keys, `knowledge/settings.mjs` ~122) that
  writes `backgroundWork.dailyCapUsd`, and the knowledge settings wire keeps returning `dailyCapUsd`
  (mirroring `backgroundWork.dailyCapUsd`) because an older `knowledgeFormat.ts` treats a missing value as
  capped. `MAX_DAILY_CAP_USD` moves to the shared module (100).
- No user action on upgrade: defaults apply on first read.

Every reader of the retired keys and fields is updated (from review): server `index.mjs` ~5763,
`ctoHealth.mjs`, `knowledge/engine.mjs` ~248 (notice copy) and ~406-408 (`capUsd`, `capReached` →
from `status()`), `local.mjs`; renderer `CtoPanel.tsx`, `ctoView.ts`, `knowledgeFormat.ts` ~87-93,
`settings/KnowledgeCard.tsx`, `types.ts` ~325/336, `api.ts` ~1059/1076; tests `knowledge/contract.test.mjs`
~214/245, `ctoBudget`, `ctoEngine.overnight`, `ctoHealth`, `ctoView`, `ctoSettingsTau`. iOS
(`mobile/native`) and `docs/opencode-plugins-v2` have no references.

## 10. UI

**Home: Settings → Models**, a `BackgroundWorkCard` beside the Optimizer card (it is a box-wide setting,
not a per-feature one). The Knowledge card and the CTO pane each show a one-line status from the same data
plus a **Change** link that opens Settings at the card, and their own work-type split ("Knowledge today:
14 calls"). The CTO thrifty banner shows the reason in words, not "cap hit".

Card contents:

- **Background work on plans** — Off / Light / Normal (existing `Segmented` control, radio semantics;
  guides `forms`, `accessibility`, `brand-consistent-forms`). Subtitle names the plans it governs
  ("Claude Max, ChatGPT Pro"). Hidden when no plan is connected.
- **API keys: up to $X/day** — dollar input; subtitle names the pay-per-token providers ("OpenRouter";
  "$0 turns it off"). Shows today and month-to-date ("$1.20 today · $23.40 this month"). Hidden when no
  pay-per-token provider is connected AND no plan is in fallback.
- **Status** per plan: "Used 2% of your Claude week · 4% of this 5-hour window (limits 5% / 10%)".
  Paused states, each with when it resumes:

  | Reason | Copy |
  |---|---|
  | off | "Off for plans." |
  | level-cap | "Reached this week's background limit (5%) — resumes Thu 09:00." / "…this 5-hour window's limit (10%) — resumes 14:30." |
  | window-busy | "Paused — your 5-hour window is 74% used. Resumes 14:30 or when it frees up." |
  | projected-high | "Paused — this week is on track to end at 86%. Resumes Thu 09:00." |
  | exhausted | "Your Claude week is used up — resumes Thu 09:00." |
  | usd-cap | "Reached today's $5.00 — resumes at midnight." |
  | unavailable | "Paused — couldn't read the budget. Retrying." |
  | fallback | "Claude usage unavailable — limited by the $5.00 daily API cap until it returns." |
  | batch waiting | "Weekly tidy waiting for a quiet moment (when you're away or before the week resets)." |

- Help text states the §6.4 limits in plain words.
- Every control reports its outcome (AGENTS.md "never stub a control"): saving shows a confirmation; a
  rejected value shows the server's message and restores the old value.

Wire: rpc `background:status` → `BudgetStatus`; writes via `configUpdate({backgroundWork: {...}})`.
Refetch on open + 30 s poll while visible.

```
BudgetStatus = {
  level, dailyCapUsd, spentUsdToday, spentUsdMonth,
  payg: { providers: [label] },
  plans: [{ adapter, label, fallback?: true,
            windows: [{key, kind, label, pct, bgPct, cap, projectedPct|null, resetsAt}],
            paused: null | {reason, key?, value?, resumesAt?} }],
  batchWaiting: [{workType, dueSince}],
  byWork: [{workType, calls, usd}]          // today
}
```

## 11. Evidence log

Append-only `~/.manta/background-budget.jsonl` (via `statePath`, the `delegateLivenessLog.mjs` pattern:
size-capped rotation), rows:

- `spend {ts, workType, mode, key?, tokens, usd}`
- `refused {ts, workType, reason, key?, pct?, projected?, bgPct?, count}` — coalesced per (workType,
  reason, hour) with a count
- `batch-start {…}` (§8), `tick {…}` (§6.2), `window-close {…}` (§6.2)

The follow-up routine (§14) reads only this file plus `usage-history.json`.

## 12. Libraries considered

| Need | Chosen | Considered, and why not |
|---|---|---|
| Budget gate / quota-share accounting | own module | `bottleneck` 2.19.5 (MIT, 15.5M/wk, last publish 2019-08) and `rate-limiter-flexible` 11.5.0 (ISC, 4.7M/wk, 2026-11) limit request RATE/concurrency; neither models "share of an externally reported quota window". `p-limit` 7.3.3 (455M/wk) is concurrency only. |
| Usage windows + history | existing `usage.mjs` poller | — |
| Tokens per pct | existing `optimizer/pacing.mjs` (between ticks only) + `modelLedger.providerTokenTotals` | pacing alone as the attribution: biased (§6.4). |
| Window projection | own 3-line time-weighted projection | `optimizer/forecast.forecastAtReset` (ignores idle time; measured too pessimistic, §5.3.1); `ctoForecast.mjs` forecasts next-DAY fractions, not end-of-window. |
| Presence | existing `push.desktopState` + CTO last-prompt signal | — |
| State persistence | existing `jsonStore` atomic writes + store mutex | `lowdb` 7.0.1 (MIT, 2.1M/wk, last publish 2023-12): a dependency for what the atomic writer does; state is a few KB. `node:sqlite` (knowledge's) would couple the CTO to the knowledge DB. |
| Evidence log | existing `delegateLivenessLog.mjs` pattern | a logging library: JSONL append with rotation already exists in-repo. |
| Pricing | knowledge's pricing, moved | `ctoBudget.priceTokens` (unpriced = $0, a cap could never trip). |
| Level control | existing `Segmented` | new control / select library. |

## 13. Tests

Server (`node:test`, injected I/O):

- `backgroundBudget.test.mjs`: billing mode (no adapter, missing snapshot → fallback, credit,
  subscription, codex with balance, null model → default); every rule and reason incl. stale windows,
  unknown projection, batch ceiling, estimates; projection (elapsed < 0.2, startedAt vs observed start);
  tick (attribution with on/off-ledger tokens, dPct ≤ 0 carry-forward, 6 h expiry, ledger null, codex
  resetsAt drift is NOT a reset, pct drop alone is NOT a reset, real reset sets windowStart and logs
  window-close); in-flight estimate fallbacks; `goodMomentForBatch` (away incl. phone-only user, near-reset,
  overdue, present mid-week refused); fail-closed on unreadable state; persistence round-trip; pricing
  fallback; evidence-log coalescing.
- `ctoSessions` preflight: called per attempt after resolution, refusal prevents the model call, null model
  → default.
- Knowledge: every early gate through `check`; `dailyCapUsd` settings case maps to the new key; contract
  test updated.
- CTO: ambient refusal reasons → thrifty only for usd-cap/level-cap; overnight §7.3 pins; incremental
  overnight recording from the sweep fold; watchdog uses payg ambient dollars only.
- `config:update` validation, merge of partial patches, retired-key deletion.

Renderer (vitest): status copy for every reason, fallback, batch waiting, hidden controls, save success and
error paths.

All verification on Freestyle VMs (`~/.local/bin/fs-run.sh`), never on the dev box.

## 14. Follow-up routine

Created when the change merges (`routine_create`, Mondays 09:00 for 3 weeks, then it disables itself).
Reads `background-budget.jsonl` + `usage-history.json` (read-only) and reports per week: bgPct per window at
close vs cap; refusals by reason; batch starts by rule (away / near-reset / overdue); weeks where the user
hit 100 % with background spend in the previous 24 h; payg dollars per day. Decision: adjust level caps
(5/10, 2/5), 70/80 thresholds, the 60 % batch ceiling.

## 15. Out of scope

Routines; the CTO effort tier; optimizer pacing/routing; per-seat budgets (the aggregate snapshot governs).
