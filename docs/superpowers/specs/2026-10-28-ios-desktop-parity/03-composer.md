# WS03 — Composer: `/` commands + skills, `@` agents + references, insertion API (C3)

Status: draft · Wave: **A** · Depends on: wave-0 foundation (C1 visibility — already
`internal` today, see `MantaAPIClient.swift:944-984`) · Provides: **C3** (insertion API +
`NewSessionDraft`) to WS01, WS04, WS05, WS07.

Ownership (master §File ownership): `ComposerView.swift`, `ComposerTypeahead.swift`,
`ComposerHistory.swift`, new `Composer*` files, `MantaAPIClient+Composer.swift`, and the
test files `MantaUITests/Composer*Tests.swift`. **No server change** — every channel used
below already exists and is what the desktop calls.

Features:

| # | Feature |
|---|---|
| F1 | Custom opencode slash commands + skills in the `/` palette |
| F2 | Sending a typed `/command args` (opencode command / skill / Manta built-in) |
| F3 | "Run in background" for a command or skill |
| F4 | `@` references (configured aliases) in the `@` typeahead |
| F5 | `@@` agent mentions in the typeahead (+ fix of the file-mention wire bug) |
| F6 | C3 composer insertion API (`ComposerTextController`, `insert`, `attach`) |
| F7 | C3 `NewSessionDraft` value |

---

## What iOS has today (do not duplicate)

- `ComposerTypeahead.swift` (whole file, 184 lines): pure `detectMention` / `applyMention`
  (`@file`), `detectSlash`, a **fixed** palette `slashCommands(running:)` of six local
  actions (`submit`, `compact`, `clear`, `fork`, `handoff`, `abort`), `filterSlashCommands`,
  `goalAfterCommand`, `isHandoffCommand`. The header comment says "the native composer has
  no server-side command registry" — that is the gap F1 closes.
- `ComposerView.swift`:
  - state for the `@` typeahead: `activeMention`, `fileResults`, `draftMentions`,
    `fileSearchTask`, `fileSearchSeq` (lines 158-171);
  - palette/typeahead rendering above the input (lines 194-205), `slashPalette` (1442-1450),
    `mentionTypeahead` (1453-1486), `slashPaletteView` (1490-1523);
  - `handleTextChange` (1528-1538), debounced `searchFiles` 250 ms, cap 10 (1542-1553),
    `selectFile` (1557-1567), `performSlash` (1571-1592);
  - `submit(delivery:)` (1379-1421): special-cases a typed `/handoff`, otherwise **always**
    calls `store.sendOrSteer(...)` → `opencode:prompt`. A typed `/review x` is posted as a
    plain prompt — opencode never runs the command.
  - the composer hint capsule `surfaceHint(_:)` (1641) — the composer's own feedback channel.
- `ChatModelStore.agents` (`ChatModelStore.swift:60-63`) — the box agent list, already
  fetched once per chat via `loadAgentsIfNeeded()` (135-143), called from
  `ChatScreen.swift:363`. Reuse it for F5; do not fetch agents a second time.
- `MantaAPIClient.findFiles` (`MantaAPIClient.swift:312-316`) and `agents()` (355-359).
- Quote already exists end to end (BET-1353): `QuoteText.buildQuoteBlock`
  (`SessionModels.swift:976-1012`, port of desktop `chatUtils.ts:581`), called from
  `ChatScreen.quote(_:into:)` (`ChatScreen.swift:995-1012`), which **prepends** the block
  to `composerText`. The composer draft and chips are `@State` in ChatScreen
  (`composerText`, `composerAttachments`, `composerFocused`, `ChatScreen.swift:260-282`)
  passed to ComposerView as bindings (574-576). `mobile/native/AGENTS.md:46` lists a
  `ComposerTextController` store, but **no such type exists in the code** — F6 creates it.
- `HandoffComposerCarry.appendBelow` (`HandoffModels.swift:482-493`) and `HandoffCarryOver`
  (`HandoffStore.swift:27-31`) — the existing "move text + ready chips to another chat"
  shapes. F6/F7 reuse them.

### Bug found while researching (fixed by F5)

iOS records a chosen **file** as a `SendPromptInput.Mention` (`applyMention`,
`ComposerTypeahead.swift:79-94`; appended in `ComposerView.selectFile`). On the wire that
becomes `mentions` → the server turns every mention into an **agent** part
(`opencode.mjs:671-676`: `body.agents = mentions.map(...)`). So iOS sends the file path as
if it were an agent name. The desktop never does this: a file or reference mention is plain
`@path` text; only `@@agent` selections become mentions (`useTypeahead.ts:295-318`).

### Desktop bug found while researching (see Open questions)

`useTypeahead.ts:177-194` finds `@` with `left.lastIndexOf("@")`. For `@@pl` that is the
SECOND `@`, whose previous character is `@` (not whitespace), so detection returns `null`:
the desktop's agent typeahead can never open (verified by running the exact function on
`"@@"`, `"@@bu"`, `"hi @@pl"` → all `null`). iOS implements the intended behaviour.

---

## F1 — Custom slash commands + skills in the `/` palette

