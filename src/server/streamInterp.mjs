// streamInterp.mjs — the box-side interpreter (BET-551 / §17).
//
// The box is the single interpreter of the opencode session stream. This
// module consumes each raw OpenCode V2 event (`{id, type, data}` from
// `GET /api/event`) and derives the interpreted events — the stream FRAMES — that
// are published on the EXISTING in-process bus (events.mjs). The frame
// vocabulary and every payload shape are unchanged by the V2 cutover (spec K2):
// clients cannot tell which opencode generation produced them.
//
// Dependency-injected (publish, now, timers, shell reader) so it is pure and
// testable and never touches a live box. State is per opencode session id.
//
// V2 → frame mapping (see docs/superpowers/specs/2026-10-16-opencode-v2-cutover.md):
//   session.execution.started            running(true)
//   session.execution.succeeded          running(false), turnComplete
//   session.execution.failed             sessionError, running(false), turnComplete
//   session.execution.interrupted        aborted, running(false), turnComplete
//   session.retry.scheduled              retry (cleared by the next step / turn edge)
//   session.text.delta / reasoning.delta flush (V2 deltas are phrase-level: no buffering)
//   session.step.started                 messageChanged (the step's message now exists)
//   session.step.ended                   stepEnded, truncation?, context, cache, messageChanged
//   session.tool.input.started / .called toolStarted (+ todos for todo_write)
//   session.tool.progress                subagent (child session) | live shell polling
//   session.tool.success / .failed       toolOutput tail, toolEnded, toolBoundary, subagent?, planMode?
//   session.created {parentID}           childSession (published under the PARENT)
//   session.agent.selected               planMode
//   session.compaction.started/delta/ended   compaction; transcriptStale once the compaction's execution settles
//   form.created (kind question) / .replied / .cancelled   questions + attention
//   permission.asked / .replied          permissions + attention
//   session.inbox.delivered              messageChanged (the user message now exists)
// `session.usage.updated` is CUMULATIVE for the session, so context/cache come
// from the per-step `session.step.ended` tokens instead (the size of the last
// request, which is what the context bar means).

import {
  classifyFinish,
  describeTruncation,
  computeContextBreakdown,
  selectCacheTtlMs,
  computeStaleCache,
  isTerminalTodo,
  allTodosTerminal,
  selectActiveTodos,
  selectVisibleTodos,
  applyQuestionEvent,
  applyPermissionEvent,
  extractSubagentInfo,
  humanizeProviderError,
} from "../shared/streamInterpretation.mjs";
import { isPlanAgent } from "../shared/planMode.mjs";
import {
  errorFromV2,
  isQuestionForm,
  normalizeToolInput,
  permissionFromV2,
  questionFromForm,
  toolNameFromV2,
  toolOutputText,
} from "../shared/opencodeV2.mjs";
import { createSeenIdFilter } from "./seenIds.mjs";

// opencode stamps its cache breakpoints with no `ttl`, so Anthropic applies
// its default 5-minute TTL — measured on the wire, see AppConfig.cacheTtl.
// This is the fallback the device stream predicts staleness against, used only
// while/unless the interpreter resolves the TTL opencode is actually
// configured to send (see `readCacheTtl` in createStreamInterpreter below).
const TTL_DEFAULT = "5m";

// At most one `messageChanged` frame per (session, message) per this window,
// with the trailing edge guaranteed (a change that lands inside the window is
// announced when the window closes, never dropped).
export const MESSAGE_CHANGED_COALESCE_MS = 100;

// Per-tool cap for the live tool-output tail (server half, BET-745). Once a
// single tool has streamed this many characters to the device, further output
// is dropped for that tool and a single "...truncated" marker is emitted so an
// endless bash can't balloon the device stream or box memory.
const MAX_TOOL_OUTPUT_CHARS = 20_000;

// How often a running shell's output is read (V2 pushes no per-chunk event).
export const SHELL_POLL_MS = 250;

