// blackboardImport.mjs — one-time import of the CTO blackboard (spec §6.1) and the key
// resolution rule it shares with the live mirror (ctoMirror.mjs, §5.4).
//
// The blackboard files are `~/.manta/cto/facts/<key>.json` (`{v, facts:[…]}`); the key is FREE
// TEXT (one project is filed under many names). A key is imported only when it can be resolved
// to exactly ONE project:
//   <key> = a tmux session name (exact, else a unique case-insensitive match) → the session's
//   windows → each window's directory → `registry.identify()` (falling back to the window's opencode
//   session mapping) → the set of project slugs must have exactly one member.
// Anything else (UUIDs, ambiguous names, sessions that no longer exist) is skipped and listed ONCE in
// Recent changes. Nothing under `~/.manta/cto/` is ever written.
//
// Idempotent and resumable: progress is kept per key in state.sqlite (`import.cto.progress`), the
// queue dedups by note hash, and the work is done in small slices (`run({budgetMs})`) that yield
// to the event loop between keys — call it from the maintenance tick until `done`.
//
// NEVER call `registry.identify()` while holding the store lock (it commits projects.json through it):
// this module takes no store lock.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { statePath } from "../../shared/paths.mjs";
import { NOTE_TEXT_MAX, NOTE_REFS_MAX, NoteRejected, isValidRef } from "./queue.mjs";
import { BOX_ID } from "./identity.mjs";

export const PROGRESS_KEY = "import.cto.progress";
export const DONE_KEY = "import.cto.done";
export const REPORTED_KEY = "import.cto.reported";
const RESOLVE_CACHE_MS = 30_000;
const REASON_MAX = 580;

/** CTO fact kind → note kind. The spec routes `cto_fact` proposals in as `status` / `decision` notes. */
export const factKindToNoteKind = (kind) => (kind === "decision" ? "decision" : "status");

/** Keep the refs that fit the §11.4 grammar (mapping bare https URLs, absolute paths and commit shas); drop the rest. */
export function mapFactRefs(refs) {
  const out = [];
  for (const raw of Array.isArray(refs) ? refs : []) {
    if (typeof raw !== "string") continue;
    const r = raw.trim();
    let mapped = null;
    if (isValidRef(r)) mapped = r;
    else if (/^https:\/\/\S+$/.test(r)) mapped = `url:${r}`;
    else if (r.startsWith("/")) mapped = `file:${r}`;
    else if (/^[0-9a-f]{7,40}$/.test(r)) mapped = `commit:${r}`;
    if (mapped && isValidRef(mapped) && !out.includes(mapped)) out.push(mapped);
    if (out.length >= NOTE_REFS_MAX) break;
  }
  return out;
}

const expired = (f, t) => {
  const v = f?.valid_until;
  if (v == null) return false;
  const ms = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) && t >= ms;
};
/** Active = not superseded, not expired. */
export const isActiveFact = (f, t) => !!f && typeof f.statement === "string" && f.statement.trim() !== "" && !f.superseded_by && !expired(f, t);

/**
 * The shared key resolution (§6.1 / §5.4).
 * deps: listTmuxProjects() → [{tmuxSession, windows:[{paneCurrentPath, opencodeSessionId?}]}]   (`tmux.listProjects`)
 *       registry {identify(dir) → {slug, canonicalId}|null}, sessionMap? {get(sessionID) → {slug}|null}
 * `resolve(key)` → `{ok:true, slug}` | `{ok:false, reason}`; never throws.
 */
