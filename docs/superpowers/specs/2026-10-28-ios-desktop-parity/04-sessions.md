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
  throws, so `FolderPickerView.listDirectory` (`:211-227`) always shows
  "Couldn't list folder". Fix: new `listDirectory(_:)` in
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
    `tmux:rename-session`, then `refresh()`. If the renamed project has open
    pinned ids, leave them (desktop does not migrate pins either).
  - Add `window(forSessionID:) -> (project: String, window: MantaWindow)?` —
    used by the chat title and by C2.
  - Error copy: `"Couldn't rename — <server message>"`, falling back to
    `"Couldn't rename — check the connection"` when the message is empty.
- **In chat** (mount, WS02 + WS07 — see §14): overflow sheet row
  "Rename session" (`pencil`) presents `SessionRenameSheet(title: "Rename
  session", initialName: <live window name>)`; the chat nav title reads
  `sessionStore.window(forSessionID: sid)?.window.name ?? title` so it updates
  after the refresh.
- **Project rename**: group header menu (see §7) → "Rename project…" →
  `SessionRenameSheet(title: "Rename project")`.

### Pure logic + tests (`MantaUITests/SessionsTests.swift`)
`SessionRenameLogic.validated(_ input: String, current: String) -> String?`
(trimmed, nil when empty or unchanged).
- `testRenameRejectsEmptyAndWhitespace`, `testRenameRejectsUnchanged`,
  `testRenameTrims`.
- Store: extend the existing mutation-seam tests (`SessionListMutationAPI`) —
  `testRenameFailureReturnsMessageAndDoesNotRefresh`,
  `testRenameSuccessRefreshes` (add `renameProject` to the protocol).

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
- **New `SessionModeLogic.swift`** (pure):
  ```swift
  enum SessionMode: Hashable, Sendable {
      case chat, terminal, cli(launcherID: String)
      var raw: String            // "chat" | "terminal" | "tui:<id>"  (desktop-identical)
      init(raw: String?, available: [SessionLauncher])   // unknown/uninstalled → .chat
  }
  enum SessionModeStore {        // UserDefaults, key "manta:session:<sid>:mode"
      static func read(sessionID: String, available: [SessionLauncher]) -> SessionMode
      static func write(_ mode: SessionMode, sessionID: String)
  }
  enum SessionPtyKey {
      static func key(project: String, windowIndex: Int, mode: SessionMode) -> String
      // .terminal → "<project>:<index>" (unchanged, keeps today's key)
      // .cli(id)  → "<project>:<index>:tui:<id>"
  }
  enum SessionLauncherFlags {
      static func resolve(schema: [SessionLauncherFlag], saved: [String: Bool]?) -> [String: Bool]
  }
  ```
  `SessionLauncher` / `SessionLauncherFlag` are `Decodable` in
  `SessionForgeModels.swift` (§13).
- **Store**: `SessionListStore` gains `@Published private(set) var launchers:
  [SessionLauncher]` (fetched in `fetchOnce` as decoration — `try?`, failure →
  `[]`, never blanks the list) and `launcherFlags: [String: [String: Bool]]`
  (read in `loadConfig`, `SessionListStore.swift:657-676`).
- **`SessionOpenTarget`** (`SessionListView.swift:1050-1070`) gains
  `var mode: SessionMode? = nil` and **mode participates in `==`/`hash`** (a
  different mode is a different destination; `seed` stays out of identity).
- **Routing** (`SessionListView` `navigationDestination`, `:134-145`): a target
  with a `sessionId` and `mode` ∈ {terminal, cli} → `TerminalScreen(window:,
  project:, sessionStore:, mode:)`; `mode == nil` resolves from
  `SessionModeStore.read` so reopening a session from the list honours the saved
  mode (desktop behaviour). No `sessionId` → terminal as today.
- **Switching** goes through C2: `MantaNavigator.switchMode(windowKey:,
  sessionID:, to:)` writes the mode then `open(.session(windowKey:))`, which
  replaces the top of the stack with the same session in the new mode (§10).