### Desktop behaviour
- Typing `/` as the **first character** with the caret inside the first word opens the
  command typeahead (`useTypeahead.ts:161-174`; token regex `^\/([\w-]*)`).
- The list is fetched lazily the first time the text starts with `/`, **per session
  directory**; a session that moves directory reloads (`useTypeahead.ts:98-124`). Failure is
  silent (`catch { /* non-fatal */ }`).
- Rows (`useTypeahead.ts:221-238`): Manta built-ins first (`MANTA_BUILTIN_COMMANDS`,
  `chatUtils.ts:629-636`: clear, fork, compact, handoff, help), then opencode commands/skills
  **minus any whose name equals a built-in** (`dedupeAgainstBuiltins`, `chatUtils.ts:610-615`),
  both filtered by case-insensitive *name contains query* (`filterCommands`, 597-604);
  capped at **12**. Row = `/name` + description.
- Empty state copy: **"No matching commands"** (`Composer.tsx:68-74`).
- Selecting a row **inserts** `/name ` (name + one space) replacing the token, and puts the
  caret after it (`useTypeahead.ts:295-326`) — it does not run anything. Send runs it (F2).
- The popup is max 240 px tall and scrolls (`ComposerParts.tsx:392`).

### Wire contract
`opencode:commands` — desktop `backgroundApi().opencodeCommands({ directory })`
(`useTypeahead.ts:110`) → `httpApi.ts:1434` → `rpc.mjs:1973-1977` →
`opencode.mjs:2856-2875 listCommands`.

- Args: `[]` or `[{ "directory": "<session cwd>" }]`.
- Response: `[{ name: string, description?: string, source?: "command"|"project"|"global"|"skill", argumentHint?: string, agent?: string, model?: string, template?: string, background?: true }]`
  (`types.ts:3056-3067`). Skills are merged in by the server (`source: "skill"`); a skill
  hides a same-named command. `background: true` = this command always runs in the
  background (F3).
- Errors: transport/HTTP error → reject (message string).

### iOS design
- New wire type + method in **`MantaAPIClient+Composer.swift`** (C1):
  ```swift
  struct OpencodeCommandInfo: Decodable, Equatable, Sendable {
      var name: String
      var description: String?
      var source: String?
      var argumentHint: String?
      var background: Bool?          // true only; absent = foreground/unknown
      var isSkill: Bool { source == "skill" }
  }
  extension MantaAPIClient {
      /// `opencode:commands` — the session's opencode commands + skills.
      func commands(directory: String?) async throws -> [OpencodeCommandInfo] {
          let args: [Any] = directory.map { [["directory": $0]] } ?? []
          return try await call("opencode:commands", args: args, as: [OpencodeCommandInfo].self) ?? []
      }
  }
  ```
  (Only the fields iOS reads are declared; unknown keys are ignored by `Decodable`.)
- New **`ComposerTypeaheadSources.swift`**: `@MainActor final class ComposerTypeaheadSources: ObservableObject`
  with a no-argument `init()` (held as `@StateObject` in ComposerView, so no ComposerView
  init change). Owns the three remote lists the typeahead needs:
  ```swift
  enum Load<T: Equatable>: Equatable { case idle, loading, loaded(T), failed(String) }
  @Published private(set) var commands: Load<[OpencodeCommandInfo]> = .idle
  @Published private(set) var references: [OpencodeReferenceInfo] = []   // F4
  @Published private(set) var fileResults: [String] = []                 // moved from ComposerView
  @Published private(set) var fileSearching = false
  func ensureCommands(api: MantaAPIClient, directory: String?)            // dedupes in-flight; reloads when directory changed; `.failed` → next call retries
  func awaitCommands(api: MantaAPIClient, directory: String?, timeout: Duration) async -> [OpencodeCommandInfo]?  // F2: bounded wait (3 s)
  func search(api: MantaAPIClient, query: String, directory: String?)    // F4: debounced 250 ms, seq-guarded files + references
  func cancelSearch()
  ```
  The list is cached per directory for the life of the composer (desktop parity: one fetch
  per panel per directory). Move `fileResults` / `fileSearchTask` / `fileSearchSeq` out of
  ComposerView into this class (ComposerView is 1,698 lines; do not grow it further).
- ComposerView `handleTextChange`: when the text starts with `/`, call
  `sources.ensureCommands(api:directory: sessionDirectory)` (desktop calls it as soon as the
  text starts with `/`, not only while the popup is open — `useTypeahead.ts:118-124`).
- Palette rows (pure, F1 logic in `ComposerTypeahead`):
  ```swift
  enum SlashAction: Equatable { case submit, compact, clear, fork, handoff, abort
                                case insert(name: String) }   // NEW: opencode command / skill
  struct SlashCommand { id, title, subtitle, kind, isSkill: Bool }   // isSkill NEW (default false)
  static let builtinIDs: Set<String> = ["submit","compact","clear","fork","handoff","abort"]
  static func paletteRows(builtins: [SlashCommand], remote: [OpencodeCommandInfo], query: String, limit: Int = 12) -> [SlashCommand]
  ```
  Order = filtered built-ins, then filtered remote rows whose `name ∉ builtinIDs`; cap 12.
  Remote row: `id = name`, `title = name`, `subtitle = description ?? ""`, `kind = .insert(name:)`.
  Filtering for remote rows is **name contains query, case-insensitive** (desktop). Built-in
  filtering keeps the existing id-or-title match.
