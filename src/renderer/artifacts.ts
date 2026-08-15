import type { OpencodeMessage, OpencodePart, OutboxFile, ServedPageMeta } from "../shared/types";

export type ArtifactKind = "link" | "image" | "file" | "plan";
export type ArtifactOrigin = "user" | "agent";

// Derived plan lifecycle, never stored — emulates `pageState`'s pattern of a
// pure row-state derivation (see `planStatus` below).
export type PlanStatus = "draft" | "approved" | "building" | "done";

export type Artifact = {
  id: string; // stable: the part id (suffixed .0/.1/... when a text part yields many links), or "page:<subdomain>" / "plan:<path>"
  kind: ArtifactKind;
  origin: ArtifactOrigin;
  key: string; // dedupe key
  label: string; // filename, page title, URL host+path, or plan title
  href: string; // absolute box path for files/images, URL for links, plan file path
  mime: string | null; // null for links
  size: number | null; // byte size for files/images when known (formatBytes), null otherwise
  at: number; // epoch ms, for sorting and day grouping
  messageId: string | null; // owning message; null for outbox files / pages with no announcing message
  context: string | null; // surrounding message text, links only
  expiresAt: number | null; // hosted pages only; null otherwise
  // True only for pages the agent published (serve_page). Distinct from
  // `expiresAt` so a hosted page with no expiry (ttlHours:0) still gets the
  // expiry chip — external/pasted links never do.
  isHosted?: boolean;
  // Plan-kind fields. Present only on `kind === "plan"` artifacts (derived,
  // never stored) — the row's status/step-count/actions read these.
  planStatus?: PlanStatus;
  planStepCount?: number | null;
  planJobSessionId?: string | null; // the job's child session; null until a plan is linked to a job
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
    messageId: msg.info.id,
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
    messageId: msg.info.id,
    context: linkContext(part.text ?? "", url),
    expiresAt: null,
  };
}

// Extension → MIME for files the agent pushes via the outbox (~/.manta-outbox)
// so generated documents/images render with the right glyph tone and preview
// kind. Unlisted extensions fall back to null; `resolvePreviewType` then maps
// them by extension for the preview, and unknown types land on the download
// path. Kept deliberately small — add a type only when a pushed artifact needs
// it.
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

// An agent-pushed file. The outbox is a durable, workspace-linked mailbox: the
// row's `sessionID` scopes it to the conversation that pushed it, and
// `expiresAt` is its TTL (default 7 days) — it is not deleted on download, and
// drops out only when the box's sweep reclaims it.
function deriveOutboxArtifact(row: OutboxFile): Artifact {
  const ext = extOf(row.name);
  const mime = EXT_MIME[ext] ?? null;
  return {
    id: "outbox:" + row.path,
    kind: mime != null && mime.startsWith("image/") ? "image" : "file",
    origin: "agent",
    key: row.path.toLowerCase(),
    label: row.name,
    href: row.path,
    mime,
    size: row.size,
    at: row.mtime || 0,
    messageId: null,
    context: null,
    expiresAt: row.expiresAt,
  };
}

// A plan is genuinely BOTH a file and a link, so it gets its own kind rather
// than being filed under either. Plan artifacts are derived from a plan file
// path (`.opencode/plans/<created>-<slug>.md`) referenced in the session
// transcript — opencode writes plans there when the session runs in plan mode.
// Matches `.opencode/plans/<name>.md` wherever it appears (`./.opencode/...`
// and absolute-prefixed paths both match from the `.opencode` segment).
const PLAN_REF_RE = /\.opencode\/plans\/[\w.-]+\.md/g;

// Readable plan title from a plan filename: strip `.md` and the leading
// `<YYYY-MM-DD>-` created-stamp opencode writes, then un-slug.
function planTitleFromPath(file: string): string {
  let base = file.replace(/\.md$/i, "");
  base = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const title = base.replace(/[-_]+/g, " ").trim();
  return title || base;
}

