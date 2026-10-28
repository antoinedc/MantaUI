# WS04 — Sessions (iOS ↔ desktop parity)

Status: draft · Date: 2026-10-28 · Wave: **A** · Master: `00-master.md`

Scope (from the master table): rename inside chat; per-session mode switch
(chat / terminal / installed AI CLI); create a terminal-only or CLI session;
new-session options (git worktree + editable branch name, Start from scratch);
repository scan / first-run setup; Clone from GitHub; close a whole project;
uncommitted-worktree prompt on close; "N subagents" + "stopped by a provider
limit" in session rows; quick session switcher; C2 `MantaNavigation`; the
`NewSessionDraft` consumer.

**No new server routes.** Every feature below uses a `/rpc` channel the desktop
already calls. No server file is edited, so this workstream needs no
`rpc.mjs` / `index.mjs` slot in wave A.

---

## 0. Baseline — what iOS has today (do not rebuild)

| Area | Where | Notes |
|---|---|---|
| Session list, grouped + flat orderings, search, All/Recent filter | `SessionListView.swift` | single `sheetRoute` binding (`:30`), `NavigationPath` stack (`:42`), destinations `:134-145` |
| Row context menu Rename · Pin · Fork · Delete, swipe actions | `SessionListView.swift:468-504` | rename sheet `:733-761` calls `store.renameSession` |
| Delete with 5 s undo, running-turn confirm | `SessionListStore.swift:559-617`, `SessionListView.swift:520-583` | RPC held until the toast expires |
| Create sheet: existing project or new project + folder, worktree fan-out | `SessionCreateSheet.swift` (whole file) | always `chatMode: true` |
| Folder picker + worktree fan-out prompt | `FolderPickerView.swift` | see bug B1 |
| Terminal screen (xterm in WKWebView over `/pty` WS) | `TerminalScreen.swift`, `TerminalWebView.swift:427-446`, `TerminalModels.swift:162-180` | shell in the window's cwd; pty key `"<session>:<index>"`; no launcher support |
| "Open terminal" from the chat overflow sheet | `ChatOverflowSheet.swift:111`, `ChatScreen.swift:1012-1023` | pushes `SessionOpenTarget(sessionId: nil)` |
| Row status (running / needs you / background jobs / progress / model) | `SessionListStore.swift:380-407`, `SessionModels.swift:391-425` | terminal windows read the `kind:"status"` poller (`:521-534`, has `subagents`, unused) |
| Live subagent records per chat session | `MantaEventStore.swift:256-268` (`sessionStates[sid].subagents`, `StreamSubagentPayload` in `MantaStreamModels.swift:313-331`) | statuses `running`/`pending`/`completed`/`error` |
| Push-notification deep link | `MantaDeepLink.swift:22-40`, `SessionListView.swift:228-241` | appends a `SessionOpenTarget` |
| Real app root | `MantaAppRoot.swift:97-110` (paired → `SessionListView`) | `RootView.swift` is only the capture-harness fixture (see §11) |

### Bugs found while researching (fix as part of this WS — they block features here)

