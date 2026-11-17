// backfillSource.mjs — the default page reader for the history backfill: opencode's
// own `session_v2` table, read-only through the shared handle (`opencodeDb.getDb`).
//
// One page is a keyset slice (`id > afterId ORDER BY id LIMIT n`) of a few columns of
// the primary-key index — milliseconds even on the 34 GB history — and the
// backfill yields to the event loop between pages and stops at a time budget, so it
// never holds the main thread (spec §3.1: background, resumable).
//
// Rows carry what the mapper needs to EXCLUDE a session (`metadata`, `title`, `agent`, and `internal` = listed in the
// internal-session registry) and its creation time (`createdAt`, for the pre-upgrade boundary). `createdBefore`
// narrows the page to sessions created before that time.

import { getDb } from "../opencodeDb.mjs";

const parseMeta = (raw) => {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

async function defaultInternalIds() {
  const { internalSessionIds } = await import("../internalSessions.mjs");
  return internalSessionIds();
}

export async function listSessionsPage({ afterId = "", limit = 200, createdBefore, db: dbIn, internalIds = defaultInternalIds } = {}) {
  const db = dbIn ?? (await getDb());
  if (!db) throw Object.assign(new Error("opencode.db is not readable yet"), { code: "no_db" });
  const before = Number.isFinite(createdBefore) ? Math.trunc(createdBefore) : Number.MAX_SAFE_INTEGER;
  const rows = db
    .prepare(
      "SELECT id, project_id AS projectId, parent_id AS parentId, directory, agent, title, metadata, time_created AS createdAt FROM session_v2 WHERE id > ? AND time_created < ? ORDER BY id LIMIT ?",
    )
    .all(String(afterId ?? ""), before, Math.max(1, Math.min(1000, limit)));
  // A failed registry read fails the page (the backfill retries it later) rather than mapping an internal session.
  const internal = rows.length ? await internalIds() : new Set();
  return rows.map((r) => ({
    id: String(r.id),
    projectId: r.projectId == null ? null : String(r.projectId),
    parentId: r.parentId == null ? null : String(r.parentId),
    directory: r.directory ?? null,
    agent: r.agent ?? null,
    title: r.title ?? null,
    metadata: parseMeta(r.metadata),
    createdAt: typeof r.createdAt === "number" ? r.createdAt : null,
    internal: internal.has(String(r.id)),
  }));
}
