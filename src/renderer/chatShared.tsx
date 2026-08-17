// Shared primitives for the chat panel and its extracted sub-components.
//
// This module holds the small constants, types, contexts, and DOM-free helper
// functions that are referenced by BOTH the top-level `ChatPanel` component
// (ChatPanel.tsx) and the leaf components split out of it (MessageRow.tsx,
// ToolCall.tsx, Cards.tsx, MarkdownBody.tsx). Keeping them here — rather than
// re-exporting from ChatPanel.tsx — avoids import cycles through the big
// component file and keeps the split modules importing from one stable place.
//
// No React rendering lives here; only createContext (a value factory) plus
// pure helpers, so this stays cheap to import from anywhere.

import { createContext, type ReactNode } from "react";
import type { OpencodeMessage, OpencodeModel } from "../shared/types";
// TokenUsage now lives in src/shared/types.ts (the single source — it also
// types OpencodeMessageInfo.tokens, which killed the renderer's
// `as unknown as { tokens?: TokenUsage }` casts, BET-733/L10). Re-exported here
// so the existing renderer `import { TokenUsage } from "./chatShared"` call
// sites are unchanged.
export type { TokenUsage } from "../shared/types";

// In-flight attachments tracked alongside the textarea content. Each chip
// rendered above the input maps to one entry; `status` drives the chip
// appearance (uploading spinner vs. ready vs. error).
export type Attachment = {
  id: string;                       // local id for keyed rendering / removal
  filename: string;
  remotePath?: string;              // set when upload finished or @-mention resolved
  mime: string;
  status: "uploading" | "ready" | "error";
  errorMsg?: string;
  source: "drop" | "paste" | "mention"; // "drop"/"paste" = scp'd to ~/.manta-uploads, "mention" = path from /find/file
  // When true this chip is NOT sent as a multimodal FilePart (the model
  // can't decode it — csv/code/text/etc). Instead its remote path is
  // appended to the outgoing message as `@<path>` so the AI reads it with
  // its Read tool. Keeps the composer clean instead of dumping the raw path.
  asPathRef?: boolean;
};

// Agent mention emitted by @-mention typeahead. We track the inserted slice
// of the textarea so we can compute {value, start, end} for the wire format
// at submit time, after the user may have edited around it.
export type AgentMention = {
  id: string;
  name: string;
};

// Active typeahead popup state. The renderer tracks what we're matching and
// the [start, end) slice of the input string that the popup overlays — on
// selection we replace that slice with the canonical insertion text.
export type TypeaheadState = {
  mode: "file" | "agent" | "command";
  query: string;
  anchorStart: number;
  anchorEnd: number;
  selectedIdx: number;
};

// A single row rendered in the typeahead popup. `kind` matches the trigger
// mode; `key` is the canonical identifier (path / name) we'll insert.
export type TypeaheadRow = {
  kind: "file" | "agent" | "command" | "reference";
  key: string;
  primary: string;            // user-visible label, e.g. "@src/foo" or "/init"
  secondary?: string;         // dim caption: command description / agent description
};