- Palette view (`slashPaletteView`): wrap the rows in a `ScrollView` capped at **240 pt**
  (desktop max height). Row: `/name` + subtitle (subtitle hidden when empty). Skill rows show
  a trailing small `Text("skill")` in `tx3` (iOS-only hint; desktop shows nothing — keep it
  quiet). Accessibility id `slash-row-<name>` (existing convention).
- States (palette is visible while `detectSlash` returns an anchor):
  - commands `.loading` and no built-in matches → one non-tappable row **"Loading commands…"**;
  - `.loaded` and no row matches → one non-tappable row **"No matching commands"** (desktop
    copy). This replaces today's "hide the palette when empty" only for the leading-`/` case.
  - `.failed(msg)` and no built-in matches → one **tappable** row "Couldn't load this
    project's commands — tap to retry" → `ensureCommands` again (no dead control).
- Selecting a `.insert(name:)` row: replace the leading `/token` with `/name ` (pure
  `ComposerTypeahead.applySlashInsertion(name:to:) -> String`), keep focus, do **not** run.
  Built-in rows keep their current immediate behaviour (`performSlash`).

### Pure logic + tests (`MantaUITests/ComposerTypeaheadTests.swift`, extend)
- `paletteRows`: built-ins first; remote filtered by name-contains, case-insensitive;
  remote row with a built-in id (e.g. `compact`) dropped; cap 12; skill flag set from
  `source == "skill"`; empty description → empty subtitle.
- `applySlashInsertion`: `"/re"` → `"/review "`; `"/re some args"` (caret in token) →
  `"/review some args"` (token replaced, the rest kept, exactly one space between);
  `"/"` → `"/review "`.
- `OpencodeCommandInfo` decodes a server fixture with extra keys and `background: true`.

### Acceptance
- [ ] In a session whose project defines `.opencode/commands/review.md`, typing `/re` lists
  `/review` with its description below the built-ins.
- [ ] Installed skills appear (tagged "skill").
- [ ] An opencode command named like a built-in (e.g. `compact`) appears once.
- [ ] Tapping `/review` turns the draft into `/review ` and keeps the keyboard up; nothing is sent.
- [ ] With the box unreachable, the palette shows the retry row; tapping it refetches.
- [ ] More than 5 matches scroll inside a ≤240 pt list; the composer does not jump.

---

## F2 — Sending a typed `/command args`

### Desktop behaviour
`ChatPanel.submit` (1702-1760, 1897-1920):
1. `^/(\S+)(?:\s+([\s\S]*))?$` → name + args (`splitSlashText`, `backgroundRun.ts:125-128`).
2. Name is a Manta built-in → run it locally; no message is sent (1705-1737).
3. Name is in the session's command list (`knownCommand`) → `opencode:run-command`
   with `{ sessionId, command, arguments, model, agent (plan), attachments }` (1897-1906).
4. Otherwise → ordinary `opencode:prompt` (a `/path/to/file is broken` message stays a message).
5. While the agent is running (`sendWhileBusy`, 1467-1560, logic `planBusySend`,
   `inboxState.ts:122-137`): built-in → refused with **"Stop the agent or wait for it to
   finish before /<name>"**; known command → `opencode:run-command` with `delivery`
   (`"steer"` / `"queue"`) and **no** model/agent and **no** mentions; else prompt.
6. On failure the error shows in the send-error card; busy failures restore the draft
   (`shouldClearDraft`, `inboxState.ts:144-146`: clear only if the composer still holds
   exactly the submitted draft).

### Wire contract
`opencode:run-command` — `httpApi.ts:1450` → `rpc.mjs:2047-2067` → `opencode.mjs:2967-3023`.
- Args: `[{ sessionId: string, command: string, arguments: string, model?: {providerID, modelID, variant?}, agent?: string, attachments?: [{remotePath, mime, filename?}], delivery?: "steer"|"queue", background?: boolean }]`
  (`api.ts:1657-1673`).
- Behaviour: a skill is sent by the server as a prompt `/<skill> <args>` with the skill
  attached (`opencode.mjs:2973-2986`) — the client does not distinguish. A refused command
  rejects with `opencode runCommand <status>: <text>`. Invalid `delivery` rejects
  (`rpc.mjs:636-640`).
- Response: `null` (foreground / always-background) or `{ jobId: string }` (F3).
- Stream: the expanded command arrives as a normal user message + `commandExecuted` frame
  (rendered by WS01/WS02; not this workstream).

