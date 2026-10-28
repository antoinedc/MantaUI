# Opus code review — desktop-delegate-decline-feedback

Branch `fix/desktop-delegate-decline-feedback`, commit `3a07f2e2` vs `origin/main`.
Read in full: spec (rev 3 + review responses), Astra review (2 rounds), the
`ChatPanel.tsx` poll + handler hunks, `PanelCards.tsx` `DelegateApprovalCard`,
`delegateApprovalFeedback.ts`, `httpApi.ts` (`fetchWithTimeout`, `rpcInner`,
`rpcWithTimeout`), server `delegate:approve|decline` (`rpc.mjs:2475-2480`) and
the approval store (`delegate.mjs:2485-2505`), store `pushAppToast` /
`GlobalToasts`, all new tests, and the sibling branch commit `0ab24ea4`
(`fix/desktop-approval-pending-always`).

Checks run in the worktree: `npm run typecheck` (tsc ×3 + eslint) clean;
`vitest run` on `ChatPanel.delegateApproval.test.tsx`,
`delegateApprovalFeedback.test.ts`, `api/httpApi.test.ts` → 91/91 pass.

## Summary of verification

- **Bug fixed.** Both handlers now route through `decideApproval`
  (`ChatPanel.tsx:983-1003`) → `settleApprovalDecision`, which awaits the call,
  classifies `{ok:true}` / `{ok:false}` / reject-or-malformed, and always ends in
  a visible result (card gone, info/error toast, or error toast + card restored).
  No `catch {}` remains on a user action; the only remaining swallow is the
  poll's (`:972`), which is a background read, not a press.
- **Copy is truthful.** `ok:false` is "no longer available" with no asserted
  reason (correct: `rpc.mjs` returns it for engine-absent and `resolve` returns
  false for any non-pending id). Unconfirmed copy says "couldn't confirm", not
  "failed"/"still waiting" — correct since a 15 s abort or a lost response may
  follow a committed resolution (server `resolve` is synchronous and deletes the
  entry before replying).
