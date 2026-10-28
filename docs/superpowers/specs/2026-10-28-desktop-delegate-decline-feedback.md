# Background-job approval card: report the outcome of Decline (and Approve)

Slug: `desktop-delegate-decline-feedback` · Branch: `fix/desktop-delegate-decline-feedback`
Revision 3 (resolves both Astra rounds — see "Review responses" at the end).

## 1. Problem

When the model asks to start a background job (`delegate`), the desktop chat
shows a pinned **Background job approval** card (Start job / Edit access / Not
now / ×). Pressing a button hides the card and fires an RPC to the box.

**What the user sees today**

- **Decline while the call errors / the box is unreachable:** the card vanishes,
  nothing is said, and ~3 s later it silently reappears (the poll re-reads the
  still-pending request).
- **Decline of a request the box no longer has** (expired after 2 min —
  `APPROVAL_TIMEOUT_MS`, `src/server/delegate.mjs:125` — or already answered
  elsewhere): the card vanishes with no word; the box's `{ok:false}` is
  discarded.
- **Approve** has exactly the same two holes — and an Approve that did not take
  effect means the user believes a job started when it may not have.

**Root cause (verified)**

1. `src/renderer/ChatPanel.tsx:3140-3150`: both handlers do
   `setPendingApproval(null); void window.api.delegateX(…).catch(() => { /* best-effort */ })`
   — hide first, fire-and-forget, rejection swallowed, reply never read. The
   bug report's claim that Approve "reports both failure kinds properly" is
   wrong; the two handlers are identical in shape. Both violate AGENTS.md
   "NEVER STUB A CONTROL TO DO NOTHING".
2. `ChatPanel.tsx:946-968` (the 3 s approval poll) is the second half of the
   problem: it **unconditionally re-installs the first non-empty list entry**
   (`setPendingApproval(approval)`) and **ignores an empty list**. So (a) a poll
   can re-show a request whose decision RPC is still in flight (duplicate
   action possible), (b) a poll that was already in flight when the user decided
   can re-show an already-resolved request after the decision completes, and
   (c) a displayed approval the box no longer has is never cleared (empty list
   is a no-op). Handler-only changes would preserve all three.
3. `ok:false` from the box is **not** "expired": `src/server/rpc.mjs:2475-2480`
   also returns `{ok:false}` when the delegate engine is absent, and
   `src/server/delegate.mjs:2495-2504,4840-4841` returns `false` for any entry
   that is not pending — expired, already approved/declined from another
   client, or already resolved by an earlier request of ours whose response was
   lost. The unchanged wire cannot distinguish these, and in the
   resolved-elsewhere/lost-response cases a job may be running.
4. `src/renderer/api/httpApi.ts:1314-1316` sends approve/decline through the
   unbounded `rpc()` (see `:300-305,363-365`), so a stalled connection yields
   neither a result nor an error — no feedback is possible at all. These
   channels only resolve an in-memory approval; they do not wait for job
   creation, so the "long operation" rationale for unbounded RPC does not apply.
5. `PanelCards.tsx:595-603,685-687`: the card keeps the user's edited rules in
   local state and passes the current value to `onApprove(tools)`; an unmount
   discards them.

## 2. Goal / non-goals

