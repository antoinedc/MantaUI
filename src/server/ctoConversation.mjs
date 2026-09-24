// BET-P3a3: src/server/ctoConversation.mjs — the production composition of
// the CTO conversation runtime (unified-cto-spec §3.1 + §8.3) and the seams
// that keep every writer on the durable admission queue.
//
// Scope (deliberately small): the four authenticated conversation channels
// (open / state / submit / interrupt) plus the seams that route EVERY write
// — including file attachments, resolved @agent mentions, and slash
// commands (P3a3 full-parity widening, admission-contract ADR) — onto the
// SAME durable admission queue. Nothing bypasses it, and as of this
// widening nothing is rejected outright either:
//   • the `opencode:prompt` / `opencode:run-command` RPC routes (human
//     traffic aimed at the conversation session; the `opencode:abort` seam
//     is deliberately DEFERRED to its own PR — a session-wide abort of the
//     role session is inherently unsafe once the admission barrier can
//     release, see docs/cto-admission-contract.md),
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
// (its own sendPrompt/sendCommand deps), so a redirected delivery can never
// loop back through promptDelivery, and admission's own dispatch never
// re-enters this service. The firehose tap feeding admission.observeEvent is
// one-way.
//
// PLAN MODE: uses the restricted CTO planner, never the general-purpose
// planner. User text and slash-command arguments are never rewritten.

import { createHash } from "node:crypto";

// Global reads are available to every session; project mutations belong only
// to an active executive turn. Check before approving or invoking an action.
export function authorizeCtoProjectMutation(tool, sessionID, state, agentName) {
  if (!tool || !["confirm", "goal"].includes(tool.mode) || !/^(projects|sessions|work)_/.test(tool.name)) return { ok: true };
  const refuse = (error) => ({ ok: false, code: "policy_blocked", retrySafe: false, error });
  if (!sessionID || sessionID !== state?.binding?.sessionId) {
    return refuse("Project management actions are restricted to the current CTO conversation; other sessions may use the read operations.");
  }
  const active = state.submissions?.find((s) => s.sessionId === sessionID &&
    ["dispatching", "accepted", "unknown"].includes(s.status));
  if (!active || !agentName || active.agent !== agentName) {
    return refuse("Project mutations are unavailable outside an active CTO execution turn (including plan mode). Switch to execution mode to dispatch work.");
  }
  return { ok: true };
}
// Terminal statuses — the redirect reports a submit receipt's terminal
// outcome honestly (a terminal replay has NOTHING queued; 202 would promise
// a run that will never happen).
import { TERMINAL } from "./ctoAdmission.mjs";

function describeErr(err) {
  return err?.message ? String(err.message) : String(err);
}

/**
 * The composer's optimistic messageID → the admission dedupe id, for the two
 * opencode seams (admitDirect / admitCommand). Present only when it is a
 * non-empty string; otherwise admission mints a fresh id. Distinct from
 * submit()'s pass-through contract, which forwards the caller's `id` field
 * verbatim.
 */
function messageIDToId(input) {
  return typeof input.messageID === "string" && input.messageID.length > 0 ? input.messageID : undefined;
}

/**
 * The shared middle of the three human-origin admission payloads (submit /
 * admitDirect / admitCommand) — one assembly so the seams cannot drift.
 *
 * The per-seam differences stay AT the seams, parameterised here:
 *   • `withText` — the prompt seams always carry a `text` key (even when the
 *     value is undefined, exactly as the inline `text: input.text` did); the
 *     command seam carries none (its kind is "command").
 *   • `id` — submit() passes the caller's idempotency key through VERBATIM
 *     (undefined → absent); the opencode seams derive it from the composer's
 *     optimistic messageID via messageIDToId().
 *   • property ORDER is preserved exactly (text, id, model,
 *     expectedGeneration, attachments) so each seam's submitted record keeps
 *     the key order it always had — admission persists these records and
 *     their serialized shape is part of the durable store.
 * `mentions` and the command-only fields (kind/command/args) remain at the
 * seams: they are ordered differently per seam (mentions after the shared
 * fields on the prompt seams, kind/command/args before the shared fields on
 * the command seam), so folding them in here would change record shape.
 */
