// safeApiError.mjs — the BET-1460 class-1 safe-500 writer.
//
// BET-1454 found /api/projects returning raw exception text (tmux stderr) in
// its 500 body, and the desktop chat panel rendered it verbatim in the
// composer banner — internal paths and command output on a user's screen.
// BET-1458 extracted that handler; BET-1460 generalized the contract across
// every respondJson(res, 500) site in index.mjs, splitting them by CONSUMER:
//
//   class 1 — routes whose 500 body can reach an END USER's screen (the chat
//             panel's attachment chips, the CTO pane's toasts and load-error
//             states, the iOS composer): the body carries a SAFE LITERAL and
//             the underlying error goes to console.warn server-side with a
//             `[api/<route>]` tag for log shipping. Every class-1 route MUST
//             write its 500 through respondSafe500 — never respondJson with
//             String(e?.message ?? e).
//   class 2 — routes consumed only by an AI tool registrar (a manta-native
//             opencode tool relays the message straight back to the model as
//             a tool result — "unauthorized", "unknown action" are the whole
//             self-correction value), an automation surface (the cap plugin
//             runner), or an operator surface (Settings renders raw text only
//             behind a `<details>` disclosure — settingsError.tsx). These
//             keep the raw body and carry a `class-2 (BET-1460)` marker
//             comment in index.mjs, asserted by errorBodyContract.test.mjs.
//
// Unit-tested in safeApiError.test.mjs; the index.mjs wiring is gated by
// errorBodyContract.test.mjs.

// Class-1 safe literals. Pinned literally in tests — a wording change is a
// review-visible event. Keep them human, reason-shaped (the calling UI
// already prefixes the action, e.g. "Couldn't load the ledger: …").
export const UPLOAD_SAFE_500_MESSAGE = "Couldn't save the upload on the box.";
export const CTO_SAFE_500_MESSAGE =
  "The box's assistant service hit an unexpected error.";

/**
 * Write a class-1 500: safe human literal in the body, underlying error on
 * the server-side console.warn.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} route  Short route tag for the console line only
 *                        (e.g. "cto/verdict", "upload"). Never sent.
 * @param {string} userMessage  The safe literal body (see the constants).
 * @param {unknown} error  The caught underlying error (Error or thrown value).
 */
export function respondSafe500(res, route, userMessage, error) {
  console.warn(`[api/${route}] 500 → safe body:`, error?.message ?? error);
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: userMessage }));
}
