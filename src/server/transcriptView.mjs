// transcriptView.mjs — what a transcript MEANS, decided on the box (WS11 D8–D11 / audit T1–T5, T8, T16).
//
// Both clients used to derive the same facts from the raw messages — a finished turn's footer, a truncation warning,
// the inline media, the plan card, a tool run's wording — each with its own copy of the rules. `opencode:messages` /
// `opencode:message` called with `{view:true}` now carry them: `message.view` (+ `part.view`). Pure; no I/O.
//
// D8: `view.turn` and `view.truncation`.
// D9: `view.media` (the canonical inline media of a message the BOX owns) and `part.view.media` (a file part that is
//     an image/video).
// D11: `part.view.{activity,runId,segmentId,gen}` and `message.view.runs` (the runs a message touches, each with its
//     wording, summary and revision) — rules in transcriptRuns.mjs, shared with the live ledger.

import { classifyFinish, describeTruncation } from "../shared/streamInterpretation.mjs";
import { MIME_BY_EXT } from "../shared/mediaMime.mjs";
import { activityView, computeRuns, runView } from "./transcriptRuns.mjs";

/** A finished background run (v2-next N4) carries a `background-result` part. */
export function isBackgroundResultMessage(message) {
  return Array.isArray(message?.parts) && message.parts.some((p) => p?.type === "background-result");
}

/**
 * Turn footers, keyed by the turn's LAST assistant message id. A user message or a background result starts a turn;
 * `tokens` = Σ output + reasoning over the turn's assistant steps; `verbSeedId` = the turn's FIRST assistant message.
 * A turn gets no entry when its last assistant message has no `time.completed`, or — while `running` — when that
 * message is the window's last (the in-flight turn).
 * @returns {Map<string, { durationMs: number|null, tokens: number|null, verbSeedId: string }>}
 */
export function computeTurns(messages, { running = false } = {}) {
  const out = new Map();
  if (!Array.isArray(messages)) return out;
  const lastId = messages[messages.length - 1]?.info?.id;
  let i = 0;
  while (i < messages.length) {
    const head = messages[i];
    if (head?.info?.role !== "user" && !isBackgroundResultMessage(head)) {
      i++;
      continue;
    }
    let j = i + 1;
    let firstStart = null;
    let lastEnd = null;
    let tokens = 0;
    let last = null;
    let seed = null;
    while (j < messages.length && messages[j]?.info?.role === "assistant" && !isBackgroundResultMessage(messages[j])) {
      const m = messages[j];
      const t = m.info.time;
      if (firstStart == null && t?.created != null) firstStart = t.created;
      if (t?.completed != null) lastEnd = t.completed;
      const tok = m.info.tokens;
      if (tok) tokens += (tok.output ?? 0) + (tok.reasoning ?? 0);
      if (seed == null) seed = m.info.id;
      last = m;
      j++;
    }
    if (last && seed != null && !(running && last.info.id === lastId) && last.info.time?.completed != null) {
      out.set(last.info.id, {
        durationMs: firstStart != null && lastEnd != null && lastEnd > firstStart ? lastEnd - firstStart : null,
        tokens: tokens > 0 ? tokens : null,
        verbSeedId: seed,
      });
    }
    i = j;
  }
  return out;
}

/** The truncation the transcript itself records for an assistant message: `{kind, label, hint}` or null. */
export function truncationOf(message) {
  if (message?.info?.role !== "assistant") return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  let stepReason = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p?.type === "step-finish" && typeof p.reason === "string" && p.reason !== "") {
      stepReason = p.reason;
      break;
    }
  }
  const finish = message.info.finish;
  const kind = classifyFinish(stepReason ?? finish, { lastPartIsToolUse: finish === "tool-calls" });
  if (!kind) return null;
  const { label, hint } = describeTruncation(kind);
  return { kind, label, hint };
}

// ---- D9: canonical media ---------------------------------------------------------------------------------------