- **B1 — the folder picker can never list a folder.** `MantaAPIClient.listDirs`
  (`MantaAPIClient.swift:338-341`) decodes `fs:list-dirs` as `[String]`, but the
  server returns a `DirListing` object `{dir, entries:[{name, path, hidden}]}`
  (`src/server/local.mjs:448-480`, `src/shared/types.ts:471-475`). The decode
  throws, so `FolderPickerView.listDirectory` (`:211-227`, the view's own private
  method) always shows
  "Couldn't list folder". Fix: new `fsListDirectory(_:)` in
  `MantaAPIClient+Sessions.swift` returning `SessionDirListing`; switch
  `FolderPickerView` to it, filter `hidden` entries (desktop filters dotdirs),
  use `entry.path` (absolute) as the row path. Leave the old `listDirs` in
  place (C1: we don't edit `MantaAPIClient.swift`) but stop calling it.
- **B2 — `TmuxCreateResult` drops the created window's identity.**
  (`SessionModels.swift:325-339`.) The box returns
  `{sessionId, windowIndex, projects}` (`src/shared/types.ts:439-443`); iOS finds
  the window by name, which mixes up same-named windows (the exact bug the
  desktop comment in `NewSessionScreen.tsx:20-22` describes). Add
  `let sessionId: String?` and `let windowIndex: Int?` (both nil for the legacy
  bare-array reply). New create paths in this WS use `windowIndex` first, name
  lookup only as fallback.

---

## 1. Rename inside the chat (+ rename a project)

### Desktop today
- Rename lives in the sidebar, which is always visible next to the chat:
  double-click / F2 on a row or a project header opens an inline field
  (`src/renderer/Sidebar.tsx:345-375`). Empty or unchanged name → cancel with no
  RPC. Project rename calls `tmuxRenameSession`, session rename
  `tmuxRenameWindow`; then `refresh()`. Failure → error toast with the message.
- The AI can also rename (app-control bus `renameSession` → refresh,
  `App.tsx:1253-1256`).
- On a phone the list is not visible while in a chat, so parity means a rename
  entry *inside* the chat.

### Wire contract (existing)
| Channel | Args | Reply | Server |
|---|---|---|---|
| `tmux:rename-window` | `[{sessionName, windowIndex, newName}]` | `Project[]` | `rpc.mjs:1284-1288` → `tmux.renameWindow` (`tmux.mjs:698-701`) |
| `tmux:rename-session` | `[{oldName, newName}]` | `Project[]` | `rpc.mjs:1279-1283` → `tmux.renameSession` (`tmux.mjs:644-656`) |

Errors: tmux's stderr in the thrown message (e.g. duplicate session name).
Note tmux silently turns `.` and `:` in a session name into `_`.

### iOS design
- **New `SessionRenameSheet.swift`**: one reusable sheet
  `SessionRenameSheet(title: String, initialName: String, onSave: (String) async -> String?)`
  — `onSave` returns `nil` on success or an error message. Stock `Form`
  (`TextField`, toolbar Cancel / Save), autofocus, autocorrection off. Save is
  disabled while the trimmed value is empty or unchanged; while saving show a
  `ProgressView` and disable the form; on error show the message in red under
  the field and keep the sheet open. Replaces the hand-rolled `renameSheet` in
  `SessionListView.swift:733-761` (same sheet for list rows, chat, projects).
- **Store** (`SessionListStore`):
  - Change `renameSession(project:index:newName:)` to return `String?`
    (error message) instead of only publishing `actionMessage`; the list path
    keeps today's toast by setting `actionMessage` from the returned value.
  - Add `renameProject(oldName:newName:) async -> String?` →
    `tmuxRenameSession` (`tmux:rename-session`), then `refresh()`. If the renamed project has open
    pinned ids, leave them (desktop does not migrate pins either).
  - Add `window(forSessionID:) -> (project: String, window: MantaWindow)?` —
    used by the chat title and by C2.
  - Error copy: `"Couldn't rename — <server message>"`, falling back to
    `"Couldn't rename — check the connection"` when the message is empty.
- **In chat** (M-04-1 applied by WS07, M-04-3/M-04-4 applied by WS02 — §14): overflow sheet row
  "Rename session" (`pencil`) presents `SessionRenameSheet(title: "Rename
  session", initialName: <live window name>)`; the chat nav title reads
  `sessionStore.window(forSessionID: sid)?.window.name ?? title` so it updates
  after the refresh.
- **Project rename**: group header menu (see §7) → "Rename project…" →
  `SessionRenameSheet(title: "Rename project")`.

### Pure logic + tests (`MantaUITests/SessionsTests.swift`)
`SessionRenameLogic.validated(_ input: String, current: String) -> String?`
(trimmed, nil when empty or unchanged) — in `SessionCreateLogic.swift`
(Linux-eligible).
- `testRenameRejectsEmptyAndWhitespace`, `testRenameRejectsUnchanged`,
  `testRenameTrims`.
- Store (Mac, `SessionStoreTests.swift`): extend the existing mutation seam
  (`SessionListMutationAPI`, `SessionListStore.swift:28-45`) with
  `renameProject` — `testRenameFailureReturnsMessageAndDoesNotRefresh`,
  `testRenameSuccessRefreshes`, `testRenameProjectFailureReturnsMessage`.

### Acceptance
- [ ] From a chat, overflow → Rename session → Save renames the tmux window; the
      nav title and the list row show the new name without leaving the chat.
- [ ] Empty/unchanged name cannot be saved; a rejected rename keeps the sheet
      open with the reason.
- [ ] Project header menu → Rename project renames the group.

---

## 2. Per-session mode switch (Chat / Terminal / installed AI CLI)

### Desktop today
- Session menu (`SessionHeader.tsx:909-1131`) has a **Mode** group: "Chat",
  "Terminal", then an **AI-CLI** group with one row per launcher
  (`:1082-1102`), current mode checked. Header glyph toggles Chat ↔ Terminal
  (`App.tsx:2130-2134`).
- Mode type `"chat" | "terminal" | "tui:<launcherId>"`, persisted **per device**
  per session in localStorage key `manta:session:<sid>:mode`
  (`chatShared.tsx:422-457`). Default always `chat`. A saved `tui:<id>` whose
  launcher is no longer installed downgrades to `chat`.
- Windows with no opencode session (adopted tmux windows) are forced to
  `terminal` and get no mode menu (`App.tsx:463-485`).
- Terminal/CLI modes spawn a pty in the window's cwd: plain shell, or the
  launcher's CLI with flags = schema defaults overlaid by the user's saved
  `launcherFlags[id]` (`App.tsx:2185-2199`, `chatShared.tsx:504-511`). Launchers
  are fetched on active-session change (`App.tsx:452-461`).

### Wire contract (existing)
| Channel / route | Args | Reply | Server |
|---|---|---|---|
| `launchers:list` | `[]` | `AvailableLauncher[]` = `[{id, label, flags:[{key,label,type:"boolean",default}]}]` (only installed, non-hidden) | `rpc.mjs:2640-2645` → `launchers.mjs:37-60` |
| `config:get` | `[]` | config object; read `launcherFlags: {[launcherId]: {[flagKey]: Bool}}` | existing |
| `GET /pty` (WS) | query `session=<key>&cwd=&cols=&rows=&launcher=<json {id, flags}>` | raw bytes; `{type:"error"}` JSON text | `ptyWs.mjs:164-179` (`launcher` already parsed and passed to `pty.spawn`) |

The desktop uses `pty:spawn` RPC + bus events; iOS keeps its existing `/pty`
WS (same pty module, same `launcher` option). Unknown launcher id → the server
falls back to a plain shell (`pty.mjs:72-90`).

### iOS design
- **Launcher discovery is WS10's client member** (D16): WS04 calls WS10's
  `launchersList() -> [AvailableLauncher]` (`MantaAPIClient+Settings.swift`,
  wave A) and resolves flags with WS10's `ExtensionsLaunchers.resolve(schema:
  saved:)` (port of `chatShared.tsx:504-511`). WS04 declares no launcher wire
  type or flag resolver of its own.
- **New `SessionModeLogic.swift`** (pure, Foundation-only, takes plain ids):
  ```swift
  enum SessionMode: Hashable, Sendable {
      case chat, terminal, cli(launcherID: String)
      var raw: String                       // "chat" | "terminal" | "tui:<id>" (desktop-identical)
      init(raw: String?)                     // parse only; unknown → .chat
  }
  enum SessionLauncherCatalog: Equatable, Sendable {
      case loading                           // never loaded on this launch
      case loaded(ids: [String])             // last SUCCESSFUL launchers:list (authoritative)
      case failed(message: String, lastGood: [String]?)
      var authoritativeIDs: [String]?        // loaded ids, or failed.lastGood; nil = unknown
  }
  enum SessionModeResolution: Equatable, Sendable {
      case ready(SessionMode)
      case waiting(launcherID: String)       // saved CLI, catalog unknown → don't guess
      static func resolve(saved: SessionMode, catalog: SessionLauncherCatalog) -> Self
      // chat/terminal → .ready as-is
      // cli(id): authoritativeIDs contains id → .ready(.cli); authoritativeIDs present
      //          but lacks id → .ready(.chat) (downgrade ONLY on an authoritative list);
      //          authoritativeIDs nil → .waiting(id)
  }
  enum SessionModeStore {                   // UserDefaults, key "manta:session:<sid>:mode"
      static func read(sessionID: String, defaults: UserDefaults = .standard) -> SessionMode
      static func write(_ mode: SessionMode, sessionID: String, defaults: UserDefaults = .standard)
  }
  enum SessionPtyKey {
      static func key(project: String, windowIndex: Int, mode: SessionMode) -> String
      // .terminal → "<project>:<index>" (unchanged, keeps today's key)
      // .cli(id)  → "<project>:<index>:tui:<id>"
  }
  struct SessionPtyLauncher: Equatable, Sendable { var id: String; var flags: [String: Bool]
      var queryJSON: String }               // compact, sorted keys: {"flags":{…},"id":"…"}
  ```
  The saved mode is NEVER rewritten by a downgrade — a later authoritative list
  that contains the CLI again restores it (desktop also leaves localStorage
  alone, `chatShared.tsx:434-449`).
- **Store** (`SessionListStore`): `@Published private(set) var launcherCatalog:
  SessionLauncherCatalog = .loading`, `launchers: [AvailableLauncher]` (last
  good list) and `launcherFlags: [String: [String: Bool]]` (read in
  `loadConfig`, `SessionListStore.swift:657-676`). `refreshLaunchers()` runs
  in `fetchOnce` after the project list (decoration: it never blanks the list)
  and on demand from a Retry button. Success → `.loaded`; failure → `.failed`
  keeping `lastGood` and the previous `launchers`.
- **`SessionOpenTarget`** (`SessionListView.swift:1050-1070`) gains
  `var mode: SessionMode? = nil` and **mode participates in `==`/`hash`** (a
  different mode is a different destination; `seed` stays out of identity).
- **Routing** (`SessionListView` `navigationDestination`, `:134-145`): a target
  with a `sessionId` resolves `SessionModeResolution.resolve(saved: target.mode
  ?? SessionModeStore.read(sid), catalog:)`:
  - `.ready(.chat)` → `ChatScreen` (today's path);
  - `.ready(.terminal | .cli)` → `TerminalScreen(window:, project:,
    sessionStore:, mode:, sessionID:)`;
  - `.waiting(id)` → **new `SessionModePendingView`** (same navigation slot,
    observes the store): `.loading` → `ProgressView` + "Checking which AI CLIs
    are installed…"; `.failed` with no snapshot → "Couldn't check which AI CLIs
    are installed on your server." + **Try again** (`refreshLaunchers()`) +
    **Open in chat**; as soon as the catalog becomes authoritative it swaps
    in-place to the resolved screen (chat if the CLI is gone, with the toast
    "<id> isn't installed on your server — opened in chat").
  - No `sessionId` → terminal as today.
- **Switching** goes through C2: `MantaNavigator.switchMode(windowKey:,
  sessionID:, to:)` writes the mode then `open(.session(windowKey:))`, which
  replaces the top of the stack with the same session in the new mode (§11).
- **Menu UI — new `SessionModeMenu.swift`**:
  - `SessionModeRows(current: SessionMode, launchers: [AvailableLauncher],
    catalog: SessionLauncherCatalog, onSelect: (SessionMode) -> Void, onRetry:
    () -> Void)` — `Section("Mode")` with "Chat" (`bubble.left`), "Terminal"
    (`terminal`); then `Section("AI CLI")`: one row per launcher (`cpu`) when
    there is a list; a disabled "Checking…" row while `.loading` with no list; a
    "Couldn't load AI CLIs — Try again" row when `.failed` with no list; the
    section is omitted only when an authoritative list is empty. Checkmark on
    the current mode. Used by the chat overflow sheet (M-04-2).
  - `SessionModeMenu(...)` — the same items in a SwiftUI `Menu` (`Picker`
    inside, so the current one is checked) for the terminal header.
  - Selecting the current mode just dismisses (desktop: harmless close).
  - Not rendered for a window without an opencode session (desktop hides it).
- **Terminal screen / socket** (D1 ownership + amendment for
  `TerminalSocket.swift`, §18.1): `TerminalScreen` takes `mode: SessionMode`
  (default `.terminal`) and `sessionID: String?`; subtitle shows the launcher
  label for `.cli`; the empty trailing slot (`TerminalScreen.swift:103-106`)
  becomes `SessionModeMenu` + the switcher button (§10) when `sessionID !=
  nil`. `TerminalContainerView` → `TerminalWebView` pass
  `launcher: SessionPtyLauncher?` and use `SessionPtyKey.key(...)`
  (`TerminalWebView.swift:427-438`). **`TerminalSocket`** gains an init
  parameter `launcher: SessionPtyLauncher? = nil`, stored as `let`, and its URL
  construction moves into a static `TerminalSocket.makeRequest(serverURL:,
  sessionKey:, cols:, rows:, cwd:, launcher:, token:) -> URLRequest?` that
  `open()` (`TerminalSocket.swift:122-131`) calls on the first connect AND every
  reconnect — so a reconnect re-launches the same CLI. The bearer header stays
  exactly as today (`Authorization: Bearer <token>`, never in the URL).
  `TerminalURLBuilder.ptyURL` (`TerminalModels.swift:162-180`) gains
  `launcher: SessionPtyLauncher? = nil` and appends `launcher=<queryJSON>`.
  Only visible launchers from `launchers:list` are ever sent (WS08 S1 makes
  `/pty` refuse hidden ones, `08-accounts.md:679`).
  `ChatScreen.openTerminal` (`:1012-1023`) keeps pushing the plain terminal;
  the overflow's "Open terminal" row is replaced by the Mode rows (M-04-2).

### Pure logic + tests (`SessionsTests.swift`, Linux-eligible)
- `testModeRawRoundTrip` (`chat`, `terminal`, `tui:claude`),
  `testUnknownRawParsesAsChat`.
- `testResolveCliWaitsWhileCatalogLoading`,
  `testResolveCliWaitsAfterFailureWithoutSnapshot`,
  `testResolveCliUsesLastGoodSnapshotAfterFailure`,
  `testResolveCliDowngradesOnlyOnAuthoritativeList`,
  `testResolveInstalledCliKept`, `testResolveChatAndTerminalNeverWait`.
- `testDowngradeDoesNotRewriteSavedMode` (store read after resolve).
- `testPtyKeyTerminalKeepsLegacyKey`, `testPtyKeyCliIsDistinct`,
  `testPtyLauncherQueryJSONIsStable`.
- `TerminalModelsTests` (Mac): `testPtyURLCarriesLauncherJSON`,
  `testPtyURLOmitsLauncherWhenNil`, **`testSocketRequestCarriesLauncherAndBearer`**
  (`TerminalSocket.makeRequest` — URL has `launcher=…`, header `Authorization:
  Bearer t`, no token in the URL), `testSocketRequestWithoutTokenHasNoHeader`.
- Store (Mac, `SessionStoreTests.swift`): `testLauncherFailureKeepsLastGood`,
  `testLauncherInitialFailureIsFailedWithoutSnapshot`.
- `SessionOpenTarget` identity (Mac): `testTargetsWithDifferentModesAreDifferent`.

### Acceptance
- [ ] Chat overflow shows Mode (Chat ✓ / Terminal / each installed CLI);
      choosing Terminal or a CLI replaces the chat with the terminal running
      that mode in the session's folder; the terminal header menu switches back
      to Chat.
- [ ] Reopening the session from the list opens it in its last mode on this
      device; a CLI that the box reports as uninstalled opens Chat; a network
      failure while checking shows "Checking…" / "Try again", never silently
      switches to Chat.
- [ ] Backgrounding and returning to a CLI terminal reconnects to the same CLI
      (not a plain shell).
- [ ] A CLI launches with the user's saved flags (`launcherFlags`), defaults
      otherwise.
- [ ] Adopted (non-chat) windows show no mode menu.

---
## 3. Create a terminal-only or CLI session

### Desktop today
Every new session is a chat-mode window (`chatMode: true` at all create sites:
`NewSessionScreen.tsx:380, 698, 705, 795, 803`); a "terminal" or "CLI" session
is a session whose mode was switched (§2). There is no `chatMode:false` create.

### iOS design
- Create sheet (§4) gets an **"Open as"** `Picker` (menu style) in its session
  section: "Chat" (default), "Terminal", then each launcher label from `store.launchers`
  (only when the catalog is authoritative; while loading/failed the picker shows
  Chat and Terminal plus a footer "Couldn't check which AI CLIs are installed —
  Try again" with a working retry). The window is still created with `chatMode: true` (so it can
  switch back to chat later, desktop parity); after create the chosen mode is
  written with `SessionModeStore.write` for the returned `sessionId` and the
  pushed target carries `mode:`.
- If the reply has no `sessionId` (legacy box) and a non-chat mode was chosen,
  push the plain terminal target (`sessionId: nil`) — the shell still opens;
  no silent drop.
- Not offered for the repo batch / clone / fan-out paths (they create many
  sessions at once; desktop lands those in chat).

### Tests
`SessionCreatePlan` (§4) cases: `testOpenAsTerminalWritesModeAndPushesTerminal`,
`testOpenAsCliWithoutSessionIdFallsBackToPlainTerminal`.

### Acceptance
- [ ] Choosing "Open as: Terminal" (or a CLI) creates the session and lands in
      the terminal (or the CLI) for it; mode menu offers Chat.

---

## 4. New-session options: git worktree + branch name; Start from scratch

### Desktop today (`NewSessionScreen.tsx`)
- **Worktree chip**: shown once the folder is a git repo (probe
  `gitListWorktrees(cwd)`, non-empty = repo, `:584-606`). Checkbox "worktree"
  (aria "Create in a fresh git worktree", `:1025-1031`); when checked an inline
  field replaces the branch label: placeholder `branch-name`, aria "Worktree
  branch name" (`:1001-1010`). Defaults: new-session-in-project →
  `wantWorktree = config.worktreePerSession`; new project → off;
  `worktreeBranch = "worktree"` (`store.ts:979-1006`). Not shown in scratch mode.
- **Submit with worktree** (`:655-740`, worktree at `:678-681`): `gitAddWorktree({cwd, name: branch})`
  → `{path, branch}` (server slugifies/dedups the branch and puts the worktree
  next to the repo root, `local.mjs:294-325`); then new-project →
  `tmuxNewSession({name, cwd: path, windowName:"default", chatMode:true})`;
  existing project → `tmuxNewWindow({sessionName, windowName, cwd: path,
  chatMode:true, worktreePath: path})` (the stamp is what clean-on-close keys
  on). Any error is shown; nothing is undone.
- **Start from scratch** (`:485-545, 655-668, 905-925, 1034-1050`): heading
  "Start something new"; "Project name" field (pre-filled with a random
  `adjective-noun-noun`); destination line `↳ <root>/<slug> · edit`;
  hint `"Add at least one letter or number — that becomes the folder name."`
  when the slug is empty, `"<slug> already exists — will create <unique>"` on a
  collision (entries of `fsListDirs(root)` ∪ project names). Root defaults to the
  probe's proposed workspace root (common parent of found repos, else
  `<home>/projects`; empty when unknown → disabled). Create label
  "Create workspace" when no prompt. Submit: `projectCreateScratch({root,
  name})` → `{path, name}` then `tmuxNewSession({name:
  uniqueSessionName(deriveProjectName(path), taken), cwd: path,
  windowName:"default", chatMode:true})` (no `createDir`).

### Wire contract (existing)
| Channel | Args | Reply | Server |
|---|---|---|---|
| `git:list-worktrees` | `[cwd]` | `WorktreeInfo[]` (already in iOS) | `rpc.mjs:914` |
| `git:add-worktree` | `[{cwd, name}]` | `{path, branch}`; throws with git's stderr | `rpc.mjs:919` → `local.mjs:294-325` |
| `tmux:new-window` | `[{sessionName, windowName, cwd?, chatMode?, worktreePath?}]` | `{sessionId, windowIndex, projects}` | `rpc.mjs:1274-1278` |
| `tmux:new-session` | `[{name, cwd, windowName?, chatMode?, createDir?}]` | `{sessionId, windowIndex, projects}` | `rpc.mjs:1244-1270` |
| `project:create-scratch` | `[{root, name}]` | `{path, name}`; throws `"root is required"` / `"name is required"` | `rpc.mjs:935` → `local.mjs:405-431` |
| `fs:list-dirs` | `[dir]` | `{dir, entries:[{name,path,hidden}]}` | `rpc.mjs:930` → `local.mjs:448-480` |
| `config:get` | `[]` | read `worktreePerSession: Bool` (default false) | existing |

### iOS design — `SessionCreateSheet` restructured
Keep stock `NavigationStack` + `Form` (`SessionCreateSheet.swift:49-120`).
Init becomes `SessionCreateSheet(store: SessionListStore, initialProject:
String?, draft: NewSessionDraft?, onClose:, onCreated: (SessionCreated) -> Void)`
where `SessionCreated = {project, windowIndex, sessionId?, projects, mode,
draft: NewSessionDraft?}` (the draft after "Don't carry over" was applied).

Sections, by target:

**Existing project**
1. Project picker (unchanged).
2. "Session": Name (optional, footer unchanged); **Folder** row (defaults to
   the project's `defaultCwd`, else first window's `paneCurrentPath`; tap →
   `FolderPickerView`); **Open as** (§3).
3. "Git worktree" — shown only when `git:list-worktrees(folder)` is non-empty:
   Toggle "Create in a fresh git worktree" (default = the box's
   `worktreePerSession`, read with a fresh `config:get` when the sheet opens —
   WS10 contract; a failed read = off; a draft's `worktreeBranch` overrides it,
   §12); when on, `TextField("Branch name", text:, prompt: "worktree")`
   (default `"worktree"`, or the draft's branch; autocaps/autocorrect off) and
   footer "The branch is created next to the repository; a name already in use
   gets a number added." While the probe runs the section shows a small
   `ProgressView` row "Checking for git…"; probe failure hides the section.

**New project** — see §5 for the scan section that leads it. Once a source is
picked:
- *Folder* (existing behaviour) + the same "Git worktree" section (default
  **off**, desktop parity) + Open as. The Name field is pre-filled with
  `SessionNaming.unique(SessionNaming.deriveProjectName(folder), taken:)` when
  the user has not typed one.
- *Start from scratch*: "Project name" field (empty, placeholder
  "Project name"); "Location" row showing `root` (tap → folder picker targeting
  the root); a monospaced footnote `↳ <root>/<slug>`; the hint line (warn colour)
  from `SessionScratchHint.text(slug:, taken:)`. `taken` = names from
  `fsListDirectory(root)` entries ∪ project names. Confirm label "Create
  workspace". Root default = `SessionWorkspaceRoot.proposed(repoPaths:,
  homeDir:)` from the scan (§5); if empty, "Location" reads "Choose a folder"
  and Create stays disabled.

**Confirm button**: one toolbar confirmation button whose label and enabled
state come from the pure `SessionCreatePlan.make(form)` ("Create", "Create
workspace", "Set up N workspaces"). Disabled with the form while creating;
`ProgressView` overlay as today.

**Create flows** (all in the sheet's private `create()`; every failure sets
the red error row with the server message via `SessionCreateFailure.message`):
- Existing project, no worktree: `createWindow(SessionNewWindowInput(
  sessionName:, windowName: name|"session", cwd: folder (nil when equal to the
  project default), chatMode: true))`.
- Existing project + worktree: `gitAddWorktree(cwd: folder, name: branch)` →
  `createWindow(SessionNewWindowInput(…, cwd: wt.path, worktreePath: wt.path))`. If the second call
  fails: error `"Created worktree at <path>, but couldn't open a session in it:
  <message>"`.
