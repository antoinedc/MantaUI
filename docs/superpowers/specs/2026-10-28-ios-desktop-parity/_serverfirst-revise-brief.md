Server-first revision of your workstream spec (worktree /home/dev/projects/better-ui-ios-parity; edit ONLY your own spec file).

The user directed that the box server owns logic and the clients are presentation layers. Read, in this folder:
- `00-master.md` decisions **D23** and **D24** (binding; D24 supersedes D7 for MOVE-NOW items).
- `server-first-audit.md` — every row whose recommendation is MOVE-NOW and whose work unit names YOUR spec.

Revise your spec so that each of those MOVE-NOW items is computed on the server:
1. Add a section "## Server-first (D23/D24)" listing each audit item id → the new or extended server module (`src/server/<name>.mjs`), the `/rpc` channel or `/events` frame field, the exact request/response JSON shape, errors, and the node tests (`src/server/<name>.test.mjs`) that pin it.
2. Rewrite the affected iOS sections to RENDER the server result (delete the client-side derivation from your plan; keep only view state/gestures/presentational formatting).
3. Specify the DESKTOP migration for the same logic: which `src/renderer/**` / `src/shared/**` code is deleted or replaced, which component now consumes the new channel/field, and the vitest updates. The desktop must not keep a parallel implementation.
4. Wire compat per D24: additive only; name the capability flag the client checks and the "Update your box to use this" behaviour.
5. Update "Files" (now including server + desktop files), "Client members", "Mount requests"/"Mounts applied", and add rows for server registrations in `rpc.mjs` / `index.mjs` / `streamInterp.mjs` as mounts applied by the wave integration agent (D24 order) — never edit those three files yourself unless you are the sole worker of your wave (WS05 in wave C).
6. Keep everything else in your spec intact. Append "## Review responses (server-first)" summarising the changes.

Be concrete and verified against the code. Reply with only: path, audit items folded (ids), new channels/frames, desktop files changed, any audit item you rejected (with evidence).