- **Poll reconciler races** — traced each:
  - *Double press:* `inflight` is set synchronously before any await; a second
    dispatch before re-render returns early. Correct.
  - *Poll during in-flight:* filtered by `nextPendingApproval`. Correct.
  - *Poll issued before press:* discarded by the press epoch bump. *Poll issued
    after press, resolving after completion:* discarded by the completion bump
    (without it, a `done` id deleted from the map would be re-shown from that
    poll's stale list). Both bumps are necessary and present.
  - *Updater ordering:* the epoch check is synchronous at poll resolution, and
    the queued updater reads the live map; a press landing between queue and
    render is applied after it (`null`), so no resurrection. The retry-pruning
    loop is outside the updater, so StrictMode double-invoking the updater is
    harmless (`nextPendingApproval` is pure).
  - *Restore lifetime:* `approvalGenRef` bumps on every setup **and** cleanup of
    the poll effect (all three early-return branches return a cleanup that
    bumps), so `isActive` flip, trust-mode flip, `sessionId` change and unmount
    all invalidate a pending restore. The retry entry survives, and the
    reactivation poll re-shows it from the snapshot (tested).
  - *Newer approval wins:* `cur ?? restored`; the losing retry is re-shown by a
    later poll when it is first. Correct.
  - *Edited grants:* snapshot taken at click from the card's own `tools`
    argument; restore/poll/remount use the snapshot; `current` is kept for the
    same id so the card's `useEffect([approval.id])` does not reset edits. The
    card is unmounted while hidden, so a restore remounts with the snapshot.
    Correct.
  - *Unmount:* toast still pushed via the global store; no setState after
    unmount (gen bumped by cleanup). Tested.
- **Auto-cover removal is complete on its own.** The `isApprovalCoveredByAlways`
  import, the `permissionsRef` mirror and its effect, and the auto-approve call
  are all gone; the production hunk is byte-for-byte the same behaviour as the
  sibling's (`0ab24ea4` → `setPendingApproval(list[0])`, never auto-approve).
  `permissions` is still consumed by the card list (`:3163`), so nothing dangles.
  `globCovers`/`isApprovalCoveredByAlways` remain exported but unused outside
  `chatUtils.test.ts` (left for the sibling per spec §3.4; `knip` is not in CI,
  so nothing goes red).
- **httpApi:** approve/decline now use `rpcWithTimeout(…, 15000)`; same channels
  and payload shape (tested). The test's fetch mock rejects on `init.signal`
  abort, so it exercises the real timeout path.
- **Security:** no new surface; the change only *removes* an automatic approval
  path and narrows a retried grant to what the user submitted.
- **Tests:** component tests import only harness/`ChatPanel`/store and drive the
  real card; the rejection, malformed and `{ok:false}` cases assert toasts that
  today's code never pushes, so they fail on `main` by assertion, not import.

## Findings

1. **SHOULD — the auto-cover removal has no regression test on this branch, and
   the sibling adds a test file with the same name.**
   `src/renderer/ChatPanel.tsx:955-977` (removal), `src/renderer/ChatPanel.delegateApproval.test.tsx`
   (new here) vs `0ab24ea4:src/renderer/ChatPanel.delegateApproval.test.tsx`
   (new on `fix/desktop-approval-pending-always`).
   Problem: this branch owns a security-relevant behaviour change (a pending
   permission ask's `always: ["*"]` must never auto-start a job) but nothing here
   would go red if the auto-approve came back. Separately, the two branches
   *add* the same file path, which is an add/add conflict, not the "drop
   duplicate hunks" the spec §3.4/§7 describes.
   Fix: port the sibling's "never auto-approve" case into this file — emit a
   permission ask on the session with `permission:"bash", always:["*"]`, let the
   poll return an approval requesting `bash: git push *`, assert the card is
   shown and `api.calls.delegateApprove` is empty. Update the spec's merge note:
   whichever branch lands second resolves the test file by keeping the union of
   cases; if this branch lands first the sibling reduces to deleting
   `globCovers`/`isApprovalCoveredByAlways` and their `chatUtils.test.ts` block.

2. **NIT — the double-press guard is not exercised.**
   `ChatPanel.delegateApproval.test.tsx` "while the decision is in flight…"
   asserts one call but never attempts a second press, so the synchronous
   `inflight` check at `ChatPanel.tsx:985` is untested.
   Fix: inside one `act`, dispatch two clicks on the same button element (before
   React re-renders), assert `calls(method)` has length 1.

3. **NIT — the completion epoch bump is not distinguished from the press bump in
   tests.** The "poll issued before the decision finished" case issues the poll
   *before* the press, so the press bump alone discards it; deleting the
   completion bump (`ChatPanel.tsx:993`) would keep the suite green while
   reintroducing resurrection.
   Fix: add a case — deferred decision; press; `tick()` with `pollImpl`
   returning a held deferred (poll issued *after* the press); resolve the
   decision `{ok:true}`; then resolve the held poll with `[AP]`; assert the card
   stays gone.

4. **NIT — a failed Decline discards unsubmitted card edits.**
   `ChatPanel.tsx:3176` passes `pendingApproval.tools`, not the card's local
   edited rules, so an unconfirmed Decline restores the original (possibly
   broader) rules. The restored card visibly lists them, so a later Start is an
   informed choice; low risk. Optional fix: have the card pass its current
   `tools` to `onDecline` (one-line `PanelCards.tsx` change) and snapshot those;
   otherwise note it in the spec as accepted.

5. **NIT — spec/impl wording drift on snapshot lifetime.** Spec §3.5 says the
   snapshot is "dropped when the id settles or the session changes"; the
   implementation drops a retry entry only when a successful poll no longer
   lists the id (`ChatPanel.tsx:968-970`). Behaviour is fine (ids are unique per
   approval, so the next poll for any other session prunes it). Fix: update §3.5
   to match.

6. **NIT — body-stall leaves an approval permanently suppressed.** The 15 s
   bound covers headers only (`fetchWithTimeout` clears its timer once
   `fetch` resolves; `rpcInner` then awaits `res.json()` unbounded). A stalled
   body keeps the id `inflight` forever, so that approval is never re-shown in
   this panel and no toast fires. Acknowledged in the spec and the reply is a
   tiny JSON body; no change required, but a one-line code comment at
   `RPC_APPROVAL_TIMEOUT_MS` stating the residual case would keep the next
   reader honest.

7. **NIT — global toast does not say which job.** `delegateApprovalFeedback.ts:57-64`.
   The toast is global (correctly, so it lands after navigation), but "the
   background job" is ambiguous once the user is in another session. Optional:
   append the approval's `name` (e.g. `… declined (job-name). …`). Copy is
   spec-frozen, so only if the spec is amended.

Counts: 0 BLOCKING, 1 SHOULD, 6 NIT.

VERDICT: APPROVE
