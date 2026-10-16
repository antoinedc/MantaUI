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
// its default 5-minute TTL — measured on the wire, see AppConfig.cacheTtl.
// This is the fallback the device stream predicts staleness against, used only
// while/unless the interpreter resolves the TTL opencode is actually
// configured to send (see `readCacheTtl` in createStreamInterpreter below).
const TTL_DEFAULT = "5m";

// Slice A (OpenCode V2 migration, phase 1) completed the frame vocabulary so a
// client can stop reading raw `opencode` events altogether. The nine frames added
// there — retry, stepEnded, toolBoundary, compaction, transcriptStale,
// messageChanged, commandExecuted, childSession, attention — are documented
// (payload shapes pinned) next to the `StreamEnvelope` type in
// src/shared/types.ts and in
// docs/superpowers/specs/2026-10-16-opencode-v2-phase1-frames-phase3-plugins.md.
// Every one of them is derived through the same de-dup filter as the rest, so
// the global + per-directory double delivery never doubles a frame.

// At most one `messageChanged` frame per (session, message) per this window,
// with the trailing edge guaranteed (a change that lands inside the window is
// announced when the window closes, never dropped).
export const MESSAGE_CHANGED_COALESCE_MS = 100;

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
    retryActive: false,        // a non-null `retry` frame is outstanding (cleared by busy/idle)
    boundaryParts: new Set(),  // partIDs that already emitted a toolBoundary frame
    attention: null,           // last `attention` kind emitted ("question"|"permission"|null)
    stepFinishParts: new Set(),   // partIDs of step-finish parts that already produced a stepEnded frame
    stepsViaPart: new Map(),      // messageID -> number of steps announced from step-finish parts
    stepsViaEvent: new Map(),     // messageID -> number of steps announced from session.next.step.ended
  };
}

const finiteNumber = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

// Normalise a usage object (a step-finish part's `tokens`, or a step.ended
// event's `tokens`/`usage`) into the `stepEnded` payload shape. All zeros when
// the source carried no usage.
function stepTokensPayload(u) {
  const t = u && typeof u === "object" ? u : {};
  return {
    input: finiteNumber(t.input),
    output: finiteNumber(t.output),
    reasoning: finiteNumber(t.reasoning),
    cache: { read: finiteNumber(t.cache?.read), write: finiteNumber(t.cache?.write) },
  };
}