- **Menu UI — new `SessionModeMenu.swift`**:
  - `SessionModeRows(current:, launchers:, onSelect:)` — a `Section("Mode")`
    with "Chat" (`bubble.left`), "Terminal" (`terminal`), then
    `Section("AI CLI")` with one row per launcher (`cpu`), checkmark on the
    current one. Used by the chat overflow sheet (mount, WS07).
  - `SessionModeMenu(current:, launchers:, onSelect:)` — a SwiftUI `Menu`
    (same items, `Picker` inside so the current one is checked) for the
    terminal header.
  - Selecting the current mode just dismisses (desktop: harmless close).
  - Not rendered for a window without an opencode session (desktop hides it).
  - The AI-CLI section is omitted when `launchers` is empty (never an empty
    header).
- **Terminal screen** (ownership request, §14): `TerminalScreen` takes
  `mode: SessionMode` (default `.terminal`) and an optional `sessionID`;
  header title subtitle shows the launcher label for `.cli`; the empty trailing
  slot (`TerminalScreen.swift:103-106`) becomes `SessionModeMenu` when
  `sessionID != nil`. `TerminalContainerView`/`TerminalWebView` take a
  `launcher: SessionPtyLauncher?` (`{id, flags}`) and use
  `SessionPtyKey.key(...)`; `TerminalURLBuilder.ptyURL` gains
  `launcher: SessionPtyLauncher? = nil` and adds `launcher=<compact JSON>`.
  `ChatScreen.openTerminal` (`:1012-1023`) is unchanged (pushes plain terminal)
  but the overflow row is replaced by the Mode rows (§14).

### Pure logic + tests (`SessionsTests.swift`)
- `testModeRawRoundTrip` (`chat`, `terminal`, `tui:claude`).
- `testUnknownRawFallsBackToChat`, `testUninstalledLauncherDowngradesToChat`,
  `testInstalledLauncherKept`.
- `testPtyKeyTerminalKeepsLegacyKey`, `testPtyKeyCliIsDistinct`.
- `testLauncherFlagsSavedOverridesDefault`, `testLauncherFlagsMissingUsesDefault`,
  `testLauncherFlagsIgnoresUnknownSavedKey`.
- `TerminalModelsTests`: `testPtyURLCarriesLauncherJSON`,
  `testPtyURLOmitsLauncherWhenNil`.
- `SessionOpenTarget` identity: `testTargetsWithDifferentModesAreDifferent`.

### Acceptance
- [ ] Chat overflow shows Mode (Chat ✓ / Terminal / each installed CLI);
      choosing Terminal or a CLI replaces the chat with the terminal running
      that mode in the session's folder; the terminal header menu switches back
      to Chat.
- [ ] Reopening the session from the list opens it in its last mode on this
      device; a CLI that was uninstalled opens Chat.
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
  section: "Chat" (default), "Terminal", then each launcher label (hidden when
  none installed). The window is still created with `chatMode: true` (so it can
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
seed: NewSessionDraft?}`.

Sections, by target:

**Existing project**
1. Project picker (unchanged).
2. "Session": Name (optional, footer unchanged); **Folder** row (defaults to
   the project's `defaultCwd`, else first window's `paneCurrentPath`; tap →
   `FolderPickerView`); **Open as** (§3).
3. "Git worktree" — shown only when `git:list-worktrees(folder)` is non-empty:
   Toggle "Create in a fresh git worktree" (default
   `store.worktreePerSession`); when on, `TextField("Branch name", text:,
   prompt: "worktree")` (default `"worktree"`, autocaps/autocorrect off) and
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
  `listDirectory(root)` entries ∪ project names. Confirm label "Create
  workspace". Root default = `SessionWorkspaceRoot.proposed(repoPaths:,
  homeDir:)` from the scan (§5); if empty, "Location" reads "Choose a folder"
  and Create stays disabled.

**Confirm button**: one toolbar confirmation button whose label and enabled
state come from the pure `SessionCreatePlan.make(form)` ("Create", "Create
workspace", "Set up N workspaces"). Disabled with the form while creating;
`ProgressView` overlay as today.

**Create flows** (all in the sheet's private `create()`; every failure sets
the red error row with the server message via `SessionCreateFailure.message`):
- Existing project, no worktree: `createWindow({sessionName, windowName:
  name|"session", cwd: folder (omit when equal to project default),
  chatMode:true})`.
- Existing project + worktree: `addWorktree(cwd: folder, name: branch)` →
  `createWindow({…, cwd: wt.path, worktreePath: wt.path})`. If the second call
  fails: error `"Created worktree at <path>, but couldn't open a session in it:
  <message>"`.
