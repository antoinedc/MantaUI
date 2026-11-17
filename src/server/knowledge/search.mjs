// search.mjs — reading tools: `knowledge_search` and `knowledge_read` (spec §7.2, §11.2).
//
//   • Pages: an FTS5 table in state.sqlite (`page_fts`), rebuilt from the store
//     after every commit (`createPageIndex().rebuild()`).
//   • Transcripts: an injected `searchTranscripts({query, directories, anyTerms,
//     limit}) → {hits:[{sessionID, messageID, partID?, snippet, at, title?}], truncated}`
//     (the transcript index owned by the search-changes work). Hits from sessions
//     with no mapping, or mapped to a project the caller may not read, are dropped.
//   • Scope: `project` (default) = the caller's project wiki, the user wiki and
//     commons (when it reads commons); `all` adds every OTHER project that shares
//     (§4.2). A `private` caller never sees other projects. Unmapped sessions are
//     excluded from transcript hits and have no project of their own.
//   • `page`: `page:` refs read a page (sharing-checked); `msg:`/`part:` refs read
//     the ±5 message neighbourhood through an injected `readMessages`.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ftsMatchExpression } from "../ftsQuery.mjs";
import { parsePartId } from "../opencodeDb.mjs";
import { KnowledgeError } from "./errors.mjs";
import { isSafePagePath, pageArea, pageTitle, parsePage } from "./pages.mjs";
import { effectiveFor } from "./settings.mjs";
import { canReadPage, canReadSessionOf, readableProjects, readsCommons } from "./sharing.mjs";

export const SNIPPET_MAX = 300;
export const MESSAGE_TEXT_MAX = 2000;
export const NEIGHBORHOOD = 5;
const PAGE_BODY_INDEX_MAX = 200_000;

// An any-term (OR) query ranks on what is distinctive: short words and common stop words would match nearly every
// row and drown the real terms. Used for the transcript query and the wiki's OR fallback; a query made ONLY of
// such words keeps its terms (it is all the caller gave).
const STOP_WORDS = new Set(["the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one", "our", "out", "has", "have", "how", "its", "that", "this", "with", "from", "they", "will", "what", "when", "where", "which", "who", "why", "your", "about", "into", "than", "then", "them", "were", "been", "does", "did", "should", "would", "could", "there", "their", "also", "just", "like", "some", "more", "most", "very"]);
export function significantTerms(terms) {
  const list = (terms ?? []).filter((t) => typeof t === "string" && t !== "");
  const keep = list.filter((t) => {
    const w = t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    return w.length >= 3 && !STOP_WORDS.has(w);
  });
  return keep.length > 0 ? keep : list;
}

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Keep `state.page_fts` / `page_meta` equal to the store's pages. */
export function createPageIndex({ state, store, now = Date.now } = {}) {
  const db = state.db;
  let running = null;
  let again = false;
  async function rebuildOnce() {
    const paths = await store.listPages();
    const rows = [];
    for (const path of paths) {
      const src = await store.read(path);
      if (src === null) continue;
      const area = pageArea(path);
      if (!area) continue;
      const p = parsePage(src);
      let mtime = now();
      try {
        mtime = Math.trunc((await stat(join(store.dir, path))).mtimeMs);
      } catch {
        /* keep now */
      }
      rows.push({ path, area: area.area, slug: area.slug, title: pageTitle(src, path), verified: p.frontMatter?.verified == null ? null : String(p.frontMatter.verified), sources: JSON.stringify(p.frontMatter?.sources ?? []), body: p.body.slice(0, PAGE_BODY_INDEX_MAX), mtime });
    }
    state.transaction(() => {
      db.exec("DELETE FROM page_fts");
      db.exec("DELETE FROM page_meta");
      const fts = db.prepare("INSERT INTO page_fts (title, body, path, area, slug) VALUES (?, ?, ?, ?, ?)");
      const meta = db.prepare("INSERT INTO page_meta (path, area, slug, title, verified, sources, mtime) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const r of rows) {
        fts.run(r.title, r.body, r.path, r.area, r.slug);
        meta.run(r.path, r.area, r.slug, r.title, r.verified, r.sources, r.mtime);
      }
    });
    return rows.length;
  }
  return {
    /** Coalescing: a rebuild requested during a rebuild runs once more afterwards. */
    rebuild() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        let n = 0;
        do {
          again = false;
          n = await rebuildOnce();
        } while (again);
        return n;
      })().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

