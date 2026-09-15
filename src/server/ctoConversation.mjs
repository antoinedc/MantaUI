// BET-P3a3: src/server/ctoConversation.mjs — the production composition of
// the CTO conversation runtime (unified-cto-spec §3.1 + §8.3) and the seams
// that keep every writer on the durable admission queue.
//
// Scope (deliberately small): the four authenticated conversation channels
// (open / state / submit / interrupt) plus the anti-bypass seams that keep
// every writer on the durable admission queue:
//   • the `opencode:prompt` / `opencode:run-command` / `opencode:abort` RPC
//     routes (human traffic aimed at the conversation session),
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
 * The background dedupe identity is the CALLER's stable delivery identity
 * (`ctoKey`) — NEVER the content. Admission dedups by id (and returns the
 * existing record even when terminal), so content-derived ids made a
 * recurring identical delivery fire exactly once ever. Per caller:
 *   • schedule   → `sched:<jobId>:<minuteKey>`  (each firing minute is a NEW
 *                  occurrence; a retry of the same fire dedups);
 *   • capability → `cap:<jobId>:<status>`       (one notify per transition);
 *   • webhook    → none available on the manta-hook delivery path (GitHub
 *                  hooks route to forge ingest before any delivery, and
 *                  manta hooks carry no delivery id) — their repeat window
 *                  is the hook store's own seenDeliveryIds dedupe, so each
 *                  accepted delivery mints a fresh unique admission id;
 *   • delegate   → none (completions fire once per job; unique id is
 *                  correct).
 * With no identity, NO id is passed and admission mints a fresh `evt_*` per
 * delivery — identical text is never an identity.
 */
