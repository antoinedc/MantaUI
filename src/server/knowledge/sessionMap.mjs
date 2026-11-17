// sessionMap.mjs — the session → project map (spec §3.1), in `state.sqlite`.
//
//   • Pinned at the session's FIRST prompt: the first `session.execution.started`
//     (or an explicit `pin()` from the prompt chokepoint) resolves the session's
//     directory at that moment. Background jobs are created under their parent and
//     then moved into a worktree, so creation time is too early.
//   • A later move updates the mapping only while the session has nothing captured
//     (`captured = 0`); after the first capture the mapping is never recomputed (a
//     removed worktree can't be resolved again).
//   • A `task` subagent child inherits its parent's mapping on
//     `session.created{parentID}`.
//   • A session with no mapping is `private` for every sharing decision (fail
//     closed) — callers use `get(id) === null` to mean that.
//   • Sessions Manta created for its own purposes (internal marker, the CTO
//     conversation, routine runs, curator/trial sessions) are never mapped.
//   • One-time, resumable history backfill: pass 1 maps sessions from their
//     recorded directory when it still resolves; pass 2 maps the rest through
//     opencode's own `project_id`, joined to a session of the same project that
//     did resolve. The rest stay unmapped.

import { isMarkedInternal } from "../internalSessionMarker.mjs";

/** Why a session must never be mapped / briefed / captured; null when it may be. */
export function sessionExclusion(session, { isCto = false } = {}) {
  if (isCto) return "cto-conversation";
  if (!session || typeof session !== "object") return null;
  if (isMarkedInternal(session)) return "internal";
  const m = session.metadata?.manta;
  if (m && typeof m === "object") {
    if (m.routineId) return "routine";
    if (m.knowledgeTrial || m.knowledgeCurator) return "curator";
  }
  return null;
}

/** Normalise a raw V2 event (`data`) or a lifecycle event (`properties`). */
export function normalizeSessionEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const d = ev.data ?? ev.properties ?? {};
  const sessionID = d.sessionID ?? d.info?.id;
  if (typeof sessionID !== "string" || sessionID === "") return null;
  let type = ev.type;
  if (type === "session.status" && d.status?.type === "busy") type = "session.execution.started";
  const parentID = d.parentID ?? d.info?.parentID;
  return { type, sessionID, parentID: typeof parentID === "string" && parentID ? parentID : null, directory: d.location?.directory ?? d.directory ?? null };
}

const REPIN_THROTTLE_MS = 60_000;

