# Server-first round 2 — 06-search

## Previous findings

1. **Resolved — initial topology failure.** Q1 now specifies `projectsFromSyncState`, rechecks `everSucceeded()` after the swallowed refresh failure, and returns degraded rather than searching an incomplete scope. This matches the actual failure behavior in `src/server/syncState.mjs:58–95`. The spec separately pins genuinely empty and stale last-known-good snapshots, with real-sync-state tests 13–16 (`06-search.md:198–233,373–391`). M-06-srv-1 includes the helper import and invocation; the master ledger agrees (`00-master.md:588`).

2. **Resolved — palette dismissing failed navigation feedback.** The shared shell now has an explicit backward-compatible `false` veto, and SearchPalette propagates it (`06-search.md:428–450`). Tests cover both mouse and Enter past the close timer, plus successful dismissal. Existing Sidebar and InboxPalette callbacks return void (`src/renderer/Sidebar.tsx:1605–1612`, `src/renderer/InboxPalette.tsx:316–319`), so their behavior is preserved. The master ownership table includes the shared shell and its test under WS06 (`00-master.md:629`); no other wave-B spec claims these files.

3. **Resolved — duplicated label policy.** Q2 makes the server label authoritative, including partial-label fallback. Desktop removes its workspace breadcrumb composition; iOS consumes the same label. Both clients have fixtures asserting supplied labels take precedence over their component fields (`06-search.md:242–245,417–421,462–465,730–733`).

4. **Resolved — legacy compatibility.** Legacy scope, primary inference and explicit caps are pinned independently of label enrichment. Missing or failing enrichment preserves hits without degraded status (`06-search.md:187–196`). Tests 9/9a–9c cover absent, failing and successful dependencies plus cap overrides. The unchanged CTO caller's `{query, sessionIds}` input and consumption of flat hits remain supported (`src/server/cto.mjs:398–412`).

## New-problem and integration checks

- The new adapter is an explicit dependency at the existing RPC handler; no additional channel or route is introduced.
- Capability registration and the missing-`groups` old-box probe remain consistent with D25, without a second accessor or client-side fallback scope/grouping implementation.
- M-06-srv-1/2, M-06-dsk-1/2 and the Swift mounts retain the canonical integration order and signatures. Shared-shell ownership is now expressly authorized.
- The revisions introduce no new blocking or advisory findings.

BLOCKING: 0; SHOULD: 0; NIT: 0.

VERDICT: APPROVE
