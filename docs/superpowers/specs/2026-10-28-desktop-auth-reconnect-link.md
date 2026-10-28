# Desktop chat error bar: the "Reconnect" link must go somewhere that can actually reconnect

Slug: `desktop-auth-reconnect-link` · Branch: `fix/desktop-reconnect-link`
Revision 3 (after review `reviews/2026-10-28-desktop-auth-reconnect-link.md-astra.md`, rounds 1 and 2; orchestrator decision: ship as scoped).

## 1. Problem

When a turn fails because the provider sign-in is no longer valid, the chat
error bar reads "Claude needs to be reconnected." with a **Reconnect** link next
to the dismiss ×. Pressing it makes the error vanish and nothing else happens.
That is the dead-control defect AGENTS.md bans ("NEVER STUB A CONTROL TO DO
NOTHING").

Verified root cause (line numbers on current `origin/main`):

- `ChatPanel.tsx:3201-3205` renders the button, `onClick={openAuthReconnect}`.
- `hooks/useSseBus.ts:386-392` — `openAuthReconnect` dispatches
  `CustomEvent("manta-open-subscriptions")`, then clears `sendError` and
  `authReconnect`. Nothing listens for that event (`grep` finds only the
  dispatch and comments); the Subscriptions card it names (BET-314) was retired.
  Subscriptions and custom endpoints now live in **Settings → Accounts**
  (`Settings.tsx:1189`, `AccountsCard.tsx`, section id `"accounts"`,
  `shared/settingsSchema.ts:103`).
- A working bridge to that section exists: `App.tsx:1496-1508` handles
  `manta-open-settings {section}`; `openAccountsSettings(provider?)`
  (`accountsData.ts:88`) dispatches it and parks the provider so the seat panel
  expands (`SeatsPanel.tsx:47-76`). `UsageDial.tsx:347` already uses it.

Two further facts the first draft got wrong, found in review and verified:

- **The Accounts destination does not currently offer a re-sign-in for an
  existing seat.** `SeatsPanel.tsx:181-297,345-368` offers rename, "Use this
  seat", Remove, "Add seat to …" and "Add … account" — no re-sign. Add is not a
  substitute: it refuses a duplicate identity (`accountsManager.mjs:337-372`,
  tests `accountsManager.test.mjs:475-488,713-721`), a sole seat cannot be
  removed (`SeatsPanel.tsx:189-194`), and an externally managed Claude row has
  no Disconnect (`AccountsCard.tsx:455-458`). The real re-sign flow
  (`ResignSeatFlow.tsx` → `accountsResignSeat({provider,seatId})`, same-account
  verified, seat preserved) is wired only from the usage popover's "Logged out"
  badge (`UsageDial.tsx:137-147,382-387,442-444`).
- **The banner state has a lifecycle gap.** `useSseBus.ts:233-236` — the public
  `setSendError` (used by `ChatPanel` for the dismiss × at `:3206` and ~30
  other writes, e.g. a failed send at `:1923`) never clears `authReconnect`.
  Today that is masked because the Reconnect press clears both; once the press
  stops clearing them (see Design), an unrelated later error would keep a stale
  Reconnect button for the old provider.

## 2. Goal / non-goals

Goal: pressing **Reconnect** opens Settings → Accounts focused on the failing
provider, and the destination offers a real way to sign in again for every
state the banner can come from — or says plainly what to do — with the banner
kept visible and never attached to the wrong error.

Non-goals: no change to how auth errors are classified or worded; no new OAuth
flow; no box/server change (see §7 for the one place this bites); iOS client
out of scope; providers outside Anthropic/OpenAI/Kimi get no banner today
(`chatUtils.ts:1777-1781,1817-1827` — an existing limitation, unchanged).

## 3. Design

### 3.1 Banner state lifecycle (finding 2)

Single rule: **any write to the error text invalidates the reconnect metadata;
only a classified `sessionError` sets it, after the text.**

In `useSseBus.ts`:

- Internal state `authReconnectState: { providerID: string; label: string } | null`.
  The hook's returned `authReconnect` stays `string | null` (`?.label ?? null`),
  so `ChatPanel` and existing assertions are unaffected.
- The wrapper `setSendError` (line 233) additionally calls
  `setAuthReconnectState(null)`. This covers the dismiss ×, every ChatPanel
  write, and the `aborted` frame.
- The `sessionError` case calls `setSendError(d.message)` **then**
  `setAuthReconnectState(d.auth ?? null)` (React applies the two in order, so the
  second wins). A second classified error for another provider therefore
  replaces the target; an unclassified error clears it.
- `openAuthReconnect` is the one caller that must NOT go through the wrapper:
  it only navigates and touches neither field (see 3.2).
- Honest lifecycle (documented in the hook comment, not overclaimed): the
  banner clears on dismiss ×, on any new send (`ChatPanel.tsx:1668` clears at
  submission), on the next error of any kind (replaced), and on a new turn only
  for the Aborted banner (`useSseBus.ts:568`). A `busy`/`retry` frame does
  **not** clear an auth banner and this fix does not change that.

### 3.2 The press (navigation)

`openAuthReconnect` → `openAccountsSettings(authProviderSeatId(state.providerID))`;
no state change, so the error stays on screen and a repeat press works (it
re-dispatches and re-parks focus). Null state → no-op (unreachable: the button
is only rendered when non-null).

`chatUtils.ts`: add pure `authProviderSeatId(providerID): SeatProviderId | undefined`
(`anthropic→"claude"`, `openai→"codex"`, else `undefined`); fix the stale
BET-316 comment at `:1763`. `ChatPanel.tsx`: button `title` →
`Open Accounts to reconnect ${authReconnect}`; visible text stays "Reconnect".
Remove every `manta-open-subscriptions` mention.

### 3.3 The destination must be actionable (finding 1)

Opening the modal is a visible outcome, but the user must be able to *act*. Per
provider/state, after the press:

| Failing login | What the user lands on | Recovery |
|---|---|---|
| Claude/Codex **non-live seat** (any status — including a seat the usage poller has not yet marked expired) | provider's seat panel auto-expanded | New **"Sign back in"** button on the seat → existing `ResignSeatFlow` |
| Claude/Codex **live seat** (the login the box itself uses — normally the sole seat) | same panel; the live seat row carries an inline instruction instead of a button | see below |
| Kimi (API key, no seats) | Accounts list, no panel | existing row **Disconnect** → **Connect** (API-key form, `ConnectProvider.tsx:662-698`) — saves a replacement key. The copy says to do exactly this; opening Accounts itself re-authenticates nothing |
| Connected, externally managed Claude row with no seat view | Accounts list | inline hint under the row (below) — never a Connect that doesn't exist |

**"Sign back in" on seats** (`SeatsPanel.tsx`, renderer only):
- Render a `BTN` "Sign back in" in `seatRow` for every seat with `!seat.live`,
  always enabled (not gated on `seatStateText`): a freshly failed credential is
  not yet marked expired. Non-live seats may attempt the existing flow; the
  server verifies identity (Claude: stored account UUID or email; Codex: stored
  account UUID) and reports failure, which `ResignSeatFlow` shows with Try
  again / Close. A seat with no verifiable identity can therefore never
  complete — a known limitation, recorded in §7 with the live-login follow-up.
  The renderer does NOT predict this (`SeatView` carries no UUID). `title`: `Sign ${seat.label} back in
  (same account only)`.
- Local state `resigning: { seat: SeatView; accountLabel: string } | null`;
  mount `ResignSeatFlow` (props exactly as `UsageDial.tsx:139-146`: `provider`,
  `seatId`, `seatLabel`, `accountLabel`, `email`) when set. `onDone(message)` →
  `setResigning(null)` + `setNotice({ok:true,text:message})`; `onCancel` →
  `setResigning(null)`. `ResignSeatFlow` reports its own failure/cancel states
  and refreshes accounts + usage itself. It is a portaled `Modal`; Settings
  already defers Escape to any open dialog (`Settings.tsx:98-122`), so stacking
  over the Settings modal is supported. One sign-in at a time: the button is
  disabled while `resigning` or `adding` is set.

**Live seat — explicit decision, with evidence.** The review asked for
re-sign-in "including a single seat". That cannot be done through
`ResignSeatFlow`: the server deliberately refuses it with `live-seat`
(`accountsManager.mjs:986-988`; tests `:1181`, `:1377`), and a provider's only
seat is the box's live login. Supporting it needs a server change (replace the
live credentials file / Codex live slot, which the resign mechanics —
temp dir beside the seat dir, or borrowing the live Codex slot — are not built
for), which is out of scope for this renderer fix (§7). So for a live seat the
panel shows, in place of the button, text that is true today:
- Claude: "This is the login this box itself uses (the Claude CLI owns it). To
  sign in again, run `claude auth login` on the box." — grounded in
  `subscriptionProviders.mjs:51,177` (managedBy / "run `claude auth login`"),
  `claudeAuth.test.mjs:207` ("the reactive path / `claude auth login` is the
  only fix") and the existing `Run claude` advice (`chatUtils.test.ts:2053`).
- Codex: "This is the login this box itself uses; it can't be re-signed from
  here yet." (Decided, not conditional: Disconnect → Connect with seats present
  is `AddSeatGate`, which rejects a duplicate identity — `rpc.mjs:2277-2304`,
  `AccountsCard.tsx:498-503`, `accountsManager.test.mjs:713-721` — so it is not
  an existing-seat recovery path.)
