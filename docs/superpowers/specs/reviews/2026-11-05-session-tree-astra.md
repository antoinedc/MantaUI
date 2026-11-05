# Astra spec review — the session tree

## Round 1 (spec r1)

1. **BLOCKING — The legacy parent field would hide nested rows**
   - **Evidence:** §3 specifies the nearest windowed ancestor. Existing `computeJobNesting` returns the **top-level** ancestor (`src/server/sessionStatus.mjs:41–54`). Desktop hides every child, then renders children only beneath top-level rows (`src/renderer/Sidebar.tsx:378–391, 874–907`). For A → B → C, returning B for C makes C disappear.
   - **Exact change:** Specify `parentWindowIndex` as the top-level **legacy-visible** window ancestor, within the same project. Add a three-window regression test; distinguish this projection from the tree's immediate parent.

2. **BLOCKING — Linger postpones flapping rather than removing it**
   - **Evidence:** §2 removes idle virtual ancestors after 30 seconds and chooses the nearest *shown* ancestor. A windowless root P with an active child C therefore disappears after 30 seconds, promotes C to root, then reappears above C on P's next turn. Ordering by depth/start time introduces further movement. Existing nesting orders children by window index (`src/server/sessionStatus.mjs:54`).
   - **Exact change:** Retain required ancestor nodes while any visible descendant exists. Define stable sibling ordering independent of turn starts, visibility and window materialization. Test a parent idle for longer than `LINGER_MS` while its child remains active. Replace "no nesting churn" with explicit stable-placement assertions.

3. **BLOCKING — Job-record parents are not uniformly authoritative ancestry**
   - **Evidence:** Adopted records store the resolved **display ancestor** in `parentSessionID`, while preserving the actual parent separately in `sessionParentID` (`src/server/delegate.mjs:684, 710, 1550–1551`). Also, `repointJobSessions` changes both parent and child IDs (`src/server/delegate.mjs:2723–2738`), contradicting §1's "field never changes."
   - **Exact change:** Define edges by record origin: Manta-owned launch parent versus adopted session's authoritative `parentID`/`sessionParentID`. Exclude superseded records and select the current attempt deterministically. Correct the immutability claim and specify normalization of retained legacy records.

4. **BLOCKING — Stage (a) cannot independently fix the motivating case**
   - **Evidence:** The Problem explicitly attributes the orchestrator relationship to transcript inference. Stage (a) removes that inference, but explicit links arrive only in (c). The existing resolver's transcript fallback is real (`src/server/delegate.mjs:868–912`); opencode ancestry cannot reconstruct an absent edge.
   - **Exact change:** Make the smallest first PR a server-only stable ancestor projection plus an explicit replacement for missing driver edges. Ship link creation/migration before bypassing transcript-derived relationships, or explicitly retain already-established relationships during transition. Add the actual windowless, externally driven parent scenario to stage (a)'s acceptance tests.

5. **BLOCKING — Adoption retirement is not an additive compatibility change**
   - **Evidence:** Old desktop and iOS consume `windows`, not `tree` (`src/renderer/Sidebar.tsx:378–391`; `mobile/native/MantaUI/SessionModels.swift:227–241`). Removing adoption windows removes their rows/counts regardless of retained `parentWindowIndex`. Same-major older clients remain compatible (`src/shared/compatibility.mjs:142–155`).
   - **Exact change:** Specify a capability-gated rollout or compatibility-version boundary before retiring windows. New clients must explicitly fall back when `tree` is absent. Test both version directions. "Both clients have shipped" is insufficient because installed clients can remain old.

6. **BLOCKING — Materialized windows can still be closed by job completion**
   - **Evidence:** Cleanup closes even a job with **no worktree** (`src/server/delegate.mjs:2970–2973`), including subagent records. Adoption also reuses existing windows (`src/server/delegate.mjs:647–651`). This contradicts the Goal's user-owned closing policy and §6's worktree-only rationale.
   - **Exact change:** Distinguish user-materialized windows from launch-owned temporary windows and prohibit automatic closure of the former. Define worktree relocation/retention when necessary. Serialize materialization against launch, cleanup and handoff using the existing session-resource lock; test concurrent clicks and completion during materialization. Define whether closing an active row dismisses it or immediately recreates it virtually.

7. **BLOCKING — Hydration and tree invalidation are underspecified**
   - **Evidence:** Current hydration seeds only active sessions and running job children (`src/server/sessionStatus.mjs:397–402`), not idle windowed sessions, paused jobs or pending-result children. Live running/attention/parent events only dirty status frames (`:283–301`); project refresh is wired specifically to job changes (`src/server/index.mjs:1415–1416`). Initial project snapshots can precede graph hydration (`src/server/rpc.mjs:1329–1348`).
   - **Exact change:** Define complete candidate/ancestor hydration, unknown-versus-root handling, last-known-good behavior and bounded retries. Refresh the materialized tree on graph, attention, handoff, directory, link and linger-expiry changes—not merely jobs/windows. Preserve the current hydration race protection and test cold boot, reconnect and failed ancestry reads without temporary root promotion.