- New project folder (+ optional worktree): as desktop (`createSession`
  with `cwd: wt.path ?? folder`, `createDir: true` only when no worktree).
- Fan-out (existing code, `:208-221`) unchanged except it uses `windowIndex`.
- Scratch: `projectCreateScratch(root:, name:)` →
  `createSession(SessionNewProjectInput(name: unique(deriveProjectName(path)),
  cwd: path, windowName: "default", chatMode: true, createDir: false))`.
- On success: resolve the window by `windowIndex` (fallback: name, then last
  window), write the mode (§3), call `onCreated`. `SessionListView` adopts the
  projects and pushes `SessionOpenTarget(…, mode:, seed: draft?.text,
  carryOver: SessionDraftCarry.carryOver(draft))` (§12).

**Deliberate deviation:** the desktop pre-fills a random three-word name from a
53 KB vendored word list (`src/shared/friendlyWords.mjs`). iOS starts the name
empty and blocks Create until it slugs to something — see Deferred.

### Pure logic (`SessionCreateLogic.swift`) + tests
Ports of `src/shared/projectName.mjs` (byte-for-byte behaviour):
`SessionNaming.slugify(_:)` (NFKD, strip diacritics, lowercase, `[^a-z0-9]+`→`-`,
trim `-`, max 32, re-trim), `deriveProjectName(_:)` (basename, `"~"`/empty →
`"project"`), `unique(_:taken:)` (`base`, `base-2`, …),
`promptWindowName(_:)` (not used on iOS yet — skip).
`SessionScratchHint.text(slug:taken:) -> String?`.
`SessionWorkspaceRoot.proposed(repoPaths:homeDir:) -> String` (common-parent
walk of `NewSessionScreen.tsx:485-500`; `""` when nothing known).
`SessionCreatePlan.make(_ form: SessionCreateForm) -> (label, enabled, kind)`.

Tests (`SessionsTests.swift`), mirroring `src/shared/projectName.test.ts`
where cases exist:
- slugify: `"My App!"`→`"my-app"`, `"Café"`→`"cafe"`, all-punctuation→`""`,
  CJK→`""`, 40 chars → 32 with no trailing `-`.
- `deriveProjectName("/a/b/")`→`"b"`, `("~")`→`"project"`, `("")`→`"project"`.
- `unique("x", ["x","x-2"])`→`"x-3"`, free name unchanged.
- scratch hint: empty slug message; collision message names the unique name;
  free → nil.
- workspace root: no repos + home → `<home>/projects`; repos sharing
  `/home/u/code` → that; repos with only `/` in common → `<home>/projects`; no
  repos, no home → `""`.
- plan: existing project → "Create" enabled; new project with empty name →
  disabled; scratch empty slug → disabled, label "Create workspace"; repos
  checked → "Set up 2 workspaces"; worktree on with empty branch → disabled.

### Acceptance
- [ ] In a git project, "Create in a fresh git worktree" + branch name creates a
      sibling worktree and a session in it; the row's window carries the
      worktree (clean-on-close works on it, §8).
- [ ] The worktree toggle defaults to the box's "Create git worktree for new
      sessions" setting for existing projects and off for new projects.
- [ ] Start from scratch creates `<root>/<slug>` (git-initialised by the box)
      and a project for it; collisions show the hint and land on the
      de-duplicated folder.
- [ ] Every failure shows the server's reason in the sheet; nothing is left
      half-created silently.

---

## 5. Repository scan / first-run setup

### Desktop today (`NewSessionScreen.tsx:238-412, 1190-1365`)
New-project mode probes the box (`forgeProbe`) and shows:
- **scanning**: "What's up next?" / "Looking for repositories on your server…"
  + skeleton rows + "Browse for a folder…", "Start from scratch".
- **degraded** (probe failed): "Couldn't scan for repositories. Point Manta at a
  folder instead." + Browse (primary), Start from scratch.
- **fresh** (0 repos): "Let's get some code on this server" / "No repositories
  found. Clone one from GitHub, or point Manta at a folder." + "Clone from
  GitHub…" (primary), Browse, Start from scratch.
- **list**: "Found N repositories on your server." (+ "GitHub connected as
  @login" when the gh CLI is authenticated); rows with checkbox, name,
  secondary `describeRepoRow` (`⎇ branch`, or `⎇ branch · ~/path · no remote`),
  trailing age (`formatAge`: now/Nm/Nh/Nd); nothing pre-checked. Footer
  "Set up N workspaces" (disabled at 0), Browse, Clone, Scratch.
- **Batch**: for each checked repo, in order, `tmuxNewSession({name:
  unique(deriveProjectName(path), taken), cwd: path, windowName:"default",
  chatMode:true, createDir:false})`; per-row status queued → creating… → ready
  / error (message) + **Retry**. All succeed → land in the first created.
  Partial failure → stay; "Done" lands in the first success or dismisses.
  (`:330-412`)
- `zeroStateMode`, `describeRepoRow`, `homeRelativePath`, `formatAge` are pure
  (`chatUtils.ts:4198-4230, 542-550`).
- The "use a different account" link is a dead "Not available yet" label on
  desktop — **do not port it** (no dead controls).

### Wire contract (existing)
| Channel | Args | Reply | Server |
|---|---|---|---|
| `forge:probe` | `[]` | `{repos:[RepoHit], cli:{installed, authenticated, login}, partial, homeDir}`; `RepoHit = {path, name, branch?, originUrl?, forge?, repoKey?, lastCommitAt?}` (ms) | `rpc.mjs:944` → `local.mjs:1030-1045` (60 s cache) |
| `tmux:new-session` | as §4 | as §4 | |

### iOS design
- **New `SessionRepoScanSection.swift`**: a `Section` rendered first in the
  create sheet when target = New project and no source has been chosen yet.
  States = `RepoZeroState.mode(pending:failed:repos:)`:
  - scanning: row with `ProgressView` + "Looking for repositories on your
    server…".
  - degraded / fresh / list: copy as desktop above (header text), list rows
    as `Button` rows with a leading checkmark circle (`checkmark.circle.fill` /
    `circle`), name, secondary line, trailing age; footer "Found N
    repositories…" + optional "GitHub connected as @login".
  - Then an actions `Section`: "Browse for a folder…" (opens the picker; the
    chosen folder switches the sheet to *Folder* source), "Clone from GitHub…"
    (pushes §6 inside the sheet's stack), "Start from scratch" (switches to
    *Scratch*).
- **Store**: pure logic stays in `SessionCreateLogic.swift`; the I/O lives in a
  new `@MainActor final class SessionSetupStore: ObservableObject` in
  **`SessionSetupStore.swift`**, which owns `probe` state, `checked: Set<String>`,
  `rowPhase: [path: SessionSetupRowPhase]`, `rowError`, `created:
  [SessionCreated]`, and `func setUp(paths:)`, `retry(path:)`. Probe runs on
  sheet appear in new-project mode (`.task`), cancelled with the sheet.
- **Batch view**: once a batch starts, the scan section rows switch to status
  rows (dot colour via tokens: queued `tx4`, creating `accent` +
  `ProgressView`, ready `ok`, error `danger` + message + "Retry" button).
  Confirm button hidden while running. All-success → `onCreated` for the first
  created and close. Any failure → toolbar shows "Done" which lands in the
  first success (or just closes when none).
- **First run**: the list's `emptyState` (`SessionListView.swift:773-783`)
  becomes "No sessions yet" / "Pick repositories on your server, clone one from
  GitHub, or start from scratch." + a "Get started" button that opens the
  create sheet with target New project (the scan starts immediately). The
  toolbar `+` path is unchanged.

### Pure logic + tests
`RepoZeroState.mode`, `RepoRowFormat.secondary(_:homeDir:)`,
`RepoRowFormat.homeRelative(_:homeDir:)`, `RepoRowFormat.age(ms:)` (port of
`formatAge`), `SessionSetupBatch` (pure: next row to run, landing target,
`taken` accumulation).
- `testZeroStatePendingWinsOverFailed`, `testZeroStateFreshWhenNoRepos`,
  `testZeroStateListWhenRepos`.
- `testRepoSecondaryWithOrigin` (`⎇ main`), `testRepoSecondaryNoRemoteUsesTilde`
  (`⎇ main · ~/scratch · no remote`), `testRepoSecondaryDetached`
  (`no branch · …`).
- `testAgeNowMinutesHoursDays` (59 999 ms → "now", 60 000 → "1m",
  3 600 000 → "1h", 86 400 000 → "1d").
- `testBatchNamesAreUniqueAcrossTheBatch` (two repos both named `api` →
  `api`, `api-2`, plus existing `api` → `api-2`, `api-3`).
- `testBatchLandsOnFirstSuccess`, `testBatchPartialFailureDoesNotLand`.

### Acceptance
- [ ] New project opens with a scan; found repos can be checked and set up in
      one go with per-row progress; a failed row shows its reason and retries.
- [ ] A box with no repos offers Clone from GitHub, Browse, Start from scratch.
- [ ] A failed scan degrades to Browse / Start from scratch with the desktop
      wording.
- [ ] An empty session list offers "Get started" into the same flow.

---

## 6. Clone from GitHub (device sign-in, repo picker, progress)

### Desktop today
- **Connect** (`ConnectGithub.tsx`): on open, `forgeDeviceStart()`:
  `connected:true` → straight to picker; `notConfigured:true` → "GitHub
  sign-in isn't configured on this server yet." + Back; else show the code:
  title "Connect GitHub · Waiting for sign-in", `m:ss remaining` countdown,
  two steps (open `verificationUri` / enter `userCode`), the code auto-copied
  ("copied" note), Cancel (calls `forgeDeviceCancel`). Poll loop invariants
  (`:16-27, 152-233`): **no immediate first poll**; one self-rescheduling timer;
  interval = `max(pollInterval, 5)` re-read from every `pending` reply;
  `done` → connected; `expired` → "The sign-in code expired before it was
  entered." + Try again / **Skip for now**; 3 consecutive errors (error replies
  or transport failures) → "Couldn't sign in: <message>" + Try again / Cancel.
  `device_code` never reaches the client.
