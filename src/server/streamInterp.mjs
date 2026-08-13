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
  resolveContextLimit,
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
  ASSUMED_CONTEXT_TOKENS,
} from "../shared/streamInterpretation.mjs";

const TTL_DEFAULT = "1h";

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
    childSessionIds: new Set(),
    liveChildStatus: new Map(),
    questions: [],             // QuestionLike[]
    permissions: [],           // PermissionLike[] (pending permission requests)
    lastCompleted: null,
    cachedTokens: 0,
    running: false,
    todos: null,               // liveTodos (todo.updated) ; null = not seen
    msgByMsgId: new Map(),     // messageID -> minimal message for turn detection
    userTurnCount: 0,
  };
}

/**
 * Create a stream interpreter. `publish(env)` is the bus publisher (a thin
 * wrapper over events.mjs). `now()` returns epoch-ms. Returns `{ interpret,
 * getState }`.
 */
export function createStreamInterpreter({ publish, now = () => Date.now() }) {
  const sessions = new Map();
  // The same opencode event is delivered on BOTH the global stream and the
  // per-directory scoped one, so interpret() is called twice for it. Un-deduped
  // that doubles every derived event — and because flushed text is APPENDED by
  // the client, a streamed answer arrived on the phone written out twice.
  // Events carry a unique id; remember a bounded window of them.
  const seenEventIds = new Set();
  const SEEN_CAP = 1000;
  function isDuplicate(id) {
    if (typeof id !== "string" || id.length === 0) return false;
    if (seenEventIds.has(id)) return true;
    seenEventIds.add(id);
    if (seenEventIds.size > SEEN_CAP) {
      // Drop the oldest half; insertion order is preserved by Set.
      let drop = seenEventIds.size - SEEN_CAP / 2;
      for (const key of seenEventIds) {
        if (drop-- <= 0) break;
        seenEventIds.delete(key);
      }
    }
    return false;
  }
  function state(sid) {
    if (!sessions.has(sid)) sessions.set(sid, newSessionState());
    return sessions.get(sid);
  }
  function emit(sid, sub, payload) {
    publish({ kind: "stream", sub, sessionId: sid, payload });
  }

  function interpret(evt) {
    if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return;
    const sid = evt.properties?.sessionID;
    if (typeof sid !== "string" || sid.length === 0) return; // no session to interpret for
    if (isDuplicate(evt.id)) return;

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
        const rawField = evt.properties?.field ?? part?.type;
        const field = rawField === "reasoning" ? "reasoning" : "text";
        const chunk =
          typeof evt.properties?.delta === "string"
            ? evt.properties.delta
            : typeof part?.text === "string"
              ? part.text
              : "";
        const partID = evt.properties?.partID ?? part?.id;
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
        if (partID && st.parts.has(partID)) {
          // Flush whatever is still buffered before dropping the part. A
          // boundary only fires at a paragraph break or a closed code fence,
          // so a short answer ends its whole life inside the buffer — without
          // this it was streamed as nothing at all.
          const pending = st.parts.get(partID);
          if (pending?.text) {
            emit(sid, "flush", {
              messageID: pending.messageID,
              partID,
              field: pending.field,
              text: pending.text,
            });
          }
          st.finalParts.add(partID);
          st.parts.delete(partID);
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
          emit(sid, "turnComplete", { complete, running: st.running && !complete });
          return;
        }
        // `properties.info` IS the message info, not a `{info}` wrapper —
        // the turn-completion helper expects the wrapper, so normalise here.
        // Without this no message was ever recorded and completion was judged
        // against an empty map, which reads as "complete" on every event.
        const wrapped = msg?.info ? msg : msg ? { info: msg } : null;
        if (wrapped?.info?.id) st.msgByMsgId.set(wrapped.info.id, wrapped);
        const complete = isAssistantTurnComplete([...st.msgByMsgId.values()]);
        emit(sid, "turnComplete", { complete, running: st.running && !complete });
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
        st.running = type === "busy" || type === "working" || type === "retry";
        emit(sid, "running", { running: st.running });
        return;
      }
      case "session.idle": {
        st.running = false;
        emit(sid, "turnComplete", { complete: true, running: false });
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
        st.running = false;
        const message =
          typeof err?.data?.message === "string" ? err.data.message :
          typeof err?.message === "string" ? err.message : "The turn failed.";
        emit(sid, "sessionError", { name, message });
        emit(sid, "turnComplete", { complete: true, running: false });
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
          const limit = resolveContextLimit(props.model) ?? ASSUMED_CONTEXT_TOKENS;
          emit(sid, "context", computeContextBreakdown(tokens, limit));
          // cache staleness: cachedTokens ~ cached prefix size
          st.cachedTokens =
            (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0) ||
            st.cachedTokens;
          emit(sid, "cache", computeStaleCache({
            lastCompleted: st.lastCompleted,
            now: now(),
            ttlMs: selectCacheTtlMs(TTL_DEFAULT),
            cachedTokens: st.cachedTokens,
            running: st.running,
          }));
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
    sessions,
  };
}

// Collect all messages recorded from message.updated for transcript-derivable
// counters (subagent running count, etc.). Best-effort; missing -> [].
function messagesOf(st) {
  return [...st.msgByMsgId.values()];
}
