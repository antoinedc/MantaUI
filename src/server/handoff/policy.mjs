// handoff/policy.mjs — the pure decisions behind auto-handoff (spec §4):
// which entry point does what in which mode (§4.1), the context budget
// (§4.3), and whether a finished turn should start a handoff (§4.2).
// No I/O, no clock: every fact arrives as an argument.

export const HANDOFF_MODES = Object.freeze(["auto", "suggest", "off"]);
export const DEFAULT_HANDOFF_MODE = "suggest";

/** Anything unreadable falls back to the box default ("suggest"; it was "auto" until 2026-10-27). */
export function normalizeMode(value) {
  return HANDOFF_MODES.includes(value) ? value : DEFAULT_HANDOFF_MODE;
}

// ---- §4.1 entry points × mode ----------------------------------------------

export const TRIGGERS = Object.freeze(["user", "button", "agent", "auto"]);
export const ACTIONS = Object.freeze(["suggest", "handoff"]);

/**
 * PURE. What an entry point does in a mode.
 *   produce "none"  — nothing happens (automatic trigger, mode off)
 *   produce "card"  — a `ready` card the user acts on
 *   produce "start" — the server starts the handoff itself at the right moment:
 *                     replacement, with `disposition` "armed" (automatic, turn
 *                     end) or "send" (the agent asked for it, after its turn)
 * `kind` is the record kind: "auto" when the server starts it, else "suggest".
 *
 * @param {{ mode: string, trigger: string, action?: string }} a
 * @returns {{ produce: "none"|"card"|"start", kind: "suggest"|"auto", how?: "clear", disposition?: "armed"|"send" }}
 */
export function entryPlan({ mode, trigger, action } = {}) {
  if (!TRIGGERS.includes(trigger)) throw new Error(`unknown trigger "${String(trigger)}"`);
  const m = normalizeMode(mode);
  if (trigger === "auto") {
    if (m === "off") return { produce: "none", kind: "suggest" };
    if (m === "suggest") return { produce: "card", kind: "suggest" };
    return { produce: "start", kind: "auto", how: "clear", disposition: "armed" };
  }
  if (trigger === "agent") {
    if (!ACTIONS.includes(action)) throw new Error(`unknown action "${String(action)}"`);
    if (action === "handoff" && m === "auto") return { produce: "start", kind: "auto", how: "clear", disposition: "send" };
    return { produce: "card", kind: "suggest" };
  }
  // `/handoff` and the "Hand off" button: always a card, whatever the mode.
  return { produce: "card", kind: "suggest" };
}

// ---- §4.3 budget -------------------------------------------------------------

export const FRONTIER_CEILING_TOKENS = 200_000;
export const SMALL_CEILING_TOKENS = 100_000;
export const WINDOW_FRACTION = 0.6;
export const COOLDOWN_MS = 30 * 60_000;

const FRONTIER_RE = /opus|sonnet|fable|gpt-?[56]|astra|\bsol\b|\bluna\b/i;
const SMALL_RE = /haiku|mini|nano|flash|lite|small/i;

/** @returns {"frontier"|"small"|"unknown"} */
export function modelClass(providerID, modelID) {
  const id = String(modelID ?? "");
  if (!id) return "unknown";
  // Cheap/small markers win over a frontier family word ("gpt-5-mini").
  if (SMALL_RE.test(id)) return "small";
  if (FRONTIER_RE.test(id)) return "frontier";
  return "unknown";
}

/**
 * PURE. A known window → 60% of it, whatever the model family (no ceiling: a
 * 1M-window model triggers at 600k). Only an unknown window falls back to the
 * family ceiling (frontier 200k / small 100k); neither → null (no budget, so
 * no automatic trigger).
 * @param {{ providerID?: string|null, modelID?: string|null, contextLimit?: number|null }} a
 * @returns {number|null}
 */
export function handoffBudget({ providerID, modelID, contextLimit } = {}) {
  const win = typeof contextLimit === "number" && Number.isFinite(contextLimit) && contextLimit > 0 ? contextLimit : null;
  const cls = modelClass(providerID, modelID);
  if (win !== null) return Math.floor(win * WINDOW_FRACTION);
  return cls === "frontier" ? FRONTIER_CEILING_TOKENS : cls === "small" ? SMALL_CEILING_TOKENS : null;
}

// ---- §4.2 automatic trigger --------------------------------------------------

/**
 * PURE. Should a turn that just ended start an automatic handoff?
 * `reason` names the first failing condition (it is what the log line reads).
 * @param {{ mode: string, turnSucceeded: boolean, contextTokens: number|null, budget: number|null, now: number, successorCreatedAt?: number|null, cooldownMs?: number }} a
 * @returns {{ fire: boolean, reason: string }}
 */
export function decideAutoTrigger({ mode, turnSucceeded, contextTokens, budget, now, successorCreatedAt = null, cooldownMs = COOLDOWN_MS } = {}) {
  if (normalizeMode(mode) === "off") return { fire: false, reason: "mode-off" };
  if (turnSucceeded !== true) return { fire: false, reason: "turn-not-successful" };
  if (typeof budget !== "number" || !(budget > 0)) return { fire: false, reason: "no-budget" };
  if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens)) return { fire: false, reason: "no-measurement" };
  if (!(contextTokens > budget)) return { fire: false, reason: "under-budget" };
  if (typeof successorCreatedAt === "number" && now - successorCreatedAt < cooldownMs) return { fire: false, reason: "cooldown" };
  return { fire: true, reason: "over-budget" };
}