Whether a seat is live is `seat.live` (`SeatsPanel.tsx:188,203`); the
sentences go in a small `text-meta` line under the seat's email line.

**Externally managed Claude without a seat view** (`AccountsCard.tsx`,
`AccountRow`): where `row.connected && row.managedExternally` currently renders
no control (`:455-458`), add a visible hint beneath the row: "Signed in with the
Claude CLI on this box. If Manta says it needs to reconnect, run `claude auth login`
on the box." Never rendered for Custom rows or non-external rows.

## 4. Libraries / existing helpers considered

No library is relevant (in-app navigation between our own components). Reused:
`manta-open-settings` bridge (App.tsx), `openAccountsSettings` +
`consumeAccountsFocus` (accountsData.ts), **`ResignSeatFlow`** as-is (a missed
reuse in draft 1), `Modal`, `SeatsPanel`'s `BTN`/`notice` pattern, the
`saveToDownloads` principle (report both branches — `ResignSeatFlow` already
does). Rejected: a `manta-open-subscriptions` listener (revives a retired
concept); hiding the button (the surface exists); a new sign-in implementation
or a server change (out of scope, §7).

## 5. Tests

Unit / hook (vitest):
1. `chatUtils.test.ts` — `authProviderSeatId`: anthropic→claude, openai→codex,
   kimi-for-coding/""/null/undefined/"foo"→undefined.
