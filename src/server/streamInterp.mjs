// streamInterp.mjs — the box-side interpreter (BET-551 / §17).
//
// The box is the single interpreter of the opencode session stream. This
// module consumes each raw opencode event and, using the shared pure logic in
// src/shared/streamInterpretation.mjs, derives interpreted events that are
// published on the EXISTING in-process bus (events.mjs). It does not add a
// second stream, a second endpoint, or a parallel copy of the raw events —
// the same bus carries both the raw `opencode` envelope and the derived
// `stream.*` envelopes the clients will consume.
//
// Dependency-injected (publish + now) so it is pure/testable and never touches
// a live box. State is per opencode session id.
//
// Deliberately lean: it covers the derivations that are cleanly event-driven
// and reuses the moved shared functions directly so there is exactly one
// implementation of each (no drift). The renderer's *consumption* of these
// events is a later stage (S1b); this wires the transport.

import {
  classifyFinish,
  describeTruncation,
  findFlushBoundary,
  isSafeCut,
  FLUSH_MAX_AGE_MS,
  computeContextBreakdown,
  selectCacheTtlMs,
  computeStaleCache,
  selectLastAssistantCompletion,
  isTerminalTodo,
  allTodosTerminal,
  selectActiveTodos,
  selectVisibleTodos,
  applyQuestionEvent,
  applyPermissionEvent,
  isAssistantTurnComplete,
  registerChildSessionFromCreated,
  extractSubagentInfo,
  countRunningSubagents,
  shouldAutoRename,
  countUserTurns,
  buildTitlePromptInput,
  buildTitleInstruction,
  humanizeProviderError,
} from "../shared/streamInterpretation.mjs";
import { planModeFromToolPart } from "../shared/planMode.mjs";
import { createSeenIdFilter } from "./seenIds.mjs";

// opencode stamps its cache breakpoints with no `ttl`, so Anthropic applies
// its default 5-minute TTL — measured on the wire. This is the fallback the
// device stream predicts staleness against (the server-measured TTL is
// surfaced separately via `optimizer:summary`, BET-1334).
const TTL_DEFAULT_MS = 5 * 60_000;

// Recompute the cached-prefix size from a usage payload and publish the
// staleness verdict for a session.
//
// Two call sites need this: the transcript-derived context emit and the
// step-ended usage emit. They must agree byte-for-byte — including WHICH TTL
// is predicted — or the device's cache pill flickers between two verdicts
// depending on which event arrived last. Keeping it in one function is also
// what stops the TTL constant being read in two places and drifting, which is
// the shape of the bug this fallback exists to fix.
//
// The `|| st.cachedTokens` fallback is deliberate: a usage payload with no
// cache buckets (0 + 0) means "this event carries no cache information",
// not "the cache is now empty" — so the last known size is retained.
function emitCacheStaleness(emit, sid, st, tokens, nowMs) {
  st.cachedTokens =
    (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0) || st.cachedTokens;
  emit(sid, "cache", computeStaleCache({
    lastCompleted: st.lastCompleted,
    now: nowMs,
    ttlMs: selectCacheTtlMs(TTL_DEFAULT_MS),
    cachedTokens: st.cachedTokens,
    running: st.running,
  }));
}

// Per-tool cap for the live tool-output tail (server half, BET-745). Once a
// single tool has streamed this many characters to the device, further output
// is dropped for that tool and a single "...truncated" marker is emitted so an
// endless bash can't balloon the device stream or box memory.
const MAX_TOOL_OUTPUT_CHARS = 20_000;

/**
 * The latest index in `text` that is safe to cut at, or -1 if none is.
 *
 * Only used by the max-age fallback: `findFlushBoundary` found no structural
 * boundary, the buffer has been held too long, and we would rather emit a
 * partial line than keep the user waiting. Walks back from the end to the last
 * word break whose prefix passes `isSafeCut`, so we never cut inside an inline
 * code span, a link or a bold run — and never mid-word, which would make the
 * text visibly stutter.
 *
 * Returns -1 when nothing is safe (e.g. an unclosed code span running the whole
 * buffer), in which case the caller keeps buffering — correctness beats
 * latency.
 */
