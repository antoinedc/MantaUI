// src/server/ctoOvernight.mjs
// BET-1402 — the overnight scheduler CORE (spec §11.1, §11.4, §11.5, §11.6):
// the window state machine, the portfolio scorer, and the execution-contract
// helpers. Pure logic with injected I/O throughout — no live tmux/opencode/
// network here. `createOvernightScheduler` is the thin I/O accessor (injected
// store + ledger + budget seam) BET-1419 wires into the engine; every decision
// it makes is one of the exported pure functions, so all of it is testable.
//
// Split of the original BET-1402: veto card, tonight UI, engine wiring,
// settings and data-gate flips live in BET-1419. This module must not touch
// ctoEngine.mjs, ctoCards.mjs, ctoSuggest.mjs, httpApi or any UI surface.

import { betaMean, thompsonDraw, effectsForVerdict } from "./ctoVerdicts.mjs";
import { createMutex, readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { statePath } from "../shared/paths.mjs";

// ---------------------------------------------------------------------------
// Constants (spec-cited, injectable where the spec leaves the number open)
// ---------------------------------------------------------------------------

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// §11.1: on boxes with no desktop client, the absence signal is ≥ 60 min of
// zero user-originated events inside the trough.
export const ABSENCE_SILENCE_MIN_MS = 60 * 60_000;

// §11.1: the veto-window card announces the open 30 min ahead — the countdown
// the veto verb (BET-1419) arms and this module carries/abandons.
export const VETO_COUNTDOWN_LEAD_MS = 30 * 60_000;

// A countdown that elapsed while the box was down is abandoned (§11.6 last
// bullet): never executed late. The grace window only covers scheduler-tick
// jitter (the due moment passed but a normal tick is about to evaluate it);
// past the grace, elapsed = abandoned.
export const COUNTDOWN_ABANDON_GRACE_MS = 15 * 60_000;

// §11.4 lattice — coarse on purpose, model-scored.
export const VALUE_LATTICE = Object.freeze([3, 2, 1, 0.5, 0.25]);
export const CONFIDENCE_LATTICE = Object.freeze([1.0, 0.8, 0.5]);

// §11.4: hygiene floor — maintenance is guaranteed 20% of the night's budget
// when any maintenance candidate exists.
export const HYGIENE_FLOOR_SHARE = 0.2;

// §11.4: λ = shadow price, 0 when spendable is fat, rising as it thins. The
// fat threshold and ceiling are our calibration (spec names the shape, not
// the constants): λ = 0 at spendable ≥ 50% of the window, rising linearly to
// LAMBDA_MAX as spendable → 0 (so near dawn the cheap jobs win).
export const SPENDABLE_FAT_FRAC = 0.5;
export const LAMBDA_MAX = 10;

// Per-category staleness τ for Decay (§11.4 "per-category τ"). Defaults are
// our calibration: explicit tonight-intent decays slowest, hygiene fastest
// (it recurs). Injectable per call.
export const DEFAULT_TAU_MS = Object.freeze({
  "queue-tonight": 7 * DAY_MS,
  suggestion: 3 * DAY_MS,
  "data-source": 7 * DAY_MS,
  maintenance: 1 * DAY_MS,
  watcher: 3 * DAY_MS,
});

// §11.4 "rising urgency (untouched-project pressure)": a candidate touching a
// project untouched this many days gets an urgency boost in Decay.
export const RISING_URGENCY_DAYS = 7;
export const RISING_URGENCY_FACTOR = 1.5;

// §11.5: unreviewed drafts expire after 7 days with an `expire` verdict.
export const DRAFT_EXPIRY_MS = 7 * DAY_MS;

// Candidate classes (§11.4 first paragraph).
export const CANDIDATE_CATEGORIES = Object.freeze([
  "queue-tonight", // accepted decision-card options marked "tonight"
  "suggestion", // below act thresholds but scoring high on value
  "data-source", // data-source analyses (§7.6)
  "maintenance", // hygiene class: dep advisories, CI red
  "watcher", // watcher-driven investigations
]);

// Default predicted cost (fraction-of-window units) when a candidate carries
// no cost estimate — keeps unknown-cost maintenance candidates scoreable
// instead of silently dropped (graceful-empty rule, §11.4).
export const DEFAULT_PREDICTED_COST = 1;

export const OVERNIGHT_LEDGER_SOURCE = "overnight";
export const OVERNIGHT_STATE_FILENAME = "overnight.json";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function finiteOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function ledgerRow(kind, ts, extra = {}) {
  return { actor: "cto", kind, source: OVERNIGHT_LEDGER_SOURCE, ts, ...extra };
}

// Nearest lattice value; non-finite input snaps to nothing (caller drops the
// candidate — graceful degradation, never a crash on bad model output).
export function snapToLattice(v, lattice) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const l of lattice) {
    const d = Math.abs(v - l);
    if (d < bestDist) {
      best = l;
      bestDist = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// §11.1 — the window state machine (pure; I/O injected by the caller)
// ---------------------------------------------------------------------------

// Coerce an unknown persisted window payload into the canonical shape. Never
// throws: a corrupt/foreign store yields a closed window (the quiet default).
export function normalizeWindow(prev) {
  const w = prev && typeof prev === "object" ? prev : {};
  const state = w.state === "open" ? "open" : "closed";
  const countdown =
    w.countdown && typeof w.countdown === "object" && finiteOrNull(w.countdown.dueMs) !== null
      ? { dueMs: w.countdown.dueMs, announcedMs: finiteOrNull(w.countdown.announcedMs) ?? w.countdown.dueMs }
      : null;
  return {
    state,
    openedMs: finiteOrNull(w.openedMs),
    closedMs: finiteOrNull(w.closedMs),
    closeReason: typeof w.closeReason === "string" ? w.closeReason : null,
    openedBy: typeof w.openedBy === "string" ? w.openedBy : null,
    // true when the window opened while the user was demonstrably present
    // (run-now override) — such a window closes on the next user event, not
    // on the presence flag (which was already "present" at open).
    openedDuringPresence: w.openedDuringPresence === true,
    // Manual pin (input consent): when set, this exact order governs the
    // window's plan for its whole life — exempt from re-scoring.
    pinnedOrder: Array.isArray(w.pinnedOrder) ? w.pinnedOrder.filter((x) => typeof x === "string") : null,
    // §9.2 veto stamp: the trough start whose run the user canceled. The open
    // path refuses to AUTO-open this trough again (run-now still overrides —
    // explicit consent after a cancel). It expires naturally when the next
    // trough has a different startMs, so a veto never suppresses tomorrow.
    vetoedTroughStartMs: finiteOrNull(w.vetoedTroughStartMs),
    countdown,
    lastEvaluatedMs: finiteOrNull(w.lastEvaluatedMs),
  };
}

export function defaultWindow() {
  return normalizeWindow(null);
}

// Is `ts` inside the trough [startMs, endMs)? A missing/invalid trough means
// "no trough known" — the window can still be run-now'd, never auto-opened.
export function troughContains(ts, trough) {
  if (!trough) return false;
  const start = finiteOrNull(trough.startMs);
  const end = finiteOrNull(trough.endMs);
  if (start === null || end === null || end <= start) return false;
  return ts >= start && ts < end;
}

/**
 * The positive absence signal (§11.1). Returns the signal kind or `null`.
 * - presence `gone` (desktop-confirmed) → "presence-gone"
 * - no-desktop boxes: ≥ 60 min of zero user-originated events *inside the
 *   trough* — the silent stretch is measured from the later of the last user
 *   event and the trough start, so pre-trough quiet does not count; with no
 *   trough known the silence cannot be verified as trough-internal → null.
 * Prolonged signal *absence* alone never opens the window: on a desktop box
 * with presence unknown/present this returns null.
 */
export function absenceSignal({ now, presence, hasDesktop, lastUserEventMs, trough }) {
  if (presence === "gone") return "presence-gone";
  if (hasDesktop) return null; // desktop boxes rely on presence only
  if (!troughContains(now, trough)) return null;
  const last = finiteOrNull(lastUserEventMs);
  if (last === null) return null; // no event data at all is signal *absence*
  const effectiveLast = Math.max(last, trough.startMs);
  return now - effectiveLast >= ABSENCE_SILENCE_MIN_MS ? "event-silence" : null;
}

/**
 * The pure transition step for one scheduler tick.
 *
 * `prev`  — the persisted window state (normalizeWindow shape).
 * `input` — { now, trough?, presence, hasDesktop, lastUserEventMs, runNow?,
 *            candidateCount }
 *
 * Returns `{ window, ledgerRows }`. Ledger rows are §14-shaped entries the
 * caller appends best-effort (kind `cto.overnight.*`).
 *
 * Transitions:
 * - closed → open when (a) `runNow` consent is set (the override; the verb
 *   that sets it ships in BET-1419), or (b) inside the trough AND a positive
 *   absence signal AND candidates exist. Zero candidates → no window
 *   (§11.4 graceful-empty: "a night with zero candidates opens no window").
 *   A pending veto countdown is executed (cleared) by the very open it was
 *   counting down to.
 * - open → closed at trough end or on user return, whichever first. User
 *   return = a user-originated event newer than the open, or the presence
 *   flag flipping present for a window that opened during absence.
 * - elapsed-but-never-evaluated veto countdowns (box was down) are abandoned
 *   + ledgered past the grace window — never executed late (§11.6).
 */
export function evaluateWindow(prev, input) {
  const now = finiteOrNull(input?.now) ?? Date.now();
  const w = normalizeWindow(prev);
  const rows = [];
  const trough = input?.trough ?? null;
  const presence = input?.presence ?? null;
  const candidateCount = Number.isFinite(input?.candidateCount) ? input.candidateCount : null;

  // --- countdown bookkeeping (a window-independent veto artifact) -----------
  let countdown = w.countdown;
  if (countdown && now >= countdown.dueMs) {
    const canOpenNow = troughContains(now, trough) && !!absenceSignal({ now, presence, hasDesktop: input?.hasDesktop, lastUserEventMs: input?.lastUserEventMs, trough });
    if (canOpenNow || (w.state === "open" && now - w.openedMs < COUNTDOWN_ABANDON_GRACE_MS)) {
      // The moment it was counting down to has arrived (or the window already
      // opened on its own signal) — the countdown is fulfilled, not abandoned.
      countdown = null;
    } else if (now - countdown.dueMs > COUNTDOWN_ABANDON_GRACE_MS) {
      // Elapsed unmet (box was down / signal never materialized) → abandoned,
      // never executed late (§11.6 last bullet).
      rows.push(
        ledgerRow("cto.overnight.countdown-abandoned", now, {
          reason: "veto countdown elapsed without its window opening; never run retroactively",
          dueMs: countdown.dueMs,
        }),
      );
      countdown = null;
    }
    // else: within grace — leave pending for the next tick.
  }

  // --- close checks (an open window closes before anything else reopens) ---
  if (w.state === "open") {
    const freshUserEvent =
      finiteOrNull(input?.lastUserEventMs) !== null && input.lastUserEventMs > w.openedMs;
    const presenceReturn = presence === "present" && !w.openedDuringPresence;
    // Trough-shift guard: the profile can re-derive the trough mid-window (a
    // G refit moves the quiet hours), which would make the trough-end close
    // below unreachable (the re-derived trough never contains openedMs). A
    // window the trough signal opened must never outlive its trough — close
    // it the moment the current trough no longer contains its opening. Run-now
    // windows are exempt: they open outside any trough on explicit consent and
    // close on the user's return/fresh event.
    const troughShifted =
      w.openedBy !== "run-now" && trough != null && !troughContains(w.openedMs, trough);
    if ((troughContains(w.openedMs, trough) && now >= trough.endMs) || troughShifted) {
      rows.push(ledgerRow("cto.overnight.close", now, { reason: "trough-end", openedMs: w.openedMs }));
      return {
        window: normalizeWindow({ ...w, state: "closed", closedMs: now, closeReason: "trough-end", countdown, pinnedOrder: null }),
        ledgerRows: rows,
      };
    }
    if (freshUserEvent || presenceReturn) {
      const reason = freshUserEvent ? "user-event" : "user-return";
      rows.push(ledgerRow("cto.overnight.close", now, { reason, openedMs: w.openedMs }));
      return {
        window: normalizeWindow({ ...w, state: "closed", closedMs: now, closeReason: reason, countdown, pinnedOrder: null }),
        ledgerRows: rows,
      };
    }
    // Still open — nothing to do this tick.
    return { window: normalizeWindow({ ...w, countdown, lastEvaluatedMs: now }), ledgerRows: rows };
  }

  // --- open checks ----------------------------------------------------------
  const runNow = input?.runNow === true;
  const signal = absenceSignal({ now, presence, hasDesktop: input?.hasDesktop, lastUserEventMs: input?.lastUserEventMs, trough });
  const inTrough = troughContains(now, trough);
  const zeroCandidates = candidateCount === 0;

  if (zeroCandidates) {
    // §11.4: a night with zero candidates opens no window at all — not even
    // on run-now (there is nothing to run).
    if (inTrough && (signal || runNow)) {
      rows.push(ledgerRow("cto.overnight.no-candidates", now, { reason: "zero candidates; no window" }));
    }
    return { window: normalizeWindow({ ...w, countdown, lastEvaluatedMs: now }), ledgerRows: rows };
  }

  // §9.2 veto: a user cancel for THIS trough (vetoedTroughStartMs === the
  // trough's start) blocks the auto-open — the run was canceled, not postponed.
  // run-now overrides it (explicit consent after a cancel); the next trough
  // has a different startMs, so the stamp never suppresses a later night.
  const vetoedTrough =
    w.vetoedTroughStartMs != null &&
    trough != null &&
    finiteOrNull(trough.startMs) === w.vetoedTroughStartMs;

  const mayOpen = runNow || (!vetoedTrough && inTrough && signal !== null);
  if (!mayOpen) {
    return { window: normalizeWindow({ ...w, countdown, lastEvaluatedMs: now }), ledgerRows: rows };
  }

  const openedDuringPresence = presence === "present";
  rows.push(
    ledgerRow("cto.overnight.open", now, {
      reason: runNow && !inTrough ? "run-now" : signal ?? "run-now",
      openedBy: runNow ? "run-now" : signal,
    }),
  );
  return {
    window: normalizeWindow({
      ...w,
      state: "open",
      openedMs: now,
      closedMs: null,
      closeReason: null,
      openedBy: runNow ? "run-now" : signal,
      openedDuringPresence,
      countdown: null, // an open fulfills any pending countdown
      vetoedTroughStartMs: null, // an open supersedes any same-night veto stamp
      lastEvaluatedMs: now,
    }),
    ledgerRows: rows,
  };
}

/**
 * Arm the veto countdown (the 30-min pre-open announcement, §11.1 / §10.3).
 * The verb that *calls* this ships in BET-1419; the machine carries the state
 * and abandons it if it elapses unmet. Returns the next window state.
 */
export function scheduleCountdown(prev, { now, dueMs } = {}) {
  const w = normalizeWindow(prev);
  const due = finiteOrNull(dueMs);
  if (due === null) return w;
  return normalizeWindow({
    ...w,
    countdown: { dueMs: due, announcedMs: finiteOrNull(now) ?? due - VETO_COUNTDOWN_LEAD_MS },
  });
}

/**
 * §11.6 restart recovery (the pure part; job-state reconciliation against the
 * delegate store is BET-1419). On boot: re-derive the window from trough +
 * presence; an open window whose trough fully elapsed during downtime is
 * closed and *skipped* (no-catch-up — never run retroactively); an open
 * window still inside its trough survives but demands a fresh spendable
 * computation before any new start; elapsed veto countdowns are abandoned.
 */
export function reconcileOnRestart(prev, input) {
  const now = finiteOrNull(input?.now) ?? Date.now();
  const w = normalizeWindow(prev);
  const rows = [];
  const trough = input?.trough ?? null;

  let window = w;
  let recomputeSpendable = false;

  if (w.countdown && now >= w.countdown.dueMs + COUNTDOWN_ABANDON_GRACE_MS) {
    rows.push(
      ledgerRow("cto.overnight.countdown-abandoned", now, {
        reason: "veto countdown elapsed while the box was down; never executed late",
        dueMs: w.countdown.dueMs,
      }),
    );
    window = normalizeWindow({ ...window, countdown: null });
  }

  if (w.state === "open") {
    const inTrough = troughContains(w.openedMs, trough);
    if (inTrough && now >= trough.endMs) {
      // The window's whole life is behind us: skipped, never caught up.
      rows.push(
        ledgerRow("cto.overnight.close", now, { reason: "trough-end", openedMs: w.openedMs, note: "restart reconcile" }),
      );
      rows.push(
        ledgerRow("cto.overnight.no-catch-up", now, {
          reason: "window missed entirely while the box was down; skipped, never run retroactively",
        }),
      );
      window = normalizeWindow({ ...window, state: "closed", closedMs: now, closeReason: "trough-end", pinnedOrder: null });
    } else {
      // Still inside its trough: re-derived, kept — but the reserve math must
      // run again before anything new starts (§11.6 "re-runs the reserve
      // computation before starting anything new").
      recomputeSpendable = true;
      rows.push(
        ledgerRow("cto.overnight.restart", now, { reason: "window re-derived after restart; spendable recompute required" }),
      );
    }
  }

  return { window, ledgerRows: rows, recomputeSpendable };
}

// ---------------------------------------------------------------------------
// §11.4 — the portfolio scorer
// ---------------------------------------------------------------------------

/**
 * λ from the spendable ratio (§11.4): 0 when spendable is fat (≥ half the
 * window), rising linearly to LAMBDA_MAX as spendable → 0. A windowless
 * plan (`spendableFrac: null`, §11.2) has no fractional reserve — λ = 0 and
 * the absolute $ night cap governs instead. An unreadable budget also yields
 * 0: a budget read failure must never block the night (graceful).
 */
export function lambdaFromSpendable(spendable) {
  const s = finiteOrNull(spendable?.spendableFrac);
  if (s === null) return 0; // windowless / unknown → no shadow price
  const frac = clamp01(s);
  if (frac >= SPENDABLE_FAT_FRAC) return 0;
  return LAMBDA_MAX * ((SPENDABLE_FAT_FRAC - frac) / SPENDABLE_FAT_FRAC);
}

/**
 * Decay(t) (§11.4): staleness exp(-age/τ) with a per-category τ, times the
 * rising-urgency boost for candidates on an untouched project. Missing age
 * data decays to 1 (no staleness evidence is not staleness).
 */
export function decayFactor(candidate, { now, tauMs } = {}) {
  const tau = finiteOrNull(tauMs) ?? (DEFAULT_TAU_MS[candidate?.category] ?? 3 * DAY_MS);
  const touched = finiteOrNull(candidate?.lastTouchedMs);
  let decay = touched === null ? 1 : Math.exp(-Math.max(0, now - touched) / Math.max(1, tau));
  const untouchedDays = finiteOrNull(candidate?.untouchedProjectDays);
  if (untouchedDays !== null && untouchedDays >= RISING_URGENCY_DAYS) decay *= RISING_URGENCY_FACTOR;
  return decay;
}

/**
 * Thompson-blend multiplier for one category (§11.4: "Category Value·
 * Confidence is blended with Thompson-sampled acceptance posteriors — two
 * counters per category, from verdicts"). `counters` maps category →
 * { alpha, beta } (successes/rejections); no data draws the flat 0.5 prior
 * via thompsonDraw(0,0).
 */
export function thompsonMultiplier(counters, category, rng = Math.random) {
  const c = counters && typeof counters === "object" ? counters[category] : null;
  const alpha = finiteOrNull(c?.alpha) ?? 0;
  const beta = finiteOrNull(c?.beta) ?? 0;
  return thompsonDraw(alpha, beta, rng);
}

/**
 * Fold one verdict's effects into a category's acceptance counters (immutable
 * copy). Success effects (accept/edit) bump alpha; rejection effects
 * (dismiss/veto/correct, plus the `never` flag) bump beta — via the shared
 * `effectsForVerdict` table so the portfolio can never disagree with the
 * verdict ledger's semantics. BET-1419 calls this from the queue-tonight
 * verdict sink.
 */
export function foldVerdictIntoCounters(counters, { category, verdict, never } = {}) {
  const base = counters && typeof counters === "object" ? counters : {};
  const cur = base[category] && typeof base[category] === "object" ? base[category] : {};
  const effects = effectsForVerdict(verdict, never);
  return {
    ...base,
    [category]: {
      alpha: (finiteOrNull(cur.alpha) ?? 0) + (effects.success ? 1 : 0),
      beta: (finiteOrNull(cur.beta) ?? 0) + (effects.rejection ? 1 : 0),
    },
  };
}

/**
 * Score the candidate portfolio (§11.4, formula verbatim):
 *
 *   Score = p_use · Value · Confidence · Decay(t) / (λ · PredictedCost)
 *
 * with Value·Confidence snapped to the coarse lattices and blended with the
 * Thompson-sampled acceptance posterior of the candidate's category. λ comes
 * from the spendable ratio. Candidates with unscoreable Value/Confidence are
 * dropped (graceful); a missing cost falls back to DEFAULT_PREDICTED_COST;
 * λ = 0 (fat budget) removes the cost penalty entirely (divide-by-zero is
 * the mathematical λ→∞-affordability limit, resolved as `score = numerator`).
 *
 * Returns the ranked list (score desc) annotated with every factor. Never
 * throws on garbage input; `[]` in → `[]` out.
 */
export function scoreCandidates(candidates, { now, spendable, counters, rng, tauMs } = {}) {
  const t = finiteOrNull(now) ?? Date.now();
  const lambda = lambdaFromSpendable(spendable ?? {});
  const list = Array.isArray(candidates) ? candidates : [];
  const scored = [];
  for (const c of list) {
    if (!c || typeof c !== "object" || typeof c.id !== "string" || c.id.length === 0) continue;
    const value = snapToLattice(c.value, VALUE_LATTICE);
    const confidence = snapToLattice(c.confidence, CONFIDENCE_LATTICE);
    if (value === null || confidence === null) continue; // unscoreable → drop
    const category = CANDIDATE_CATEGORIES.includes(c.category) ? c.category : "suggestion";
    const pUse = clamp01(finiteOrNull(c.pUse) ?? 1);
    const costRaw = finiteOrNull(c.predictedCost);
    const predictedCost = costRaw !== null && costRaw > 0 ? costRaw : DEFAULT_PREDICTED_COST;
    const decay = decayFactor({ ...c, category }, { now: t, tauMs });
    const thompson = thompsonMultiplier(counters, category, rng);
    const numerator = pUse * value * confidence * decay * thompson;
    const denom = lambda * predictedCost;
    const score = denom > 0 ? numerator / denom : numerator;
    scored.push({
      ...c,
      category,
      value,
      confidence,
      pUse,
      predictedCost,
      decay,
      thompson,
      lambda,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Select tonight's plan from the ranked list (§11.4 + §11.3 budget cut).
 * Applies the hygiene floor: when any maintenance candidate exists, 20% of
 * the night's budget is reserved for the maintenance class — non-maintenance
 * jobs may not consume it while a maintenance candidate remains unselected.
 * Every class degrades to empty gracefully: empty in → empty out.
 *
 * `budgetFrac` is the night's budget in predictedCost units (the spendable
 * fraction of the plan window; the accessor passes it from ctoBudget).
 * `pinnedOrder` (manual pin, input consent) overrides ranking entirely: the
 * pinned candidate order governs selection and is exempt from re-scoring.
 */
export function selectPortfolio(ranked, { budgetFrac = 1, pinnedOrder = null } = {}) {
  const list = Array.isArray(ranked) ? ranked : [];
  const budget = Math.max(0, finiteOrNull(budgetFrac) ?? 1);
  const byId = new Map(list.map((c) => [c.id, c]));

  let ordered;
  if (Array.isArray(pinnedOrder) && pinnedOrder.length > 0) {
    // Pinned order governs; unknown ids are skipped, un-pinned candidates
    // never jump ahead of the pin (the pin is the window's contract).
    ordered = pinnedOrder.map((id) => byId.get(id)).filter(Boolean);
  } else {
    ordered = [...list];
  }

  const hasMaintenance = list.some((c) => c.category === "maintenance");
  const floorFrac = hasMaintenance ? HYGIENE_FLOOR_SHARE * budget : 0;
  let spendable = budget;
  let generalBudget = budget - floorFrac;

  const selected = [];
  let maintenanceSelectedFrac = 0;
  for (const c of ordered) {
    const cost = Math.max(0, finiteOrNull(c.predictedCost) ?? DEFAULT_PREDICTED_COST);
    const isMaintenance = c.category === "maintenance";
    if (isMaintenance) {
      if (cost > spendable) continue;
      spendable -= cost;
      maintenanceSelectedFrac += cost;
      selected.push(c);
    } else {
      // Non-maintenance jobs stop at the hygiene-floor line while any
      // maintenance candidate is still waiting for its reserved slice.
      const maintenanceStillWaiting = list.some(
        (m) => m.category === "maintenance" && !selected.includes(m),
      );
      const limit = maintenanceStillWaiting ? generalBudget : budget;
      if (cost > limit || cost > spendable) continue;
      spendable -= cost;
      generalBudget -= cost;
      selected.push(c);
    }
  }

  return {
    selected,
    reservedMaintenanceFrac: maintenanceSelectedFrac,
    floorFrac,
    hasMaintenance,
    budgetFrac: budget,
  };
}

// ---------------------------------------------------------------------------
// §11.5 — execution-contract helpers (exported for BET-1419 to call)
// ---------------------------------------------------------------------------

/**
 * Machine gates before surfacing (§11.5): the gate set is read from project
 * config (`gates: { typecheck, tests, lint }` — truthy entry = defined gate).
 * An **empty gate set passes with a `no-gates` note** carried on the artifact,
 * the Just-finished card and the digest item — review expectations are
 * calibrated, never silently absent.
 */
export function evaluateGates(projectConfig) {
  const gates = projectConfig?.gates && typeof projectConfig.gates === "object" ? projectConfig.gates : {};
  const defined = Object.keys(gates).filter((k) => gates[k]);
  if (defined.length === 0) {
    return { pass: true, gates: [], note: "no-gates" };
  }
  return { pass: true, gates: defined, note: null };
}

/**
 * Overnight delegate jobs require a git project (§11.5: worktrees are git).
 * Non-git projects are read/digest-only surfaces: they never receive
 * file-editing jobs, but read-only work is fine.
 */
export function gitOnlyJobRule(project, { fileEditing = true } = {}) {
  const isGit = project?.git === true;
  if (!fileEditing) return { allowed: true, reason: null };
  if (!isGit) return { allowed: false, reason: "non-git" };
  return { allowed: true, reason: null };
}

/**
 * §11.2 routing: batch-flagged request-shaped tasks route to a provider's
 * batch pool where the adapter reports one (cheaper, non-competing); agentic
 * tasks always draw on the interactive pool. `providers` maps provider id →
 * adapter capabilities ({ batchPool: boolean }); a provider with no adapter
 * entry is treated as interactive-only and never blocks the path.
 */
export function routeRequestShaped(candidate, providers = {}) {
  const provider = typeof candidate?.provider === "string" && candidate.provider ? candidate.provider : null;
  if (!provider) return { provider: null, pool: "interactive", reason: "no provider" };
  const caps = providers && typeof providers === "object" ? providers[provider] : null;
  const batchPool = caps?.batchPool === true;
  if (candidate?.requestShaped === true && batchPool) {
    return { provider, pool: "batch", reason: null };
  }
  return { provider, pool: "interactive", reason: candidate?.requestShaped === true ? "no batch pool" : "agentic" };
}

/**
 * §7.6 data-source candidates (BET-1404): ONE per deep-consented,
 * chain-untripped, integrated tool, targeting the argmax-relevance project —
 * emitted only when a relevance score exists. `p_use = vitality.ewma ×
 * max(relevance)` (the scoring composition the issue fixes; selectivity
 * lives here, value stays mid-lattice). `requestShaped: true` so §11.2
 * batch routing picks them up where a provider adapter supports a batch
 * pool. Experiment-first: a tool with zero as_source reports runs a forced-
 * small first analysis (single probe window, halved context budget — carried
 * in the prompt contract and a 0.5 predicted cost); its verdict seeds the
 * as_source counters via the §9.5 sink.
 * @param {Array<{tool: string, displayName?: string, status?: string,
 *   consent?: {deep_read?: string|null}, asSourceDecayed?: boolean,
 *   as_source?: {reports?: number, accepted?: number}, relevance?: Object,
 *   vitality?: {ewma?: number|null}}>} tools registry projections (listTools)
 */
export function dataAnalysisCandidatesFromTools(tools) {
  const out = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t !== "object" || typeof t.tool !== "string" || !t.tool) continue;
    if (t.consent?.deep_read !== "yes") continue; // deep-consented only
    if (t.status !== "integrated") continue; // probes actually ran
    if (t.asSourceDecayed === true) continue; // chain tripped → analyses stopped
    let project = null;
    let best = 0;
    for (const [p, r] of Object.entries(t.relevance ?? {})) {
      const s = Number(r);
      if (Number.isFinite(s) && s > best) {
        best = s;
        project = p;
      }
    }
    if (project === null || !(best > 0)) continue; // only when a relevance score exists
    const ewma = Number(t.vitality?.ewma);
    if (!(Number.isFinite(ewma) && ewma > 0)) continue; // no live vitality → nothing fresh to mine
    const name = t.displayName ?? t.tool;
    const experiment = (t.asSource?.reports ?? t.as_source?.reports ?? 0) === 0;
    const pUse = Math.max(0, Math.min(1, ewma * best));
    out.push({
      id: `data-source:${t.tool}`,
      name: `Analyze ${name}'s data (overnight report)`,
      prompt: dataAnalysisPrompt(name, project, { experiment }),
      project,
      category: "data-source",
      pUse,
      value: 1,
      confidence: 0.5,
      predictedCost: experiment ? 0.5 : 1,
      requestShaped: true,
      refs: [t.tool],
    });
  }
  return out;
}

/**
 * The data-analysis job's prompt contract (§11.5): read-only analysis of the
 * tool's collected probe data, output = a draft REPORT markdown artifact in
 * the worktree root, no code changes — a report runs no gates, so the
 * standard no-gates note applies. Experiment-first appends the forced-small
 * constraints (single most-recent probe window, ~half the context budget).
 */
export function dataAnalysisPrompt(name, project, { experiment = false } = {}) {
  const slug = String(name ?? "tool")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const lines = [
    `You are the Adaptive CTO's overnight analyst. Draft a findings REPORT on ${name}'s data for the "${project}" project.`,
    ``,
    `Read-only analysis: use the probe data the CTO already collected for ${name} (~/.manta/cto/probe-state/ and the tool registry) — no new credentials, no new API access beyond what the probes already cover, and NO code changes.`,
    `Output: write your findings to REPORT-${slug || "tool"}.md in the worktree root — markdown, what the data shows, 3-5 concrete observations, any anomalies, one recommended next step. This is a report job: it runs no code gates and must leave the project untouched.`,
  ];
  if (experiment === true) {
    lines.push(
      ``,
      `EXPERIMENT-FIRST CONSTRAINTS (first analysis for this tool): keep it deliberately small — use ONLY the single most recent probe window of data, spend no more than about half the normal context budget, and end with a one-line verdict on whether a deeper analysis looks worthwhile.`,
    );
  }
  return lines.join("\n");
}

/**
 * §11.5 draft expiry: unreviewed drafts close after 7 days with an `expire`
 * verdict and a one-line digest note. Returns the expired drafts (each with
 * its verdict row) and the survivors. Never throws; garbage entries are kept
 * untouched rather than expired on a guessed age.
 */
export function expireDrafts(drafts, now) {
  const t = finiteOrNull(now) ?? Date.now();
  const list = Array.isArray(drafts) ? drafts : [];
  const expired = [];
  const keep = [];
  for (const d of list) {
    const created = finiteOrNull(d?.createdMs);
    const reviewed = d?.reviewed === true;
    const unreviewed = !reviewed && d?.reviewedAtMs == null;
    if (d && typeof d === "object" && typeof d.id === "string" && created !== null && unreviewed && t - created >= DRAFT_EXPIRY_MS) {
      expired.push({
        draft: d,
        verdict: "expire",
        digestNote: `Draft “${d.title ?? d.id}” expired unreviewed after 7 days.`,
      });
    } else {
      keep.push(d);
    }
  }
  return { expired, keep };
}

/**
 * §11.6 preempt-on-return (the pure decision; the bus wiring is BET-1419):
 * when presence flips present while an absence-opened window holds, the
 * running overnight jobs pause (at their next tool-call boundary) and the
 * window closes. A window opened during presence (run-now while the user is
 * there) is not preempted by the presence flag alone — its user-event close
 * rule governs.
 */
export function preemptOnReturn({ presence, window, runningJobs = [] } = {}) {
  const w = normalizeWindow(window);
  if (presence !== "present" || w.state !== "open" || w.openedDuringPresence) {
    return { shouldPause: false, pauseJobs: [], closeWindow: false };
  }
  return {
    shouldPause: true,
    pauseJobs: (Array.isArray(runningJobs) ? runningJobs : []).filter((j) => typeof j === "string"),
    closeWindow: true,
  };
}

// ---------------------------------------------------------------------------
// The I/O accessor (injected store + ledger + budget; BET-1419 wires it)
// ---------------------------------------------------------------------------

// Default store: the shared atomic jsonStore pattern at the sandboxed state
// path (statePath — never a bare homedir join; the test-sandbox rule).
function defaultOvernightStore() {
  const path = statePath("cto", OVERNIGHT_STATE_FILENAME);
  const mutex = createMutex();
  const fallback = { v: 1, window: null };
  return {
    path,
    load: async () => {
      const raw = readJsonSync(path, fallback);
      return raw && typeof raw === "object" ? raw : fallback;
    },
    save: (data) =>
      mutex.runExclusive(() => writeJsonAtomic(path, JSON.stringify(data ?? fallback, null, 2), { mode: 0o600 })),
  };
}

/**
 * The overnight scheduler accessor. All decision logic lives in the exported
 * pure functions above; this factory only injects I/O:
 * - `store`  — { load, save } for the window state (default: jsonStore at
 *              statePath("cto/overnight.json"))
 * - `now`    — clock seam
 * - `budget` — async () => ({ spendableFrac, remainingFrac } | null), fed
 *              from ctoBudget's computeSpendable by BET-1419; a throw is
 *              swallowed (budget read failure must never block the night)
 * - `ledger` — optional { append(row) } for the §14.5 activity ledger
 */
export function createOvernightScheduler({ store = defaultOvernightStore(), now = Date.now, budget = async () => null, ledger = null } = {}) {
  async function ledgerAppend(rows) {
    for (const row of rows ?? []) {
      try {
        if (ledger && typeof ledger.append === "function") await ledger.append(row);
      } catch {
        /* ledger is best-effort — never fail a tick on a ledger write */
      }
    }
  }

  async function readSpendable() {
    try {
      return (await budget()) ?? {};
    } catch {
      return {}; // graceful: unreadable budget → λ = 0 (fat default)
    }
  }

  return {
    /**
     * One scheduler tick. `input`: { trough?, presence, hasDesktop,
     * lastUserEventMs, runNow?, candidates? }. Persists the window state,
     * appends ledger rows best-effort, and — whenever the window is open and
     * candidates are supplied — scores the portfolio and selects tonight's
     * plan under the current spendable. Returns { window, plan, ledgerRows }.
     */
    async tick(input = {}) {
      const t = typeof now === "function" ? now() : now;
      const payload = await store.load().catch(() => ({ v: 1, window: null }));
      const prevWindow = payload?.window ?? null;
      const candidates = Array.isArray(input.candidates) ? input.candidates : [];

      const { window, ledgerRows } = evaluateWindow(prevWindow, {
        ...input,
        now: t,
        candidateCount: candidates.length,
      });

      let plan = null;
      if (window.state === "open" && candidates.length > 0) {
        const spendable = await readSpendable();
        const ranked = scoreCandidates(candidates, { now: t, spendable, counters: payload?.counters, rng: Math.random });
        // The spendable fraction of the plan window IS the night's budget in
        // predictedCost units (both are fraction-of-window space, §11.3).
        const budgetFrac = finiteOrNull(spendable.spendableFrac) ?? 1;
        plan = selectPortfolio(ranked, { budgetFrac, pinnedOrder: window.pinnedOrder });
      }

      await store.save({ ...payload, window }).catch(() => {});
      await ledgerAppend(ledgerRows);
      return { window, plan, ledgerRows };
    },

    /**
     * §11.6 restart recovery: re-derive the window, abandon elapsed veto
     * countdowns, skip fully-missed windows, and flag whether the spendable
     * must be recomputed before any new start. Persists + ledgers.
     */
    async reconcile(input = {}) {
      const t = typeof now === "function" ? now() : now;
      const payload = await store.load().catch(() => ({ v: 1, window: null }));
      const { window, ledgerRows, recomputeSpendable } = reconcileOnRestart(payload?.window ?? null, {
        ...input,
        now: t,
      });
      await store.save({ ...payload, window }).catch(() => {});
      await ledgerAppend(ledgerRows);
      return { window, recomputeSpendable, ledgerRows };
    },

    /**
     * Read the current window state without ticking (BET-1419 verbs read it
     * for copy/preempt decisions). Null when no window was ever persisted.
     */
    async readWindow() {
      const payload = await store.load().catch(() => null);
      return payload?.window ?? null;
    },

    /**
     * BET-1419 verb seam: apply a pure window transition (from the §11
     * machine's helpers — scheduleCountdown / normalizeWindow) and persist.
     * The mutator receives the previous window (or null) and returns the next
     * normalized one; returning null is a no-op. The ENGINE decides WHEN these
     * run (arming the veto countdown, canceling tonight, pinning an edit) —
     * the scheduler only owns the store.
     */
    async updateWindow(mutator) {
      if (typeof mutator !== "function") return null;
      const payload = await store.load().catch(() => ({ v: 1, window: null }));
      const next = mutator(payload?.window ?? null);
      if (!next) return null;
      await store.save({ ...payload, window: next }).catch(() => {});
      return next;
    },

    /**
     * BET-1419: fold a verdict into the Thompson acceptance counters the
     * portfolio samples from (the queue-tonight verdict sink). Counters live
     * beside the window in the same overnight store so one save stays atomic.
     */
    async foldCounters({ category, verdict, never } = {}) {
      const payload = await store.load().catch(() => ({ v: 1 }));
      const counters = foldVerdictIntoCounters(payload?.counters, { category, verdict, never });
      await store.save({ ...payload, counters }).catch(() => {});
      return counters;
    },

    async readCounters() {
      const payload = await store.load().catch(() => null);
      return payload?.counters ?? null;
    },
  };
}

// Re-exported for BET-1419's convenience (and so tests assert the exact
// helper identities the engine will consume).
export { betaMean, thompsonDraw, statePath };