function newSessionState() {
  return {
    tools: new Map(),          // toolID -> { idx, callID, v2Name, name, input, status, sent, truncated, ended, messageID, childSessionId?, shellID? }
    childSessionIds: new Set(),
    liveChildStatus: new Map(), // child session id -> "running" | "idle"
    questions: [],             // QuestionLike[]
    permissions: [],           // PermissionLike[] (pending permission requests)
    lastCompleted: null,
    cachedTokens: 0,
    running: false,
    runningSince: null,        // epoch ms when the running turn started (idle->busy edge)
    runningType: null,         // "busy" | "retry" | null; preserved for the connect-time snapshot replay
    todos: null,               // last todo_write list ; null = not seen
    model: null,               // { providerID, modelID } of the latest step
    contextEmitted: null,      // { totalInput, limit } of the last context emit
    retryActive: false,        // a non-null `retry` frame is outstanding
    attention: null,           // last `attention` kind emitted ("question"|"permission"|null)
    compacted: false,          // a compaction ended; the transcript goes stale when its execution settles
  };
}

const textOf = (x) => (typeof x === "string" ? x : "");

/**
 * Create a stream interpreter. `publish(env)` is the bus publisher (a thin
 * wrapper over events.mjs). `now()` returns epoch-ms. Returns `{ interpret,
 * getState, … }`.
 */