2. `hooks/useSseBusFrames.test.tsx` (`providerID` is mutable in the harness,
   lines 41/57/96) — new cases in `describe("sessionError")`:
   - **Fails today:** after a `ProviderAuthError`, `bus.openAuthReconnect()`
     dispatches exactly one `manta-open-settings` with detail
     `{section:"accounts", provider:"claude"}`; `sendError` and `authReconnect`
     are unchanged afterwards (today both become null and a different event name
     fires).
   - Same for provider `openai` → `provider:"codex"`; `kimi-for-coding` →
     `section:"accounts"`, `provider` undefined.
   - Repeat press dispatches again; banner still present.
   - **Lifecycle (fails today):** auth failure → press Reconnect → `setSendError(null)`
     (dismiss) → `bus.authReconnect` null; auth failure → press → `setSendError("Couldn't send the message: x")`
     (new unrelated failure) → `bus.authReconnect` null (today it stays "Claude");
     auth failure → press → a second classified error for a different active
     provider → `authReconnect` is the new label and a press targets the new
     provider; `aborted` frame clears it.
3. Existing assertions at `useSseBusFrames.test.tsx:236-258` unchanged.

Destination (vitest, mounting real components with `window.api` stubs, in the
style of `SeatsPanel.test.tsx` / `UsageDial.resign.test.tsx` / `AccountsCard.test.tsx`):
4. `SeatsPanel.test.tsx` — a provider with ONE non-live seat whose status is
   `ok` shows "Sign back in"; clicking it mounts `ResignSeatFlow` and calls
   `accountsResignSeat({provider, seatId})`; success shows the "Signed back in"
   notice and the panel's list refreshes; a `different-account` result shows the
   flow's failure copy and the seat is untouched (same-account recovery).
   A **live** seat renders NO "Sign back in" and shows the Claude / Codex
   sentence from §3.3 verbatim. (Implemented in `SeatsPanel.resign.test.tsx`,
   which needs fake timers; focus-consumption tests live in `SeatsPanel.test.tsx`;
   Kimi/external-row tests in `AccountsReconnect.test.tsx`.)
5. `SeatsPanel.test.tsx` — pending focus: `openAccountsSettings("claude")` called
   **before** mount → the claude panel mounts expanded and focus is consumed
   (a second mount is collapsed); and `manta-open-settings {provider}` while
   **already mounted** → the matching panel expands, others don't.
6. `AccountsCard.test.tsx` — Kimi: connected row → Disconnect → (stubbed
   `opencodeProviderAuth`) → Connect renders the API-key form and saving calls
   the save action; disconnected row shows Connect directly. Externally managed
   Claude row with no seat view shows the §3.3 hint and no Connect.
7. Failure test: a seat whose identity the box cannot verify ends `login-failed`;
   the failure stays visible and Close works (`SeatsPanel.resign.test.tsx`).

Modal-opening criterion: no existing test mounts `App` (the cited
`ModelMenu.test.tsx`/`UsageDial.seats.test.tsx` only observe the dispatch).
Verified by a **manual running-app check** recorded in the PR description:
trigger a `ProviderAuthError` (e.g. temporarily break the Claude login on a
staging box), press Reconnect → Settings opens on Accounts with the claude panel
expanded, banner still visible; press again; close Settings; banner persists.

## 6. Acceptance criteria

- [ ] Reconnect dispatches `manta-open-settings {section:"accounts", provider}`
      (`claude`/`codex`/none for Kimi) and opens Settings → Accounts in the
      running app; the banner stays; repeat press works.
