// transcriptRuns.mjs — what a run of tool calls IS and what it SAYS, decided on the box (WS11 D11 / audit T1, T2).
//
// One rule set for both clients, canonical and live: the wording of a tool call ("Edited Transcript.tsx"), the summary
// of a run ("Read 3 files, ran a command"), where a run begins and ends, and the run's revision. Pure; no I/O.
//
// The SAME `createRunWalker` builds the runs for a canonical transcript (`computeRuns`, below) and for the live ledger
// the stream interpreter keeps (`streamInterp.mjs`): there is no second implementation to drift.

import { mapTimeline } from "../shared/opencodeV2.mjs";

// ---- wording (moved verbatim from the desktop's toolActivity.ts + the phone's `delegate` kind) ------------------------

const asRecord = (v) => (v && typeof v === "object" ? v : {});
const str = (v) => (typeof v === "string" ? v.trim() : "");

function basename(p) {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
const BASH_DETAIL_MAX = 60;
const DELEGATE_NAME_MAX = 60;
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
function humanizeToolName(tool) {
  const name = tool.replace(/^mcp[_-]/i, "");
  const words = name.split(/[_-]+/).filter(Boolean);
  return words.length > 0 ? words.join(" ") : tool;
}
const filePath = (input) => str(input.filePath) || str(input.file_path) || str(input.path);
const withDetail = (verb, detail) => (detail ? `${verb} ${detail}` : verb);
const first = (...c) => c.find((s) => s) ?? "";

export function normalizeToolStatus(status) {
  return status === "completed" || status === "error" || status === "running" ? status : "pending";
}

const isDelegateToolName = (lowercased) => {
  const name = lowercased.replace(/^mcp[_-]/i, "");
  return name === "delegate" || name === "delegate_delegate";
};

/** Is this tool name the `delegate` call (the one wording rule that reads a tool's OUTPUT)? */
export const isDelegateTool = (name) => isDelegateToolName(String(name ?? "").toLowerCase());

/** The display name of a `delegate` call: the quoted name in the output, else the first line of the input. */
function delegateJobName(state) {
  const out = typeof state.output === "string" ? state.output : typeof state.metadata?.output === "string" ? state.metadata.output : "";
  const m = /job "(.+?)" \(id [0-9a-f]+\)/.exec(out);
  const named = m?.[1]?.trim();
  if (named) return clip(named, DELEGATE_NAME_MAX);
  const input = asRecord(state.input);
  for (const key of ["description", "prompt"]) {
    const line = (typeof input[key] === "string" ? input[key] : "")
      .split(/\r?\n|\u2028|\u2029/)
      .map((l) => l.trim())
      .find((l) => l);
    if (line) return clip(line, DELEGATE_NAME_MAX);
  }
  return "";
}

const files = (one, many) => (n) => (n === 1 ? one : many.replace("{n}", String(n)));

function describeTool(part) {
  const rec = asRecord(part);
  const tool = String(rec.tool ?? "").toLowerCase();
  const state = asRecord(rec.state);
  const input = asRecord(state.input);
  const status = normalizeToolStatus(state.status);
  const title = str(state.title);
  const make = (kind, tense, plural, target) => ({
    kind,
    status,
    ...tense,
    label: status === "completed" ? tense.done : status === "error" ? tense.failed : tense.running,
    plural,
    counted: true,
    target,
  });
  const verbs = (run, done, fail, detail) => ({ running: withDetail(run, detail), done: withDetail(done, detail), failed: withDetail(fail, detail) });

  if (isDelegateToolName(tool)) {
    return make(
      "delegate",
      verbs("Running background job", "Started background job", "Failed to start background job", delegateJobName(state)),
      files("started a background job", "started {n} background jobs"),
      title,
    );
  }
  switch (tool) {
    case "read":
      return make("read", verbs("Reading", "Read", "Failed to read", basename(filePath(input)) || title), files("read a file", "read {n} files"), first(filePath(input), title));
    case "edit":
    case "multiedit":
    case "apply_patch":
    case "patch":
      return make("edit", verbs("Editing", "Edited", "Failed to edit", basename(filePath(input)) || title), files("edited a file", "edited {n} files"), first(filePath(input), title));
    case "write":
      return make("write", verbs("Writing", "Wrote", "Failed to write", basename(filePath(input)) || title), files("wrote a file", "wrote {n} files"), first(filePath(input), title));
    case "bash": {
      const command = str(input.command).split("\n")[0]?.trim() ?? "";
      const detail = clip(str(input.description) || command || title, BASH_DETAIL_MAX);
      return make(
        "bash",
        detail
          ? { running: detail, done: detail, failed: `Failed: ${detail}` }
          : { running: "Running a command", done: "Ran a command", failed: "Failed to run a command" },
        files("ran a command", "ran {n} commands"),
        first(command, title),
      );
    }
    case "grep":
    case "glob":
    case "codesearch":
      return make("search", verbs("Searching", "Searched", "Failed to search", str(input.pattern) || str(input.query) || title), files("searched code", "ran {n} searches"), first(str(input.pattern), str(input.query), title));
    case "list":
    case "ls":
      return make("list", verbs("Listing", "Listed", "Failed to list", basename(str(input.path)) || title), files("listed a directory", "listed {n} directories"), first(str(input.path), title));
    case "webfetch":
    case "web_fetch":
      return make("fetch", verbs("Fetching", "Fetched", "Failed to fetch", hostOf(str(input.url)) || title), files("fetched a page", "fetched {n} pages"), first(str(input.url), title));
    case "websearch":
    case "web_search": {
      const q = str(input.query) || title;
      return make(
        "websearch",
        q
          ? verbs("Searching the web for", "Searched the web for", "Failed to search the web for", q)
          : { running: "Searching the web", done: "Searched the web", failed: "Failed to search the web" },
        (n) => (n === 1 ? "searched the web" : `searched the web ${n} times`),
        first(str(input.query), title),
      );
    }
    case "task":
      return make(
        "task",
        {
          running: withDetail("Running agent", str(input.description) || title),
          done: withDetail("Ran agent", str(input.description) || title),
          failed: withDetail("Agent failed:", str(input.description) || title),
        },
        files("ran an agent", "ran {n} agents"),
        first(str(input.description), title),
      );
    case "skill":
      return make("skill", verbs("Loading skill", "Loaded skill", "Failed to load skill", str(input.name) || title), files("loaded a skill", "loaded {n} skills"), first(str(input.name), title));
    case "question":
      return make("question", { running: "Asking", done: "Asked", failed: "Failed to ask" }, files("asked a question", "asked {n} questions"), title);
    default: {
      const name = humanizeToolName(String(rec.tool ?? "tool"));
      return make("other", { running: `Using ${name}`, done: `Used ${name}`, failed: `Failed: ${name}` }, files("used a tool", "used {n} tools"), title);
    }
  }
}

function describePatch(part) {
  const patchFiles = Array.isArray(part.files) ? part.files : [];
  const detail = patchFiles.length === 1 ? basename(String(patchFiles[0])) : patchFiles.length > 1 ? `${patchFiles.length} files` : "";
  const done = detail ? `Saved changes to ${detail}` : "Saved changes";
  return {
    kind: "patch",
    status: "completed",
    running: withDetail("Saving", detail),
    done,
    failed: done,
    label: done,
    plural: (n) => (n === 1 ? "saved a change" : `saved ${n} changes`),
    counted: false,
    target: patchFiles.filter((f) => typeof f === "string").join(", "),
  };
}

/** Labels for one tool or patch part. */
export function describeActivity(part) {
  return part?.type === "patch" ? describePatch(part) : describeTool(part);
}

/** The wire view of one part's activity: `{kind, status, label, target, counted}`. */
export function activityView(part) {
  const a = describeActivity(part);
  return { kind: a.kind, status: a.status, label: a.label, target: a.target, counted: a.counted };
}

const MAX_SUMMARY_CATEGORIES = 3;

/** `{label, calls, failed, tone, live}` for a list of tool/patch parts. `live` = the latest unfinished tool, present tense. */
export function summarizeParts(parts) {
  const activities = parts.map(describeActivity);
  const tools = activities.filter((a) => a.counted);
  const described = tools.length > 0 ? tools : activities;
  const failed = tools.filter((a) => a.status === "error").length;
  const unfinished = tools.filter((a) => a.status !== "completed" && a.status !== "error");
  const liveAct = unfinished.length > 0 ? unfinished[unfinished.length - 1] : null;
  let label;
  if (described.length === 1) {
    const only = described[0];
    label = only.status === "error" ? only.failed : only.done;
  } else {
    const order = [];
    const tally = new Map();
    for (const a of described) {
      const t = tally.get(a.kind);
      if (t) t.n++;
      else {
        order.push(a.kind);
        tally.set(a.kind, { n: 1, plural: a.plural });
      }
    }
    if (order.length > MAX_SUMMARY_CATEGORIES) label = `Used ${tools.length} tools`;
    else {
      const text = order.map((k) => tally.get(k).plural(tally.get(k).n)).join(", ");
      label = text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
  return {
    label,
    calls: tools.length,
    failed,
    tone: liveAct ? "running" : failed > 0 ? "warn" : "ok",
    live: liveAct ? { kind: liveAct.kind, label: liveAct.running } : null,
  };
}

// ---- what draws / what ends a run -----------------------------------------------------------------------------------

const HANDOFF_TOOL_RE = /^(?:manta[_-])?handoff$/i;
export const isHandoffToolPart = (p) => p?.type === "tool" && HANDOFF_TOOL_RE.test(String(p.tool ?? ""));
const isToolPart = (p) => p?.type === "tool" && !isHandoffToolPart(p);
const isTodoWrite = (p) => p?.type === "tool" && (p.tool === "todowrite" || p.tool === "todo_write");

/** An assistant message's parts that DRAW (text must be non-synthetic, non-ignored, non-empty; step markers and todo writes never). */
export function visibleAssistantParts(message) {
  return (message?.parts ?? []).filter((p) => {
    if (p?.type === "text") return !p.synthetic && !p.ignored && (p.text ?? "").length > 0;
    if (p?.type === "step-start" || p?.type === "step-finish") return false;
    return !isTodoWrite(p);
  });
}

const blank = (s) => (s ?? "").trim() === "";

/** A finished background job posts a USER turn starting `[background job "`: it never draws and never ends a run. */
function isBackgroundJobCompletionTurn(message) {
  if (message?.info?.role !== "user") return false;
  const text = (message.parts ?? [])
    .filter((p) => p?.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => p.text ?? "")
    .join("\n")
    .trimStart();
  return text.startsWith('[background job "');
}

/**
 * Does a transcript item END the open run? One classifier for the canonical walk and the ledger (rule 3):
 * a user message that DRAWS (text or a file, not a background-job completion turn) and an assistant message carrying a
 * `background-result` part draw; a hidden user message is transparent. Anything else (a plain assistant message) is
 * walked part by part, so it is `"transparent"` here.
 */
export function runBoundaryOf(message) {
  const role = message?.info?.role;
  if (role === "user") {
    if (isBackgroundJobCompletionTurn(message)) return "transparent";
    const text = (message.parts ?? [])
      .filter((p) => p?.type === "text" && !p.synthetic && !p.ignored)
      .map((p) => p.text ?? "")
      .join("\n")
      .replace(/\s+$/, "");
    return text.length > 0 || (message.parts ?? []).some((p) => p?.type === "file") ? "draws" : "transparent";
  }
  if (role === "assistant" && (message.parts ?? []).some((p) => p?.type === "background-result")) return "draws";
  return "transparent";
}

/**
 * Classify an inbox item AT ENQUEUE TIME by its MAPPED TRANSCRIPT OUTCOME (never by `raw.type` alone):
 * `"draws" | "transparent" | "unknown"` (unknown → the caller resolves it with a lookup).
 */
export function deliveryClassOf(raw) {
  if (!raw || typeof raw !== "object") return "unknown";
  const id = typeof raw.id === "string" && raw.id ? raw.id : "inbox";
  if (raw.type === "user") {
    const p = raw.payload;
    if (!p || typeof p !== "object") return "unknown";
    const [m] = mapTimeline([{ type: "user", id, text: p.text, files: p.files, agents: p.agents }]);
    return m ? runBoundaryOf(m) : "unknown";
  }
  if (raw.type === "synthetic") {
    if (raw.metadata?.source !== "subagent") return "transparent";
    if (!raw.metadata || typeof raw.metadata !== "object" || typeof raw.text !== "string") return "unknown";
    const [m] = mapTimeline([{ ...raw, id }]);
    return m ? runBoundaryOf(m) : "transparent";
  }
  if (raw.type === "compaction" || raw.type === "move") return "transparent";
  return "unknown";
}

// ---- the walker -----------------------------------------------------------------------------------------------------

/**
 * Builds runs from a stream of `part` / `boundary` / `text` / `reasoning` items. A run is consecutive tool + patch parts;
 * it SPANS assistant messages (opencode writes one message per model step) and belongs to the message where it starts.
 * A non-blank reasoning part is transparent to the run but starts a new SEGMENT; anything else that draws ends the run.
 * The first segment's id equals the run id; later segments take the id of their first part.
 */
export function createRunWalker(startSeq = 0) {
  /** @type {Map<string, any>} */
  const runs = new Map();
  const order = [];
  const partRun = new Map(); // partId -> { runId, segmentId }
  let open = null;
  let segBreak = false;
  let seq = startSeq;
  const touch = (run) => {
    run.seq = ++seq;
  };
  return {
    runs,
    order,
    partRun,
    get open() {
      return open;
    },
    get seq() {
      return seq;
    },
    /** A tool/patch part (insert or update by part id). Returns what changed. */
    part(part, messageId) {
      const known = partRun.get(part.id);
      if (known) {
        const run = runs.get(known.runId);
        const i = run.parts.findIndex((p) => p.id === part.id);
        run.parts[i] = part;
        touch(run);
        return { run, created: false, newSegment: false };
      }
      let created = false;
      let newSegment = false;
      if (!open) {
        open = { id: part.id, ownerMessageId: messageId, parts: [], segments: [part.id], closed: false, seq: 0 };
        runs.set(open.id, open);
        order.push(open.id);
        created = true;
        segBreak = false;
      } else if (segBreak) {
        open.segments.push(part.id);
        newSegment = true;
        segBreak = false;
      }
      const segmentId = open.segments[open.segments.length - 1];
      open.parts.push(part);
      partRun.set(part.id, { runId: open.id, segmentId });
      touch(open);
      return { run: open, created, newSegment };
    },
    /** Something that draws and is not a run part (non-blank text, a file, a handoff card, a boundary). Returns the closed run. */
    end() {
      const closed = open;
      if (open) open.closed = true;
      open = null;
      segBreak = false;
      return closed;
    },
    /** A non-blank reasoning part: transparent to the open run, starts a new segment of it. */
    reasoning() {
      if (open) segBreak = true;
    },
    /** Replace the walker's membership wholesale (a canonical rebuild keeps `seq` monotonic). */
    reset() {
      runs.clear();
      order.length = 0;
      partRun.clear();
      open = null;
      segBreak = false;
    },
    /** Segments of a run as `{id, parts}`, in order. */
    segmentsOf(run) {
      return run.segments.map((id) => ({ id, parts: run.parts.filter((p) => partRun.get(p.id)?.segmentId === id) }));
    },
    /** A rebuild stamps every run with a fresh `seq` (monotonic across the rebuild). */
    touchAll() {
      for (const run of runs.values()) touch(run);
    },
  };
}

/** A run's wire view: the summary, plus `segments` only when the run split (rule 5). */
export function runView(walker, run, rev) {
  const view = { id: run.id, ownerMessageId: run.ownerMessageId, rev, ...summarizeParts(run.parts) };
  if (run.segments.length > 1) {
    view.segments = walker.segmentsOf(run).map(({ id, parts }) => ({ id, ...summarizeParts(parts) }));
  }
  return view;
}

/**
 * The canonical walk over a transcript (chronological `{info, parts}[]`).
 * `anchored`: something that draws (text, a drawing user message, a handoff, a background result) came before the FIRST
 * run part, so the first run provably began inside this list; false means it may have begun earlier (an open window edge).
 * @returns {{ walker: ReturnType<typeof createRunWalker>, partRun: Map<string,{runId:string,segmentId:string}>, messageRuns: Map<string, string[]>, anchored: boolean }}
 */
export function computeRuns(messages, { startSeq = 0 } = {}) {
  const walker = createRunWalker(startSeq);
  const messageRuns = new Map();
  let sawRunPart = false;
  let sawBoundary = false;
  const end = () => {
    if (!sawRunPart) sawBoundary = true;
    walker.end();
  };
  const touchedBy = (messageId, runId) => {
    const list = messageRuns.get(messageId) ?? [];
    if (!list.includes(runId)) list.push(runId);
    messageRuns.set(messageId, list);
  };
  for (const message of messages ?? []) {
    const role = message?.info?.role;
    if (role === "user") {
      if (runBoundaryOf(message) === "draws") end();
      continue;
    }
    const id = message?.info?.id;
    for (const part of visibleAssistantParts(message)) {
      if (isHandoffToolPart(part)) {
        end();
        continue;
      }
      if (isToolPart(part) || part.type === "patch") {
        sawRunPart = true;
        const { run } = walker.part(part, id);
        touchedBy(id, run.id);
        continue;
      }
      if (part.type === "text" && blank(part.text)) continue;
      if (part.type === "reasoning") {
        if (!blank(part.text)) walker.reasoning();
        continue;
      }
      end();
    }
  }
  return { walker, partRun: walker.partRun, messageRuns, anchored: sawBoundary || !sawRunPart };
}