export function createStreamInterpreter({
  publish,
  now = () => Date.now(),
  contextLimitFor = () => null,
  // Resolves the cache TTL opencode is actually configured to send ("5m" |
  // "1h"), or null when nothing is set / it can't be read (non-fatal). Injected
  // like contextLimitFor so the interpreter stays pure/testable; production
  // wires providers.readCacheTtl. The device stream predicts staleness against
  // this — the SAME value the desktop SessionHeader pill reads — so the two
  // pills agree on a 1h box instead of the device always assuming 5m.
  readCacheTtl = async () => null,
  // Reads a running shell's output from `cursor` on: `{ output, cursor }`. The
  // shell resource is scoped to the session's directory (`evt.location`).
  // null disables live shell tailing (the full output still arrives at the end).
  fetchShellOutput = null,
  shellPollMs = SHELL_POLL_MS,
  // Timer seam for the `messageChanged` trailing edge and the shell poller (the
  // interpreter is otherwise purely event-driven). Production uses real,
  // unref'd timers; tests inject a fake queue driven by the same fake clock.
  setTimer = (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimer = (h) => clearTimeout(h),
}) {
  const sessions = new Map();
  const childParent = new Map(); // child session id -> parent session id
  // `messageChanged` coalescing state, keyed by session + message.
  const changed = new Map(); // key -> { sid, messageID, lastAt, timer }
  // Reconnects can re-deliver an event; events carry a unique id, so remember a
  // bounded window of them (shared filter, also used by push.mjs).
  const seenEventIds = createSeenIdFilter();
  // Configured cache TTL resolved once, non-blocking. Fetching it is async I/O
  // (providers.readCacheTtl reads opencode's config) while `interpret` is
  // synchronous, so resolve it in the background and read the memoized label
  // here; "5m" stays the fallback until/unless a configured value lands.
  let cacheTtlLabel = null;
  void (async () => {
    try {
      const label = await readCacheTtl();
      if (typeof label === "string" && label.length > 0) cacheTtlLabel = label;
    } catch {
      /* non-fatal: fall back to the 5m default */
    }
  })();
  function state(sid) {
    if (!sessions.has(sid)) sessions.set(sid, newSessionState());
    return sessions.get(sid);
  }
  function emit(sid, sub, payload) {
    publish({ kind: "stream", sub, sessionId: sid, payload });
  }

  // messageChanged: "the canonical copy of this message changed — refetch it".
  // Leading edge fires immediately; anything landing inside the next 100 ms is
  // folded into ONE trailing frame fired when the window closes, so the last
  // change is always announced and a chatty tool stream costs ~10 frames/s.
  function noteMessageChanged(sid, messageID) {
    if (typeof messageID !== "string" || messageID.length === 0) return;
    const key = `${sid}\u0000${messageID}`;
    let e = changed.get(key);
    if (!e) {
      e = { sid, messageID, lastAt: -Infinity, timer: null };
      changed.set(key, e);
    }
    if (e.timer != null) return; // the pending trailing frame will carry it
    const t = now();
    const wait = e.lastAt + MESSAGE_CHANGED_COALESCE_MS - t;
    if (wait <= 0) {
      e.lastAt = t;
      emit(sid, "messageChanged", { messageID });
      pruneChanged();
      return;
    }
    e.timer = setTimer(() => {
      e.timer = null;
      e.lastAt = now();
      emit(sid, "messageChanged", { messageID });
      pruneChanged();
    }, wait);
  }
  // Bound the map: an entry with no pending timer and an expired window carries
  // no information (the next change would fire on the leading edge anyway).
  function pruneChanged() {
    if (changed.size <= 256) return;
    const t = now();
    for (const [k, e] of changed) {
      if (e.timer == null && t - e.lastAt >= MESSAGE_CHANGED_COALESCE_MS) changed.delete(k);
    }
  }
  // Fire every pending trailing frame now (shutdown / end of a replay).
  function flushPending() {
    for (const e of changed.values()) {
      if (e.timer == null) continue;
      clearTimer(e.timer);
      e.timer = null;
      e.lastAt = now();
      emit(e.sid, "messageChanged", { messageID: e.messageID });
    }
  }
  function dispose() {
    for (const e of changed.values()) {
      if (e.timer != null) clearTimer(e.timer);
      e.timer = null;
    }
    changed.clear();
    for (const st of sessions.values()) for (const t of st.tools.values()) t.poll?.stop();
  }

  // The one "the turn is blocked on the user" badge: a pending question wins
  // over a pending permission (same precedence as peers.mjs), null when neither
  // is pending. Emitted on change only.
  function emitAttention(sid, st) {
    const kind = st.questions.length > 0 ? "question" : st.permissions.length > 0 ? "permission" : null;
    if (kind === st.attention) return;
    st.attention = kind;
    emit(sid, "attention", { kind });
  }

  // Clear an outstanding retry banner (new step / turn edge).
  function clearRetry(sid, st) {
    if (!st.retryActive) return;
    st.retryActive = false;
    emit(sid, "retry", null);
  }

  // Recompute the cached-prefix size from a usage payload and publish the
  // staleness verdict for a session. The `|| st.cachedTokens` fallback is
  // deliberate: a usage payload with no cache buckets (0 + 0) means "this event
  // carries no cache information", not "the cache is now empty".
  function emitCacheStaleness(sid, st, tokens, nowMs) {
    st.cachedTokens =
      (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0) || st.cachedTokens;
    emit(sid, "cache", computeStaleCache({
      lastCompleted: st.lastCompleted,
      now: nowMs,
      ttlMs: selectCacheTtlMs(cacheTtlLabel ?? TTL_DEFAULT),
      cachedTokens: st.cachedTokens,
      running: st.running,
    }));
  }

  // The single place `running` changes. Stamps the idle->busy EDGE only, so a
  // mid-turn status re-emit cannot restart the clock.
  function setRunning(st, running) {
    if (running && !st.running) st.runningSince = now();
    if (!running) st.runningSince = null;
    st.running = running;
  }

  function emitRunning(sid, st, running) {
    setRunning(st, running);
    st.runningType = running ? "busy" : null;
    emit(sid, "running", { running, type: running ? "busy" : "idle", since: st.runningSince });
  }

  function emitTurnComplete(sid, st, complete) {
    setRunning(st, st.running && !complete);
    emit(sid, "turnComplete", { complete, running: st.running, since: st.runningSince });
  }

  // ---- tool frames ---------------------------------------------------------
  //
  // toolStarted { sessionId, idx, callID, toolName, toolPresentationHint?, status }
  // toolOutput  { sessionId, idx, text }            (an incremental chunk, never the full output)
  // toolEnded   { sessionId, idx, ok, truncated? }
  // `idx` is the tool id (the part id the transcript mapper gives the same tool),
  // identical on started/output/ended, so a duplicate is a no-op.

  function ensureTool(sid, st, d) {
    const id = String(d.id ?? "");
    if (!id) return null;
    let tool = st.tools.get(id);
    if (!tool) {
      const v2Name = typeof d.name === "string" ? d.name : "";
      tool = {
        idx: id,
        callID: id,
        v2Name,
        name: toolNameFromV2(v2Name) || null,
        input: {},
        status: "pending",
        sent: 0,
        truncated: false,
        ended: false,
        messageID: d.assistantMessageID ?? null,
        started: false,
      };
      st.tools.set(id, tool);
    }
    if (!tool.v2Name && typeof d.name === "string") {
      tool.v2Name = d.name;
      tool.name = toolNameFromV2(d.name);
    }
    if (!tool.started && tool.name) {
      tool.started = true;
      emit(sid, "toolStarted", {
        sessionId: sid,
        idx: tool.idx,
        callID: tool.callID,
        toolName: tool.name,
        toolPresentationHint: null,
        status: "pending",
      });
    }
    return tool;
  }

  // Deliver `text` as incremental tool output, honouring the per-tool cap.
  function emitToolText(sid, tool, text) {
    if (!text) return;
    if (tool.truncated) {
      tool.sent += text.length; // cap already hit: advance silently
      return;
    }
    const room = MAX_TOOL_OUTPUT_CHARS - tool.sent;
    if (text.length > room) {
      const kept = text.slice(0, Math.max(0, room));
      tool.sent += kept.length;
      tool.truncated = true;
      emit(sid, "toolOutput", { sessionId: sid, idx: tool.idx, text: kept + "… [output truncated]" });
    } else {
      tool.sent += text.length;
      emit(sid, "toolOutput", { sessionId: sid, idx: tool.idx, text });
    }
  }

  function stopShellPoll(tool) {
    tool.poll?.stop();
    tool.poll = null;
  }

  // V2 pushes no per-chunk shell event: tail the shell resource by cursor.
  function startShellPoll(sid, tool, shellID, directory) {
    if (!fetchShellOutput || tool.poll || !shellID) return;
    let stopped = false;
    let timer = null;
    let cursor = 0;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await fetchShellOutput({ shellID, cursor, directory });
        if (!stopped && r && typeof r.output === "string" && r.output.length > 0) {
          cursor = Number.isFinite(r.cursor) ? r.cursor : cursor + Buffer.byteLength(r.output);
          emitToolText(sid, tool, r.output);
        }
      } catch {
        /* the shell may already be gone — the final output still arrives with the tool result */
      }
      if (!stopped) timer = setTimer(tick, shellPollMs);
    };
    timer = setTimer(tick, shellPollMs);
    tool.poll = {
      stop() {
        stopped = true;
        if (timer != null) clearTimer(timer);
      },
    };
  }

  function subagentFrame(sid, st, tool, status, output) {
    const input = normalizeToolInput("subagent", tool.input);
    const info = extractSubagentInfo({
      type: "tool",
      tool: "task",
      state: {
        status,
        input,
        metadata: { sessionId: tool.childSessionId, background: input.background === true },
        ...(output != null ? { output } : {}),
        title: typeof input.description === "string" ? input.description : undefined,
      },
    });
    if (!info) return;
    let running = 0;
    for (const t of st.tools.values()) {
      if (t.name !== "task" || !t.childSessionId) continue;
      const live = st.liveChildStatus.get(t.childSessionId);
      if ((live ?? (t.ended ? "idle" : "running")) === "running") running++;
    }
    emit(sid, "subagent", { ...info, runningCount: running });
  }

  function emitTodos(sid, st, list) {
    st.todos = Array.isArray(list) ? list : null;
    const active = selectActiveTodos(st.todos, null, false);
    emit(sid, "todos", {
      active,
      visible: active ? selectVisibleTodos(active) : null,
      allTerminal: active ? allTodosTerminal(active) : false,
      anyTerminal: active ? active.some(isTerminalTodo) : false,
    });
  }

  function finishTool(sid, st, d, ok) {
    const tool = ensureTool(sid, st, d);
    if (!tool) return;
    stopShellPoll(tool);
    if (ok) {
      const output = toolOutputText(tool.v2Name, d.content);
      if (output.length > tool.sent && !tool.truncated) emitToolText(sid, tool, output.slice(tool.sent));
      if (tool.name === "task" && tool.childSessionId) {
        st.liveChildStatus.set(tool.childSessionId, "idle");
        tool.ended = true;
        subagentFrame(sid, st, tool, "completed", output);
      }
    } else if (tool.name === "task" && tool.childSessionId) {
      st.liveChildStatus.set(tool.childSessionId, "idle");
      tool.ended = true;
      subagentFrame(sid, st, tool, "error", null);
    }
    tool.status = ok ? "completed" : "error";
    tool.ended = true;
    emit(sid, "toolEnded", { sessionId: sid, idx: tool.idx, ok, ...(tool.truncated ? { truncated: true } : {}) });
    emit(sid, "toolBoundary", {
      messageID: String(d.assistantMessageID ?? tool.messageID ?? ""),
      partID: tool.idx,
      callID: tool.callID,
      tool: String(tool.name ?? ""),
      status: ok ? "completed" : "error",
    });
    noteMessageChanged(sid, d.assistantMessageID ?? tool.messageID);
  }

  function interpret(evt) {
    if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return;
    const d = evt.data && typeof evt.data === "object" ? evt.data : {};
    // V2 stamps `data.sessionID` on every session-scoped event; a form carries
    // it inside `data.form`; a shell names its session in `info.metadata`.
    const sid = d.sessionID ?? d.form?.sessionID ?? d.info?.metadata?.sessionID;
    if (typeof sid !== "string" || sid.length === 0) return; // no session to interpret for
    if (seenEventIds.seen(evt.id)) return;

    const st = state(sid);
    switch (evt.type) {
      case "session.execution.started": {
        clearRetry(sid, st);
        emitRunning(sid, st, true);
        return;
      }
      case "session.execution.succeeded": {
        clearRetry(sid, st);
        emitRunning(sid, st, false);
        emitTurnComplete(sid, st, true);
        // The compaction rewrote the timeline: tell clients to refetch it, but
        // only once its execution settles — a client shows the "compacted"
        // confirmation for the `ended` frame first, and an immediate stale
        // frame would wipe that card in the same render.
        if (st.compacted) {
          st.compacted = false;
          emit(sid, "transcriptStale", {});
        }
        return;
      }
      case "session.execution.failed": {
        clearRetry(sid, st);
        const err = errorFromV2(d.error);
        const message = textOf(err?.data?.message) || "The turn failed.";
        // Unwrap a provider rejection body down to the human sentence so the
        // native iOS transcript notice shows the same clean text desktop does
        // (BET-1131). Lossless — unrecognised messages pass through unchanged.
        // `rawMessage` (additive, only when unwrapping changed the text) lets
        // the desktop keep classifying credential failures against the original.
        const human = humanizeProviderError(message);
        emit(sid, "sessionError", {
          name: err?.name ?? null,
          message: human,
          ...(human !== message ? { rawMessage: message } : {}),
        });
        emitRunning(sid, st, false);
        emitTurnComplete(sid, st, true);
        return;
      }
      case "session.execution.interrupted": {
        // An interrupt is a control outcome, not an error: no banner on iOS, and
        // the desktop shows its "aborted" notice unless it issued the abort itself.
        clearRetry(sid, st);
        emit(sid, "aborted", {});
        emitRunning(sid, st, false);
        emitTurnComplete(sid, st, true);
        for (const t of st.tools.values()) stopShellPoll(t);
        return;
      }
      case "session.retry.scheduled": {
        // The provider is being retried (rate limit, overload, seat limit). The
        // matching `null` follows on the next step / turn edge.
        st.retryActive = true;
        st.runningType = "retry";
        emit(sid, "retry", {
          attempt: typeof d.attempt === "number" ? d.attempt : 0,
          message: textOf(d.error?.message),
          ...(typeof d.at === "number" ? { next: d.at } : {}),
        });
        return;
      }
      case "session.step.started": {
        clearRetry(sid, st);
        if (d.model?.providerID && d.model?.id) st.model = { providerID: d.model.providerID, modelID: d.model.id };
        if (st.runningType === "retry") st.runningType = "busy";
        noteMessageChanged(sid, d.assistantMessageID);
        return;
      }
      case "session.inbox.delivered": {
        // The user's message id IS the inbox id; it joins the timeline now.
        noteMessageChanged(sid, d.inboxID);
        return;
      }
      case "session.text.started":
      case "session.text.ended":
      case "session.reasoning.started":
      case "session.reasoning.ended": {
        noteMessageChanged(sid, d.assistantMessageID);
        return;
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        const reasoning = evt.type === "session.reasoning.delta";
        const messageID = d.assistantMessageID;
        const chunk = textOf(d.delta);
        if (!messageID || !chunk) return;
        const field = reasoning ? "reasoning" : "text";
        // V2 deltas are phrase-level already, so they are forwarded as they
        // arrive; the part id is the one the transcript mapper gives the block.
        emit(sid, "flush", { messageID, partID: `${messageID}:${field}:${d.ordinal ?? 0}`, field, text: chunk });
        return;
      }
      case "session.tool.input.started": {
        ensureTool(sid, st, d);
        noteMessageChanged(sid, d.assistantMessageID);
        return;
      }
      case "session.tool.called": {
        const tool = ensureTool(sid, st, d);
        if (!tool) return;
        tool.input = d.input && typeof d.input === "object" ? d.input : {};
        tool.status = "running";
        if (tool.name === "todo_write" || tool.name === "todowrite") emitTodos(sid, st, tool.input.todos);
        noteMessageChanged(sid, d.assistantMessageID);
        return;
      }
      case "session.tool.progress": {
        const tool = ensureTool(sid, st, d);
        if (!tool) return;
        const md = d.metadata ?? {};
        if (typeof md.shellID === "string") {
          tool.shellID = md.shellID;
          startShellPoll(sid, tool, md.shellID, evt.location?.directory);
        }
        if (typeof md.sessionID === "string") {
          // A subagent: the parent learns its child's session id here.
          tool.childSessionId = md.sessionID;
          st.childSessionIds.add(md.sessionID);
          if (!st.liveChildStatus.has(md.sessionID)) st.liveChildStatus.set(md.sessionID, "running");
          subagentFrame(sid, st, tool, "running", null);
        }
        noteMessageChanged(sid, d.assistantMessageID);
        return;
      }
      case "session.tool.success": {
        finishTool(sid, st, d, true);
        return;
      }
      case "session.tool.failed": {
        finishTool(sid, st, d, false);
        return;
      }
      case "session.step.ended": {
        const tokens = d.tokens ?? {};
        const mid = String(d.assistantMessageID ?? "");
        st.lastCompleted = typeof evt.created === "number" ? evt.created : now();
        emit(sid, "stepEnded", {
          messageID: mid,
          // All zeros when the event carried no usage.
          tokens: {
            input: Number(tokens.input) || 0,
            output: Number(tokens.output) || 0,
            reasoning: Number(tokens.reasoning) || 0,
            cache: { read: Number(tokens.cache?.read) || 0, write: Number(tokens.cache?.write) || 0 },
          },
          ...(typeof d.cost === "number" && Number.isFinite(d.cost) ? { cost: d.cost } : {}),
          ...(typeof (d.rawFinish ?? d.finish) === "string" ? { finish: d.rawFinish ?? d.finish } : {}),
        });
        const lastIsTool = d.finish === "tool-calls";
        const kind = classifyFinish(d.rawFinish ?? d.finish ?? null, { lastPartIsToolUse: lastIsTool });
        if (kind) {
          emit(sid, "truncation", {
            kind,
            label: describeTruncation(kind).label,
            messageID: mid || undefined,
          });
        }
        const totalInput = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
        if (totalInput > 0) {
          const limit = st.model ? contextLimitFor(st.model.providerID, st.model.modelID) : null;
          if (!st.contextEmitted || st.contextEmitted.totalInput !== totalInput || st.contextEmitted.limit !== limit) {
            st.contextEmitted = { totalInput, limit };
            emit(sid, "context", computeContextBreakdown(tokens, limit));
          }
          emitCacheStaleness(sid, st, tokens, now());
        }
        noteMessageChanged(sid, mid);
        return;
      }
      case "session.created": {
        // A child (subagent) session announces itself; the frame is published
        // under the PARENT's id — the session a viewer is looking at.
        const parentId = d.parentID;
        if (typeof parentId === "string" && parentId.length > 0) {
          childParent.set(sid, parentId);
          state(parentId).childSessionIds.add(sid);
          emit(parentId, "childSession", { childSessionId: sid, parentSessionId: parentId });
        }
        if (d.model?.providerID && d.model?.id) st.model = { providerID: d.model.providerID, modelID: d.model.id };
        return;
      }
      case "session.deleted": {
        const own = sessions.get(sid);
        if (own) for (const t of own.tools.values()) stopShellPoll(t);
        sessions.delete(sid);
        childParent.delete(sid);
        return;
      }
      case "session.agent.selected": {
        // Plan mode IS the `plan` agent (V2 keeps the agent on the session).
        emit(sid, "planMode", { on: isPlanAgent(d.agent) });
        return;
      }
      case "session.model.selected": {
        if (d.model?.providerID && d.model?.id) st.model = { providerID: d.model.providerID, modelID: d.model.id };
        return;
      }
      case "form.created": {
        if (!isQuestionForm(d.form)) return;
        // The form is the V2 spelling of the question tool: re-shape it to the
        // QuestionRequest the card renders (the form id stays the reply key).
        st.questions = applyQuestionEvent(st.questions, "question.asked", questionFromForm(d.form), sid);
        // attention first: the `questions` frame stays the LAST one for the event.
        emitAttention(sid, st);
        emit(sid, "questions", { questions: st.questions });
        return;
      }
      case "form.replied":
      case "form.cancelled": {
        st.questions = applyQuestionEvent(
          st.questions,
          evt.type === "form.replied" ? "question.replied" : "question.rejected",
          { sessionID: sid, requestID: d.id },
          sid,
        );
        emitAttention(sid, st);
        emit(sid, "questions", { questions: st.questions });
        return;
      }
      // Permissions get the identical treatment to questions: they ride the
      // interpreted stream as a `permissions` frame. Trust-mode note: the pump
      // interprets `permission.asked` only when the user actually has to act on
      // it (see permissionAskPump.mjs), so a trust-mode ask never flashes a card.
      case "permission.asked": {
        st.permissions = applyPermissionEvent(st.permissions, "permission.asked", permissionFromV2(d), sid);
        emitAttention(sid, st);
        emit(sid, "permissions", { permissions: st.permissions });
        return;
      }
      case "permission.replied": {
        st.permissions = applyPermissionEvent(st.permissions, "permission.replied", { requestID: d.requestID }, sid);
        emitAttention(sid, st);
        emit(sid, "permissions", { permissions: st.permissions });
        return;
      }
      case "session.compaction.started": {
        emit(sid, "compaction", { phase: "started", text: "", ...(d.reason != null ? { reason: String(d.reason) } : {}) });
        return;
      }
      case "session.compaction.delta": {
        emit(sid, "compaction", { phase: "delta", text: textOf(d.text) });
        return;
      }
      case "session.compaction.ended": {
        emit(sid, "compaction", { phase: "ended" });
        st.compacted = true;
        return;
      }
      case "session.compacted": {
        st.compacted = false;
        emit(sid, "transcriptStale", {});
        return;
      }
      default:
        return;
    }
  }

  // After an event-stream reconnect (V2 has no replay) re-sync one session from
  // what the server reports NOW: `running` (is the turn still going?), pending
  // permission/question requests, and a `transcriptStale` so clients refetch.
  function resync(sid, { running, permissions, questions } = {}) {
    const st = sessions.get(sid);
    if (!st) return;
    if (running === false && st.running) {
      clearRetry(sid, st);
      emitRunning(sid, st, false);
      emitTurnComplete(sid, st, true);
    } else if (running === true && !st.running) {
      emitRunning(sid, st, true);
    }
    if (Array.isArray(permissions)) {
      st.permissions = [];
      for (const p of permissions) st.permissions = applyPermissionEvent(st.permissions, "permission.asked", p, sid);
      emitAttention(sid, st);
      emit(sid, "permissions", { permissions: st.permissions });
    }
    if (Array.isArray(questions)) {
      st.questions = [];
      for (const q of questions) st.questions = applyQuestionEvent(st.questions, "question.asked", q, sid);
      emitAttention(sid, st);
      emit(sid, "questions", { questions: st.questions });
    }
    emit(sid, "transcriptStale", {});
  }

  return {
    interpret,
    resync,
    flushPending,
    dispose,
    getState: (sid) => sessions.get(sid),
    knownSessionIds: () => [...sessions.keys()],
    // Replay current edge-only state for the bus's connect-time snapshot
    // (BET-913 + BET-916 + BET-922). These frames are emitted only on an EDGE —
    // their current value is never re-sent on its own — so a client that
    // (re)connects mid-state never sees them: `questions` / `permissions`
    // frames fire only as `form.*` / `permission.*` events arrive, and the
    // running set below is reconstructed live. A fresh /events subscription
    // therefore recovers the still-pending interactive cards too. Each is
    // replayed with exactly the same envelope the live path emits, so a
    // reconnecting client needs no change.
    //
    // The COMPLETE set of currently-running sessions is replayed to every new
    // /events subscriber as ONE authoritative `runningSet` frame (BET-922). The
    // set is always exactly one frame, index 0, even when the list is empty:
    // "nothing is running" is the correction a stale client needs. A session
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
        // Same precedence as the live `attention` frame (question over
        // permission) so a reconnecting sidebar shows the badge.
        const attention = st.questions.length > 0 ? "question" : st.permissions.length > 0 ? "permission" : null;
        if (attention) {
          out.push({ kind: "stream", sub: "attention", sessionId: sid, payload: { kind: attention } });
        }
        if (st.questions.length > 0) {
          out.push({ kind: "stream", sub: "questions", sessionId: sid, payload: { questions: st.questions } });
        }
        if (st.permissions.length > 0) {
          out.push({ kind: "stream", sub: "permissions", sessionId: sid, payload: { permissions: st.permissions } });
        }
      }
      return out;
    },
    sessions,
  };
}