- New project folder (+ optional worktree): as desktop (`createSession`
  with `cwd: wt.path ?? folder`, `createDir: true` only when no worktree).
- Fan-out (existing code, `:208-221`) unchanged except it uses `windowIndex`.
- Scratch: `createScratchProject(root:, name:)` →
  `createSession({name: unique(deriveProjectName(path)), cwd: path,
  windowName:"default", chatMode:true, createDir:false})`.
- On success: resolve the window by `windowIndex` (fallback: name, then last
  window), write the mode (§3), call `onCreated`. `SessionListView` adopts the
  projects and pushes `SessionOpenTarget(…, mode:, seed: draft?.text,
  seedAttachments: draft?.attachments)`.

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
- **New `CloneFromGitHubConnect.swift`** — `GitHubDeviceConnectView(onConnected:,
  onCancel:)` + its `@MainActor final class GitHubDeviceConnectStore`. Stages
  `starting / code / notConfigured / expired / error(message)` with the desktop
  copy above. Code stage: large monospaced code, "Copied to clipboard" note
  after the automatic `UIPasteboard` write, a "Copy code" button, an "Open
  github.com/login/device" button (`openURL`), the countdown (`m:ss
  remaining`), Cancel. Poll loop = one `Task` that sleeps the full interval
  first, re-reads `pollInterval`, enforces the 3-error budget, and is cancelled
  on disappear and on Cancel (which also calls `forge:device-cancel`). This is
  the **only** device-flow implementation on iOS — WS05 reuses it (§15).
- **New `CloneFromGitHubView.swift`** — pushed inside the create sheet's
  `NavigationStack`, `CloneFromGitHubView(defaultRoot: String, onCloned:
  ([String]) -> Void)`, with `@MainActor final class CloneFromGitHubStore`.
  Phases `connect → pick → clone(index) → failed`:
  - pick: `.searchable` (prompt "Search N repositories"), owner `Menu` in the
    toolbar ("All owners" / `@owner`), rows with checkmark circle, name,
    description or "—", age; footer row "Clone into" `root` (tap → editable
    `TextField`, monospaced); bottom toolbar button "Clone N selected".
  - clone: `ProgressView(value: percent/100)`, "Cloning <name> · N% ·
    <bytes>", "into <dest>", Cancel → `forge:clone-cancel` + pop back to pick.
  - failed: kind message, "Try again", "Pick another repo", "Copy diagnostics"
    (`UIPasteboard`, then a "Copied" confirmation).
  - On all cloned: pop to the create sheet root and start the §5 batch with
    those paths (added to the scan list as checked rows).
- Bytes formatting: port `formatBytes` (`chatUtils.ts:380`) into
  `CloneFromGitHubLogic.swift`, or use `ByteCountFormatter` with `.file` style —
  either is fine; tests pin whichever is chosen.

### Pure logic (`CloneFromGitHubLogic.swift`) + tests (`MantaUITests/CloneFromGitHubTests.swift`)
- `CloneErrorKind.classify(_ stderr:)` — port of `cloneErrorKind`
  (`chatUtils.ts:4248-4270`, destination checked first).
  Tests: destination beats permission (`"destination path 'x' already exists"`
  + `"permission denied"` → destination); `"Repository not found"` →
  permission; `"No space left on device"` → disk; `"Could not resolve host"` →
  network; garbage → unknown.
- `CloneFailureCopy.message(kind:raw:)` — the five strings above.
- `RepoListError.message(code:)` — port of `repoListErrorMessage`
  (`chatUtils.ts:4275-4289`), one test per code + nil.
- `GitHubDevicePollPolicy`: `nextInterval(current:reply:)` (min 5),
  `afterError(count:) -> stop?` (3). Tests: `pending` with 3 → 5;
  `pending` with 10 → 10; third consecutive error stops; a `pending` resets the
  budget.
- `CountdownLabel.text(remaining:)` → `"4:05"`, negative → `"0:00"`.
- `ClonePicker.filter(repos:owner:query:)`, `owners(repos)` (sorted, unique,
  non-empty). Tests for owner + query AND, case-insensitive on fullName/name.
- `ClonePicker.dest(root:name:)` strips trailing slashes.
- Decoders: `testDeviceStartDecodesAllThreeShapes`,
  `testCloneStatusNullDecodesAsNil`.

### Acceptance
- [ ] On a box without GitHub credentials: Clone from GitHub shows the code
      (already on the clipboard), a link to GitHub, a live countdown; signing in
      on another device moves on to the repo list without a tap.
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
  worktreeCount:)` where counts use **visible** windows (job windows are
  represented by their parent; same as the header chip) and running from
  `rowStatus`.