8. **SHOULD — Preserve explicit exclusions before applying visibility rules**
   - **Evidence:** §2's "running" rule includes foreground subagents, internal sessions and uncommitted handoff successors before its later exclusion sentence. Current reconciliation explicitly excludes handoff successors, internal/CTO sessions and foreground task children (`src/server/delegate.mjs:4644–4682`). Foreground children are contractually transcript-only (`AGENTS.md:1137–1146`).
   - **Exact change:** Make exclusions precede visibility predicates. Preserve foreground-only behavior unless explicitly approved as a scope change; include provenance-based internal exclusions, routine runs, CTO helpers and `handoffEngine.isSuccessor`. Test that these sessions never briefly appear during hydration or handoff preparation.

9. **SHOULD — Handoff identity and project ownership need deterministic rules**
   - **Evidence:** `chainOf` returns a bidirectional set, not chronological ordering (`src/server/handoff/engine.mjs:1675–1688`); commit restamps windows and repoints job IDs (`src/server/handoff/wiring.mjs:74–82`). Jobs can explicitly belong to `targetProject` regardless of directory (`src/server/delegate.mjs:4146–4172`). §1's "window member, else newest" and §2's directory fallback do not resolve multiple stamped chain members, duplicate windows or cross-project parents.
   - **Exact change:** Define a stable conversation key separately from the current session ID; canonicalize chains before selecting edges and detecting cycles. Specify same-project nesting, job `tmuxSession` ownership, duplicate-window selection and directory-move behavior. Materialization must return the canonical session/window and publish refreshed project state before selection.

10. **SHOULD — Retirement leaves status and existing-record behavior unresolved**
    - **Evidence:** Busy ancestry and child counts independently consume `displayParentID` (`src/server/sessionStatus.mjs:96–138`). Lost-run detection belongs to `reconcileV2Jobs`/`judgeLostRun`, not the active-session adoption reconciler (`src/server/delegate.mjs:3240–3271, 3479–3506`). Existing observed records can retain inherited worktrees (`:2962–2968`). Push labels resolve only stamped windows (`src/server/push.mjs:494–516`).
    - **Exact change:** Extend §6 with migration behavior for existing observed records and retained worktrees; retain V2 settlement independently of adoption. Derive busy/count status from the same canonical graph, explicitly defining direct versus flattened descendant counts. Specify virtual-session notification labeling and correct the reconciler description.

11. **SHOULD — The proposed wire cannot represent the complete sidebar**
    - **Evidence:** `SessionNode.sessionId` is mandatory, but terminal windows have no session ID (`src/shared/types.ts:398–406`). Existing navigation and selection use project/window tuples (`src/renderer/store.ts:209–213, 1781–1788`); sidebar pins and focus also use window indices (`src/renderer/Sidebar.tsx:397–410`). iOS currently hides orphan job windows entirely, not merely nested children (`mobile/native/MantaUI/SessionModels.swift:221–250`).
    - **Exact change:** Specify how terminal rows merge with the session tree, how duplicate windows remain reachable, and how pins/focus survive materialization. Resolve iOS virtual roots explicitly: "count only" provides no parent on which to display their count. Define count semantics for running, paused, lingering and pending-result nodes.

12. **SHOULD — Library evaluation does not meet the required evidence standard**
    - **Evidence:** The table supplies an unsourced star count and rejects durable-store alternatives because an existing handwritten pattern exists (`docs/superpowers/specs/2026-11-05-session-tree.md:179–183`). The repository's inherited delivery instructions expressly reject that justification and require current maintenance/adoption/license evidence.
    - **Exact change:** Add sourced package versions, publish dates, adoption and license information for evaluated candidates. Name the actual reusable persistence implementation and its locking/atomicity guarantees, or give a concrete fit-based reason for custom storage. Cover concurrent link writes and deterministic cycle handling.

VERDICT: CHANGES REQUIRED

## Round 2 (spec r2)

