import { PART_SQL } from "./opencodeDb.mjs";

// Bounded source evidence, scoped to the closed segment, not the latest turn.
// Reads the V2 store through PART_SQL (opencodeDb.mjs): text and tool parts of
// the segment's messages, newest 40, in the V1-shaped part JSON.
export function readSegmentEvidence(db, { sessionID, start, end }) {
  if (!db || !sessionID || !Number.isFinite(start) || !Number.isFinite(end)) return "";
  const rows = db.prepare(`
    SELECT p.id, p.role AS role,
      json_extract(p.data, '$.type') AS type,
      substr(json_extract(p.data, '$.text'), 1, 1000) AS text,
      json_extract(p.data, '$.tool') AS tool,
      json_extract(p.data, '$.state.status') AS status,
      substr(json_extract(p.data, '$.state.output'), 1, 1000) AS output
    FROM ${PART_SQL} p
    WHERE p.session_id = ? AND p.time_created >= ? AND p.time_created <= ?
      AND json_extract(p.data, '$.type') IN ('text', 'tool')
    ORDER BY p.time_created DESC, p.id DESC LIMIT 40
  `).all(sessionID, start, end);
  return rows.reverse().map((r) => JSON.stringify(r)).join("\n").slice(-6000);
}
