// rules.mjs — project rules, preferences and their bookkeeping (spec §4.1, §6.3, §6.5).
//
//   • `projects/<slug>/rules.md` holds a project's standing rules as top-level bullets. The briefing
//     reads it (part 1) while the rules are not delivered through the repository.
//   • `applyBulletOp` edits ONE bullet line and touches nothing else in the page, so a hand-written
//     page keeps its exact formatting.
//   • `state.sqlite` tables (this module's own migration): `curator_rules` (rule tracking: when it was
//     applied, its correction cluster, how many times it was rewritten), `curator_bullets` (which
//     project contributed which bullet of a shared page — the downgrade cleanup needs it).
//   • `repoSafeText` — everything that goes to a repository (block text, reasons) carries the rule and
//     a one-line reason only: no quotes, ids or refs.

import { createHash } from "node:crypto";
import { parsePage, renderPage } from "./pages.mjs";

export const RULES_BUDGET_LINES = 120;
export const GLOBAL_BUDGET_LINES = 200;
export const RULE_TEXT_MAX = 300;

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
export const bulletHash = (s) => createHash("sha256").update(norm(s)).digest("hex").slice(0, 24);
const BULLET_RE = /^([-*])\s+(.+?)\s*$/;

/** Top-level bullets of a page body: `[{text, line}]`. */
export function parseBullets(source) {
  const body = parsePage(source).body;
  const out = [];
  body.split("\n").forEach((l, i) => {
    const m = BULLET_RE.exec(l.replace(/\r$/, ""));
    if (m) out.push({ text: m[2], line: i });
  });
  return out;
}

/** One-line, bullet-safe text, or null when it can't be a rule/preference. */
export function cleanBulletText(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").replace(/^[-*]\s+/, "").trim();
  if (t.length < 3 || t.length > RULE_TEXT_MAX) return null;
  return t;
}

export function newBulletsPage(title, text) {
  return renderPage({ frontMatter: { title }, body: `# ${title}\n\n${text ? `- ${text}\n` : ""}` });
}

/**
 * Add, change or remove one top-level bullet. Returns `{changed, source, reason?}`. `reason`:
 * "exists" (add of an existing bullet), "missing" (change/remove of a bullet that isn't there).
 */
export function applyBulletOp(source, { op, text, replaces, title = "Notes" } = {}) {
  const cur = source ?? newBulletsPage(title, "");
  const page = parsePage(cur);
  const lines = page.body.split("\n");
  const find = (t) => lines.findIndex((l) => {
    const m = BULLET_RE.exec(l.replace(/\r$/, ""));
    return m && norm(m[2]) === norm(t);
  });
  const withBody = (ls) => `${cur.slice(0, page.bodyOffset)}${ls.join("\n")}`;
  if (op === "add") {
    if (find(text) >= 0) return { changed: false, source: cur, reason: "exists" };
    let last = -1;
    lines.forEach((l, i) => {
      if (BULLET_RE.test(l.replace(/\r$/, ""))) last = i;
    });
    if (last >= 0) lines.splice(last + 1, 0, `- ${text}`);
    else {
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (lines.length) lines.push("");
      lines.push(`- ${text}`, "");
    }
    return { changed: true, source: withBody(lines) };
  }
  if (op === "change") {
    const i = find(replaces);
    if (i < 0) return { changed: false, source: cur, reason: "missing" };
    if (find(text) >= 0 && norm(text) !== norm(replaces)) {
      lines.splice(i, 1);
      return { changed: true, source: withBody(lines) };
    }
    const m = BULLET_RE.exec(lines[i].replace(/\r$/, ""));
    lines[i] = lines[i].replace(/^([-*])\s+.+$/, `${m[1]} ${text}`);
    return { changed: norm(text) !== norm(replaces), source: withBody(lines) };
  }
  if (op === "remove") {
    const i = find(text);
    if (i < 0) return { changed: false, source: cur, reason: "missing" };
    lines.splice(i, 1);
    return { changed: true, source: withBody(lines) };
  }
  throw new Error(`applyBulletOp: unknown op "${op}"`);
}