- Store: `closeProject(_ name:) async -> SessionCloseReport`
  (`{keptWorktrees:[String], errors:[String]}`) implementing the desktop order
  above. The view shows `SessionCloseCopy.kept(…)` and/or the first error via
  the existing feedback toast (`SessionListView.swift:635-661`), and fires the
  `.success` haptic on completion.

### Pure logic + tests
`SessionCloseCopy.project(...)`, `SessionCloseCopy.session(name:running:
worktreePath:)`, `SessionCloseCopy.kept(_ paths:) -> String?` — ports of
`chatUtils.ts:5131-5175` and `Sidebar.tsx:337-342`.
- `testProjectCloseZeroSessions`, `testProjectCloseSingular`
  (`Close “a” and its 1 session?`, `All 1 tmux window will be killed…`),
  `testProjectClosePluralWithRunningAndWorktrees`
  (`2 sessions are mid-turn…`, `3 worktrees will be removed.`),
  `testProjectCloseOneRunningUsesIs`.
- `testKeptNoticeSingleNamesPath`, `testKeptNoticePluralCounts`,
  `testKeptNoticeEmptyIsNil`.
- Store (mutation seam extended with `killProject`, `deleteProjectMeta`,
  `removeWorktree`): `testCloseProjectKeepsDirtyWorktreesAndStillKills`,
  `testCloseProjectMetaDeleteFailureStillRefreshes`,
  `testCloseProjectSkipsWorktreesWhenSettingOff`.

### Acceptance
- [ ] Project menu → Close project names how many sessions, how many are
      running and how many worktrees go; confirming removes the whole group.
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
- Store: replace the body of `commitPendingDelete`
  (`SessionListStore.swift:595-617`) and the running-confirm action
  (`SessionListView.swift:552-564`, which today swallows errors with `try?`)
  with one `closeWindow(project:index:decision:)` returning
  `SessionCloseOutcome`:
  `.closed(notice: String?)`, `.needsWorktreeDecision(SessionWorktreePrompt)`,
  `.failed(String)`. Kill = `opencode:delete-session` for chat windows,
  `tmux:kill-window` otherwise (unchanged). The worktree step runs first, only
  when `worktreeCleanOnClose && window.worktreePath != nil`.
- `@Published var worktreePrompt: SessionWorktreePrompt?` on the store. The idle
  undo flow is unchanged until commit; if commit hits a dirty worktree the
  pending delete is dropped (the row reappears) and the prompt shows.
- **New `SessionWorktreePromptSheet.swift`**: compact bottom sheet (same shape
  as `ConfirmActionSheet`) with the title/body above and three buttons:
  "Remove worktree" (red), "Keep worktree", separated "Cancel". Cancel → no
  RPC, row stays. Keep → close with `.keep`, toast "Kept worktree at <path>".
  Remove → `force:true` then close.
- Running-confirm sheet message gains "Its worktree at <path> will be removed."
  when applicable. Delete failures now show the toast
  `"Couldn't delete — <message>"` instead of silently refreshing.

