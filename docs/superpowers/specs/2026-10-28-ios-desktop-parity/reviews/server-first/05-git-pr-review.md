# WS05 review — server-first

The four capability ids and their accessor/registration ownership agree with master D25 and its capability registry. The existing merge snapshot, branch-keyed preview, read-only composer bridge and shared sign-in ownership remain specified. The additive forge response approach and same-workstream desktop migration are consistent with D23–D24. Findings below concern the revised contracts and migration seams.

1. **BLOCKING — S.2: copying the existing diff parser's rules produces incorrect review anchors for valid diff content.**
   - **Problem:** S.2 requires the rules of `commentableLines`, including dropping `+++ ` / `--- ` lines as preamble. That implementation recognizes those prefixes even *inside a hunk*. A newly added source line `++ heading` is encoded as `+++ heading`: it is discarded and the new-line counter never advances. The following context line is then assigned the preceding line number. Both clients would display incomplete code and submit comments at the wrong location.
   - **Evidence:** spec `05-git-pr-review.md:248-252`; `src/renderer/chatUtils.ts:4454-4492` (header recognition precedes hunk-content handling). Read-only execution of the extracted current function with `@@ -1,2 +1,3 @@`, ` first`, `+++ heading`, ` last` returned anchors `both:1, both:2`; the correct anchors are `both:1, new:2, both:3`. The same issue affects removed content beginning `-- `.
   - **Fix:** Specify hunk-aware parsing: interpret file headers outside active hunk content, consume old/new counts from the hunk header, and treat any in-hunk `+`/`-` prefix as content regardless of the following characters. Require node fixtures for added `++ heading`, removed `-- heading`, and content resembling file headers; assert rows, both counters, anchors and subsequent thread placement. Do not port this particular existing bug verbatim.

2. **SHOULD — S.2 / S.5 / D.2: define placement preservation after every draft mutation.**
   - **Problem:** Placement is attached only by `forge:diff`, while add/delete/set-verdict still return a complete raw draft. The spec describes where to put a newly added comment but does not say how existing comments retain their placements when that raw draft replaces the placed one. Following the existing desktop mutation pattern loses all pre-existing placements on a verdict change or removal; reimplementing coordinate matching in the clients would violate D23.
   - **Evidence:** spec `05-git-pr-review.md:280-287,336`; `src/server/forge/index.mjs:1352-1374` returns store drafts unchanged; `src/server/forge/draft.mjs:145-174` stores anchors, not placements; `src/renderer/ReviewPane.tsx:185-202,232-249` replaces draft state with mutation responses.
   - **Fix:** Pin one client reconciliation rule for both clients: preserve placements by stable comment id within the current diff snapshot, retain the tapped placement for a new id, remove deleted ids, and refresh through `forge:diff` for unknown ids or a changed snapshot. Alternatively, refetch the full placed response after every successful mutation. Add desktop and iOS store tests with two existing placed comments followed by add, delete and set-verdict; verify no surviving comment disappears or moves to an arbitrary section.

3. **SHOULD — S.5: preserve ordinary tool-output diff line numbers when removing `commentableLines`.**
   - **Problem:** The migration says tool-output diffs need no anchors and removes their anchor producer, but that producer also supplies every displayed line number. Simply removing the review-only props does not account for this remaining consumer. The implementation otherwise has to guess whether to remove numbers or recreate the parser locally.
   - **Evidence:** spec `05-git-pr-review.md:332,337`; `src/renderer/ToolBodies.tsx:335-341,426-432` derives `ln` from `anchors[ci]` even when no gutter or notes were supplied.
   - **Fix:** Explicitly specify how non-review `UnifiedDiff` retains its existing line-number presentation and the permitted ownership of that presentation logic. If this requires a new box-provided tool-diff field, ledger its producer and consumer rather than silently leaving a second review parser. Add a rendered tool-output regression fixture spanning multiple hunks, asserting old numbers on removals and new numbers on additions/context after the migration.

4. **SHOULD — S.1 / S.5: map inbox wire tones to the existing desktop status-dot vocabulary.**
   - **Problem:** The new inbox wire tone is `danger|warn|muted`, but the existing `StatusDot` accepts `error|warn|idle` for these states. Deleting `dotTone` and passing `item.tone` directly either fails typechecking or paints failures grey if cast through the type error. The spec should distinguish server semantic tone from component presentation mapping.
   - **Evidence:** spec `05-git-pr-review.md:233-240,338`; `src/renderer/InboxPalette.tsx:38-47`; `src/renderer/StatusDot.tsx:15-33` accepts `ok|running|error|warn|idle` and falls back to grey for unknown values.
   - **Fix:** Pin the trivial presentation mapping `danger → error`, `warn → warn`, `muted/unknown → idle` at the inbox row, or choose an explicitly compatible wire vocabulary. Assert the failed-check row renders a red status dot in the new vitest fixture, not merely that its label is present.

5. **NIT — §9 / §10: remove stale server-mount and probe-consumer entries.**
   - **Problem:** §9 still lists `rpc.mjs, index.mjs` as the receiving files for M-05-srv-1/2, although S.3, §8 and the master now correctly assign the second mount to `boxCapabilities.mjs` and its test. §10 still lists WS04's `forgeProbe()` as consumed, although §12 correctly says WS05 no longer calls it.
   - **Evidence:** spec `05-git-pr-review.md:293-295,1243-1244,1256-1260,1316-1321`; master `00-master.md:588-589`.
   - **Fix:** Make §9 match the canonical registrations and remove `forgeProbe` from §10's consumed client members. The server's injected `local.forgeProbe` remains part of M-05-srv-1.

Counts: BLOCKING 1 · SHOULD 3 · NIT 1.

VERDICT: CHANGES REQUIRED