export function lastSafeCut(text) {
  if (!text) return -1;
  for (let i = text.length - 1; i > 0; i--) {
    if (text[i] !== " " && text[i] !== "\n") continue;
    const cut = i + 1;
    if (isSafeCut(text.slice(0, cut))) return cut;
  }
  return -1;
}

function newSessionState() {
  return {
    parts: new Map(),          // partID -> { messageID, field, text } (delta buffers)
    finalParts: new Set(),     // partIDs that got a message.part.updated snapshot
    partTypes: new Map(),      // partID -> part type ("text"|"reasoning"|...) from message.part.updated (BET-1209)
    tools: new Map(),          // toolIdx(partID) -> { idx, name, status, sent, truncated, ended }
    childSessionIds: new Set(),
    liveChildStatus: new Map(),
    questions: [],             // QuestionLike[]
    permissions: [],           // PermissionLike[] (pending permission requests)
    lastCompleted: null,
    cachedTokens: 0,
    running: false,
    runningSince: null,        // epoch ms when the running turn started (idle->busy edge)
    runningType: null,         // last session.status type ("busy"|"working"|"retry"|null); preserved for the connect-time snapshot replay
    todos: null,               // liveTodos (todo.updated) ; null = not seen
    handledPlanCallIds: new Set(), // callIDs that already emitted a planMode frame
    msgByMsgId: new Map(),     // messageID -> minimal message for turn detection
    userTurnCount: 0,
    contextEmitted: null,      // { totalInput, limit } of the last context emit
  };
}