- **Picker** (`CloneFromGitHub.tsx:105-136, 277-401`): `forgeRepos()` once
  connected; `error:"rejected"|"not_connected"` → back to Connect; other error →
  `repoListErrorMessage` callout. Title "Clone a repository", owner filter
  ("All owners" / `@owner`), search ("Search N repositories…"), rows with
  checkbox, name, description or "—", pushed age; **nothing pre-checked**.
  "Clone into <root> change" (editable root, default = the proposed workspace
  root); "Clone N selected" (disabled at 0 or empty root); Back.
  "No repositories match."; "Loading repositories…".
- **Clone** (`:153-243, 404-424`): sequential per repo, dest
  `<root>/<repo.name>`: `forgeCloneStart({url: cloneUrl, dest, name})` → `{id}`
  or `{message}` (destination preflight, shown verbatim) / nothing → "Couldn't
  start the clone."; poll `forgeCloneStatus({id})` every 500 ms with a 130 s cap
  ("The clone timed out."); `null` → "The clone job went away."; `done && ok` →
  next; `done && !ok` → failed with `cloneErrorKind(error)`. UI: "Cloning
  <name> · N% · <bytes>", determinate bar, "into <dest>", Cancel (calls
  `forgeCloneCancel`). All done → hand the paths to the §5 batch.
- **Failed** (`:426-478`): "Clone failed" + kind message (permission: "permission
  denied. The token may not have access to this repository.", disk: "not enough
  disk space in the clone location.", network: "a network error prevented the
  clone.", destination: server text) + "Try again" (re-queues the failed repo
  last), "Pick another repo", "Copy diagnostics" (copies the raw message).

### Wire contract (existing)
| Channel | Args | Reply | Server |
|---|---|---|---|
| `forge:device-start` | `[]` | `{connected:true, grant:null}` \| `{connected:false, grant:{grantId, userCode, verificationUri, expiresIn, pollInterval}, error:null}` \| `{connected:false, notConfigured:true, grant:null}` | `rpc.mjs:1068` |
| `forge:device-poll` | `[{grantId}]` | `{status:"pending", pollInterval}` \| `{status:"done"}` \| `{status:"expired"}` \| `{status:"error", error}` | `rpc.mjs:1069` |
| `forge:device-cancel` | `[{grantId}]` | `{ok}` | `rpc.mjs:1070` |
| `forge:repos` | `[]` | `{repos:[{name, fullName, owner, description?, pushedAt?, defaultBranch, cloneUrl, url}], stale, error?}` | `rpc.mjs:1071` |
| `forge:clone-start` | `[{url, dest, name}]` | `{id?, error?, message?}` | `rpc.mjs:1072-1073` |
| `forge:clone-status` | `[{id}]` | `{id, name, url, dest, percent, bytes, done, ok, error?, cancelled}` \| `null` | `rpc.mjs:1074` |
| `forge:clone-cancel` | `[{id}]` | `{cancelled}` | `rpc.mjs:1075` |

Electron-local bits → iOS-native: clipboard write → `UIPasteboard.general.string`;
open the verification URL → `openURL`.

### iOS design

**GitHub device sign-in — the single iOS implementation (D5, D14).** WS04 owns
it in wave A and adopts the complete WS05 §4 C.2/C.3 behaviour under the D14
names; WS05 consumes it unchanged.

- **Files:** `CloneFromGitHubSignIn.swift` (view + store),
  `CloneFromGitHubSignInLogic.swift` (pure state machine, Foundation-only, in
  `Package.swift`), wire types in `SessionForgeModels.swift`, client members in
  `MantaAPIClient+Sessions.swift` (§13 "Client members").
- **Public API (exactly D14):**
  ```swift
  @MainActor final class GitHubDeviceSignInStore: ObservableObject {
      @Published private(set) var flow: GitHubDeviceFlow
      init(api: GitHubDeviceSignInAPI = ServerGitHubDeviceSignIn(), now: @escaping () -> Date = Date.init)
      func start()                 // forge:device-start; restart = start() again
      func cancel()                // forge:device-cancel (result ignored), stops polling
      func sceneBecameActive()     // foreground resume, see "Polling"
      func copyCode() / copyLink() // UIPasteboard + transient "Copied" note
  }
  struct GitHubDeviceSignInView: View {
      init(onConnected: @escaping () -> Void, onCancel: @escaping () -> Void)
  }
  protocol GitHubDeviceSignInAPI: Sendable {   // seam for tests; live adapter wraps the client
      func start() async throws -> GitHubDeviceStart
      func poll(grantId: String) async throws -> GitHubDevicePoll
      func cancel(grantId: String) async
  }
  ```
- **Pure state machine** (`CloneFromGitHubSignInLogic.swift`), the WS05 C.3
  contract renamed under WS04 ownership:
  ```swift
  struct GitHubDeviceFlow: Equatable, Sendable {
    enum Stage: Equatable, Sendable { case starting, code, notConfigured, expired, error(String), connected }
    var stage: Stage; var grant: GitHubDeviceGrant?; var interval: Int
    var consecutiveErrors: Int; var deadline: Date?; var lastPoll: Date?
    static let maxConsecutiveErrors = 3, minInterval = 5
    mutating func started(_ r: GitHubDeviceStart, now: Date)   // deadline = now + expiresIn; interval = max(pollInterval, 5)
    mutating func startFailed()                                 // .error("Couldn't reach the server. Try again.")
    mutating func polled(_ r: GitHubDevicePoll, now: Date)      // pending: re-read interval, reset errors; done/expired; error counts
    mutating func pollThrew(now: Date)                          // counts; 3rd → .error("Couldn't reach the server. Try again.")
    mutating func tick(now: Date)                               // deadline passed while .code → .expired (no poll)
    static func shouldPollNow(lastPoll: Date?, now: Date, interval: Int) -> Bool
    static func countdownLabel(remaining: TimeInterval) -> String   // "m:ss", floors at "0:00"
    static func displayURL(_ uri: String) -> String                  // strips http(s)://
  }
  ```
  Error message for 3 server `error` replies = the server's `error`, or
  "GitHub sign-in failed." when empty (`ConnectGithub.tsx:212-219`).
- **Stages / copy** (desktop wording): `.starting` → `ProgressView` "Preparing
  sign-in…"; `.code` → title "Connect GitHub", subtitle "Waiting for sign-in ·
  m:ss remaining" (`TimelineView(.periodic(from:by: 1))` feeding `tick`), step 1
  "Open this link" → **Open github.com/login/device** (`openURL`) + **Copy
  link**, step 2 "Enter the code" → large monospaced code + **Copy code**, note
  "Code copied to clipboard" after the automatic copy on entering `.code` and
  after each manual copy ("Link copied" for the link); **Cancel**.
  `.notConfigured` → "GitHub sign-in isn't configured on this server yet." +
  **Back**. `.expired` → "The sign-in code expired before it was entered." +
  **Try again** / **Skip for now**. `.error(m)` → "Couldn't sign in: m" + **Try
  again** / **Cancel**. `.connected` → `onConnected()`.
- **Polling (one owner):** a single `Task` held by the store; it sleeps the full
  interval before the first poll (never polls immediately), and after every
  `await` checks `Task.isCancelled` and that the grant id is still current
  before mutating state (a late reply from a cancelled/restarted grant is
  dropped). `start()`/`cancel()`/view `onDisappear` cancel the task.
  `sceneBecameActive()` (view observes `scenePhase == .active`; the user is
  usually returning from Safari) first calls `tick(now:)`, then, if still
  `.code`, polls at once **only if** `shouldPollNow(lastPoll:now:interval:)`,
  otherwise reschedules for the remainder — never faster than the interval.
  When the deadline passes the loop stops and shows `.expired` without a
  network call.

**Clone from GitHub.**
- **New `CloneFromGitHubView.swift`** — pushed inside the create sheet's
  `NavigationStack`, `CloneFromGitHubView(defaultRoot: String, onCloned:
  ([String]) -> Void)`, with `@MainActor final class CloneFromGitHubStore`.
  Phases `connect → pick → clone(index) → failed`:
  - connect: `GitHubDeviceSignInView(onConnected: { store.connected() },
    onCancel: { dismiss() })`. `forge:repos` answering
    `error: "rejected" | "not_connected"` returns to connect
    (`CloneFromGitHub.tsx:117-123`).
  - pick: `.searchable` (prompt "Search N repositories"), owner `Menu` in the
    toolbar ("All owners" / `@owner`), rows with checkmark circle, name,
    description or "—", age; footer row "Clone into" `root` (tap → editable
    `TextField`, monospaced); bottom toolbar button "Clone N selected"
    (disabled at 0 or empty root); "Loading repositories…" / "No repositories
    match." / `RepoListError.message`.
  - clone: `ProgressView(value: percent/100)`, "Cloning <name> · N% ·
    <bytes>", "into <dest>", Cancel → `forge:clone-cancel` + back to pick.
    Poll every 0.5 s, 130 s cap, cancellation checked after every await.
  - failed: kind message, "Try again", "Pick another repo", "Copy diagnostics"
    (`UIPasteboard`, then "Copied").
  - On all cloned: pop to the create sheet root and start the §5 batch with
    those paths (added to the scan list as checked rows).
- Bytes: `ByteCountFormatter` (`.file`), pinned by a test.

### Pure logic + tests
`CloneFromGitHubSignInLogic.swift` → `MantaUITests/GitHubDeviceSignInTests.swift`
(Linux-eligible; injected clock):
`testStartAlreadyConnectedIsConnected`, `testStartNotConfigured`,
`testStartGrantSetsCodeIntervalAndDeadline` (interval = max(pollInterval,5),
deadline = now + expiresIn), `testPendingReReadsIntervalAndResetsErrors`,
`testSlowDownLengthensInterval`, `testPendingIntervalNeverBelowFive`,
`testThreeConsecutiveErrorsStopWithServerMessage`,
`testThreeErrorsWithEmptyMessageUseDefault`,
`testTransportThrowsCountTowardBudget`, `testDoneConnects`, `testExpiredReply`,
`testTickPastDeadlineExpires`, `testTickBeforeDeadlineKeepsCode`,
`testShouldPollNowAfterIntervalElapsed`, `testShouldPollNowFalseBeforeInterval`,
`testShouldPollNowWithNoPreviousPoll`, `testCountdownLabel` (`4:05`, `0:00`
floor), `testDisplayURL`, `testDeviceStartDecodesAllThreeShapes`,
`testDevicePollDecodesAllFourShapes`.
Store (Mac, `GitHubDeviceSignInStoreTests.swift`, fake API + fake clock):
`testNoPollBeforeFirstInterval`, `testResumeBeforeIntervalDoesNotPoll`,
`testResumeAfterIntervalPollsOnce`, `testResumeAfterDeadlineExpiresWithoutPoll`,
`testLateReplyAfterCancelIsDropped`, `testRestartDiscardsOldGrantReplies`.

