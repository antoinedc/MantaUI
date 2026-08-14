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
  ASSUMED_CONTEXT_TOKENS,
} from "../shared/streamInterpretation.mjs";

const TTL_DEFAULT = "1h";

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
        // Live tool-output frames for any tool part (additive; the subagent
        // branch above still runs for task tools). A task subagent is also a
        // tool part, so it gets a toolStarted/…/toolEnded pair too — harmless
        // alongside the richer `subagent` frame.
        if (part?.type === "tool") updateToolFrames(st, sid, part, emit);
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
            const limit =
              contextLimitFor(msgInfo.providerID, msgInfo.modelID) ??
              ASSUMED_CONTEXT_TOKENS;
            if (
              !st.contextEmitted ||
              st.contextEmitted.totalInput !== totalInput ||
              st.contextEmitted.limit !== limit
            ) {
              st.contextEmitted = { totalInput, limit };
              emit(sid, "context", computeContextBreakdown(tokens, limit));
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
        emit(sid, "sessionError", { name, message });
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
          const limit =
            contextLimitFor(props.providerID, props.modelID) ??
            ASSUMED_CONTEXT_TOKENS;
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
    // Replay events for sessions that are currently running, for the bus's
    // connect-time snapshot (BET-913). The `running` frame is emitted only on
    // the idle->busy EDGE, so a client that (re)connects mid-turn never saw
    // it — this reconstructs it (with the original `since`, so the turn timer
    // survives a force-quit + relaunch). Empty when nothing is busy.
    snapshotBusy() {
      const out = [];
      for (const [sid, st] of sessions) {
        if (st.running && st.runningSince != null) {
          out.push({
            kind: "stream",
            sub: "running",
            sessionId: sid,
            payload: {
              running: true,
              type: st.runningType ?? null,
              since: st.runningSince,
            },
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