### iOS design
- `MantaAPIClient+Composer.swift`:
  ```swift
  struct RunCommandInput: Sendable {
      var sessionId: String; var command: String; var arguments: String
      var model: SendPromptInput.Model?; var agent: String?
      var attachments: [SendPromptInput.Attachment]
      var delivery: String?            // InboxDelivery.wire, only while running
      var background: Bool = false
  }
  struct RunCommandResult: Decodable, Equatable, Sendable { var jobId: String? }
  func runCommand(_ input: RunCommandInput) async throws -> RunCommandResult?   // "opencode:run-command"
  ```
  Encode `model` exactly like `sendPrompt` (`MantaAPIClient.swift:63-77`); omit
  `model`/`agent`/`delivery`/`background` keys when nil/false; always send `attachments`
  (possibly empty) and `arguments` (possibly `""`).
- Pure decision (`ComposerTypeahead`):
  ```swift
  enum SlashSendPlan: Equatable {
      case prompt                                    // not a command → today's sendOrSteer
      case builtin(SlashAction)                      // compact / clear / fork (handoff keeps its existing path)
      case refuse(String)                            // built-in while running
      case command(name: String, args: String, alwaysBackground: Bool)
  }
  static func splitSlashText(_ text: String) -> (name: String, args: String)?
  static func planSlashSend(text: String, running: Bool, remote: [OpencodeCommandInfo]?) -> SlashSendPlan
  ```
  Built-ins considered on Send: `compact`, `clear`, `fork` (iOS keeps `/handoff` on its
  existing `isHandoffCommand` path, checked first, unchanged). `submit`/`abort` are palette
  actions only and a typed `/submit` is an ordinary prompt. Refusal copy:
  **"Stop the agent or wait for it to finish before /<name>"**.
- `ComposerView.submit` new flow (order matters):
  1. existing `/handoff` branch (unchanged);
  2. if the text starts with `/` and commands are `.loading`/`.idle`, `await
     sources.awaitCommands(timeout: 3 s)` (better than desktop, which falls through to a
     prompt while the list is loading); a nil result (timeout/failure) → treat as `.prompt`;
  3. `planSlashSend`:
     - `.prompt` → today's path, unchanged (with F5's mention fix);
     - `.builtin(.compact)` → `store.compact()`; `.clear` → `showClearConfirm = true` (the
       existing confirm before `onSlashClear`); `.fork` → `onSlashFork?()`; clear the text;
       if the callback is nil (`onSlashFork`/`onSlashClear` absent) fall through to `.prompt`;
     - `.refuse(msg)` → `surfaceHint(msg)`, keep the draft;
     - `.command` → `sendCommand(...)` below.
