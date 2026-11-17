// changes.mjs — the Recent-changes log (spec §8, §11.6): every applied decision
// (newest first) with what, why and where, plus skipped/waiting items. Stored in
// `state.sqlite` (`changes`); the undo itself is performed by the curator layer
// (an injected `undo(change)`), this module only owns the record and its state.
//
// Wire item (`knowledge:changes`): {id, at, kind, summary, reason, area, slug?,
// undoable, undoneAt?, error?}
//   kind: "applied" (a decision landed) | "skipped" (a decision was refused: bar,
//         secret, conflict) | "waiting" (cap reached, no capable model) | "dropped"
//         (queue overflow) | "outward" (a repository write / PR) | "undo" (an undo
//         that ran) | "import" (blackboard import) | "notice" (anything else)
// Internal fields kept beside the wire item: commitSha, decisionId, batchId, data.

import { newChangeId } from "./ids.mjs";

export const CHANGE_KINDS = Object.freeze(["applied", "skipped", "waiting", "dropped", "outward", "undo", "import", "notice"]);

const wire = (r) => {
  const out = { id: r.id, at: r.at, kind: r.kind, summary: r.summary, reason: r.reason ?? "", area: r.area ?? null, undoable: r.undoable === 1 && r.undone_at == null };
  if (r.slug) out.slug = r.slug;
  if (r.undone_at != null) out.undoneAt = r.undone_at;
  if (r.error) out.error = r.error;
  return out;
};
const full = (r) => ({ ...wire(r), commitSha: r.commit_sha ?? null, decisionId: r.decision_id ?? null, batchId: r.batch_id ?? null, data: r.data ? JSON.parse(r.data) : null });

export function createChangeLog({ state, now = Date.now } = {}) {
  const db = state.db;
  return {
    /** Append a record; returns its id. */
    add({ kind = "notice", summary, reason = "", area = null, slug = null, undoable = false, commitSha = null, decisionId = null, batchId = null, data = null } = {}) {
      const t = now();
      const id = newChangeId(t);
      db.prepare("INSERT INTO changes (id, at, kind, summary, reason, area, slug, undoable, commit_sha, decision_id, batch_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        t,
        CHANGE_KINDS.includes(kind) ? kind : "notice",
        String(summary ?? "").slice(0, 300),
        String(reason ?? "").slice(0, 600),
        area,
        slug,
        undoable ? 1 : 0,
        commitSha,
        decisionId,
        batchId,
        data == null ? null : JSON.stringify(data),
      );
      return id;
    },
    /** Newest first. `cursor` is the `nextCursor` of the previous page. */
    list({ cursor, limit = 50 } = {}) {
      const lim = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 50));
      const before = cursor === undefined || cursor === null || cursor === "" ? Number.MAX_SAFE_INTEGER : Number(cursor);
      const rows = db.prepare("SELECT * FROM changes WHERE seq < ? ORDER BY seq DESC LIMIT ?").all(Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER, lim + 1);
      const page = rows.slice(0, lim);
      return { items: page.map(wire), nextCursor: rows.length > lim ? String(page[page.length - 1].seq) : null };
    },
    get(id) {
      const r = db.prepare("SELECT * FROM changes WHERE id = ?").get(id);
      return r ? full(r) : null;
    },
    markUndone(id) {
      db.prepare("UPDATE changes SET undone_at = ?, error = NULL WHERE id = ?").run(now(), id);
    },
    setError(id, error) {
      db.prepare("UPDATE changes SET error = ? WHERE id = ?").run(String(error ?? "").slice(0, 300), id);
    },
    /** Counts since `sinceMs` per kind (the weekly summary notification). */
    countsSince(sinceMs) {
      return Object.fromEntries(db.prepare("SELECT kind, COUNT(*) AS n FROM changes WHERE at >= ? GROUP BY kind").all(sinceMs).map((r) => [r.kind, r.n]));
    },
    prune(keepMs = 180 * 24 * 3600 * 1000) {
      db.prepare("DELETE FROM changes WHERE at < ?").run(now() - keepMs);
    },
  };
}