### Tests
Pure decision `SessionCloseDecision.next(cleanOnClose:, worktreePath:,
removal: SessionWorktreeRemoval?, decision:)`:
`testNoWorktreeGoesStraightToKill`, `testSettingOffIgnoresWorktree`,
`testCleanRemovalKills`, `testDirtyWithoutDecisionAsks`,
`testKeepKillsWithNotice`, `testRemoveForcesThenKills`,
`testOtherRemovalErrorStillKillsAndReports`.
Store: `testDirtyCommitRestoresRowAndPublishesPrompt`.

### Acceptance
- [ ] Deleting a session whose worktree has uncommitted work (setting on) asks
      Cancel / Keep worktree / Remove worktree and each does exactly that.
- [ ] A clean worktree is removed with no prompt.
- [ ] A failed delete says so.

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
  [SessionStoppedRecord]` and `stoppedConversations: Set<String>`.
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
- `testStoppedListDecodesAndIgnoresUnknownFields`.

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
  chat is pushed). Buttons: chat nav bar (mount, WS02) and terminal header
  (ownership request), SF symbol `rectangle.stack`, label "Switch session". The
  session list itself already has search, so no button there.
- Hardware keyboard: give the chat-bar button `.keyboardShortcut("k",
  modifiers: .command)` — free on iPad / keyboard users, no extra UI.

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

Wave 0 leaves a scaffold with the C2 types and a no-op `open`. WS04 implements
it. **Injection point:** the master says "from RootView", but `RootView.swift`
is only the capture-harness fixture; the real paired root is `MantaAppRoot`
(`MantaAppRoot.swift:97-110`). The navigator is a `@StateObject` in
`MantaAppRoot`, injected with `.environmentObject(navigator)` on its body
`Group` (covers sheets/covers presented below it). `RootView` is not changed.

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
  // WS04 additions (additive, same file):
  @Published var switcherPresented = false
  func presentSwitcher()
  @Published var pendingDraft: NewSessionDraft?
  func startNewSession(_ draft: NewSessionDraft)
  func switchMode(windowKey: String, sessionID: String, to mode: SessionMode)
  static func windowKey(project: String, windowIndex: Int) -> String
}
enum MantaRouteResolver {                      // pure
  static func parse(windowKey: String) -> (project: String, windowIndex: Int)?   // splits on LAST "#"
  static func target(for route: MantaRoute, projects: [MantaProject],
                     savedMode: (String) -> SessionMode) -> SessionOpenTarget?
}
```

Consumer — `SessionListView` (`.onChange(of: navigator.pending)` + `.onAppear`):
- `.session(windowKey)`: dismiss any sheet (`sheetRoute = nil`) and the
  settings cover; resolve; if not found, `await store.refresh()` and resolve
  once more; still missing → feedback toast "That session is no longer open".
  Found → `path = NavigationPath()`, append the target (mode from
  `SessionModeStore.read`), `store.noteOpened`, clear `pending`.
- `.message(sessionID, _)`: resolve the window by `opencodeSessionId`; if the
  stack top is not that chat, reset the path to its chat target
  (`mode: .chat`); if no window, push the bare target the push link uses
  (`SessionListView.swift:238-239`). **Leave `pending` set** — WS02's
  `ChatScreen` consumes it (scroll + highlight) and clears it.
- `.settings(section)`: dismiss sheets, open the existing settings cover
  (`SessionListView.swift:157-159`) passing `initialSection: section` (mount,
  WS10); clear `pending`.
- `.review`: ignored here (WS05 consumes and clears it).
- `MantaPushRouter` stays as is (no behaviour change).

Tests (`MantaUITests/MantaNavigationTests.swift`):
`testParseWindowKeyHandlesHashInProjectName` (`"a#b#3"` → `("a#b", 3)`),
`testParseRejectsNonNumericIndex`, `testSessionRouteResolvesWithSavedMode`,
`testSessionRouteMissingWindowIsNil`, `testMessageRouteResolvesChatByOpencodeID`,
`testOpenSetsPending`, `testStartNewSessionSetsDraft`.

Acceptance:
- [ ] `navigator.open(.session(windowKey:))` from anywhere (including a sheet)
      lands on that session; `.settings` opens Settings; `.message` lands on the
      chat with the route still pending for WS02.