| # | Finding → disposition | Why |
|---|---|---|
| 1 | **Resolved** | Legacy projection now targets the root window; A → B → C is explicitly tested. |
| 2 | **Partially resolved** | Structural retention fixes linger-driven promotion. Ordering still mixes index-based ordering with an unspecified retained slot (§2). |
| 3 | **Partially resolved** | Adopted display ancestry is correctly excluded. "Manta-owned" is incorrectly restricted to `origin:"delegate"`; see #13. |
| 4 | **Partially resolved** | Links and transitional inference ship in (a), but inference eligibility still depends on window existence; see #14. |
| 5 | **Resolved as an explicit trade-off** | Old-client loss of adopted rows is acknowledged; new-client fallback is specified. |
| 6 | **Partially resolved** | User ownership protects windows, but worktree removal remains unspecified. Current cleanup removes the worktree **before** closing the window (`src/server/delegate.mjs:1722–1737`). |
| 7 | **Partially resolved** | §7 still permits unknown candidates to become roots. The actual handoff event is `kind:"handoff"` with a payload (`src/server/handoff/engine.mjs:181–184, 1578–1583`). |
| 8 | **Partially resolved** | "Current turn" is inaccurate: `toolBlockFor` scans the parent's assistant timeline (`src/server/delegate.mjs:3146–3153, 4674–4682`). |
| 9 | **Partially resolved** | `key=sessionId` still changes on handoff; duplicate windows have no representation. |
| 10 | **Partially resolved** | Calling adopted `parentSessionID` "dead data" is incorrect: job listing and parent presentation consume it (`src/server/delegate.mjs:409–412`; `src/server/delegateView.mjs:158`). |
| 11 | **Partially resolved** | Duplicate-window reachability unspecified; `flatSessions` navigates every window (`src/renderer/store.ts:1781–1788`). |
| 12 | **Partially resolved** | Metrics lack source references; the headless-tree row lacks maintenance/adoption evidence. |

13. **SHOULD — Ownership must not be inferred from origin.** Wrapped commands have `origin:"command"` and `completionOwner:"manta"` (`src/server/delegate.mjs:4006–4029`); use `completionOwnerOf(record) === "manta"`.
14. **BLOCKING — Transitional inference still depends on adoption windows.** §1.4 applies only to a windowless root; stage (a) retains adoption windows (`src/server/delegate.mjs:647–664, 678–710`). Apply inference to graph roots regardless of windows; cache it across window creation/removal.
15. **SHOULD — Unlink can immediately restore the inferred relationship.** Define unlink as suppressing inference for that child.
16. **BLOCKING — Materialization is not serialized with handoff.** The session-resource lock is delegate-private (`src/server/delegate.mjs:95`); handoff restamps windows itself (`src/server/handoff/engine.mjs:1428–1435`). Specify coordination + canonical revalidation.
17. **SHOULD — "Unchanged" busy semantics omit the session's own work.** Today's active-work set includes running sessions themselves (`src/server/sessionStatus.mjs:96–120, 141–147`); counts are direct-children today (`:128–137`) — make the change explicit.

Scope: stage (a) is not yet standalone (#14) and larger than necessary — the smallest first PR is the stable server-side ancestry resolver + the legacy projection, preserving established inferred relationships.

VERDICT: CHANGES REQUIRED

## Round 3 (spec r3)

| # | Status | Remaining |
|---|---|---|
| 2, 3, 4, 5, 7, 8, 12, 13, 14, 17 | **Resolved** | — |
| 6 | Partially | "chat panel does not depend on the directory" is false: selection supplies its cwd (`src/renderer/store.ts:1790–1811`), ChatPanel passes it to directory-scoped ops (`src/renderer/ChatPanel.tsx:1949, 2479–2503`); materialization must supply a valid cwd (`src/server/tmux.mjs:605–608`). |
| 9 | Partially | window indices are project-local: "lowest index" needs a project tie-break and explicit duplicate placement. |
| 10 | Partially | §6 still called adopted `parentSessionID` dead data (consumers: `src/server/delegate.mjs:409–412`, `src/server/delegateView.mjs:158`). |
| 11 | Partially | duplicate-window rows need unique wire keys (#19). |
| 15 | Partially | §5 defined only deletion; specify a durable suppression entry, precedence, and that linking again clears it. |
| 16 | **Not resolved** | check/create/revalidate still races handoff (`src/server/handoff/engine.mjs:1428–1435, 1555–1565`): coordinate through shared exclusion or a handoff-owned operation. |

18. **SHOULD — Inference now includes ordinary user conversations.** The existing resolver restricts targets to opencode-owned records (`src/server/delegate.mjs:759–762, 941–948`); restrict inference to adopted/externally driven roots and retained windowless ancestors.
19. **NIT — Duplicate-window rows need distinct keys** (`window:<project>:<index>`).

Scope: stage (a) appropriately narrowed; defer the link store to (b); apply exclusions to traversal only.

VERDICT: CHANGES REQUIRED

## Round 4 (spec r4)

| # | Disposition | Remaining |
|---|---|---|
| 6, 10, 11, 15, 16, 19 | **Resolved** | — |
| 9 | Partially | root placement ("the tmux session of its window") and window selection ("the project the root was placed in") were circular; specify a deterministic initial project tie-break, then retain it. |
| 18 | Partially | "no job record at all" also excluded retained windowless ancestors; and a materialised (user-owned) window must not revoke an established inferred edge. |

20. **NIT — One handoff test still describes the superseded algorithm** (mid-create restamp); replace with both serialised orderings.

VERDICT: CHANGES REQUIRED

## Round 5 (spec r5)

| 9 | Resolved | 18 | Resolved | 20 | Resolved |

No new findings. VERDICT: APPROVE
