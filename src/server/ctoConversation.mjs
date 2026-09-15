// BET-P3a3: src/server/ctoConversation.mjs — the production composition of
// the CTO conversation runtime (unified-cto-spec §3.1 + §8.3) and the seams
// that keep every writer on the durable admission queue.
//
// Scope (deliberately small): the four authenticated conversation channels
// (open / state / submit / interrupt) plus the two anti-bypass seams that
// redirect direct sends at the bound role session into the same queue:
//   • the `opencode:prompt` / `opencode:run-command` RPC routes (human-typed
//     traffic aimed at the conversation session), and
//   • the background prompt-delivery engine (schedule / capability / webhook
//     / delegate completion prompts aimed at the conversation session).
//
// The service is a THIN adapter over exactly ONE createCtoBinding and ONE
// createCtoAdmission instance (wired once in src/server/index.mjs). It holds
// no durable state of its own: everything is read from, and written to, the
// two engines. Binding creation is LAZY — composing the service (and booting
// the server) never creates a role session and never invokes the model; only
// `open()` does ("existing role binding service headless works only via the
// API" — spec §3.1).
//
// Anti-recursion: the admission engine sends via the RAW low-level oc client
// (its own sendPrompt dep), so a redirected delivery can never loop back
// through promptDelivery, and admission's own dispatch never re-enters this
// service. The firehose tap feeding admission.observeEvent is one-way.

import { createHash } from "node:crypto";

/**
 * The single rejection copy for the "not admitted yet" seams. Both the
 * attachment-bearing direct send and the slash-command route throw it: the
 * CTO conversation API admits PLAIN TEXT only until a later phase adds
 * slash-command / file-part support. Actionable — names the API to use.
 */
export const CTO_CONVERSATION_UNSUPPORTED_MESSAGE =
  "the CTO conversation API admits plain text only — submit via cto:conversation-submit; " +
  "slash commands and file attachments on the CTO conversation are not supported yet";

function describeErr(err) {
  return err?.message ? String(err.message) : String(err);
}

/**
 * Stable id for a background delivery, mapped from the delivery's known
 * content so a retried/redelivered identical prompt maps to the SAME
 * submission id (and admission's id-keyed dedup then collapses the replay
 * per §8.3 "do not duplicate a submitted turn"). The agent is server-stamped
 * and constant per box, so it is not part of the identity; model is.
 */
export function backgroundDeliveryId({ text, model } = {}) {
  const hash = createHash("sha256")
    .update(text ?? "")
    .update("\u0000")
    .update(JSON.stringify(model ?? null))
    .digest("hex");
  return `bg_${hash.slice(0, 24)}`;
}

/**
 * Build the conversation service over the composed engines.
 *
 * @param {object} deps
 * @param {object} deps.binding — the ONE createCtoBinding instance (lazy;
 *   only `open()` may create the role session).
 * @param {object} deps.admission — the ONE createCtoAdmission instance (its
 *   sendPrompt dep is the RAW oc client — never promptDelivery).
 * @param {string} deps.agentName — the server-owned central role agent
 *   (providers.mjs CTO_AGENT_NAME). Stampeded onto every admitted turn: the
 *   caller can NEVER choose an arbitrary agent for the CTO conversation.
 * @returns conversation service
 */