// A plan's step count is *derived* from its announcing message — the markdown
// step headings (`##`/`###`) the agent wrote alongside the `.md` reference.
// 0 means "no steps derivable from the message" (the row then omits it).
export function planStepCount(text: string | null): number {
  if (!text) return 0;
  return text.match(/^#{2,3}\s+.+$/gm)?.length ?? 0;
}

// Derived plan lifecycle, never stored (parallels `pageState`). Precedence:
// a completed build is `done`, an in-flight build is `building`, an approved
// (but not yet built) plan is `approved`, anything else — or a rejected /
// failed build — falls back to `draft`.
export function planStatus(opts: {
  completed?: boolean;
  running?: boolean;
  approved?: boolean;
}): PlanStatus {
  if (opts.completed) return "done";
  if (opts.running) return "building";
  if (opts.approved) return "approved";
  return "draft";
}

function joinHref(cwd: string | null, rel: string): string {
  if (!cwd) return rel;
  return cwd.endsWith("/") ? cwd + rel : cwd + "/" + rel;
}

function derivePlanArtifact(
  msg: OpencodeMessage,
  path: string,
  cwd: string | null,
): Artifact {
  const rel = path.replace(/^\.\//, "");
  const label = planTitleFromPath(lastPathSegment(rel));
  return {
    id: "plan:" + rel.toLowerCase(),
    kind: "plan",
    origin: "agent",
    key: rel.toLowerCase(),
    label,
    href: joinHref(cwd, rel),
    mime: "text/markdown",
    size: null,
    at: messageCreated(msg),
    messageId: msg.info.id,
    context: null,
    expiresAt: null,
    planStatus: planStatus({}),
    planStepCount: planStepCount(messageText(msg)),
    planJobSessionId: null, // set once a plan is linked to its implementing job
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
    isHosted: true,
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
  outbox: OutboxFile[] = [],
  cwd: string | null = null,
): Artifact[] {
  const out: Artifact[] = [];

  for (const msg of messages) {
    const isUser = msg.info.role === "user";
    for (const part of msg.parts) {
      if (part.type === "file") {
        out.push(deriveFileArtifact(msg, part));
        continue;
      }
      // Only text parts of USER messages contribute links; every other part
      // type (tool, patch, step-start, step-finish, reasoning, snapshot,
      // agent) is explicitly excluded.
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

  // Plan artifacts: any text part (any role) may reference a plan file. The
  // `.md` path is never an `https?://` URL and never a `file:` part, so a
  // plan is never ALSO emitted as a link or a file (no double-counting).
  const plansByKey = new Map<string, Artifact>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "text") continue;
      if (part.synthetic || part.ignored) continue;
      for (const m of (part.text ?? "").matchAll(PLAN_REF_RE)) {
        const a = derivePlanArtifact(msg, m[0], cwd);
        const existing = plansByKey.get(a.key);
        if (!existing || a.at > existing.at) plansByKey.set(a.key, a);
      }
    }
  }
  out.push(...plansByKey.values());

  for (const page of pages) {
    if (page.sessionID !== sessionId) continue;
    out.push(derivePageArtifact(page, newestAnnouncingMessage(messages, page.url)));
  }

  for (const row of outbox) {
    // Workspace-link: only the conversation that pushed the file sees it.
    if (row.sessionID !== sessionId) continue;
    out.push(deriveOutboxArtifact(row));
  }

  return dedupeByKey(out).sort((a, b) => b.at - a.at);
}

// Locale-driven "older than yesterday" group label — "Mon, 3 Aug" / "Mon, Aug 3"
// depending on the OS locale. Module-level so the (expensive) Intl object is
// constructed once, not per group. Mirrors the RESET_*_FMT consts in
// chatUtils.ts (BET-966). Deliberately no year: the label is a within-recent-
// history grouping header, and adding a year is a behaviour change, not this task.
const GROUP_DAY_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

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
  return GROUP_DAY_FMT.format(atMs);
}

export type PageState = "live" | "soon" | "expired" | null;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function pageState(expiresAt: number | null, now: number): PageState {
  if (expiresAt == null) return null;
  if (expiresAt <= now) return "expired";
  return expiresAt - now <= SIX_HOURS_MS ? "soon" : "live";
}

export function countByKind(items: Artifact[]): {
  link: number;
  image: number;
  file: number;
  plan: number;
} {
  const counts = { link: 0, image: 0, file: 0, plan: 0 };
  for (const item of items) {
    counts[item.kind]++;
  }
  return counts;
}