// One tool part's `state` shape (opencode tool-call lifecycle). Extracted so
// the tool-rendering components share a single definition.
export type ToolState = {
  status?: string;
  title?: string;
  output?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

// Subagent (Task tool) context. Carries the per-panel state needed to render
// expanded child transcripts inside TaskBody. Provided once by ChatPanel near
// its scroll container; consumed by TaskBody via useContext so the chain of
// memoized components (MessageRow → AssistantPart → ToolCall → ToolBody) stays
// untouched and their default shallow-comparator memos keep working. Without
// the context, TaskBody falls back to its collapsed-header-only rendering
// (the chevron is hidden because there's nothing to expand into).
export type TaskContextValue = {
  expanded: Set<string>;
  toggle: (childSessionId: string) => void;
  // Child transcripts. Map.get(childSessionId) may be undefined if the child
  // has no cached messages yet; TaskBody renders its collapsed header only in
  // that case (no separate loading/fetch state is tracked here).
  childMessages: Map<string, OpencodeMessage[]>;
  // Tail-first loading for the child transcript (BET-683). Maps each childId
  // to whether its FULL history has been pulled (via "Load earlier"); until
  // true, child fetches pull only TRANSCRIPT_TAIL_LIMIT. Drives the "Load
  // earlier" header on an expanded TaskCard.
  childLoadedAllRef: React.MutableRefObject<Map<string, boolean>>;
  loadEarlierChild: (childId: string) => void;
  loadingChildEarlier: Set<string>;
  // Live child running/idle from session.status / session.idle events.
  // Overrides the parent's stale `state.status` for the running pulse.
  liveStatus: Map<string, "running" | "idle">;
  // Inherited from ChatPanel's Ctrl+O toggle so reasoning visibility
  // matches between parent and child transcripts.
  showThinking: boolean;
};
export const TaskContext = createContext<TaskContextValue | null>(null);

// Present-tense verb pool for the running indicator. Picked once per turn
// so the verb doesn't shuffle between renders. Past-tense pair (same index)
// is used in the post-turn footer (`✻ Ruminated for 1m44s`).
export const SPINNER_VERBS = [
  "Cogitating",
  "Ruminating",
  "Pondering",
  "Reflecting",
  "Considering",
  "Deliberating",
  "Musing",
  "Contemplating",
  "Generating",
  "Forging",
  "Brewing",
  "Crafting",
];
export const SPINNER_VERBS_PAST = [
  "Cogitated",
  "Ruminated",
  "Pondered",
  "Reflected",
  "Considered",
  "Deliberated",
  "Mused",
  "Contemplated",
  "Generated",
  "Forged",
  "Brewed",
  "Crafted",
];

// Deterministic verb for a message — same id always picks the same index so
// neither the running indicator's present verb nor the footer's past verb
// shuffles when the transcript refetches. One hash backs both accessors so a
// single turn shows the SAME verb in flight ("Pondering…") and finished
// ("Pondered"), rather than two different ones.
function verbIndexFor(messageId: string): number {
  let h = 0;
  for (let i = 0; i < messageId.length; i++) h = (h * 31 + messageId.charCodeAt(i)) | 0;
  return Math.abs(h) % SPINNER_VERBS_PAST.length;
}
export function presentVerbFor(messageId: string): string {
  return SPINNER_VERBS[verbIndexFor(messageId)];
}
export function pastVerbFor(messageId: string): string {
  return SPINNER_VERBS_PAST[verbIndexFor(messageId)];
}

// Detect whether a model can accept file attachments. Two shapes in the wild:
//   /provider source:  capabilities = {attachment: bool, input: {image, pdf, ...}}
//   /api/model source: capabilities = {tools, input: ["text", "image", ...]}
// Treat "supports attachments" as: any non-"text" input modality.
export function modelSupportsAttachments(m: OpencodeModel | null): boolean {
  const modes = modelInputModes(m);
  return modes.some((v) => v !== "text");
}

// Return the set of input modalities the model accepts (text, image, pdf,
// video, audio, ...). Empty array if unknown.
export function modelInputModes(m: OpencodeModel | null): string[] {
  if (!m) return [];
  const caps = m.capabilities as unknown as
    | { input?: unknown }
    | undefined;
  if (!caps) return [];
  const input = caps.input;
  if (Array.isArray(input)) {
    return input.filter((v): v is string => typeof v === "string");
  }
  if (input && typeof input === "object") {
    return Object.entries(input as Record<string, unknown>)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  }
  return [];
}

// Group a mime type into one of opencode's input modality buckets so we can
// match against the model's capabilities. Important nuance for the
// Anthropic family (and many others): a model declaring `input.text=true`
// only means it accepts text content in `text` blocks — NOT that it accepts
// `text/*` or `application/json` files as FilePart content blocks. Those
// silently get the cryptic "media type X functionality not supported" from
// the upstream API. So we treat text-ish files as "other" — caller refuses
// them upfront. Image/PDF are the only mime classes that map to FilePart-
// safe modes for the providers we've seen.
export function mimeToInputMode(mime: string): "image" | "video" | "audio" | "pdf" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "other";
}

