# WS03 — Composer: `/` commands + skills, `@` agents + references, insertion API (C3)

Status: revised (round 2) · Wave: **A1** (D20) · Depends on: wave-0 foundation (C1 helpers are
already `internal`, `MantaAPIClient.swift:944-984`; `NewSessionDraft` /
`NewSessionDraftAttachment` scaffolded in `MantaNavigation.swift` per D2) · Provides:
**C3** (`ComposerTextController`, `insert`, `attach`, `newSessionDraft(cwd:)`, the
`composerController` environment value, and its adoption in `ChatScreen.swift` per D3/D13).

Ownership: `ComposerView.swift`, `ComposerTypeahead.swift`, `ComposerHistory.swift`, new
`Composer*` files, `MantaAPIClient+Composer.swift`, `MantaUITests/Composer*Tests.swift`, and
the **D13 exception**: the composer-adoption edits in `ChatScreen.swift` listed under
"Files" (wave A, additive/minimal). **No server change** — every channel used already
exists and is the one the desktop calls.

| # | Feature |
|---|---|
| F1 | Custom opencode slash commands + skills in the `/` palette |
| F2 | Sending a typed `/command args` (opencode command / skill / Manta built-in) |
| F3 | "Run in background" for a command or skill |
| F4 | `@` references (configured aliases) in the `@` typeahead |
| F5 | `@@` agent mentions (+ fix of the iOS file-mention wire bug) |
| F6 | C3 composer insertion API + adoption in ChatScreen |
| F7 | C3 `NewSessionDraft` producer / consumer helpers (type owned by D2, not declared here) |

---

## What iOS has today (do not duplicate)

- `ComposerTypeahead.swift` (184 lines, Foundation-only, already in `Package.swift`): pure
  `detectMention` / `applyMention` (`@file`), `detectSlash`, a **fixed** palette
  `slashCommands(running:)` (`submit`, `compact`, `clear`, `fork`, `handoff`, `abort`),
  `filterSlashCommands`, `goalAfterCommand`, `isHandoffCommand`. No server command list.
- `ComposerView.swift`:
  - `ComposerAttachment` (26-37: `let id = UUID()`, `filename`, `mime`, `remotePath?`, `isImage`);
  - typeahead state `activeMention`, `fileResults`, `draftMentions`, `fileSearchTask`,
    `fileSearchSeq` (158-171); popups above the input (194-205); `slashPalette`
    (1442-1450), `mentionTypeahead` (1453-1486), `slashPaletteView` (1490-1523);
    `handleTextChange` (1528-1538), `searchFiles` 250 ms / cap 10 (1542-1553), `selectFile`
    (1557-1567), `performSlash` (1571-1592 — `.clear` calls `onSlashClear` **directly**,
    1577-1578, bypassing the confirm dialog at 348-354);
  - `submit(delivery:)` (1379-1421): special-cases `/handoff`, else always
    `store.sendOrSteer` → `opencode:prompt`; no in-flight guard; `canSend` (1341-1344) checks
    only text + uploads. Entry points: send button (1301, 1317, 1324, 1329), keyboard bar
    (780, 788, 797), palette `.submit` (1574), voice (`submitVoiceTranscript`, 1213-1216);
  - composer hint capsule `surfaceHint(_:)` (1641).
- `ChatModelStore.agents` (`ChatModelStore.swift:60-63`, owned by **WS09** per D1), loaded once
  by `loadAgentsIfNeeded()` (135-143) from `ChatScreen.swift:363`. It sets `didLoadAgents`
  before the request and turns every error into `[]` — a failure is indistinguishable from
  an empty catalog and never retried (see M-03-5).
- `MantaAPIClient.findFiles` (312-316), `agents()` (355-359), `sendPrompt` (63-110).
- Quote (BET-1353): `QuoteText.buildQuoteBlock` (`SessionModels.swift:976-1012`, port of
  desktop `chatUtils.ts:581`); `ChatScreen.quote(_:into:)` (995-1012) **prepends** the block
  to `composerText`; "Quote in new session" forks (`forkSession(seed:)`, 968-993) — kept per D12.
- Composer state lives in ChatScreen: `@State composerText` (264), `composerAttachments`
  (269), `@FocusState composerFocused` (282), seeded in `init` (297-309), bound into
  ComposerView (574-576), read by handoff (459, 710-712, 733-734, 741-742) and quote (1004-1005).
  `mobile/native/AGENTS.md:46` names a `ComposerTextController`; **it does not exist** — F6
  creates it.
- `HandoffComposerCarry.appendBelow` (`HandoffModels.swift:482-493`) — the existing
  "blank line between, never overwrite" join; F6 `.append` reuses it.

### Bug fixed by F5
iOS records a chosen **file** as a `SendPromptInput.Mention` (`ComposerTypeahead.swift:79-94`,
appended in `selectFile`). The server turns every mention into an **agent** part
(`opencode.mjs:671-676`), so iOS sends file paths as agent names. The desktop sends file and
reference mentions as plain `@text`; only agent selections become mentions
(`useTypeahead.ts:295-318`).

### Desktop bug (reported, not fixed here — D10)
`useTypeahead.ts:177-194` uses `left.lastIndexOf("@")`; for `@@pl` that is the second `@`,
whose predecessor is `@`, so detection returns `null` (verified on `"@@"`, `"@@bu"`,
`"hi @@pl"`). The desktop agent typeahead never opens. It is renderer-only, so per D10 it is
**out of scope** and listed in the end-of-effort report. iOS implements the intended grammar.

---

## F1 — Custom slash commands + skills in the `/` palette

### Desktop behaviour
- `/` as the first character with the caret in the first word opens the command typeahead
  (`useTypeahead.ts:161-174`).
- The list loads lazily the first time the text starts with `/`, per session directory;
  a directory change reloads (`useTypeahead.ts:98-124`). Failure is silent.
- Rows (`useTypeahead.ts:221-238`): Manta built-ins first (`chatUtils.ts:629-636`), then
  opencode commands/skills minus built-in names (`dedupeAgainstBuiltins`, 610-615), each
  filtered case-insensitively by *name contains query* (`filterCommands`, 597-604); cap **12**.
  Row = `/name` + description. Empty copy **"No matching commands"** (`Composer.tsx:68-74`).
- Selecting a row **inserts** `/name ` and puts the caret after it; nothing runs
  (`useTypeahead.ts:295-326`). Popup max 240 px, scrolls (`ComposerParts.tsx:392`).

### Wire contract
`opencode:commands` — `useTypeahead.ts:110` → `httpApi.ts:1434` → `rpc.mjs:1973-1977` →
`opencode.mjs:2856-2875`.
- Args: `[]` or `[{ "directory": "<session cwd>" }]`.
- Success: **always an array** `[{ name, description?, source?: "command"|"project"|"global"|"skill", argumentHint?, agent?, model?, template?, background?: true }]`
  (`types.ts:3056-3067`). Skills are merged by the server (`source: "skill"`); a skill hides a
  same-named command. `background: true` = always runs in the background (F3).
- Error: reject with a message.

### iOS design
- Wire types in new **`ComposerModels.swift`** (Foundation-only → added to `Package.swift`
  by the integration step, M-03-8):
  ```swift
  struct OpencodeCommandInfo: Decodable, Equatable, Sendable {
      var name: String
      var description: String?
      var source: String?
      var argumentHint: String?
      var background: Bool?
      var isSkill: Bool { source == "skill" }
  }
  ```
