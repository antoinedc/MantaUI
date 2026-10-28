You are drafting ONE workstream spec for porting desktop features to the native iOS app in the MantaUI repo. Work ONLY in the worktree /home/dev/projects/better-ui-ios-parity (do NOT touch /home/dev/projects/better-ui). Read-only research everywhere; the ONLY file you write is docs/superpowers/specs/2026-10-28-ios-desktop-parity/<ID>.md. Use bash (grep -rn, sed -n, ls) and read tools; do not run builds.

First read: docs/superpowers/specs/2026-10-28-ios-desktop-parity/00-master.md (the master spec — its ground rules, shared contracts C1–C7, file ownership table and waves are binding; your spec must respect your workstream's file ownership and route any mount in a non-owned file through "Mount requests"), mobile/native/AGENTS.md, and skim docs/mobile-redesign/DECISIONS.md for relevant decisions.

For EACH feature in your scope, research and specify:
1. Desktop behaviour today: what the user sees/does, edge cases, copy strings — cite desktop files (src/renderer/...) and line numbers.
2. Wire contract: the exact /rpc channel(s) or /api route(s) the desktop uses, args and response shape, errors — verified against src/renderer/api/httpApi.ts, src/shared/api.ts and the server handler (src/server/rpc.mjs, index.mjs, the module). Also the /events frames involved (src/server/streamInterp.mjs). If something is Electron-local (preload/OS bridge) say so and specify a minimal new server route (own module, full contract) OR an iOS-native equivalent, OR propose deferring with reason.
3. iOS design: where it lives (existing Swift files to edit within your ownership, new files with names), native idioms, states (loading/empty/error/success feedback — no dead controls), copy. Note what iOS already has (cite Swift files/lines) so the implementer doesn't duplicate.
4. Pure logic to extract + the XCTest cases to add (file MantaUITests/<Area>Tests.swift), plus node tests for any server change.
5. Acceptance criteria (checkable bullets).

Also include sections: "Files" (edit / create, all within ownership), "Mount requests" (exact mounts needed in files owned by other workstreams, if any), "Contracts provided / consumed" (referencing C1–C7), "Deferred" (with reasons), "Open questions" (only genuinely undecidable ones; propose a default for each).

Be concrete and verified — every channel name, field and file path must exist in the code (or be explicitly marked NEW). Keep it implementable by a mid-level engineer with no other context. Plain language for behaviour; precise identifiers in contract sections. When done, reply with ONLY: path written, feature count, any new server routes, open questions (one line each).
