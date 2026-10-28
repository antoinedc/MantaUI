// artifacts.mjs — the ONE implementation of "what artifacts does this
// conversation have" (links the user pasted, files and images, hosted pages the
// agent published, files the agent pushed to the outbox, plan files). Both
// clients render the result of `artifacts:list`; neither derives anything
// (master D23/D24, WS07 spec "Server-first").
//
// Layers, all pure except the service:
//   deriveArtifacts   transcript + page registry + outbox + directory → core items
//   view              core items + clock → wire items (expiry state) + counts
//   createArtifactsService   injected I/O, memoized, one `list(sessionId)`
//
// The derivation is a line-for-line port of the desktop's former
// `src/renderer/artifacts.ts` / `planRefsFromPart`, with two deliberate
// refinements (pinned by tests): plan hrefs join the opencode SESSION directory,
// and the plan page URL is resolved from the registry + the box's own public
// base instead of each client's server URL.

import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { mimeForName } from "./media.mjs";
import { planSubdomain, planPageUrl } from "../shared/planMode.mjs";

const URL_RE = /https?:\/\/[^\s<>]+/g;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// ---- plan-file discovery (moved from src/renderer/chatUtils.ts) -------------
//
// Plan paths live in different part shapes depending on how the plan was
// authored: a prose mention (text part), the write/plan tool's input
// (`filePath` / `path` / `planPath`), or a patch part's file list. We never read
// tool output or file content, only path fields and prose.

const PLAN_REF_RE = /\.opencode\/plans\/[\w.-]+\.md/g;

// Tools that AUTHOR the plan file (or confirm it at plan_exit). A `read` tool
// pointed at a plan path is a reference, not an authoring signal.
const PLAN_AUTHORING_TOOLS = new Set([
  "write", "edit", "multiEdit", "patch", "plan", "plan_exit",
]);

/** Every distinct `.opencode/plans/*.md` reference a single part carries. */
export function planRefsFromPart(part) {
  const out = [];
  const candidates = [];
  if (!part || typeof part !== "object") return out;
  if (typeof part.text === "string") candidates.push(part.text);
  const isTool = part.type === "tool";
  if (isTool && PLAN_AUTHORING_TOOLS.has(String(part.tool ?? ""))) {
    const input = part.state?.input ?? part.input;
    if (input && typeof input === "object") {
      for (const key of ["filePath", "path", "planPath"]) {
        const v = input[key];
        if (typeof v === "string") candidates.push(v);
      }
    }
  }
  if (Array.isArray(part.files)) candidates.push(...part.files.map(String));
  for (const c of candidates) {
    for (const m of c.matchAll(PLAN_REF_RE)) {
      if (!out.includes(m[0])) out.push(m[0]);
    }
  }
  return out;
}