export function createSessionMap({ state, registry, getSession, isCtoSession, listSessionsPage, now = Date.now, log = console.warn } = {}) {
  const db = state.db;
  const get_ = db.prepare("SELECT * FROM session_project WHERE session_id = ?");
  const upsert = db.prepare(`INSERT INTO session_project (session_id, slug, canonical_id, directory, oc_project_id, parent_id, source, captured, pinned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(session_id) DO UPDATE SET slug = excluded.slug, canonical_id = excluded.canonical_id, directory = excluded.directory,
      oc_project_id = COALESCE(excluded.oc_project_id, oc_project_id), source = excluded.source, pinned_at = excluded.pinned_at`);
  const inflight = new Map();
  const lastCheck = new Map();

  const wire = (row) =>
    row
      ? { sessionID: row.session_id, slug: row.slug, canonicalId: row.canonical_id, directory: row.directory, source: row.source, captured: row.captured === 1, pinnedAt: row.pinned_at }
      : null;

  const get = (sessionID) => wire(get_.get(sessionID));

  async function excluded(sessionID, session) {
    let cto = false;
    try {
      cto = (await isCtoSession?.(sessionID)) === true;
    } catch {
      return "unknown"; // can't tell what kind of session this is → don't map it (a later prompt retries)
    }
    return sessionExclusion(session, { isCto: cto });
  }

  function serial(sessionID, fn) {
    const prev = inflight.get(sessionID) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    inflight.set(sessionID, run);
    const cleanup = () => {
      if (inflight.get(sessionID) === run) inflight.delete(sessionID);
    };
    run.then(cleanup, cleanup);
    return run;
  }

  /**
   * Pin (or, while nothing is captured, re-pin) a session from its directory.
   * Returns the mapping, or null when the directory cannot be resolved or the
   * session is excluded. `force` skips the re-pin throttle.
   */
  function pin({ sessionID, directory, ocProjectId = null, parentId = null, source = "prompt", session, force = false } = {}) {
    return serial(sessionID, async () => {
      const existing = get_.get(sessionID);
      if (existing && (existing.captured === 1 || existing.source.startsWith("backfill"))) return wire(existing);
      if (existing && !force && now() - (lastCheck.get(sessionID) ?? 0) < REPIN_THROTTLE_MS) return wire(existing);
      lastCheck.set(sessionID, now());
      if (lastCheck.size > 5000) lastCheck.delete(lastCheck.keys().next().value);

      let sess = session;
      if (!sess && getSession) {
        try {
          sess = await getSession(sessionID);
        } catch {
          sess = null;
        }
      }
      if (await excluded(sessionID, sess)) return null;
      const dir = directory ?? sess?.directory ?? null;
      if (!dir) return existing ? wire(existing) : null;
      if (existing && existing.directory === dir) return wire(existing);
      const id = await registry.identify(dir);
      if (!id) return existing ? wire(existing) : null;
      upsert.run(sessionID, id.slug, id.canonicalId, dir, ocProjectId ?? sess?.projectID ?? sess?.projectId ?? null, parentId ?? sess?.parentID ?? null, existing ? "move" : source, now());
      return get(sessionID);
    });
  }

  function inheritFromParent(childId, parentId) {
    return serial(childId, async () => {
      if (get_.get(childId)) return get(childId);
      const parent = get_.get(parentId);
      if (!parent) return null;
      upsert.run(childId, parent.slug, parent.canonical_id, parent.directory, parent.oc_project_id, parentId, "parent", now());
      return get(childId);
    });
  }

  function markCaptured(sessionID) {
    db.prepare("UPDATE session_project SET captured = 1 WHERE session_id = ?").run(sessionID);
  }

  /** Feed raw V2 events or lifecycle events; never throws. */
  async function observe(ev) {
    try {
      const n = normalizeSessionEvent(ev);
      if (!n) return;
      if (n.type === "session.created" && n.parentID) {
        await inheritFromParent(n.sessionID, n.parentID);
        return;
      }
      if (n.type === "session.execution.started") await pin({ sessionID: n.sessionID, directory: n.directory ?? undefined, source: "prompt" });
    } catch (e) {
      log("[knowledge] session map observe failed:", e?.message ?? e);
    }
  }

  const sessionsFor = (slug) => db.prepare("SELECT session_id FROM session_project WHERE slug = ?").all(slug).map((r) => r.session_id);
  function directoriesFor(slugs) {
    const out = new Set();
    for (const slug of slugs) for (const r of db.prepare("SELECT DISTINCT directory FROM session_project WHERE slug = ? AND directory IS NOT NULL").all(slug)) out.add(r.directory);
    return [...out];
  }
  const counts = () => Object.fromEntries(db.prepare("SELECT slug, COUNT(*) AS n FROM session_project GROUP BY slug").all().map((r) => [r.slug, r.n]));

  // ---- backfill ---------------------------------------------------------------
  const backfillDone = () => state.kvGet("backfill.done") === "1";

  async function backfillStep({ budgetMs = 2000, pageSize = 200, maxPages = Infinity } = {}) {
    if (backfillDone() || !listSessionsPage) return { done: backfillDone(), mapped: 0, scanned: 0 };
    const deadline = now() + budgetMs;
    let mapped = 0;
    let scanned = 0;
    let pagesDone = 0;
    while (now() < deadline && pagesDone++ < maxPages) {
      const pass = state.kvGet("backfill.pass", "1");
      const cursor = state.kvGet("backfill.cursor", "");
      if (pass === "1") {
        const rows = await listSessionsPage({ afterId: cursor, limit: pageSize });
        if (!rows || rows.length === 0) {
          state.kvSet("backfill.pass", "2");
          state.kvSet("backfill.cursor", "");
          continue;
        }
        for (const row of rows) {
          scanned++;
          if (get_.get(row.id)) continue;
          if (isMarkedInternal({ agent: row.agent, metadata: row.metadata }) || (await excluded(row.id, { metadata: row.metadata }))) continue;
          const id = row.directory ? await registry.identify(row.directory).catch(() => null) : null;
          if (id) {
            upsert.run(row.id, id.slug, id.canonicalId, row.directory, row.projectId ?? null, row.parentId ?? null, "backfill", now());
            mapped++;
          } else if (row.projectId) {
            db.prepare("INSERT OR IGNORE INTO backfill_unresolved (session_id, oc_project_id, directory) VALUES (?, ?, ?)").run(row.id, row.projectId, row.directory ?? null);
          }
        }
        state.kvSet("backfill.cursor", rows[rows.length - 1].id);
      } else {
        const rows = db.prepare("SELECT * FROM backfill_unresolved WHERE session_id > ? ORDER BY session_id LIMIT ?").all(cursor, pageSize);
        if (rows.length === 0) {
          state.kvSet("backfill.done", "1");
          return { done: true, mapped, scanned };
        }
        const bySlug = new Map(
          db
            .prepare("SELECT oc_project_id AS p, MIN(slug) AS slug, MIN(canonical_id) AS cid FROM session_project WHERE oc_project_id IS NOT NULL GROUP BY oc_project_id HAVING COUNT(DISTINCT slug) = 1")
            .all()
            .map((r) => [r.p, { slug: r.slug, canonicalId: r.cid }]),
        );
        for (const row of rows) {
          scanned++;
          const hit = bySlug.get(row.oc_project_id);
          if (hit && !get_.get(row.session_id)) {
            upsert.run(row.session_id, hit.slug, hit.canonicalId, row.directory, row.oc_project_id, null, "backfill-project", now());
            mapped++;
          }
          db.prepare("DELETE FROM backfill_unresolved WHERE session_id = ?").run(row.session_id);
        }
        state.kvSet("backfill.cursor", rows[rows.length - 1].session_id);
      }
      await new Promise((r) => setImmediate(r));
    }
    return { done: false, mapped, scanned };
  }

  return { get, pin, inheritFromParent, markCaptured, observe, observeRaw: observe, observeEvent: observe, sessionsFor, directoriesFor, counts, backfillStep, backfillDone };
}
