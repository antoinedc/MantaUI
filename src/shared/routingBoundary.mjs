// routingBoundary.mjs — when to re-decide routing, and whether to actually switch.
//
// Two separate questions, both answered here so they cannot drift between call
// sites:
//
//  - WHEN do we re-evaluate? Not every turn. Switching model mid-conversation
//    discards the prompt cache and re-bills the whole prefix, and it changes the
//    assistant's judgement under the user mid-thread. A boundary is a moment
//    where re-evaluating is cheap or forced.
//  - HAVING re-evaluated, do we actually switch? Not just because a rival edged
//    ahead on price. We keep the incumbent unless it genuinely fell out.
//
// Pure + framework-free: no I/O, no Date.now() — everything arrives as an
// argument. The caller decides what a "turn" looks like.

/** The kinds of decision point. Order here is the precedence in `crossesBoundary`. */
export const BOUNDARY = {
  FIRST_TURN: "first-turn", // new session, or after /clear
  AGENT: "agent-changed", // plan <-> build
  CONSTRAINT: "constraint", // context outgrown / modality missing / provider unavailable
  COMPACTED: "compacted", // cache is gone anyway — a free moment
  USER: "user-requested", // the user re-picked Auto
};

// Stable machine identity of a routed endpoint. Same convention as modelRouter.
function endpointKey(m) {
  return m ? `${m?.providerID ?? ""}/${m?.id ?? ""}` : "";
}

/**
 * Does this turn cross a decision point?
 *
 * Returns the FIRST matching boundary in `BOUNDARY` precedence, or
 * `{ crossed: false, boundary: null }` when none match — that is the common
 * case and it must be cheap.
 *
 * @param {object} [input]
 * @param {boolean}  [input.hasRoutedModel]       false → new session / after /clear
 * @param {string}   [input.agent]                the agent of this turn
 * @param {string}   [input.previousAgent]        the agent of the previous turn
 * @param {number}   [input.contextTokens]        current context size
 * @param {number}   [input.incumbentContextLimit]max context the incumbent can hold
 * @param {string[]} [input.requiredModalities]   modalities this turn needs
 * @param {string[]} [input.incumbentModalities]  modalities the incumbent has
 * @param {boolean}  [input.incumbentHealthy]     true → provider is available
 * @param {boolean}  [input.justCompacted]        true → cache is gone anyway
 * @param {boolean}  [input.userRequested]        true → user re-picked Auto
 * @returns {{ crossed: boolean, boundary: string|null }}
 */
export function crossesBoundary(input = {}) {
  const {
    hasRoutedModel,
    agent,
    previousAgent,
    contextTokens,
    incumbentContextLimit,
    requiredModalities = [],
    incumbentModalities = [],
    incumbentHealthy = true,
    justCompacted = false,
    userRequested = false,
  } = input;

  // FIRST_TURN — new session or after /clear; there is nothing to re-decide, we
  // are deciding for the first time. Cheapest, checked first.
  if (hasRoutedModel === false) {
    return { crossed: true, boundary: BOUNDARY.FIRST_TURN };
  }

  // AGENT — the assistant's judgement role changed (plan <-> build).
  if (agent != null && previousAgent != null && agent !== previousAgent) {
    return { crossed: true, boundary: BOUNDARY.AGENT };
  }

  // CONSTRAINT — the incumbent genuinely no longer fits the turn: it lost its
  // context window, lacks a modality the turn needs, or its provider went away.
  const contextOutgrown =
    typeof incumbentContextLimit === "number" &&
    typeof contextTokens === "number" &&
    contextTokens > incumbentContextLimit;
  const modalityMissing = requiredModalities.some(
    (m) => !incumbentModalities.includes(m),
  );
  if (incumbentHealthy === false || contextOutgrown || modalityMissing) {
    return { crossed: true, boundary: BOUNDARY.CONSTRAINT };
  }

  // COMPACTED — the cache is gone anyway, so re-evaluating is free.
  if (justCompacted === true) {
    return { crossed: true, boundary: BOUNDARY.COMPACTED };
  }

  // USER — the user explicitly re-picked Auto; honour it.
  if (userRequested === true) {
    return { crossed: true, boundary: BOUNDARY.USER };
  }

  return { crossed: false, boundary: null };
}

const BOUNDARY_PHRASE = {
  [BOUNDARY.FIRST_TURN]: "first turn",
  [BOUNDARY.AGENT]: "agent changed",
  [BOUNDARY.CONSTRAINT]: "context or capability",
  [BOUNDARY.COMPACTED]: "just compacted",
  [BOUNDARY.USER]: "Auto re-selected",
};

/**
 * A short human phrase naming WHICH boundary justified a re-decision. The
 * router's `reason` already explains the model choice; this appends the
 * trigger context so the routed pill reads "…cost/quality… · just compacted".
 * Pure display — returns "" for an unknown/null boundary (never throws).
 *
 * @param {string|null} boundary a `BOUNDARY.*` value
 * @returns {string}
 */
export function boundaryPhrase(boundary) {
  return BOUNDARY_PHRASE[boundary] ?? "";
}

// 0-based position of the incumbent endpoint within `ranked`, or -1 if absent.
function incumbentIndex(incumbent, ranked) {
  const k = endpointKey(incumbent);
  if (!k) return -1;
  return ranked.findIndex((m) => endpointKey(m) === k);
}

/**
 * Having re-evaluated, should we move off the incumbent? Hysteresis.
 *
 * A boundary re-evaluates; it does NOT automatically switch. We switch only
 * when the incumbent genuinely fell out: it is no longer eligible, capable, or
 * healthy, or it dropped out of the top `topN` of `ranked`. Otherwise we keep
 * it, even if something now ranks above it — being edged out on price is not
 * enough.
 *
 * @param {object} input
 * @param {object|null} input.incumbent          the session's current routed endpoint
 * @param {object[]}    input.ranked             ordered candidates from the router
 * @param {boolean}     input.incumbentStillEligible  can Auto still describe it
 * @param {boolean}     input.incumbentStillCapable   does it still fit the turn
 * @param {boolean}     input.incumbentHealthy        is its provider available
 * @param {number}      [input.topN]             contention window (default 3)
 * @returns {{ switch: boolean, why: string }}
 */
export function shouldSwitch(input = {}) {
  const {
    incumbent,
    ranked = [],
    incumbentStillEligible = true,
    incumbentStillCapable = true,
    incumbentHealthy = true,
    topN = 3,
  } = input;

  if (incumbentStillEligible === false) {
    return { switch: true, why: "incumbent-ineligible" };
  }
  if (incumbentStillCapable === false) {
    return { switch: true, why: "incumbent-incapable" };
  }
  if (incumbentHealthy === false) {
    return { switch: true, why: "incumbent-unhealthy" };
  }

  const pos = incumbentIndex(incumbent, ranked);
  if (pos === -1 || pos >= topN) {
    return { switch: true, why: "incumbent-dropped-out" };
  }
  return { switch: false, why: "incumbent-retained" };
}
