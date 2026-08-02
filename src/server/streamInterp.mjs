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
  hydrateQuestion,
  isAssistantTurnComplete,
  registerChildSessionFromCreated,
  extractSubagentInfo,
  collectChildSessionIds,
  countRunningSubagents,
  shouldAutoRename,
  countUserTurns,
  buildTitlePromptInput,
  buildTitleInstruction,
  sanitizeGeneratedTitle,
  ASSUMED_CONTEXT_TOKENS,
} from "../shared/streamInterpretation.mjs";

const TTL_DEFAULT = "1h";

function newSessionState() {
  return {
    parts: new Map(),          // partID -> { messageID, field, text } (delta buffers)
    finalParts: new Set(),     // partIDs that got a message.part.updated snapshot
    childSessionIds: new Set(),
    liveChildStatus: new Map(),
    questions: [],             // QuestionLike[]
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

    const st = state(sid);
    switch (evt.type) {
      case "message.part.delta": {
        // delta flush boundaries
        const part = evt.properties?.part;
        const messageID = evt.properties?.messageID ?? part?.messageID;
        const field = part?.type === "reasoning" ? "reasoning" : "text";
        const chunk = typeof part?.text === "string" ? part.text : "";
        const partID = part?.id;
        if (!messageID || !partID || !chunk) return;
        const cur = st.parts.get(partID) ?? { messageID, field, text: "" };
        cur.text += chunk;
        const boundary = findFlushBoundary(cur.text);
        if (boundary > 0) {
          const flushed = cur.text.slice(0, boundary);
          cur.text = cur.text.slice(boundary);
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
        if (msg?.info) st.msgByMsgId.set(msg.info.id ?? (msg.id ?? ""), msg);
        const complete = isAssistantTurnComplete([...st.msgByMsgId.values()]);
        emit(sid, "turnComplete", { complete, running: st.running && !complete });
        return;
      }
      case "session.status": {
        const type = evt.properties?.type;
        st.running = type === "busy" || type === "working";
        emit(sid, "running", { running: st.running });
        return;
      }
      case "session.idle": {
        st.running = false;
        emit(sid, "turnComplete", { complete: true, running: false });
        return;
      }
      case "session.next.step.ended": {
        // truncation classification + context arithmetic
        const props = evt.properties ?? {};
        const finish = typeof props.finish === "string" ? props.finish : null;
        const kind = classifyFinish(finish, { lastPartIsToolUse: props.lastPartIsToolUse });
        if (kind) emit(sid, "truncation", { kind, label: describeTruncation(kind).label });
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

export const __private = {
  newSessionState,
  messagesOf,
};

// Re-export the shared functions this module drives, so the server can use the
// box-side interpretation logic directly (DoD: "imported by the server").
export const interp = {
  classifyFinish,
  computeContextBreakdown,
  computeStaleCache,
  selectActiveTodos,
  selectVisibleTodos,
  hydrateQuestion,
  ASSUMED_CONTEXT_TOKENS,
};
