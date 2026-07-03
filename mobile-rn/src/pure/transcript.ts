// transcript.ts — pure mapping of the box's `opencode:messages` RPC response
// into the read-only row view model the RN SessionDetailScreen's FlatList
// renders, plus the live-update helpers (delta merge + idle flip).
//
// This is the mobile port of the minimal subset of the desktop's transcript
// derivation (src/renderer/ChatPanel.tsx `onOpencodeEvent` + the message/part
// shapes in src/shared/types.ts). Kept PURE — no fetch, no RN, no timers — so
// it is fully unit-testable without a live box.
//
// Wire shape (mirrors GET /session/{id}/message on the opencode server):
//   message  = { info: { id, role, time?: { created? }, modelID? }, parts: Part[] }
//   part     = { type: "text"|"reasoning"|"tool"|..., id, text?, tool?, state?, ... }
//
// The desktop keeps a rich 12-variant part renderer. For a read-only mobile
// transcript we collapse each message into ONE row carrying:
//   - role (user / assistant)
//   - the concatenated text of its visible text parts
//   - a compact one-line summary per tool-call part
// and a top-level `running` flag driven by session.idle / session.status.

// ---- Raw wire types (subset we read) ----

/** One part as returned by opencode (subset). */
export interface RawPart {
  type: string;
  id?: string;
  /** text-bearing variants ("text", "reasoning") carry a string here. */
  text?: string;
  /** text-part flags — synthetic/ignored parts are hidden from the UI. */
  synthetic?: boolean;
  ignored?: boolean;
  /** tool parts carry the tool name + a state object. */
  tool?: string;
  state?: { status?: string; title?: string } | null;
  [k: string]: unknown;
}

/** One message as returned by opencode (subset). */
export interface RawMessage {
  info?: {
    id?: string;
    role?: string;
    time?: { created?: number } | null;
    modelID?: string;
  } | null;
  parts?: RawPart[] | null;
}

// ---- View model ----

/** A single tool-call summary line within a message row. */
export interface ToolCallVM {
  /** Stable key within the row: part id (or a synthesized index fallback). */
  key: string;
  /** Tool name, e.g. "read", "bash", "edit". */
  name: string;
  /** "running" | "completed" | "error" | "pending" — from state.status. */
  status: string;
  /** Optional one-line title opencode attaches (e.g. the file path). */
  title?: string;
}

/** A rendered message row (one per transcript message). */
export interface MessageRowVM {
  /** Stable FlatList key: the opencode message id. */
  key: string;
  /** "user" | "assistant". */
  role: "user" | "assistant";
  /** Concatenated visible text of the message's text/reasoning parts. */
  text: string;
  /** Tool-call summaries, in part order. */
  tools: ToolCallVM[];
  /** Assistant model id, when present (shown as a subtle byline). */
  model?: string;
  /** Creation time (ms) for stable ordering; 0 when unknown. */
  createdAt: number;
}

/** The full transcript view model + top-level running flag. */
export interface TranscriptVM {
  rows: MessageRowVM[];
  /** True while the session is mid-turn (streaming); flipped by idle/status. */
  running: boolean;
}

const TEXT_PART_TYPES = new Set(["text", "reasoning"]);

function normRole(role: unknown): "user" | "assistant" {
  return role === "user" ? "user" : "assistant";
}

/**
 * Collapse one raw message into a row VM. Concatenates visible text parts and
 * summarizes tool parts. Defensive: a malformed part is skipped, never thrown.
 * Pure.
 */