function humanAdmissionFields(input, { withText, id }) {
  return {
    ...(withText ? { text: input.text } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.expectedGeneration !== undefined ? { expectedGeneration: input.expectedGeneration } : {}),
    ...(Array.isArray(input.attachments) && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
  };
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
 * @param {string} [deps.planAgentName] — the ONE additional agent a caller
 *   may reach (providers.mjs MANTA_PLAN_AGENT_NAME). A closed, one-entry
 *   server-side allowlist (full-parity widening item 5) — see resolveAgent.
 *   Absent/empty → the allowlist is empty and every `agent` value is dropped,
 *   identical to the pre-widening behavior (safe default for tests that
 *   don't wire it).
 * @param {(() => Promise<string|null>)} [deps.stamp] — the binding store's
 *   cheap change stamp (ctoStores `stamp()`), enabling a stamp-validated
 *   classification cache. Without it every seam classification pays a full
 *   binding.json read+parse — on EVERY ordinary project `opencode:prompt`.
 * @returns conversation service
 */
export function createCtoConversationService({
  binding,
  admission,
  agentName,
  planAgentName = null,
  stamp = null,
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

  /**
   * Map the composer's plan selection to the restricted CTO planner.
   */
  function resolveAgent(inputAgent) {
    return (planAgentName && inputAgent === planAgentName) || inputAgent === `${agentName}-plan`
      ? `${agentName}-plan` : agentName;
  }

  function rejectInlineWorkers(input) {
    if (Array.isArray(input.mentions) && input.mentions.length) {
      throw new Error("@agent mentions run inline tasks and are unavailable in the CTO conversation. Ask the CTO to dispatch a worker in the target project instead.");
    }
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
      droppedByPolicy: queue.droppedByPolicy,
    };
  }

  // -- channel: cto:conversation-submit -------------------------------------
  // The human turn. Origin is fixed ("human" — the caller is the CEO side of
  // the conversation; the server stamps it, never the request body). `id` is
  // the caller's idempotency key: a same-id/same-payload replay returns the
  // existing record, a same-id/different-payload is an actionable error.
  // Full-parity widening: attachments/mentions ride through verbatim (a
  // prompt-kind submission only — this channel has no slash-command
  // concept, see admitCommand for that) and `agent` passes through the
  // closed plan-mode allowlist (resolveAgent) — never an arbitrary value.
  async function submit(input) {
    requireInputObject(input);
    rejectInlineWorkers(input);
    return admission.submit({
      origin: "human",
      ...humanAdmissionFields(input, { withText: true, id: input.id }),
      ...(Array.isArray(input.mentions) && input.mentions.length > 0 ? { mentions: input.mentions } : {}),
      agent: resolveAgent(input.agent),
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
        // Cache under the PRE-READ stamp only. Re-stamping AFTER the read
        // would store pre-write data under a post-write stamp when a binding
        // write lands in the read window — a stale hit that classifies the
        // LIVE session as ordinary until the next write (50/50 bypass). The
        // pre-read stamp makes any write that landed during the read
        // invalidate on the very next classification; a failed pre-read
        // stamps nothing (always-miss is always correct).
        if (typeof stamp === "function" && typeof current === "string") {
          classificationCache = {
            stamp: current,
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
  // Routed through the same durable admission queue with a stable id (the
  // caller's messageID when present — the composer's optimistic id — else
  // admission mints one). Full-parity widening: file attachments and
  // resolved @agent mentions ride through VERBATIM (admission.submit hashes
  // them into the same canonical idempotency key and hands them to
  // sendPrompt unchanged — opencode.mjs already turns them into file/agent
  // parts for an ordinary session). The caller's `agent` field passes
  // through the closed plan-mode allowlist (resolveAgent): every value
  // except the ONE allow-listed plan agent is still dropped exactly as
  // before — the server owns the role agent. Throws actionable errors
  // (at-cap, stale-generation, invalid attachment/mention shape, ...) —
  // never fake success.
  async function admitDirect(input) {
    requireInputObject(input);
    rejectInlineWorkers(input);
    return admission.submit({
      origin: "human",
      ...humanAdmissionFields(input, { withText: true, id: messageIDToId(input) }),
      ...(Array.isArray(input.mentions) && input.mentions.length > 0 ? { mentions: input.mentions } : {}),
      agent: resolveAgent(input.agent),
    });
  }

  // -- seam: slash commands (`opencode:run-command`) at the conversation ----
  // Full-parity widening: a command aimed at the conversation session is
  // routed through the SAME durable admission queue as a direct send, via a
  // `kind:"command"` record (admission.submit validates command/args and
  // refuses outright — before persisting anything — if no sendCommand
  // transport is wired). Every existing admission guarantee is preserved
  // (one turn at a time, durable dedup by id, the queue projection shape,
  // the interrupt/abort barrier, the definitive-4xx-vs-uncertain crash
  // classification) — only the dispatcher changes (sendCommand instead of
  // sendPrompt, a different opencode endpoint). `agent` passes through the
  // SAME closed plan-mode allowlist as admitDirect.
  async function admitCommand(input) {
    requireInputObject(input);
    // Templates can execute shell expansions or spawn subagents before role
    // tools are evaluated. Keep command execution in project sessions.
    throw new Error("Slash commands execute in project sessions, not the CTO conversation. Ask the CTO to dispatch this command in the target project.");
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
      // Honest outcome mapping (round 4): a receipt that is already TERMINAL
      // (a genuine retry replaying a settled record or tombstone — e.g. a
      // cancelled-by-policy drop) has NOTHING queued and nothing running:
      // queued:true here becomes HTTP 202 "queued" to the webhook sender for
      // a delivery that will never run. Terminal → deduped (the redelivery
      // dedupe shape: seen, not acted on); anything still live → queued.
      const terminal = TERMINAL.has(receipt.status);
      return {
        redirected: true,
        result: {
          delivered: false,
          queued: !terminal,
          ...(terminal ? { deduped: true } : {}),
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
    admitCommand,
    redirectDelivery,
    tick,
  };
}