// Array.findLast polyfill — ES2023, not in our ES2022 target. Returns the
// last element matching `pred`, or undefined. Used by the voice action
// dispatcher to pick the NEWEST pending permission/question (matches the
// visual stack: topmost card is the most recent ask).
export function findLast<T>(arr: readonly T[], pred: (v: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return arr[i];
  }
  return undefined;
}

// Best-effort MIME inference for drag-drop chips and @-mention file refs.
// Drag-drop has File.type for many cases; @-mention only has the path. The
// FilePartInput's mime field is required by the API but opencode is tolerant
// of generic types like `application/octet-stream`.
export function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    yml: "text/yaml",
    yaml: "text/yaml",
    js: "text/javascript",
    jsx: "text/javascript",
    ts: "text/typescript",
    tsx: "text/typescript",
    py: "text/x-python",
    rs: "text/x-rust",
    go: "text/x-go",
    sh: "text/x-shellscript",
    html: "text/html",
    css: "text/css",
  };
  return map[ext] ?? "application/octet-stream";
}

// Per-session model override. Stored in localStorage keyed by sessionId so the
// picker remembers the user's choice across panel mounts. `null` (or missing)
// means "let opencode pick its default" — matches the prompt_async fallback.
export type ModelSelection = { providerID: string; modelID: string; variant?: string };

// Per-mode storage (BET-950). "build" uses the original `…:model` key so every
// existing session keeps its model and nothing migrates; "plan" gets its own
// key (`…:model:plan`), same JSON shape. Zero-config: readSavedModel falls back
// to the build key when the plan key is absent, so plan mode uses the build
// model until the user picks one while in plan mode.
export type ModelMode = "build" | "plan";

export function modelKey(sessionId: string, mode: ModelMode): string {
  return mode === "plan"
    ? `manta:chat:${sessionId}:model:plan`
    : `manta:chat:${sessionId}:model`;
}

export function readSavedModel(sessionId: string, mode: ModelMode): ModelSelection | null {
  try {
    const raw = localStorage.getItem(modelKey(sessionId, mode));
    if (!raw) {
      // Zero-config until used: plan mode with no plan key uses the build model.
      if (mode === "plan") return readSavedModel(sessionId, "build");
      return null;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.providerID === "string" && typeof parsed.modelID === "string") {
      return parsed as ModelSelection;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeSavedModel(sessionId: string, mode: ModelMode, m: ModelSelection | null): void {
  try {
    if (m) localStorage.setItem(modelKey(sessionId, mode), JSON.stringify(m));
    else localStorage.removeItem(modelKey(sessionId, mode));
  } catch { /* quota / disabled storage */ }
}

// /clear carry-forward (BET-950): copy BOTH per-mode model keys from one
// session id to another, preserving their independence. Copies the RAW value of
// each key (not readSavedModel, whose plan→build fallback would stamp the build
// model into a plan key that was never explicitly written), and leaves the
// destination plan key absent when the source plan key is absent.
export function copySavedModels(fromSessionId: string, toSessionId: string): void {
  for (const mode of ["build", "plan"] as const) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(modelKey(fromSessionId, mode)); } catch { continue; }
    if (raw === null) continue;
    try {
      if (raw) localStorage.setItem(modelKey(toSessionId, mode), raw);
      else localStorage.removeItem(modelKey(toSessionId, mode));
    } catch { /* quota / disabled storage */ }
  }
}

// Per-session plan-mode override (BET-949). Deliberately its OWN storage key —
// NOT folded into the `manta:chat:<sid>:model` JSON blob (that blob is a model
// selection and the native iOS client stores it in an incompatible format).
// Value is the literal "1" when on, absent otherwise.
export function planKey(sessionId: string): string {
  return `manta:chat:${sessionId}:plan`;
}

export function readPlanSaved(sessionId: string): boolean {
  try {
    return localStorage.getItem(planKey(sessionId)) === "1";
  } catch { /* disabled storage */ return false; }
}

export function writePlanSaved(sessionId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(planKey(sessionId), "1");
    else localStorage.removeItem(planKey(sessionId));
  } catch { /* quota / disabled storage */ }
}

