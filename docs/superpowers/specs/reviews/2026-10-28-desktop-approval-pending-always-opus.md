# Opus review — desktop-approval-pending-always

Commit reviewed: `0ab24ea4` (branch `fix/desktop-approval-pending-always`, vs `origin/main`).

## What I checked

- Read the spec (incl. Review responses), the Astra review, the full diff, and the
  surrounding code: the approval poll effect and card wiring in `ChatPanel.tsx`
  (`~938-955`, `3123-3136`), `DelegateApprovalCard` (`PanelCards.tsx:581-700`), the server
  approval engine (`delegate.mjs:2452-2510`, `4763-4840`), every `startJobWithApproval` /
  `startJob` caller (`index.mjs:1336, 2714-2721, 2793-2802, 4517-4530`, `rpc.mjs:2449-2482`,
  `ctoAct.mjs:425-436`, `ctoWorkTools.mjs:2410, 3493`), the trust-mode ask pump
  (`permissionAskPump.mjs:65-100`), and the iOS client (`mobile/native`).
- `grep -rn "isApprovalCoveredByAlways|globCovers|permissionsRef" src mobile` → nothing.
  No stale "§A5 / auto-skip" references remain in code or docs.
- Ran `npx vitest run src/renderer/ChatPanel.delegateApproval.test.tsx src/renderer/chatUtils.test.ts`
  → 677 passed. `npm run typecheck` (tsc ×3 + eslint) → clean.
- **Red-on-main verified independently**: copied the new test file into a throwaway worktree of
  `origin/main` (removed afterwards). Tests 1 and 2 fail with
  `expected [ [ 'ap1', [ … ] ] ] to deeply equal []` — i.e. the real auto-approve, not a
  missing label. Tests 3 and 4 pass on main (as intended: they pin unchanged behaviour).

## Remaining-path audit (the security question)

No remaining path approves a **pending pre-flight approval** from tool-supplied or unanswered
data outside explicit trust mode:

- **Renderer:** the only `delegateApprove` call site left is the card's Start job button
  (`ChatPanel.tsx:3130`), driven by a user click. No other renderer module polls or
  subscribes to approvals (`delegate.approval.requested` has no renderer consumer). The poll
  effect now only `setPendingApproval(list[0])`.
- **Box server:** an approval resolves only via `approve`/`decline` (REST `index.mjs:4448`,
  RPC `rpc.mjs:2475`) or the 2-minute timeout (→ declined). Neither reads pending asks'
  `always`/`save`. `trustMode` on the tool-facing REST create path comes from box config
  (`cfg.chatAutoAllow`), never the request body. The CTO plan executor passes
  `trustMode:false`; only the overnight scheduler passes `true` (consented via the §11 veto
  card — server-supplied, not tool-supplied). The trust-mode pump auto-replies only when
  `chatAutoAllow` is on.
- **iOS:** no delegate approval API/card at all (`grep` for pending-approvals / approve
  finds nothing); `PermissionRequest.always` is decoded but only shown as a button scope
  (`ChatScreen.swift:1736`). A job raised while only iOS is watching fails closed (times out).
- **Fail-closed renderer/server mismatch:** if the renderer's `chatAutoAllow` is stale-true
  while the box has it off, the renderer doesn't poll and the job times out as declined —
  not an auto-approve.

## Findings

1. **NIT — out-of-scope, worth a tracked follow-up: jobs started with no approval and no
   ruleset.** `ctoWorkTools.mjs:2410` / `:3493` (CTO `work_dispatch` / `work_review`, via the
   bound `delegateOps.startJob`) and `rpc.mjs:2449-2458` (`delegate:start`, inbox "Delegate in
   background") call `startJob` directly with no `permission`, so `delegate.mjs:4114` passes
   `undefined` and the child gets opencode's default ruleset — the same shape BET-1519 fixed
   for overnight jobs. These are not approvals being auto-resolved (no approval is ever
   raised; inbox is a user click, work_dispatch a CTO turn), so they are outside this fix's
   invariant and must not be folded into this PR. Fix (separate spec): route both through
   `startJobWithApproval` with a declared toolset (e.g. `STANDARD_WORK_TOOLS`) so the catch-all
   deny applies, deciding per path whether the card or explicit consent covers it.

2. **NIT — already recorded, re-affirm priority: empty edited tool list is overridden.**
   `delegate.mjs:4787` (`edited.length > 0 ? edited : tools`) means a user who removes every
   rule and clicks Start grants the tool's original request. Spec §Review-responses #2 records
   it as a separate security follow-up; agree, and it should be filed before this merges so
   it isn't lost. Fix: `resolvedTools = Array.isArray(edited) ? edited : tools`, plus a test
   that approving `[]` yields only the catch-all deny.

3. **NIT — pre-existing, owned elsewhere: stale card after server-side timeout.** The poll
   returns early on an empty list (`ChatPanel.tsx:946`) so a timed-out/declined approval's
   card stays up, and Start then fails silently (`.catch(() => {})`, `:3130`). Not introduced
   or worsened here; the spec correctly defers it to `desktop-delegate-decline-feedback`.
   Make sure that branch also clears `pendingApproval` when the list no longer contains its id.

No BLOCKING or SHOULD findings. The fix is minimal (renderer only, no wire/server/preload
change), removes the only consumer of the unsafe helper and the helper itself, matches the
spec's acceptance criteria, keeps `permissions` driving `PermissionCard`, introduces no new
swallowed errors or dead controls, and the regression test is deterministic (deferred first
poll) and red on `origin/main` for the right reason.

Counts: 0 BLOCKING, 0 SHOULD, 3 NIT.

VERDICT: APPROVE
