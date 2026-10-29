# Code review — WS11 server consolidation, steps D4 + D5 (a: naming, b: clone)

Scope: the committed diffs only.

| Commit | Content |
|---|---|
| `76f2d39e` | D4, accounts |
| `8d70d60e` | D5a, naming + allocator + `async-mutex` |
| `0048d324` | D5b, clone |
| `d0455521` | iOS test fix |

D6 and later are out of scope.

**Checks run** on a `git archive 7f58a4bf` snapshot, which contains all of the above:
- `npm run typecheck`: clean.
- `npm run test:server`: 6214 pass, 0 fail. This includes `sessionNaming.test.mjs`, `sessionNaming.alloc.test.mjs`, `accountsCopy.test.mjs`, `accountsRowState.test.mjs` and `forge/cloneView.test.mjs`.
- Full vitest: 4870 pass. The one failure is the environment-only Playwright check in `tests/unit/e2e-smoke.test.ts`.
- The Mac compiled D1–D5 at `a7c19027`. The two failing tests there were fixed by `d0455521` (`AccountsRefusal` code + message), which I read; it is correct.

**What each step got right:**
- **The box owns the logic.** Each family moved into one node-tested module: `accountsCopy.mjs`, `accountsRowState.mjs`, `sessionNaming.mjs`, `forge/cloneView.mjs`.
- **Old copies are deleted.** I checked that the desktop and iOS copies were deleted: `accountsErrorMessage`, `formatEndpointStateLine`, `formatNoHealthyEndpointCopy`, `describeAccountState`, `usagePace`, `ENDPOINT_STATE_BADNESS`, the client half of `formatLastMove`, `AccountsCopy.reason(forCode:)`, `moveNoticeText`, `EndpointHealth`, `ProviderHealthFormat`, `AccountRowState.describe/control`, `SessionNaming.slugify/tmuxSafe/unique*`, `SessionScratchHint`, `SessionWorkspaceRoot`, `SessionRenameLogic.validated`, `cloneErrorKind`, `repoListErrorMessage`, `destFor`, `CloneErrorKind`, `RepoListError` and `ClonePicker.dest`. Guard rows cover them.
- **Wire changes are additive.** `message`, `stateLine`, `providerLines`, `copy`, `text`/`line`/`resentText`, `name`, `proposedRoot`, `errorKind`, `needsSignIn`, the optional `nameHint`, and `{root}` next to `{dest}` are all new and optional.

**The naming allocator is right:**
- **Lock scope.** One process-wide `async-mutex`. `runExclusive` covers read-names → choose → `tmux.newSession`. Metadata upsert and `syncState.refreshNow()` run after the release, using the final name.
- **Ownership.** It is sticky across retries, because `createdHere` comes only from `maybeCreateChatSession`.
- **Cleanup.** Only an owned session is ever deleted, never a caller-supplied `existingSessionId`. A failed delete is logged, not thrown.
- **Retries.** Explicit names are never retried. Hinted names get three attempts in total.
- **Tests.** The latch-based serialization test asserts the second caller has not entered and that the maximum concurrency is 1. Every ownership case listed in the spec is tested.

---

## BLOCKING

### 1. A failed `accounts:row-states` read leaves every Accounts row blank and without controls, silently (both clients)

**Where:**
- Desktop: `src/renderer/AccountsCard.tsx:500` (`.catch(() => null)`) and `:256`.
- iOS: `mobile/native/MantaUI/ProviderConnectionsStore.swift:119-130` and `AccountsScreen.swift:327`.

**Problem:** on a current box, a timeout or 500 on the new channel sends both clients into the older-box fallback:
- every connection row gets an empty or raw label;
- the controls become `none`, so there is no Connect, Disconnect or Try again;
- and, because `accounts-copy-1` is present, there isn't even the update note.

The desktop swallows the error. iOS logs it (`NSLog`) and, on a first-read failure, keeps an empty map. The user sees their providers with nothing to press and no reason given. This is the D1 rule again ("a failure is never evidence of an older box"), and it also hides the Accounts screen's primary controls.

**Fix:**
- Keep the three states apart:
  - an unsupported box (unknown channel, or `accounts-copy-1 === false`) gets the older-box fallback plus the note;
  - a failed read keeps the last good row states and shows a source failure ("Couldn't load account states — Retry");
  - while loading, keep the last good states or show loading.
