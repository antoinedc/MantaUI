# Background-job approval must never be auto-approved from pending asks

Slug: `desktop-approval-pending-always` · Severity: **security, high** · Scope: desktop renderer only.

## 1. Problem

A background job (`delegate` tool call) that declares `tools` while trust mode is off holds
for a single pre-flight approval card ("Start / Edit access / Not now"). The user is meant to
be the only party who can say yes.

Today the desktop can say yes **for** the user. `ChatPanel.tsx:947-968` polls
`delegatePendingApprovals` every 3 s; before showing the card it calls
`isApprovalCoveredByAlways(approval, permissionsRef.current)` (`ChatPanel.tsx:958`) and, when
true, calls `window.api.delegateApprove(approval.id, approval.tools)` itself — no card, no
click, no feedback (the error is swallowed too).

`isApprovalCoveredByAlways` (`chatUtils.ts:2261-2282`) treats the `always` list of every entry
in `permissionsRef.current` as an already-granted rule, and `globCovers` (`chatUtils.ts:2243-2253`)
makes a bare `*` cover every pattern.

Root cause — the data is not what the code assumes:

- `permissionsRef.current` is the panel's `permissions` state, which is replaced wholesale by the
  box's **pending** (unanswered) asks (`useSseBus.ts:739-745`, the `permissions` frame; seeded
  by `refreshPermissions`). An answered ask leaves the list. There are no "retained" grants in it
  (the original commit message and comment, "pending/retained PermissionRequest records", assume
  there are).
- `PermissionRequest.always` is `save` from the V2 ask (`opencodeV2.mjs:487`,
  `always: p.save`): what opencode **would persist if the user chose "Always"**. It is chosen by
  the asking tool, not by the user.

So any tool can pre-approve a background job: raise an ask whose `always` is `["*"]` (or any
broad glob), then `delegate` with `tools:[{permission, pattern}]`. The poll sees the pending ask
and approves the job within 3 s. The user never approved anything; rejecting the ask afterwards
does not undo the job. Report verified; line numbers in the report were off (985-993 → 947-968,
1995-2016 → 2261-2282, useSseBus 380-388 → 739-745), the mechanism is exactly as described.

Not a bug (unchanged): trust mode (`chatAutoAllow`) is an explicit user setting; with it on the
box skips the card (`delegate.mjs` `startJobWithApproval`, `trustMode`) and the poll effect
returns early (`ChatPanel.tsx:948`).

### What the feature was meant to do

Introduced by `3e952908` (BET-418 §A5, 2026-07-31): "auto-skip approval card when parent
`always[]` grants cover the request" — if the user had already granted "Always" for e.g.
`bash: pytest *` in this conversation, don't make them approve a job that needs only that.
Intent is reasonable; the implementation read the wrong data (what a pending ask offers, not
what the user granted). No spec doc exists for §A5.

### Is there a trustworthy source of user-granted rules?

- **The panel/box permission list: no.** Pending asks only (above). The box keeps no record
  when the user answers "always": `replyPermission` (`opencode.mjs:1514`) forwards the decision
  to opencode and stores nothing.
- **opencode V2 saved permissions: yes in principle, not wired and not safe to wire here.**
  `decision:"always"` persists a rule readable at `GET /api/permission/saved`
  (`[{id, projectID, action, resource, time}]`, verified in
  `docs/opencode-v2/spikes/p3/FINDINGS.md` and `round1-b.md` §B6). Nothing in `src/` calls it
  (only the cleanup spec lists "saved permissions management" as a future item). Using it for
  this auto-cover needs answers that are unverified: rules are **project**-scoped (is a job's
  worktree the same project? is the list per-directory?); action names differ from Manta's
  declared `permission` names (`shell`↔`bash`, `permissionKeysFor` aliases); `resource` glob
  semantics vs `globCovers`; rules created silently while trust mode was on (auto-reply
  "always") would count as "user granted"; and whether a saved rule even counts for a child
  session whose ruleset is catch-all-deny. That is a feature with its own spec and a live-opencode
  probe, not a security hotfix.

## 2. Goal / non-goals

