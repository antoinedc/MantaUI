# Code review — WS03 composer (commit `70d75cc7`)

Scope read in full: `ComposerModels.swift`, `ComposerInsertion.swift`,
`ComposerTextController.swift`, `ComposerTypeaheadSources.swift`,
`MantaAPIClient+Composer.swift`, `ComposerTypeahead.swift`, the `ComposerView.swift`
diff plus every region it touches (send button, submit / submitSlash, palette, mention
popup, keyboard bar, voice submit, confirm dialog), the `ChatScreen.swift` adoption
(M-03-1…4), and the four test files. Cross-checked against `00-master.md` (C3, D2/D11,
D13, ledger M-03-*, registry), `03-composer.md` (incl. round-2 responses),
`mobile/native/AGENTS.md`, and the server handlers for `opencode:run-command` /
`opencode:prompt`.

Overall: well-structured and close to spec. Every registry symbol WS03 owns exists with
the pinned signature (`ComposerTextController` members, `ComposerInsertMode`,
`ComposerInsertion.AttachRejection`, `EnvironmentValues.composerController`,
`ChatScreen(…, draft:)`, `ComposerTypeahead.agentRows(agents:loadError:query:limit:)`,
`OpencodeCommandInfo`, `OpencodeReferenceInfo`, `commands(directory:)`, `references()`,
`runCommand(_:)`); WS10's `ExtensionsReferencesScreen` already compiles against
`references()`. No duplicate type names across `MantaUI/`. Swift 6 isolation looks
right (`@MainActor` stores, Sendable `MantaAPIClient` captured into `async let`, the
EnvironmentKey default is a MainActor class, so Sendable). The `onGeometryChange` /
trailing-`action:` form matches existing uses in the same file. The pure logic is well
tested. One BLOCKING behaviour bug: the seed notice is never shown. Three SHOULDs.

## Findings

### 1. BLOCKING — the "N attachments couldn't be carried over" notice is never shown
`ChatScreen.swift:386` (with `ComposerView.swift:338-342`).
`onAppear` calls `store.start()` → `load()`, which sets `store.loading = true`
synchronously, and only then sets `store.actionHint = notice`. On the next render
`content` switches to `ChatLoadingSkeleton` (`ChatScreen.swift:509-517`), so
`ComposerView` (the only consumer of `actionHint`) is unmounted in that same update.
When loading finishes, ComposerView mounts again with `actionHint` already set. A plain
`.onChange(of:)` does not fire for the value present at mount, so the hint never shows.
It also stays set and is overwritten by the next hint. A new chat from the create flow
always goes through this skeleton. So F7's acceptance ("a rejected attachment shows the
notice once") and C3's rule that every rejection is shown to the user both fail. The
existing handoff `skippedUploads` hint (`ChatScreen.swift:714-718`) has the same latent
bug.
**Fix:** in `ComposerView.swift:338`, change it to
`.onChange(of: store.actionHint, initial: true) { _, hint in … }`. The body is unchanged:
it surfaces the hint and then sets `store.actionHint = nil`, so the hint cannot show
twice. This fixes both the seed notice and the handoff hint. Add an acceptance note: open
a new chat with a draft that has one relative-path attachment, and the notice appears
once after the skeleton.

### 2. SHOULD — the Clear dialog now wipes the draft even when the clear fails
`ComposerView.swift:355-358`.
The dialog's Clear now runs `onSlashClear?(); text = ""`. `onSlashClear` is
`Task { await clearSession() }` (`ChatScreen.swift:586`), which is async and can fail with
"Clear failed — the session is still there" (`ChatScreen.swift:957-972`). The draft has
already been emptied by then. The keyboard-bar **Clear** key (`ComposerView.swift:536-539`)
opens the same dialog while the user may hold a real draft, so a failed clear now loses
the user's text. Before this change the draft survived. On success, emptying adds
nothing: `onCleared` sets `carryOver = nil` and the swap rebuilds `ChatScreenContent`
under a new `.id(sid)`, so a fresh, empty controller replaces this one anyway.
**Fix:** remove `text = ""` from the dialog's Clear button (keep `onSlashClear?()`).
Update the comment: a successful clear rebuilds the screen with an empty composer, and a
failed one leaves the draft (including a typed `/clear`) in place next to the failure
hint.