/** Media extension → mime (the image/video part of the box's one allowlist, `MIME_BY_EXT`). */
function mediaMimeForPath(path) {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const mime = MIME_BY_EXT[path.slice(dot).toLowerCase()];
  return mime && (mime.startsWith("image/") || mime.startsWith("video/")) ? mime : null;
}

function mediaKindOf(mime) {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return null;
}

/** `"Handle: <hex>"` out of a `media_begin` result, or null. */
export function beginHandle(output) {
  const i = output.indexOf("Handle: ");
  if (i < 0) return null;
  const m = /^[0-9a-fA-F]+/.exec(output.slice(i + "Handle: ".length));
  return m ? m[0] : null;
}

/**
 * `"Displayed <path> (<mime>[ <W>x<H>], <size> bytes) in the transcript."`. The path is anchored on the LAST " (" so a
 * path containing spaces or parentheses still parses. Returns null for anything else.
 */
export function parseShowOutput(output) {
  const prefix = "Displayed ";
  const suffix = " bytes) in the transcript.";
  const text = output.trim();
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  const body = text.slice(prefix.length, text.length - suffix.length);
  const open = body.lastIndexOf(" (");
  if (open < 0) return null;
  const path = body.slice(0, open);
  const inner = body.slice(open + 2);
  const comma = inner.lastIndexOf(", ");
  if (path === "" || comma < 0) return null;
  const sizeText = inner.slice(comma + 2).trim();
  if (!/^-?\d+$/.test(sizeText)) return null;
  const meta = inner.slice(0, comma).split(" ").filter(Boolean);
  if (meta.length === 0) return null;
  let width = null;
  let height = null;
  if (meta.length >= 2) {
    const dims = meta[1].split("x");
    if (dims.length === 2) {
      const w = Number(dims[0]);
      const h = Number(dims[1]);
      if (dims[0] !== "" && dims[1] !== "" && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        width = w;
        height = h;
      }
    }
  }
  return { path, mime: meta[0], width, height, size: Number(sizeText) };
}

const positive = (n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);
const nonEmpty = (s) => (typeof s === "string" && s !== "" ? s : null);

/** The identity rule, verbatim from the phone: a handle gives `media:h:<handle>`, else the show call's message + path. */
export function mediaId({ handle, showMessageId, path }) {
  return handle ? `media:h:${handle}` : `media:s:${showMessageId}:${path}`;
}

/**
 * Canonical inline media over a list of messages (session-wide over what was loaded): every completed `media_begin`
 * seeds a pending entry owned by the begin's message; every completed `media_show` resolves it (by handle, else by
 * message + path) to ready. A begin that was never shown draws nothing. Returns READY entries only, in first-sight
 * order, each carrying `ownerMessageId`.
 * @returns {Array<{ id: string, ownerMessageId: string, kind: "image"|"video", path: string, mime: string|null,
 *   width: number|null, height: number|null, aspectRatio: number|null, count: number|null, size: number|null,
 *   title: string|null, handle: string|null }>}
 */