/**
 * deps: state, store, registry, sessionMap, settings, searchTranscripts, readMessages({sessionID, messageIDs, radius}) →
 * [{id, role, text, at}] | null, scanner {redact(text) → {text, unavailable?}}.
 *
 * Transcript text that leaves a project is secret-redacted: a snippet or message of a session that belongs to
 * a project OTHER than the caller's goes through `scanner.redact`; with no scanner, or one that is unavailable,
 * the text is omitted rather than shown raw. The caller's own project (and own session) is shown as is.
 */
export function createSearch({ state, store, registry, sessionMap, settings, searchTranscripts, readMessages, scanner } = {}) {
  const db = state.db;

  async function callerContext(sessionID) {
    const s = await settings.get();
    const callerSlug = (typeof sessionID === "string" && sessionMap.get(sessionID)?.slug) || null;
    const modeOf = (slug) => effectiveFor(s, slug).sharing;
    // unmapped → private (fail closed)
    const callerMode = callerSlug ? modeOf(callerSlug) : "private";
    return { callerSlug, callerMode, modeOf };
  }

  /** The text to show for a session of project `slug`: raw for the caller's own project, redacted for any other, "" if it can't be. */
  async function shown(text, slug, ctx, { own = false } = {}) {
    if (own || (slug && slug === ctx.callerSlug)) return String(text ?? "");
    try {
      const r = scanner ? await scanner.redact(String(text ?? "")) : null;
      return r && !r.unavailable && typeof r.text === "string" ? r.text : "";
    } catch {
      return "";
    }
  }

  function validate({ query, scope, sources, limit }) {
    const q = typeof query === "string" ? query.trim() : "";
    if (q.length < 1 || q.length > 200) throw new KnowledgeError("invalid-query", "query must be 1 to 200 characters.", { status: 400 });
    const sc = scope === undefined || scope === "" ? "project" : scope;
    if (sc !== "project" && sc !== "all") throw new KnowledgeError("invalid-query", 'scope must be "project" or "all".', { status: 400 });
    const src = sources === undefined ? ["wiki", "sessions"] : sources;
    if (!Array.isArray(src) || src.length === 0 || src.some((x) => x !== "wiki" && x !== "sessions")) throw new KnowledgeError("invalid-query", 'sources must be "wiki" and/or "sessions".', { status: 400 });
    const lim = limit === undefined ? 8 : Number(limit);
    if (!Number.isInteger(lim) || lim < 1 || lim > 20) throw new KnowledgeError("invalid-query", "limit must be an integer from 1 to 20.", { status: 400 });
    return { q, scope: sc, sources: new Set(src), limit: lim };
  }

  function wikiHits(q, ctx, readable, limit) {
    const m = ftsMatchExpression(q);
    if (!m.ok) throw new KnowledgeError("invalid-query", m.reason, { status: 400 });
    const meta = db.prepare("SELECT mtime FROM page_meta WHERE path = ?");
    const run = (expr) =>
      db
        .prepare(
          `SELECT path, area, slug, title, snippet(page_fts, 1, '', '', '…', 24) AS snip, bm25(page_fts) AS rank
           FROM page_fts WHERE page_fts MATCH ? ORDER BY rank LIMIT 200`,
        )
        .all(expr);
    let rows = run(m.expr);
    if (rows.length === 0 && m.terms.length > 1) rows = run(significantTerms(m.terms).map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR "));
    const out = [];
    for (const r of rows) {
      if (r.area === "project" ? !readable.has(r.slug) : !canReadPage(r.path, { ...ctx })) continue;
      if (r.area === "commons" && !readsCommons(ctx.callerMode)) continue;
      out.push({ source: "wiki", project: r.area === "project" ? r.slug : r.area, title: r.title, snippet: clip(r.snip, SNIPPET_MAX), ref: `page:${r.path}`, at: meta.get(r.path)?.mtime ?? null });
    }
    return out;
  }

  async function search({ sessionID, query, scope, sources, limit } = {}) {
    const v = validate({ query, scope, sources, limit });
    const ctx = await callerContext(sessionID);
    const all = (await registry.list()).map((p) => p.slug);
    const readable = readableProjects({ callerSlug: ctx.callerSlug, callerMode: ctx.callerMode, scope: v.scope, allSlugs: all, modeOf: ctx.modeOf });
    const hits = [];
    let truncated = false;
    if (v.sources.has("wiki")) hits.push(...wikiHits(v.q, ctx, readable, v.limit));
    if (v.sources.has("sessions") && searchTranscripts && readable.size > 0) {
      const directories = sessionMap.directoriesFor([...readable]);
      if (directories.length > 0) {
        let r = null;
        try {
          r = await searchTranscripts({ query: significantTerms(v.q.split(/\s+/)).join(" "), directories, anyTerms: true, limit: v.limit * 3 });
        } catch (e) {
          console.warn("[knowledge] transcript search failed:", e?.message ?? e);
        }
        if (r?.truncated) truncated = true;
        const sess = [];
        for (const h of r?.hits ?? []) {
          const slug = sessionMap.get(h.sessionID)?.slug ?? null;
          if (!slug || !readable.has(slug)) continue;
          const own = h.sessionID === sessionID;
          // Redact the WHOLE text first, truncate after: a secret cut at the limit would otherwise slip past the scanner.
          const snippet = await shown(h.snippet, slug, ctx, { own });
          const title = await shown(h.title ?? "Session", slug, ctx, { own });
          sess.push({ source: "sessions", project: slug, title: clip(title || "Session", 80), snippet: clip(snippet, SNIPPET_MAX), ref: `msg:${h.sessionID}/${h.messageID}`, at: h.at ?? null });
        }
        sess.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
        hits.push(...sess);
      }
    }
    if (hits.length > v.limit) truncated = true;
    return { hits: hits.slice(0, v.limit), truncated };
  }

  async function page({ sessionID, ref } = {}) {
    const r = typeof ref === "string" ? ref.trim() : "";
    const ctx = await callerContext(sessionID);
    const pg = /^page:(.+)$/.exec(r);
    if (pg) {
      const path = pg[1];
      if (!isSafePagePath(path)) throw new KnowledgeError("not-found", "No such page.", { status: 404 });
      if (!canReadPage(path, ctx)) throw new KnowledgeError("not-shared", "That page isn't shared with this project.", { status: 403 });
      const src = await store.read(path);
      if (src === null) throw new KnowledgeError("not-found", "No such page.", { status: 404 });
      const p = parsePage(src);
      db.prepare("INSERT INTO page_use (path, uses, last_at) VALUES (?, 1, ?) ON CONFLICT(path) DO UPDATE SET uses = uses + 1, last_at = excluded.last_at").run(path, Date.now());
      const out = { kind: "page", title: pageTitle(src, path), body: p.body };
      if (p.frontMatter?.verified != null) out.verified = String(p.frontMatter.verified);
      if (Array.isArray(p.frontMatter?.sources)) out.sources = p.frontMatter.sources.map(String);
      return out;
    }
    const msg = /^(msg|part):([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(r);
    if (!msg) throw new KnowledgeError("not-found", "That ref can't be read.", { status: 404 });
    const [, type, sid, id] = msg;
    const own = typeof sessionID === "string" && sid === sessionID;
    const slug = sessionMap.get(sid)?.slug ?? null;
    if (!own && !canReadSessionOf(slug, ctx)) throw new KnowledgeError("not-shared", "That session isn't shared with this project.", { status: 403 });
    const messageIDs = type === "msg" ? [id] : (parsePartId(id)?.messageIds ?? []);
    if (messageIDs.length === 0 || !readMessages) throw new KnowledgeError("not-found", "No such message.", { status: 404 });
    const rows = await readMessages({ sessionID: sid, messageIDs, radius: NEIGHBORHOOD });
    if (!rows || rows.length === 0) throw new KnowledgeError("not-found", "No such message.", { status: 404 });
    const messages = [];
    for (const m of rows) {
      const text = await shown(String(m.text ?? ""), slug, ctx, { own });
      messages.push({ id: m.id, role: m.role, text: text.slice(0, MESSAGE_TEXT_MAX), at: m.at });
    }
    return { kind: "session", sessionID: sid, messages };
  }

  return { search, page };
}

/**
 * A `readMessages` for `createSearch`, over the box's transcript reader
 * (`listMessages(sessionID) → [{info:{id, role, time:{created}}, parts:[{type, text}]}]`):
 * the ±`radius` messages around the first of `messageIDs` that exists, text parts only.
 */
export function createMessageReader({ listMessages }) {
  return async function readMessages({ sessionID, messageIDs, radius = NEIGHBORHOOD }) {
    const all = (await listMessages(sessionID)) ?? [];
    const i = all.findIndex((m) => messageIDs.includes(m?.info?.id ?? m?.id));
    if (i < 0) return null;
    return all.slice(Math.max(0, i - radius), i + radius + 1).map((m) => {
      const info = m.info ?? m;
      const text = (m.parts ?? [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      return { id: info.id, role: info.role === "user" ? "user" : "assistant", text, at: info.time?.created ?? null };
    });
  };
}