- iOS: add to the existing `sourceFailures` section.
- Desktop: use the card's error strip, and make Retry re-run `refreshAccounts`.
- Tests: a row-states rejection on a box that has the capability keeps the controls of the last good read and shows the failure line, on both clients.

### 2. D5a breaks automatic window naming for titles over 40 characters or containing ":"

**Where:** `src/server/rpc.mjs` `tmux:rename-window` (now runs `validateSessionName`), called from `src/renderer/ChatPanel.tsx:2364` (`renameWindow`).

**Problem:** the auto-rename path sends `sanitizeGeneratedTitle(raw)`. That cap is `TITLE_MAX_CHARS = 48` (`streamInterpretation.mjs:938`), and it strips only a *trailing* `:`. So:
- titles of 41–48 characters, and
- titles with an internal colon, which models produce often ("Fix: login redirect"),

are now refused by the box. Before D5a these renames succeeded. The first-name path catches the error silently and retries on every turn, so such a window never gets named.

**Fix:**
- Set `TITLE_MAX_CHARS` to 40, the box's limit.
- Have `sanitizeGeneratedTitle` replace `:` (for example with " –") and drop control characters.
- Add a `streamInterpretation` test with a colon title and a 45-character title, and assert that `validateSessionName` accepts the result.

The `opencode` first-name title goes through the same sanitizer, so one fix covers both paths.

---

## SHOULD

### 3. An older box loses Connect / Disconnect / Try again entirely (both clients)

**Where:** `AccountsCard.tsx:256` (`control: "none"`), `AccountsScreen.swift:327`.

**Problem:** this is spec-conformant (the fallback is "raw health label only"), but it disables the core Accounts actions until the box updates. The D3 review chose the opposite for the upgrade gate: never a dead end.

**Suggestion (needs an orchestrator decision):** when row states are unsupported, offer Connect for `!connected` and Disconnect for `connected && !managedExternally`. Those are data fields the clients already read from `opencode:provider-auth status`, not a copied rule. The box refuses anything it can't do, and the flows already show refusals. Record the decision in the spec's D4 fallback cell.

### 4. Sign-in status failures are still worded on both clients, and differently from the box

**Where:**
- Desktop: `AddSeatFlow.tsx:66` (`seatFailureMessage`), `ResignSeatFlow.tsx:48` (`resignFailureMessage`).
- iOS: `AccountsSignInModels.swift:404, 445`.

**Problem:** the spec's K7 covers "the sign-in/resign status replies carrying `error`". The box now adds `message` to those replies, because `withErrorMessage` runs in the channel wrapper. But the poll loops ignore it and keep their own sentences. For the same code, the two sources disagree:

| Source | `duplicate-login` sentence |
|---|---|
| Box | "That login is already added." |
| Both clients | "That login is already added as a seat. Sign in with a different account." |

This leaves two sources of truth for one code, and the box-first rule is broken.

**Fix:** move these sentences onto the box, including:
- the 15-minute timeout (the box knows when the flow started);
- `different-account` with `expectedEmail` / `gotEmail` (already in the reply).

Have the poll loops render `message`. Delete the client copies, add guard rows, and add node tests for each code. If this is deferred, add it to the Follow-ups list and make the box's wording match the clients' wording in the meantime.

### 5. Creating a new project while the capability list is unknown can strand a session on an older box

**Where:** `NewSessionScreen.tsx:176`, `InboxPalette.tsx:136`, `SessionCreateSheet.swift:161`.

**Problem:** the gate is `=== false` / `== false`. While `sessions-naming-1` is still `null` (loading, or a failed read), both clients send `nameHint` with no `name`.

On a pre-D5 box, `tmux:new-session` then runs with `name: undefined`. A chat-mode create has already made the opencode session by that point. The tmux step then either fails or creates a session under a name the client can't predict. In both cases the client throws "The box didn't report the new session's name.", after the box may already have created something.

**Fix:** for new-project creates, require `=== true`. While the list is `null`, disable the create action with a "Checking your box…" title. The capability store retries on its own, and the reconnect refresh covers a current box.

---

## NIT