export function createCtoConversationService({ binding, admission, agentName }) {
  if (!binding || typeof binding.ensure !== "function" || typeof binding.getBinding !== "function") {
    throw new Error("createCtoConversationService requires the composed ctoBinding engine");
  }
  if (!admission || typeof admission.submit !== "function" || typeof admission.list !== "function") {
    throw new Error("createCtoConversationService requires the composed ctoAdmission engine");
  }
  if (typeof agentName !== "string" || agentName.length === 0) {
    throw new Error("createCtoConversationService requires the server-owned agent name");
  }

  function requireInputObject(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("cto conversation input must be an object");
    }
  }

  // -- channel: cto:conversation-open ---------------------------------------
  // Open (or recover) the ONE durable role session. The FIRST open creates
  // it (title + identity marker, NO model invocation); concurrent opens
  // singleflight inside the binding engine and return the same binding.
  async function open() {
    const { binding: bound } = await binding.ensure();
    const sessionId = bound.currentSessionId;
    if (!sessionId) {
      // Defensive — ensure() success always binds; a null here would mean the
      // binding engine's contract changed. Never fake success.
      throw new Error("cto conversation binding returned no session id after ensure");
    }
    return { sessionId, generation: bound.generation ?? 0 };
  }

  // -- channel: cto:conversation-state --------------------------------------
  // Binding view + durable queue projection. getBinding() is a pure store
  // read: reading state NEVER creates a session and NEVER invokes the model
  // (safe to poll from any client).
  async function state() {
    const bound = await binding.getBinding();
    const queue = await admission.list();
    return {
      binding: {
        sessionId: bound.currentSessionId ?? null,
        generation: bound.generation ?? 0,
      },
      submissions: queue.submissions,
      counts: queue.counts,
    };
  }

  // -- channel: cto:conversation-submit -------------------------------------
  // The human turn. Origin is fixed ("human" — the caller is the CEO side of
  // the conversation; the server stamps it, never the request body), the
  // agent is the server-owned central role config. `id` is the caller's
  // idempotency key: a same-id/same-payload replay returns the existing
  // record, a same-id/different-payload is an actionable error.
  async function submit(input) {
    requireInputObject(input);
    return admission.submit({
      origin: "human",
      text: input.text,
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.expectedGeneration !== undefined ? { expectedGeneration: input.expectedGeneration } : {}),
      agent: agentName,
    });
  }

  // -- channel: cto:conversation-interrupt ----------------------------------
  // The EXPLICIT interruption op (submit never aborts). Returns the visible
  // request marker: cancelled (was still queued) / interrupt_pending
  // (accepted turn) / cancel_requested (unknown). Note an interrupt on
  // `unknown` does NOT release the queue — the barrier is retained until
  // reconciliation proves the send's outcome (docs/cto-admission-contract.md
  // limitation 1).
  async function interrupt(input) {
    requireInputObject(input);
    return admission.interrupt(input.id);
  }

  // -- seam: classify a target session --------------------------------------
  // TRUE only for the CURRENT binding's role session (a replaced generation's
  // archived id is ordinary again). FAILS OPEN on a binding store read
  // failure (warn + false): classification must never break ORDINARY project
  // delivery, and an unreadable store means the whole conversation runtime is
  // already failing loudly everywhere else.
  async function isConversationSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return false;
    let bound;
    try {
      bound = await binding.getBinding();
    } catch (e) {
      console.warn(
        `[cto-conversation] binding unreadable; treating session ${sessionId} as ordinary: ${describeErr(e)}`,
      );
      return false;
    }
    return bound.currentSessionId === sessionId;
  }

  // -- seam: direct sends (`opencode:prompt`) at the conversation session ----
  // Plain text → routed through the same durable admission queue with a
  // stable id (the caller's messageID when present — the composer's optimistic
  // id — else admission mints one). File attachments / agent mentions → the
  // clear rejection (not admitted yet). The caller's `agent` field is
  // deliberately DROPPED: the server owns the role agent. Throws actionable
  // errors (unsupported parts, at-cap, stale-generation, ...) — never fake
  // success.
  async function admitDirect(input) {
    requireInputObject(input);
    const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0;
    const hasMentions = Array.isArray(input.mentions) && input.mentions.length > 0;
    if (hasAttachments || hasMentions) {
      throw new Error(CTO_CONVERSATION_UNSUPPORTED_MESSAGE);
    }
    return admission.submit({
      origin: "human",
      text: input.text,
      ...(typeof input.messageID === "string" && input.messageID.length > 0
        ? { id: input.messageID }
        : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      agent: agentName,
    });
  }

  // -- seam: slash commands (`opencode:run-command`) at the conversation ----
  // Rejected with the clear copy until a later phase adds support.
  async function rejectRunCommand() {
    throw new Error(CTO_CONVERSATION_UNSUPPORTED_MESSAGE);
  }

  // -- seam: background prompt delivery -------------------------------------
  // promptDelivery calls this FIRST on every deliver(); returning null means
  // "not ours — continue ordinarily". A CONFIRMED conversation target is
  // submitted to admission with origin "background" and the stable
  // content-mapped id. Submit refusals are surfaced as
  // {rejected:true, error} (never swallowed, never fake success) — the
  // delivery engine's contract is to never reject, so the outcome rides the
  // result object. Classification failure fails OPEN to the ordinary path
  // (warn), exactly like isConversationSession.
  async function redirectDelivery(args) {
    if (!args || typeof args !== "object") return null;
    const isConversation = await isConversationSession(args.sessionId);
    if (!isConversation) return null;
    try {
      const receipt = await admission.submit({
        origin: "background",
        text: args.text,
        ...(args.model !== undefined ? { model: args.model } : {}),
        id: backgroundDeliveryId({ text: args.text, model: args.model }),
        agent: agentName,
      });
      return {
        redirected: true,
        result: {
          delivered: false,
          queued: true,
          ctoId: receipt.id,
          ctoStatus: receipt.status,
          persisted: receipt.persisted,
        },
      };
    } catch (e) {
      console.warn(
        `[cto-conversation] background delivery to the CTO conversation refused by admission: ${describeErr(e)}`,
      );
      return {
        redirected: true,
        result: { delivered: false, queued: false, rejected: true, error: describeErr(e) },
      };
    }
  }

  // Bounded tick poller body (wired via startPoller in index.mjs): reconcile
  // + pump even with no inbound events. Store corruption rethrows to the
  // poller, which warns — surfaced, never swallowed.
  async function tick() {
    return admission.tick();
  }

  return {
    open,
    state,
    submit,
    interrupt,
    isConversationSession,
    admitDirect,
    rejectRunCommand,
    redirectDelivery,
    tick,
  };
}
