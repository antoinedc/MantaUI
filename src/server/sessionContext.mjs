// sessionContext.mjs — which model a session's context percentage is measured
// against (WS11 D2 / audit T20). The box resolves it so both clients show the same
// number: the model SELECTED for the session, else the configured default, else the
// model of the last reply.

import { computeContextBreakdown } from "../shared/streamInterpretation.mjs";

const validModel = (m) =>
  m && typeof m === "object" && typeof m.providerID === "string" && m.providerID !== "" &&
  typeof m.modelID === "string" && m.modelID !== "";

/**
 * Pure. Resolution order: model-prefs session record → config.defaultModel →
 * last-used (the interpreter's latest step model / the transcript's last reply).
 * @returns {{providerID: string, modelID: string, basis: "selected"|"default"|"last-used"} | null}
 */
export function contextModelFor({ sessionId, prefs, config, lastUsed }) {
  const sel = prefs?.sessions?.[sessionId];
  if (validModel(sel)) return { providerID: sel.providerID, modelID: sel.modelID, basis: "selected" };
  const def = config?.defaultModel;
  if (validModel(def)) return { providerID: def.providerID, modelID: def.modelID, basis: "default" };
  if (validModel(lastUsed)) return { providerID: lastUsed.providerID, modelID: lastUsed.modelID, basis: "last-used" };
  return null;
}

/** The additive `context` payload: today's breakdown plus `limit`, `model`, `basis`. */
export function buildContextPayload(tokens, resolved, limit) {
  return {
    ...computeContextBreakdown(tokens, limit),
    limit: typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null,
    model: resolved ? { providerID: resolved.providerID, modelID: resolved.modelID } : null,
    basis: resolved ? resolved.basis : null,
  };
}

/**
 * The in-memory resolver the interpreter and `opencode:context` share. Prefs are read
 * through `loadPrefs` once and cached until `invalidatePrefs()` (called by
 * `model-prefs:set` / `seed`); the default model is pushed in by `setDefaultModel`
 * (boot read + `config:update`).
 */
export function createContextModelResolver({ loadPrefs }) {
  let prefs = null;
  let defaultModel = null;
  return {
    resolve({ sessionId, lastUsed }) {
      if (prefs === null) {
        try {
          prefs = loadPrefs();
        } catch {
          prefs = { sessions: {} };
        }
      }
      return contextModelFor({ sessionId, prefs, config: { defaultModel }, lastUsed });
    },
    invalidatePrefs() {
      prefs = null;
    },
    /** Returns true when the default actually changed. */
    setDefaultModel(next) {
      const norm = validModel(next) ? { providerID: next.providerID, modelID: next.modelID } : null;
      const same = (norm?.providerID ?? null) === (defaultModel?.providerID ?? null) &&
        (norm?.modelID ?? null) === (defaultModel?.modelID ?? null);
      defaultModel = norm;
      return !same;
    },
  };
}