6. **iOS refusal copy.** `AccountsCopy.failure(action, reason:)` (`AccountsModels.swift:734`) now joins a capitalised box sentence onto a clause: "Couldn't rename the seat — Names must be 1–40 characters, with no control characters." Render the box sentence on its own when the error is an `AccountsRefusal`.
7. **Desktop row freshness.** Rows no longer follow live usage. Before, `describeAccountState` re-ran on every update of the `usage` store; now the words come from one `accounts:row-states` read per card load. Refetch the row states when the `usage` slice changes, or poll them alongside `accounts:health`.
8. **CTO tool bypasses the allocator.** `ctoMantaTools.mjs:1086` (`sessions_create`) calls `tmux.newSession` outside the allocator and without `tmuxSafeName`. A name with a `.` is stored and looked up under a name tmux won't keep. Route it through `createSessionUnderAllocator` with `explicitName`.
9. **`tmux:rename-session` doesn't make the name tmux-safe.** A project renamed to `a.b` becomes `a_b` in tmux, while the Sidebar sets the active project to `a.b`. Apply `tmuxSafeName` and return the final name. Also map tmux's "duplicate session" stderr to the class-1 "A project named … already exists." sentence.
10. **Slow work inside the mutex.** Opencode chat-session creation (an HTTP call) runs inside the mutex, so a hung opencode blocks every create box-wide. Bound `maybeCreateChatSession` with a timeout, or create the opencode session before taking the lock (ownership tracking already supports a pre-made, owned id).
11. **iOS name preview can go stale.** In `SessionCreateSheet`, if the proposal fetch for a new folder fails, the field keeps the previous folder's proposed name. It is display only (the create sends `nameHint`). Clear `newProjectName` when the key changes.

---

## Older-box behaviour summary