export function createKeyResolver({ listTmuxProjects, registry, sessionMap, now = Date.now, cacheMs = RESOLVE_CACHE_MS } = {}) {
  let cache = { at: -Infinity, projects: [] };
  const dirCache = new Map();

  async function projects() {
    if (now() - cache.at < cacheMs) return cache.projects;
    const list = await listTmuxProjects();
    cache = { at: now(), projects: Array.isArray(list) ? list : [] };
    dirCache.clear();
    return cache.projects;
  }

  /** `{slug, box}` of a window, or null when it cannot be resolved. `box` = outside any repository. */
  async function projectOfWindow(w) {
    const dir = typeof w?.paneCurrentPath === "string" ? w.paneCurrentPath : "";
    if (dir) {
      if (!dirCache.has(dir)) dirCache.set(dir, registry.identify(dir).then((r) => (r?.slug ? { slug: r.slug, box: r.canonicalId === BOX_ID } : null), () => null));
      const hit = await dirCache.get(dir);
      if (hit) return hit;
    }
    const slug = (w?.opencodeSessionId && sessionMap?.get(w.opencodeSessionId)?.slug) || null;
    return slug ? { slug, box: false } : null;
  }

  /** The one project the given opencode sessions are mapped to (the facts' own authors), else null. */
  function slugFromSessions(sessionIDs) {
    const slugs = new Set();
    for (const id of sessionIDs ?? []) {
      const slug = typeof id === "string" ? sessionMap?.get(id)?.slug : null;
      if (slug) slugs.add(slug);
    }
    return slugs.size === 1 ? [...slugs][0] : null;
  }

  /**
   * `sessionIDs` (optional): opencode sessions that wrote facts under this key. They resolve a key whose tmux session
   * no longer exists (a PAST name) through the session map — only when they all agree on one project.
   */
  async function resolve(key, { sessionIDs = [] } = {}) {
    try {
      const k = String(key ?? "").trim();
      if (!k) return { ok: false, reason: "empty key" };
      const fallback = (reason) => {
        const slug = slugFromSessions(sessionIDs);
        return slug ? { ok: true, slug } : { ok: false, reason };
      };
      const list = await projects();
      let hits = list.filter((p) => p.tmuxSession === k);
      if (hits.length === 0) {
        hits = list.filter((p) => String(p.tmuxSession ?? "").toLowerCase() === k.toLowerCase());
        if (hits.length > 1) return { ok: false, reason: "ambiguous: several tmux sessions match that name" };
      }
      if (hits.length === 0) return fallback("no tmux session with that name");
      const real = new Set();
      let box = false;
      for (const w of hits[0].windows ?? []) {
        const p = await projectOfWindow(w);
        if (!p) continue;
        if (p.box) box = true;
        else real.add(p.slug);
      }
      // Windows outside any repository (a shell in ~) don't make a session ambiguous when a real project is also there.
      if (real.size === 0) return fallback(box ? "its windows are outside any repository" : "none of its windows resolve to a project");
      if (real.size > 1) return { ok: false, reason: `ambiguous: its windows span ${real.size} projects` };
      return { ok: true, slug: [...real][0] };
    } catch (e) {
      return { ok: false, reason: `could not resolve: ${String(e?.message ?? e).slice(0, 80)}` };
    }
  }

  return { resolve, invalidate: () => (cache = { at: -Infinity, projects: [] }) };
}

/**
 * deps:
 *   state          openState() handle (progress markers in kv)
 *   queue          enqueue(…)
 *   changesLog     add(…) — the one "import" change
 *   resolver       createKeyResolver(…) (or any {resolve(key)})
 *   factsDir       default `~/.manta/cto/facts`
 *   readdir/readFile  injectable fs (tests)
 *   now, log
 */
