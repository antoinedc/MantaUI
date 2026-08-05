import type { OpencodeMessage, OpencodePart, ServedPageMeta } from "../shared/types";

export type ArtifactKind = "link" | "image" | "file";
export type ArtifactOrigin = "user" | "agent";

export type Artifact = {
  id: string; // stable: the part id (suffixed .0/.1/... when a text part yields many links), or "page:<subdomain>"
  kind: ArtifactKind;
  origin: ArtifactOrigin;
  key: string; // dedupe key
  label: string; // filename, page title, or URL host+path
  href: string; // absolute box path for files/images, URL for links
  mime: string | null; // null for links
  size: number | null; // byte size for files/images when known (formatBytes), null otherwise
  at: number; // epoch ms, for sorting and day grouping
  messageId: string | null; // null for pages with no matching message
  context: string | null; // surrounding message text, links only
  expiresAt: number | null; // hosted pages only; null otherwise
};

const URL_RE = /https?:\/\/[^\s<>]+/g;

// Collapse whitespace to single spaces, trim, then hard-cap at 160 chars.
function collapseAndTrim(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

// 160-char context for a link: the owning message's text with the URL removed.
function linkContext(text: string, url: string): string {
  return collapseAndTrim(text.replace(url, ""));
}

function messageText(msg: OpencodeMessage): string {
  return msg.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

function messageCreated(msg: OpencodeMessage): number {
  return msg.info.time?.created ?? 0;
}

function lastPathSegment(s: string): string {
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

// File part wire shape (src/server/opencode.mjs:624-632): { type:"file", mime,
// url: "file://<abs>", filename? }.
function deriveFileArtifact(msg: OpencodeMessage, part: OpencodePart): Artifact {
  const url = String(part.url ?? "");
  const mime = part.mime != null ? String(part.mime) : null;
  const kind: ArtifactKind =
    mime != null && mime.startsWith("image/") ? "image" : "file";
  const pathOnly = url.replace(/^file:\/\//, "");
  const label = part.filename ? String(part.filename) : lastPathSegment(pathOnly);
  return {
    id: part.id,
    kind,
    origin: msg.info.role === "user" ? "user" : "agent",
    key: pathOnly.toLowerCase(),
    label,
    href: pathOnly,
    mime,
    size: typeof part.size === "number" ? part.size : null,
    at: messageCreated(msg),
    messageId: null,
    context: null,
    expiresAt: null,
  };
}

function deriveLinkArtifact(msg: OpencodeMessage, part: OpencodePart, url: string): Artifact | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const label = (parsed.host + parsed.pathname).replace(/\/+$/, "") || parsed.host;
  return {
    id: part.id,
    kind: "link",
    origin: "user",
    key: url.toLowerCase(),
    label,
    href: url,
    mime: null,
    size: null,
    at: messageCreated(msg),
    messageId: null,
    context: linkContext(part.text ?? "", url),
    expiresAt: null,
  };
}

// Extension → MIME for files the agent writes (creation, not edit) so
// generated documents/images render with the right glyph tone and preview
// kind. Unlisted extensions fall back to null; `resolvePreviewType` then maps
// them by extension for the preview, and unknown types land on the download
// path. Kept deliberately small — add a type only when a generated artifact
// needs it.
const EXT_MIME: Record<string, string> = {
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i).toLowerCase() : "";
}

// An agent-generated file: a `write` tool CREATION (distinct from `edit`,
// which modifies existing source and stays out). `href` is the written path; a
// `write` carries no byte size, so `size` is null. Timestamp comes from the
// tool's start time, falling back to the owning message.
function deriveWriteArtifact(msg: OpencodeMessage, part: OpencodePart): Artifact | null {
  const state = (part as {
    state?: { input?: { filePath?: unknown }; time?: { start?: unknown } };
  }).state;
  const filePath = state?.input?.filePath;
  if (typeof filePath !== "string" || !filePath) return null;
  const ext = extOf(filePath);
  const mime = EXT_MIME[ext] ?? null;
  return {
    id: part.id,
    kind: mime != null && mime.startsWith("image/") ? "image" : "file",
    origin: "agent",
    key: filePath.toLowerCase(),
    label: lastPathSegment(filePath),
    href: filePath,
    mime,
    size: null,
    at: typeof state?.time?.start === "number" ? state.time.start : messageCreated(msg),
    messageId: msg.info.id,
    context: null,
    expiresAt: null,
  };
}

function derivePageArtifact(page: ServedPageMeta, matched: OpencodeMessage | null): Artifact {
  return {
    id: "page:" + page.subdomain,
    kind: "link",
    origin: "agent",
    key: page.url.toLowerCase(),
    label: page.subdomain,
    href: page.url,
    mime: null,
    size: null,
    at: page.createdAt,
    messageId: matched ? matched.info.id : null,
    context: matched ? collapseAndTrim(messageText(matched)) : null,
    expiresAt: page.expiresAt,
  };
}

// Find the newest assistant message whose (joined) text contains `url`.
function newestAnnouncingMessage(messages: OpencodeMessage[], url: string): OpencodeMessage | null {
  let best: OpencodeMessage | null = null;
  let bestAt = -1;
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue;
    if (!messageText(msg).includes(url)) continue;
    const at = messageCreated(msg);
    if (at >= bestAt) {
      best = msg;
      bestAt = at;
    }
  }
  return best;
}

// Dedupe on lowercased href: keep only the artifact with the greatest `at`;
// on a tie keep the first encountered.
function dedupeByKey(items: Artifact[]): Artifact[] {
  const byKey = new Map<string, Artifact>();
  for (const item of items) {
    const existing = byKey.get(item.key);
    if (!existing || item.at > existing.at) {
      byKey.set(item.key, item);
    }
  }
  return [...byKey.values()];
}

export function deriveArtifacts(
  messages: OpencodeMessage[],
  pages: ServedPageMeta[],
  sessionId: string,
): Artifact[] {
  const out: Artifact[] = [];

  for (const msg of messages) {
    const isUser = msg.info.role === "user";
    for (const part of msg.parts) {
      if (part.type === "file") {
        out.push(deriveFileArtifact(msg, part));
        continue;
      }
      // Agent-created files: a `write` tool with a target path is a produced
      // artifact; every other tool part is excluded.
      if (part.type === "tool") {
        if (part.tool === "write") {
          const generated = deriveWriteArtifact(msg, part);
          if (generated) out.push(generated);
        }
        continue;
      }
      // Only text parts of USER messages contribute links; every other part
      // type (patch, step-start, step-finish, reasoning, snapshot, agent) is
      // explicitly excluded.
      if (part.type !== "text" || !isUser) continue;
      if (part.synthetic || part.ignored) continue;
      const text = part.text ?? "";
      const matches = [...text.matchAll(URL_RE)];
      for (let i = 0; i < matches.length; i++) {
        const a = deriveLinkArtifact(msg, part, matches[i][0]);
        if (!a) continue;
        // A single text part can yield multiple link artifacts. Each gets a
        // stable, unique id — the part id, suffixed with the URL index when
        // the part emits more than one — so ids never collide as React keys
        // in BET-659. Deterministic, so it stays stable across re-derivations.
        a.id = matches.length > 1 ? `${part.id}.${i}` : part.id;
        out.push(a);
      }
    }
  }

  for (const page of pages) {
    if (page.sessionID !== sessionId) continue;
    out.push(derivePageArtifact(page, newestAnnouncingMessage(messages, page.url)));
  }

  return dedupeByKey(out).sort((a, b) => b.at - a.at);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Calendar-day index (days since epoch) in LOCAL time, DST-safe by offsetting
// the timestamp to UTC before dividing — makes "today/yesterday/older" and
// same-day grouping independent of the local offset.
function dayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}

export function groupByDay(items: Artifact[], now: number): Array<{ label: string; items: Artifact[] }> {
  if (items.length === 0) return [];
  const today = dayIndex(now);
  const sorted = [...items].sort((a, b) => b.at - a.at);
  const groups: Array<{ label: string; items: Artifact[] }> = [];
  let lastDay = Number.NaN;
  for (const item of sorted) {
    const idx = dayIndex(item.at);
    if (idx === lastDay) {
      groups[groups.length - 1].items.push(item);
    } else {
      groups.push({ label: groupLabel(idx, today, item.at), items: [item] });
      lastDay = idx;
    }
  }
  return groups;
}

function groupLabel(idx: number, today: number, atMs: number): string {
  if (idx === today) return "Today";
  if (idx === today - 1) return "Yesterday";
  const d = new Date(atMs);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export type PageState = "live" | "soon" | "expired" | null;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function pageState(expiresAt: number | null, now: number): PageState {
  if (expiresAt == null) return null;
  if (expiresAt <= now) return "expired";
  return expiresAt - now <= SIX_HOURS_MS ? "soon" : "live";
}

export function countByKind(items: Artifact[]): { link: number; image: number; file: number } {
  const counts = { link: 0, image: 0, file: 0 };
  for (const item of items) {
    counts[item.kind]++;
  }
  return counts;
}