- [ ] The banner's Reconnect button never survives dismiss, a new send, an
      unrelated error, or a different provider's classified error pointing at
      the old provider (tests in §5.2).
- [ ] Every non-live Claude/Codex seat, including a lone non-live seat that still
      shows healthy, has a "Sign back in" (existing `ResignSeatFlow`); an
      identified seat recovers on the same account, a different account or an
      unverifiable identity fails visibly with Close (tests).
- [ ] A live seat shows a true instruction instead of a button; no claim of
      recovery that the code cannot deliver.
- [ ] Kimi's path (Disconnect → Connect with a replacement key) is test-proven;
      copy never implies Accounts re-authenticates by itself.
- [ ] Pending provider focus is consumed on mount and when already mounted.
- [ ] `grep -rn manta-open-subscriptions src` is empty.
- [ ] New hook/destination tests fail on `origin/main`, pass on the branch;
      `npm run typecheck` and `npm test` pass; manual check recorded.

## 7. Risks / open questions

- **Accepted follow-up (server):** the only login most boxes have is live, and
  the server refuses to re-sign it (`live-seat`); a seat with no stored
  identity can never pass same-account verification. This fix gives the live
  case accurate instructions and the unidentified case a visible failure; a
  one-click re-sign for the live login (Claude: replace
  `~/.claude/.credentials.json` after an identity match; Codex: write through
  opencode's auth API) is a separate server feature. Decision recorded:
  ship as scoped.
- We cannot tell *which* seat failed from the banner, so the panel shows all
  seats; the focus is per provider only.
- Stacked modals: `ResignSeatFlow` over Settings relies on Settings' existing
  Escape deferral; the manual check covers it.
- Providers outside the three have no banner (pre-existing) and are not changed.

## Review responses

1. **BLOCKING — Accounts destination lacks existing-seat re-sign-in: accepted
   (verified), with one evidence-backed deviation.** Verified: `SeatsPanel` has
   no re-sign; Add rejects duplicates; sole seat can't be removed; external
   Claude has no Disconnect; `ResignSeatFlow` is wired only from `UsageDial`.
   Resolved: §3.3 wires `ResignSeatFlow` into every non-live seat in the panel
   (always enabled, so a not-yet-marked-expired seat works), keeps provider
   focus, defines the no-seat-view fallback (externally managed Claude hint),
   and amends the renderer-only scope to include this destination wiring;
   same-account recovery acceptance/tests added (§5.4, §6). **Deviation:** the
   review's "including a single seat" cannot go through `ResignSeatFlow` when
   that seat is the box's live login — the server refuses with `live-seat`
   (`accountsManager.mjs:986-988`, tests `:1181`/`:1377`). A lone non-live seat
   is covered; for live seats the destination now gives explicit, true
   instructions and §7 records the server follow-up and a maintainer decision.
2. **BLOCKING — stale reconnect metadata / wrong clearing lifecycle: accepted
   (verified).** `setSendError` never cleared `authReconnect`; dismiss and new
   sends only cleared text; busy/retry do not clear auth banners. Resolved in
   §3.1: every wrapper write invalidates the metadata, `sessionError` sets it
   after the text, the press alone preserves both; lifecycle documented
   accurately (no "busy/retry clears it" claim; send-time clearing stated);
   tests for dismiss, new send, unrelated failure and replacement by another
   classified provider added (§5.2).
3. **SHOULD — verify the destination and bound non-seat-provider behaviour:
   accepted.** §5.4-§5.7 test the destination (existing-seat re-sign,
   Kimi connected/disconnected recovery, focus consumed on mount and when
   mounted); §5.2 covers all three providers, persistence and repeat press via
   the mutable `providerID`; the modal-opening criterion is a recorded manual
   running-app check (no App test exists); §2/§3.3/§7 separate the existing
   no-banner limitation for other providers from this scope, state the Kimi
   route as Disconnect → Connect with a replacement key, and do not extend that
   fallback to arbitrary providers or custom endpoints.

### Round 2 (Astra: 0 BLOCKING, 2 SHOULD, approved)

1. **SHOULD — bound "every non-live seat works"; unidentified seats cannot
   verify: accepted.** §3.3 now says non-live seats *may attempt* the flow and
   the server verifies identity and reports failure; §6 qualifies the success
   criterion to identified seats; added the `login-failed` destination test
   (§5.7); the missing-identity limitation is recorded in §7 next to the
   live-login follow-up. No renderer identity predicate was added.
2. **SHOULD — drop the speculative Codex-live success gate: accepted.** The
   honest fallback copy is now the decided behaviour (§3.3), the server
   follow-up is an accepted decision (§7), the old §5.7 gate is removed, and the
   copy is tested with no "Sign back in" button. The Kimi Disconnect → Connect
   test is kept.
