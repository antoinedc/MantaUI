# Opus review — desktop-auth-reconnect-link (branch `fix/desktop-reconnect-link`, commit 756489d8)

Scope read: spec rev 3 + Astra review, every changed file in full around the
changes, `ResignSeatFlow.tsx`, `accountsData.ts`, server `accountsManager.mjs`
(`resignSeat`, `landResign`, `compareAccount`, Codex landing) and
`accounts.mjs` (`seatStates`, `resolveSeatSource`, `claudeLiveIdentity`,
`provisionLiveSeatDirs`), `accountsErrorMessage`, App's `manta-open-settings`
handler. Ran: `npm run typecheck` (clean) and the four touched vitest files
(92/92 pass).

Summary: the dead control is fixed — Reconnect now dispatches the live
`manta-open-settings` bridge, the banner stays, and the lifecycle rule ("any
write to the text clears the target; only a classified `sessionError` sets it,
after the text") is implemented in one place (the `setSendError` wrapper), so
there is no path that leaves a target pointing at a different provider than the
banner text names. Label and provider id are captured as one object, so they
cannot disagree. The "Sign back in" button renders exactly when the server
would accept it: the view's `seat.live` and `resignSeat`'s `live-seat` refusal
both come from the same `accounts.seatStates()` computation. No security
concerns (renderer-only, no new data paths, no secret exposure). Findings are
copy/test-quality, none blocking.

## Findings

1. **SHOULD — `live-seat` refusal from the resign flow says "can't be removed".**
   `src/renderer/chatUtils.ts:3868-3869` (used by `ResignSeatFlow.tsx` start
   failure). The view's `live` flag can be stale relative to the server: for
   Claude, `live` is recomputed per read from the identity cache
   (`accounts.mjs:766-772`, 1 h TTL for a known identity, 30 s for a failed
   lookup) and is not persisted, so no `accounts.updated` event fires when it
   flips. Pressing "Sign back in" on a seat the server now considers live is a
   realistic path (and more likely now that the button is on every non-live
   seat, not only "Logged out" ones). The modal then shows "This is the login
   the box is using right now, so it can't be removed." — false for a re-sign.
   **Fix:** in `ResignSeatFlow`'s start-failure branch, map `live-seat` to
   resign-specific copy, e.g. `liveSeatNote(provider)` (move it to
   `chatUtils.ts` so both import it) or "This is now the login the box itself
   uses, so it can't be re-signed here. " + the provider instruction; also call
   `refreshAccounts()` on that error so the panel swaps the button for the note.
   Add a test: `accountsResignSeat` resolves `{error:"live-seat"}` → the modal
   text does not contain "removed".

2. **SHOULD — Kimi destination has no copy, contrary to the spec.**
   Spec §3.3 table, Kimi row: "The copy says to do exactly this" (Disconnect →
   Connect with a replacement key). Nothing on the branch renders that: the
   Kimi row on Accounts shows only "connected" + Disconnect, and the banner
   button's title is "Open Accounts to reconnect Kimi". A user who pressed
   Reconnect for Kimi lands on a list where the only visible action is labelled
   "Disconnect", with no hint that this is the recovery path.
   **Fix (either):** (a) in `AccountsCard.tsx` `AccountRow`, for a connected,
   non-Custom, non-`managedExternally` row with no `seatView`, render a
   `text-meta` hint "If Manta says this needs to reconnect, Disconnect and
   Connect again with a new key." (gate on the row being API-key-shaped if that
   is knowable; otherwise on `!seatView`), with a test in
   `AccountsReconnect.test.tsx`; or (b) correct the spec table to say the
   destination relies on the existing Disconnect/Connect controls with no
   additional copy, and record it as a deviation in "Review responses".

3. **SHOULD — the "replaces the target" test does not test in-place replacement.**
   `src/renderer/hooks/useSseBusFrames.test.tsx:303-323`. After switching
   `providerID = "openai"` it unmounts and remounts `Probe`, so the second
   classified error lands in a fresh hook with empty state; the assertion would
   pass even if a second classified error never replaced an existing target.
   **Fix:** don't remount. After `providerID = "openai"`, force one re-render
   so `providerIDRef` updates (e.g. `await emit(frame("running", {running:true}))`),
   then `await emit(authErr())`, assert `bus.authReconnect === "Codex"` and
   that a press dispatches `{section:"accounts", provider:"codex"}`.

