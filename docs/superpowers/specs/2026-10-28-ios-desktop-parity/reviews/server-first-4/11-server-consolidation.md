# WS11 server-first-4 — confirmation review

Confirmed the four server-first-3 responses against the revised normative contracts, tests, receiving-path tables and master registry. This is specification approval, not implementation/build certification; no builds or tests were run.

1. **Resolved — visible synthetic-result classification.** D11 now classifies the mapped transcript outcome, distinguishes visible subagent results from dropped synthetics, and uses the buffered lookup for insufficient mapping data. Live/canonical boundary behavior and canonical-only result-row placement are explicit. Test (6b) covers the native synthetic result separately from transparent legacy completion messages. This matches `mapTimeline` / `mapBackgroundResult` in `src/shared/opencodeV2.mjs`.

2. **Resolved — provisional boundary repair.** D11 now specifies server-side canonical rebuilding, buffered event replay, replacement of membership and summaries, generation advancement, retired-id deletion and late-result invalidation. Run and part annotations carry the generation; both clients reject stale membership and refetch. Test (6c) checks the repair through subsequent single-message fetches and tool updates, with corresponding client regression cases. The former promise of canonical repair now has an explicit mechanism.

3. **Resolved — wave-D epoch plumbing.** D11 explicitly assigns the top-level `runningSet` receiving path, payload fields, persistent connection state and request-generation capture to WS11. M-11-4/11/12 identify the receiving edits. Receiver-level tests cover actual routing, reconnect, late RPC completion and a chat opened after the snapshot. No new work is assumed from or reassigned to the in-flight WS02 implementation.

4. **Resolved — cross-cutting registry reconciliation.** The master now lists both `apiVersion()` members, labeled close signatures, the D8-qualified truncation-factory replacement and D22's media reset in M-09-4. WS11 D6 uses the labeled signatures and the response section acknowledges the cross-cutting report. Existing B contracts and IB ownership remain intact. Cross-cutting S2 was already resolved by the corrected allocation test.

No remaining findings within this confirmation scope.

**Counts:** 0 BLOCKING · 0 SHOULD · 0 NIT

VERDICT: APPROVE
