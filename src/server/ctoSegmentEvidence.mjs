// Bounded source evidence, scoped to the closed segment, not the latest turn.
export function readSegmentEvidence(db, { sessionID, start, end }) {
  if (!db || !sessionID || !Number.isFinite(start) || !Number.isFinite(end)) return "";
  const rows = db.prepare(`
    SELECT p.id, json_extract(m.data, '$.role') AS role,
      json_extract(p.data, '$.type') AS type,
      substr(json_extract(p.data, '$.text'), 1, 1000) AS text,
      json_extract(p.data, '$.tool') AS tool,
      json_extract(p.data, '$.state.status') AS status,
      substr(json_extract(p.data, '$.state.output'), 1, 1000) AS output
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.session_id = ? AND p.time_created >= ? AND p.time_created <= ?
      AND json_extract(p.data, '$.type') IN ('text', 'tool')
    ORDER BY p.time_created DESC, p.id DESC LIMIT 40
  `).all(sessionID, start, end);
  return rows.reverse().map((r) => JSON.stringify(r)).join("\n").slice(-6000);
}