// design: live tool-output frames (server half, BET-745).
//
// opencode re-emits `message.part.updated` for a tool part (~every 20-40ms)
// as the tool's stdout grows, with `part.type === "tool"`. The running tool's
// live stdout streams into `part.state.metadata.output` (NOT `state.output`,
// which only exists at completion). The canonical transcript only refreshes
// at refetch boundaries, so a thin client never saw the running tool until the
// turn ended. These three TEMPORARY frames publish it on the interpreted
// stream — additive only: every existing frame (`session.run`, `running`,
// `todos`, `truncation`, `subagent`, …) and the turnComplete/running books are
// untouched, and the same raw event still flows through every other branch.
//
// App contract (the iOS rendering half, sequenced BET, must read exactly these
// frame + field names so the two halves cannot drift):
//   toolStarted { sessionId, idx, callID, toolName, toolPresentationHint?, status }
//   toolOutput  { sessionId, idx, text }
//   toolEnded   { sessionId, idx, ok, truncated? }
//
// Field types:
//   sessionId            string   — the opencode session the tool belongs to
//   idx                  string   — the tool PART ID; stable per tool across the
//                                   whole run (identical on started/output/ended)
//   callID               string   — the tool's stable call id (opencode's
//                                   `callID`, falling back to `idx`); shared with
//                                   the canonical step row's id so a live row is
//                                   replaced IN PLACE by its completed sibling
//                                   instead of removing one and inserting another
//   toolName             string   — e.g. "bash", "read", "write", "task"
//   toolPresentationHint string?  — opencode's human title for the part (e.g.
//                                   "Run: npm test"); null when the box gave none
//   status               string   — "pending" | "running" | "completed" | "error"
//   text                 string   — a single incremental stdout chunk (the delta
//                                   since the last chunk, never the full output)
//   ok                   boolean  — toolEnded: true when the tool completed,
//                                   false when it errored
//   truncated            boolean  — present true only when the per-tool output
//                                   cap (MAX_TOOL_OUTPUT_CHARS) was hit
//
// Bounding: only the delta since the last chunk is ever sent (never the full
// output again), and the per-tool cap stops a long-running bash from
// ballooning the device stream; past the cap a single "...truncated" marker
// rides the last toolOutput and toolEnded carries `truncated: true`. All three
// frames are keyed by `idx`, so a duplicate/re-emitted part for the same tool
// is a no-op for started/ended and appends only newly-arrived bytes for output.
function updateToolFrames(st, sid, part, emit) {
  if (!part || part.type !== "tool") return;
  const idx = typeof part.id === "string" && part.id.length > 0 ? part.id : null;
  if (!idx) return;
  const state = part.state;
  const status = typeof state?.status === "string" ? state.status : null;
  if (!status) return;

  // The canonical step row is keyed by the tool's callID (see the Swift
  // `ChatTranscriptMapper.stepIdentity`). Stream that same id here so the live
  // row and its completed canonical sibling carry the same identity — the only
  // thing that lets the turn-boundary refetch REPLACE the row in place instead
  // of removing + inserting (a visible flash/reorder).
  const callID = typeof part.callID === "string" && part.callID.length > 0 ? part.callID : idx;

  let tool = st.tools.get(idx);

  // A tool the device hasn't been told about yet -> toolStarted.
  if (!tool) {
    tool = { idx, callID, name: part.tool ?? null, status, sent: 0, truncated: false, ended: false };
    st.tools.set(idx, tool);
    emit(sid, "toolStarted", {
      sessionId: sid,
      idx,
      callID,
      toolName: tool.name,
      toolPresentationHint: typeof state?.title === "string" ? state.title : null,
      status,
    });
  }

  // Live incremental stdout. The running tool streams into metadata.output;
  // send only the bytes not already delivered, bounded by the per-tool cap.
  if (status === "running" && typeof state?.metadata?.output === "string") {
    tool.status = status;
    const full = state.metadata.output;
    if (full.length > tool.sent) {
      if (tool.truncated) {
        // Cap already hit: advance the cursor silently so we never re-send.
        tool.sent = full.length;
      } else {
        const delta = full.slice(tool.sent);
        const room = MAX_TOOL_OUTPUT_CHARS - tool.sent;
        if (delta.length > room) {
          const kept = delta.slice(0, room);
          tool.sent += kept.length;
          tool.truncated = true;
          emit(sid, "toolOutput", { sessionId: sid, idx, text: kept + "… [output truncated]" });
        } else {
          tool.sent += delta.length;
          emit(sid, "toolOutput", { sessionId: sid, idx, text: delta });
        }
      }
    }
  }

  // Terminal statuses -> deliver any final tail, then toolEnded exactly once.
  // At completion the authoritative full output sits in state.output, which may
  // carry a few trailing bytes the live metadata.output hadn't flushed yet.
  if (status === "completed" || status === "error") {
    const finalOutput =
      typeof state?.output === "string"
        ? state.output
        : typeof state?.metadata?.output === "string"
          ? state.metadata.output
          : null;
    if (typeof finalOutput === "string" && finalOutput.length > tool.sent && !tool.truncated) {
      const delta = finalOutput.slice(tool.sent);
      tool.sent = finalOutput.length;
      emit(sid, "toolOutput", { sessionId: sid, idx, text: delta });
    }
    if (!tool.ended) {
      tool.ended = true;
      emit(sid, "toolEnded", {
        sessionId: sid,
        idx,
        ok: status === "completed",
        ...(tool.truncated ? { truncated: true } : {}),
      });
    }
  }
}

/**
 * Create a stream interpreter. `publish(env)` is the bus publisher (a thin
 * wrapper over events.mjs). `now()` returns epoch-ms. Returns `{ interpret,
 * getState }`.
 */