---

## 12. `NewSessionDraft` consumer (C3)

### Contract (pinned here; see Open question 2 for where it is declared)
```swift
struct NewSessionDraft: Hashable, Sendable {
  var cwd: String?                               // absolute box path; nil = let the user pick
  var text: String                               // composer seed
  var attachments: [NewSessionDraftAttachment]   // already uploaded to the box
}
struct NewSessionDraftAttachment: Hashable, Sendable {
  var remotePath: String
  var displayName: String
  var mime: String?
}
```
Producers (WS01 Quote in new session, WS05 inbox "start a session") call
`navigator.startNewSession(draft)`.

### Desktop today
The new-session composer is a persisted draft (`store.ts:220-245`) holding
cwd, text, attachments, model, plan; submit creates the session and queues the
first prompt (`NewSessionScreen.tsx:739-760`).

### iOS design
- `SessionListView` observes `navigator.pendingDraft` → clears it and presents
  `.create(project: <derived>, draft:)`.
- `SessionCreateSheet` prefill (`SessionDraftPrefill.target(draft:,
  projects:)`, pure): a `cwd` equal to, or under, an existing project's
  `defaultCwd` or any window's `paneCurrentPath` → that project (longest
  match wins) with Folder = `cwd`; otherwise New project → *Folder* source with
  `cwd`; `cwd == nil` → today's default target.
- A "Carried over" section shows the text (3-line preview) and
  "N attachment(s)", with a "Don't carry over" button that drops both.
- On create the pushed target carries `seed: draft.text` and
  `seedAttachments: draft.attachments` (new non-identity field on
  `SessionOpenTarget`). The text and chips land in the new chat's composer
  (mount, WS02) — **not auto-sent** (see Open question 4). For a non-chat
  "Open as", the draft is dropped and the sheet says so in its footer
  ("Terminal sessions don't take a first message").

### Tests
`testPrefillMatchesProjectDefaultCwd`, `testPrefillLongestPrefixWins`,
`testPrefillUnderPaneCurrentPath`, `testPrefillUnknownCwdIsNewProjectFolder`,
`testPrefillNilCwdKeepsDefault`, `testPrefillDoesNotMatchSiblingPrefix`
(`/a/bc` is not under `/a/b`).

### Acceptance
- [ ] "Quote in new session" / inbox "start a session" open the create sheet
      already pointed at the right project/folder; after Create the chat opens
      with the text and attachments in the composer.

---

## 13. Files

All within WS04 ownership (`Session*`, `MantaNavigation.swift`,
`CloneFromGitHub*`, and the listed existing files).

**Edit**
- `SessionListView.swift` — group header menu, create-sheet init, mode-aware
  destinations, navigator consumer, switcher sheet host, worktree prompt
  host, empty state, rename via `SessionRenameSheet`, `SessionOpenTarget`
  fields (`mode`, `seedAttachments`).
- `SessionListStore.swift` — config keys, launchers, stopped records,
  subagent/halted row status, rename/close/project APIs, recents, mutation
  seam extension.
- `SessionModels.swift` — B2 (`TmuxCreateResult`), `SessionRowStatus` fields,
  subtitle precedence, `SessionDotState.halted`.
- `SessionCreateSheet.swift` — §3–§5, §12.
- `FolderPickerView.swift` — B1; also accept `title:` ("Choose folder" /
  "Choose location") for the scratch-root use.
- `MantaAppRoot.swift` — `@StateObject navigator` + `.environmentObject`.
- `MantaNavigation.swift` — fill the wave-0 scaffold (§11).

**Create**
- `MantaAPIClient+Sessions.swift` — RPC methods (below).
- `SessionForgeModels.swift` — `Decodable` wire types: `SessionDirListing`,
  `SessionWorktreeAdded {path, branch}`, `SessionWorktreeRemoval {removed,
  reason?}`, `SessionScratchProject {path, name}`, `RepoProbeResult`,
  `RepoHit`, `ForgeCliStatus`, `GitHubDeviceGrant`, `GitHubDeviceStart`,
  `GitHubDevicePoll`, `GitHubRepoList`, `GitHubRepo`, `CloneStartResult`,
  `CloneJobStatus`, `SessionLauncher`, `SessionLauncherFlag`,
  `SessionStoppedRecord`, `SessionStoppedList`, `SessionNewProjectInput`,
  `SessionNewWindowInput` (adds `worktreePath`).