- `MantaAPIClient+Composer.swift`:
  ```swift
  func commands(directory: String?) async throws -> [OpencodeCommandInfo] {
      let args: [Any] = directory.map { [["directory": $0]] } ?? []
      return try await callRequired("opencode:commands", args: args, as: [OpencodeCommandInfo].self)
  }
  ```
  `callRequired` (`MantaAPIClient.swift:954-959`) so a `null`/missing result **throws** instead
  of becoming an empty "loaded" catalog (which would make F2 send a real command as a prompt).
- New **`ComposerTypeaheadSources.swift`**: `@MainActor final class ComposerTypeaheadSources: ObservableObject`,
  no-argument `init()` (held as `@StateObject` in ComposerView, so its memberwise init is
  unchanged):
  ```swift
  enum Load<T: Equatable & Sendable>: Equatable { case idle, loading, loaded(T), failed(String) }
  @Published private(set) var commands: Load<[OpencodeCommandInfo]> = .idle
  @Published private(set) var references: [OpencodeReferenceInfo] = []   // F4
  @Published private(set) var fileResults: [String] = []                 // moved from ComposerView
  @Published private(set) var fileSearching = false
  func ensureCommands(api: MantaAPIClient, directory: String?)           // in-flight dedupe; reload on directory change; .failed → next call retries
  func awaitCommands(api: MantaAPIClient, directory: String?, timeout: Duration) async -> [OpencodeCommandInfo]?  // F2, nil on timeout/failure
  func search(api: MantaAPIClient, query: String, directory: String?)    // F4: 250 ms debounce, seq guard
  func cancelSearch()
  ```
  Cached per directory for the life of the composer (desktop: one fetch per panel per
  directory). `fileResults` / `fileSearchTask` / `fileSearchSeq` move here out of ComposerView.
- `handleTextChange`: when text starts with `/`, `sources.ensureCommands(api:directory: sessionDirectory)`.
- Pure palette logic (`ComposerTypeahead.swift`):
  ```swift
  enum SlashAction: Equatable { case submit, compact, clear, fork, handoff, abort
                                case insert(name: String) }          // NEW
  struct SlashCommand { id, title, subtitle, kind, isSkill: Bool = false }
  static let builtinIDs: Set<String> = ["submit","compact","clear","fork","handoff","abort"]
  static func paletteRows(builtins: [SlashCommand], remote: [OpencodeCommandInfo], query: String, limit: Int = 12) -> [SlashCommand]
  static func applySlashInsertion(name: String, to text: String) -> String
  ```
  Order: filtered built-ins, then remote rows with `name ∉ builtinIDs` filtered by name
  contains query (case-insensitive); cap 12. Remote row: `id = name`, `subtitle =
  description ?? ""`, `kind = .insert(name:)`.
- View: rows in a `ScrollView` capped at **240 pt**; `/name` + subtitle (hidden when empty);
  skill rows show a quiet trailing `Text("skill")` (`tx3`). Accessibility id
  `slash-row-<name>`.
- States while `detectSlash` returns an anchor:
  - `.loading`/`.idle` and no built-in matches → non-tappable **"Loading commands…"**;
  - `.loaded` and nothing matches → non-tappable **"No matching commands"**;
  - `.failed` and no built-in matches → tappable **"Couldn't load this project's commands — tap to retry"** → `ensureCommands`.
- Selecting `.insert(name:)` → `text = applySlashInsertion(...)`, keep focus, nothing runs.
- **Built-in `/clear` from the palette goes through the confirm dialog** (finding 4):
  `performSlash(.clear)` sets `showClearConfirm = true` (does not call `onSlashClear`);
  the dialog's Clear runs `onSlashClear?()` and empties the draft; Cancel leaves the draft
  untouched. `performSlash` clears the text only for the other non-submit actions, as today.
  Both entry points (palette, typed Send in F2) share this one dialog.

### Tests (`ComposerTypeaheadTests.swift`, runs under `verify.sh`)
- `paletteRows`: built-ins first; case-insensitive name match; remote `compact` dropped;
  cap 12; skill flag; empty description → empty subtitle.
- `applySlashInsertion`: `"/re"` → `"/review "`; `"/re some args"` → `"/review some args"`;
  `"/"` → `"/review "`.
- `OpencodeCommandInfo` decodes a fixture with extra keys and `background: true`; decoding a
  JSON `null` into `[OpencodeCommandInfo]` fails (documents why `callRequired` is used) while
  `[]` succeeds as an empty list.

### Acceptance
- [ ] A project command `review` is listed below the built-ins when typing `/re`.
- [ ] Skills appear, tagged "skill"; a remote `compact` appears once.
- [ ] Tapping `/review` gives `/review ` with the keyboard up; nothing is sent.
- [ ] Box unreachable → retry row; tapping it refetches.
- [ ] Palette `/clear` shows "Clear this session?"; Cancel keeps the draft; Clear resets.
- [ ] More than 5 rows scroll inside ≤240 pt; the composer does not jump.

---

## F2 — Sending a typed `/command args`

### Desktop behaviour
`ChatPanel.submit` (1702-1760, 1897-1920): split `^/(\S+)(?:\s+([\s\S]*))?$`
(`backgroundRun.ts:125-128`); built-in → run locally; name in the session's list →
`opencode:run-command { sessionId, command, arguments, model, agent, attachments }`; else
`opencode:prompt`. While running (`sendWhileBusy` 1467-1560, `planBusySend`
`inboxState.ts:122-137`): built-in → **"Stop the agent or wait for it to finish before /<name>"**;
known command → run-command with `delivery`, no model/agent/mentions. Busy sends snapshot the
submitted attachments and remove only those ids on success (1580-1588, 1605-1613), clear the
text only if unchanged (`shouldClearDraft`, `inboxState.ts:144-146`), and guard re-entry
(`busyInFlightRef`, 1576).

### Wire contract
`opencode:run-command` — `httpApi.ts:1450` → `rpc.mjs:2047-2067` → `opencode.mjs:2967-3023`.
- Args `[{ sessionId, command, arguments, model?: {providerID, modelID, variant?}, agent?, attachments?: [{remotePath, mime, filename?}], delivery?: "steer"|"queue", background?: boolean }]`
  (`api.ts:1657-1673`). Skills are sent by the server as a prompt with the skill attached
  (`opencode.mjs:2973-2986`). Invalid delivery rejects (`rpc.mjs:636-640`); a refused command
  rejects `opencode runCommand <status>: <text>`.