Goal: for a pending pre-flight approval, no renderer path may approve automatically; approval
requires an explicit user action (the card's Start job). Jobs declared without tools, and
server-supplied trust (trust mode, consented overnight work), intentionally start without a card.

Non-goals: wiring `/api/permission/saved` (follow-up, §7); changing trust mode; changing the
server approval engine (`createApprovalState`, `startJobWithApproval`) or its 2-minute timeout;
touching the card UI; iOS (no equivalent logic: `grep` of `mobile/native` for the helper finds
nothing).

## 3. Design

Behaviour after the fix, in plain words: when a job asks for approval the card appears, always,
unless trust mode is on (then there is no ask at all). Nothing about the parent's pending
permission asks influences it. Removing the auto-skip returns the pre-BET-418-§A5 behaviour.

Code changes (renderer only, no wire change):

1. `src/renderer/ChatPanel.tsx`
   - In the approval poll effect (~947-968) delete the `isApprovalCoveredByAlways` branch and
     its `delegateApprove` call; the effect just does `setPendingApproval(list[0])`.
   - Delete the now-unused `permissionsRef` + its sync effect (~937-941) and its BET-418 §A5
     comment, and drop `isApprovalCoveredByAlways` from the `chatUtils` import (line 54).
     `permissions` itself stays (PermissionCard).
2. `src/renderer/chatUtils.ts`: delete `globCovers` and `isApprovalCoveredByAlways` (+ comment
   block). They are only used by that branch (`grep` confirms) and a dead, security-relevant
   helper invites reuse. Remove the imports they alone needed if lint/typecheck flags them
   (`DelegateApprovalTool`, `PermissionRequest` only if no other use remains).
3. `src/renderer/chatUtils.test.ts`: delete the `globCovers` and `isApprovalCoveredByAlways`
   describe blocks (~2778-2905) and their imports (lines ~79 and the `globCovers` import).
4. Add a code comment at the poll effect stating the invariant once:
   `// Never auto-approve: only a user click may start a job (a pending ask's always[] is what the tool WOULD save, not a grant).`
5. NEVER-STUB rule check: the card's Start/Not now buttons already call
   `delegateApprove`/`delegateDecline` with `.catch(() => {})` (ChatPanel ~3136-3150). That is a
   pre-existing swallow of a failed user action — **out of scope here** but noted in §7; do not
   widen this fix.

No server, preload, `httpApi`, or `Api` type change. `delegateApprove` stays in the API
(the card uses it).

## 4. Libraries / existing helpers considered

- No library applies (this is a trust decision, not parsing). Glob libraries (`minimatch`,
  `picomatch`) would make `globCovers` more correct, but correctness of the match is not the
  defect — the input is untrusted — so a better matcher would only make the unsafe auto-approve
  more precise. Rejected.
- Existing source of real grants: opencode V2 `GET /api/permission/saved` — viable later,
  rejected for this fix (§1, §7).
- Chosen: **remove the auto-cover.** Smallest change that makes the exploit unreachable; matches
  the "no trustworthy source ⇒ always show the card" instruction.

## 5. Tests

Harness: `src/renderer/ChatPanel.harness.test.tsx`-style (`installMockApi`, `mount`,
`emitStreamAndFlush` from `testHarness.tsx`, jsdom). Add a new file
`src/renderer/ChatPanel.delegateApproval.test.tsx`:

1. **Regression — fails on today's code, passes after.** Mock `delegatePendingApprovals` →
   `[{id:"ap1", parentSessionID:"ses_test", name:"job", prompt:"p", tools:[{permission:"bash",pattern:"git push *"}], createdAt:1}]`.
   Mount `ChatPanel` (`sessionId:"ses_test"`, `isActive:true`, `chatAutoAllow` false). Emit a
   stream frame `{sub:"permissions", sessionId:"ses_test", payload:{permissions:[{id:"per1", sessionID:"ses_test", permission:"bash", patterns:["x"], always:["*"]}]}}`
   **before** the first poll resolves (emit, then let timers/flush run; use fake timers or
   `await h.flush()` twice to cover the initial `poll()` and one 3 s tick). Assert
   `api.calls.delegateApprove` is undefined/empty AND the approval card is in the DOM
   (`getByText`/`buttonByText(h, "Start")` — use the card's real label from `PanelCards.tsx`
   `DelegateApprovalCard`). On unfixed code `delegateApprove` is called with `("ap1", tools)`
   and no card renders → red.
2. Same scenario but the permission ask is **rejected/removed** first (emit empty `permissions`
   frame) → still card, still no `delegateApprove` (guards the "rejecting later" variant).
3. Clicking Start on the card calls `delegateApprove("ap1", tools)` exactly once and removes
   the card (guards that the removal didn't break the real path).
4. Trust mode on (`resetStore({chatAutoAllow:true})`): `delegatePendingApprovals` is never
   called (existing early return) — pins the unchanged behaviour.
5. Delete the obsolete `globCovers` / `isApprovalCoveredByAlways` unit tests (§3.3); do not
   keep them skipped.

Commands: `npx vitest run src/renderer/ChatPanel.delegateApproval.test.tsx src/renderer/chatUtils.test.ts`,
then `npm run typecheck && npm test`. Verify test 1 red on `origin/main` first (stash the fix or
run it in the base worktree) per the verify-before-merge rule.

## 6. Acceptance criteria

- [ ] With a pending ask `always:["*"]` and a pending job approval, no `delegateApprove` call is
      made and the approval card is shown (test 1).
- [ ] Same after the ask is rejected (test 2).
- [ ] Start still approves; Not now still declines (test 3 + existing).
- [ ] `grep -rn "isApprovalCoveredByAlways\|globCovers" src` returns nothing.
- [ ] No `permissionsRef` left in ChatPanel; `permissions` still drives PermissionCard.
- [ ] Trust mode behaviour unchanged (test 4).
- [ ] `npm run typecheck` and `npm test` pass; no server/wire/preload file changed.

## 7. Risks / open questions

- **UX cost:** users who relied on the (broken) auto-skip see the card every time. That is the
  pre-§A5 behaviour and the safe default. Mitigation if it hurts: follow-up below.
- **Follow-up (separate spec, not this PR):** honour *real* grants by reading V2
  `GET /api/permission/saved` server-side (box owns the check, client never decides), after a
  live probe of project scoping, action-name mapping, trust-mode-created rules, and
  child-session precedence. Must filter to rules created by an explicit user "always", which
  V2's saved record does not distinguish from trust-mode auto-replies today.
- **Related, pre-existing, not touched:** the card's `delegateApprove`/`delegateDecline` calls
  swallow failures (`.catch(() => {})`), against the AGENTS.md "never stub a control" rule; a
  failed Start leaves the card gone and the job held until the 2-minute server timeout. Worth a
  separate small fix reporting the error.
- **Server hardening idea (not needed for this fix):** the server could ignore approvals that
  arrive without a prior `delegate:pending-approvals` read, but any authenticated client is
  already trusted with approve; the defect was the client approving without the user.

## Review responses (Astra: 0 BLOCKING, 2 SHOULD, 1 NIT)

1. **SHOULD — deterministic regression ordering: applied.** The tests hold the first
   `delegatePendingApprovals` on a deferred promise: mount, hydrate, emit the permissions frame
   (`always:["*"]`), then resolve the approval list inside `act` and assert zero `delegateApprove`
   calls plus the visible `Start job` button. Real label `Start job` used. The click test resolves
   `delegateApprove` and asserts the card disappears. Verified red on the unfixed code
   (the failure is the unexpected `delegateApprove("ap1", …)` call).
2. **SHOULD — empty-edit consent bug: recorded, not fixed here.** `PanelCards.tsx` lets the user
   remove every rule and send `[]`; `delegate.mjs` (`startJobWithApproval`) treats an empty edited
   list as absent and falls back to the tool-supplied `tools`, so the user's reduced grant is
   silently overridden. Separate security follow-up: honour an explicitly supplied empty array
   (fall back only when `edited` is absent) and test that approving `[]` creates a child with only
   the catch-all deny. Not implemented in this patch.
3. **NIT — invariant wording / audit: applied** (§2 goal narrowed). iOS: a call-site audit
   (delegate / approval / always / permission-reply) found no delegate pre-flight approval API or
   card in the native client and no use of the decoded `always` field to auto-grant. Start / Not
   now failure handling is owned by the existing branch `desktop-delegate-decline-feedback`; this
   patch does not touch those handlers.