- `sendCommand` (ComposerView private, async on MainActor):
  - set `@State commandSending = true` → the send button shows a `ProgressView` and is
    disabled (no double send); record `submittedDraft = text`;
  - build `RunCommandInput` with ready attachments (same compactMap as today), `model:
    store.running ? nil : modelStore.promptModel`, `agent: store.running ? nil : plan agent`,
    `delivery: store.running ? delivery.wire : nil`, `background` from F3;
  - success: `PromptHistoryStore.append`, clear text/attachments/agent mentions **only if
    `text == submittedDraft`** (port of `shouldClearDraft`); then `store.refreshInbox()` when
    it was a running-turn send, else `Task { await store.refetch() }`;
  - failure: keep draft + chips; `surfaceHint("Couldn't run /<name> — \(message)")` where
    `message` is `MantaError`'s server/transport text;
  - always `commandSending = false`.
  - No optimistic transcript row (that pipeline is WS02's `ChatSessionStore`); the
    spinner on Send covers the gap until the box's user message streams in.

### Pure logic + tests (`ComposerTypeaheadTests.swift`)
- `splitSlashText`: `"/review"` → (`review`, `""`); `"/review  a b\nc"` → (`review`, `"a b\nc"`);
  `"hello"` → nil; `"/"` → nil.
- `planSlashSend`: known remote → `.command`; unknown `/usr/bin is slow` → `.prompt`;
  `/compact` idle → `.builtin(.compact)`; `/compact` running → `.refuse("Stop the agent or
  wait for it to finish before /compact")`; known remote while running → `.command`;
  `remote == nil` → `.prompt` for non-built-ins; `background: true` entry → `alwaysBackground`.
- `shouldClearDraft(submitted:current:)`.

### Acceptance
- [ ] `/review the auth module` + Send in an idle session runs the opencode command (the
  transcript shows the command's turn, not the literal text as a prompt).
- [ ] A skill name + Send runs the skill inline.
- [ ] While the agent runs, `/review x` + Send delivers with the chosen Now/After-this-turn
  delivery and appears in the pending card.
- [ ] `/compact` + Send while running shows the refusal hint and keeps the draft.
- [ ] A refused command keeps the text and chips and shows "Couldn't run /<name> — …".
- [ ] `/usr/local is full` is sent as a normal message.

---

## F3 — "Run in background"

### Desktop behaviour
- When the composer text's first token is a known opencode command or skill (never a Manta
  built-in), a **"Run in background"** checkbox slides in under the input
  (`ChatPanel.tsx:539-556`, `backgroundRun.ts:81-108`, `SlashComposerParts.tsx:68-110`).
  Checked → helper "— runs in its own session, without this chat's history; the result
  comes back here" (`BACKGROUND_HELPER_TEXT`, `backgroundRun.ts:102-103`). If the command
  always runs in the background (`background: true`), the box is checked and disabled with
  title **"This command always runs in the background"** (`BACKGROUND_LOCKED_TITLE`).
- The box resets (unchecked) whenever the token stops being an opencode command.
- The send button reads "Run in background" (`InputArea.tsx:620-651`).
- Send: `opencode:run-command` with `background: true` and NO `delivery`, idle or busy; it
  never steers the running turn (`ChatPanel.tsx:1569-1620`). Composer clears only after the
  box accepts; a refusal shows its message and keeps draft + chips.

### Wire contract
Same `opencode:run-command` with `background: true`. Server (`rpc.mjs:679-702`): resolves
`{ jobId }` for a Manta-wrapped job, `null` for an always-background command; rejects with
actionable messages, e.g. `"/<name>" isn't an opencode command or skill, so it can't run in
the background`, `background runs aren't available on this box`, or the delegate's cap error.
The job then shows through the existing background-jobs surface (`BackgroundJobsSheet.swift`;
cards/approval are WS02's).

### iOS design
- Pure: `static func backgroundState(text: String, remote: [OpencodeCommandInfo]?) -> BackgroundToggleState?`
  returning nil (hidden) or `{ name, locked: Bool }`.
- ComposerView: `@State runInBackground = false`, reset to false in `onChange(of: text)`
  when `backgroundState` becomes nil. When visible, a single row **above** the input box
  inside the composer stack: `Toggle("Run in background", isOn:)` (compact, `tx2`, small
  type), disabled + on when `locked`, with `.accessibilityHint` = locked title. A second
  `Text` line holds the helper copy and uses `.opacity(on ? 1 : 0)` (reserved height, not
  removed — mirrors desktop's `invisible`, so toggling never resizes the composer).
- Send while active (`locked || runInBackground`) → F2's `sendCommand` with `background:
  true`, `delivery: nil`, model + plan agent included even while running (desktop sends
  them on the background path). Send button accessibility label "Run in background".
- Success copy: `{jobId}` → hint **"Running /<name> in the background — the result comes
  back here"**; `null` → same copy. Failure → keep draft, hint with the server message.

### Tests
- `backgroundState`: built-in → nil; unknown → nil; known → unlocked; `background: true`
  → locked; nil remote list → nil.

### Acceptance
- [ ] Typing `/review` shows the toggle; typing `/compact` or plain text does not.
- [ ] An always-background command shows the toggle on and disabled.
- [ ] Toggling never changes the composer's height.
- [ ] A background send does not interrupt a running turn and reports success/failure.

---

## F4 — `@` references in the typeahead

### Desktop behaviour
- Same `@` trigger as files (`useTypeahead.ts:175-195`). On the same debounced tick as the
  file search the desktop also fetches references (`useTypeahead.ts:132-157`).
- Rows: **non-hidden** references whose name contains the query (case-insensitive) come
  first, then files; total cap 20 (`useTypeahead.ts:263-282`). Row = `@alias` + description.
- Selecting inserts `@alias ` as plain text (no structured mention, `useTypeahead.ts:305-310`);
  opencode resolves the alias itself.
- References are managed in Settings → References (WS10 owns that screen).

### Wire contract
`opencode:references` — `httpApi.ts:1437` → `rpc.mjs:1992` → `opencode.mjs:2931-2950`.
Args `[]`. Response `[{ name: string, path?: string, repository?: string, branch?: string, description?: string, hidden?: boolean }]`
(`types.ts:3083-3091`). HTTP error rejects.

### iOS design
- `MantaAPIClient+Composer.swift`:
  ```swift
  struct OpencodeReferenceInfo: Decodable, Equatable, Sendable {
      var name: String; var path: String?; var repository: String?
      var branch: String?; var description: String?; var hidden: Bool?
  }
  func references() async throws -> [OpencodeReferenceInfo]   // "opencode:references", args []
  ```
- `ComposerTypeaheadSources.search` runs `findFiles` and `references()` **concurrently and
  independently** (`async let` each wrapped so a references failure leaves files intact —
  desktop's `Promise.all` loses both; iOS must not). Seq guard as today.
- Pure: `static func mentionRows(query: String, references: [OpencodeReferenceInfo], files: [String], limit: Int = 20) -> [MentionRow]`
  where `MentionRow { id, kind: .reference|.file|.agent, insertText, title, subtitle }`.
  Reference row: title `@alias`, subtitle `description ?? repository ?? path ?? ""`,
  icon `link` (repository) or `folder` (path).
- File-mode states: search in flight and no rows yet → non-tappable **"Searching…"**
  (desktop copy); finished and empty → **"No matching files"**; otherwise rows (scroll, ≤240 pt).
- Selecting a reference or file: replace the anchor with `@<insertText> ` (pure
  `applyMentionToken(_:to:anchor:) -> (text: String, caret: Int)`), **no** `Mention`.

### Tests (`ComposerTypeaheadTests.swift`)
- `mentionRows`: hidden references excluded; references before files; case-insensitive
  match; cap 20; subtitle fallback order.
- `applyMentionToken` replaces exactly the anchor range (UTF-16 offsets, emoji before the
  token) and appends one space.

### Acceptance
- [ ] With a reference `docs` configured, typing `@do` lists `@docs` above matching files.
- [ ] Hidden references never appear.
- [ ] If `opencode:references` fails, file results still show.
- [ ] Choosing `@docs` puts `@docs ` in the text and the sent prompt has no `mentions`.

---

## F5 — `@@` agent mentions (+ file-mention wire fix)

### Desktop behaviour (intended)
- A token starting `@@` (at line start or after whitespace) is agent mode; query = text
  after `@@` (`useTypeahead.ts:187-188`). Rows: agents from the box catalog whose name
  contains the query, cap 12, row `@@name` + description (`useTypeahead.ts:239-250`).
  Empty copy **"No matching agents"**.
- Selecting inserts `@name ` (single `@`) and records an agent mention (`useTypeahead.ts:307-317`).
- At send, mentions are resolved against the FINAL text by scanning for `@name` on word
  boundaries (`[A-Za-z0-9_]` neither side), first occurrence only; a mention whose token is
  gone is dropped (`chatShared.tsx:76-101`). Sent as `mentions: [{name, source:{value,start,end}}]`
  on `opencode:prompt` (prompt path only; never on run-command).
- (Desktop detection is broken — see top; iOS implements the intended grammar.)

### Wire contract
`opencode:prompt` `mentions` (already encoded by iOS, `MantaAPIClient.swift:99-109`) →
server `body.agents` (`opencode.mjs:671-676`). Offsets are UTF-16 code units (JS string
indices) — iOS already uses `NSString` units.

### iOS design
- `detectMention` gains a kind: `MentionAnchor { start, end, query, kind: .file | .agent }`.
  Detection walks back from the caret to the start of the whitespace-delimited token; the
  token must start with `@` and sit at BOF/after whitespace; `@@` prefix → `.agent` with
  query after `@@`, else `.file`. (Existing tests keep passing for `.file`.)
- ComposerView: agent mode reads `modelStore.agents` (no new fetch). `nil` → non-tappable
  **"Loading agents…"**; filtered empty → **"No matching agents"**. Rows: icon `person.crop.circle`,
  title `@name`, subtitle description.
- Selecting an agent: `applyMentionToken("@"+name)` and append `name` to
  `@State agentMentionNames: [String]` (replaces `draftMentions`).
- **Fix:** file/reference selection no longer records anything; `draftMentions` is removed.
  At submit (prompt path only): `mentions = ComposerTypeahead.resolveAgentMentions(text: trimmed, names: agentMentionNames)`
  (port of `chatShared.tsx:76-101`), nil when empty. Note the existing code sends
  `trimmed` text with offsets computed on the untrimmed draft — resolving against
  `trimmed` at submit removes that mismatch too.
- Clear `agentMentionNames` wherever `draftMentions` was cleared (submit, command success).

### Tests (`ComposerTypeaheadTests.swift`)
- `detectMention`: `"@@"` → agent, query `""`; `"hi @@pl"` → agent `pl`; `"@src"` → file;
  `"a@@b"` → nil; caret after the token → nil.
- `resolveAgentMentions`: `@build` not matched inside `@builder`; token deleted → dropped;
  offsets correct after an emoji; duplicate names resolve once.
- Update `testApplyMentionSerializesOntoSendArgs` / `testApplyMentionReplacesAnchorAndBuildsCorrectSourceRange`
  to the new `applyMentionToken` (files produce no mention).

### Acceptance
- [ ] `@@` lists the box's agents; `@@gen` narrows to matching ones.
- [ ] Choosing `general` inserts `@general ` and the sent prompt carries one mention whose
  `source` slice of the sent text is exactly `@general`.
- [ ] Deleting the `@general` text before sending sends no mention.
- [ ] Choosing a file sends **no** `mentions` key.

---

## F6 — C3: composer insertion API

### Why / callers
Quote (WS01, existing path in ChatScreen), "Send failures to the agent" (WS05 — desktop
**replaces** the composer text: `onFillComposer` → `updateInputWithHistoryReset`,
`SessionHeader.tsx:1582-1585`, `chatUtils.ts:4098-4105`), Attach artifact (WS07 — desktop
re-uploads the bytes as a new chip, `ArtifactsPanel.tsx:131-146`; on iOS the artifact
already sits on the box, so it attaches by path), inbox "start a session" (WS05 → F7).

### Design — new file `ComposerTextController.swift`
```swift
enum ComposerInsertMode: Equatable, Sendable {
    case append   // HandoffComposerCarry.appendBelow(current, text): blank line between, never overwrites
    case replace  // text replaces the draft; chips untouched
    case quote    // QuoteText.buildQuoteBlock(text) PREPENDED (today's Quote behaviour, desktop parity)
}

/// Pure, unit-tested core. No SwiftUI.
enum ComposerInsertion {
    static func insert(_ text: String, into draft: String, mode: ComposerInsertMode) -> String?   // nil = nothing to insert (blank input / unquotable)
    static func attach(remotePath: String, displayName: String, mime: String?,
                       to chips: [ComposerAttachment]) -> [ComposerAttachment]?               // nil = rejected (not absolute, or duplicate path)
}

@MainActor final class ComposerTextController: ObservableObject {
    @Published var text: String
    @Published var attachments: [ComposerAttachment]
    /// Bumped by every successful insert/attach; ChatScreen focuses the field on change.
    @Published private(set) var focusRequest = 0
    init(text: String = "", attachments: [ComposerAttachment] = [])
    convenience init(draft: NewSessionDraft)
    @discardableResult func insert(text: String, mode: ComposerInsertMode) -> Bool
    @discardableResult func attach(remotePath: String, displayName: String, mime: String?) -> Bool
    func newSessionDraft(cwd: String) -> NewSessionDraft   // current text + READY chips
}

extension EnvironmentValues { var composerController: ComposerTextController? }   // EnvironmentKey, default nil (pattern: HandoffStore.swift:459-471)
```
Rules:
- `insert` with blank/whitespace `text` → `false`, no change. `.quote` uses the existing
  `QuoteText.buildQuoteBlock` (single line, middle-truncated, `"> …\n\n"`) — the master
  spec's "prefix per line" wording is superseded by the shipped desktop/iOS behaviour
  (see Open questions).
- `attach`: `remotePath` must start with `/`; a chip with the same `remotePath` already
  present → `false` (no duplicate); `mime ?? ChatVoice.mime(forFilename: displayName)`
  (`ChatVoice.swift:21-29`), falling back to the path's last component when `displayName`
  has no extension; `isImage = mime.hasPrefix("image/")`; chip is created **ready**
  (`remotePath` set) so it goes straight through the existing send path
  (`ComposerView.submit` compactMap). Callers report `false` themselves (e.g. WS07:
  "Already attached").
- Callers must render their control only when `composerController != nil` (no dead
  controls on read-only surfaces such as `ChatSubagentScreen`).

### Mount (ChatScreen is WS02's — see Mount requests)
ChatScreen replaces `@State composerText` / `composerAttachments` with
`@StateObject composer`, binds `$composer.text` / `$composer.attachments` into ComposerView
(ComposerView's API is unchanged), injects `.environment(\.composerController, composer)`,
and `.onChange(of: composer.focusRequest) { composerFocused = true }`. `quote(_:into:)`
`.thisSession` becomes `composer.insert(text: selection, mode: .quote)`.

### Tests (`MantaUITests/ComposerInsertionTests.swift`, new)
- append into empty → text; append into `"hi\n"` → `"hi\n\nnew"`; replace; quote prepends
  `"> sel\n\n"`; quote of whitespace → nil; quote of 300 chars is middle-truncated (reuses
  `QuoteText`).
- attach: relative path rejected; duplicate path rejected; mime inferred from name
  (`a.png` → `image/png`, `isImage`); explicit mime wins; chip is not uploading.
- Controller (`@MainActor` test): `insert` bumps `focusRequest` only on success; blank
  insert leaves `text` and `focusRequest` unchanged.

### Acceptance
- [ ] Quote still prepends exactly as before (no visual change), now via the controller.
- [ ] `insert(.replace)` replaces the draft and keeps chips.
- [ ] `attach` adds a ready chip that is sent as an attachment on the next Send.
- [ ] Any insert/attach focuses the composer.

---

## F7 — C3: `NewSessionDraft`

In `ComposerTextController.swift`:
```swift
/// What a "start a session with this" action hands to WS04's create flow.
struct NewSessionDraft: Equatable {
    var cwd: String
    var text: String
    var attachments: [ComposerAttachment]   // READY chips only; the init drops uploading ones
    init(cwd: String, text: String, attachments: [ComposerAttachment] = [])
    var isEmpty: Bool                       // blank text and no attachments
    /// Reuses ChatScreen's existing carry-over seed (HandoffStore.swift:27-31,
    /// ChatScreen.swift:297-309) so WS04 opens the new chat pre-filled with no new plumbing.
    var carryOver: HandoffCarryOver { .init(text: text, attachments: attachments, skippedUploads: 0) }
}
```
Desktop's `NewSessionDraft` (`store.ts:220-246`) is a full pre-session composer (model,
worktree, plan, staged files); iOS needs only the hand-off value — WS04's create sheet owns
the other choices. Consumers: WS04 (create flow seeds the new chat via `carryOver`), WS05
(inbox "start a session"), WS01/WS02 ("Quote in new session" may keep today's fork seed —
not changed here).

Tests (`ComposerInsertionTests.swift`): init drops uploading chips; `isEmpty`; `carryOver`
round-trips text + chips with `skippedUploads == 0`; `ComposerTextController(draft:)` seeds
text + chips; `newSessionDraft(cwd:)` excludes uploading chips.

---

## Files

Edit (owned):
- `mobile/native/MantaUI/ComposerTypeahead.swift` — F1/F2/F3/F4/F5 pure logic.
- `mobile/native/MantaUI/ComposerView.swift` — palette/typeahead rows + states, sources
  wiring, submit flow, background toggle, agent mentions; remove `draftMentions`,
  `fileResults`, `fileSearchTask`, `fileSearchSeq` (moved).
- `mobile/native/MantaUITests/ComposerTypeaheadTests.swift` — extend/update.

Create (owned prefix):
- `mobile/native/MantaUI/MantaAPIClient+Composer.swift` — `OpencodeCommandInfo`,
  `OpencodeReferenceInfo`, `RunCommandInput`, `RunCommandResult`, `commands`, `references`,
  `runCommand`.
- `mobile/native/MantaUI/ComposerTypeaheadSources.swift` — remote lists store.
- `mobile/native/MantaUI/ComposerTextController.swift` — C3 (F6, F7).
- `mobile/native/MantaUITests/ComposerInsertionTests.swift`.
- Regenerate `.pbxproj` (xcodegen; sources are folder-globbed by `project.yml:45`).

No server files. No `generated/swift/*` change.

## Mount requests

To **WS02** (owner of `ChatScreen.swift`), apply in wave 0 by the orchestrator or first in
wave B — until applied, F6/F7 are unit-tested but unreachable from other screens:
1. `ChatScreen.swift:264-269` — replace `@State composerText` and `composerAttachments` with
   `@StateObject private var composer: ComposerTextController`; in `init` (297-309) seed it
   with `ComposerTextController(text: HandoffComposerCarry.appendBelow(seed, carryOver?.text ?? ""), attachments: carryOver?.attachments ?? [])`.
2. Every `composerText` / `composerAttachments` reference (459, 574-575, 710-712, 733, 741-742,
   1004) → `composer.text` / `composer.attachments` (`$composer.text` for the bindings).
3. Add `.environment(\.composerController, composer)` on the chat content root (so sheets
   presented from it — WS05 branch/checks sheet, WS07 artifacts — receive it), and
   `.onChange(of: composer.focusRequest) { _, _ in composerFocused = true }`.
4. `quote(_:into:)` `.thisSession` branch (1002-1006) → `composer.insert(text: selection, mode: .quote)`
   (the `buildQuoteBlock` guard stays for `.newSession`).

No other mounts: F1–F5 live entirely inside ComposerView.

## Contracts provided / consumed

- **C1 provided:** `MantaAPIClient+Composer.swift` (`commands`, `references`, `runCommand`).
  Consumed: existing `findFiles`, `agents` (via `ChatModelStore.agents`), `sendPrompt`.
- **C3 provided:** `ComposerInsertMode`, `ComposerInsertion`, `ComposerTextController`
  (`insert`, `attach`, `focusRequest`, `newSessionDraft(cwd:)`, `init(draft:)`),
  `EnvironmentValues.composerController`, `NewSessionDraft` (+ `carryOver`).
  Consumers: WS01 (quote, via WS02's mount), WS04 (`NewSessionDraft`), WS05 (`.replace`
  for failures, `NewSessionDraft` for inbox), WS07 (`attach`).
- **C4:** mount requests above (WS02).
- **C5 consumed (indirectly):** `commandExecuted` rendering of a command turn is WS01/WS02;
  nothing here decodes frames.
- **C7:** `ComposerTypeaheadTests.swift`, `ComposerInsertionTests.swift`.

## Deferred

- **Coloured `/name` highlight inside the input** (`SlashComposerParts.tsx:33-64`): needs a
  UIKit attributed text view replacing the SwiftUI editor; purely cosmetic — the "Run in
  background" toggle already signals a recognised command.
- **`/help`** (desktop shows a keyboard-shortcut notice, `ChatPanel.tsx:144-158`): content is
  desktop shortcuts; meaningless on a phone.
- **"Model doesn't support file attachments" warning row** in `@` file mode
  (`useTypeahead.ts:251-262`): file mentions are text paths, unrelated to this workstream's
  scope; belongs with model capability work (WS09) if wanted.
- **Optimistic "sending…" row for commands**: the pending/optimistic pipeline lives in
  `ChatSessionStore` (WS02). The Send spinner + hint cover feedback; WS02 may add a
  `sendCommand` to the store later and the composer would switch to it.

## Open questions

1. **`.quote` format.** Master C3 says "prefix `> ` per line + blank line"; shipped desktop
   and iOS collapse to one middle-truncated line and prepend. *Default:* keep the shipped
   behaviour (reuse `QuoteText.buildQuoteBlock`); amend C3 wording.
2. **Desktop `@@` agent typeahead is unreachable** (`useTypeahead.ts:177-182`). Not in any
   workstream's ownership. *Default:* WS03 fixes it in the same PR (detect the token start,
   not the last `@`) with a `useTypeahead.test.tsx` case for `"@@"`, `"hi @@pl"`; if the
   orchestrator prefers strict ownership, file a follow-up issue instead.
3. **Who applies the ChatScreen mount (C3 adoption)?** *Default:* the wave-0 orchestrator,
   as part of "composer insertion API signatures stubbed", so WS01/WS07 can call it in
   waves A/B; otherwise WS02 does it first thing in wave B.