| Capability | Result |
|---|---|
| `accounts-copy-1` | Static error line ✓; static "Moved to X." ✓; note ✓; controls lost (see #3) |
| `sessions-naming-1` | Create disabled with the note when `false` ✓; unknown state is unsafe (see #5) |
| `forge-clone-view-1` | Clone action disabled with the note on both clients ✓. The `{root}` form is never sent to a box without it, except while the capability is unknown; then an old box answers `bad_request`, shown as "Couldn't start the clone." (a reported failure, not a dead control). |

VERDICT: CHANGES REQUIRED

---

## Round 2 — re-check against fix commit `e9b374d1`

I read the full diff of `e9b374d1` only; other uncommitted work in the worktree was ignored. I ran the checks on a `git archive e9b374d1` snapshot:

- **`npm run typecheck`:** clean.
- **`npm run test:server`:** 6252 pass, 1 fail. The failure is `upgradeV2Reclaim.test.mjs` › "a manifest entry replaced by a DIFFERENT file (different inode) is refused". It is a timing flake under box load: other agents' suites were running at the same time, the file passed 76/76 three times in isolation, and the commit doesn't touch it.
- **Full `npx vitest run`:** 251/251 files, 4835 pass, 0 fail. This covers the run the implementer skipped after the final `py-1` class change. The class change broke nothing, including the visual/structure suites.
- **Swift:** read only. The poll-outcome enums changed shape (`.failed(message:)`), and I checked every call site: `AccountsSignInFlow.swift:459,489` and the tests. `ProviderConnectionsStore.readRowStates` is now internal, so the screen's Retry can call it. I found no isolation or exhaustiveness risk.

### Findings 1–11

| # | Status | Notes |
|---|---|---|
| 1 BLOCKING (row-states failure) | **Resolved** | **Desktop:** the read is separate and sequence-guarded. A failure keeps the last good rows and shows "Couldn't load account states." with Retry. The older-box path is only `accounts-copy-1 === false`. **iOS:** `rowStatesReadFailed` drives the same row; only an unknown-channel answer means an older box. Tests on both clients. |
| 2 BLOCKING (auto-rename) | **Resolved** | `TITLE_MAX_CHARS = 40`. An internal ":" becomes " – " and control characters are dropped. A test runs every sanitizer shape through `validateSessionName`. One fix covers both the first-name and re-title paths. |
| 3 SHOULD (older-box controls) | **Resolved** (choice (a) accepted, see below) | |
| 4 SHOULD (sign-in wording) | **Resolved** (choice (b) accepted, see below) | `accounts:seat-status` / `accounts:resign-status` failures carry `message`: timed out, duplicate login, different account with both emails, generic. The box's `duplicate-login` sentence is now the actionable one. Both clients' `seatFailureMessage` / `resignFailureMessage` / `resignTimedOut` are deleted, with guard rows. Node tests cover every branch. |
| 5 SHOULD (capability unknown) | **Resolved** | NewSessionScreen, InboxPalette and the iOS create sheet now require `sessions-naming-1 === true`; while it is unknown they show "Checking your box…". The harness test covers it. |
| 6 NIT (refusal copy) | Resolved | An `AccountsRefusal` is shown as the box's sentence alone. |
| 7 NIT (row freshness) | Resolved | Row states are re-read when the card's data or the `usage` slice changes. |
| 8 NIT (CTO allocator) | Resolved | `projects.create` goes through `createSessionUnderAllocator` with an explicit name. A lost race maps to `target_exists`. Tested. |
| 9 NIT (rename-session tmux-safe) | Resolved | `tmuxSafeName` is applied, and duplicate errors map to the class-1 sentence. The additive `returnName` flag gives the final name; the Sidebar uses it, and an older box's bare list falls back to the typed name. Tested. |
| 10 NIT (opencode create inside the mutex) | Resolved | `maybeCreateChatSession` is bounded at 20 s, and a late session is deleted. Tested. |
| 11 NIT (iOS stale preview) | Resolved | The field is cleared when the folder key changes. It only clears while `!nameEdited`, and since `nameEdited` is set only by the field's own setter (`SessionCreateSheet.swift:341`), the programmatic clear does not mark the field as edited. |

### Judgement on the two deliberate choices

**(a) Older box: Connect / Disconnect / Try again derived from plain fields. Accepted.**
- The rule is four lines: out-of-credit → Try again; external credential → none; connected → Disconnect; else Connect. It reads fields both clients already hold, and it applies only while the box has given no row state.
- It is named (`fallbackControl` / `AccountRowState.fallbackControl`), documented in the spec's D4 cell as the single exception, and replaced as soon as `accounts:row-states` answers.
- The failure mode is benign. The box still refuses anything it can't do, and the flows already show refusals.
- It also covers a current box whose first read failed. That is strictly better than the controls disappearing.
- Small gap, accepted: the box also treats a usage reader's `exhausted` as out-of-credit, and the fallback only checks health. So such a row shows Disconnect instead of Try again until the box answers.

**(b) Strings the client keeps, plus a static line when the box stays silent past the limit. Accepted.**
- "Couldn't reach the server to check" is knowledge only the client has (the box can't report its own unreachability).
- The claude-login-exited line comes from the PTY the client drives.
- Past the client's deadline with no verdict, the box has not done what it promised, so the old "the box stopped waiting after 15 minutes" was a claim the client couldn't verify. A static "That didn't work. Try again." is the honest choice.
- **Minor cost (NIT R2-3 below):** for a re-sign, that static line drops the reassurance "<seat> was not changed", which the client does know.
- **Older-box cost, accepted under D24:** a box without `message` on its status replies now shows the static line for every sign-in failure. Before, it showed the specific sentence, including the emails for `different-account`.

### New problems (NIT only)

**R2-1 NIT — a failed seat lookup now hides a real sign-in failure.**
- **Where:** `src/server/accountsManager.mjs` (resign-status failure path).
- **Problem:** to word the sentence, the failure reply now calls `findSeatView(await providerView(…))`. If that read throws, the channel turns a definite "failed" verdict into the generic thrown error. The client then reads it as unreachable and keeps polling until its own limit.
- **Fix:** wrap the lookup in `try` and fall back to `seatLabel: undefined` (the sentence already handles "The seat").

**R2-2 NIT — desktop shows a failure instead of the update note on an older box while the capability is unknown.**
- **Where:** `src/renderer/AccountsCard.tsx` `loadRowStates`.
- **Problem:** while `accounts-copy-1` is still `null`, an older box answers "unknown rpc channel". That is recorded as `failed`, so the card shows "Couldn't load account states. Retry" instead of the update note until the capability resolves. iOS already separates the two cases.
- **Fix:** treat `isUnknownChannelError` like `accountsCopyCap === false`.

**R2-3 NIT — the re-sign abandon line drops a reassurance the client knows.**
- **Where:** `ResignSeatFlow.tsx` / `AccountsSignInFlow.swift` (`.abandon(unreachable:false)`).
- **Problem:** the static "That didn't work. Try again." no longer says the seat was not changed, though the client knows it.
- **Fix:** append the client-known clause: "That didn't work. <seat> was not changed — try again."

**R2-4 NIT — "Checking your box…" can stay up indefinitely.**
- **Problem:** this happens when the capability read is `failed` with no earlier success, including after a 401, which deliberately stops the retries.
- **Fix:** distinguish `failed` ("Couldn't check your box — retrying" with a Retry) from `loading`.

VERDICT: APPROVE
