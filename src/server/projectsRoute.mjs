// GET /api/projects handler — extracted from index.mjs so the real route
// logic is unit-testable without a live HTTP server (mirrors the peek.mjs
// extraction; the BET-1454 review left the safe-error contract unpinned and
// BET-1458 characterization drives THIS module, not a re-implemented mock).
// The tmux dependency is injected so a test can force the listing to fail.

export function createProjectsHandler({ listProjects }) {
  return async function handleProjects(_req, res) {
    try {
      const projects = await listProjects();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(projects));
    } catch (e) {
      // BET-1454: never forward raw tmux stderr to a client-facing body —
      // the desktop chat panel renders `error` verbatim in a banner. Log the
      // fault server-side and return a safe, human message instead.
      console.warn("[api/projects] tmux listing failed:", e?.message ?? e);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Couldn't reach tmux on the box." }));
    }
  };
}