- `SessionCreateLogic.swift`, `SessionSetupStore.swift`,
  `SessionRepoScanSection.swift`, `SessionModeLogic.swift`,
  `SessionModeMenu.swift`, `SessionRenameSheet.swift`,
  `SessionWorktreePromptSheet.swift`, `SessionSwitcherLogic.swift`,
  `SessionSwitcherSheet.swift`, `CloneFromGitHubLogic.swift`,
  `CloneFromGitHubConnect.swift`, `CloneFromGitHubView.swift`.
- Tests: `MantaUITests/SessionsTests.swift`,
  `MantaUITests/CloneFromGitHubTests.swift`,
  `MantaUITests/MantaNavigationTests.swift`; extend
  `MantaUITests/SessionModelsTests.swift` and `TerminalModelsTests.swift`.

**`MantaAPIClient+Sessions.swift` methods** (all via C1 `call` /
`callRequired` / `callVoid`):
`createSession(_: SessionNewProjectInput) -> TmuxCreateResult`
(`tmux:new-session`), `createWindow(_: SessionNewWindowInput) ->
TmuxCreateResult` (`tmux:new-window`), `renameProject(oldName:newName:)`
(`tmux:rename-session`), `killProject(_:)` (`tmux:kill-session`),
`deleteProjectMeta(_:)` (`project:meta:delete`), `addWorktree(cwd:name:)`
(`git:add-worktree`), `removeWorktree(path:force:)` (`git:remove-worktree`),
`listDirectory(_:)` (`fs:list-dirs`), `createScratchProject(root:name:)`
(`project:create-scratch`), `repoProbe()` (`forge:probe`),
`githubDeviceStart()`, `githubDevicePoll(grantId:)`,
`githubDeviceCancel(grantId:)` (`forge:device-*`), `githubRepos()`
(`forge:repos`), `cloneStart(url:dest:name:)`, `cloneStatus(id:)`,
`cloneCancel(id:)` (`forge:clone-*`), `launchers()` (`launchers:list`),
`usageStoppedList()` (`usage-stopped:list`).

**Ownership request (unowned files — see Open question 1):**
`TerminalScreen.swift`, `TerminalWebView.swift`, `TerminalModels.swift` —
additive only: `mode`/`sessionID`/`launcher` parameters, mode menu + switcher
button in the header, launcher query param, `SessionPtyKey`.

No server files. No `generated/swift/*` edits (settings are read from
`config:get`; WS10 owns moving `worktreePerSession` / `worktreeCleanOnClose`
to `platform: "both"`).

## 14. Mount requests