/** Number of `##` / `###` headings — a plan's derivable step count (0 = none). */
export function planStepCount(text) {
  if (!text) return 0;
  return text.match(/^#{2,3}\s+.+$/gm)?.length ?? 0;
}

/** Readable plan title from a plan filename: strip `.md` and the `YYYY-MM-DD-` stamp, un-slug. */
export function planTitleFromPath(file) {
  let base = String(file).replace(/\.md$/i, "");
  base = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const title = base.replace(/[-_]+/g, " ").trim();
  return title || base;
}

/** "live" | "soon" (≤ 6 h) | "expired" | null (no expiry concept). */
export function expiryState(expiresAt, now) {
  if (expiresAt == null) return null;
  if (expiresAt <= now) return "expired";
  return expiresAt - now <= SIX_HOURS_MS ? "soon" : "live";
}

export function countByKind(items) {
  const counts = { link: 0, image: 0, file: 0, plan: 0 };
  for (const item of items) {
    if (item.kind in counts) counts[item.kind]++;
  }
  return counts;
}

// ---- small helpers ----------------------------------------------------------

function collapseAndTrim(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function messageText(msg) {
  return (msg.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

function messageCreated(msg) {
  return msg.info?.time?.created ?? 0;
}

function lastPathSegment(s) {
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** True for an absolute http(s) URL with a host. */
export function isUsableHttpUrl(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

function joinHref(directory, rel) {
  if (!directory) return rel;
  return directory.endsWith("/") ? directory + rel : `${directory}/${rel}`;
}

// ---- plan page resolution ---------------------------------------------------

/**
 * Where a session's plan page lives. Evaluated against the registry rows under
 * the session's plan subdomain (the slug truncates the session id, so two
 * sessions can share it):
 *   1. a row owned by this session → its URL if usable, else null
 *      ("no-public-address": `listPages` returns `url:""` with no public base);
 *   2. a row owned by another session (or none) → null, "other-session" — the
 *      deterministic URL would open that other session's page;
 *   3. no row → the deterministic URL when `baseUrl` is usable, else null.
 * `pageUrlReason` is null whenever `pageUrl` is non-null.
 */
export function planPageResolution({ sessionId, pages, baseUrl }) {
  const sub = planSubdomain(sessionId);
  if (!sub) return { pageUrl: null, pageUrlReason: "no-public-address" };
  const rows = (pages ?? []).filter((p) => p.subdomain === sub);
  const owned = rows.find((p) => p.sessionID === sessionId);
  if (owned) {
    return isUsableHttpUrl(owned.url)
      ? { pageUrl: owned.url, pageUrlReason: null }
      : { pageUrl: null, pageUrlReason: "no-public-address" };
  }
  if (rows.length > 0) return { pageUrl: null, pageUrlReason: "other-session" };
  if (isUsableHttpUrl(baseUrl)) {
    const url = planPageUrl(sessionId, baseUrl);
    if (isUsableHttpUrl(url)) return { pageUrl: url, pageUrlReason: null };
  }
  return { pageUrl: null, pageUrlReason: "no-public-address" };
}

// ---- derivation -------------------------------------------------------------

function deriveFileItem(msg, part) {
  const url = String(part.url ?? "");
  const mime = part.mime != null ? String(part.mime) : null;
  const pathOnly = url.replace(/^file:\/\//, "");
  return {
    id: part.id,
    kind: mime != null && mime.startsWith("image/") ? "image" : "file",
    origin: msg.info?.role === "user" ? "user" : "agent",
    key: pathOnly.toLowerCase(),
    label: part.filename ? String(part.filename) : lastPathSegment(pathOnly),
    href: pathOnly,
    mime,
    size: typeof part.size === "number" ? part.size : null,
    at: messageCreated(msg),
    messageId: msg.info?.id ?? null,
    context: null,
    isHosted: false,
    expiresAt: null,
    plan: null,
  };
}

function deriveLinkItem(msg, part, url) {
  let parsed;
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
    messageId: msg.info?.id ?? null,
    context: collapseAndTrim((part.text ?? "").replace(url, "")),
    isHosted: false,
    expiresAt: null,
    plan: null,
  };
}

// An agent-pushed file. The outbox is a durable, workspace-linked mailbox: the
// row's `sessionID` scopes it to the conversation that pushed it, `expiresAt` is
// its TTL, and an unlisted extension keeps `mime: null` (download path).
function deriveOutboxItem(row) {
  const mime = mimeForName(row.name);
  return {
    id: `outbox:${row.path}`,
    kind: mime != null && mime.startsWith("image/") ? "image" : "file",
    origin: "agent",
    key: row.path.toLowerCase(),
    label: row.name,
    href: row.path,
    mime,
    size: typeof row.size === "number" ? row.size : null,
    at: row.mtime || 0,
    messageId: row.messageID ?? null,
    context: null,
    isHosted: false,
    expiresAt: row.expiresAt ?? null,
    plan: null,
  };
}

// The plan markdown for step-count derivation: the part's own prose, else the
// tool-input `content` of the write/plan part that authored the file.
function partAnnounceText(part) {
  if (typeof part.text === "string" && part.text.trim()) return part.text;
  const input = part.state?.input ?? part.input;
  if (input && typeof input.content === "string" && input.content.trim()) return input.content;
  return null;
}

function derivePlanItem(msg, path, { announceText, directory, pageResolution }) {
  const rel = path.replace(/^\.\//, "");
  return {
    id: `plan:${rel.toLowerCase()}`,
    kind: "plan",
    origin: "agent",
    key: rel.toLowerCase(),
    label: planTitleFromPath(lastPathSegment(rel)),
    href: joinHref(directory, rel),
    mime: "text/markdown",
    size: null,
    at: messageCreated(msg),
    messageId: msg.info?.id ?? null,
    context: null,
    isHosted: false,
    expiresAt: null,
    plan: {
      status: "draft",
      steps: planStepCount(announceText ?? messageText(msg)),
      pageUrl: pageResolution.pageUrl,
      pageUrlReason: pageResolution.pageUrlReason,
      fileAvailable: Boolean(directory),
    },
  };
}

function derivePageItem(page, matched) {
  return {
    id: `page:${page.subdomain}`,
    kind: "link",
    origin: "agent",
    key: page.url.toLowerCase(),
    label: page.subdomain,
    href: page.url,
    mime: null,
    size: null,
    at: page.createdAt,
    messageId: matched ? matched.info?.id ?? null : null,
    context: matched ? collapseAndTrim(messageText(matched)) : null,
    isHosted: true,
    expiresAt: page.expiresAt ?? null,
    plan: null,
  };
}

// The newest assistant message whose (joined) text contains `url`.
function newestAnnouncingMessage(messages, url) {
  let best = null;
  let bestAt = -1;
  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue;
    if (!messageText(msg).includes(url)) continue;
    const at = messageCreated(msg);
    if (at >= bestAt) {
      best = msg;
      bestAt = at;
    }
  }
  return best;
}

// Dedupe on `key`: keep the item with the greatest `at`; a tie keeps the first.
function dedupeByKey(items) {
  const byKey = new Map();
  for (const item of items) {
    const existing = byKey.get(item.key);
    if (!existing || item.at > existing.at) byKey.set(item.key, item);
  }
  return [...byKey.values()];
}

/**
 * Hosted (non-plan) pages of this session that cannot be listed because the box
 * has no usable public URL for them. The service reports them as
 * `degraded: ["public-address"]`.
 */
export function omittedHostedPages({ pages, sessionId }) {
  const planSub = planSubdomain(sessionId);
  return (pages ?? []).filter(
    (p) => p.sessionID === sessionId && p.subdomain !== planSub && !isUsableHttpUrl(p.url),
  );
}

/**
 * Pure derivation → core items (no expiry state), newest first. `key` and
 * `expiresAt` are internal: `view` turns them into the wire shape.
 *
 * @param {{ messages: any[], pages: any[], outbox: any[], sessionId: string,
 *           directory: string|null, baseUrl: string }} input
 */
export function deriveArtifacts({ messages, pages, outbox, sessionId, directory, baseUrl }) {
  messages = messages ?? [];
  pages = pages ?? [];
  outbox = outbox ?? [];
  const out = [];

  for (const msg of messages) {
    const isUser = msg.info?.role === "user";
    for (const part of msg.parts ?? []) {
      if (part.type === "file") {
        out.push(deriveFileItem(msg, part));
        continue;
      }
      // Only text parts of USER messages contribute links; every other part type
      // (tool, patch, step-start, step-finish, reasoning, snapshot, agent) is
      // excluded.
      if (part.type !== "text" || !isUser) continue;
      if (part.synthetic || part.ignored) continue;
      const matches = [...(part.text ?? "").matchAll(URL_RE)];
      for (let i = 0; i < matches.length; i++) {
        const item = deriveLinkItem(msg, part, matches[i][0]);
        if (!item) continue;
        // A part that yields several links gets a stable `.N` suffix so ids never
        // collide; a single link keeps the part id.
        item.id = matches.length > 1 ? `${part.id}.${i}` : part.id;
        out.push(item);
      }
    }
  }

  // Plan artifacts: any non-synthetic part (prose mention, write/plan tool input,
  // patch file list) may carry a `.opencode/plans/*.md` path. A plan path is never
  // an `https?://` URL or a `file:` part, so it is never ALSO a link or a file.
  const pageResolution = planPageResolution({ sessionId, pages, baseUrl });
  const plansByKey = new Map();
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (part.synthetic || part.ignored) continue;
      for (const ref of planRefsFromPart(part)) {
        const item = derivePlanItem(msg, ref, {
          announceText: partAnnounceText(part),
          directory,
          pageResolution,
        });
        const existing = plansByKey.get(item.key);
        if (!existing || item.at > existing.at) plansByKey.set(item.key, item);
      }
    }
  }
  out.push(...plansByKey.values());

  const planSub = planSubdomain(sessionId);
  for (const page of pages) {
    if (page.sessionID !== sessionId) continue;
    // The auto-published plan page is represented BY its plan item — never also a link.
    if (page.subdomain === planSub) continue;
    // A page with no usable public URL is omitted (never a link with an empty href).
    if (!isUsableHttpUrl(page.url)) continue;
    out.push(derivePageItem(page, newestAnnouncingMessage(messages, page.url)));
  }

  for (const row of outbox) {
    // Workspace-link: only the conversation that pushed the file sees it.
    if (row.sessionID !== sessionId) continue;
    out.push(deriveOutboxItem(row));
  }

  return dedupeByKey(out).sort((a, b) => b.at - a.at);
}

function wireExpiry(core, now) {
  if (core.isHosted) {
    // A hosted page always carries an expiry concept; no TTL = "never".
    return core.expiresAt == null
      ? { state: "never", expiresAt: null }
      : { state: expiryState(core.expiresAt, now), expiresAt: core.expiresAt };
  }
  // Outbox files carry one only when they have a TTL; everything else has none.
  return core.expiresAt == null
    ? null
    : { state: expiryState(core.expiresAt, now), expiresAt: core.expiresAt };
}

/** Core items + clock → wire items (expiry computed at `now`) + counts. */
export function view(core, now) {
  const items = core.map((c) => ({
    id: c.id,
    kind: c.kind,
    origin: c.origin,
    label: c.label,
    href: c.href,
    mime: c.mime,
    size: c.size,
    at: c.at,
    messageId: c.messageId,
    context: c.context,
    isHosted: c.isHosted,
    expiry: wireExpiry(c, now),
    plan: c.plan ? { ...c.plan } : null,
  }));
  return { items, counts: countByKind(items) };
}

// ---- service ----------------------------------------------------------------

const READ_FAILED = "Couldn't read this conversation's artifacts";

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

// A cheap fingerprint of the transcript tail: last message id + part count +
// completion time + a hash of its parts (covers text growing inside the same
// final part).
function transcriptRevision(tail) {
  const last = Array.isArray(tail) && tail.length > 0 ? tail[tail.length - 1] : null;
  if (!last) return "empty";
  const parts = last.parts ?? [];
  return [
    last.info?.id ?? "",
    parts.length,
    last.info?.time?.completed ?? "",
    sha1(JSON.stringify(parts)),
  ].join("|");
}

function pagesKey(pages, sessionId) {
  const planSub = planSubdomain(sessionId);
  return pages
    .filter((p) => p.sessionID === sessionId || p.subdomain === planSub)
    .map((p) => [p.subdomain, p.url, p.createdAt, p.expiresAt, p.sessionID].join("|"))
    .sort();
}

function outboxKey(rows, sessionId) {
  return rows
    .filter((r) => r.sessionID === sessionId)
    .map((r) => [r.path, r.mtime, r.size, r.expiresAt, r.messageID].join("|"))
    .sort();
}

/**
 * @param {{
 *   listMessages: (sessionId: string, opts?: { limit?: number }) => Promise<any[]>,
 *   listPages: () => any[] | Promise<any[]>,
 *   listOutbox: (sessionId: string) => any[] | Promise<any[]>,
 *   sessionDirectory: (sessionId: string) => Promise<string|null> | string | null,
 *   baseUrl: () => string,
 *   now?: () => number, ttlMs?: number, maxSessions?: number,
 * }} deps
 */
export function createArtifactsService({
  listMessages,
  listPages,
  listOutbox,
  sessionDirectory,
  baseUrl,
  now = Date.now,
  ttlMs = 30_000,
  maxSessions = 32,
}) {
  // Derived cores, oldest-derivation-first eviction after `ttlMs` (a hit never
  // refreshes the age) or beyond `maxSessions`. The injected clock drives the
  // cache's TTL through `perf`; `ttlResolution: 0` makes it read that clock on
  // every check instead of re-using a value cached for a millisecond.
  const cache = new LRUCache({
    max: maxSessions,
    ttl: ttlMs,
    ttlAutopurge: false,
    ttlResolution: 0,
    perf: { now: () => now() },
  });
  /** @type {Map<string, { key: string, promise: Promise<any[]> }>} */
  const inflight = new Map();

  async function optional(read, fallback, name, degraded) {
    try {
      return await read();
    } catch (e) {
      console.warn(`[artifacts] ${name} read failed:`, e?.message ?? e);
      degraded.add(name);
      return fallback;
    }
  }

  async function list(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("artifacts:list needs a sessionId");
    }
    const sid = sessionId;
    const failed = new Set();
    const [pages, outbox, directory, tail] = await Promise.all([
      optional(async () => (await listPages()) ?? [], [], "pages", failed),
      optional(async () => (await listOutbox(sid)) ?? [], [], "outbox", failed),
      optional(async () => (await sessionDirectory(sid)) ?? null, null, "directory", failed),
      (async () => listMessages(sid, { limit: 1 }))().catch((e) => {
        console.warn("[artifacts] transcript tail read failed:", e?.message ?? e);
        throw new Error(READ_FAILED);
      }),
    ]);
    let base = "";
    try {
      base = String(baseUrl() ?? "");
    } catch {
      base = "";
    }

    const key = JSON.stringify([
      base,
      pagesKey(pages, sid),
      outboxKey(outbox, sid),
      directory ?? "?",
      transcriptRevision(tail),
      [...failed].sort(),
    ]);

    let core;
    const cached = cache.get(sid);
    if (cached && cached.key === key) {
      core = cached.core;
    } else {
      let entry = inflight.get(sid);
      if (!entry || entry.key !== key) {
        const promise = (async () => {
          let messages;
          try {
            messages = await listMessages(sid);
          } catch (e) {
            console.warn("[artifacts] transcript read failed:", e?.message ?? e);
            throw new Error(READ_FAILED);
          }
          const derived = deriveArtifacts({
            messages,
            pages,
            outbox,
            sessionId: sid,
            directory,
            baseUrl: base,
          });
          cache.set(sid, { key, core: derived });
          return derived;
        })();
        entry = { key, promise };
        inflight.set(sid, entry);
        const mine = entry;
        const clear = () => {
          if (inflight.get(sid) === mine) inflight.delete(sid);
        };
        promise.then(clear, clear);
      }
      core = await entry.promise;
    }

    // `degraded` always describes THIS request's reads, never a cached one.
    if (omittedHostedPages({ pages, sessionId: sid }).length > 0) failed.add("public-address");
    const generatedAt = now();
    const { items, counts } = view(core, generatedAt);
    const order = ["pages", "outbox", "directory", "public-address"];
    return {
      sessionId: sid,
      generatedAt,
      items,
      counts,
      degraded: order.filter((n) => failed.has(n)),
    };
  }

  return { list };
}
