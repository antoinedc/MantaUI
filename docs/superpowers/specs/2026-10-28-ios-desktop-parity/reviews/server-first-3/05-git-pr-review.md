# WS05 review — server-first-3

Confirmation-only review of the three server-first-2 findings.

1. **Resolved — parser failures are visible.** S.2 adds `parseFailed`, preserves the legacy fetch `error`, and explicitly prioritizes parsing failure over the empty state on both clients. All threads and draft comments remain actionable in “Other comments”; Retry and Open on GitHub are specified. Server, desktop and iOS tests cover a successful fetch followed by a parse failure and assert that “No diff.” is absent. Evidence: `05-git-pr-review.md:261-275,318,379-402,418-428,1045-1053,1127-1130`.

2. **Resolved — zero-length hunk headers.** Header formatting subtracts one only for a zero-count range; content-row counters retain jsdiff's normalized starts. This matches the `diff@9.0.0` behavior verified in the preceding round. Insertion-only and deletion-only fixtures assert both header text and row numbers. The first-character-only content mapping and header-like-line regression cases remain intact. Evidence: `05-git-pr-review.md:279-298,384-395`.

3. **Resolved — nullable mutation drafts.** The reconciliation helper now accepts and returns an optional draft. A successful null response clears draft cards and the pending bar without error or refetch, matching the existing server delete contract. Both clients have regression coverage for a draft cleared by another client before Remove completes. Evidence: `05-git-pr-review.md:344-353,423,428,1126-1133`; `src/server/forge/draft.mjs:177-196`.

No new findings in these revisions. This confirms the spec contracts and required tests; it does not claim the implementation or tests have been built or run.

Counts: BLOCKING 0 · SHOULD 0 · NIT 0.

VERDICT: APPROVE