### 3. SHOULD — the in-flight spinner hides **Stop** while a turn is running
`ComposerView.swift:1305-1316` (`sendButton`).
`submitInFlight` is checked first, so the spinner replaces both the running send menu and
the Stop button. This happens in two cases:
- On the `.prompt` path, `sendOrSteer` → `deliver` sets `running = true` immediately and
  then awaits `opencode:prompt` (`ChatSessionStore.swift:1478-1505`).
- On the `.command` path, the turn starts (via the `running` frame) while the
  `opencode:run-command` POST is still pending, and the server first awaits
  `syncSessionControls` (`opencode.mjs:2988`).

During that window the user cannot stop a turn that has visibly started. A slow box
makes the window long.
**Fix:**
```swift
if submitInFlight && !store.running { spinner }
else if store.running && canSend { runningSendMenu }
else { Button(... store.running ? store.abort() : submit() ...) }
```
`canSend` already includes `!submitInFlight`, so a running in-flight send shows Stop. The
double-send guard stays in `submit()`.

### 4. SHOULD — a voice transcript during an in-flight send overwrites the draft and is silently not sent
`ComposerView.swift:1221-1224`.
`submitVoiceTranscript` does `text = transcript; submit()`. While `submitInFlight` is
true, `submit()` returns at its first guard with no message. The dictation now sits in
the composer unsent and has replaced whatever was typed. The settle step then keeps it,
because `text != snapshot.text`. That is a silent no-op on a user action, which root
AGENTS.md forbids.
**Fix:** at the top of `submitVoiceTranscript`, check `submitInFlight`. If it is true, do
`text = HandoffComposerCarry.appendBelow(text, transcript)` and
`surfaceHint("Still sending — your dictation is in the composer")`, then return.
Otherwise keep today's path.

### 5. NIT — "Nothing to quote" is the wrong copy when the composer is read-only
`ChatScreen.swift:1022-1024`. `insert` also returns `false` when
`acceptsInput == false`, which happens once M-03-7 lands in wave B. This is already
recorded in `_integration-notes.md:18`.
**Fix (WS02, with M-03-7):**
`store.actionHint = composer.acceptsInput ? "Nothing to quote" : "This chat is read-only"`.

### 6. NIT — `apply(_:)` silently drops the draft text when insertion is refused
`ComposerTextController.swift:113-124`. The `insert(.append)` result is discarded and only
attachment rejections are counted. This is harmless today, because the only caller is the
seeding init, where `acceptsInput` is always `true`. If a later caller applies a draft to
a read-only composer, though, its text vanishes without notice.
**Fix:** `guard acceptsInput else { return draft.attachments.count }` (or document that
`apply` must only be called on a writable composer).

### 7. NIT — tautological assertions in the `/fork` settle test
`MantaUITests/ComposerModelsTests.swift:74-79`. These lines build two local arrays and
assert they are equal. They test nothing in the composer.
**Fix:** delete lines 74-79. The meaningful part (`localAction` returning `""` / the edited
text) is already asserted at lines 71-72.

### 8. NIT — a background run while busy shows "Send after this turn"
`ComposerView.swift:1343-1347`. When `isBackgroundRun` is true, the running send menu's
label reads "Run in background", but the long-press and the accessibility action still
offer "Send after this turn". Delivery is ignored for a background run, so both do the
same thing.
**Fix:** when `isBackgroundRun`, render the plain Button, not `runningSendMenu`. A
background run never joins the turn.

### Notes (no action)
- `verify.sh` cannot build until IA applies M-03-8. `ComposerTypeahead.swift` is already
  in `Package.swift` and now depends on `ComposerModels.swift`. This is documented in the
  spec. IA must land M-03-8 before anything else relies on `verify.sh`.
- `agentsLoadError` / `retryAgents` are nil stubs until M-03-6 (IB), as specified. The
  retry row is not rendered as tappable until then, so it is not a dead control.
- `submitSlash`'s orchestration lives in the view and is covered only by acceptance
  checks, as the spec allows. The pure planner, settle and insertion rules are well
  tested.

Counts: 1 BLOCKING, 3 SHOULD, 4 NIT.

VERDICT: CHANGES REQUIRED