export function backgroundDeliveryId(ctoKey) {
  if (typeof ctoKey !== "string" || ctoKey.length === 0) return null;
  // Normalise long caller keys to a bounded, readable id: keep the source
  // namespace + a content-addressed digest of the full identity.
  if (ctoKey.length <= 200) return ctoKey;
  return `bg_${createHash("sha256").update(ctoKey).digest("hex").slice(0, 24)}`;
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
 * @param {(() => Promise<string|null>)} [deps.stamp] — the binding store's
 *   cheap change stamp (ctoStores `stamp()`), enabling a stamp-validated
 *   classification cache. Without it every seam classification pays a full
 *   binding.json read+parse — on EVERY ordinary project `opencode:prompt`.
 * @param {((sessionId: string) => Promise<unknown>)} [deps.abortSession] —
 *   the RAW oc abort, used only by the abort seam's documented untracked
 *   fallback (no unresolved admission record on the session).
 * @returns conversation service
 */
export function createCtoConversationService({
  binding,
  admission,
  agentName,
  stamp = null,
  abortSession = null,
}) {
  if (!binding || typeof binding.ensure !== "function" || typeof binding.getBinding !== "function") {
    throw new Error("createCtoConversationService requires the composed ctoBinding engine");
  }
  if (!admission || typeof admission.submit !== "function" || typeof admission.list !== "function") {
    throw new Error("createCtoConversationService requires the composed ctoAdmission engine");
  }
  if (typeof agentName !== "string" || agentName.length === 0) {
    throw new Error("createCtoConversationService requires the server-owned agent name");
  }

  // Stamp-validated classification cache: one stat per seam classification
  // instead of a binding.json read+parse. `stamp()` changes whenever the
  // binding store is written (ino:size:mtime:ctime), so a rebind invalidates
  // on the very next classification. Cache-miss direction (re-read) is the
  // safe direction; the stamp tuple makes a stale hit practically impossible.
  let classificationCache = { stamp: null, currentSessionId: null, previousSessionIds: [] };

  // The stamp dep with its failure mode folded in: null = no dep or a stat
  // error → always a cache miss (the classification itself never fails on a
  // stat; only a real binding read failure fails the seam, fail-open).
  const safeStamp = async () => {
    if (typeof stamp !== "function") return null;
    try {
      return await stamp();
    } catch {
      return null;
    }
  };

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
  // TRUE for the CURRENT binding's role session AND for a previous
  // generation's archived role session id: a delivery aimed at a replaced
  // session must still retarget through admission (whose dispatch resolves
  // the CURRENT binding) — classifying it "ordinary" would fire a pre-rebind
  // schedule into a dead session. An archived role id can never collide with
  // an ordinary project session. FAILS OPEN on a binding read failure (warn
  // + false): classification must never break ORDINARY project delivery, and
  // an unreadable store means the whole conversation runtime is already
  // failing loudly everywhere else. Reads are stamp-cached when a `stamp` dep
  // is wired (one stat per classification instead of read+parse).
  async function isConversationSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return false;
    let bound;
    try {
      // A stamp (stat) failure is a CACHE problem, not a classification
      // problem: degrading the CTO session to "ordinary" would raw-send past
      // the queue (worse than the pre-cache behavior). safeStamp() maps any
      // stamp error to null = cache miss; the real binding read decides.
      const current = await safeStamp();
      if (current !== null && current === classificationCache.stamp) {
        bound = {
          currentSessionId: classificationCache.currentSessionId,
          previousSessionIds: classificationCache.previousSessionIds,
        };
      }
      if (!bound) {
        bound = await binding.getBinding();
        if (typeof stamp === "function") {
          classificationCache = {
            stamp: await safeStamp(),
            currentSessionId: bound.currentSessionId ?? null,
            previousSessionIds: Array.isArray(bound.previousSessionIds)
              ? [...bound.previousSessionIds]
              : [],
          };
        }
      }
    } catch (e) {
      console.warn(
        `[cto-conversation] binding unreadable; treating session ${sessionId} as ordinary: ${describeErr(e)}`,
      );
      return false;
    }
    return (
      bound.currentSessionId === sessionId ||
      (Array.isArray(bound.previousSessionIds) && bound.previousSessionIds.includes(sessionId))
    );
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
      ...(input.expectedGeneration !== undefined ? { expectedGeneration: input.expectedGeneration } : {}),
      agent: agentName,
    });
  }

  // -- seam: abort (`opencode:abort`) at the bound role session --------------
  // Spec §8.3 names drain/abort: a raw session abort is INVISIBLE to
  // admission's abortState — the interrupted turn would settle `completed`
  // and a LATE abort could hit the next admitted turn. So the abort of the
  // bound role session routes onto the tracked interrupt path:
  //   • the currently ACCEPTED turn → `interrupt(record.id)` (tracked
  //     abortState, signal forwarded);
  //   • an `unknown` send → `interrupt(...)` → visible `cancel_requested`
  //     (barrier retained until reconcile — see contract limitation 1);
  //   • an existing marker: IDEMPOTENT only while an abort is genuinely in
  //     flight (interrupt_pending with abortState "pending"/"claimed") or
  //     already confirmed ("ok" — opencode accepted the stop). For the WEDGED
  //     states — abortState "uncertain" (a previous abort's outcome is
  //     permanently unknown) and "refused" (opencode declined the stop), and
  //     for `cancel_requested` (the unknown path issues NO abort at all) —
  //     the request falls through to the REAL raw abort: the turn may still
  //     be running, it is already untrackable, and stopping it is the honest
  //     action. Never a silent no-op success (AGENTS.md: a control that
  //     reports success while the model keeps running is the worst defect);
  //   • mid-`dispatching` → actionable error (the contract refuses an
  //     interrupt until the dispatch resolves — surface it, never guess);
  //   • NOTHING unresolved on the session → the caller's stop request is
  //     honored with the RAW session abort (a turn admission cannot see —
  //     pre-P3a3 or foreign — is not trackable, so no abortState is touched;
  //     this is exactly the contract's known limitation 2, unchanged).
  // Resolves the target record server-side from the durable queue: the
  // caller only knows the session id. Returns nothing (the Api is void) —
  // tracked status is visible via cto:conversation-state.
  const ABORT_IN_FLIGHT = new Set(["pending", "claimed"]);
  const ABORT_WEDGED = new Set(["uncertain", "refused"]);
  async function abortAdmittedTurn(sessionId) {
    const queue = await admission.list();
    const mine = queue.submissions.filter((r) => r.sessionId === sessionId);
    const accepted = mine.find((r) => r.status === "accepted");
    if (accepted) {
      await admission.interrupt(accepted.id);
      return;
    }
    const unknown = mine.find((r) => r.status === "unknown");
    if (unknown) {
      await admission.interrupt(unknown.id);
      return;
    }
    const dispatching = mine.find((r) => r.status === "dispatching");
    if (dispatching) {
      throw new Error(
        "cto conversation: the admitted turn is still mid-dispatch — retry the abort in a moment",
      );
    }
    const pendingMarker = mine.find((r) => r.status === "interrupt_pending");
    if (pendingMarker) {
      const state = pendingMarker.abortState;
      // Abort genuinely in flight (the durable request is about to be / is
      // being issued by its owner) or already confirmed by opencode: an
      // idempotent re-request, honest because the stop IS happening.
      if (ABORT_IN_FLIGHT.has(state) || state === "ok") return;
      // Wedged (uncertain / refused): the turn may still be running and no
      // abort is in flight — issue the real stop. The record's barrier is
      // admission's business (reconcile proves it out); the user's intent —
      // the turn STOPS — is served here.
      if (ABORT_WEDGED.has(state) && typeof abortSession === "function") {
        await abortSession(sessionId);
      }
      return;
    }
    const cancelMarker = mine.find((r) => r.status === "cancel_requested");
    if (cancelMarker) {
      // The unknown path NEVER issues an abort (a visible request marker
      // only). Without this fallback, Stop after a parked-unknown press is a
      // permanent silent no-op while the model keeps running. Fall through to
      // the real raw abort — the send's outcome is unreconciled, so the turn
      // may well be live and stopping it is exactly what Stop means.
      if (typeof abortSession === "function") {
        await abortSession(sessionId);
      }
      return;
    }
    if (typeof abortSession === "function") {
      await abortSession(sessionId);
    }
  }

  // -- seam: slash commands (`opencode:run-command`) at the conversation ----
  // Rejected with the clear copy until a later phase adds support.
  async function rejectRunCommand() {
    throw new Error(CTO_CONVERSATION_UNSUPPORTED_MESSAGE);
  }

  // -- seam: background prompt delivery -------------------------------------
  // promptDelivery calls this FIRST on every deliver(); returning null means
  // "not ours — continue ordinarily". A CONFIRMED conversation target is
  // submitted to admission with origin "background" and the CALLER's stable
  // delivery identity (ctoKey) when one exists — else a fresh unique id per
  // delivery (identical text is never an identity; see
  // backgroundDeliveryId). Submit refusals are surfaced as
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
        // Dedupe identity is the CALLER's stable delivery identity (ctoKey)
        // when one exists — a genuine retry of the same logical delivery
        // dedups (id-keyed, even against a terminal record, which is exactly
        // right for a retry); each NEW occurrence carries a fresh id. With
        // no identity, admission mints a fresh unique id per delivery —
        // identical text is NEVER the identity (that defect made a recurring
        // schedule fire once ever).
        ...(backgroundDeliveryId(args.ctoKey) ? { id: backgroundDeliveryId(args.ctoKey) } : {}),
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
    abortAdmittedTurn,
    rejectRunCommand,
    redirectDelivery,
    tick,
  };
}