`CloneFromGitHubLogic.swift` → `MantaUITests/CloneFromGitHubTests.swift`
(Linux-eligible):
- `CloneErrorKind.classify(_ stderr:)` — port of `cloneErrorKind`
  (`chatUtils.ts:4248-4270`, destination checked first). Tests: destination
  beats permission; `"Repository not found"` → permission; `"No space left on
  device"` → disk; `"Could not resolve host"` → network; garbage → unknown.
- `CloneFailureCopy.message(kind:raw:)` — the five strings above.
- `RepoListError.message(code:)` — port of `repoListErrorMessage`
  (`chatUtils.ts:4275-4289`), one test per code + nil.
- `ClonePicker.filter(repos:owner:query:)`, `owners(repos)`, `dest(root:name:)`
  — owner + query AND, case-insensitive; trailing slashes stripped.
- `CloneProgressCopy.bytes(_:)` (ByteCountFormatter `.file`).
- Decoders: `testCloneStatusNullDecodesAsNil`, `testRepoListDecodesError`.

### Acceptance
- [ ] On a box without GitHub credentials: Clone from GitHub shows the code
      (already on the clipboard), Open / Copy link, a live countdown; signing in
      in Safari and switching back moves on to the repo list within one poll
      interval, without a tap.
- [ ] No poll fires before the first interval or faster than the interval after
      returning to the app; an expired countdown shows the expired state with no
      extra request.
- [ ] Expired / not configured / repeated errors each show their own message
      and a way out ("Skip for now" / "Back" / "Cancel").
- [ ] Picking repos and "Clone N selected" shows real progress per repo, then
      sets them up as workspaces exactly like found repos.
- [ ] A failed clone names the cause and offers Try again / Pick another repo /
      Copy diagnostics; Cancel during a clone stops it on the box.

---
## 7. Close a whole project (with counts)

### Desktop today
- Project header "Close" → confirm (`Sidebar.tsx:1026-1073`) with copy from
  `describeProjectClose` (`chatUtils.ts:5149-5175`): title `Close “<name>” and
  its N session(s)?` (or `Close “<name>”?` at 0); body "All N tmux window(s)
  will be killed on the server." + "K session(s) are/is mid-turn and will be
  stopped." + "W worktree(s) will be removed." (W only when
  `worktreeCleanOnClose`); button "Close project".
- `killProject` (`Sidebar.tsx:296-343`): if `worktreeCleanOnClose`, for every
  window with `worktreePath` call `gitRemoveWorktree({path, force:false})`;
  dirty ones are **kept** (no prompt) and listed; other errors toast but never
  abort. Then `tmuxKillSession(project)`, then `projectMetaDelete(project)`
  (failure toasts, refresh still runs), then refresh. Notice: `Kept worktree at
  <path> — it has uncommitted changes.` / `Kept N worktrees with uncommitted
  changes.`

### Wire contract (existing)
| Channel | Args | Reply | Server |
|---|---|---|---|
| `tmux:kill-session` | `[sessionName]` | `Project[]` | `rpc.mjs:1289-1293` |
| `project:meta:delete` | `[tmuxSession]` | config | `rpc.mjs:911-912` |
| `git:remove-worktree` | `[{path, force}]` | `{removed, reason?: "dirty"\|"other"}`; other failures throw | `rpc.mjs:928` |
| `config:get` | `[]` | read `worktreeCleanOnClose: Bool` (default false) | existing |

### iOS design
- Group header (`SessionListView.swift:409-434`) gains a trailing
  `Menu { … } label: { Image(systemName: "ellipsis") }` (accessibility label
  "Project actions"): **New session here** (opens the create sheet preselected
  — the per-project create row the desktop rail has), **Rename project…**
  (§1), divider, **Close project…** (destructive). Only in the grouped ordering
  (the flat ordering has no headers).