// Per-project remembered DELEGATION model (BET-951). Written ONLY on an
// explicit user pick from the plan card's delegate split (never promoted from
// an inherited default — that would pin whatever happened to be current the
// first time). Level 2 of resolveDelegateModel's precedence.
export function delegateModelKey(projectKey: string): string {
  return `manta:delegate:${projectKey}:model`;
}

export function readSavedDelegateModel(projectKey: string): ModelSelection | null {
  try {
    const raw = localStorage.getItem(delegateModelKey(projectKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.providerID === "string" && typeof parsed.modelID === "string") {
      return parsed as ModelSelection;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeSavedDelegateModel(projectKey: string, m: ModelSelection | null): void {
  try {
    if (m) localStorage.setItem(delegateModelKey(projectKey), JSON.stringify(m));
    else localStorage.removeItem(delegateModelKey(projectKey));
  } catch { /* quota / disabled storage */ }
}

// Resolve the active OpencodeModel for the NEXT prompt from the available
// model list + the per-session override + the server default. modelOverride
// wins; otherwise the server default's provider/model is looked up. Returns
// null when no models are loaded or no target can be resolved. Pure —
// extracted so ChatPanel (capability lookups) and ModelPicker (display +
// variant list) share one resolution path instead of duplicating the lookup.
export function resolveActiveModel(
  models: OpencodeModel[] | null | undefined,
  modelOverride: ModelSelection | null,
  defaultModel: { providerID: string; modelID: string } | null,
): OpencodeModel | null {
  if (!models || models.length === 0) return null;
  const target = modelOverride ??
    (defaultModel
      ? { providerID: defaultModel.providerID, modelID: defaultModel.modelID }
      : null);
  if (!target) return null;
  return (
    models.find(
      (m) => m.providerID === target.providerID && m.id === target.modelID,
    ) ?? null
  );
}

// Per-session mode toggle (BET-138): a chat session shows either the
// ChatPanel ("chat"), a bare shell-in-cwd ("terminal"), or an AI CLI TUI
// launcher ("tui:<launcherId>", e.g. "tui:claude"). Persisted per-session in
// localStorage, mirroring the model-selection helpers above. Default is
// always "chat" (locked decision — new sessions never default elsewhere).
export type SessionMode = "chat" | "terminal" | `tui:${string}`;

export function modeKey(sessionId: string): string {
  return `manta:session:${sessionId}:mode`;
}

// `availableLaunchers` is the CURRENT set of launchers the box reports (see
// window.api.launchersList()). A saved `tui:<id>` whose launcher is not in
// that set downgrades to "chat" — e.g. a machine that lost its `claude`
// install shouldn't render a broken TUI slot. Defaults to an empty list so
// callers that haven't fetched launchers yet still get sane "chat"/"terminal"
// behavior (only `tui:*` modes are affected by the availability check).
export function readSavedMode(
  sessionId: string,
  availableLaunchers: { id: string }[] = [],
): SessionMode {
  try {
    const raw = localStorage.getItem(modeKey(sessionId));
    if (raw === "terminal") return "terminal";
    if (raw && raw.startsWith("tui:")) {
      const launcherId = raw.slice("tui:".length);
      return availableLaunchers.some((l) => l.id === launcherId)
        ? (raw as SessionMode)
        : "chat";
    }
    return "chat"; // default, and the fallback for any unrecognized value
  } catch {
    return "chat";
  }
}

export function writeSavedMode(sessionId: string, m: SessionMode): void {
  try {
    localStorage.setItem(modeKey(sessionId), m);
  } catch { /* quota / disabled storage */ }
}

// ===== Last-active session (restored on refresh / relaunch) =====
//
// Persisted in localStorage so a renderer reload / app relaunch lands on the
// session the user was last using instead of defaulting to the first project.
// Keyed by the tmux WINDOW (project + window index), the stable identity
// across opencode sessionIds (a /clear swaps the session id but not the
// window). Written on every setActive; read by applyProjects when there is no
// valid selection to restore yet.

export type ActiveSessionPin = { project: string; window: number };

export function activeSessionKey(): string {
  return "manta:lastActiveSession";
}

export function readSavedActiveSession(): ActiveSessionPin | null {
  try {
    const raw = localStorage.getItem(activeSessionKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.project === "string" &&
      typeof parsed.window === "number" &&
      Number.isInteger(parsed.window) &&
      parsed.window >= 0
    ) {
      return { project: parsed.project, window: parsed.window };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeSavedActiveSession(pin: ActiveSessionPin | null): void {
  try {
    if (pin) localStorage.setItem(activeSessionKey(), JSON.stringify(pin));
    else localStorage.removeItem(activeSessionKey());
  } catch { /* quota / disabled storage */ }
}

// Merge a launcher's flag schema with the user's saved overrides (from
// AppConfig.launcherFlags), falling back to each flag's registry default for
// keys the user never touched.
export function resolveLauncherFlags(
  schema: { key: string; default: boolean }[],
  saved: Record<string, boolean> | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of schema) out[f.key] = saved?.[f.key] ?? f.default;
  return out;
}

// ===== Persisted prompt history (survives /clear) =====
//
// Keyed by the tmux WINDOW (project session + window index), NOT the opencode
// sessionId — /clear swaps in a new sessionId with an empty transcript, so a
// session-keyed history would reset on every clear. The window is the stable
// identity across clears (and across app reloads, since this is localStorage).
const HISTORY_MAX = 200;

export function historyKey(tmuxSession: string, windowIndex: number): string {
  return `manta:window:${tmuxSession}:${windowIndex}:history`;
}

export function readPromptHistory(
  tmuxSession: string | null,
  windowIndex: number | null,
): string[] {
  if (!tmuxSession || windowIndex == null) return [];
  try {
    const raw = localStorage.getItem(historyKey(tmuxSession, windowIndex));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

// Append a freshly-submitted prompt. Chronological (freshest last), collapses a
// consecutive duplicate, caps at HISTORY_MAX (oldest dropped first).
export function appendPromptHistory(
  tmuxSession: string | null,
  windowIndex: number | null,
  text: string,
): void {
  if (!tmuxSession || windowIndex == null) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    const list = readPromptHistory(tmuxSession, windowIndex);
    if (list[list.length - 1] === trimmed) return; // collapse consecutive dup
    list.push(trimmed);
    const capped = list.length > HISTORY_MAX ? list.slice(-HISTORY_MAX) : list;
    localStorage.setItem(historyKey(tmuxSession, windowIndex), JSON.stringify(capped));
  } catch { /* quota / disabled storage */ }
}

// Merge persisted history with the live transcript's user turns into one
// chronological list (freshest last). Concatenate then collapse CONSECUTIVE
// duplicates, which handles the common "last persisted == first transcript"
// seam without reordering. Pure — unit-tested.
export function mergePromptHistory(
  persisted: string[],
  transcript: string[],
): string[] {
  const out: string[] = [];
  for (const item of [...persisted, ...transcript]) {
    if (!item) continue;
    if (out[out.length - 1] === item) continue; // collapse consecutive dup
    out.push(item);
  }
  return out;
}

// Small inline metadata badge: the faint bordered pill that sits next to a
// primary label to name a secondary attribute (a secret's scope, a webhook's
// unsigned state, a subagent's agent type). One definition so the call sites
// cannot drift apart.
//
// Always render it as the `shrink-0` sibling of a `truncate` primary label
// inside a `flex items-center gap-2` row — that is what keeps the badge
// visible when the primary label is too long for the row.
export function MetaBadge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "danger";
  title?: string;
}) {
  const toneClass =
    tone === "danger"
      ? "text-danger border-danger/30"
      : "text-text-faint border-border";
  return (
    <span className={"shrink-0 rounded-xs border px-1 text-meta font-mono " + toneClass} title={title}>
      {children}
    </span>
  );
}
