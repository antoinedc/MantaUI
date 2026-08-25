// optimizer/tuner.mjs — the conservative bandit that earns its own parameter
// changes (Optimizer P2.5, BET-1347).
//
// The phases before this fix the parameters at DEFAULT_POLICY's values
// (mask 12 uses / batch 20k / protect tail 40k). The tuner is what changes
// them — one parameter, one step along its ladder, at a time, and only when
// the guardrails let it. A change is KEPT only if no guardrail trips during
// its observation window; otherwise it is REVERTED immediately and both facts
// (kept / rolled-back) are written to the activity log. The activity log is
// the trust surface; the tuner is deliberately paranoid.
//
// EVENT-DRIVEN, NOT CLOCK-DRIVEN. A tune is evaluated on: TUNE_MIN_NEW_SESSIONS
// new sessions since the last change, a regime change (the eco level moved, or
// a quota window reset), or a guardrail trip. The TUNE_IDLE_SWEEP_MS sweep is
// a BACKSTOP for a box that sees none of those — not the mechanism.
//
// Pure decision + injected I/O throughout, mirroring the other optimizer
// modules:
//   • countRefetchChurn(rows)  — PURE. The honest measure of a trim that cost
//     more than it saved (defined exactly below).
//   • nextTuneStep(policy)     — PURE. One parameter, one ladder rung.
//   • createTuner({...})       — the stateful engine. Injected `load`/`save`
//     (the optimizer-policy.json repo table, via the shared atomic writer),
//     `now`, `enabled`, `directory` (the repo being tuned), `activityLog`,
//     `sessionCount`, and `observeGuardrails`. Returns { tune, snapshot }.
//
// The tuner is the ONLY writer of optimizer-policy.json — the write path lives
// here (POLICY_PATH + the default load/save), never in index.mjs.

import { statePath } from "../../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "../jsonStore.mjs";
import { shipCtxEvent } from "./telemetry.mjs";

// Event trigger: at least this many NEW sessions since the last change.
export const TUNE_MIN_NEW_SESSIONS = 20;
// Backstop sweep only — a box with no new sessions, no regime change and no
// guardrail trip is simply left alone.
export const TUNE_IDLE_SWEEP_MS = 6 * 60 * 60_000;
// A change must survive its observation window without a guardrail trip to be
// KEPT. Bounded to the same horizon as the sustain guardrail below.
export const TUNE_OBSERVE_MS = 60 * 60_000;

// Guardrails — any one trips -> instant revert + a "rolled-back" entry naming
// which. Deliberately conservative numbers; the tuner is a bandit, not a
// gambler.
export const GUARD_CACHE_HIT_DROP_PTS = 10; // cache-hit rate down this many points, sustained
export const GUARD_SUSTAIN_MS = 60 * 60_000; // ...for this long
export const GUARD_CHURN_PCT = 0.02; // re-fetch churn > 2% of masked parts
export const GUARD_COST_PER_TURN_WOW = 0.2; // effective cost/turn +20% week over week

// The ladders each parameter moves along. "Aggressive" is the LOWER end (mask
// sooner, batch sooner, protect less tail); the tuner moves DOWN one rung at a
// time and reverts if a guardrail objects.
export const TUNE_STEPS = {
  maskAfterUses: [8, 10, 12, 16, 20],
  batchTokens: [10_000, 20_000, 40_000],
  protectTailTokens: [24_000, 40_000, 60_000],
};

// DEFAULT_POLICY's starting values (destination when none tuned yet).
export const DEFAULT_TUNED = {
  maskAfterUses: 12,
  batchTokens: 20_000,
  protectTailTokens: 40_000,
};

// The tuner owns the per-repo tuner table file (the ONLY writer — see the
// counterfactual/route context; the policy route only READS it).
export const POLICY_PATH = statePath("optimizer-policy.json");

const PARAM_KEYS = Object.keys(TUNE_STEPS); // order = tune priority

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// --- Pure decision helpers -------------------------------------------------