- Close project → `confirmActionSheet(isPresented:, title: copy.title,
  message: copy.body, destructiveTitle: "Close project")`
  (`NativeActionSheet.swift:110-128`), copy from
  `SessionCloseCopy.project(name:, sessionCount:, runningCount:,
  worktreeCount:)`. **Counts come from the COMPLETE project
  (`store.projects`, not `visibleProjects`)** — hidden background-job windows
  are killed and their worktrees removed too, so they are counted (desktop
  parity: `Sidebar.tsx:1050-1061` counts `proj.windows`, `:305-325` walks every
  window's `worktreePath`). Pure helper `SessionCloseCounts.project(_ project:
  MantaProject, isRunning: (MantaWindow) -> Bool, cleanOnClose: Bool)` gives
  `sessionCount = windows.count`, `runningCount` over all windows (row status,
  job windows included), `worktreeCount` = windows with `worktreePath` when
  `cleanOnClose`. The header chips keep using visible windows.
- `cleanOnClose` is read with a fresh `config:get` at the moment the confirm
  opens and again when the close runs (WS10 contract: never a cached copy).
  A failed read counts as **off** — nothing is removed when we can't confirm the
  setting.
- Store: `closeProject(_ name:) async -> SessionCloseReport`
  (`{keptWorktrees:[String], errors:[String]}`) implementing the desktop order
  above over every window. The view shows `SessionCloseCopy.kept(…)` and/or the
  first error via the existing feedback toast (`SessionListView.swift:635-661`)
  and fires the `.success` haptic only after the kill succeeded.

### Pure logic + tests
`SessionCloseCopy.project(...)`, `SessionCloseCopy.session(name:running:
worktreePath:)`, `SessionCloseCopy.kept(_ paths:) -> String?` — ports of
`chatUtils.ts:5131-5175` and `Sidebar.tsx:337-342`; `SessionCloseCounts`.
All in `SessionCloseLogic.swift` (Linux-eligible; uses `MantaProject` from
`SessionModels.swift`, which joins `Package.swift`, §13).
- `testProjectCloseZeroSessions`, `testProjectCloseSingular`
  (`Close “a” and its 1 session?`, `All 1 tmux window will be killed…`),
  `testProjectClosePluralWithRunningAndWorktrees`
  (`2 sessions are mid-turn…`, `3 worktrees will be removed.`),
  `testProjectCloseOneRunningUsesIs`.
- **`testCountsIncludeHiddenJobWindow`**: one visible parent + one hidden
  `owner:"job"` window that is running and has a worktree → `sessionCount 2`,
  `runningCount 1`, `worktreeCount 1`; with `cleanOnClose:false` →
  `worktreeCount 0`.
- `testKeptNoticeSingleNamesPath`, `testKeptNoticePluralCounts`,
  `testKeptNoticeEmptyIsNil`.
- Store (Mac, `SessionStoreTests.swift`, mutation seam extended with
  `tmuxKillSession`, `projectMetaDelete`, `gitRemoveWorktree`, `configGet`):
  `testCloseProjectKeepsDirtyWorktreesAndStillKills`,
  `testCloseProjectRemovesHiddenJobWorktree`,
  `testCloseProjectMetaDeleteFailureStillRefreshes`,
  `testCloseProjectSkipsWorktreesWhenSettingOff`,
  `testCloseProjectConfigReadFailureRemovesNothing`.

### Acceptance
- [ ] Project menu → Close project names how many sessions (including
      background-job windows), how many are running and how many worktrees go;
      confirming removes the whole group.
- [ ] With "remove worktree on close" on, clean worktrees are removed and dirty
      ones are kept and reported.

---

## 8. Uncommitted-worktree prompt on close

### Desktop today (`Sidebar.tsx:240-294, 1077-1120`)
Closing one session whose window has a `worktreePath`, with
`worktreeCleanOnClose` on: `gitRemoveWorktree({path, force:false})`; on
`{removed:false, reason:"dirty"}` show a modal **"Uncommitted changes in this
worktree"** / "`<path>` has uncommitted changes. Removing the worktree will
permanently delete that work." with **Cancel** (nothing happens), **Keep
worktree** (notice "Kept worktree at <path>", then kill the window), **Remove
worktree** (danger: `force:true`, then kill). A clean worktree is removed
silently, then the window is killed. A non-dirty failure toasts and the close
continues. The close confirm adds "Its worktree at <path> will be removed."
(`describeSessionClose`).

### iOS design
- **Serialized close queue.** Today `commitExpiredDeletes`
  (`SessionListStore.swift:584-589`) loops over every expired delete and
  `commitPendingDelete` (`:595-617`) fires an independent `Task` each. Replace
  with a FIFO `closeQueue: [SessionCloseRequest]` (`{project, index, key
  "<project>#<index>", decision: .none | .keep | .remove}`) processed by ONE
  worker task at a time: `commitExpiredDeletes()` and the running-confirm
  action (`SessionListView.swift:552-564`, today `try?`-swallowed) only
  enqueue. For each request the worker:
  1. reads `worktreeCleanOnClose` fresh (`config:get`; failure = off);
  2. runs `SessionCloseDecision.next(...)` (pure);
  3. dirty without a decision → appends a `SessionWorktreePrompt` (keyed by the
     request key; duplicates for the same key are not added) to
     `@Published private(set) var worktreePrompts: [SessionWorktreePrompt]`,
     and **moves on** to the next request — it does not block the queue;
  4. otherwise kills (`opencode:delete-session` for chat windows,
     `tmux:kill-window` otherwise — unchanged) and publishes a
     `SessionCloseFeedback` (`{id: UUID, kind: .closed | .closedWithNotice(String)
     | .failed(String)}`) on `@Published private(set) var closeFeedback:
     [SessionCloseFeedback]`.
  The row of a request that is waiting on a prompt reappears (the pending
  delete is removed) until the user decides.
- **Prompts never overwrite each other.** The view presents
  `worktreePrompts.first` in **new `SessionWorktreePromptSheet.swift`**
  (compact bottom sheet shaped like `ConfirmActionSheet`: title/body, then
  "Remove worktree" (red), "Keep worktree", separated "Cancel"). Answering calls
  `store.resolveWorktreePrompt(key:, decision: .keep | .remove | .cancel)`,
  which removes that prompt (the next one presents) and, for keep/remove,
  enqueues the request again with the decision. Cancel → no RPC, the row stays.
- **Feedback follows real outcomes.** The undo toast's `.task(id:)`
  (`SessionListView.swift:612-620`) no longer fires the `.success` haptic from
  `commitExpiredDeletes()`'s return value; the view consumes `closeFeedback`
  (`.onChange`, then `store.consumeFeedback(id:)`) and fires `.success` per
  `.closed`, success + toast "Kept worktree at <path>" for
  `.closedWithNotice`, `.warning` + toast `"Couldn't delete — <message>"` for
  `.failed`. A needs-decision outcome fires nothing until resolved.
  `commitExpiredDeletes()` keeps its `@discardableResult Bool` (true = something
  was enqueued) for existing callers/tests.
- Running-confirm sheet message gains "Its worktree at <path> will be removed."
  when `cleanOnClose` (fresh read when the sheet opens) and the window has a
  worktree.

### Tests
Pure decision (`SessionCloseLogic.swift`, Linux-eligible)
`SessionCloseDecision.next(cleanOnClose:, worktreePath:, removal:
SessionWorktreeRemoval?, decision:)`: `testNoWorktreeGoesStraightToKill`,
`testSettingOffIgnoresWorktree`, `testCleanRemovalKills`,
`testDirtyWithoutDecisionAsks`, `testKeepKillsWithNotice`,
`testRemoveForcesThenKills`, `testOtherRemovalErrorStillKillsAndReports`.
Pure queue model `SessionWorktreePromptQueue` (append dedupes by key, resolve
removes by key): `testTwoPromptsQueuedInOrder`, `testSameKeyNotDuplicated`,
`testResolveRemovesOnlyThatKey`.
Store (Mac, `SessionStoreTests.swift`, fake seam):
`testTwoExpiredDirtyDeletesProduceTwoPromptsInOrder`,
`testMixedOutcomesDirtyFailedSuccess` (one dirty → prompt, one kill throws →
`.failed`, one clean → `.closed`; exactly one success feedback),
`testCloseRequestsRunOneAtATime` (seam records no overlapping calls),
`testCancelPromptRestoresRowWithoutRPC`, `testKeepEnqueuesKillWithNotice`,
`testNoSuccessFeedbackWhenKillFails`.

### Acceptance
- [ ] Deleting a session whose worktree has uncommitted work (setting on) asks
      Cancel / Keep worktree / Remove worktree and each does exactly that.
- [ ] Deleting two such sessions quickly asks twice, one after the other; no
      decision is lost.
- [ ] A clean worktree is removed with no prompt.
- [ ] The success haptic only fires for a session that was actually closed; a
      failed delete says so.

---
## 9. "N subagents" and "stopped by a provider limit" in rows

### Desktop today
- Rail rows read running while the session's own turn, any subagent child, or a
  running background job beneath it is working (`Sidebar.tsx:635-650`,
  `sessionsWithActiveWork` `chatUtils.ts:2150-2190`); the subagent count is in
  the dot tooltip `Running · <label> · N subagents` (`Sidebar.tsx:1159-1173`).
  **Mobile deliberately diverges** (`DECISIONS.md` §7.1a): the subtitle reads
  **`N subagents` and nothing else**.
- Stopped conversations: the box's durable record (`usage-stopped:list`,
  refetched on the `usage-stopped.updated` bus event); a stopped row shows a
  hollow warn ring dot titled "Stopped by a provider limit"
  (`Sidebar.tsx:1305-1314`, `SessionRow.tsx:100-103`); a pending
  question/permission outranks it (`shouldShowStoppedMarker`,
  `usageResume.ts:139-144`). The header pill (count of unarmed records,
  `Sidebar.tsx:700-712`) opens the resume modal — WS09's.

### Wire contract (existing)
| Source | Shape | Server |
|---|---|---|
| `/events` stream frame `sub:"subagent"` under the PARENT session | `StreamSubagentPayload` (already decoded) `status`: `running`/`pending`/`completed`/`error` | `streamInterp.mjs:455-476` |
| `/events` bus `kind:"status"` | `[{session, windowIndex, running, subagents}]` (already consumed) | `status.mjs` |
| `usage-stopped:list` | `[]` → `{records:[{workspace, conversation, provider, model?, window?, stoppedAt, cachedTokens?, armed?, attempts?}], lastLooked}`; unknown channel on an older box | `rpc.mjs:2394` → `stoppedStore.mjs:287-290` |
| `/events` bus `kind:"usage-stopped.updated"` | `{conversation?}` / `{removed}` | `stoppedStore.mjs:152-239` |

### iOS design
- `SessionRowStatus` (`SessionModels.swift:351-368`) gains
  `runningSubagents: Int = 0` and `halted: Bool = false`.
- `SessionListStore.rowStatus` (`:380-407`): chat →
  `SessionSubagentCount.running(stream?.subagents ?? [], parentRunning:
  stream?.running == true)`; terminal → `polled.subagents`. `running` becomes
  `running || runningSubagents > 0`. `halted = stoppedConversations.contains(sid)`.
- **Stale-guard (important):** a subagent record can stay `running` if its
  finish frame was missed during a reconnect. Foreground subagents block their
  parent's turn, and background ones are counted by the job list, so the count
  is **0 whenever the parent is not running**.
- Store fetches `usage-stopped:list` in `fetchOnce` (decoration, `try?`, failure
  keeps the previous set) and on a raw frame with `kind ==
  "usage-stopped.updated"` (same pattern as `trackDelegate`,
  `SessionListStore.swift:457-460`). Publishes `stoppedRecords:
  [SessionStoppedRecord]`, `stoppedLastLooked`, `stoppedConversations:
  Set<String>`, `unarmedStoppedCount` (records with `armed != true`, port of
  `usageResume.ts:24-26`), `isStopped(sessionID:)` and `refreshStopped()`.
  This is the ONLY stopped-state source on iOS (D16); WS09's resume screen
  reads it.
- Subtitle precedence (`SessionRowSubtitle.text`, `SessionModels.swift:391-411`):
  1. background jobs (unchanged) → 2. **`N subagent(s)`** → 3. running
  (progress / `running · model` / `running`) → 4. `needs you` →
  5. **`stopped by a provider limit`** → 6. `terminal` → 7. model.
- `SessionDotState` (`:474-484`) gains `.halted` (only when not attention and
  not running); `SessionStatusDot` draws it as a hollow `tokens.warn` ring
  (`Circle().strokeBorder`), subtitle colour `tokens.warn`.
- Recent filter: a halted idle row follows the normal recency rule (no change).

### Tests (`SessionModelsTests.swift` + `SessionsTests.swift`)
- `testSubtitleSubagentsReplaceEverythingButJobs` (`3 subagents`),
  `testSubtitleOneSubagentSingular`, `testSubtitleJobsBeatSubagents`.
- `testSubagentCountIgnoresCompletedAndError`,
  `testSubagentCountZeroWhenParentNotRunning`,
  `testSubagentCountCountsPending`.
- `testHaltedSubtitleWhenIdle`, `testAttentionOutranksHalted` (dot + subtitle),
  `testRunningOutranksHalted`, `testDotHalted`.
- `testStoppedListDecodesAndIgnoresUnknownFields`, `testUnarmedCountIgnoresArmed`.
- `SessionSubagentCount.running(_:parentRunning:)` lives in `SessionModels.swift`
  (uses `StreamSubagentPayload`, already in the package).
- Store (Mac): `testStoppedRefetchOnUsageStoppedFrame`,
  `testStoppedFetchFailureKeepsPreviousSet`.

### Acceptance
- [ ] A session running two subagents reads "2 subagents" and a running dot.
- [ ] A session stopped by a usage limit shows a hollow amber dot and "stopped
      by a provider limit"; a pending question on it still reads "needs you".
- [ ] An older box without the channel shows rows normally.

---

## 10. Quick session switcher

### Desktop today
⌘K palette (`Sidebar.tsx:600-628, 1597-1646`): placeholder "Search sessions…";
empty query → every session, most recently activated first (store
`recentWindows`, pin ids `"<project>/<index>"`, max 64, `store.ts:956`), never
activated ones after in rail order; typed query → `fuzzySessionScore(query,
windowName, workspaceName)` (`chatUtils.ts:2038-2065`: contiguous substring of
`"<window> <workspace>"` scores `1000 - index`; else ordered subsequence
`100 + 10 per adjacent hit`; else 0 = excluded), descending. Each row: session
name + workspace. "No sessions match". First row is "Inbox" (WS05).

### iOS design
- **New `SessionSwitcherLogic.swift`** (pure): `SessionSwitcher.score(query:,
  session:, workspace:)` (exact port), `results(candidates:, query:, recents:)`
  (candidates = visible windows, job windows excluded), `SessionRecents.push(_
  key:, into:) -> [String]` (front, dedupe, cap 64).
- **Store**: `SessionListStore` keeps `recents: [String]` (keys
  `"<project>#<index>"`, the `SessionRowEntry.id` / `terminalKey` composite),
  persisted in `UserDefaults` key `sessionRecents`; `noteOpened(project:index:)`
  is called whenever a session target is pushed (row tap, push link, navigator,
  create).
- **New `SessionSwitcherSheet.swift`**: `NavigationStack` + `List` +
  `.searchable(text:, placement: .navigationBarDrawer(displayMode: .always),
  prompt: "Search sessions")`, focused on appear. Rows reuse the list's dot +
  name + `SessionRowSubtitle.text(for:projectName:)`. Tap → dismiss, then
  `navigator.open(.session(windowKey:))`. Empty results → "No sessions match".
  Medium/large detents.
- **Entry points**: `MantaNavigator.presentSwitcher()` sets
  `switcherPresented`; `SessionListView` hosts the sheet on a background node of
  the `NavigationStack` (like `confirmActionSheet`, so it can present while a
  chat is pushed). Buttons: chat nav bar (M-04-6, applied by WS02) and terminal header
  (WS04, D1 terminal files), SF symbol `rectangle.stack`, label "Switch session". The
  session list itself already has search, so no button there.

### Tests (`SessionsTests.swift`)
`testScoreContiguousBeatsSubsequence`, `testScoreEarlierMatchHigher`,
`testScoreSubsequenceAdjacencyBonus`, `testScoreNoMatchIsZero`,
`testScoreMatchesWorkspaceName`, `testEmptyQueryOrdersByRecencyThenListOrder`,
`testResultsExcludeZeroScores`, `testRecentsPushDedupesAndCaps64`.

### Acceptance
- [ ] From inside any chat or terminal, "Switch session" opens a search over
      every session; typing part of a session or workspace name ranks it first;
      tapping opens it (replacing the current screen).
- [ ] Empty search lists recently opened sessions first.

---

## 11. C2 — `MantaNavigation.swift`

Wave 0 leaves a scaffold with the C2 types, D2's `NewSessionDraft` and a no-op
`open`. WS04 implements it. **Injection point (D1):** `MantaAppRoot`
(`MantaAppRoot.swift:97-110`) — the navigator is a `@StateObject` there,
injected with `.environmentObject(navigator)` on its body `Group` (covers the
sheets/covers presented below it). `RootView.swift` is not changed.

```swift
enum MantaRoute: Hashable {                    // C2, unchanged
  case session(windowKey: String)              // windowKey = "<project>#<windowIndex>"
  case message(sessionID: String, messageID: String)
  case review(sessionID: String)
  case settings(section: String?)
}
@MainActor final class MantaNavigator: ObservableObject {
  @Published var pending: MantaRoute?
  func open(_ route: MantaRoute)               // sets pending
  func startNewSession(_ draft: NewSessionDraft)   // D2: sets pendingDraft
  @Published var pendingDraft: NewSessionDraft?
  // WS04 additions (additive, same file):
  @Published var switcherPresented = false
  func presentSwitcher()
  func switchMode(windowKey: String, sessionID: String, to mode: SessionMode)
  static func windowKey(project: String, windowIndex: Int) -> String   // key builder WS02 F6 needs
}
```
Pure resolution lives in **`SessionRouteLogic.swift`** (Foundation-only, so it
runs under `verify.sh`): `SessionRouteLogic.parse(windowKey:) -> (project:
String, windowIndex: Int)?` (splits on the LAST `#`), `window(forKey:in:
[MantaProject])`, `window(forSessionID:in:)` returning a plain
`SessionRouteTarget {project, windowIndex, name, sessionId}`; `SessionListView`
maps it to `SessionOpenTarget`.

Consumer — `SessionListView` (`.onChange(of: navigator.pending)` + `.onAppear`):
- `.session(windowKey)`: dismiss any sheet (`sheetRoute = nil`) and the
  settings cover; resolve; if not found, `await store.refresh()` and resolve
  once more; still missing → feedback toast "That session is no longer open"
  and clear `pending`. Found → `path = NavigationPath()`, append the target
  (mode from §2 resolution), `store.noteOpened`, clear `pending`.
- `.message(sessionID, _)` (also WS02's M2): resolve the window by
  `opencodeSessionId`; if the stack top is not that chat, reset the path to its
  chat target (`mode: .chat`); if no window, push the bare target the push link
  uses (`SessionListView.swift:238-239`). **Leave `pending` set** — WS02's
  `ChatScreen` consumes it (scroll + highlight) and clears it.
- `.settings(section)`: dismiss sheets, open the existing settings cover
  (`SessionListView.swift:157-159`) as
  `SettingsScreen(eventStore:, initialSection: section)` (WS10's init, M-10-3
  applied by WS04); clear `pending`.
- `.review`: **not touched** — left pending for WS05's handler (wave C, applied
  by WS05 in this file).
- `MantaPushRouter` stays as is (no behaviour change).

Tests: `SessionsTests.swift` (Linux-eligible) —
`testParseWindowKeyHandlesHashInProjectName` (`"a#b#3"` → `("a#b", 3)`),
`testParseRejectsNonNumericIndex`, `testWindowKeyRoundTrip`,
`testResolveWindowByKey`, `testResolveMissingWindowIsNil`,
`testResolveByOpencodeSessionID`. Mac `MantaNavigationTests.swift`:
`testOpenSetsPending`, `testStartNewSessionSetsDraft`,
`testSwitchModeWritesModeThenOpensSession`, `testPresentSwitcher`.

Acceptance:
- [ ] `navigator.open(.session(windowKey:))` from anywhere (including a sheet)
      lands on that session; `.settings` opens Settings at the section;
      `.message` lands on the chat with the route still pending for WS02;
      `.review` is left for WS05.

---

## 12. `NewSessionDraft` consumer (D2, D11, D12)

### Contract
WS04 consumes the single declaration in D2 (`MantaNavigation.swift`, wave-0
scaffold, owned by WS04 afterwards): `NewSessionDraft {cwd, text, attachments,
worktreeBranch, linkedIssueURL}` and `NewSessionDraftAttachment {remotePath,
displayName, mime}`. WS04 declares no other draft type. Producers (D12):
WS03's `ComposerTextController.newSessionDraft(cwd:)` and WS05's inbox "Start a
session" call `navigator.startNewSession(draft)`. "Quote in new session"
(WS01) keeps forking and does NOT use this path.

### Desktop today
The new-session composer is a persisted draft (`store.ts:220-245`) holding
cwd, text, attachments, worktree choice + branch, model, plan; submit creates
the session and queues the first prompt (`NewSessionScreen.tsx:655-760`).

### iOS design
- `SessionListView` observes `navigator.pendingDraft` → clears it and presents
  `.create(project: <derived>, draft:)`. Creation always needs the user's
  **Create** tap (D2); nothing is created on presentation.
- Prefill (pure `SessionDraftPrefill.apply(draft:, projects:,
  worktreePerSession:) -> SessionCreatePrefill`, in `SessionCreateLogic.swift`):
  - **cwd**: equal to, or under, an existing project's `defaultCwd` or any
    window's `paneCurrentPath` → that project (longest match wins; `/a/bc` is
    not under `/a/b`), Folder = `cwd`; otherwise New project → *Folder* source
    with `cwd` (Name pre-filled from the folder, §4); `nil` → today's default
    target.
  - **worktreeBranch**: non-nil → "Create in a fresh git worktree" is pre-ticked
    with that branch name, **taking precedence over the box's
    `worktreePerSession` default** (both for an existing project and a new
    project-from-folder). The section still only renders once the folder probes
    as a git repo; if it is not a repo the sheet shows the footer "This folder
    isn't a git repository — the worktree can't be created." and the toggle is
    off. `nil` → the normal default (§4).
  - **linkedIssueURL**: shown as the sheet's first row ("For <url>",
    `link` symbol, tappable → `openURL`), informational only — nothing is sent
    to the box for it (D12 drops `forgeIssue`).
  - **text + attachments**: a "Carried over" section shows the text (3-line
    preview) and "N attachment(s)", with "Don't carry over" which drops both.
    For a non-chat "Open as" the section footer reads "Terminal sessions don't
    take a first message" and the seed is dropped on Create.
- On create the pushed `SessionOpenTarget` carries `seed: draft.text` and a new
  non-identity field `carryOver: HandoffCarryOver?` built by
  `SessionDraftCarry.carryOver(draft) -> HandoffCarryOver` (each
  `NewSessionDraftAttachment` → `ComposerAttachment(filename: displayName, mime:
  mime ?? "application/octet-stream", remotePath: remotePath, isImage: mime has
  prefix "image/")`, `skippedUploads: 0`) — D11: HandoffStore carry-over is
  WS04's internal transport. The destination passes it to `ChatScreen`'s new
  `initialCarryOver:` parameter (M-04-7), which seeds the existing
  `ChatScreenContent(carryOver:)` path (`ChatScreen.swift:297-309`): text + chips
  in the composer, **never auto-sent**.

### Tests (`SessionsTests.swift`, Linux-eligible except the last)
`testPrefillMatchesProjectDefaultCwd`, `testPrefillLongestPrefixWins`,
`testPrefillUnderPaneCurrentPath`, `testPrefillUnknownCwdIsNewProjectFolder`,
`testPrefillNilCwdKeepsDefault`, `testPrefillDoesNotMatchSiblingPrefix`,
**`testPrefillWorktreeBranchOverridesBoxDefaultOff`**,
**`testPrefillWorktreeBranchOverridesBoxDefaultOn`** (branch name kept, not
"worktree"), **`testPrefillNilBranchUsesBoxDefault`**,
**`testPrefillCarriesLinkedIssueURL`**, `testPrefillNilIssueHasNoHeader`.
Plan: **`testCreatePlanPreservesDraftBranchIntoWorktreeCreate`** (the plan's
`gitAddWorktree` name = draft branch). Mac: `testCarryOverMapsAttachments`
(mime nil → octet-stream, image detection, remotePath kept).

### Acceptance
- [ ] An inbox "Start a session" opens the create sheet pointed at the repo,
      with "new worktree" ticked and the inbox's branch name, and the issue link
      at the top; Create makes the worktree + session and opens the chat with the
      seed text unsent.
- [ ] A composer "start a session with this" opens the sheet at the right
      project; the new chat shows the text and attachment chips.

---

## 13. Files

All within WS04 ownership (`Session*`, `MantaNavigation.swift`,
`CloneFromGitHub*`, the listed existing files, and D1's terminal files).

**Edit**
- `SessionListView.swift` — group header menu, create-sheet init, mode-aware
  destinations (`SessionModePendingView`), navigator consumer, switcher sheet
  host, worktree prompt host, close feedback, empty state, rename via
  `SessionRenameSheet`, `SessionOpenTarget` fields (`mode`, `carryOver`),
  WS10's M3 (`initialSection`).
- `SessionListStore.swift` — launcher catalog, stopped records (D16 owner),
  subagent/halted row status, rename/close/project APIs, close queue + prompts +
  feedback, recents, mutation seam extension.
- `SessionModels.swift` — B2 (`TmuxCreateResult`), `SessionRowStatus` fields,
  subtitle precedence, `SessionDotState.halted`.
- `SessionCreateSheet.swift` — §3–§5, §12.
- `FolderPickerView.swift` — B1; `title:` parameter.
- `MantaAppRoot.swift` — `@StateObject navigator` + `.environmentObject`;
  WS10's M1/M2.
- `MantaNavigation.swift` — fill the wave-0 scaffold (§11).
- `TerminalScreen.swift`, `TerminalWebView.swift`, `TerminalModels.swift` (D1),
  `TerminalSocket.swift` (amendment requested, §18.1) — additive only (§2).

**Create**
- `MantaAPIClient+Sessions.swift` — see "Client members".
- `SessionForgeModels.swift` (Foundation-only) — wire types:
  `SessionDirListing`, `SessionWorktreeAdded {path, branch}`,
  `SessionWorktreeRemoval {removed, reason?}`, `SessionScratchProject {path,
  name}`, `ForgeProbeResult`, `RepoHit`, `ForgeCliStatus`,
  `GitHubDeviceGrant`, `GitHubDeviceStart`, `GitHubDevicePoll`,
  `GitHubRepoList`, `GitHubRepo`, `CloneStartResult`, `CloneJobStatus`,
  `SessionStoppedRecord`, `SessionStoppedList`, `SessionNewProjectInput`,
  `SessionNewWindowInput` (adds `worktreePath`).
- Pure (Foundation-only): `SessionCreateLogic.swift`, `SessionModeLogic.swift`,
  `SessionCloseLogic.swift`, `SessionSwitcherLogic.swift`,
  `SessionRouteLogic.swift`, `CloneFromGitHubLogic.swift`,
  `CloneFromGitHubSignInLogic.swift`.
- UI / stores: `SessionSetupStore.swift`, `SessionRepoScanSection.swift`,
  `SessionModeMenu.swift`, `SessionModePendingView.swift`,
  `SessionRenameSheet.swift`, `SessionWorktreePromptSheet.swift`,
  `SessionSwitcherSheet.swift`, `CloneFromGitHubSignIn.swift`,
  `CloneFromGitHubView.swift`.
- Tests: Linux-eligible `MantaUITests/SessionsTests.swift`,
  `CloneFromGitHubTests.swift`, `GitHubDeviceSignInTests.swift`; Mac-only
  `SessionStoreTests.swift`, `MantaNavigationTests.swift`,
  `GitHubDeviceSignInStoreTests.swift`; extend `SessionModelsTests.swift` and
  `TerminalModelsTests.swift`.

**Package manifest (D18/D19, applied by integration agent A):** add to the
`MantaUI` target `sources`: `SessionModels.swift` (Foundation-only; references
only `MantaError`, already in the package), `SessionForgeModels.swift`,
`SessionCreateLogic.swift`, `SessionModeLogic.swift`, `SessionCloseLogic.swift`,
`SessionSwitcherLogic.swift`, `SessionRouteLogic.swift`,
`CloneFromGitHubLogic.swift`, `CloneFromGitHubSignInLogic.swift`; to
`MantaUITests` `sources`: `SessionModelsTests.swift`, `SessionsTests.swift`,
`CloneFromGitHubTests.swift`, `GitHubDeviceSignInTests.swift`. Each must pass
`mobile/native/verify.sh` before hand-off; if `SessionModels.swift` turns out to
pull a non-package type, it and `SessionModelsTests.swift` stay Mac-only and the
pure files that need `MantaProject` (`SessionCloseLogic`, `SessionRouteLogic`,
`SessionCreateLogic`'s prefill) take plain value inputs instead. Workers never
touch `project.pbxproj` (D18).

No server files. No `generated/swift/*` edits.

### Client members (`MantaAPIClient+Sessions.swift`, single owner per D16)

| Member | Channel | Args sent | Returns |
|---|---|---|---|
| `func createSession(_ input: SessionNewProjectInput) async throws -> TmuxCreateResult` | `tmux:new-session` | `[{name, cwd, windowName, chatMode, createDir}]` | B2 type |
| `func createWindow(_ input: SessionNewWindowInput) async throws -> TmuxCreateResult` | `tmux:new-window` | `[{sessionName, windowName, cwd?, chatMode, worktreePath?}]` | B2 type |
| `func tmuxRenameSession(oldName: String, newName: String) async throws` | `tmux:rename-session` | `[{oldName, newName}]` | — |
| `func tmuxKillSession(_ name: String) async throws` | `tmux:kill-session` | `[name]` | — |
| `func projectMetaDelete(_ tmuxSession: String) async throws` | `project:meta:delete` | `[name]` | — |
| `func gitAddWorktree(cwd: String, name: String) async throws -> SessionWorktreeAdded` | `git:add-worktree` | `[{cwd, name}]` | `{path, branch}` |
| `func gitRemoveWorktree(path: String, force: Bool) async throws -> SessionWorktreeRemoval` | `git:remove-worktree` | `[{path, force}]` | `{removed, reason?}` |
| `func fsListDirectory(_ dir: String) async throws -> SessionDirListing` | `fs:list-dirs` | `[dir]` | `{dir, entries}` |
| `func projectCreateScratch(root: String, name: String) async throws -> SessionScratchProject` | `project:create-scratch` | `[{root, name}]` | `{path, name}` |
| `func forgeProbe() async throws -> ForgeProbeResult` | `forge:probe` | `[]` | probe |
| `func forgeDeviceStart() async throws -> GitHubDeviceStart` | `forge:device-start` | `[]` | 3 shapes |
| `func forgeDevicePoll(grantId: String) async throws -> GitHubDevicePoll` | `forge:device-poll` | `[{grantId}]` | 4 shapes |
| `func forgeDeviceCancel(grantId: String) async` | `forge:device-cancel` | `[{grantId}]` | result ignored |
| `func forgeRepos() async throws -> GitHubRepoList` | `forge:repos` | `[]` | `{repos, stale, error?}` |
| `func forgeCloneStart(url: String, dest: String, name: String) async throws -> CloneStartResult` | `forge:clone-start` | `[{url, dest, name}]` | `{id?, error?, message?}` |
| `func forgeCloneStatus(id: String) async throws -> CloneJobStatus?` | `forge:clone-status` | `[{id}]` | status or `null` |
| `func forgeCloneCancel(id: String) async throws` | `forge:clone-cancel` | `[{id}]` | — |
| `func usageStoppedList() async throws -> SessionStoppedList` | `usage-stopped:list` | `[]` | `{records, lastLooked}` |

**Consumed, not declared** (other owners): `launchersList()` +
`AvailableLauncher` + `ExtensionsLaunchers.resolve` (WS10), existing
`configGet()` / `configUpdate(_:)` / `renameWindow` / `deleteSession` /
`killWindow` / `listWorktrees` / `projects()` / `delegateList()` (base client).
**Reused by others:** WS05 calls `forgeProbe()`, `forgeDevice*`,
`gitAddWorktree(cwd:name:)` and must not redeclare them or the wire types
`ForgeProbeResult` / `RepoHit` / `GitHubDevice*`; WS09 calls
`usageStoppedList()` only through `SessionListStore` (below).

## 14. Mount requests

Per D18. Provider symbols are defined in this spec (WS04, wave A), so wave-B
appliers can write the calls.

| ID | Receiving file | Applier | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-04-1 | `ChatOverflowSheet.swift` | WS07 (wave B) | — | Add `var onRename: () -> Void` and a row "Rename session" (`pencil`) in the second section, before "Fork session" (`:110`). | WS04 merged |
| M-04-2 | `ChatOverflowSheet.swift` | WS07 (wave B) | `SessionModeRows`, `SessionMode`, `SessionLauncherCatalog`, `AvailableLauncher` (WS10) | Add params `mode: SessionMode?` (nil = window has no chat session → no Mode rows), `launchers: [AvailableLauncher]`, `launcherCatalog: SessionLauncherCatalog`, `onSelectMode: (SessionMode) -> Void`, `onRetryLaunchers: () -> Void`; replace the "Open terminal" row (`:111`) with `SessionModeRows(current: mode, launchers:, catalog:, onSelect: { dismiss(); onSelectMode($0) }, onRetry: onRetryLaunchers)` when `mode != nil`. | WS04 + WS10 merged |
| M-04-3 | `ChatScreen.swift` | WS02 (wave B) | `SessionListStore.window(forSessionID:)` | `.navigationTitle(sessionStore.window(forSessionID: store.sessionId)?.window.name ?? title)` (`:342`). | WS04 merged |
| M-04-4 | `ChatScreen.swift` | WS02 (wave B) | `SessionRenameSheet`, `SessionListStore.renameSession(project:index:newName:) -> String?` | Pass `onRename:` to `ChatOverflowSheet` → dismiss overflow, then present `SessionRenameSheet(title: "Rename session", initialName: <live name>, onSave: { await sessionStore.renameSession(project: projectName, index: w.index, newName: $0) })`; when the window is unresolved show `actionHint = "Can't rename — session's window not found."`. | M-04-1 |
| M-04-5 | `ChatScreen.swift` | WS02 (wave B) | `MantaNavigator.switchMode`, `MantaNavigator.windowKey`, `SessionModeStore.read`, `SessionListStore.launchers/launcherCatalog/refreshLaunchers()` | Pass to the overflow: `mode: sessionWindow == nil ? nil : SessionModeStore.read(sessionID: store.sessionId)`, `launchers: sessionStore.launchers`, `launcherCatalog: sessionStore.launcherCatalog`, `onSelectMode: { m in guard m != .chat, let w = sessionWindow else { return }; navigator.switchMode(windowKey: MantaNavigator.windowKey(project: projectName, windowIndex: w.index), sessionID: store.sessionId, to: m) }`, `onRetryLaunchers: { Task { await sessionStore.refreshLaunchers() } }`. Add `@EnvironmentObject var navigator: MantaNavigator`. | M-04-2 |
| M-04-6 | `ChatScreen.swift` | WS02 (wave B) | `MantaNavigator.presentSwitcher()` | Toolbar `ToolbarItem(placement: .topBarTrailing)` before the overflow button (`:346`): `Button { navigator.presentSwitcher() } label: { Image(systemName: "rectangle.stack") }.accessibilityLabel("Switch session")`. | WS04 merged |
| M-04-7 | `ChatScreen.swift` | WS02 (wave B) | `HandoffCarryOver` (existing), `SessionOpenTarget.carryOver` | `ChatScreen` gains `var initialCarryOver: HandoffCarryOver? = nil`; `init` sets `_carryOver = State(initialValue: initialCarryOver)` (`:135`). `SessionListView`'s destination (WS04) passes `target.carryOver`. Default nil keeps every other call site compiling. | WS03's D13 adoption merged (carryOver still seeds the adopted controller) |

## 15. Mounts applied by this workstream

| ID (requester) | Receiving file | Applier | Change | Prerequisite |
|---|---|---|---|---|
| M1 (WS10) | `MantaAppRoot.swift` | WS04 (wave A — owner running in that wave) | `@AppStorage(SettingsAppearance.storageKey)` + `.preferredColorScheme(SettingsAppearance.colorScheme(for:))` on the root `Group`. | WS10's `SettingsAppearance` (same wave; WS04 rebases onto it before its last commit) |
| M2 (WS10) | `MantaAppRoot.swift` | WS04 (wave A) | `.onReceive(… .mantaBoxRemoved)` → stop store, `sessionStore.resetForBoxChange()`, `flow.isSwitching = false`, `flow.backToEntry()`, `paired = false`. `resetForBoxChange` also clears WS04's new state (launcher catalog, stopped records, close queue/prompts, recents are device-local and kept). | WS10's `.mantaBoxRemoved`, `flow.backToEntry()` |
| M3 (WS10) | `SessionListView.swift` | WS04 (wave A) | `.settings(section)` → `SettingsScreen(eventStore:, initialSection:)` (§11). | WS10's init param |
| M2 (WS02) | `SessionListView.swift` | WS04 (wave A) | `.message` handling in the navigator consumer + `MantaNavigator.windowKey` (§11) — built here, nothing for WS02 to apply. | — |
| Search entry (WS06 M2) | `SessionListView.swift` | integration agent B (D18) | `SheetRoute.conversationSearch(seed:)` + list/no-match rows, per `06-search.md`. | WS04 merged |
| Stopped pill (WS09 M2) | `SessionListView.swift` | integration agent B | Toolbar capsule when `store.unarmedStoppedCount > 0` opening WS09's resume sheet; **must read `SessionListStore` (D16), not a second store**. | WS04 merged |
| Usage overlay/sheet (WS09 M3) | `MantaAppRoot.swift` | integration agent B | Per `09-models-usage.md`, minus any stopped-store binding (D16). | WS04 merged |
| Agent-file notice (WS07) | `MantaAppRoot.swift` | integration agent B | `.overlay(alignment: .bottom) { ArtifactAgentFileNotice() }` under the upgrade overlay. | WS04 merged |
| Inbox button + `.review` handler (WS05 M2/M3) | `SessionListView.swift` | WS05 (wave C) | Inbox toolbar sheet whose "Start a session" calls `navigator.startNewSession(draft)` (D12); `.review` case in the navigator consumer. | WS04 merged |

## 16. Contracts provided / consumed

- **C1 (consumed):** internal `call`/`callRequired`/`callVoid`; members listed
  above, none duplicated (D16).
- **C2 (provided):** `MantaNavigator` implementation, `.session` /
  `.settings` handling, `.message` push-to-chat (WS02 finishes it), `.review`
  left pending for WS05; additive `presentSwitcher()`, `switchMode(...)`,
  `windowKey(project:windowIndex:)`.
- **D2/D11/D12 (consumed):** `NewSessionDraft` + `startNewSession(_:)`; prefill
  of all five fields (§12); HandoffCarryOver transport internal.
- **D5/D14 (provided to WS05):** `GitHubDeviceSignInView`,
  `GitHubDeviceSignInStore`, `GitHubDeviceFlow`, `GitHubDevice*` wire types and
  `forgeDevice*` members — WS05 creates no device flow of its own.
- **D16 (provided to WS09):** `SessionListStore` is the only stopped-state
  source: `stoppedRecords: [SessionStoppedRecord]`, `stoppedLastLooked: Date?`,
  `stoppedConversations: Set<String>`, `unarmedStoppedCount: Int`,
  `isStopped(sessionID:) -> Bool`, `refreshStopped() async` (also triggered by
  `usage-stopped.updated` frames). WS09's arm/disarm/stamp/mark-ran actions call
  `refreshStopped()` after a successful write (or rely on the bus frame).
- **Provided to WS06:** `SessionListStore.window(forSessionID:)`.
- **Consumed from WS10:** `launchersList()`, `AvailableLauncher`,
  `ExtensionsLaunchers.resolve`, `SettingsScreen(initialSection:)`,
  `SettingsAppearance`, `.mantaBoxRemoved`; config keys `worktreePerSession` /
  `worktreeCleanOnClose` read fresh at the moment of action.
- C4–C7: no frames added (uses existing `subagent`, `status`,
  `usage-stopped.updated`); no schema edits; tests per C7.

## 17. Deferred

- **Random scratch-project names** — desktop's generator needs the 53 KB
  `friendlyWords.mjs` list. iOS requires a typed name instead.
- **Keeping a CLI / shell alive across a disconnect** — iOS's `/pty` WS kills
  its pty when the socket closes, so a reconnect relaunches the CLI (fresh
  process, same mode). Desktop keeps the pty mounted. Needs a server `/pty`
  reattach change; out of scope (D7 lists no such change).
- **Attaching to adopted (non-Manta) tmux windows** — `/pty` has no
  `tmuxTarget` (`ptyWs.mjs:164-179`). Pre-existing gap, unchanged.
- **Model / plan / trust choice in the create sheet** — chosen in the new
  chat's composer instead.
- **"Inbox" first row in the switcher** — WS05 may add it.
- **"use a different account"** on the repo list — dead on desktop; not ported.
- **⌘K on the switcher button** — keyboard shortcuts are out of scope (master).

## 18. Open questions

1. **`TerminalSocket.swift` ownership.** D1 gave WS04 the other three terminal
   files but not the socket, which owns the `/pty` URL and reconnects
   (`TerminalSocket.swift:122-131`). *Default:* WS04 owns it under the same
   "additive only" rule; no other workstream touches it.

## Review responses (round 1)

**`reviews/round1/04-sessions.md`**
1. BLOCKING launcher plumbing skips `TerminalSocket` → §2: socket init gains
   `launcher`, URL built by a static `makeRequest` used by every (re)connect,
   bearer unchanged; tests on the real request; ownership amendment in §18.1.
2. BLOCKING draft contract vs D2 → §12 rewritten to consume D2's five-field
   type; branch prefill overrides the box default; issue-link header; tests for
   both + preservation into the worktree create; superseded open question
   removed.
3. SHOULD close-project counts exclude hidden jobs → §7: counts from the full
   project via `SessionCloseCounts`; hidden-job test added; chips unchanged.
4. SHOULD single prompt / premature haptic → §8: serialized close queue, keyed
   FIFO prompt queue, feedback published per real outcome; tests for two dirty
   deletes and mixed outcomes.
5. SHOULD launcher failure downgrades to Chat → §2: `SessionLauncherCatalog`
   (loading/loaded/failed + lastGood), downgrade only on an authoritative list,
   `SessionModePendingView` with Checking / Try again / Open in chat; tests.
6. SHOULD device-flow contract incomplete → §6: full WS05 C.2/C.3 behaviour
   under D14 names (deadline, expiry tick, single polling owner, guarded
   foreground resume, Copy link, cancellation checks), clock-injected tests.

**`reviews/round1/00-cross-cutting.md`** (findings mentioning WS04)
1. Three draft contracts → consume D2 only (§12); no WS04 declaration.
2. Producers bypass create-and-confirm → §12: presentation creates nothing;
   one Create tap; inbox worktree is created by WS04's flow on Create; quote
   keeps forking (D12).
4. Device-flow names/implementations → D14 names, WS04 sole implementation
   (§6, §16).
6. Duplicate client members → "Client members" table; `usageStoppedList()`
   single owner; launcher discovery consumed from WS10's `launchersList()`
   instead of a second member; desktop-named forge/git members WS05 reuses.
7. Wave-B shared-file edits → §15 assigns WS06/WS07/WS09 mounts in WS04 files
   to integration agent B; WS05's to WS05 in wave C.
8. Mount receipts → §14 per-ID ledger with appliers (WS02/WS07); M-04-7 added
   for the carry-over seed.
9. Stopped-state ownership → §16: `SessionListStore` is the only source; WS09
   reads it; WS09's pill/overlay mounts must not bind a second store.
10. Package/pbxproj schedule → §13 "Package manifest" for integration agent A;
    workers never edit pbxproj.
