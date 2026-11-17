// backfillSource.mjs — the default page reader for the history backfill: opencode's
// own `session_v2` table, read-only through the shared handle (`opencodeDb.getDb`).
//
// One page is a keyset slice (`id > afterId ORDER BY id LIMIT n`) of a few columns of
// the primary-key index — milliseconds even on the 34 GB history — and the
// backfill yields to the event loop between pages and stops at a time budget, so it
// never holds the main thread (spec §3.1: background, resumable).

import { getDb } from "../opencodeDb.mjs";

export async function listSessionsPage({ afterId = "", limit = 200 } = {}) {
  const db = await getDb();
  if (!db) throw Object.assign(new Error("opencode.db is not readable yet"), { code: "no_db" });
  const rows = db
    .prepare("SELECT id, project_id AS projectId, parent_id AS parentId, directory, agent FROM session_v2 WHERE id > ? ORDER BY id LIMIT ?")
    .all(String(afterId ?? ""), Math.max(1, Math.min(1000, limit)));
  return rows.map((r) => ({ id: String(r.id), projectId: r.projectId == null ? null : String(r.projectId), parentId: r.parentId == null ? null : String(r.parentId), directory: r.directory ?? null, agent: r.agent ?? null }));
}