- Response `null` or `{ jobId }` (F3). The command turn then streams normally (rendering is
  WS01/WS02 via D15's `commandByMessageID`).

### iOS design
- `ComposerModels.swift`:
  ```swift
  struct RunCommandResult: Decodable, Equatable, Sendable { var jobId: String? }
  /// Snapshot taken synchronously at submit, before any await.
  struct ComposerSubmission: Equatable, Sendable {
      let text: String                  // the raw draft at submit
      let attachmentIDs: Set<UUID>      // READY chips sent
      let agentNames: [String]
  }
  enum ComposerSubmissionSettle {
      /// After the box ACCEPTED a message/command: drop only the submitted chips; clear text +
      /// agent selections only if the draft is still exactly the submitted text.
      static func accepted(_ s: ComposerSubmission, text: String, attachments: [ComposerAttachment],
                           agentNames: [String]) -> (text: String, attachments: [ComposerAttachment], agentNames: [String])
      /// After a LOCAL built-in (/compact, /fork, confirmed /clear) was triggered: nothing was
      /// sent, so chips and agent selections are never touched; only the typed command text is
      /// consumed, and only if the draft is still exactly the submitted text.
      static func localAction(_ s: ComposerSubmission, text: String) -> String
  }
  ```
  `ComposerAttachment` moves verbatim from `ComposerView.swift:26-37` into
  `ComposerModels.swift` (UUID only → Foundation-only), so this logic runs under `verify.sh`.
  Failure needs no settle function: the command path never clears anything before acceptance.
- `MantaAPIClient+Composer.swift`:
  ```swift
  struct RunCommandInput: Sendable {
      var sessionId: String; var command: String; var arguments: String
      var model: SendPromptInput.Model?; var agent: String?
      var attachments: [SendPromptInput.Attachment]
      var delivery: String?; var background: Bool = false
  }
  func runCommand(_ input: RunCommandInput) async throws -> RunCommandResult?   // "opencode:run-command"
  ```
  `model` encoded exactly like `sendPrompt` (`MantaAPIClient.swift:63-77`); omit nil/false
  keys; always send `arguments` and `attachments` (may be empty). `call` (not
  `callRequired`): `null` is a legitimate success.
- Pure plan (`ComposerTypeahead.swift`):
  ```swift
  enum SlashSendPlan: Equatable {
      case prompt
      case builtin(SlashAction)          // .compact / .clear / .fork
      case refuse(String)
      case command(name: String, args: String, alwaysBackground: Bool)
  }
  static func splitSlashText(_ text: String) -> (name: String, args: String)?
  static func planSlashSend(text: String, running: Bool, remote: [OpencodeCommandInfo]?) -> SlashSendPlan
  ```
  Typed built-ins considered: `compact`, `clear`, `fork` (`/handoff` keeps its existing
  `isHandoffCommand` branch, checked first, unchanged; typed `/submit`/`/abort` are prompts).
- **Submission guard** (finding 5): `@State private var submitInFlight = false`.
  `submit(delivery:)` returns immediately when `submitInFlight`; `canSend` also requires
  `!submitInFlight` (the send glyph shows a `ProgressView` while true). Every entry point
  listed above already calls `submit()`, so all are covered. Flow:
  1. `/handoff` branch (unchanged).
  2. If the trimmed text starts with `/` and is not handoff: **synchronously** set
     `submitInFlight = true` and capture the user's **payload** — `snapshot =
     ComposerSubmission(text:, attachmentIDs: ready chip ids, agentNames:)`, `ready:
     [SendPromptInput.Attachment]`, the chosen `delivery` preference (Now / After this turn),
     `modelPref = modelStore.promptModel`, `planAgentPref`, `background` (F3) — then start one
     `Task { @MainActor in … }` that releases `submitInFlight = false` on every exit path
     (a single `defer` at the top of the task body). **Session state (`store.running`, the
     mutation policy after M-03-9) is NOT snapshotted** — it may change during the lookup.
  3. In the task: `remote = sources.loaded list` or `await sources.awaitCommands(timeout: .seconds(3))`
     (nil → treated as unknown). Payload comes from the snapshot, never the live draft.
  4. **Immediately before dispatch**, re-read the live state: `let runningNow = store.running`
     (and, after M-03-9, `store.mutationPolicy`). Then
     `planSlashSend(text: snapshot.text.trimmed, running: runningNow, remote:)`:
     - `.prompt` → `store.sendOrSteer(text:attachments:model:mentions:agent:delivery:)` with the
       snapshot payload (the store itself re-checks `running` at dispatch,
       `ChatSessionStore.swift:1276-1290`, and owns failure recovery via failed pending rows,
       exactly like today's synchronous path), then `ComposerSubmissionSettle.accepted`;
     - `.builtin(.compact)` → `store.compact()`, then `localAction`; `.clear` →
       `showClearConfirm = true` (draft untouched; the dialog's Clear runs `onSlashClear` —
       which swaps the session and rebuilds the screen); `.fork` → `onSlashFork?()`, then
       `localAction` — **chips and agent selections stay in this composer whether the fork
       succeeds or fails** (the callback is `Void` and fork failures are reported by ChatScreen
       itself, `ChatScreen.swift:968-993`); a nil callback → `.prompt`;
     - `.refuse(msg)` → `surfaceHint(msg)`, draft untouched;
     - `.command` → `runCommand` with the snapshot payload: if `runningNow` (and not
       background) → `delivery: <preference>.wire`, `model: nil`, `agent: nil`; if idle →
       `delivery: nil`, `model: modelPref`, `agent: planAgentPref`; background → F3.
       So a turn that started during the lookup gets a steer/queue delivery (no model sync,
       `opencode.mjs:2987-2992`), and a turn that ended during the lookup gets an ordinary idle
       command instead of a refusal.
  5. Command success → `PromptHistoryStore.append`, apply `ComposerSubmissionSettle.accepted`
     to the live `text` / `attachments` / `agentMentionNames`, then `store.refreshInbox()` if
     it was a running-turn send else `await store.refetch()`.
  6. Failure → nothing cleared; `surfaceHint("Couldn't run /<name> — \(message)")` using the
     `MantaError` server/transport text.
  7. After M-03-9 (wave B): an EXHAUSTIVE dispatch gate on `store.mutationPolicy`, evaluated
     immediately before the direct `runCommand` / local built-in action (i.e. AFTER the
     async command lookup), and re-evaluated inside a delayed Clear confirmation's callback:
     `.allowed` → dispatch; `.resolving` → `surfaceHint("One moment — checking this session")`;
     `.readOnlyJob` → `surfaceHint("This is a background job — it can't take messages")`.
     In both refusal cases: no RPC, no cleanup, draft + chips untouched (a command cannot be
     parked in WS02's prompt outbox). `.prompt` still goes to `sendOrSteer`, which WS02 guards.
     Integration tests (M-03-9): (a) submit `/cmd` while `.resolving` with the command lookup
     suspended, flip ownership to a job, release lookup → zero command RPCs, draft/chips kept;
     (b) same but resolve to `.allowed` → exactly one command RPC.
  Plain (non-`/`) text keeps today's synchronous path untouched.
- No optimistic transcript row (that pipeline is WS02's store); the spinner covers the gap.

### Tests
`ComposerTypeaheadTests.swift`:
- `splitSlashText`: `"/review"` → (`review`, `""`); `"/review  a b\nc"` → (`review`, `"a b\nc"`);
  `"hello"`, `"/"` → nil.
- `planSlashSend`: known → `.command`; `/usr/bin is slow` → `.prompt`; `/compact` idle →
  `.builtin(.compact)`; `/compact` running → `.refuse("Stop the agent or wait for it to finish before /compact")`;
  known while running → `.command`; `remote == nil` → `.prompt`; `background: true` →
  `alwaysBackground`.
New `ComposerModelsTests.swift` (runs under `verify.sh`):
- settle, unchanged draft → text + mentions cleared, submitted chips removed;
- **a chip added during the request survives** (only snapshot ids removed);
- **text edited during the request survives** with its agent selections, while submitted
  chips are still removed (no double send);
- snapshot ids already removed by the user → no crash, nothing else removed;
- `localAction` (`/fork` with one ready chip + one agent selection): returns `""` when the
  draft is unchanged and the edited text when it changed; the caller never passes chips or
  agents to it, so both survive — asserted by a test that runs `localAction` and then checks
  the untouched arrays for the "fork succeeded" and "fork failed" cases (the composer's
  behaviour is identical because it does not learn the fork's outcome).
`ComposerTypeaheadTests.swift` also covers the dispatch-time re-read: `planSlashSend` for the
same snapshot text with `running: false` vs `true` (idle→running: `.command` either way, the
caller picks delivery from `runningNow`; running→idle for `/compact`: `.refuse` becomes
`.builtin(.compact)`).
Guard behaviour (a view `@State`) is covered by acceptance below.

### Acceptance
- [ ] `/review the auth module` + Send (idle) runs the command; the literal text is not posted.
- [ ] A skill + Send runs the skill inline.
- [ ] While running, `/review x` + Send delivers with the chosen delivery and shows in the pending card.
- [ ] `/compact` + Send while running shows the refusal hint; draft kept.
- [ ] A refused command keeps text + chips and shows "Couldn't run /<name> — …".
- [ ] Two rapid Sends during the command-list wait dispatch once.
- [ ] Editing the draft or adding a chip during the request keeps the edit / new chip.
- [ ] `/fork` with a ready chip: the chip stays in the original composer after a successful
      fork and after a failed one.
- [ ] Idle when Send is tapped, a turn starts during the command-list wait → the command goes
      out with the chosen delivery and appears in the pending card (no model switch).
- [ ] Running when Send is tapped, the turn ends during the wait → an idle command runs (with
      model/agent); `/compact` in the same situation compacts instead of being refused.
- [ ] (after M-03-9) A command sent while the session is still being checked shows
      "One moment — checking this session" and keeps the draft.
- [ ] `/usr/local is full` is sent as a normal message.

---

## F3 — "Run in background"

### Desktop behaviour
When the first token is a known opencode command/skill (never a built-in), a **"Run in
background"** checkbox appears (`ChatPanel.tsx:539-556`, `backgroundRun.ts:81-108`,
`SlashComposerParts.tsx:68-110`); checked → helper "— runs in its own session, without this
chat's history; the result comes back here" (`backgroundRun.ts:102-103`); always-background
commands → checked + disabled, title **"This command always runs in the background"**. The box
resets when the token stops matching. Send button reads "Run in background"
(`InputArea.tsx:620-651`). Send = run-command with `background: true`, no `delivery`, model +
plan agent included, idle or busy (`ChatPanel.tsx:1569-1620`); composer cleared only on accept.

### Wire contract
Same channel, `background: true`. Server (`rpc.mjs:679-702`): `{ jobId }` (wrapped job) or
`null` (always-background); rejects e.g. `"/<name>" isn't an opencode command or skill, so it
can't run in the background`, `background runs aren't available on this box`, or the job cap
error. The job appears in the existing background-jobs surface (`BackgroundJobsSheet.swift`;
cards are WS02's).

### iOS design
- Pure: `static func backgroundState(text: String, remote: [OpencodeCommandInfo]?) -> BackgroundToggleState?`
  (`struct BackgroundToggleState: Equatable { name: String; locked: Bool }`).
- ComposerView `@State runInBackground = false`, reset in `onChange(of: text)` when the state
  becomes nil. When visible: a row above the input box with `Toggle("Run in background")`
  (small, `tx2`), forced on + disabled when `locked` (accessibility hint = locked title), and a
  helper line kept in layout with `.opacity(on ? 1 : 0)` so toggling never resizes the composer.
- The flag is captured into the F2 snapshot; `.command` then calls `runCommand` with
  `background: true`, `delivery: nil`, model + plan agent. Send accessibility label
  "Run in background".
- Success hint **"Running /<name> in the background — the result comes back here"**; failure →
  draft kept, hint with the server message.

### Tests
`backgroundState`: built-in → nil; unknown → nil; known → unlocked; `background: true` → locked;
nil remote → nil.

### Acceptance
- [ ] `/review` shows the toggle; `/compact` and plain text do not.
- [ ] Always-background command → toggle on and disabled.
- [ ] Toggling does not change the composer height.
- [ ] A background send never interrupts a running turn and reports success/failure.

---

## F4 — `@` references in the typeahead

### Desktop behaviour
Same `@` trigger as files; references fetched on the same debounced tick as the file search
(`useTypeahead.ts:132-157`). Rows: non-hidden references whose name contains the query
(case-insensitive) first, then files; cap 20 (263-282). Selecting inserts `@alias ` as plain
text (305-310). References are managed in Settings (WS10).

### Wire contract
`opencode:references` — `httpApi.ts:1437` → `rpc.mjs:1992` → `opencode.mjs:2931-2950`. Args
`[]`. Success: always an array `[{ name, path?, repository?, branch?, description?, hidden? }]`
(`types.ts:3083-3091`). HTTP error rejects.

### iOS design
- `ComposerModels.swift`:
  ```swift
  struct OpencodeReferenceInfo: Decodable, Equatable, Sendable {
      var name: String; var path: String?; var repository: String?
      var branch: String?; var description: String?; var hidden: Bool?
  }
  struct MentionRow: Equatable, Identifiable, Sendable {
      enum Kind: Equatable, Sendable { case reference, file, agent, status(tappable: Bool) }
      let id: String; let kind: Kind; let insertText: String; let title: String; let subtitle: String
  }
  ```
- `MantaAPIClient+Composer.swift`: `func references() async throws -> [OpencodeReferenceInfo]`
  via `callRequired("opencode:references", args: [], …)`.
- `ComposerTypeaheadSources.search` runs `findFiles` and `references()` concurrently and
  **independently** (a references failure keeps file results; desktop's `Promise.all` loses
  both). Seq guard as today.
- Pure: `static func mentionRows(query: String, references: [OpencodeReferenceInfo], files: [String], limit: Int = 20) -> [MentionRow]`
  — reference title `@alias`, subtitle `description ?? repository ?? path ?? ""`, icon `link`
  (repository) / `folder` (path).
- States: searching with no rows → **"Searching…"**; finished empty → **"No matching files"**.
- Selecting a reference/file: `applyMentionToken(_:to:anchor:) -> (text: String, caret: Int)`
  replaces the anchor with `@<insertText> `; **no** mention recorded.

### Tests (`ComposerTypeaheadTests.swift`)
`mentionRows`: hidden excluded; references first; case-insensitive; cap 20; subtitle fallback.
`applyMentionToken`: exact UTF-16 range (emoji before the token) + one space.
`OpencodeReferenceInfo` decode fixture; `null` → decode failure.

### Acceptance
- [ ] Reference `docs` → typing `@do` lists `@docs` above files; hidden ones never appear.
- [ ] References failure → files still listed.
- [ ] Choosing `@docs` inserts `@docs `; the sent prompt has no `mentions`.

---

## F5 — `@@` agent mentions (+ file-mention wire fix)

### Desktop behaviour (intended)
`@@` token at BOF/after whitespace → agent mode, query after `@@` (`useTypeahead.ts:187-188`);
rows = catalog agents whose name contains the query, cap 12 (239-250); empty copy **"No
matching agents"**. Selecting inserts `@name ` and records the name (307-317). At send,
mentions are resolved against the final text on word boundaries (`[A-Za-z0-9_]`), first
occurrence, dropped if gone (`chatShared.tsx:76-101`); prompt path only.

### Wire contract
`opencode:prompt` `mentions` (iOS encoder `MantaAPIClient.swift:99-109`) → server `body.agents`
(`opencode.mjs:671-676`). Offsets are UTF-16 (JS string indices = `NSString` units).

### iOS design
- `detectMention` returns `MentionAnchor { start, end, query, kind: .file | .agent }`: walk back
  to the start of the whitespace-delimited token; it must start with `@` at BOF/after
  whitespace; `@@` → `.agent` (query after `@@`), else `.file`.
- Agent rows: pure
  `static func agentRows(agents: [OpencodeAgent]?, loadError: String?, query: String, limit: Int = 12) -> [MentionRow]`:
  `agents == nil && loadError == nil` → status **"Loading agents…"** (not tappable);
  `loadError != nil` → status **"Couldn't load agents — tap to retry"** (tappable);
  filtered empty → **"No matching agents"**; else rows (`person.crop.circle`, `@name`,
  description).
- Source: `modelStore.agents` (no second fetch). Failure/retry needs WS09's store change
  (**M-03-5**) and its consumption (**M-03-6**). In wave A ComposerView passes
  `loadError: nil` and the retry row cannot appear; after M-03-6 it passes
  `modelStore.agentsLoadError` and tap → `modelStore.retryAgents()`.
- Selecting an agent: `applyMentionToken("@" + name)` and append to `@State agentMentionNames: [String]`
  (replaces `draftMentions`, which is removed).
- **Fix:** files/references record nothing. At submit (prompt path only):
  `mentions = ComposerTypeahead.resolveAgentMentions(text: <sent text>, names: agentMentionNames)`
  (port of `chatShared.tsx:76-101`), nil when empty — resolved against the exact sent
  (trimmed) text, which also removes today's offset mismatch between draft and trimmed text.

### Tests (`ComposerTypeaheadTests.swift`)
- `detectMention`: `"@@"` → agent `""`; `"hi @@pl"` → agent `pl`; `"@src"` → file; `"a@@b"` →
  nil; caret past token → nil.
- `agentRows`: nil/nil → loading; error → retry row; error then a later call with agents and
  nil error → rows (**failure → retry → loaded**); filter; cap 12.
- `resolveAgentMentions`: `@build` not inside `@builder`; deleted token dropped; offsets after
  emoji; duplicates once.
- Update the two existing `applyMention` tests to `applyMentionToken` (files produce no mention).

### Acceptance
- [ ] `@@` lists agents; `@@gen` narrows.
- [ ] Choosing `general` → `@general `; the sent prompt has one mention whose source slice is `@general`.
- [ ] Deleting the token before send → no mention. Choosing a file → no `mentions` key.
- [ ] (after M-03-5/6) agents failed → retry row → tap → agents listed.

---

## F6 — C3: composer insertion API + adoption

### Callers
WS01 Quote (raw selection through ChatScreen's quote callback), WS05 "Send failures to the
agent" (**`.append`**, D6), WS02 "Edit last" (`.replace` after its own confirm), WS07 Attach
artifact (`attach`), WS04 create flow (consumes `NewSessionDraft`, F7).

### Design
New Foundation-only **`ComposerInsertion.swift`** (→ `Package.swift`, M-03-8):
```swift
enum ComposerInsertMode: Equatable, Sendable { case append, replace, quote }

enum ComposerInsertion {
    /// nil = rejected (blank input, or quoteBlock returned nil). `.append` uses
    /// HandoffComposerCarry.appendBelow(draft, text): exactly one blank line between,
    /// just `text` when the draft is blank. `.replace` = text. `.quote` = quoteBlock(text) + draft.
    static func insert(_ text: String, into draft: String, mode: ComposerInsertMode,
                       quoteBlock: (String) -> String?) -> String?
    enum AttachRejection: Equatable, Sendable { case notAbsolute, duplicate, readOnly }
    static func checkAttach(remotePath: String, existing: [ComposerAttachment], acceptsInput: Bool) -> AttachRejection?
    static func makeChip(remotePath: String, displayName: String, mime: String) -> ComposerAttachment   // ready chip, isImage = mime hasPrefix "image/"
}
```
New **`ComposerTextController.swift`** (SwiftUI; app target only):
```swift
@MainActor final class ComposerTextController: ObservableObject {
    @Published var text: String
    @Published var attachments: [ComposerAttachment]
    /// false only while the chat is a background job (WS02 keeps it in sync, M-03-7);
    /// insert/attach then return false. `.resolving` and `.allowed` both keep it true —
    /// typing and inserting stay possible while WS02 checks the session (its outbox parks
    /// sends); sending is gated separately by WS02's store.
    @Published var acceptsInput = true
    /// Bumped on every successful insert/attach; ChatScreen focuses the field on change.
    @Published private(set) var focusRequest = 0
    /// Set by the seeding init when some draft attachments were rejected; ChatScreen shows it
    /// once on appear and clears it.
    @Published private(set) var seedNotice: String?
    init(text: String = "", attachments: [ComposerAttachment] = [], draft: NewSessionDraft? = nil)
        // seeds text/chips, then `apply(draft)` once; rejected count > 0 →
        // seedNotice = "1 attachment couldn't be carried over" / "N attachments couldn't be carried over"
    func consumeSeedNotice() -> String?
    @discardableResult func insert(text: String, mode: ComposerInsertMode) -> Bool   // quoteBlock = QuoteText.buildQuoteBlock
    @discardableResult func attach(remotePath: String, displayName: String, mime: String?) -> Bool
        // mime ?? ChatVoice.mime(forFilename: displayName) (falls back to the path's last
        // component when displayName has no extension)
    var lastAttachRejection: ComposerInsertion.AttachRejection? { get }   // for callers' copy
    func newSessionDraft(cwd: String?) -> NewSessionDraft                 // F7
    @discardableResult func apply(_ draft: NewSessionDraft) -> Int        // F7; returns rejected attachment count
}
extension EnvironmentValues { var composerController: ComposerTextController? }   // EnvironmentKey, default nil (pattern HandoffStore.swift:459-471)
```
Rules:
- Bool contract (C3): `false` means nothing changed; **every caller must surface it**.
  Suggested copy: insert → "Couldn't add that to the message"; attach `.duplicate` →
  "Already attached"; `.readOnly` → "This chat is read-only"; `.notAbsolute` → "Couldn't attach that file".
- `.quote` takes the **raw** selection and applies `QuoteText.buildQuoteBlock` itself (D4;
  WS01's note: never pass an already-built block). Single line, middle-truncated, prepended.
- No attachment count cap (desktop has none; the photo picker's per-pick limit of 5,
  `ComposerView.swift:1031`, is unchanged).
- A ready chip goes straight through the existing send path.
- Callers render their control only when `composerController != nil` (no dead controls on
  `ChatSubagentScreen` / read-only surfaces).

### ChatScreen adoption (WS03, wave A — D3/D13; ledger M-03-1…M-03-4)
1. `ChatScreen.swift:264-269` → `@StateObject private var composer: ComposerTextController`;
   init (297-309) sets `_composer = StateObject(wrappedValue: ComposerTextController(text:
   HandoffComposerCarry.appendBelow(seed, carryOver?.text ?? ""), attachments:
   carryOver?.attachments ?? [], draft: draft))`. The `StateObject` autoclosure runs once per
   screen identity, so re-renders of the struct never re-seed.
2. All uses → `composer.text` / `composer.attachments` (459, 574-575 as `$composer.text` /
   `$composer.attachments`, 710-712, 733, 741-742, 1004). ComposerView's API is unchanged.
3. `.environment(\.composerController, composer)` on the `ChatScreenContent` root (so sheets it
   presents inherit it) and `.onChange(of: composer.focusRequest) { _, _ in composerFocused = true }`.
   `quote(_:into:)` `.thisSession` → `if !composer.insert(text: selection, mode: .quote) { store.actionHint = "Nothing to quote" }`;
   `.newSession` keeps `forkSession(seed: block)` (D12).
4. `ChatScreen` (wrapper, memberwise) gains `var draft: NewSessionDraft? = nil`;
   `ChatScreenContent.init` gains `draft: NewSessionDraft? = nil`. The wrapper passes
   `currentSessionId == nil ? draft : nil`, so a clear or handoff swap (which rebuilds the
   content via `.id(sid)`, `ChatScreen.swift:140-160`) never re-applies it; handoffs keep using
   the existing `carryOver` path only. In the content's existing `onAppear` block (≈`:355`):
   `if let n = composer.consumeSeedNotice() { store.actionHint = n }`.
   **The one new-chat seed contract (finding 2):** the create flow (WS04) carries the
   confirmed draft to the destination and calls `ChatScreen(…, seed: target.seed ?? "", draft: target.draft)`
   with `target.seed == nil`, i.e. an empty seed (`seed` stays the quote-fork channel, D12). No `initialCarryOver`, no
   `seedAttachments`: chips reach the composer only through `apply` → `attach`, so they are
   validated (absolute path, no duplicates) as D11 requires.
No legacy-binding fallback remains; WS02 builds on `composer` in wave B.

### Tests
`ComposerInsertionTests.swift` (new, `verify.sh`): append into blank → text; into `"hi\n"` →
`"hi\n\nnew"`; replace; quote with a stub `quoteBlock` prepends; blank → nil; quoteBlock nil →
nil; `checkAttach`: relative → `.notAbsolute`, duplicate path → `.duplicate`, `acceptsInput
false` → `.readOnly`; `makeChip` is ready and `isImage` for `image/png`.
`ComposerTextControllerTests.swift` (new, Mac-only `test-unit`): `insert(.quote)` uses the real
`QuoteText` (300-char selection truncated, one `> `); `focusRequest` bumps only on success; mime
inferred from `a.png`; explicit mime wins; read-only rejects both APIs.

### Acceptance
- [ ] Quote prepends exactly as before (no visible change), via the controller.
- [ ] `insert(.append)` adds below with one blank line; `.replace` keeps chips.
- [ ] `attach` adds a ready chip that is sent on the next Send; a second identical attach is refused.
- [ ] Any successful insert/attach focuses the composer.

---

## F7 — C3: `NewSessionDraft` helpers (no type declared here — D2/D11)

The type is `NewSessionDraft` / `NewSessionDraftAttachment` in `MantaNavigation.swift`
(wave-0 scaffold, WS04 owns). WS03 provides only:
- `ComposerTextController.newSessionDraft(cwd: String?) -> NewSessionDraft`: `text` = current
  draft; attachments = **ready** chips only (`remotePath != nil`) mapped to
  `NewSessionDraftAttachment(remotePath:, displayName: chip.filename, mime: chip.mime)`;
  `worktreeBranch = nil`, `linkedIssueURL = nil` (producers set them afterwards if needed).
- `ComposerTextController.apply(_ draft: NewSessionDraft) -> Int` (reverse): `insert(text:
  draft.text, mode: .append)` when non-blank, then `attach(remotePath:displayName:mime:)` per
  attachment; returns how many attachments were rejected. `cwd`, `worktreeBranch`,
  `linkedIssueURL` are create-sheet concerns (WS04) and are ignored here.
- `ComposerTextController(…, draft:)` + the `ChatScreen(draft:)` parameter (adoption step 4,
  wave A1) is the **only** consumption point for WS04's create flow (D11: "maps back via
  `attach`"). WS04's consumer (A2, after A1): put the confirmed `NewSessionDraft` on its
  `SessionOpenTarget` as a non-identity `draft` field and pass `ChatScreen(…, draft: target.draft)`;
  this replaces M-04-7 (`initialCarryOver`) and WS04's `SessionDraftCarry.carryOver` conversion,
  and WS02's old `seedAttachments` receipt for this flow.

Tests (`ComposerTextControllerTests.swift`): `newSessionDraft` drops uploading chips, maps
fields, leaves metadata nil and passes `cwd` through (including nil); `apply` seeds text into
an empty composer, appends below an existing draft, attaches each attachment, and counts a
duplicate as rejected; the seeding init with a draft holding one valid and one relative-path
attachment yields text once, one chip, and `seedNotice == "1 attachment couldn't be carried over"`;
`consumeSeedNotice()` returns it once then nil; a controller built without a draft (the
post-clear/handoff rebuild) has no seed text and no notice.

Acceptance (with WS04's consumer): after Create, the new chat shows the draft text once and
its chips; a rejected attachment shows the notice once; clearing that chat or handing it off
does not bring the draft back.

---

## Files

Edit (owned): `ComposerTypeahead.swift`, `ComposerView.swift` (palette/typeahead rows + states,
sources wiring, submission guard + flow, background toggle, agent mentions; remove
`ComposerAttachment` (moved), `draftMentions`, `fileResults`, `fileSearchTask`,
`fileSearchSeq`), `MantaUITests/ComposerTypeaheadTests.swift`.

D13 exception (wave A): `ChatScreen.swift` — exactly adoption steps 1-4 above.

Create: `ComposerModels.swift` (Foundation), `ComposerInsertion.swift` (Foundation),
`ComposerTypeaheadSources.swift`, `ComposerTextController.swift`,
`MantaAPIClient+Composer.swift`, `MantaUITests/ComposerModelsTests.swift`,
`MantaUITests/ComposerInsertionTests.swift`, `MantaUITests/ComposerTextControllerTests.swift`.

Manifest for the integration step (D18/D19): Package.swift sources +
`ComposerModels.swift`, `ComposerInsertion.swift`; tests + `ComposerModelsTests.swift`,
`ComposerInsertionTests.swift` (`ComposerTypeaheadTests.swift` already listed; it keeps
compiling because `ComposerTypeahead.swift` depends only on `ComposerModels.swift` and
`MantaModels.swift`, both in the package). Until M-03-8 lands, `verify.sh` cannot compile
the extended `ComposerTypeaheadTests.swift`; the WS03 worker runs `verify.sh` against a
local, uncommitted copy of `Package.swift` with the two sources/tests added and reports the
result, and the integration agent commits the real edit. Workers never edit `project.pbxproj`.

No server files. No `generated/swift/*` change.

## Mount requests

Waves per D20 (A1 = WS10/WS01/WS03; A2 = WS04/WS08; IA/IB = integration agents after A2/B).
IDs, appliers and provider symbols match the master's canonical mount ledger (`00-master.md`).

| ID | Receiving file | Applier (D18) | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-03-1 | `ChatScreen.swift` | WS03, A1 (D13) | `ComposerTextController.init(text:attachments:draft:)` | Replace `@State composerText` / `composerAttachments` (264-269) with `@StateObject private var composer: ComposerTextController`, created in `init` (297-309) via `StateObject(wrappedValue:)` from `seed` + `carryOver` + `draft` | WS03 `ComposerTextController.swift` |
| M-03-2 | `ChatScreen.swift` | WS03, A1 | `ComposerTextController.text`, `.attachments` | Rewrite uses at 459, 574-575 (`$composer.text`, `$composer.attachments`), 710-712, 733, 741-742, 1004 | M-03-1 |
| M-03-3 | `ChatScreen.swift` | WS03, A1 | `EnvironmentValues.composerController`, `ComposerTextController.focusRequest`, `insert(text:mode:)` | `.environment(\.composerController, composer)` on the `ChatScreenContent` root; `.onChange(of: composer.focusRequest) { _, _ in composerFocused = true }`; quote `.thisSession` → `insert(text: selection, mode: .quote)`, `false` → `store.actionHint = "Nothing to quote"` | M-03-1 |
| M-03-4 | `ChatScreen.swift` | WS03, A1 | `NewSessionDraft` (D2 scaffold), `ComposerTextController.consumeSeedNotice()` | `var draft: NewSessionDraft? = nil` on `ChatScreen`; `draft:` on `ChatScreenContent.init`; wrapper passes `currentSessionId == nil ? draft : nil`; `onAppear` shows `consumeSeedNotice()` via `store.actionHint` | M-03-1; D2 scaffold |
| M-03-5 | `ChatModelStore.swift` | WS09, B (owns file, D1) | — (WS09 adds) `@Published private(set) var agentsLoadError: String?`; `func retryAgents()` | `loadAgentsIfNeeded()` (135-143): on failure set `agentsLoadError = <MantaError message>` and leave `agents == nil` (instead of `[]`); on success set `agents` and `agentsLoadError = nil`. `retryAgents()`: `agentsLoadError = nil; didLoadAgents = false; loadAgentsIfNeeded()`. WS09 tests: failure → error set + agents nil; retry → loaded + error nil; success path unchanged (plan chip still sees the same `agents`). | — |
| M-03-6 | `ComposerView.swift` | IB (WS03 not in B) | `ComposerTypeahead.agentRows(agents:loadError:query:limit:)`, M-03-5 members | Replace the wave-A argument `loadError: nil` with `modelStore.agentsLoadError`; the tappable status row's action calls `modelStore.retryAgents()` | M-03-5 committed |
| M-03-7 | `ChatScreen.swift` | WS02, B (owns file) | `ComposerTextController.acceptsInput` (WS03); `ChatSessionStore.isBackgroundJobReadOnly` (WS02, canonical read-only signal) | In `ChatScreenContent`: `.onAppear { composer.acceptsInput = !store.isBackgroundJobReadOnly }` and `.onChange(of: store.isBackgroundJobReadOnly) { _, ro in composer.acceptsInput = !ro }` — covers a job screen opened directly, reclassified after opening, and transitions back to `.allowed`. `.resolving` keeps `true` (typing allowed; sends are parked by WS02). | M-03-1; WS02 F6 (`isBackgroundJobReadOnly`) |
| M-03-8 | `mobile/native/Package.swift` | IA | WS03 manifest (Files) | Add `ComposerModels.swift`, `ComposerInsertion.swift` to `MantaUI` sources; `ComposerModelsTests.swift`, `ComposerInsertionTests.swift` to test sources | WS03 files committed |
| M-03-9 | `ComposerView.swift` | IB (WS03 not in B) | WS02's `ChatSessionStore.mutationPolicy: ChatCardMutationPolicy` (`.resolving`, `.allowed`, `.readOnlyJob`) | Exhaustive gate on `store.mutationPolicy` immediately before command/built-in dispatch (after lookup) and inside delayed Clear confirmation: `.allowed` dispatch; `.resolving` and `.readOnlyJob` refuse with hint, no RPC, draft kept (F2 step 7, incl. its two integration tests) | WS02 `mutationPolicy` committed |

Integration acceptance (checked by IB after M-03-5/6/7/9): agents request fails → "Couldn't
load agents — tap to retry" → tap after the box recovers → agents listed; a background-job chat
opened directly has `composer.acceptsInput == false` (WS05's fill controls and WS07's Attach
report the read-only rejection); a chat reclassified to a job while open flips to `false`, and
back to `true` if re-resolved as `.allowed`.

## Mounts applied by this workstream

| ID | From | Receiving file | Change | Prerequisite |
|---|---|---|---|---|
| M-03-1 … M-03-4 | WS03 (own, D13) | `ChatScreen.swift` | Composer adoption, A1 (see above) | WS03 controller |

Cross-checked the current request tables of 01, 02, 04, 05, 06, 07, 08, 09, 10 and the
master's canonical mount ledger: apart from WS03's own M-03-6 / M-03-9 (applied by IB), no
request targets `ComposerView.swift`,
`ComposerTypeahead.swift`, `ComposerHistory.swift` or a WS03 new file. Consumers that call C3
from their own code (no mount into WS03 files): WS02 "Edit last" (`composer.insert(…, .replace)`,
02 §F8), WS05 M-05-1 (`composerController` + `acceptsInput`), WS07 M-07-1
(`ArtifactsCard(…composer:…)`), WS04's create-flow destination (`ChatScreen(…, draft:)`, see
F7 — this supersedes M-04-7).

## Client members

New in `MantaAPIClient+Composer.swift` (no other spec declares these names — grep of all
specs for `commands(`, `references(`, `runCommand`):
- `func commands(directory: String?) async throws -> [OpencodeCommandInfo]` — `callRequired("opencode:commands", …)`
- `func references() async throws -> [OpencodeReferenceInfo]` — `callRequired("opencode:references", [])`
- `func runCommand(_ input: RunCommandInput) async throws -> RunCommandResult?` — `call("opencode:run-command", …)`

Reused, not redeclared: `findFiles(query:directory:)`, `agents()`, `sendPrompt(_:)`.

## Contracts provided / consumed

- **C1 provided:** the three members above; wire types in `ComposerModels.swift`.
- **C2:** consumes `NewSessionDraft` / `NewSessionDraftAttachment` types only (D2).
- **C3 provided:** `ComposerInsertMode`, `ComposerInsertion`, `ComposerTextController`
  (`insert` → Bool, `attach` → Bool, `lastAttachRejection`, `acceptsInput`, `focusRequest`,
  `newSessionDraft(cwd:)`, `apply(_:)`, `init(text:attachments:draft:)`, `seedNotice` /
  `consumeSeedNotice()`), `EnvironmentValues.composerController`, and the
  ChatScreen adoption (D13). `.append` = one blank line (`HandoffComposerCarry.appendBelow`);
  `.quote` = raw selection through `QuoteText.buildQuoteBlock`, prepended. Consumers: WS01
  (quote via ChatScreen), WS02 (`.replace` for Edit last; `acceptsInput`), WS04 (draft →
  `ChatScreen(draft:)`), WS05 (`.append` for failures, D6; drafts via the navigator), WS07 (`attach`).
- **C4:** M-03-1…4 (own, D13); M-03-7 (WS02); M-03-5 (WS09); M-03-6, M-03-9 (IB).
- **Consumed from WS02 (wave B, via M-03-7/9):** `ChatSessionStore.isBackgroundJobReadOnly`
  (M-03-7) and `ChatSessionStore.mutationPolicy` / `ChatCardMutationPolicy`
  (`.resolving`, `.allowed`, `.readOnlyJob`) (M-03-9).
- **Consumed from WS09 (wave B, via M-03-5/6):** `ChatModelStore.agentsLoadError`, `retryAgents()`.
- **C5:** none decoded here; command turns render from D15's `commandByMessageID` (WS01/WS02).
- **C7:** `ComposerTypeaheadTests`, `ComposerModelsTests`, `ComposerInsertionTests`
  (`verify.sh`), `ComposerTextControllerTests` (Mac).

## Deferred

- Coloured `/name` highlight in the input (`SlashComposerParts.tsx:33-64`): needs a UIKit
  attributed text view; cosmetic — the background toggle signals a recognised command.
- `/help` (`ChatPanel.tsx:144-158`): a keyboard-shortcut list, meaningless on a phone.
- "Model doesn't support file attachments" row in `@` file mode (`useTypeahead.ts:251-262`):
  model-capability work (WS09), unrelated to this scope.
- Optimistic "sending…" row for commands: lives in WS02's `ChatSessionStore`.
- Desktop `@@` detection fix: renderer-only (D10); reported at the end.

## Open questions

None remaining — the quote format (D4), adoption owner (D3/D13), draft type (D2/D11) and the
desktop `@@` fix (D10) are settled by the master.

## Review responses (round 1)

WS03 review:
1. **BLOCKING draft type** — F7 rewritten: no type declared; `newSessionDraft(cwd: String?)`
   maps ready chips → `NewSessionDraftAttachment`, metadata nil, cwd optional; reverse
   `apply(_:)` via `attach`; `ChatScreen(draft:)` consumption point; tests updated.
2. **BLOCKING adoption owner** — WS03 applies M-03-1…4 in wave A (D13); ChatScreen listed as the
   D13 exception in Files; obsolete open question removed.
3. **BLOCKING success cleanup** — `ComposerSubmission` snapshot + `ComposerSubmissionSettle.accepted`
   remove only submitted chip ids and clear text/mentions only if unchanged; tests for added
   chip, edited text, and failure (nothing cleared before acceptance).
4. **BLOCKING `/clear` confirmation** — palette `.clear` now sets `showClearConfirm`; one dialog
   for palette + typed Send; Cancel keeps the draft; acceptance added.
5. **SHOULD async dispatch** — synchronous `submitInFlight` guard + snapshot before any await,
   released by a single `defer`; `canSend` respects it; all entry points route through `submit()`;
   acceptance for double Send and editing during the wait.
6. **SHOULD agent load errors** — `agentRows` handles loading/error/empty; M-03-5 asks WS09 for
   `agentsLoadError` + `retryAgents()` (no second fetch), M-03-6 wires it; failure→retry→loaded test.
7. **SHOULD D6/D10** — WS05 contract is `.append`; desktop `@@` fix moved to "reported, out of
   scope", no desktop edits.
8. **SHOULD decoding** — `commands` and `references` use `callRequired`; tests separate `null`
   (error) from `[]` (empty).

Cross-cutting review:
- **#1** — resolved as WS03 item 1 (single D2 type; both conversions specified).
- **#3** — resolved as WS03 item 2.
- **#10** — WS03 supplies a Package.swift manifest (M-03-8, integration agent A) and does not
  touch `project.pbxproj`; new pure files are Foundation-only so they run under `verify.sh`
  (`ComposerAttachment` moved into `ComposerModels.swift` for that reason).
- **#12** — C3 documented here with Bool returns, rejection-surfacing rule and copy, blank-line
  append, raw-selection quote; WS05 failures use `.append`.

## Review responses (round2)

WS03 review:
1. **BLOCKING M-03-5/6/7 receipts** — M-03-5 now pins WS09's exact members (`@Published private(set) var agentsLoadError: String?`, `func retryAgents()`), behaviour and WS09-side tests; M-03-6 stays gated on M-03-5 being committed. M-03-7 is rewritten against WS02's store-level symbols (reconciled after round 2 to the canonical read-only signal `ChatSessionStore.isBackgroundJobReadOnly`, derived from `mutationPolicy == .readOnlyJob`; the ownership store's `job` stays WS02-internal) with `onAppear` + `onChange` sync covering direct open, reclassification and return to `.allowed`, and `.resolving` pinned as writable. Integration acceptance added for retry and both job-screen paths. The receiving specs (WS09, WS02) must add these rows to their applied tables — recorded as a cross-spec dependency; WS03 cannot edit them.
2. **BLOCKING new-chat seed entry points** — one contract: `ComposerTextController.init(text:attachments:draft:)` + `ChatScreen(draft:)` (A1). The draft is applied once (StateObject autoclosure; wrapper passes it only before the first clear/handoff), chips go through `attach` validation, rejections surface once via `seedNotice`. WS04 must carry `draft` on `SessionOpenTarget` and pass it with `seed` nil; this supersedes M-04-7 (`initialCarryOver`), `SessionDraftCarry.carryOver`, and WS02's `seedAttachments` receipt. Handoff keeps the existing `carryOver` path only. Tests for one-time seeding, rejection notice, and no reseed after clear/handoff added.
3. **BLOCKING `/fork` cleanup** — added `ComposerSubmissionSettle.localAction` for local built-ins: consumes only unchanged command text, never chips or agent selections; `/fork` and `/compact` use it, not `accepted`. Test + acceptance for `/fork` with a ready chip, success and failure.
4. **SHOULD stale running state** — the snapshot now holds only the user's payload and preferences (text, chip ids, agent names, delivery preference, model/agent preference, background); `store.running` (and after M-03-9 the mutation policy) is re-read immediately before planning/dispatch. Idle→running and running→idle acceptance cases + `planSlashSend` tests added. New M-03-9 also blocks command/built-in dispatch while WS02 is still resolving (a command cannot be parked in WS02's outbox).

Cross-cutting review (round 2):
- **#3 (draft handoff)** — same as WS03 item 2.
- **#4 (agent retry receipt)** — same as WS03 item 1 (M-03-5/6).
- **#5 (writability propagation)** — same as WS03 item 1 (M-03-7), using WS02's `isBackgroundJobReadOnly`; WS05's `acceptsInput` bridge now has a real provider value.
- **#10 (ledger integrity)** — request IDs M-03-1…9 use the ledger's IDs/appliers/waves (A1, IA, IB); the stale claim that WS02 keeps a `composerText` fallback is removed (WS02 now consumes `composer`, `02-chat-cards-queue.md:49-50`); "Mounts applied" lists only real rows and the consumers that need none.