export function canonicalMediaEntries(messages) {
  const byId = new Map();
  let seq = 0;
  for (const message of messages ?? []) {
    if (message?.info?.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (part?.type !== "tool") continue;
      const state = part.state && typeof part.state === "object" ? part.state : {};
      if (state.status !== "completed") continue;
      const input = state.input && typeof state.input === "object" ? state.input : {};
      const output = typeof state.output === "string" ? state.output : "";
      if (part.tool === "media_begin") {
        const handle = beginHandle(output);
        if (!handle) continue;
        const id = mediaId({ handle, showMessageId: "", path: "" });
        if (byId.has(id)) continue;
        const count = typeof input.count === "number" && Number.isFinite(input.count) ? Math.round(input.count) : null;
        byId.set(id, {
          id, ownerMessageId: message.info.id, seq: seq++, ready: false,
          kind: input.kind === "video" ? "video" : "image",
          path: null, mime: null,
          width: positive(input.width), height: positive(input.height), aspectRatio: positive(input.aspectRatio),
          count, size: null, title: nonEmpty(input.title), handle,
        });
      } else if (part.tool === "media_show") {
        const out = parseShowOutput(output);
        if (!out) continue;
        const handle = nonEmpty(input.handle);
        const id = mediaId({ handle, showMessageId: message.info.id, path: out.path });
        const mime = out.mime ?? mediaMimeForPath(out.path);
        const kind = mediaKindOf(mime);
        const existing = byId.get(id);
        if (existing) {
          existing.ready = true;
          existing.path = out.path;
          existing.mime = mime;
          existing.size = out.size;
          existing.kind = kind ?? existing.kind;
          existing.title = nonEmpty(input.title) ?? existing.title;
        } else {
          byId.set(id, {
            id, ownerMessageId: message.info.id, seq: seq++, ready: true,
            kind: kind ?? "image", path: out.path, mime,
            width: out.width, height: out.height, aspectRatio: null, count: null,
            size: out.size, title: nonEmpty(input.title), handle,
          });
        }
      }
    }
  }
  return [...byId.values()]
    .filter((e) => e.ready)
    .sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ seq: _seq, ready: _ready, ...entry }) => entry);
}

/** A file part that is an image/video on the box's disk: `{kind, path}`, else null. */
export function filePartMedia(part) {
  if (part?.type !== "file") return null;
  const kind = mediaKindOf(typeof part.mime === "string" ? part.mime : null);
  const url = typeof part.url === "string" ? part.url : "";
  if (!kind || !url.startsWith("file://")) return null;
  const path = url.slice("file://".length);
  return path ? { kind, path } : null;
}

const withFileViews = (message) => {
  if (!Array.isArray(message?.parts)) return message;
  let changed = false;
  const parts = message.parts.map((p) => {
    const media = filePartMedia(p);
    if (!media) return p;
    changed = true;
    return { ...p, view: { ...(p.view ?? {}), media } };
  });
  return changed ? { ...message, parts } : message;
};

/**
 * `runContext` (optional): the window PLUS up to RUN_LOOKBACK earlier records — runs are walked over it so a run that
 * began before the window keeps its true id and owner (rev/windows: see the spec's "Window edges"). `runContextOpen`: older
 * records exist that were not read, so a run that reaches the context's start is anchored at the window instead.
 * `ledger` (optional) is the live run ledger of the session: `{epoch, gen, runView(id), runOfPart(id)}`. A run it knows
 * is emitted with ITS view and revision (a full fetch can never regress live state); history it does not know gets
 * `rev {epoch, gen, seq: 0}` and the canonical summary.
 */