// Bound the per-message step counters (a long-lived session accumulates one
// entry per assistant message). Oldest-first eviction; an evicted message only
// risks a duplicate `stepEnded` if a late event for it arrives, which is benign.
const STEP_COUNTER_CAP = 512;
function boundStepCounters(st) {
  for (const m of [st.stepsViaPart, st.stepsViaEvent]) {
    if (m.size <= STEP_COUNTER_CAP) continue;
    let drop = m.size - STEP_COUNTER_CAP / 2;
    for (const k of m.keys()) {
      if (drop-- <= 0) break;
      m.delete(k);
    }
  }
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
  // Resolves the cache TTL opencode is actually configured to send ("5m" |
  // "1h"), or null when nothing is set / it can't be read (non-fatal). Injected
  // like contextLimitFor so the interpreter stays pure/testable; production
  // wires providers.readCacheTtl. The device stream predicts staleness against
  // this — the SAME value the desktop SessionHeader pill reads — so the two
  // pills agree on a 1h box instead of the device always assuming 5m.
  readCacheTtl = async () => null,
  // Timer seam for the `messageChanged` trailing edge (the interpreter is
  // otherwise purely event-driven). Production uses real, unref'd timers; tests
  // inject a fake queue driven by the same fake clock as `now`.
  setTimer = (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimer = (h) => clearTimeout(h),
}) {
  const sessions = new Map();
  // `messageChanged` coalescing state, keyed by session + message.
  const changed = new Map(); // key -> { sid, messageID, lastAt, timer }
  // The same opencode event is delivered on BOTH the global stream and the
  // per-directory scoped one, so interpret() is called twice for it. Un-deduped
  // that doubles every derived event — and because flushed text is APPENDED by
  // the client, a streamed answer arrived on the phone written out twice.
  // Events carry a unique id; remember a bounded window of them (shared filter,
  // lifted from this inline block so push.mjs can reuse the same guard).
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
  // change is always announced and a 30 ms tool-output stream costs ~10 frames/s
  // instead of ~30.
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

  // Clear an outstanding retry banner (busy / idle / session.idle).
  function clearRetry(sid, st) {
    if (!st.retryActive) return;
    st.retryActive = false;
    emit(sid, "retry", null);
  }

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
      ttlMs: selectCacheTtlMs(cacheTtlLabel ?? TTL_DEFAULT),
      cachedTokens: st.cachedTokens,
      running: st.running,
    }));
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
    // opencode stamps `properties.sessionID` on every session-scoped event; the
    // info/part fallbacks cover the message.* family on a build that nests it.
    const sid = evt.properties?.sessionID ?? evt.properties?.info?.sessionID ?? evt.properties?.part?.sessionID;
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
        // messageID lives on the PART for this event (properties.messageID is
        // undefined) — resolving only the top-level path is the "debounce
        // starvation" bug (AGENTS.md).
        noteMessageChanged(sid, evt.properties?.messageID ?? part?.messageID ?? evt.properties?.info?.id);
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
        // Step boundary: a tool part reaching a terminal status. This is the
        // trigger the queued-prompt drain keys on (the build emits no
        // session.next.step.ended). Once per part.
        if (
          part?.type === "tool" &&
          typeof partID === "string" && partID.length > 0 &&
          (part.state?.status === "completed" || part.state?.status === "error") &&
          !st.boundaryParts.has(partID)
        ) {
          st.boundaryParts.add(partID);
          emit(sid, "toolBoundary", {
            messageID: String(part.messageID ?? evt.properties?.messageID ?? ""),
            partID,
            callID: typeof part.callID === "string" && part.callID.length > 0 ? part.callID : partID,
            tool: String(part.tool ?? ""),
            status: part.state.status,
          });
        }
        // stepEnded from the step-finish PART. The deployed V1 build never emits
        // `session.next.step.ended`, but every step it runs ends with a
        // `step-finish` part carrying the same usage/cost/reason — derive the
        // frame from that (once per part id). A build that emits BOTH is
        // reconciled per message: steps are counted from each source and a step
        // already announced by the other source is not announced again.
        if (
          part?.type === "step-finish" &&
          typeof partID === "string" && partID.length > 0 &&
          !st.stepFinishParts.has(partID)
        ) {
          st.stepFinishParts.add(partID);
          const mid = String(part.messageID ?? evt.properties?.messageID ?? "");
          const nth = (st.stepsViaPart.get(mid) ?? 0) + 1;
          st.stepsViaPart.set(mid, nth);
          boundStepCounters(st);
          if ((st.stepsViaEvent.get(mid) ?? 0) < nth) {
            emit(sid, "stepEnded", {
              messageID: mid,
              tokens: stepTokensPayload(part.tokens),
              ...(typeof part.cost === "number" && Number.isFinite(part.cost) ? { cost: part.cost } : {}),
              ...(typeof part.reason === "string" && part.reason.length > 0 ? { finish: part.reason } : {}),
            });
          }
        }
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
        // A child (subagent) session announces itself. On the wire
        // `properties.sessionID` is the NEW session's own id and the parent is
        // `info.parentID`, so the frame is published under the PARENT's id —
        // the session a viewer is looking at.
        const childId = evt.properties?.info?.id;
        const parentId = evt.properties?.info?.parentID;
        if (
          typeof childId === "string" && childId.length > 0 &&
          typeof parentId === "string" && parentId.length > 0
        ) {
          emit(parentId, "childSession", { childSessionId: childId, parentSessionId: parentId });
        }
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
        noteMessageChanged(sid, evt.properties?.messageID ?? evt.properties?.part?.messageID ?? msgInfo?.id);
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
        if (type === "retry") {
          // Provider is being retried (rate limit, overload, seat limit). Carry
          // everything the banner renders; the matching `null` follows on busy/idle.
          const status = evt.properties?.status ?? {};
          const action = status.action;
          st.retryActive = true;
          emit(sid, "retry", {
            attempt: typeof status.attempt === "number" ? status.attempt : 0,
            message: typeof status.message === "string" ? status.message : "",
            ...(typeof status.next === "number" ? { next: status.next } : {}),
            ...(action && typeof action === "object"
              ? {
                  action: {
                    title: String(action.title ?? ""),
                    message: String(action.message ?? ""),
                    label: String(action.label ?? ""),
                    ...(action.link != null ? { link: String(action.link) } : {}),
                  },
                }
              : {}),
          });
        } else {
          clearRetry(sid, st);
        }
        // `type` is ADDITIVE, not the indicator: `running` stays the single
        // source of truth for the running boolean, while `type` carries the
        // raw "busy" | "working" | "retry" (or null) so a thin client (iOS)
        // can distinguish a retry from a plain busy spinner without changing
        // what desktop already reads. Desktop ignores the new field.
        emit(sid, "running", { running: st.running, type, since: st.runningSince });
        return;
      }
      case "session.idle": {
        clearRetry(sid, st);
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
        {
          const mid = String(props.messageID ?? props.info?.id ?? "");
          const nth = (st.stepsViaEvent.get(mid) ?? 0) + 1;
          st.stepsViaEvent.set(mid, nth);
          boundStepCounters(st);
          // Already announced by this step's step-finish part → don't double it.
          if ((st.stepsViaPart.get(mid) ?? 0) < nth) {
            emit(sid, "stepEnded", {
              messageID: mid,
              // All zeros when the event carried no usage.
              tokens: stepTokensPayload(props.tokens ?? props.usage),
              ...(typeof props.cost === "number" ? { cost: props.cost } : {}),
              ...(finish != null ? { finish } : {}),
            });
          }
        }
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
        // attention first: the `questions` frame stays the LAST one for the event.
        emitAttention(sid, st);
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
        emitAttention(sid, st);
        emit(sid, "permissions", { permissions: st.permissions });
        return;
      }
      case "message.part.removed":
      case "message.removed": {
        noteMessageChanged(sid, evt.properties?.messageID ?? evt.properties?.part?.messageID ?? evt.properties?.info?.id);
        return;
      }
      case "session.next.compaction.started": {
        const p = evt.properties ?? {};
        emit(sid, "compaction", {
          phase: "started",
          text: String(p.text ?? ""),
          ...(p.reason != null ? { reason: String(p.reason) } : {}),
        });
        return;
      }
      case "session.next.compaction.delta": {
        emit(sid, "compaction", { phase: "delta", text: String(evt.properties?.delta ?? "") });
        return;
      }
      case "session.next.compaction.ended": {
        emit(sid, "compaction", { phase: "ended" });
        return;
      }
      case "session.compacted": {
        emit(sid, "transcriptStale", {});
        return;
      }
      case "command.executed": {
        const p = evt.properties ?? {};
        emit(sid, "commandExecuted", {
          messageID: String(p.messageID ?? ""),
          name: String(p.name ?? ""),
          arguments: String(p.arguments ?? ""),
        });
        return;
      }
      default:
        return;
    }
  }

  return {
    interpret,
    flushPending,
    dispose,
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
        // Same precedence as the live `attention` frame (question over
        // permission) so a reconnecting sidebar shows the badge.
        const attention = st.questions.length > 0 ? "question" : st.permissions.length > 0 ? "permission" : null;
        if (attention) {
          out.push({ kind: "stream", sub: "attention", sessionId: sid, payload: { kind: attention } });
        }
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