| Owner (wave) | File | Mount |
|---|---|---|
| WS07 (B) | `ChatOverflowSheet.swift` | (a) add row **"Rename session"** (`pencil`) → new closure `onRename`; (b) replace the "Open terminal" row (`:111`) with `SessionModeRows(current:, launchers:, onSelect:)` (shown only when the session has a window); new params `mode: SessionMode`, `launchers: [SessionLauncher]`, `onSelectMode: (SessionMode) -> Void`. |
| WS02 (B) | `ChatScreen.swift` | (a) nav title `sessionStore.window(forSessionID: sid)?.window.name ?? title` (`:341`); (b) wire `onRename` → present `SessionRenameSheet(title: "Rename session", …)` calling `sessionStore.renameSession`; (c) wire `onSelectMode` → `navigator.switchMode(windowKey:, sessionID:, to:)` (chat → no-op); pass `SessionModeStore.read` + `sessionStore.launchers`; (d) toolbar button "Switch session" (`rectangle.stack`, ⌘K) → `navigator.presentSwitcher()`; (e) accept `seedAttachments` from the target and hand each to the composer via C3 `attach(remotePath:displayName:mime:)` once on first appear; (f) consume `navigator.pending == .message(sid, mid)` for its own sid (WS02's C2 duty). |
| WS10 (A) | `SettingsScreen.swift` | `init(eventStore:, initialSection: String? = nil)` — scroll to / open that section. Until it lands WS04 calls the existing init. |
| WS09 (B) | `SessionListView.swift` (WS04 file, later wave) | optional "N stopped" pill in the list toolbar opening WS09's resume screen, reading `store.stoppedRecords` (data provided by §9). WS09's spec defines it. |

## 15. Contracts provided / consumed

- **C1 (consumed):** `call`/`callRequired`/`callVoid` internal; WS04 methods in
  `MantaAPIClient+Sessions.swift`.
- **C2 (provided):** `MantaNavigator` implementation, `.session` and
  `.settings` handling, `.message` push-to-chat (WS02 finishes it), additive
  `presentSwitcher()`, `startNewSession(_:)`, `switchMode(...)`,
  `windowKey(project:windowIndex:)`.
- **C3 (consumed):** `NewSessionDraft` (shape pinned in §12) and the composer
  `attach(...)` API (via WS02 mount).
- **Provided to WS05:** `GitHubDeviceConnectView` / `GitHubDeviceConnectStore`
  and the `githubDevice*` client methods are the **single** iOS device-flow
  implementation (desktop rule: "exactly one implementation of the device
  flow", `ConnectGithub.tsx:4-5`). WS05's Connect GitHub reuses them.
- **Provided to WS09:** `SessionStoppedRecord`/`SessionStoppedList` decoders,
  `usageStoppedList()`, and `SessionListStore.stoppedRecords` — WS09 must not
  declare a second copy.
- **Provided to WS06:** `SessionListStore.window(forSessionID:)` for result
  rows.
- C4–C7: no frames added (uses existing `subagent`, `status`,
  `usage-stopped.updated`); no schema edits; tests per C7.

## 16. Deferred

- **Random scratch-project names** — desktop's generator needs the 53 KB
  `friendlyWords.mjs` list. Porting it needs a generator script and a
  generated Swift file; not worth it for a name the user can type. iOS
  requires a typed name instead.
- **Keeping a CLI / shell alive across a disconnect** — iOS's `/pty` WS kills
  its pty when the socket closes (`ptyWs.mjs` close handler), so backgrounding
  the app restarts the CLI. Desktop keeps the pty mounted. Fixing it needs a
  server change to `/pty` reattach; out of scope.
- **Attaching to adopted (non-Manta) tmux windows** — `/pty` has no
  `tmuxTarget` (`ptyWs.mjs:164-179`), so iOS opens a fresh shell in the pane's
  folder instead of the pane itself. Pre-existing gap, unchanged.
- **Model / plan / trust choice in the create sheet** — the desktop
  new-session composer carries them; on iOS they are chosen in the session's
  own composer before sending. Not in this scope list.
- **"Inbox" first row in the switcher** — WS05 may add it (desktop has it).
- **"use a different account"** on the repo list — dead on desktop; not ported.

## 17. Open questions (each with a proposed default)

1. **Terminal files have no owner** (`TerminalScreen.swift`,
   `TerminalWebView.swift`, `TerminalModels.swift`, not in the master table),
   but the mode switch needs them. *Default:* assign them to WS04 for wave A,
   additive edits only.
2. **Where `NewSessionDraft` is declared.** C3 says WS03 adds it; WS04
   consumes it and WS01/WS05 produce it, all needing one type in wave A/C.
   *Default:* the wave-0 scaffold declares it in `MantaNavigation.swift` with
   the exact shape pinned in §12; WS03 does not redeclare it.
3. **One GitHub device flow for WS04 and WS05.** *Default:* WS04 builds it in
   `CloneFromGitHubConnect.swift` (wave A); WS05 (wave C) reuses it and does not
   create a `Git*` duplicate.
4. **Auto-send the draft's text on create, or prefill?** Desktop auto-sends;
   iOS's chat screen owns the optimistic outbox, which a send from the sheet
   would bypass. *Default:* prefill the composer (one extra tap, no
   duplicated send path).
