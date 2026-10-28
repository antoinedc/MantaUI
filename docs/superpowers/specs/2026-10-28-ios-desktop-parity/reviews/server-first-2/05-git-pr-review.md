# WS05 review — server-first-2

## Previous findings

1. **Resolved — header-like hunk content.** S.2 now uses `diff@9.0.0`'s `parsePatch`, then classifies hunk content by its first character only. Read-only execution of the actual published parser plus the specified counter walk confirmed the original `+++ heading` fixture produces `both:1, new:2, both:3`. Removed `--- a/old`, empty context, added `+++ /dev/null`, no-newline markers and offset multiple hunks also preserved the expected counters. Evidence: spec `05-git-pr-review.md:252-279,357-373`; published `diff@9.0.0/libesm/patch/parse.js`, `parseHunk`.
2. **Resolved for non-null mutation responses — placement preservation.** S.2 now pins id-based reconciliation, tapped-row placement for the added id, deletion and refetch on unexpected changes. Both clients have helper tests; neither re-derives coordinates. Evidence: spec `:314-333,399,1046-1051,1088-1093`. One newly introduced nullable-response gap remains below.
3. **Resolved — tool-output line numbers.** S.5 explicitly retains numbers through `diffLineNumbers`, uses the same library parser, separates presentation from review anchors, and requires rendered multi-hunk/header-like-content regressions. Bare hunks were accepted in the live parser probe. Evidence: spec `:395-396`.
4. **Resolved — inbox tone mapping.** The explicit `danger → error`, `warn → warn`, `muted/unknown → idle` mapping matches `StatusDot`; rendered colour assertions are required. Evidence: spec `:397,400`; `src/renderer/StatusDot.tsx:15-33`.
5. **Resolved — mount/probe bookkeeping.** §9 names `rpc.mjs` and `boxCapabilities.mjs` plus its test separately; §10 no longer consumes the client probe. Evidence: spec `:1345-1346,1360-1363`; master canonical registration rows C1/C2.

Dependency ownership agrees with the master: WS07 adds `lru-cache@11.5.3` in wave B and WS05 adds `diff@9.0.0` in wave C (`00-master.md:539,635,643`). The published LRU package exposes the specified named ESM API and supports the box's Node runtime. Capability ids/accessors remain aligned with D25.

## New findings

1. **BLOCKING — S.2 / D.2: parser failure is indistinguishable from an empty diff in the specified client state machine.**
   - **Problem:** The new catch sets `files: []` and a non-null `message`, while the legacy `error` field remains unchanged. A successful forge fetch has `error: null`. D.2 only enters the error UI when `error` is set; otherwise empty files display “No diff.” Thus malformed input that the new dependency rejects silently looks like a PR with no changes. S.5 likewise only says to display messages for errors, not to treat a standalone parsing message as an error. Returning the raw threads/draft does not define how their placements remain visible when there are no files.
   - **Evidence:** spec `05-git-pr-review.md:261-265,291-292,394,1016-1025`; `src/server/forge/index.mjs:1248-1272` returns `error: null` on successful diff reads. Actual `parsePatch` execution throws for a hunk declaring two old/three new lines but containing only ` first` and `+new`.
   - **Concrete fix:** Pin an additive parsing-failure signal and its UI precedence, or explicitly define non-null diff `message` as a failure even with `error: null`. Both clients must show “Couldn't read this diff.” before the empty state, with Retry/Open on GitHub. Preserve comments in an unplaced section or explicitly defined retained snapshot; do not silently discard them. Add server and client fixtures for successful forge fetch + parser failure, asserting the message is visible and “No diff.” is absent. Keep old fields compatible.

2. **SHOULD — S.2: reverse jsdiff's zero-length-range normalization when rebuilding hunk header text.**
   - **Problem:** `parsePatch` increments a range's start when its length is zero. The specified direct reconstruction from `oldStart/oldLines/newStart/newLines` therefore displays the wrong header for insertions/deletions. The content-row counter walk is correct; only the reconstructed hunk label needs denormalization.
   - **Evidence:** spec `05-git-pr-review.md:269-272`; published `diff@9.0.0/libesm/patch/parse.js`, `parseHunk`, explicitly performs `oldStart += 1` / `newStart += 1` for zero counts. The live probe of `@@ -0,0 +1 @@ section` returned `{oldStart:1, oldLines:0, newStart:1, newLines:1}`. Direct formatting would show `-1,0`, not `-0,0`. The parser also does not retain `section`; the spec's “any section heading parsePatch keeps” correctly avoids promising one.
   - **Concrete fix:** For header text only, subtract one from the corresponding start when its count is zero; keep row counters initialized from the normalized starts. Require insertion-only and deletion-only fixtures asserting both header text and commentable row numbers.

3. **SHOULD — S.2 / D.2: handle a successful mutation returning `draft: null`.**
   - **Problem:** The new Swift reconciliation contract requires `response: GitDraft` and always returns a non-null placed draft, while D.2 sends Remove through that helper. The existing delete endpoint can return `{ok:true, draft:null}` when another client has already submitted/cleared the draft. Without an explicit branch, the implementation must invent a placeholder, retain stale comments, or force an optional into a non-optional helper.
   - **Evidence:** spec `05-git-pr-review.md:328-333,1046-1051`; `src/server/forge/draft.mjs:177-196` returns the nullable draft when absent; `src/server/forge/index.mjs:1363-1366` forwards it unchanged.
   - **Concrete fix:** Allow a nullable response/result in the helper, or specify a caller-level null branch that clears the placed draft and pending bar without failure. Test a draft loaded on this client, cleared by another client, followed by a successful Remove returning null on both desktop and iOS.

Verification was read-only: published parser executed in memory, no dependency installation or implementation edits. This validates the proposed parser contract, not an implementation that has yet to be built.

Counts: BLOCKING 1 · SHOULD 2 · NIT 0.

VERDICT: CHANGES REQUIRED