export function createStreamInterpreter({
  publish,
  now = () => Date.now(),
  contextLimitFor = () => null,
}) {
  const sessions = new Map();
  // The same opencode event is delivered on BOTH the global stream and the
  // per-directory scoped one, so interpret() is called twice for it. Un-deduped
  // that doubles every derived event — and because flushed text is APPENDED by
  // the client, a streamed answer arrived on the phone written out twice.
  // Events carry a unique id; remember a bounded window of them (shared filter,
  // lifted from this inline block so push.mjs can reuse the same guard).
  const seenEventIds = createSeenIdFilter();
  function state(sid) {
    if (!sessions.has(sid)) sessions.set(sid, newSessionState());
    return sessions.get(sid);
  }
  function emit(sid, sub, payload) {
    publish({ kind: "stream", sub, sessionId: sid, payload });
  }

  // The single place `running` changes. Stamps the idle->busy EDGE only, so a
  // mid-turn status re-emit cannot restart the clock, and clears the stamp
  // wherever the turn stops.
  function setRunning(st, running) {
    if (running && !st.running) st.runningSince = now();
    if (!running) st.runningSince = null;
    st.running = running;
  }

  function emitTurnComplete(sid, st, complete) {
    setRunning(st, st.running && !complete);
    emit(sid, "turnComplete", { complete, running: st.running, since: st.runningSince });
  }

  function interpret(evt) {
    if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return;
    const sid = evt.properties?.sessionID;
    if (typeof sid !== "string" || sid.length === 0) return; // no session to interpret for
    if (seenEventIds.seen(evt.id)) return;

    const st = state(sid);
    switch (evt.type) {
      case "message.part.delta": {
        // Delta flush boundaries. opencode sends the chunk FLAT
        // (`properties.{messageID, partID, field, delta}`) — there is no
        // `part` object and no `part.text` on this event. Reading only the
        // nested shape meant `chunk` was always empty, so not one flush was
        // ever emitted and a streaming answer reached the phone as silence.
        const part = evt.properties?.part;
        const messageID = evt.properties?.messageID ?? part?.messageID;
        const partID = evt.properties?.partID ?? part?.id;
        // opencode never sets `field` to "reasoning": its ReasoningPart carries
        // its content in a property literally named `text`, so a reasoning
        // delta arrives byte-identical to a prose delta. The only reliable
        // discriminator is the part's `type`, recorded from the
        // `message.part.updated` snapshot that opencode emits BEFORE it starts
        // streaming into the part (BET-1209). Fall back to the field/type when
        // no snapshot was seen (classified "text", today's behaviour).
        const rawField = evt.properties?.field ?? part?.type;
        const known = partID != null ? st.partTypes.get(partID) : null;
        const field = known === "reasoning" || rawField === "reasoning" ? "reasoning" : "text";
        const chunk =
          typeof evt.properties?.delta === "string"
            ? evt.properties.delta
            : typeof part?.text === "string"
              ? part.text
              : "";
        if (!messageID || !partID || !chunk) return;
        const cur = st.parts.get(partID) ?? { messageID, field, text: "", firstAt: now() };
        if (cur.firstAt == null) cur.firstAt = now();
        cur.text += chunk;
        let boundary = findFlushBoundary(cur.text);
        // Max-age fallback (BET-649). Without it a long run with no sentence
        // or paragraph break — a table, a bulleted line, a wall of prose —
        // stays buffered until the part's snapshot lands, which is the "it
        // arrived all at once at the end" case. Checked on the NEXT delta
        // rather than on a timer: deltas arrive continuously while the model
        // generates, so an age check here needs no clock of its own and the
        // interpreter stays purely event-driven.
        if (boundary <= 0 && now() - cur.firstAt >= FLUSH_MAX_AGE_MS) {
          boundary = lastSafeCut(cur.text);
        }
        if (boundary > 0) {
          const flushed = cur.text.slice(0, boundary);
          cur.text = cur.text.slice(boundary);
          cur.firstAt = now();
          emit(sid, "flush", { messageID, partID, field, text: flushed });
        }
        st.parts.set(partID, cur);
        return;
      }
      case "message.part.updated": {
        // subagent (task tool) + finalize part snapshot
        const part = evt.properties?.part;
        const partID = part?.id;
        // Record the part's type BEFORE the flush-and-finalize block below, so
        // a reasoning part that finalizes is withheld correctly (BET-1209).
        // opencode creates the part via `message.part.updated` (type known)
        // before streaming deltas into it, so this entry is present before the
        // first `message.part.delta` ever lands.
        if (partID != null && part?.type != null) st.partTypes.set(partID, part.type);
        if (partID && st.parts.has(partID)) {
          // Flush whatever is still buffered before dropping the part. A
          // boundary only fires at a paragraph break or a closed code fence,
          // so a short answer ends its whole life inside the buffer — without
          // this it was streamed as nothing at all. A REASONING part is the
          // one exception: its tail must NOT reach the device as prose, so it
          // is dropped un-flushed (BET-1209).
          if (st.partTypes.get(partID) !== "reasoning") {
            const pending = st.parts.get(partID);
            if (pending?.text) {
              emit(sid, "flush", {
                messageID: pending.messageID,
                partID,
                field: pending.field,
                text: pending.text,
              });
            }
          }
          st.finalParts.add(partID);
          if (st.parts.delete(partID)) st.partTypes.delete(partID);
        }
        const info = extractSubagentInfo(part);
        if (info) {
          emit(sid, "subagent", {
            ...info,
            runningCount: countRunningSubagents(
              messagesOf(st),
              st.liveChildStatus,
            ),
          });
        }
        // Live tool-output frames for any tool part (additive; the subagent
        // branch above still runs for task tools). A task subagent is also a
        // tool part, so it gets a toolStarted/…/toolEnded pair too — harmless
        // alongside the richer `subagent` frame.
        if (part?.type === "tool") updateToolFrames(st, sid, part, emit);
        // Plan-mode mirror (BET-977). Plan mode is NOT server state — opencode
        // switches its agent locally on plan_enter/plan_exit, so the box must
        // relay the fact for the phone's Plan chip to stay honest. Only a
        // COMPLETED plan_enter/plan_exit asserts a mode (an errored one,
        // e.g. "Keep planning" rejecting the exit, changed nothing). De-duped
        // per callID exactly like the desktop, so the same completed tool part
        // arriving twice emits one frame.
        const planNext = planModeFromToolPart(part);
        if (planNext !== null) {
          const callID = typeof part?.callID === "string" ? part.callID : "";
          if (callID && !st.handledPlanCallIds.has(callID)) {
            st.handledPlanCallIds.add(callID);
            emit(sid, "planMode", { on: planNext });
          }
        }
        return;
      }
      case "session.next.agent.switched": {
        // Report a switch that already happened (mirrors the desktop's
        // `session.next.agent.switched` branch). `properties.agent` is
        // opencode's own agent name — plan mode is exactly agent "plan".
        emit(sid, "planMode", { on: String(evt.properties?.agent ?? "") === "plan" });
        return;
      }
      case "session.created": {
        if (registerChildSessionFromCreated(evt, sid, st.childSessionIds)) {
          emit(sid, "subagent.child", {
            childSessionId: evt.properties?.info?.id,
          });
        }
        return;
      }
      case "message.updated": {
        // Context + cache reading from the live token breakdown. The
        // `session.next.step.ended` event that used to be the only source of
        // these frames does not fire on the deployed opencode build, so the
        // iOS context strip had no data. `message.updated` for an assistant
        // message carries the same token breakdown + model — emit `context`
        // and `cache` here instead. Deduped per session so the many `updated`
        // events in a turn do not spam the stream.
        const msgInfo = evt.properties?.info ?? evt.properties?.message;
        if (msgInfo?.role === "assistant" && msgInfo?.tokens) {
          const tokens = msgInfo.tokens;
          const totalInput =
            (tokens.input ?? 0) +
            (tokens.cache?.read ?? 0) +
            (tokens.cache?.write ?? 0);
          if (totalInput > 0) {
            const limit = contextLimitFor(msgInfo.providerID, msgInfo.modelID);
            if (
              !st.contextEmitted ||
              st.contextEmitted.totalInput !== totalInput ||
              st.contextEmitted.limit !== limit
            ) {
              st.contextEmitted = { totalInput, limit };
              emit(sid, "context", computeContextBreakdown(tokens, limit));
              emitCacheStaleness(emit, sid, st, tokens, now());
            }
          }
        }
        // turn-complete detection from the transcript payload when present
        const msg = evt.properties?.message ?? evt.properties?.info;
        if (Array.isArray(evt.properties?.messages)) {
          const msgs = evt.properties.messages;
          for (const m of msgs) if (m?.info?.id) st.msgByMsgId.set(m.info.id, m);
          const complete = isAssistantTurnComplete(msgs);
          const lastCompleted = selectLastAssistantCompletion(msgs);
          if (lastCompleted != null) st.lastCompleted = lastCompleted;
          const n = countUserTurns(msgs);
          if (n !== st.userTurnCount) {
            st.userTurnCount = n;
            if (shouldAutoRename(n)) {
              const input = buildTitlePromptInput(msgs);
              if (input) {
                emit(sid, "autoRename", {
                  turns: n,
                  promptInput: input,
                  instruction: buildTitleInstruction(input),
                });
              }
            }
          }
          emitTurnComplete(sid, st, complete);
          return;
        }
        // `properties.info` IS the message info, not a `{info}` wrapper —
        // the turn-completion helper expects the wrapper, so normalise here.
        // Without this no message was ever recorded and completion was judged
        // against an empty map, which reads as "complete" on every event.
        const wrapped = msg?.info ? msg : msg ? { info: msg } : null;
        if (wrapped?.info?.id) st.msgByMsgId.set(wrapped.info.id, wrapped);
        const complete = isAssistantTurnComplete([...st.msgByMsgId.values()]);
        emitTurnComplete(sid, st, complete);
        return;
      }
      case "session.status": {
        // The status is NESTED (`properties.status.type`); the flat
        // `properties.type` this used to read is never present, so every
        // status resolved to "not busy" and the running indicator never lit.
        const type = evt.properties?.status?.type ?? evt.properties?.type;
        // retry is a live turn for the renderer's running indicator (matches
        // pre-S1b renderer semantics) — the box is the single source of truth,
        // so it must report the same value the renderer's raw handler does.
        setRunning(st, type === "busy" || type === "working" || type === "retry");
        st.runningType = type ?? null;
        // `type` is ADDITIVE, not the indicator: `running` stays the single
        // source of truth for the running boolean, while `type` carries the
        // raw "busy" | "working" | "retry" (or null) so a thin client (iOS)
        // can distinguish a retry from a plain busy spinner without changing
        // what desktop already reads. Desktop ignores the new field.
        emit(sid, "running", { running: st.running, type, since: st.runningSince });
        return;
      }
      case "session.idle": {
        emitTurnComplete(sid, st, true);
        return;
      }
      case "session.error": {
        // MessageAbortedError is an intentional abort (user Stop, or the
        // desktop's queued-drain abort) — NOT a failure. Same name-check the
        // push pump uses (src/server/push.mjs, classifyPushEvent session.error
        // branch): the abort carries no other marker, the name is the only
        // signal. Do NOT emit it.
        const err = evt.properties?.error;
        const name = typeof err?.name === "string" ? err.name : null;
        if (name === "MessageAbortedError") return;
        const message =
          typeof err?.data?.message === "string" ? err.data.message :
          typeof err?.message === "string" ? err.message : "The turn failed.";
        // Unwrap a provider rejection body down to the human sentence so the
        // native iOS transcript notice shows the same clean text desktop does
        // (BET-1131). Lossless — unrecognised messages pass through unchanged.
        emit(sid, "sessionError", { name, message: humanizeProviderError(message) });
        emitTurnComplete(sid, st, true);
        return;
      }
      case "session.next.step.ended": {
        // truncation classification + context arithmetic
        const props = evt.properties ?? {};
        const finish = typeof props.finish === "string" ? props.finish : null;
        const kind = classifyFinish(finish, { lastPartIsToolUse: props.lastPartIsToolUse });
        if (kind) {
          // The renderer renders truncation per-message (finishByMessageId),
          // so carry the step's messageID when the raw event provides one
          // (S1b consumes this to stamp the badge on the right message).
          const messageID =
            typeof props.messageID === "string" ? props.messageID : undefined;
          emit(sid, "truncation", {
            kind,
            label: describeTruncation(kind).label,
            messageID,
          });
        }
        const tokens = props.tokens ?? props.usage;
        if (tokens) {
          emit(sid, "context", computeContextBreakdown(tokens, contextLimitFor(props.providerID, props.modelID)));
          // cache staleness: cachedTokens ~ cached prefix size
          emitCacheStaleness(emit, sid, st, tokens, now());
        }
        return;
      }
      case "todo.updated": {
        const raw = evt.properties?.todos ?? evt.properties?.todo;
        st.todos = Array.isArray(raw) ? raw : null;
        const active = selectActiveTodos(st.todos, null, false);
        emit(sid, "todos", {
          active,
          visible: active ? selectVisibleTodos(active) : null,
          allTerminal: active ? allTodosTerminal(active) : false,
          anyTerminal: active ? active.some(isTerminalTodo) : false,
        });
        return;
      }
      case "question.asked":
      case "question.replied":
      case "question.rejected": {
        st.questions = applyQuestionEvent(st.questions, evt.type, evt.properties, sid);
        emit(sid, "questions", { questions: st.questions });
        return;
      }
      // Permissions get the identical treatment to questions: they ride the
      // interpreted stream as a `permissions` frame. Trust-mode note: this
      // interpret() runs in the opencode pump BEFORE the chatAutoAllow
      // auto-allow branch in src/server/index.mjs, so under trust mode the
      // phone briefly receives a pending permission that the box answers
      // milliseconds later — the `permission.replied` opencode then emits
      // flows through this same case and clears it. That transient matches the
      // desktop sidebar's semantics; leave it.
      case "permission.asked":
      case "permission.replied":
      case "permission.rejected": {
        st.permissions = applyPermissionEvent(st.permissions, evt.type, evt.properties, sid);
        emit(sid, "permissions", { permissions: st.permissions });
        return;
      }
      default:
        return;
    }
  }

  return {
    interpret,
    getState: (sid) => sessions.get(sid),
    // Replay current edge-only state for the bus's connect-time snapshot
    // (BET-913 + BET-916 + BET-922). These frames are emitted only on an EDGE —
    // their current value is never re-sent on its own — so a client that
    // (re)connects mid-state never sees them: `questions` / `permissions`
    // frames fire only as `question.*` / `permission.*` events arrive, and the
    // running set below is reconstructed live. A fresh /events subscription
    // therefore recovers the still-pending interactive cards too. Each is
    // replayed with exactly the same envelope the live path emits, so a
    // reconnecting client needs no change.
    //
    // The COMPLETE set of currently-running sessions is replayed to every new
    // /events subscriber as ONE authoritative `runningSet` frame (BET-922).
    // BET-913 replayed one `stream/running` frame per busy session, which could
    // only ever ADD running state — a client that missed a turn ending stayed
    // latched forever. The set is always exactly one frame, index 0, even when
    // the list is empty: "nothing is running" is the correction a stale client
    // needs, and a client that receives nothing learns nothing. A session
    // absent from the set is NOT running.
    //
    // Replayed independently of one another and of `st.running`: a pending
    // question/permission blocks the turn but never sets `running`, so gating
    // on `running` would skip exactly the sessions that need the replay.
    snapshotState() {
      const running = [];
      for (const [sid, st] of sessions) {
        if (st.running && st.runningSince != null) {
          running.push({ sessionId: sid, since: st.runningSince, type: st.runningType ?? null });
        }
      }
      const out = [{ kind: "runningSet", payload: { sessions: running } }];
      for (const [sid, st] of sessions) {
        if (st.questions.length > 0) {
          out.push({
            kind: "stream",
            sub: "questions",
            sessionId: sid,
            payload: { questions: st.questions },
          });
        }
        if (st.permissions.length > 0) {
          out.push({
            kind: "stream",
            sub: "permissions",
            sessionId: sid,
            payload: { permissions: st.permissions },
          });
        }
      }
      return out;
    },
    sessions,
  };
}

// Collect all messages recorded from message.updated for transcript-derivable
// counters (subagent running count, etc.). Best-effort; missing -> [].
function messagesOf(st) {
  return [...st.msgByMsgId.values()];
}
