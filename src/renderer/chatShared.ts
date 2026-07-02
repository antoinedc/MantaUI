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

import { createContext } from "react";
import type { OpencodeMessage, OpencodeModel } from "../shared/types";

// Claude's bullet/spinner accent. Inlined (not in tailwind config) so we only
// brand the chat panel without touching the rest of bui's blue accent.
export const CLAUDE_ORANGE = "#d97757";

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
  source: "drop" | "paste" | "mention"; // "drop"/"paste" = scp'd to ~/.bui-uploads, "mention" = path from /find/file
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
  kind: "file" | "agent" | "command";
  key: string;
  primary: string;            // user-visible label, e.g. "@src/foo" or "/init"
  secondary?: string;         // dim caption: command description / agent description
};

// Token accounting surfaced by the running indicator / context bar.
export type TokenUsage = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
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
  // Lazy-loaded child transcripts. Map.get(childSessionId) may be undefined
  // (never fetched) — TaskBody shows a spinner or "expand to load" depending
  // on fetchState.
  childMessages: Map<string, OpencodeMessage[]>;
  // "loading" while the initial fetch is in flight; "error" if it failed
  // (TaskBody renders a small retry hint). Absent = idle.
  childFetchState: Map<string, "loading" | "error">;
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
// is used in the post-turn footer (`✻ Brewed for 1m 44s`).
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

// Deterministic past-tense verb for a message — same id always picks the same
// verb so the footer doesn't shuffle when the transcript refetches.
export function pastVerbFor(messageId: string): string {
  let h = 0;
  for (let i = 0; i < messageId.length; i++) h = (h * 31 + messageId.charCodeAt(i)) | 0;
  return SPINNER_VERBS_PAST[Math.abs(h) % SPINNER_VERBS_PAST.length];
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

export function modelKey(sessionId: string): string {
  return `bui:chat:${sessionId}:model`;
}

export function readSavedModel(sessionId: string): ModelSelection | null {
  try {
    const raw = localStorage.getItem(modelKey(sessionId));
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

export function writeSavedModel(sessionId: string, m: ModelSelection | null): void {
  try {
    if (m) localStorage.setItem(modelKey(sessionId), JSON.stringify(m));
    else localStorage.removeItem(modelKey(sessionId));
  } catch { /* quota / disabled storage */ }
}
