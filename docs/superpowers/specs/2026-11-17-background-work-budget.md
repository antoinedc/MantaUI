# Background work budget — one budget for shared knowledge and the background CTO

Status: draft rev 1 (2026-11-17)
Owner: box server (`src/server/`), desktop renderer (`src/renderer/`)

## 1. Problem

Two subsystems spend model calls the user did not ask for:

- **Shared knowledge** (`src/server/knowledge/`, PR #1688): capture, curator batches, corrections pass,
  weekly tidy, skill trials. Bounded by `knowledge.dailyCapUsd` (default $1/day) in `knowledge/budget.mjs`.
- **Background CTO**: ambient work bounded by `ctoAmbientCap` ($2.50/day, `ctoBudget.mjs`), overnight
  jobs bounded by a plan-window reserve or, without a windowed plan, `ctoNightCapUsd` ($5/night).

Both price every call in dollars at list price. On a subscription plan (Claude Max, ChatGPT Pro, Kimi)
those dollars are fictional: the real cost is plan quota, which is either spare (and would be wasted
at the window reset) or scarce (and background work steals it from the user). A dollar cap is
simultaneously too tight (it stops useful work when quota is idle) and too loose (it does not see that the
user is about to run out). On a pay-per-token API key the dollars are real and a dollar cap is right.

Two bugs in the overnight budget seam (`src/server/index.mjs`, `adaptiveCtoOvernight.budget`):

1. It filters snapshots on `s.windowed === true`, a field `buildSnapshot` (`usage.mjs`) never sets, so
   every subscription is treated as windowless and the plan-window reserve never runs.
2. It passes the window's `pct` (percent **used**) as `remainingPct`, and picks the provider with the
   **highest** used percentage as the one with "most headroom" — the opposite of the intent.

## 2. Goal and decisions

User decisions (2026-11-17):

- **One budget** governs all background work of shared knowledge AND the background CTO (ambient +
  overnight). Routines keep their own controls (out of scope).
- **Subscription plans** are budgeted as a share of plan quota windows, through one setting
  **Background work: Off / Light / Normal**, default **Normal**.
- **Pay-per-token** (API keys, credit accounts) keeps a dollar cap: **$5/day by default**, user-editable.
- Background work on a plan uses **spare quota only**, prefers running while the user is away, and does
  its weekly batch jobs close to a window reset when that quota would otherwise be wasted.
- The UI states plan usage in plan terms ("2% of your Claude week").

Decisions made in this spec (flag to the user in the PR body; easy to revisit):

- **The CTO night cap folds in.** `ctoNightCapUsd` and `ctoAmbientCap` are retired. Overnight CTO work
  draws from the same budget: on a plan it is bounded by the level caps plus the existing overnight reserve
  (§7.3); on pay-per-token it shares the one daily dollar cap. Reason: two dollar caps for the same
  agent on the same key made the real daily ceiling the sum of three numbers in three places
  ($1 + $2.50 + $5), which no user could reason about.
- Old cap values are **not** carried over (the user chose a fresh $5 default).

## 3. Definitions

- **Background work**: every model call or job started by shared knowledge or the background CTO rather
  than by the user. Each has a **work type** (§5.1).
- **Billing mode of a call**: decided from the model the call will use (§4).
- **Window**: one `UsageWindow` of a usage snapshot (`usage.mjs`): `kind` ("session" = the 5-hour window,
  "weekly", or another kind), `pct` = percent USED (0–100), `resetsAt`, optional `stale`, `active`,
  `models`.
- **Background share of a window** (`bgPct`): the pct-points of that window consumed by background
  work since the window started (§6).
- **Level caps** (share of a window background work may use):

  | Level | weekly-kind window | any other kind (5h, daily…) |
  |---|---|---|
  | Off | 0 % | 0 % |
  | Light | 2 % | 5 % |
  | Normal (default) | 5 % | 10 % |

## 4. Billing mode

For a call on `{providerID, modelID}`:

1. `adapter = adapterForProviderID(providerID)` (`usage.mjs`). No adapter → **pay-per-token**.
2. The adapter's aggregate snapshot from `listSnapshots()`. Missing (never fetched, adapter failing) →
   **pay-per-token** (fail safe: the dollar cap applies; it is the bounded option).
3. `snapshot.kind === "credit"` → **pay-per-token**. Otherwise (`"subscription"` or absent with at least
   one window) → **plan**. A subscription that also reports a balance (codex) is plan (the existing
   rule in the `UsageSnapshot` typedef).

The windows that govern a plan call are the snapshot's windows with `active !== false` that apply to the
model (`windowAppliesToModel` from `src/shared/seatChoice.mjs` / `marginalCost.mjs` — reuse, do not copy).

Callers that do not know their model up front (none today) must resolve it before asking.

## 5. The shared module

New `src/server/backgroundBudget.mjs`, dependency-injected like `ctoBudget.mjs`. It REPLACES
`knowledge/budget.mjs`'s cap logic and `ctoBudget.mjs`'s ambient-cap/night-cap logic. Created once in
`index.mjs` and passed to the knowledge engine and the CTO engine/overnight scheduler.

### 5.1 Work types

| Work type | Owner | Class |
|---|---|---|
| `knowledge-capture`, `curator-notes`, `curator-rules`, `curator-skills` | knowledge | continuous |
| `knowledge-corrections` (weekly pass), `knowledge-tidy`, `knowledge-trial` | knowledge | batch |
| `cto-ambient` (every ambient model call) | CTO | continuous |
| `cto-overnight` (overnight delegate jobs) | CTO | batch |

The briefing and the knowledge tools (search/read/note) make no model calls and are never gated
(unchanged from the knowledge spec).

### 5.2 API

```
createBackgroundBudget({
  store,                 // JSON store: load(), save() with a mutex (use ctoStores.patchStore pattern / jsonStore atomic writes)
  configGet,             // → config; reads `backgroundWork`
  listSnapshots,         // usage.mjs
  usageHistory,          // usage.mjs getUsageHistory → for forecastAtReset
  forecastAtReset,       // optimizer/forecast.mjs
  providerTokenTotals,   // modelLedger.mjs ({sinceMs}) → {byProvider} | null
  getPrices, bandOf,     // pricing (moved from knowledge/budget.mjs, §5.5)
  desktopState,          // () => "present" | "away" | "gone"   (push.desktopState(push.getDesktopPresence()))
  now,
})
→ {
  check({ workType, model:{providerID, modelID} }) → Promise<Decision>
  record({ workType, model, tokens?, usd?, sessionId? }) → Promise<{usd, priced, mode}>
  goodMomentForBatch({ workType, model, dueSince }) → Promise<{ok, reason}>   // §8
  observe(snapshots)     // called from the usage poller's publish point (§6.2)
  status() → Promise<BudgetStatus>   // for the UI (§10)
  dailyUsd(day?) → number            // list-price $ today, all modes (watchdog, health)
}
Decision = { ok: boolean, mode: "plan"|"payg", reason: null | ReasonCode, detail }
ReasonCode = "off" | "level-cap" | "window-busy" | "forecast-high" | "exhausted" | "usd-cap" | "unavailable"
```

`check` never throws. If its own state cannot be read it refuses with `unavailable` (fail closed:
background work waits; it is never more important than the user's quota or money). A missing usage
snapshot is not an error — it is pay-per-token (§4).
`record` never throws either: a store failure is logged and the spend dropped (the call already happened).

### 5.3 Decision rule (`check`)

Pay-per-token: `ok = spentUsdToday < dailyCapUsd`; else reason `usd-cap`. `dailyCapUsd = 0` means no
background work on pay-per-token.

Plan, evaluated per governing window (all must pass):

1. level `off` → `off`.
2. `snapshot.exhausted` or `window.pct >= 100` → `exhausted`.
3. window not `stale` and `window.pct > 70` → `window-busy`.
4. `forecastAtReset(history, "<adapter>:<kind>", {now, resetsAt, currentPct: pct})` returns a number
   `> 80` → `forecast-high`. `null` (not enough history) skips this test.
5. `bgPct(window) + inFlightPct(window) >= levelCap(kind)` → `level-cap`.

A `stale` window (its reset has passed, the provider has not published the new window yet) is treated as
a fresh window: tests 3–4 skipped, `bgPct` = 0.

The thresholds (70, 80) and the level caps are module constants, exported for tests and the UI.

### 5.4 Recording

`record` is called once per finished call/job with its real usage:

- prices it at list price (§5.5) and adds the $ to today's local-day total in every mode (the CTO
  watchdog, the CTO health row and the "would have cost" figure read it);
- in plan mode adds `tokensSent(usage)` (input + output + cacheRead + cacheWrite — the SAME formula
  `modelLedger.providerTokenTotals` uses; export and reuse it) to the window accumulators of the
  provider (§6.1);
- keeps a per-work-type daily breakdown (calls, usd, tokens) for 60 days.

The knowledge subsystem keeps its own `budget_ledger` rows for its per-class report (the Knowledge card
and the measurement routine read it), but its `canSpend`/cap logic is replaced by `check`.

### 5.5 Pricing

One pricing path for both subsystems: move `normalizeTokens`, `priceTokens`, `resolveRates` from
`knowledge/budget.mjs` into the shared module (an unpriced model is charged at the dearest priced model
of its band, so a cap always applies). `ctoBudget.priceTokens` (which priced an unpriceable model at $0)
is no longer used for capping. A trial's recorded cost (`usd`) is stored as-is.

## 6. Background share of a window

Plan usage is reported per account, not per session. Background work's share is attributed
proportionally, from token counts both sides measure the same way.

### 6.1 Accumulators (persisted per window key `"<adapter>:<kind>"`)

See the end of §6.2 for the exact shape.

### 6.2 Tick (`observe(snapshots)`, at the usage poller's publish point, ~every 10 min)

For each plan window:

1. **Reset detection**: `resetsAt` moved forward, or `pct` dropped by more than 10 points (the same
   `RESET_DELTA` rule as `optimizer/forecast.mjs`) → `bgPct = 0`, `bgTokensSinceTick = 0`,
   `lastTick = {at: now, pct}`; stop here for this window.
2. With a previous tick: `T` = `providerTokenTotals({sinceMs: lastTick.at})` summed over the snapshot's
   `providerIDs` — the tokens ALL sessions of those providers sent since the last tick. Background work
   runs in ordinary opencode sessions (knowledge and CTO both use ephemeral sessions), so it is inside
   `T` exactly once.
3. `dPct = pct - lastTick.pct`. If `dPct > 0` and `T > 0`: `bgPct += dPct * min(1, bgTokensSinceTick / T)`
   and remember `lastRatio = T / dPct` (tokens per pct, §6.3). Otherwise add nothing (usage that moved
   with no tokens on this box came from another device or the provider's web app — not ours; no movement
   → nothing to attribute).
4. Store `lastTick = {at: now, pct}`, `bgTokensSinceTick = 0`.

`T` unavailable (`providerTokenTotals` returned `null`) → skip steps 3–4 for this tick: keep `lastTick`
and `bgTokensSinceTick` so the next successful tick attributes the whole span.

Accumulator shape (§6.1) therefore is
`{ resetsAt, bgPct, bgTokensSinceTick, lastTick: {at, pct} | null, lastRatio: number | null }`.

### 6.3 Between ticks (`inFlightPct`)

`inFlightPct = bgTokensSinceTick / tokensPerPct`, where `tokensPerPct` is the window's measured
conversion from the optimizer pacing state (`optimizerPacing.tokensPerPct` / its snapshot). When it is
unknown, use `lastRatio` (§6.2); when
that is unknown too, `inFlightPct = 0` and the next tick catches up. Overshoot is bounded by one tick of
background work; acceptable (the caps are soft budgets, not billing limits).

### 6.4 Known limits (document in the UI help text, not hidden)

- Attribution is by raw token share. Cache reads count fully on both sides; background work with large
  cached contexts is therefore over-counted relative to quota weighting — the error is conservative.
- On first install the share starts at 0 mid-window.
- If the usage poller is not running or the provider never reports, the call is pay-per-token (§4.2).

## 7. Background CTO integration

### 7.1 Ambient

- The pre-call gate in `ctoEngine.mjs` (`budget.isCapHit(cap)` + `budgetAmbientCapUsd`) becomes
  `backgroundBudget.check({workType:"cto-ambient", model})`. A refusal flips thrifty mode exactly as a cap
  hit does today (`setThrifty(true, {reason:"cap_hit"})`); the error code stays `cto_cap_hit` for
  compatibility, with the reason carried in the ledger row.
- `reportAmbientSpend` (`budget.record`) records into the shared budget (and may keep writing
  `budget.json` day buckets for the ROI roll, which reads `monthSpendUsd`).
- Watchdog (`index.mjs` `createWatchdog`): `getSpendPerHour` and `expectedHourlyBurn` keep working on the
  list-price $ meter; the floor that used `ambientCapUsd/24` uses `dailyCapUsd/24` (the payg cap).

### 7.2 Overnight

- Each overnight job dispatch first calls `check({workType:"cto-overnight", model})` and
  `goodMomentForBatch` (§8); a refusal selects nothing more tonight.
- A finished job records its real usage (the delegate record's usage, `jobProgress` usage) with
  `workType:"cto-overnight"`. The estimate-based `overnightSpendUsd` night-cap path is removed.

### 7.3 Overnight seam fixes (both §1 bugs)

`adaptiveCtoOvernight.budget` becomes:

1. Resolve the overnight model (the existing `nightModelCost` lookup's model) and its billing mode (§4).
2. Plan mode: take the governing window with the highest `pct` (the one that binds), call
   `computeSpendable({provider, remainingPct: 100 - pct, windowKind: kind, windowed: true})`. The
   reserve logic is unchanged; it now actually runs.
3. Payg: `computeSpendable({windowed:false, …})` keeps feeding the Health forecaster, but its
   `spendableFrac` is `0` when `check` refuses and `null` otherwise. `ctoNightCapUsd`,
   `nightCapUsd()`, `overnightSpendUsd()` and the `cto.overnight.night_cap_hit` row are removed; a
   refusal is ledgered as `cto.overnight.budget_refused {reason}` once per day.
4. Unit tests pin: a subscription snapshot is windowed; `remainingPct` = 100 − used; the binding window
   is the most-used one.

## 8. Timing: spare quota, presence, near-reset

- **Continuous work** runs whenever `check` passes.
- **Batch work** (weekly corrections pass, weekly tidy, skill trials, overnight jobs) becomes due on its
  existing schedule (`TIDY_EVERY_MS`, `corrections.shouldRun`, trial queue, overnight window) but only
  STARTS at a good moment — `goodMomentForBatch` returns ok when `check` passes AND one of:
  1. the desktop is `away` or `gone`;
  2. plan mode, and a governing weekly-kind window resets within 24 h and its forecast-at-reset is
     below 80 % (or unknown and `pct < 60`): quota that would otherwise be wasted;
  3. the job has been due for more than 48 h (it must not starve; `check` still applies).
  Overnight jobs already run at night; rule 1 or 3 normally holds for them.
- A refused batch job stays due and is retried by its own poller (no new scheduler).

## 9. Configuration and migration

New config key in `~/.manta/config.json` (via `local.mjs` defaults + `configUpdate`):

```
backgroundWork: { level: "normal", dailyCapUsd: 5 }
```

Validation: `level ∈ {off, light, normal}`; `dailyCapUsd` a number 0–100, rounded to cents. Invalid →
defaults.

Retired (read nowhere after this change; deleted from the config on the first write through
`configUpdate`, and from the knowledge settings store on its next save):
`ctoAmbientCap`, `ctoAmbientCapUsd` (legacy spelling), `ctoNightCapUsd`, knowledge `dailyCapUsd`
(`knowledge/settings.mjs`: drop the field, its validation and `MAX_DAILY_CAP_USD`). An RPC that still
sends a retired key is ignored, not rejected (an older desktop against a new box must not error).
The curator batch limit (24/project/day) stays.

No user action on upgrade: the new key's defaults apply on the first read (AGENTS.md "upgrades are
always automatic").

## 10. UI

One shared component, `src/renderer/BackgroundWorkCard.tsx`, rendered in BOTH the Knowledge card
(replacing the cap input, `KnowledgeCard.tsx` ~:499–556) and the CTO pane (replacing the ambient-cap and
night-cap inputs, `CtoPanel.tsx` ~:1327/:1388; `TonightBudgetCard` shows the new status instead of
"$x of $cap"). Same data, same writer.

Contents:

- **Background work on plans:** Off / Light / Normal — the existing `Segmented` control (a radio group;
  guides `forms`, `accessibility`, `brand-consistent-forms`). Help line: "Uses spare plan quota only:
  up to 5% of a week and 10% of a 5-hour window on Normal."
- **Pay-per-token daily cap:** a dollar input (cents), default $5.
- **Status**, one row per plan provider with a governing window, from `status()`:
  "Background work used 2% of your Claude week · 4% of this 5-hour window" and, when paused, why in plain
  words: "Paused — your 5-hour window is 74% used", "Paused — this week is on track to end at 86%",
  "Paused — reached today's Normal limit", "Off". Pay-per-token: "$1.20 of $5.00 today".
- Every control reports its outcome (AGENTS.md "never stub a control"): a failed save shows an error and
  keeps the old value.

Wire: `background:status` rpc channel → `BudgetStatus`; settings through the existing `configGet` /
`configUpdate`. Freshness: refetch on open + 30 s poll while visible (the card pattern used elsewhere).

```
BudgetStatus = {
  level, dailyCapUsd, spentUsdToday,
  plans: [{ adapter, planLabel?, windows: [{kind, label, bgPct, cap, pct, forecastPct|null, resetsAt}],
            paused: null | {reason: ReasonCode, kind?, value?} }],
  byWork: [{workType, calls, usd}]   // today
}
```

`ctoHealth.mjs`'s "ambient spend today / cap" row reads `spentUsdToday` / `dailyCapUsd` (payg) or the
plan share line.

## 11. Libraries considered

| Need | Chosen | Considered, and why not |
|---|---|---|
| Budget gate / quota accounting | own module (`backgroundBudget.mjs`) | `bottleneck` 2.19.5 (MIT, 15.5M/wk, last publish 2019-08) and `rate-limiter-flexible` 11.5.0 (ISC, 4.7M/wk, 2026-11) limit request RATE / concurrency, not "share of an externally reported quota window"; none model plan windows. `p-limit` 7.3.3 is concurrency only. The CTO engine already has its own concurrency limits. |
| Usage windows, history | existing `usage.mjs` poller + history | — (already in the stack) |
| Forecast-at-reset | existing `optimizer/forecast.mjs` | — |
| Tokens per pct | existing `optimizer/pacing.mjs` + `modelLedger.providerTokenTotals` | — |
| Presence | existing `push.desktopState` | — |
| Persistence | existing `jsonStore` atomic writes + store mutex (`ctoStores.patchStore` pattern) | `lowdb` 7.0.1 (MIT, 2.1M/wk, last publish 2023-12): adds a dependency for what the existing atomic writer already does; state is a few KB. SQLite (`node:sqlite`, used by knowledge) would split state across two subsystems' databases. |
| Pricing | `knowledge/budget.mjs` pricing, moved to the shared module | `ctoBudget.priceTokens` prices unpriceable models at $0 → a cap could never trip. |
| Level control UI | existing `Segmented` component (native radio semantics) | a new control; a library select. |

No component is hand-rolled where an established library fits.

## 12. Tests

Server (`node:test`, injected I/O, no live opencode):

- `backgroundBudget.test.mjs`: billing-mode classification (no adapter, no snapshot, credit, subscription,
  codex with balance); every decision rule and reason, including stale windows and null forecast; level
  caps per window kind; payg cap incl. 0; attribution tick (normal, dPct ≤ 0, T = 0, ledger null carries
  tokens forward, reset by resetsAt and by pct drop); in-flight estimate with and without tokensPerPct;
  `goodMomentForBatch` (away, near-reset spare, overdue, present+mid-week refused); store persistence
  round-trip; pricing fallback (unpriced → dearest in band).
- knowledge: capture/curator/corrections/skills/trial gate through `check` (existing tests updated, no
  `dailyCapUsd`); settings rejects nothing for the retired key on read and drops it on save.
- CTO: ambient gate refusal → thrifty + `cto_cap_hit`; overnight seam (§7.3 pins); watchdog floor.
- `local.mjs`: defaults + validation + retired-key removal on write.

Renderer (vitest): `BackgroundWorkCard` status copy for each reason, payg line, save error path.

Verification runs on a Freestyle VM (`~/.local/bin/fs-run.sh`), never on the dev box.

## 13. Follow-up (routine)

After release, a routine (`routine_create`, weekly for 3 weeks, then disables itself) reads the box's
background budget state and the usage history and reports: background share per window per week, how
often each pause reason fired, whether batch jobs ran near resets or while away, and any week where the
user's own window hit 100 % while background work had run in the preceding 24 h. Decision it informs:
whether to adjust the level caps (5/10, 2/5) and the 70/80 thresholds.

## 14. Out of scope

Routines; the CTO effort tier (A12 dial); the optimizer's pacing/routing; per-seat (multi-account)
budgets — the aggregate snapshot governs.