/** Strip anything that must never reach a repository: refs, ids, quoted spans. */
export function repoSafeText(text) {
  return String(text ?? "")
    .replace(/\b(?:msg|part|commit|pr|page|file|url):\S+/gi, "")
    .replace(/\b(?:ses|msg|prt|d|n|b|c)_[A-Za-z0-9]{6,}\b/g, "")
    .replace(/["“”][^"“”]{1,300}["“”]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

const DDL = `
  CREATE TABLE IF NOT EXISTS curator_rules (
    slug TEXT NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, reason TEXT, cluster_id TEXT,
    applied_at INTEGER NOT NULL, rewrites INTEGER NOT NULL DEFAULT 0, decision_id TEXT,
    PRIMARY KEY (slug, hash)
  );
  CREATE TABLE IF NOT EXISTS curator_bullets (
    path TEXT NOT NULL, hash TEXT NOT NULL, slug TEXT NOT NULL, text TEXT NOT NULL, decision_id TEXT,
    PRIMARY KEY (path, hash, slug)
  );
`;

/** deps: store, state, now. */
export function createRulesStore({ store, state, now = Date.now } = {}) {
  state.migrate("curator-rules-1", DDL);
  const db = state.db;
  const path = (slug) => `projects/${slug}/rules.md`;

  async function read(slug) {
    const src = await store.read(path(slug));
    return src ? parseBullets(src).map((b) => b.text) : [];
  }

  // ---- tracking ----------------------------------------------------------------
  function track({ slug, text, reason = "", clusterId = null, decisionId = null, rewrites = 0 }) {
    db.prepare(
      `INSERT INTO curator_rules (slug, hash, text, reason, cluster_id, applied_at, rewrites, decision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug, hash) DO UPDATE SET text = excluded.text, reason = excluded.reason, cluster_id = COALESCE(excluded.cluster_id, curator_rules.cluster_id), applied_at = excluded.applied_at, rewrites = excluded.rewrites, decision_id = excluded.decision_id`,
    ).run(slug, bulletHash(text), text, String(reason).slice(0, 300), clusterId, now(), rewrites, decisionId);
  }
  const untrack = (slug, text) => db.prepare("DELETE FROM curator_rules WHERE slug = ? AND hash = ?").run(slug, bulletHash(text));
  const tracked = (slug) => db.prepare("SELECT * FROM curator_rules WHERE slug = ?").all(slug);
  const trackedWithCluster = () => db.prepare("SELECT * FROM curator_rules WHERE cluster_id IS NOT NULL").all();
  const trackedFor = (slug, text) => db.prepare("SELECT * FROM curator_rules WHERE slug = ? AND hash = ?").get(slug, bulletHash(text)) ?? null;
  // a cluster is "handled" while a rule tracks it, and for good once its rule was removed for not working
  const retireCluster = (clusterId) => state.kvSet(`rules.retired:${clusterId}`, "1");
  const clusterTracked = (clusterId) => db.prepare("SELECT 1 AS x FROM curator_rules WHERE cluster_id = ?").get(clusterId) != null || state.kvGet(`rules.retired:${clusterId}`) === "1";

  // ---- bullet origins (downgrade cleanup) ----------------------------------------
  const noteBullet = ({ path: p, text, slug, decisionId = null }) => db.prepare("INSERT OR REPLACE INTO curator_bullets (path, hash, slug, text, decision_id) VALUES (?, ?, ?, ?, ?)").run(p, bulletHash(text), slug, text, decisionId);
  const dropBullet = (p, text) => db.prepare("DELETE FROM curator_bullets WHERE path = ? AND hash = ?").run(p, bulletHash(text));
  const dropBulletFor = (p, text, slug) => db.prepare("DELETE FROM curator_bullets WHERE path = ? AND hash = ? AND slug = ?").run(p, bulletHash(text), slug);
  const bulletOrigins = (p) => db.prepare("SELECT hash, slug, text FROM curator_bullets WHERE path = ?").all(p);

  // ---- delivery state -----------------------------------------------------------
  const kvKey = (k, slug) => `rules.${k}:${slug}`;
  const viaBriefing = (slug) => state.kvGet(kvKey("viaBriefing", slug)) === "1";
  const setViaBriefing = (slug, v) => (v ? state.kvSet(kvKey("viaBriefing", slug), "1") : state.kvDelete(kvKey("viaBriefing", slug)));
  const getJson = (k, slug, fallback) => {
    try {
      return JSON.parse(state.kvGet(kvKey(k, slug)) ?? "null") ?? fallback;
    } catch {
      return fallback;
    }
  };
  const setJson = (k, slug, v) => (v === null || (Array.isArray(v) && v.length === 0) ? state.kvDelete(kvKey(k, slug)) : state.kvSet(kvKey(k, slug), JSON.stringify(v)));

  /**
   * What is handed to `repoWriter.applyRules`: each rule with its one-line reason, repo-safe. `[{rule, string}]`
   * (the pairs are kept so a hand edit of the block can be mapped back to the rules that produced it).
   */
  async function repoPairs(slug) {
    const list = await read(slug);
    return list.map((r) => {
      const t = trackedFor(slug, r);
      const reason = repoSafeText(t?.reason ?? "");
      const base = repoSafeText(r) || r;
      return { rule: r, string: reason ? `${base} — ${reason}` : base };
    });
  }
  const repoStrings = async (slug) => (await repoPairs(slug)).map((p) => p.string);

  /** Briefing part 1: the rules not delivered through the repository (box-only, or PR unmerged / write failed). */
  async function projectRulesForBriefing(slug, { repoRules } = {}) {
    if (repoRules !== "box-only" && !viaBriefing(slug)) return [];
    return read(slug);
  }

  return {
    path,
    read,
    track,
    untrack,
    tracked,
    trackedWithCluster,
    trackedFor,
    clusterTracked,
    retireCluster,
    noteBullet,
    dropBullet,
    dropBulletFor,
    bulletOrigins,
    viaBriefing,
    setViaBriefing,
    getJson,
    setJson,
    repoPairs,
    repoStrings,
    projectRulesForBriefing,
  };
}