export function createBlackboardImport(deps = {}) {
  const { state, queue, changesLog, resolver } = deps;
  for (const k of ["state", "queue", "changesLog", "resolver"]) if (!deps[k]) throw new Error(`createBlackboardImport: ${k} is required`);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.warn;
  const factsDir = deps.factsDir ?? statePath("cto", "facts");
  const ls = deps.readdir ?? readdir;
  const read = deps.readFile ?? readFile;

  const loadProgress = () => {
    try {
      const p = JSON.parse(state.kvGet(PROGRESS_KEY, "{}"));
      return p && typeof p === "object" && p.keys && typeof p.keys === "object" ? p : { keys: {} };
    } catch {
      return { keys: {} };
    }
  };
  const saveProgress = (p) => state.kvSet(PROGRESS_KEY, JSON.stringify(p));
  const isDone = () => state.kvGet(DONE_KEY) === "1";

  /** The key's file → its ACTIVE facts, or `{error}`. */
  async function readFacts(key) {
    try {
      const doc = JSON.parse(await read(join(factsDir, `${key}.json`), "utf8"));
      const t = now();
      return { facts: (Array.isArray(doc?.facts) ? doc.facts : []).filter((f) => isActiveFact(f, t)) };
    } catch (e) {
      return { error: `unreadable (${String(e?.code ?? e?.message ?? e).slice(0, 40)})` };
    }
  }

  async function importFacts(facts, slug) {
    let n = 0;
    for (const f of facts) {
      let r;
      try {
        r = await queue.enqueue({
          slug,
          sessionID: typeof f.sender?.sessionID === "string" ? f.sender.sessionID : null,
          origin: "import",
          kind: factKindToNoteKind(f.kind),
          text: f.statement.replace(/\s+/g, " ").trim().slice(0, NOTE_TEXT_MAX),
          refs: mapFactRefs(f.refs),
          derived: true,
        });
      } catch (e) {
        if (e instanceof NoteRejected) continue;
        throw e;
      }
      if (r.accepted) n++;
      else if (/scanner/i.test(String(r.reason))) return { s: "paused", reason: r.reason };
    }
    return { s: "imported", slug, n };
  }

  function report(progress) {
    if (state.kvGet(REPORTED_KEY) === "1") return;
    const entries = Object.entries(progress.keys);
    const imported = entries.filter(([, v]) => v.s === "imported");
    const skipped = entries.filter(([, v]) => v.s === "skipped");
    const facts = imported.reduce((a, [, v]) => a + (v.n ?? 0), 0);
    const projects = new Set(imported.map(([, v]) => v.slug)).size;
    const list = skipped.map(([k, v]) => `${k} (${v.reason})`).join("; ");
    changesLog.add({
      kind: "import",
      summary: `Imported ${facts} CTO fact${facts === 1 ? "" : "s"} into ${projects} project${projects === 1 ? "" : "s"}; skipped ${skipped.length} key${skipped.length === 1 ? "" : "s"}`,
      reason: skipped.length ? `Skipped: ${list}`.slice(0, REASON_MAX) : "Every blackboard key mapped to a project.",
      area: "project",
      undoable: false,
      data: {
        imported: imported.map(([key, v]) => ({ key, slug: v.slug, facts: v.n ?? 0 })),
        skipped: skipped.map(([key, v]) => ({ key, reason: v.reason })),
      },
    });
    state.kvSet(REPORTED_KEY, "1");
  }

  /**
   * Process keys until `budgetMs` is spent. Returns `{done, imported, skipped, remaining}`.
   * Safe to call repeatedly (and after a restart): finished keys are never redone.
   */
  async function run({ budgetMs = 2_000 } = {}) {
    if (isDone()) return { done: true, imported: 0, skipped: 0, remaining: 0 };
    let names;
    try {
      names = (await ls(factsDir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    } catch (e) {
      if (e?.code === "ENOENT") {
        state.kvSet(DONE_KEY, "1"); // no blackboard on this box: nothing to import
        return { done: true, imported: 0, skipped: 0, remaining: 0 };
      }
      log("[knowledge] blackboard import: cannot list facts:", e?.message ?? e);
      return { done: false, imported: 0, skipped: 0, remaining: -1 };
    }
    const progress = loadProgress();
    const deadline = now() + budgetMs;
    let imported = 0;
    let skipped = 0;
    for (const key of names) {
      if (progress.keys[key]) continue;
      if (now() >= deadline) break;
      const read_ = await readFacts(key);
      let entry;
      const res = read_.error ? null : await resolver.resolve(key, { sessionIDs: read_.facts.map((f) => f.sender?.sessionID).filter((x) => typeof x === "string") });
      if (read_.error) entry = { s: "skipped", reason: read_.error };
      else if (!res.ok) entry = { s: "skipped", reason: res.reason };
      else {
        entry = await importFacts(read_.facts, res.slug);
        if (entry.s === "paused") {
          log("[knowledge] blackboard import paused:", entry.reason);
          break; // retried by the next slice; nothing recorded for this key
        }
      }
      progress.keys[key] = entry;
      saveProgress(progress);
      if (entry.s === "imported") imported++;
      else skipped++;
      await new Promise((r) => setImmediate(r));
    }
    const remaining = names.filter((k) => !progress.keys[k]).length;
    if (remaining === 0) {
      report(progress);
      state.kvSet(DONE_KEY, "1");
    }
    return { done: remaining === 0, imported, skipped, remaining };
  }

  return { run, isDone, progress: loadProgress };
}
