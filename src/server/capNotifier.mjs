// Capability-job completion notification: bridges the queue's field naming
// to opencode's. capabilities.mjs calls notifySession({sessionID, text})
// (the queue's natural shape — matches the job shape it persists);
// oc.sendPrompt expects camelCase `sessionId`. This module OWNS the
// field-name translation so there is exactly one definition (shared by
// /api/cap/:id/done and the startCapSweeper deps in index.mjs), and so the
// translation is unit-tested in isolation — a regression here would
// silently strand the completion turn on /session/undefined/prompt_async
// (the bug BET-184 review-return flagged).
//
// Keep this file the ONLY place that translates sessionID → sessionId; the
// pass-through wiring elsewhere would let a field-name typo silently drop
// the session id and never reach opencode.

import * as oc from "./opencode.mjs";

/**
 * Bridge a capability job's terminal notification into an opencode
 * session prompt. Field-name translation: sessionID (caps) → sessionId
 * (opencode). Errors are propagated (caller is expected to swallow + log).
 *
 * @param {{sessionID: string, text: string}} args
 * @returns {Promise<unknown>}
 */
export function notifyCapSession({ sessionID, text }) {
  return oc.sendPrompt({ sessionId: sessionID, text });
}