export function mapMessageRow(msg: RawMessage, index: number): MessageRowVM {
  const info = msg?.info ?? {};
  const id = typeof info.id === "string" && info.id.length > 0 ? info.id : `msg-${index}`;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];

  const textChunks: string[] = [];
  const tools: ToolCallVM[] = [];

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || typeof p !== "object") continue;
    if (TEXT_PART_TYPES.has(p.type)) {
      if (p.synthetic || p.ignored) continue;
      if (typeof p.text === "string" && p.text.length > 0) textChunks.push(p.text);
    } else if (p.type === "tool") {
      const name = typeof p.tool === "string" && p.tool.length > 0 ? p.tool : "tool";
      const state = p.state ?? undefined;
      tools.push({
        key: typeof p.id === "string" && p.id.length > 0 ? p.id : `${id}:tool:${i}`,
        name,
        status: typeof state?.status === "string" ? state.status : "pending",
        title: typeof state?.title === "string" ? state.title : undefined,
      });
    }
  }

  return {
    key: id,
    role: normRole(info.role),
    text: textChunks.join("\n\n"),
    tools,
    model: typeof info.modelID === "string" ? info.modelID : undefined,
    createdAt: typeof info.time?.created === "number" ? info.time.created : 0,
  };
}

/**
 * Map a raw `opencode:messages` response into a transcript view model.
 * Defensive against a non-array / malformed payload (yields an empty
 * transcript rather than throwing). `running` starts false; live events flip
 * it via {@link applyOpencodeEvent}. Pure.
 */
export function mapTranscript(raw: unknown): TranscriptVM {
  if (!Array.isArray(raw)) return { rows: [], running: false };
  const rows: MessageRowVM[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    if (!m || typeof m !== "object") continue;
    rows.push(mapMessageRow(m as RawMessage, i));
  }
  return { rows, running: false };
}

// ---- Live update helpers ----

/**
 * A narrowed opencode event (the `payload` of a `{kind:"opencode"}` /events
 * envelope). `properties` carries the event-specific fields.
 */
export interface OpencodeEventLike {
  type: string;
  properties?: Record<string, unknown> | null;
}

/**
 * Merge a single `message.part.delta` event's text into the matching message
 * row, appending to the row's text. Mirrors the desktop's delta accumulation
 * (`pendingDeltas` → flush) but simplified: we append directly to the row's
 * concatenated text, since the mobile read-only view doesn't need per-part
 * flush-boundary buffering.
 *
 * A delta whose `messageID` matches no existing row is dropped (the canonical
 * refetch / message.updated will materialize it). Returns a NEW rows array
 * only when something changed; otherwise returns the SAME reference so callers
 * can skip a re-render. Pure.
 */
export function mergeDelta(
  rows: MessageRowVM[],
  props: Record<string, unknown>,
): MessageRowVM[] {
  const messageID = typeof props.messageID === "string" ? props.messageID : "";
  const delta = typeof props.delta === "string" ? props.delta : "";
  // Only merge text-field deltas (reasoning parts also stream `field:"text"`).
  const field = typeof props.field === "string" ? props.field : "text";
  if (!messageID || !delta || field !== "text") return rows;

  const idx = rows.findIndex((r) => r.key === messageID);
  if (idx < 0) return rows;

  const target = rows[idx];
  const next = rows.slice();
  next[idx] = { ...target, text: target.text + delta };
  return next;
}

/**
 * Apply one opencode event to a transcript VM, returning the next VM (same
 * reference when nothing changed, so callers can bail out of a re-render).
 *
 * Handled events (the read-only subset):
 *   - message.part.delta → append streamed text to the matching row.
 *   - session.idle       → running = false (turn over).
 *   - session.status     → running = (status.type is "busy"|"retry").
 *
 * Everything else (message.updated, tool state, todo.updated, …) is left to the
 * caller's debounced refetch — this helper only owns the cheap live edits.
 * Pure.
 */
export function applyOpencodeEvent(
  vm: TranscriptVM,
  ev: OpencodeEventLike,
): TranscriptVM {
  const props = ev?.properties ?? {};

  if (ev.type === "message.part.delta") {
    const nextRows = mergeDelta(vm.rows, props);
    // A delta means the session is actively producing output → running.
    if (nextRows === vm.rows && vm.running) return vm;
    return { rows: nextRows, running: true };
  }

  if (ev.type === "session.idle") {
    if (!vm.running) return vm;
    return { ...vm, running: false };
  }

  if (ev.type === "session.status") {
    const status = props.status as { type?: string } | undefined;
    const t = status?.type;
    const running = t === "busy" || t === "retry";
    if (running === vm.running) return vm;
    return { ...vm, running };
  }

  return vm;
}