**Goal:** every press ends in one of the three legal outcomes (does it and says
so / fails and says why / isn't there), without asserting anything the wire
cannot establish, without allowing duplicate or stale-resurrected decisions, and
without losing the user's edited grants on a retry.

**Non-goals:** no box/server change and no wire/`api.ts` type change; the 3 s
poll cadence is unchanged; the card layout is unchanged; model-facing
"declined"/"approval timed out" results unchanged; no mobile/iOS change. The
always-grant auto-cover branch of the poll is being removed on the separate
branch `desktop-approval-pending-always`; this design **neither depends on nor
edits it** (see §3.4 for the merge note).

## 3. Design

### 3.1 Outcome model

A decision attempt resolves to exactly one of three outcomes:

| Outcome | When |
|---|---|
| `done` | reply is an object with `ok === true` |
| `unavailable` | reply is an object with `ok === false` (the box has no such pending approval — reason unknown) |
| `unconfirmed` | the call rejects (network, auth, HTTP error, timeout) **or** the reply is malformed (`undefined`, no boolean `ok`) — the box may or may not have applied it |

Copy is exact and deliberately asserts neither a reason nor a job outcome:

| Key | Tone | Text |
|---|---|---|
| `declineUnavailable` | info | `This approval is no longer available. Check background jobs to see whether it was already started.` |
| `approveUnavailable` | error | `This approval is no longer available. Check background jobs before trying to start it again.` |
| `declineUnconfirmed` | error | `Couldn’t confirm that the background job was declined. Check background jobs before trying again.` |
| `approveUnconfirmed` | error | `Couldn’t confirm that the background job was started. Check background jobs before trying again.` |

`done` shows no toast: the card disappearing (Decline) or the job appearing as a
background session (Approve) is the visible result.

### 3.2 Behaviour per press

1. Press → the card hides immediately and the decision is **in flight** for that
   approval id; further presses/polls for that id are inert.
2. `done` / `unavailable` → the entry is deleted. A poll issued before completion
   is discarded by the completion epoch; a poll issued after cannot list the id
   (the box removes the pending entry before replying). Toast per §3.1.
3. `unconfirmed` → the id becomes **retryable**: the card is restored (only
   where §3.3 allows) carrying the **snapshot of the rules the user submitted**
   (edited grants preserved; see 3.5). The card is an *unconfirmed retry
   opportunity*, not evidence the box still has the request; the next
   successful poll reconciles it (an authoritative empty list clears it; a list
   still containing the id keeps it).
4. The toast is global, so it appears even if the user has navigated away.

### 3.3 State (all in `ChatPanel`, refs for synchronous reads)

- `approvalDecisionsRef: Map<approvalId, {state:"inflight"} | {state:"retry", tools}>`
  — holds **only** in-flight decisions and unconfirmed-failure retry snapshots.
  Entries are deleted on a confirmed outcome (`done`/`unavailable`) and a retry
  entry is dropped when a successful poll no longer lists its id. (Rev 3: the
  permanent "settled" tombstones of rev 2 were cut — see Review responses R2-1.)
- `approvalEpochRef: number` — bumped on every press **and** every decision
  completion. Each poll captures it before `await delegatePendingApprovals` and
  **discards its result if the epoch moved** (stale-poll invalidation; the next
  3 s tick reconciles — cadence unchanged).
- `approvalGenRef: number` — bumped in the poll effect's setup **and** cleanup,
  i.e. on `sessionId`, `isActive`, trust-mode (`chatAutoAllow`) change and
  unmount. A press captures it; a restore is applied only if
  `approvalGenRef.current === capturedGen`. `App.tsx:2205-2225` keeps one panel
  mounted per visited session and only flips `isActive`, so `sessionId` alone
  is not a sufficient lifetime guard. On reactivation the fresh poll
  reconciles (a retryable id is re-shown from its snapshot).
- Pure reconcile function (new, in the helper module, unit-tested):

  ```ts
  nextPendingApproval({ current, polled, decisions }): DelegateApproval | null
  ```
  - `candidates = polled.filter(a => decisions.get(a.id)?.state !== "inflight")`
  - empty → `null` (**authoritative empty clears a displayed stale approval**)
  - else take `candidates[0]`; if `decisions.get(id)` is `retry`, return
    `{ ...a, tools: snapshot.map(t => ({ ...t })) }` (snapshot wins over the
    box's original tools on every poll and remount); if `current?.id === id`
    keep `current` (same identity, so the card's local edit state is not reset).

  The poll applies `setPendingApproval(nextPendingApproval(...))` only when the
  captured epoch is current and the effect is not cancelled. A newer approval
  already displayed is never overwritten by an older decision's restore: restore
  uses `setPendingApproval(cur => cur === null ? restored : cur)`; if it loses,
  the retry entry stays in the map and the poll re-shows it when it is first in
  the list.

### 3.4 Code changes

1. **New `src/renderer/delegateApprovalFeedback.ts`**
   - `APPROVAL_FEEDBACK_COPY` (§3.1 strings, exported), `ApprovalDecisionOutcome`
     (`"done"|"unavailable"|"unconfirmed"`), `classifyApprovalReply(reply)`,
     `nextPendingApproval(...)`, and
     `settleApprovalDecision(kind, call): Promise<ApprovalDecisionOutcome>` —
     awaits `call()`, classifies (rejection/malformed → `unconfirmed`), pushes
     the toast via `useStore.getState().pushAppToast` (`tone:"error"` except
     `declineUnavailable`), **never throws**.
2. **`ChatPanel.tsx`**
   - Replace the two handlers (~3140-3150): read `pendingApproval`, return if the
     id is already `inflight` (a `retry` entry may be re-decided); set `inflight` **synchronously**; bump
     epoch; capture gen; `setPendingApproval(null)`; call
     `settleApprovalDecision(kind, () => window.api.delegateApprove(id, tools))`
     (Approve submits the card's current `tools`, Decline passes the id). On
     completion: delete the entry (`done`/`unavailable`) or set `retry` with
     `tools.map(t => ({...t}))` snapshot — for Decline the snapshot is the
     approval's current tools), bump epoch, and for `unconfirmed` restore the
     card if gen matches.
   - Poll (~946-968): epoch capture, `nextPendingApproval`, empty list handled.
     **Sibling-branch ownership (rev 3):** `desktop-approval-pending-always` has
     no commits yet, so this PR **incorporates the already-agreed deletion** of
     the always-grant auto-cover from the poll (the `isApprovalCoveredByAlways`
     call, `permissionsRef` and its effect). The exported helper
     `isApprovalCoveredByAlways` and its tests in `chatUtils` are left for that
     branch to delete. This is a behaviour change owned by this PR, not a
     textual-only conflict; whichever lands second just drops duplicate hunks.
3. **`src/renderer/api/httpApi.ts:1314-1316`** — send approve/decline through the
   existing `rpcWithTimeout` with a new named constant
   `RPC_APPROVAL_TIMEOUT_MS = 15000` (same value/style as
   `RPC_METADATA_TIMEOUT_MS`). No change to channels, payloads or `api.ts`
   types. This is the **existing 15 s fetch timeout** (it bounds waiting for
   response headers; `fetchWithTimeout` clears its timer once headers arrive, so
   a stalled response *body* is not covered — a full-RPC timeout would be a
   global helper rewrite and is out of scope). A timeout rejects → `unconfirmed` (the request may have committed;
   the copy says so and a later retry hitting `ok:false` reads `unavailable`).
4. Nothing else: server, `PanelCards.tsx`, `api.ts` unchanged. (The card
   already hands its edited rules to `onApprove`, so no state hoisting is
   needed.)

### 3.5 Edited grants on a failed Approve

The `tools` array passed to `onApprove` is snapshotted (deep copy) at click and
stored in the `retry` entry. Every restore/poll/remount for that id uses the
snapshot (§3.3), so a user who narrowed access and hit a failure cannot, by
pressing Start job again, submit the original broader grant. The retry entry is
dropped when a successful poll no longer lists the id (ids are unique per
approval, so no per-session reset is needed).

## 4. Libraries / existing helpers considered

- No library applies to this two-branch feedback + small state machine. Toast:
  the app's own `Toast`/`pushAppToast` (`tone:"error"|"info"`).
- Reused: `saveToDownloads` (`downloadFeedback.ts`) as the shape (async, never
  throws, always ends in a visible outcome); `rpcWithTimeout` in `httpApi.ts`;
  the existing `ChatPanel.background.test.tsx` + `testHarness.tsx` for
  component tests.
- Rejected: `setSendError` (composer error banner — wrong surface, send
  failures only); "hide only after the box confirms" (leaves live buttons over
  a hung call; a down box would show a card with no sign anything happened);
  hoisting the card's edit state into `ChatPanel` (unneeded — the callback
  already supplies the edited rules).

## 5. Tests

All vitest. Commands: `npm run typecheck && npx vitest run <files>`, then full
`npm test`.

### 5.1 Component tests — REQUIRED, no waiver

New `src/renderer/ChatPanel.delegateApproval.test.tsx`, built like
`ChatPanel.background.test.tsx` (`installMockApi({ delegatePendingApprovals, delegateApprove, delegateDecline, … })`,
`resetStore`, `mount(<ChatPanel {...PROPS} />)`, `h.flush()`; the poll runs
immediately on mount so no 3 s wait is needed; use `vi.useFakeTimers` only for
the poll-tick/race cases). The file imports **only** the harness, `ChatPanel`
and `store` — **not** the new helper — and drives the real card
(buttons "Start job", "Edit access", "Not now", the Remove ✕ with
`title="Remove"`), asserting `useStore.getState().appToasts`, card
presence in the DOM, and the recorded `api.calls`.

Cases:

1. **Decline rejects** → error toast `declineUnconfirmed`; card visible again;
   `delegateDecline` called once with the id. *(Fails behaviourally on today's
   code: no toast, card only returns after a poll.)*
2. **Decline `{ok:false}`** → info toast `declineUnavailable`; card gone.
   *(Fails on today's code: no toast.)*
3. **Decline `{ok:true}`** → no toast; card gone.
4. **Approve rejects** → `approveUnconfirmed` error toast; card restored.
5. **Approve `{ok:false}`** → `approveUnavailable` error toast; card gone.
6. **Approve `{ok:true}`** → no toast; card gone; `delegateApprove` called with
   the id and the original tools.
7. **Malformed reply** (`undefined`) on Decline and Approve → `unconfirmed`
   copy, card restored.
8. **In-flight race:** `delegateDecline` returns a deferred promise; while it is
   pending, trigger a poll tick that still lists the id → card is **not**
   re-shown, `delegateDecline` is not called twice; resolve → outcome applied.
9. **Late pre-decision poll:** a `delegatePendingApprovals` call started before
   the press resolves (still listing the id) after the decision completed
   successfully → card not resurrected (completion epoch).
10. **Authoritative empty list:** with the card displayed (e.g. after
    `unconfirmed` restore), the next poll returns `[]` → card cleared.
11. **Edited grants:** open Edit access, Remove one rule, press Start job with
    `delegateApprove` rejecting → card restored showing only the narrowed
    rules; press Start job again with `delegateApprove` resolving `{ok:true}`
    → second call's args are exactly the narrowed rules (deep-equal), and a poll
    in between (listing the original request) does not restore the broad rules.
12. **Inactive-panel switch:** press Decline with a deferred rejecting promise,
    `h.rerender` with `isActive:false` (same `sessionId`), then reject →
    error toast is shown but the card is **not** restored into the hidden
    panel; rerender with `isActive:true` → the reactivation poll re-shows the
    retryable card.
13. **Newer approval wins:** decision for A in flight; poll shows B; A's
    `unconfirmed` completion does not replace B.
14. **Unmount** during an in-flight decision: toast still appears, no state
    update warning/throw.

Cases 1, 2, 4, 5, 7 must be run against unmodified `main` first and confirmed
failing on assertions (not on a missing import); record that in the PR.

### 5.2 Unit tests

`src/renderer/delegateApprovalFeedback.test.ts`: only what is awkward through
the UI — `classifyApprovalReply` malformed-reply edges and `nextPendingApproval`
(in-flight skip, empty → null, retry snapshot wins as a copy, identity kept).
Outcome × kind copy/tone is asserted once, in the component tests, which are
parameterised over approve/decline.

### 5.3 httpApi test

In `src/renderer/api/httpApi.test.ts` (follow its fetch-mock pattern): a fetch
mock that **observes `init.signal` and rejects on abort** (a merely-pending
promise would not reject), with fake timers — `delegateApprove`/`delegateDecline`
reject after 15 s; a normal
reply still resolves `{ok}`; request body/channel unchanged.

## 6. Acceptance criteria

- [ ] No `.catch(() => { /* best-effort */ })` remains on the two card handlers.
- [ ] `ok:false` is never described as "expired"; copy is exactly §3.1; malformed replies and rejections use the unconfirmed copy.
- [ ] Decline/Approve rejection or timeout → error toast and the card restored (live panel only).
- [ ] While a decision is in flight, polls cannot re-show that approval and a second decision cannot be sent; a poll issued before a completed decision cannot re-show it.
- [ ] An authoritative empty poll clears a displayed approval.
- [ ] A failed Approve retried submits exactly the rules submitted before the failure (narrowed rules survive; no poll/remount resets them).
- [ ] Navigating away (`isActive` false), switching session, trust-mode change or unmount never restores a card into a dead/hidden panel, and an older completion never overwrites a newer approval.
- [ ] Approve/decline use the existing 15 s fetch timeout (headers); a stalled connection ends in the unconfirmed outcome.
- [ ] Tests in §5 present, handler-level cases 1/2/4/5/7 fail on `main` and pass after; typecheck + full suite green.
- [ ] No server, wire-payload, or `api.ts` type changes; poll cadence still 3 s; the auto-cover call and `permissionsRef` are removed from the poll (§3.4).

## 7. Risks / open questions

- **Poll-handling change is necessary scope.** It is the only way to make
  "in flight / retry" real; it does not change cadence or what the box sees.
- **Overlap with `desktop-approval-pending-always`** — this PR removes the
  auto-cover from the poll (§3.4); the other branch then only has the helper and
  its tests left to delete.
- **"Check background jobs"** refers to the background-job rows in the sidebar;
  no new navigation is added.
- Auto-approve path: removed by the other branch; nothing here touches it.

## Review responses

Each finding was verified against the code before acting.

1. **BLOCKING — `ok:false` ≠ expired.** *Accepted.* Confirmed `rpc.mjs:2475-2480`
   (engine-absent → `{ok:false}`) and `delegate.mjs:2495-2504,4840-4841`
   (`resolve` returns false for any non-pending id). Outcome renamed
   `unavailable`; copy replaced with the reviewer's wording (§3.1) and no reason
   or job outcome asserted; Decline gets an info toast, Approve an error toast;
   malformed replies are `unconfirmed`, not expired. Tests/acceptance updated.
2. **BLOCKING — optimistic hide doesn't stop duplicates/stale resurrection.**
   *Accepted.* Confirmed `ChatPanel.tsx:946-968` re-installs `list[0]` every
   tick and ignores `[]`. Added the per-id decision map (synchronous in-flight
   guard shared by handlers and poll), settled-id suppression (later cut — R2-1), a poll epoch that
   invalidates stale responses, and empty-list reconciliation (§3.3). Retry
   after uncertain failure is the `retry` state; an older completion cannot
   overwrite a newer approval (`cur === null` restore + map re-show). Cadence
   unchanged. Tests 8, 9, 10, 13.
3. **BLOCKING — retain edited grants.** *Accepted; my earlier "needs hoisting"
   claim was wrong.* Confirmed `PanelCards.tsx:595-603,685-687`: the callback
   already carries the edited rules. Snapshot at click, restore with the
   snapshot, retained against polls and remounts (§3.5). Test 11 verifies the
   second approval submits exactly the narrowed rules.
4. **SHOULD — failure copy must express uncertainty.** *Accepted.* Confirmed
   `httpApi.ts:323-348` rejects on many causes and the server may have committed
   before a response is lost. Copy replaced with the reviewer's "Couldn’t
   confirm…" wording; a restored card is described as an unconfirmed retry
   opportunity reconciled by the next successful poll (§3.2 step 3).
5. **SHOULD — session guard vs actual panel lifetime.** *Accepted.* Confirmed
   `App.tsx:2205-2225` keeps panels mounted with stable `sessionId` and flips
   `isActive`. Replaced `sessionIdRef` with a lifecycle generation bumped in the
   poll effect's setup and cleanup (session, activity, trust mode, unmount);
   restore only in the matching generation; reactivation poll reconciles.
   Tests 12, 13, 14.
6. **SHOULD — bound the decision request.** *Accepted.* Confirmed `httpApi.ts`
   uses unbounded `rpc()` at `:1314-1316` while `rpcWithTimeout` exists (`:371`).
   Switched approve/decline to `rpcWithTimeout` with a 15 s constant (no wire or
   type change); timeout → `unconfirmed`. Test in §5.3.
7. **BLOCKING — handler-level regression test, no waiver.** *Accepted.*
   Confirmed `ChatPanel.background.test.tsx:94-121` and `testHarness.tsx`
   (`installMockApi`, `mount`, `rerender`, `flush`) make this feasible, and the
   poll runs on mount. Waiver removed; §5.1 specifies 14 component cases through
   the real card, importing nothing new, with cases 1/2/4/5/7 required to fail
   on unmodified `main` by assertion. Unit tests are secondary (§5.2).

### Round 2 (approved; SHOULDs/NIT applied)

- **R2-1 SHOULD — cut permanent settled tombstones.** *Accepted.* The box deletes
  the pending entry before replying, and the completion epoch already discards
  every earlier-issued poll. §3.3/§3.2/§7 now keep only in-flight and retry
  entries; cases 2/3 no longer invent a post-completion stale server listing
  (case 9 covers the real race). The first implementation also showed the retry
  entry must not block a second decision — the guard is `inflight` only.
- **R2-2 SHOULD — sibling-branch ownership.** *Accepted, "incorporate" option.*
  `desktop-approval-pending-always` has no commits, so this PR owns the
  agreed deletion of the auto-cover from the poll (call + `permissionsRef`);
  the exported helper and its tests are left for that branch (§3.4).
- **R2-3 SHOULD — qualify the timeout; realistic mock.** *Accepted.* The change
  uses the existing 15 s fetch timeout (headers only); the httpApi test's fetch
  mock observes `init.signal` and rejects on abort (§3.4, §5.3, §6).
- **R2-4 NIT — redundant unit coverage.** *Accepted.* Unit tests reduced to the
  classification edges and reconciler; component cases are `describe.each` over
  approve/decline (§5.1, §5.2).

### Opus code review (approved; 1 SHOULD, 6 NIT)

- **O-1 SHOULD — auto-cover removal regression test / same-named test file.**
  Resolved by rebasing onto `origin/main` after PR #1635 (the sibling) merges and
  keeping the union of cases in `ChatPanel.delegateApproval.test.tsx` (its
  "never auto-approve" tests + this branch's decision tests); the sibling's
  deletion of `globCovers`/`isApprovalCoveredByAlways` from `chatUtils` is kept.
  This supersedes the §3.4 note that the helper is left for the other branch.
- **O-2 NIT** double-press guard — test added (two clicks in one `act`).
- **O-3 NIT** completion-epoch bump — test added (poll issued after the press,
  resolving after completion).
- **O-4 NIT** a failed Decline restores the box's original rules, not unsubmitted
  card edits. Accepted: the restored card lists them, so a later Start is an
  informed choice; no `PanelCards` change.
- **O-5 NIT** §3.5 wording aligned with the implementation.
- **O-6 NIT** residual body-stall case noted in a comment at
  `RPC_APPROVAL_TIMEOUT_MS`.
- **O-7 NIT** toast naming the job — declined; copy is spec-frozen and the
  toast text is deliberately generic.