function withRunViews(messages, ledger, { single = false, runContext = null, runContextOpen = false } = {}) {
  let walked = computeRuns(runContext ?? messages);
  if (runContext && runContextOpen && !walked.anchored) {
    // The first run reaches back past what was read (more than RUN_LOOKBACK records before the window). That only matters
    // when it ALSO has a part inside the window (it is drawn there); a run that ended before the window is never drawn, so an
    // ordinary tail refetch that merely starts inside an old run is not a problem and is not logged.
    const first = walked.walker.runs.get(walked.walker.order[0]);
    const inWindow = new Set(messages.flatMap((m) => (m?.parts ?? []).map((p) => p?.id)));
    if (first?.parts.some((p) => inWindow.has(p.id))) {
      // Annotate as if it began at the window — an id that is stable for THIS window only (the spec's accepted edge).
      console.warn(`[transcript] a run reaches back more than the lookback before the window (${messages[0]?.info?.id ?? "?"}); anchoring it at the window`);
      walked = computeRuns(messages);
    }
  }
  const { walker, partRun, messageRuns } = walked;
  const epoch = ledger?.epoch ?? "";
  const gen = ledger?.gen ?? 1;
  // A run's view by id: the ledger's (with its revision) when it knows the run, else the canonical walk's at seq 0.
  const viewById = (id) => {
    const live = ledger?.runView?.(id);
    if (live) return live;
    const run = walker.runs.get(id);
    return run ? runView(walker, run, { epoch, gen, seq: 0 }) : null;
  };
  // PAYLOAD (measured, transcriptView.payload.test.mjs): the full RunView on EVERY message of a long run is quadratic, so a
  // list response carries it ONLY on the run's placement message (the first in-window message touching it — its owner when
  // that is in the window); every other message carries a RunRef `{id, rev, ref:true}` a client never lets overwrite a
  // stored value. A lone `getMessage` is self-contained: always full.
  const placed = new Set();
  return messages.map((m) => {
    const localIds = messageRuns.get(m?.info?.id);
    if (!localIds) return m;
    // A lone message is stamped from the LEDGER where it knows the part (step 2+ of a live run belongs to a run that began in
    // an earlier message), and carries exactly the runs its parts reference — never an id of its own making.
    const ids = single && ledger ? [] : localIds;
    let parts = m.parts;
    if (Array.isArray(parts)) {
      parts = parts.map((p) => {
        let at = partRun.get(p.id);
        if (!at) return p;
        if (single && ledger) {
          const live = ledger.runOfPart?.(p.id);
          if (live) at = live;
          if (!ids.includes(at.runId)) ids.push(at.runId);
        }
        const split = (ledger?.runView?.(at.runId)?.segments ?? (walker.runs.get(at.runId)?.segments.length > 1 ? true : null)) != null;
        return { ...p, view: { ...(p.view ?? {}), activity: activityView(p), runId: at.runId, ...(split ? { segmentId: at.segmentId } : {}), gen } };
      });
    }
    const runs = ids
      .map((id) => viewById(id))
      .filter(Boolean)
      .map((view) => {
        if (single || !placed.has(view.id)) {
          placed.add(view.id);
          return view;
        }
        return { id: view.id, rev: view.rev, ref: true };
      });
    return { ...m, parts, view: { ...(m.view ?? {}), runs } };
  });
}

/**
 * Add `view` to each message. Pure: returns new message objects; a message with nothing to say gets no `view`.
 * `running`: the session has a turn in flight (the box reads it from the interpreter), which withholds the footer of
 * the in-flight turn. `ledger` / `single` / `runContext`: see `withRunViews`.
 * @param {any[]} messages
 * @param {{running?: boolean, ledger?: any, single?: boolean, runContext?: any[]|null, runContextOpen?: boolean}} [opts]
 */
export function annotateView(messages, { running = false, ledger = null, single = false, runContext = null, runContextOpen = false } = {}) {
  const turns = computeTurns(messages, { running });
  const mediaByOwner = new Map();
  for (const entry of canonicalMediaEntries(messages)) {
    const { ownerMessageId, ...rest } = entry;
    if (!mediaByOwner.has(ownerMessageId)) mediaByOwner.set(ownerMessageId, []);
    mediaByOwner.get(ownerMessageId).push(rest);
  }
  const withRuns = withRunViews(messages, ledger, { single, runContext, runContextOpen });
  return withRuns.map((raw) => {
    const m = withFileViews(raw);
    const view = { ...(m.view ?? {}) };
    const turn = turns.get(m?.info?.id);
    if (turn) view.turn = turn;
    const truncation = truncationOf(m);
    if (truncation) view.truncation = truncation;
    const media = mediaByOwner.get(m?.info?.id);
    if (media) view.media = media;
    return Object.keys(view).length > 0 ? { ...m, view } : m;
  });
}

/**
 * A single message annotated alone (`getMessage`): truncation, media and its runs, never a turn (a turn needs neighbours).
 * @param {any} message
 * @param {{ledger?: any}} [opts]
 */
export function annotateSingle(message, { ledger = null } = {}) {
  if (!message) return message;
  const [annotated] = annotateView([message], { running: true, ledger, single: true });
  if (!annotated?.view?.turn) return annotated;
  const { turn: _turn, ...rest } = annotated.view;
  const { view: _v, ...bare } = annotated;
  return Object.keys(rest).length > 0 ? { ...bare, view: rest } : bare;
}