// JSON-stable stringify: deterministic key order so "same input" means the
// same bytes regardless of object key order. Never throws.
function stableStringify(v) {
  if (v === undefined) return "null";
  try {
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
    if (v && typeof v === "object") {
      return `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(v);
  } catch {
    return "null";
  }
}

// The refetch identity of a part row: same sessionID, same tool, same
// state.input (JSON-stable-stringified). Two parts with the same key are the
// same tool run; if an earlier one was masked and it came back, that's churn.
function refetchKey(r) {
  const input = r.input === undefined || r.input === null ? null : r.input;
  return `${String(r.sessionID ?? "")}|${String(r.tool ?? "")}|${stableStringify(input)}`;
}

const PLACEHOLDER_PREFIX = "[manta: trimmed";
const isPlaceholder = (output) => typeof output === "string" && output.startsWith(PLACEHOLDER_PREFIX);

/**
 * PURE. The re-fetch churn over a window of tool part rows.
 *
 * Churn is a tool re-run whose EARLIER output we masked: the same
 * (`sessionID`, `tool`, `state.input`) as a part that was replaced by a manta
 * placeholder earlier in the sequence. Re-running a tool whose output we had
 * trimmed is the honest measure of a trim that cost more than it saved — we
 * paid to re-execute it, which is the masking counterfactual not saving us.
 *
 * `rows` is an array (chronological) of `{ sessionID, tool, input, output }`
 * where `output` is the part's output string (a real tool result, or a manta
 * placeholder). Returns `{ count, masked, ratio }` where `ratio = count /
 * masked` is churn as a fraction of masked parts (0 when no parts were masked)
 * — the guardrail threshold guards `ratio > GUARD_CHURN_PCT`.
 *
 * @param {Array<{sessionID?: string, tool?: string, input?: unknown, output?: string}>} rows
 * @returns {{ count: number, masked: number, ratio: number }}
 */
export function countRefetchChurn(rows) {
  const seen = new Map(); // refetch key -> number of earlier masked parts
  let masked = 0;
  let count = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.tool !== "string" || typeof r.output !== "string") continue;
    const key = refetchKey(r);
    if (isPlaceholder(r.output)) {
      masked++;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    } else if ((seen.get(key) ?? 0) > 0) {
      // A real re-run whose EARLIER same-key output was masked.
      count++;
    }
  }
  return { count, masked, ratio: masked > 0 ? count / masked : 0 };
}

// Clamp a policy value to its nearest ladder rung; returns { idx, val } where
// idx is the rung index (lower idx = more aggressive) and val the rung value.
function ladderPos(ladder, value) {
  if (!Array.isArray(ladder) || ladder.length === 0) return { idx: -1, val: value };
  if (!isNum(value)) return { idx: ladder.length - 1, val: ladder[ladder.length - 1] };
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ladder.length; i++) {
    const d = Math.abs(ladder[i] - value);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return { idx: best, val: ladder[best] };
}

function paramValue(policy, param) {
  const raw = policy?.[param];
  return isNum(raw) && raw > 0 ? raw : DEFAULT_TUNED[param];
}

/**
 * PURE (though it reads a `policy` object). Choose the next tune: exactly ONE
 * parameter, exactly ONE step DOWN its ladder (more aggressive), cycling by
 * priority (maskAfterUses → batchTokens → protectTailTokens). Returns
 * `{ param, from, to }`, or `null` when every parameter is already at its most
 * aggressive rung (nothing left to earn).
 */
export function nextTuneStep(policy = {}) {
  for (const param of PARAM_KEYS) {
    const ladder = TUNE_STEPS[param];
    const { idx, val } = ladderPos(ladder, paramValue(policy, param));
    if (idx > 0) {
      return { param, from: val, to: ladder[idx - 1] };
    }
  }
  return null;
}

// Human change description for an activity entry's `subject`. The "Kept /
// Rolled back" prefix is the renderer's (from `verdict`); this is the change.
export function describeTuneSubject(param, from, to) {
  switch (param) {
    case "maskAfterUses":
      return `trim threshold ${from} → ${to} tool uses`;
    case "batchTokens":
      return `batch threshold ${formatK(from)} → ${formatK(to)} tokens`;
    case "protectTailTokens":
      return `protected tail ${formatK(from)} → ${formatK(to)} tokens`;
    default:
      return `${param} ${from} → ${to}`;
  }
}

function formatK(v) {
  return isNum(v) ? `${Math.round(v / 1000)}k` : String(v);
}

/**
 * The tuner engine. Pure decision + injected I/O (no fs access unless the
 * injected load/save touch it — tests stub them in-memory).
 *
 *   load / save       — the per-repo tuner table (optimizer-policy.json shape
 *                        `{ repos: { "<dir>": { maskAfterUses?... } } }`).
 *                        Defaults read/write `POLICY_PATH` atomically. The
 *                        tuner is the ONLY writer of that file.
 *   directory         — the repo directory being tuned (the policy route's
 *                        repo-table key). Empty/absent → no tuning.
 *   enabled           — boolean or zero-arg fn: the optimizer switch. When
 *                        false the tuner neither observes nor writes.
 *   now               — clock (number or zero-arg fn).
 *   activityLog       — { append } (optimizer/activityLog.mjs).
 *   sessionCount      — () => number | number: the box's current session count
 *                        (for the "new sessions since last change" trigger).
 *   observeGuardrails — () => { tripped, which, evidence } | null: the current
 *                        guardrail state. Index wiring derives it from the
 *                         cache-hit / churn / cost measurements (fail-open:
 *                        absent/broken → no trip → the bandit stays put).
 *   loadTunerState / saveTunerState — persist `{ pending, lastSessionCount,
 *                        lastChangeAt }` (tests stub in-memory).
 *
 * Returns { tune, snapshot }: tune(input) runs ONE evaluation pass.
 */
export function createTuner({
  load = () => readJsonSync(POLICY_PATH, {}),
  save = (data) => writeJsonAtomic(POLICY_PATH, JSON.stringify(data, null, 2)),
  directory = "",
  enabled = () => true,
  now,
  activityLog,
  sessionCount = () => 0,
  observeGuardrails = () => null,
  loadTunerState = async () => ({}),
  saveTunerState = async () => {},
} = {}) {
  let state = null;

  const nowMs = () => (typeof now === "function" ? (now() ?? Date.now()) : (now ?? Date.now()));
  const enabledOn = async () => (typeof enabled === "function" ? !!enabled() : !!enabled);
  const curSessions = async () => {
    const c = typeof sessionCount === "function" ? sessionCount() : sessionCount;
    return isNum(c) ? c : 0;
  };

  async function ensureState() {
    if (!state) state = { pending: null, lastSessionCount: 0, lastChangeAt: 0, ...(await loadTunerState()) };
    return state;
  }

  async function persistState() {
    await saveTunerState({ pending: state.pending, lastSessionCount: state.lastSessionCount, lastChangeAt: state.lastChangeAt });
  }

  // Read the current tunable values for `directory` from the repo table.
  async function currentPolicy() {
    const table = await load();
    const repo = table?.repos?.[directory];
    return {
      maskAfterUses: paramValue(repo, "maskAfterUses"),
      batchTokens: paramValue(repo, "batchTokens"),
      protectTailTokens: paramValue(repo, "protectTailTokens"),
    };
  }

  // Build the policy table with `patch` applied to this directory's entry.
  async function persistPolicy(patch) {
    const table = await load();
    const repos = table?.repos && typeof table.repos === "object" ? table.repos : {};
    const repo = { ...(repos[directory] ?? {}) };
    for (const [k, v] of Object.entries(patch)) repo[k] = v;
    await save({ repos: { ...repos, [directory]: repo } });
  }

  async function appendActivity(entry) {
    if (activityLog && typeof activityLog.append === "function") {
      try {
        await activityLog.append(entry);
      } catch (e) {
        console.warn("[optimizer] activity append failed:", e?.message ?? e);
      }
    }
  }

  async function apply(s, step, t, sessions) {
    await persistPolicy({ [step.param]: step.to });
    s.pending = { param: step.param, from: step.from, to: step.to, changedAt: t };
    s.lastChangeAt = t;
    s.lastSessionCount = sessions;
    await persistState();
    // Context telemetry: a tune step was applied (counts + knob values only).
    shipCtxEvent({ kind: "tune", param: step.param, from: step.from, to: step.to, verdict: "applied" });
  }

  async function keep(s, t, sessions) {
    const p = s.pending;
    await appendActivity({
      kind: "tune",
      subject: describeTuneSubject(p.param, p.from, p.to),
      from: p.from,
      to: p.to,
      verdict: "kept",
      evidence: {
        observeMinutes: Math.round((t - p.changedAt) / 60_000),
      },
    });
    s.lastChangeAt = t;
    s.lastSessionCount = sessions;
    s.pending = null;
    await persistState();
    shipCtxEvent({ kind: "tune", param: p.param, from: p.from, to: p.to, verdict: "kept" });
  }

  async function revert(s, guardrail, t, sessions) {
    const p = s.pending;
    // Restore the pre-change value — the bandit changes nothing that survives
    // a trip.
    await persistPolicy({ [p.param]: p.from });
    await appendActivity({
      kind: "tune",
      subject: describeTuneSubject(p.param, p.from, p.to),
      from: p.from,
      to: p.from,
      verdict: "rolled-back",
      revertedAt: t,
      evidence: {
        revertedAfterMinutes: Math.round((t - p.changedAt) / 60_000),
        guardrail: guardrail?.which ?? "unknown",
        ...(guardrail?.evidence ?? {}),
      },
    });
    s.lastChangeAt = t;
    s.lastSessionCount = sessions;
    s.pending = null;
    await persistState();
    shipCtxEvent({ kind: "tune", param: p.param, from: p.from, to: p.from, verdict: "rolled-back" });
  }

  async function shouldTune({ newSessions, ecoChanged, quotaReset }) {
    if (newSessions >= TUNE_MIN_NEW_SESSIONS) return true;
    if (ecoChanged || quotaReset) return true;
    return false;
  }

  /**
   * ONE evaluation pass. `input`:
   *   { sessionCount?, ecoChanged?, quotaReset?, guardrail? } where
   *   `guardrail` = { tripped, which, evidence } (from observeGuardrails).
   * Returns a descriptive { action, ... }. Always fails open to {action:"no-op"}
   * on any unexpected error; never throws.
   */
  async function tune(input = {}) {
    try {
      if (!(await enabledOn())) return { action: "no-op" };
      const t = nowMs();
      const s = await ensureState();
      const guardrail =
        input.guardrail?.tripped
          ? input.guardrail
          : (await (typeof observeGuardrails === "function" ? observeGuardrails() : null)) ?? null;

      // 1. A guardrail trip reverts an in-flight pending change immediately.
      if (s.pending && guardrail) {
        const sessions = input.sessionCount ?? (await curSessions());
        await revert(s, guardrail, t, sessions);
        return { action: "reverted", param: s.pending?.param, guardrail: guardrail.which };
      }

      // 2. A pending change that survived its observation window is KEPT.
      if (s.pending && t - s.pending.changedAt >= TUNE_OBSERVE_MS) {
        const p = s.pending;
        await keep(s, t, input.sessionCount ?? (await curSessions()));
        return { action: "kept", param: p.param, from: p.from, to: p.to };
      }

      // 3. A positive trigger with nothing pending applies the next step.
      const sessions = isNum(input.sessionCount) ? input.sessionCount : await curSessions();
      const newSessions = Math.max(0, sessions - (s.lastSessionCount ?? 0));
      if (!s.pending && (await shouldTune({ newSessions, ecoChanged: !!input.ecoChanged, quotaReset: !!input.quotaReset }))) {
        const policy = await currentPolicy();
        const step = nextTuneStep(policy);
        if (!step) return { action: "no-tune" };
        await apply(s, step, t, sessions);
        return { action: "applied", param: step.param, from: step.from, to: step.to };
      }

      return { action: "no-tune" };
    } catch (e) {
      console.warn("[optimizer] tune pass failed (fail-open):", e?.message ?? e);
      return { action: "no-op" };
    }
  }

  async function snapshot() {
    const s = await ensureState();
    return {
      pending: s.pending ? { ...s.pending } : null,
      lastChangeAt: s.lastChangeAt,
      lastSessionCount: s.lastSessionCount,
    };
  }

  return { tune, snapshot, nextTuneStep, countRefetchChurn };
}