4. **SHOULD — the spec's "aborted frame clears it" case is not tested.**
   Spec §5.2 lists it; the only aborted test (`useSseBusFrames.test.tsx:337-344`)
   never sets an auth banner first, so `authReconnect === null` is trivially
   true. The branch also deleted the explicit `setAuthReconnect(null)` from the
   `aborted` case, relying on the wrapper — exactly what needs pinning.
   **Fix:** add: `emit(authErr())` → `expect(bus.authReconnect).toBe("Claude")`
   → `emit(frame("aborted", {}))` → `sendError === "Aborted"`,
   `authReconnect === null`.

5. **NIT — lifecycle tests only cover the "press first" order; add the
   no-press variant, which is the one red on `main`.**
   `useSseBusFrames.test.tsx:285-301`. Both tests press Reconnect before the
   dismiss / unrelated error; on `main` the press itself cleared both fields, so
   these pass on `main` too. The actual pre-existing hole (§1 "lifecycle gap") is
   auth error → unrelated `setSendError("…")` with no press → `authReconnect`
   stayed "Claude". **Fix:** add that sequence (no press) asserting
   `authReconnect === null`.

6. **NIT — the live-seat note renders literal backticks.**
   `src/renderer/SeatsPanel.tsx:42-46,235-239`. `liveSeatNote` returns a plain
   string containing `` `claude auth login` ``, rendered as text, so the user
   sees the backticks; the sibling hint in `AccountsCard.tsx:495-500` uses
   `<code>`. **Fix:** drop the backticks from the string and render the command
   in `<code>` (e.g. return `{before, cmd}` or a ReactNode), updating the
   verbatim assertions in `SeatsPanel.resign.test.tsx:125-139`.

7. **NIT — instruction omits "same account".**
   `SeatsPanel.tsx:44` and `AccountsCard.tsx:497-498`. `claude auth login` with
   a different account does not repair the failing seat: the new identity is
   discovered as a new seat and the old seat (it has a provisioned directory,
   `accounts.mjs:830-846`) is left with the dead token. **Fix:** "…run
   `claude auth login` on the box and sign in with the same account."

8. **NIT (risk, record only) — which Claude seat shows the button vs the note
   depends on the identity cache, not on the failure.**
   `accounts.mjs:233-241,758-772`. A sole Claude seat whose live token is dead
   is shown as live (note) while the cached identity is fresh, then as a
   directory seat (button) once the lookup is retried and fails, because it has
   a provisioned `credentialDir` and `liveUuid` is now null. In the button
   state a successful re-sign writes only the seat directory, never
   `~/.claude/.credentials.json`; traffic recovers only because per-conversation
   routing reads the seat file. This is server behaviour outside this renderer
   fix and both outcomes are honest, but the manual running-app check should
   include sending a turn after "Signed back in" to confirm the banner does not
   recur, and §7's server follow-up should mention it.

## Questions answered (focus)

- **Is "Sign back in" a real outcome everywhere it renders?** Yes for the
  server-acceptance question: it renders iff `!seat.live`, and the server's only
  pre-flow refusals are `unknown-seat` and `live-seat` (same `seatStates`
  source). Every start/landing failure (`login-failed`, `different-account`,
  `unknown-flow`, timeout, cancel) is shown by `ResignSeatFlow` with Close /
  Try again. Unidentified seats end `login-failed` (spec-acknowledged); the copy
  there says "try again", which will never succeed for such a seat — recorded
  in §7, acceptable. Only the stale-view `live-seat` path has wrong copy (#1).
- **Is every instruction text true?** Claude live note and external-row hint:
  true (CLI owns `~/.claude/.credentials.json`; re-login re-identifies and
  mirrors), modulo "same account" (#7). Codex live note: true (no client path).
  Kimi: promised copy missing (#2). Title "(same account only)": true.
- **Stale reconnect target?** No path found. Every text write goes through the
  wrapper and clears the target; `sessionError` sets text then target in one
  batch; the press touches neither; `abortedBannerRef` busy-clear goes through
  the wrapper; the hook is per-session (ChatPanels keyed by session id), so a
  session switch can't carry it. Pre-existing, unchanged: the provider is the
  active model's at error time (a mid-turn model switch mislabels it) — out of
  scope per §2.

VERDICT: APPROVE
