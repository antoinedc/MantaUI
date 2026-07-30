// Capability-job completion notification: bridges the queue's field naming
// to opencode's. capabilities.mjs calls notifySession({sessionID, text})
// (the queue's natural shape — matches the job shape it persists);
// the shared prompt-delivery engine expects camelCase `sessionId`. This
// module OWNS the field-name translation so there is exactly one definition
// (shared by /api/cap/:id/done and the startCapSweeper deps in index.mjs),
// and so the translation is unit-tested in isolation — a regression here
// would silently strand the completion turn on /session/undefined/prompt_async
// (the bug BET-184 review-return flagged).
//
// The actual send now routes through the shared defer-while-busy engine
// (src/server/promptDelivery.mjs) so a completion notice never aborts the
// user's in-flight turn (BET-375). The translation stays HERE — do not move
// it; a field-name typo elsewhere would silently drop the session id.
//
// Keep this file the ONLY place that translates sessionID → sessionId.

import * as oc from "./opencode.mjs";

// Default deliver: a direct passthrough to oc.sendPrompt. Used by the unit
// tests (which assert the field translation by capturing the HTTP request)
// and as a fallback when no shared engine is wired. Production wires the
// shared engine's `deliver` via the { deliver } dep.
function defaultDeliver({ sessionId, text }) {
  return oc.sendPrompt({ sessionId, text });
}

/**
 * Bridge a capability job's terminal notification into an opencode
 * session prompt. Field-name translation: sessionID (caps) → sessionId
 * (delivery engine / opencode). Errors are propagated (caller is expected
 * to swallow + log).
 *
 * @param {{sessionID: string, text: string}} args
 * @param {{deliver?: (args:{sessionId:string, text:string})=>Promise<unknown>}} [deps]
 * @returns {Promise<unknown>}
 */
export function notifyCapSession({ sessionID, text }, { deliver = defaultDeliver } = {}) {
  return deliver({ sessionId: sessionID, text });
}
