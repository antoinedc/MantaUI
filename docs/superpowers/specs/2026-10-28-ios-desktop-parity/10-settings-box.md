# WS10 — Settings, extensions, box, updates, upgrade actions, pairing

Status: revised (round 2) · Date: 2026-10-28 · Parent: `00-master.md` · Wave: **A1** (D20)
WS10 runs in A1 alongside WS01 and WS03. Same-wave consumption of WS03's
`references()` codes against the pinned signature (D21); the UI compile happens
on the Mac after wave A is integrated. WS10 depends on nothing from A2 (WS04,
WS08); those consume WS10's providers.

Scope: settings the desktop has and iOS does not, the Extensions section, the
Box section (add a device, linked devices, remove server, restart opencode),
software updates, the upgrade screen's actions, and two pairing changes
(DECISIONS §5.2.9, §6.3) plus the notification-denied reminder (§5.6).

Everything here is reached from the existing iOS Settings screen
(`SettingsScreen`, presented full-screen from `SessionListView.swift:158`).

---

## 0. How the iOS Settings screen is extended (read first)

Today `SettingsScreen.swift` renders **only** the generated inventory
(`generated/swift/SettingsSchema.swift`, produced from
`src/shared/settingsSchema.ts` by `scripts/gen-swift-settings.mjs`, which emits
only `platform: "both" | "mobile"` entries and only sections that contain one).
`custom` entries render as a non-interactive label (`labelRow`,
`SettingsScreen.swift` ~line 345).

This workstream keeps that model and adds one mechanism:

- **Custom anchors.** Each new non-value surface (Updates, Backup, Add a device,
  Linked devices, Plugins, …) gets a `control: "custom"`, `configKey: null`,
  `platform: "mobile"` entry in `settingsSchema.ts`. That makes the section
  appear on iOS, makes the surface searchable by label + help, and gives it a
  stable id. Desktop never sees `platform: "mobile"` entries, so desktop
  rendering is unchanged.
- **`SettingsCustomRow`** (new, `SettingsCustomRows.swift`) maps an anchor id to
  its real view (a NavigationLink row, an inline card, or a button). In
  `SettingsScreen.field(for:)` the `.custom` case calls
  `SettingsCustomRow(entryID:)` and falls back to today's `labelRow` for ids it
  does not know (e.g. `accountsList`).
- **Reset excludes custom entries.** `MantaSettingsLogic.sectionResetValues` /
  `resetAllValues` skip `control == .custom` (they hold no value; resetting them
  wrote `.null` into UserDefaults). This is a pure change with tests (§T1).

Resulting iOS section order (from `SETTING_SECTIONS`): notification reminder
(if any) · Accounts row (unchanged) · **General** · Box · Accounts · Models ·
Sessions · Files · **Extensions** · Voice.

### 0.1 Schema changes (`src/shared/settingsSchema.ts`) — exact

| id | section | change | control | configKey | platform | default | label / help |
|---|---|---|---|---|---|---|---|
| `themeMobile` | general | **NEW** | segmented | `null` (device-local) | mobile | `"system"` | "Theme" / "System follows your phone's appearance." options System/Light/Dark (`system`/`light`/`dark`), group "Appearance" |
| `hapticsEnabled` | general | **NEW** | toggle | `"hapticsEnabled"` | mobile | `true` | "Haptics" / "Light taps when you swipe, confirm or delete in the session list, and when a turn finishes." group "Feedback" |
| `updatesMobile` | general | **NEW** anchor | custom | null | mobile | null | "Software updates" / "Check whether Manta Server, opencode or an AI CLI on your box has an update, and install it." |
| `backupMobile` | general | **NEW** anchor | custom | null | mobile | null | "Restore windows" / "Rebuild your chat window layout — names, order and grouping — if the box's terminal server restarted. Conversations are never affected." |
| `serverUrlMobile` | box | **DELETE** | — | — | — | — | dead on every client (see F13) |
| `boxStatusMobile` | box | **NEW** anchor | custom | null | mobile | null | "Server" / "The box this phone is connected to." |
| `addDeviceMobile` | box | **NEW** anchor | custom | null | mobile | null | "Add a device" / "Show a pairing code so another phone or a computer can connect to this box." |
| `linkedDevicesMobile` | box | **NEW** anchor | custom | null | mobile | null | "Linked devices" / "Phones and computers that can reach this box. Revoke one you don't recognise." |
| `restartOpencodeMobile` | box | **NEW** anchor | custom | null | mobile | null | "Restart opencode" / "Restarts the agent engine on your box. Every running agent turn ends." |
| `removeServerMobile` | box | **NEW** anchor | custom | null | mobile | null | "Remove server" / "Forget this box on this phone and sign this phone out of it." |
| `worktreePerSession` | sessions | platform `desktop` → **`both`** | toggle | unchanged | both | false | unchanged |
| `worktreeCleanOnClose` | sessions | platform `desktop` → **`both`** | toggle | unchanged | both | false | unchanged |
| `pluginsListMobile` | extensions | **NEW** anchor | custom | null | mobile | null | "Plugins" / "Plugins installed on your Mac. They run there; this phone can only see them." |
| `forgeMobile` | extensions | **NEW** anchor | custom | null | mobile | null | "GitHub and forge rules" / "The GitHub account your box uses, and rules that start agents from GitHub events." |
| `skillRegistriesMobile` | extensions | **NEW** anchor | custom | null | mobile | null | "Skill registries" / "Extra skill registry URLs opencode loads on startup." |
| `referencesMobile` | extensions | **NEW** anchor | custom | null | mobile | null | "References" / "External folders or git repositories you can attach in chat with @alias." |
| `launcherFlagsMobile` | extensions | **NEW** anchor | custom | null | mobile | null | "CLI launch options" / "Flags used when a session starts an AI CLI such as Claude Code." |

Unchanged and still desktop-only: `theme`, `allowAgentPush`, `downloadsDir`,
`opencodePort`, `pluginsEnabled` (reasons in §Deferred). `theme` deliberately
stays desktop-only: the box config is shared by every device, so writing
`theme` from the phone would flip the desktop's theme too — hence the separate
device-local `themeMobile`.

After editing: `npm run gen:swift-settings` (rewrites
`generated/swift/SettingsSchema.swift`), `node scripts/gen-swift-settings.mjs --check`
must pass. Update `src/shared/settingsSchema.test.ts`: the cases at lines 94
and 187 that use `serverUrlMobile` switch to `themeMobile`; add a case that
`themeMobile`/`hapticsEnabled` are mobile-only and `worktreePerSession` is on
both platforms. (`scripts/gen-swift-settings.test.mjs` uses its own sample
schema — untouched.)

### 0.2 Commit path for box-config settings (applies to EVERY config-driven row)

Today `MantaSettingsStore.commit` (`MantaSettingsStore.swift:113-127`) writes
the new value into `values` BEFORE the request and only sets `lastError` on
failure, so a rejected save leaves the screen showing a value the box never
stored. WS10 fixes `commit` itself (owned file), so F1, F5 and every existing
toggle / segmented / text row become failure-safe:

- `values` holds only **confirmed** values (loaded or saved).
- New `@Published private(set) var pending: [String: SettingValue]` holds the
  value being saved; `current(_:)` returns `pending[id] ?? values[id] ?? default`
  (so the control moves immediately).
- New `@Published private(set) var saving: Set<String>`.
- `@discardableResult func commit(_ entry: SettingEntry, _ value: SettingValue) async -> Bool`:
  - device-local entry → persist to UserDefaults, set `values`, return `true`
    (unchanged behaviour);
  - config entry already in `saving` → return `false` (rows are disabled while
    saving, so this is a guard, not a UX path);
  - otherwise insert into `saving`, set `pending`, `await configuration.update`;
    success → `values[id] = coerced`, `lastError = nil`; failure → keep the old
    confirmed value, `lastError = "Couldn't save \(entry.label)."`; always
    remove `pending[id]` and `saving`.
  Writes are therefore serialized per entry; there is no stale-response race.
- `SettingsScreen` rows call it inside `Task { await store.commit(...) }`,
  render `.disabled(store.saving.contains(entry.id))`, and show a small
  `ProgressView` trailing the label while saving. `lastError` is published today
  but **never rendered** (`SettingsScreen.swift` has no reference to it — a
  silent failure); WS10 adds a danger-toned banner under the search field that
  shows `store.lastError` (also covers load/reset/restore failures), with a ×
  that calls new `store.clearError()`. It clears on the next successful save.
- `setBool` (chat trust toggle, BET-748) is unchanged.
- **Shared mutation guard (reset/undo vs. commit).** Reset / undo keep their
  existing optimistic batch write (redesign deferred) but are serialized
  against commits through one guard on the store:
  - new `@Published private(set) var batchWriting = false`;
  - `var isMutating: Bool { batchWriting || !saving.isEmpty }`;
  - `resetSection`, `resetAll`, `undoLastReset` return immediately (no change,
    no write) when `isMutating`; otherwise set `batchWriting = true` before
    their `configuration.update` and clear it when that write completes
    (success or failure). They become `async` internally; the public API keeps
    its synchronous signatures by spawning the `Task` and setting
    `batchWriting` synchronously before returning, so the guard is visible to
    the very next call;
  - `commit` for a config entry also returns `false` without writing when
    `batchWriting` is true;
  - `SettingsScreen` disables every config-driven row while `batchWriting`,
    and disables the per-section "Reset", the "Reset all settings…" button and
    the toast's "Undo" while `isMutating`.
  So a pending toggle and a reset can never interleave; the box and the
  screen always end with the same value.

Tests: §T1 (injected failing/succeeding/gated `SettingsConfigurationStore`,
including the commit-vs-reset interleavings).

---

## Features

### F1. Worktree toggles ("Create git worktree for new sessions", "Remove worktree when a session is closed")

**Desktop today.** Settings → Sessions → card "Git worktrees", two toggles
(schema entries `worktreePerSession` `settingsSchema.ts:223`,
`worktreeCleanOnClose` :235; rendered by the generic `ToggleField`,
`Settings.tsx` ~line 150). Persisted with `config:update`. Consumed **client
side** by the desktop: `Sidebar.tsx:140,248,308,1046` (close / destroy honour
`worktreeCleanOnClose`), new-session dialog reads `worktreePerSession`
(`store.ts:371`).

**Wire.** `config:get` → `AppConfig.worktreePerSession?: boolean`,
`worktreeCleanOnClose?: boolean` (`src/shared/types.ts:110,118`; server
defaults `false`, `src/server/local.mjs` `DEFAULT_CONFIG`). Write:
`config:update` `[{"worktreePerSession": Bool}]` → returns the merged config.

**iOS.** Flip both entries to `platform: "both"`; they render automatically in
the Sessions section through the existing generic toggle row
(`SettingsScreen.toggleRow`) and persist through the awaited, serialized
`MantaSettingsStore.commit` of §0.2 → `config:update`. No new Swift view.

**Contract to WS04 (consumed there):** WS04's create flow pre-selects "own
worktree" from `config["worktreePerSession"] == true`, and its close flow runs
the worktree prompt only when `config["worktreeCleanOnClose"] == true`, reading
the box config at the moment of the action (`MantaAPIClient.configGet()`), not a
cached copy. Until WS04 lands, the toggles are honest on iOS because they
already change desktop behaviour (shared config) — not dead.

**Acceptance**
- Both toggles appear under Sessions on iOS, reflect the box value on open, and
  a change is visible on the desktop's Settings after its next config read.
- While saving the toggle is disabled with a spinner; a failed save returns the
  toggle to the last confirmed value and shows "Couldn't save <label>." in the
  error banner (§0.2). Proven by §T1 tests with an injected failing store.

### F2. "Auto-save files the AI sends" — **excluded** (see Deferred D1)

### F3. Downloads directory — **excluded** (Deferred D2)

### F4. Theme override (System / Light / Dark)

**Desktop today.** General → Appearance → Theme segmented control
(`settingsSchema.ts:119`, box config key `theme`, applied live by
`applyTheme` in `src/renderer/theme.ts`).

**iOS today.** Follows the system only; nothing in the app calls
`preferredColorScheme` (verified by grep). All colours come from
`Tokens.scheme(colorScheme)`, so overriding the environment colour scheme
re-themes everything.

**Wire.** None (device-local; see §0.1 why not the shared `theme` key).
Stored by `MantaSettingsStore` in UserDefaults under its existing device-local
key format `manta.settings.local.themeMobile` (`MantaSettingsStore.deviceStorageKey`).

**iOS design.**
- New pure, Foundation-only type in `SettingsAppearance.swift` (goes in
  `Package.swift` per D19):
  ```swift
  enum ThemePreference: String, Sendable { case system, light, dark }
  enum SettingsAppearance {
    static let storageKey = "manta.settings.local.themeMobile"   // must equal MantaSettingsStore's key for entry "themeMobile"
    static let systemValue = "system"
    static func preference(for stored: String?) -> ThemePreference  // "light"/"dark" → that; anything else → .system
  }
  ```
  and, in the SwiftUI file `SettingsAppearanceView.swift`:
  `extension ThemePreference { var colorScheme: ColorScheme? }` (.system → nil).
- `SettingsScreen` applies `.preferredColorScheme(SettingsAppearance.preference(for: themePref).colorScheme)`
  on its own `NavigationStack` (via `@AppStorage(SettingsAppearance.storageKey)`)
  so the change is visible the instant the user taps it.
- App-wide application is mount **M-10-1** in `MantaAppRoot.swift`.
- Renders through the generic segmented row; no custom view.

**Acceptance**
- Choosing Dark/Light re-themes Settings immediately and the whole app after
  Settings is dismissed; System returns to following the phone.
- Survives relaunch. Does not change the desktop's theme.

### F5. Haptics on/off

**Desktop.** None (desktop has no haptics) — this is DECISIONS §7.4 "Must be
user-disableable". **iOS today:** `SessionListStore.hapticsEnabled` (default
`true`) is read from box config key `hapticsEnabled` in
`SessionListStore.loadConfig()` (`SessionListStore.swift:657-668`) and gates
every `SessionHaptics.fire(...)` in `SessionListView.swift` and the
turn-complete haptic in `ChatScreen.swift:439-445`. `setHapticsEnabled(_:)`
(`:552`) exists but nothing in the UI calls it.

**Wire.** `config:update` `[{"hapticsEnabled": Bool}]` (generic key; server
merges any key, `local.mjs configUpdate`).

**iOS design.** New schema entry `hapticsEnabled` (§0.1) renders as the generic
toggle in General. To keep ONE writer per key and keep the session list's
in-memory copy fresh:
- The toggle row for `hapticsEnabled` uses the awaited `commit` of §0.2 like
  every other row; when it returns `true` the screen calls
  `sessionStore.loadConfig()` (`@EnvironmentObject SessionListStore` —
  available inside the full-screen cover); a `false` return leaves the
  confirmed value and the "Couldn't save Haptics." banner.
- `SettingsScreen` also calls `sessionStore.loadConfig()` in `.onDisappear`, so
  a reset/undo of `hapticsEnabled` or `cacheTtl` reaches the session list.
- When turned on, play one `UISelectionFeedbackGenerator` tick as confirmation.

**Acceptance**
- Off → no haptic on swipe-commit, destructive confirm, delete, or turn
  complete. On → they return. Survives relaunch (box config).

### F6. opencode port — **excluded** (Deferred D3)

### F7. Restore windows (Backup)

**Desktop today.** General → "Backup" card (`Settings.tsx:1076-1110`, logic
`:621-660`). On entering General it calls `tmux:restore-preview`; shows
"Restore windows" (disabled with tooltip "Nothing to restore — every saved
window is already open." when `restorable == 0`), "Last backup <date> · W
windows across P projects", "N window(s) can be restored." / "Every saved
window is already open.", or "No backup yet. Manta saves your window layout
automatically as you work." when `available == false`. Intro copy: "Manta saves
your chat window layout — names, order and grouping — so it can be rebuilt if
the box's terminal server restarts. Your conversations are stored separately
and are never affected." Restore → toast with server `message` (default
"Windows restored.") or "Couldn't restore your windows. <error>"; preview re-runs.

**Wire.**
- `tmux:restore-preview` (no args) → `TopologyRestorePreview`
  `{available: Bool, capturedAt: number|null (epoch ms), ops: [{kind, tmuxSession, mantaOwned, index, name, opencodeSessionId, cwd, worktreePath}], skipped: [{tmuxSession, index, name, opencodeSessionId, reason}], restorable: Int}`
  (`src/shared/api.ts:253-283`, handler `rpc.mjs:1177`). Read-only.
- `tmux:restore-topology` (no args) → `{ok, error?, created, failed, skipped?, windows?, failures?, message?}`
  (`api.ts:290`, handler `rpc.mjs:1202`).
- A successful `{available:false}` answer is "No backup yet"; a FAILED request
  is a different state (the desktop swallows it into null,
  `Settings.tsx:632-640` — iOS does not copy that silence).

**iOS design.** Anchor `backupMobile` → NavigationLink row "Restore windows" →
`SettingsBackupScreen.swift`, driven by a pure state
`BackupPreviewState = .loading | .loaded(TopologyRestorePreview) | .failed(String)`:
- `.loading` → inline `MantaLoader`, no button.
- `.loaded` → intro copy; status line; primary "Restore windows" (disabled +
  footnote "Every saved window is already open." when `restorable == 0`;
  hidden when `available == false`).
- `.failed(msg)` → "Couldn't load the saved window layout. <msg>" (danger tone)
  + "Try again" (re-runs the preview). Restore is **hidden** — never offered
  without a successful preview. This applies equally to a refresh that fails
  after an earlier success (the old preview is discarded, not shown stale).
- After a restore: inline result banner with the server `message` (ok tone) or
  "Couldn't restore your windows. <error>" (danger), then re-preview and
  `await sessionStore.refresh()` so the list shows the restored windows.
  The button shows a spinner and is disabled while restoring.

**Pure logic** (`SettingsBackupModels.swift`, Foundation-only, `enum BackupSummary`):
`windows(preview) = ops.count + skipped.count`,
`projects(preview) = Set((ops+skipped).map(\.tmuxSession)).count`,
`statusLine(preview)` → the exact strings above (date via an injected
formatter), `showsRestore(state) -> Bool` (true only for `.loaded` with
`available`), `restoreEnabled(state) -> Bool`.

**Acceptance:** matches desktop strings; restore outcome always shown; button
disabled while restoring (spinner).

### F8. Plugins list (view) and the plugins setting

**Desktop today.** Extensions → Plugins (`Settings.tsx` ~1185-1240): Mac-local
toggle "Run plugins on this machine" (preload `pluginsGetEnabled/SetEnabled`,
`schema :315`, `configKey null`); list via `plugins:registry`, polled every
10 s while Extensions is open; each row: name, "valid" badge or "parse error:
<error>", "N step(s) · <timeout>", description, "Inputs: id=default, …"; empty
"No plugins installed yet. The AI can author them with plugin.write when this
toggle is on."; "Open plugins folder" (Mac reveal).

**Wire.** `plugins:registry` (no args) → `PluginRegistryRow[]`
(`types.ts:2720-2745`): `{name, description, inputs:[{id, description, type, default?, values?}], valid: true, yaml, stepCount, timeoutMs|null}` or
`{…, valid: false, error, yaml}` (handler `rpc.mjs:2592`). In-memory on the
box; the Mac executor republishes on every reconnect.

**iOS design.** Anchor `pluginsListMobile` → `ExtensionsPluginsScreen.swift`.
Read-only list with the same row content (timeout formatted like desktop
`formatTimeout`: `<1000 → "Nms"`, `<60000 → "Ns"`, else `"Nm"`). Header note:
"Plugins run on your Mac. Turn them on or off in Manta on your Mac (Settings →
Extensions)." Empty: "No plugins are installed on your Mac — or plugins are
turned off there." Error: "Couldn't load the plugins list. <error>" + "Try
again". Polls every 10 s while visible (`.task` loop, cancelled on disappear).
Tap a row → sheet showing the YAML in monospace (read-only, copy via
`textSelection(.enabled)`). **No toggle, no folder button** (Deferred D4).

**Pure:** `ExtensionsFormat.timeout(ms:)`, `ExtensionsFormat.inputsLine(_:)`.

### F9. GitHub connection + forge rules

**Desktop today.** Extensions → "Forge" card (`Settings.tsx:1244-1310`,
logic `:836-888`): GitHub row — "Checking…" / connected with
`forgeCredentialSecondary(status)` (`chatUtils.ts:4293`) and a "Disconnect"
button / "Not connected."; checkbox "Let forge rules start agents on this
server" (config key `forgeRulesEnabled`); rules list (10 s poll): valid rows
"<repoKey> · N rule(s) · valid", invalid rows with the error verbatim in danger;
empty "No forge rules yet. The AI authors them on the server with
forge_rules.save; each is a YAML file at ~/.manta/forge-rules/." Disconnect
toast: "Disconnected GitHub. Your gh CLI is untouched — Manta will ignore it
until you reconnect." / "Couldn't disconnect GitHub. <error>".

**Wire.**
- `forge:status` → `{connected: true, login: String|null, kind: "github", source: "cli"|"env"|"stored"|null, valid: Bool|null}` or `{connected: false}` (`types.ts:622`, `rpc.mjs:952`). The handler validates against GitHub only when `input.validate === true`.
  **Single owner (D16): WS10** defines, in `MantaAPIClient+Settings.swift`,
  `func forgeStatus(validate: Bool) async throws -> ForgeConnectionStatus`
  (args `[["validate": validate]]`) and the wire type in `SettingsWireModels.swift`:
  ```swift
  struct ForgeConnectionStatus: Decodable, Equatable, Sendable {
    var connected: Bool
    var login: String?        // only when connected
    var kind: String?         // "github"
    var source: String?       // "cli" | "env" | "stored" | nil
    var valid: Bool?          // nil = not probed
  }
  ```
  Settings calls `forgeStatus(validate: true)` (desktop parity,
  `Settings.tsx:853`). WS05 consumes this exact member/type (its chat-side
  refresh uses `validate: false`, matching desktop `ChatPanel.tsx:1055` which passes
  no input) and declares no `forgeStatus` / `GitForgeStatus` of its own.
- `forge:rules-list` (no args) → `[{repoKey, valid, error?, ruleCount?}]` (`rpc.mjs:965`).
- `forge:disconnect` (no args) → `{ok: true}` (`rpc.mjs:981`).
- `config:get` `forgeRulesEnabled` (Bool, absent = false); `config:update` `[{"forgeRulesEnabled": Bool}]`.

**iOS design.** Anchor `forgeMobile` → `ExtensionsForgeScreen.swift`.
Section "GitHub": status row with dot (ok / warn when `valid == false` / idle),
secondary text from the Swift port of `forgeCredentialSecondary`, trailing
"Disconnect" (confirmation dialog "Disconnect GitHub?" / "Your gh CLI on the
box is not signed out — Manta just stops using it until you reconnect.").
Not connected: "Not connected." (Connecting is WS05's device flow; Settings
does not duplicate it.) Section "Forge rules": `Toggle` "Let forge rules start
agents on this server" (optimistic, reverted with "Couldn't change forge
rules." on failure), then the list (10 s poll while visible) with desktop
copy. Loading/error states as F8.

**Pure:** `ExtensionsForge.secondary(login:source:valid:) -> String` — exact
port of `forgeCredentialSecondary` (box wording "server" kept).

### F10. Skill registries (add / remove)

**Desktop today.** Extensions → "Skill registries" (`Settings.tsx:1311-1327`,
logic `:708-735`): intro "Extra skill registry URLs fetched by opencode on
startup. The default Manta registry is always included."; list of URLs each
with ×; field "https://example.com/skills" + "Add" (disabled when blank;
ignores duplicates); optimistic save via `config:update {skillRegistryUrls}`,
revert + "Couldn't update skill registries." on failure; on success raises the
"restart needed" banner ("An opencode restart is needed to apply recent model
or endpoint changes. Restarting interrupts all running sessions." + "Restart
opencode" / "Later", `Settings.tsx:1505`).

**Wire.** `config:get` → `skillRegistryUrls: [String]?`; `config:update`
`[{"skillRegistryUrls": [String]}]` → merged config (read back the saved array).
Restart via `opencode:restart` (F16).

**iOS design.** Anchor `skillRegistriesMobile` → `ExtensionsRegistriesScreen.swift`.
List with swipe-to-delete (and an explicit "Remove" in a context menu for
accessibility); add field + "Add" button. After a successful save show an
inline banner "Restart opencode to load the new registries. Restarting ends
every running agent turn." with "Restart opencode" (runs F16's confirm + call)
and "Later". Failure reverts and shows "Couldn't update skill registries."

**Pure:** `ExtensionsRegistries.add(_ url: String, to list: [String]) -> [String]?`
(trim; nil when blank or duplicate), `remove(_:from:)`.

### F11. References (add)

**Desktop today.** Extensions → "References" (`Settings.tsx:1328-1360`, logic
`:737-783`): intro "Add an external directory or git repository as an opencode
reference. Type @alias in the chat to attach it, or @alias/… to search inside
it. Agents can read a reference's files without a permission prompt. Removing a
reference isn't available yet."; list "@name → path" or "@name → repo (branch)"
+ description; empty "No references configured."; fields alias / "path or
repository — e.g. ../docs or owner/repo" / "optional description"; "Add"
(disabled unless alias + target). Validation: `validateReferenceAlias`
(`settingsSchema.ts`), target required ("Enter a local path or a repository.");
`classifyReferenceTarget` picks `path` vs `repository`. Outcomes: toast
"Reference added" / "Couldn't add reference: <error>".

**Wire.**
- `opencode:references` (no args) → `[{name, path?, repository?, branch?, description?, hidden?}]` (`opencode.mjs:2931`, `rpc.mjs:1992`).
- `opencode:set-references` args `[{"upsert": [{alias, path | repository, description?}]}]` → `{ok: true}` or `{ok: false, error}` (`providers.mjs:705`, `rpc.mjs:1998`). Hot-applies (config edit + reload, no restart).

**Client members (D16).** The read is **WS03's** member
`references() async throws -> [OpencodeReferenceInfo]` (`03-composer.md` F4,
`MantaAPIClient+Composer.swift`) — WS10 does not add a second
reader. The write `opencodeSetReferences(upsert:)` is WS10's (no other spec
writes references). WS03 runs in the same sub-wave (A1); per D21 WS10 codes
against WS03's pinned signature (`03-composer.md` F4: `func references() async
throws -> [OpencodeReferenceInfo]`, fields `name, path?, repository?, branch?,
description?, hidden?`) and the screen compiles once wave A is integrated.

**iOS design.** Anchor `referencesMobile` → `ExtensionsReferencesScreen.swift`:
list + a Form section "Add a reference" with the three fields, inline field
errors (desktop strings), "Add" button with spinner; success clears the form,
refetches, shows "Reference added"; failure shows "Couldn't add reference:
<error>". No remove (parity; see Deferred D6).

**Pure (exact ports, with the TS test cases mirrored):**
`ExtensionsReferences.validateAlias(_:) -> String?`,
`ExtensionsReferences.classifyTarget(_:) -> Kind (.path | .repository)`,
`ExtensionsReferences.upsertPayload(alias:target:description:) -> [String: Any]`,
`ExtensionsReferences.displayTarget(name:path:repository:branch:) -> String`
(takes plain fields so the helper stays independent of WS03's type).

### F12. CLI launch options

**Desktop today.** Extensions → "CLI launch options" (`Settings.tsx:1362-1380`,
logic `:785-796`), only rendered when some launcher has flags. Intro "Flags
used when launching an AI CLI (e.g. Claude Code) directly in a session's
terminal. Only CLIs detected on this server are shown." One checkbox per flag.
Value = `resolveLauncherFlags(schema, saved)` (`chatShared.tsx:504`: saved ??
default); write = `updateLauncherFlag` (`settingsShared.ts:41`) which writes the
launcher's FULL resolved map. Optimistic; revert + "Couldn't save launcher
flag." on failure.

**Wire.** `launchers:list` (no args) → `[{id, label, flags:[{key, label, type:"boolean", default}]}]`
(`launchers.mjs:37`, `rpc.mjs:2645`). Config key `launcherFlags`:
`{[launcherId]: {[flagKey]: Bool}}`; `config:update [{"launcherFlags": {...}}]`.

**Provider (D21 — WS10 owns launcher discovery; WS04 consumes, A2).**
Everything below is declared by WS10 and is the ONLY launcher API in the app:

- Wire types, `SettingsWireModels.swift` (Foundation-only, [pkg]):
  ```swift
  struct AvailableLauncherFlag: Decodable, Equatable, Hashable, Sendable {
    var key: String          // stable config key, e.g. "skipPermissions"
    var label: String        // user-facing
    var type: String         // always "boolean" today; rows render only type == "boolean"
    var `default`: Bool      // JSON key "default"
  }
  struct AvailableLauncher: Decodable, Equatable, Hashable, Sendable, Identifiable {
    var id: String           // launcher id, e.g. "claude"
    var label: String        // e.g. "Claude Code"
    var flags: [AvailableLauncherFlag]   // [] when the CLI has no flags
  }
  ```
  Decoding is strict for `id`/`label`/`key`/`label`; a missing `flags` array
  decodes as `[]`, a missing `type` as `"boolean"`, a missing `default` as
  `false` (custom `init(from:)`), so an older box never blanks the list.
- Client member, `MantaAPIClient+Settings.swift`:
  `func launchersList() async throws -> [AvailableLauncher]` —
  `callRequired("launchers:list", args: [], as: [AvailableLauncher].self)`
  (server returns installed, non-hidden launchers in registry order,
  `launchers.mjs:37-60`, `rpc.mjs:2645`; a missing result throws — the caller
  shows a retry, never an empty list as success).
- Pure resolver + writer, `ExtensionsModels.swift` (Foundation-only, [pkg]):
  ```swift
  enum ExtensionsLaunchers {
    /// Port of resolveLauncherFlags (chatShared.tsx:504-511): for every flag in
    /// `schema`, saved[key] ?? flag.default. Keys in `saved` not in `schema` are dropped.
    static func resolve(schema: [AvailableLauncherFlag], saved: [String: Bool]?) -> [String: Bool]
    /// Port of updateLauncherFlag (settingsShared.ts:41-57): returns `prev` with
    /// prev[launcherID] replaced by the launcher's FULL resolved map plus
    /// [flagKey] = checked. Unknown launcherID → `prev` unchanged.
    static func update(launchers: [AvailableLauncher], launcherID: String, flagKey: String,
                       checked: Bool, prev: [String: [String: Bool]]) -> [String: [String: Bool]]
    /// Reads config["launcherFlags"] (`[String: JSONValue]` from configGet) into
    /// the typed map; non-object / non-bool entries are skipped.
    static func savedFlags(from config: [String: JSONValue]?) -> [String: [String: Bool]]
  }
  ```
  `JSONValue` is in `MantaModels.swift` — that file must be in the [pkg]
  target with `ExtensionsModels.swift` (manifest M-10-3; WS01 already owns
  `MantaModels.swift` per D1 and it is already listed in `Package.swift`).
- Consumers: WS04 (A2) — session-mode rows / launcher catalog
  (`04-sessions.md:158-163,1295-1296,1353`). WS04 declares no launcher member,
  type or resolver. WS10 consumes nothing launcher-related from WS04.

**iOS design.** Anchor `launcherFlagsMobile` → `ExtensionsLaunchersScreen.swift`
(state in the screen's `@StateObject ExtensionsLaunchersModel`, `@MainActor
final class`): on appear, `launchersList()` and `configGet()` concurrently;
then one `Section(launcher.label)` per launcher with non-empty `flags`, a
`Toggle(flag.label)` per flag bound to
`ExtensionsLaunchers.resolve(schema: launcher.flags, saved: saved[launcher.id])[flag.key]`.
Empty (no launcher has flags): "No AI CLI with launch options is installed on
your box." Writing: `ExtensionsLaunchers.update(...)` →
`configUpdate(["launcherFlags": <map>])`, awaited and serialized (all toggles
disabled with a spinner while one save runs); success adopts the saved map
from the returned config (`savedFlags(from:)`), failure reverts and shows
"Couldn't save launcher flag." Load failure: "Couldn't load the AI CLIs on
your box. <error>" + "Try again". Settings calls `sessionStore.loadConfig()`
on disappear (F5) so WS04's cached flags refresh.

### F13. Box status card (replaces the dead "Server URL" field)

**Finding.** The iOS Box section today renders the schema entry
`serverUrlMobile` ("Server URL", `settingsSchema.ts:137`) as an editable text
field that writes `manta.settings.local.serverUrlMobile` — **nothing reads that
key** (grep: no consumer in `mobile/native`, `src/`). It was the retired web
client's override (BET-559). It is a dead control and is deleted (§0.1).

**Desktop today.** Box → read-only status card (`Settings.tsx` ~1125-1145):
dot + "Connected"/"Not paired", "Server URL <url>", "Server v<version>".

**Wire.** `server:version` (no args) → `{version, minClient, opencodeVersion}`
(`rpc.mjs` ~2572). Server URL from `KeychainCredentialStore.shared.serverURL`.
Connection from `MantaEventStore.connectionState.name == "connected"`.

**iOS design.** Anchor `boxStatusMobile` renders inline (no navigation): dot
(ok when connected, `tx4` otherwise) + "Connected" / "Reconnecting…", rows
"Server URL" (monospace, selectable) and "Server" `v<version>` (omitted until
loaded; a failed read omits it), and "opencode" `<opencodeVersion>`.

### F14. Add a device (QR + rotating code)

**Desktop today.** Box → "Devices" → `AddPhonePanel.tsx` (+ `PairingQR.tsx`,
`pairPanel.ts`). Mints on open via `auth:pair`; QR of
`buildUniversalPairLink({boxId, code, serverUrl?})`
(`pairPayload.ts:241`: `https://app.mantaui.com/m?box=<id>&code=<6>[&server=<url-encoded>]`);
`server=` only when the configured URL differs from `https://<boxId>.boxes.mantaui.com`
AND is private (`resolveQrServerOverride`, `pairPanel.ts`); shows "Code: …",
"Server ID: …", countdown "Expires in m:ss" (red under 60 s) / "Expired.
Generate a new code."; auto-rotates on expiry (1 s tick,
`shouldRefreshPairCode`); "Refresh code" / "Refreshing…"; errors in danger.

**Wire.** `auth:pair` (no args) → `{ok: true, pairingCode: "123456", boxId: "<32hex>", expiresAt: "<ISO-8601>"}`
or `{ok: false, error}` (`rpc.mjs:2558`, type `types.ts:2710`). Runs in-process,
so it works over the phone's authenticated `/rpc` (the HTTP `GET /auth/pair`
is loopback-only and must NOT be used).

**iOS design.** Anchor `addDeviceMobile` → `BoxAddDeviceScreen.swift`.
- Header "Add a device". Body: "Point the other phone's camera at this code, or
  open Manta on it and scan. It refreshes on its own every five minutes."
- QR rendered natively with CoreImage (`CIFilter.qrCodeGenerator()`, correction
  level "M", nearest-neighbour scaled, white quiet zone) in a new
  `BoxPairingQR.swift`.
- Below: "Code" + six digits (monospace, large), **"Server address"** + the
  value from `BoxPairing.manualAddress(boxId:connectedServerUrl:)` (monospace,
  selectable, with a "Copy" button → `UIPasteboard`, then "Copied"), "Server
  ID" + boxId (monospace, selectable), countdown pill
  (`TimelineView(.periodic(every: 1))`), "Refresh code" button (spinner
  "Refreshing…").
  `manualAddress` returns the phone's own normalized connected URL
  (`KeychainCredentialStore.shared.serverURL?.absoluteString` — the store exposes
  `serverURL: URL?`, `KeychainCredentialStore.swift:21` — through
  `MantaPairing.normalizeServerURL`) — the address this phone actually reaches
  the box at. So on a Tailscale/private box (where the Server ID's derived
  `https://<id>.boxes.mantaui.com` does not exist, `pairPanel.ts:46-74`) the
  visible address is the private one, and it is exactly what F21's "Server
  address" field accepts. When the connected URL is missing it falls back to
  `MantaPairing.boxDirectURL(boxId)`.
- Auto-rotate: when `now >= expiresAt` while visible, mint again (guarded so
  only one mint is in flight).
- Footer: "Prefer to type it? On the other device open Manual Setup and type
  the six digits and the server address above."
- Acceptance case: on a Tailscale box, a second phone pairs via Manual Setup
  using only the Code and Server address visible on this screen.
- `UIApplication.shared.isIdleTimerDisabled = true` while the screen is up (so
  the code stays on screen while someone scans), restored on disappear.
- Error: "Couldn't create a pairing code. <error>" + "Try again".

**Pure** (`BoxPairingModels.swift`, `enum BoxPairing`):
`universalLink(boxId:code:serverUrl:) -> String` (exact port of
`buildUniversalPairLink`, encoding with `.urlQueryAllowed` minus `&=+/:`— must
round-trip through `MantaPairing.parsePairPayload`),
`manualAddress(boxId:connectedServerUrl:) -> String?`,
`qrServerOverride(boxId:configured:) -> String?` (port of
`resolveQrServerOverride`, using `MantaPairing.boxDirectURL`,
`normalizeServerURL`, `isPrivateServerURL`), `shouldRefresh(expiresAt:now:)`,
`countdown(expiresAt:now:) -> (text: String, low: Bool, expired: Bool)`,
`parseExpiresAt(_ iso: String) -> Date?` (ISO-8601 with and without fractional
seconds).

### F15. Remove server (unpair)

**Desktop today.** Box → Danger zone "Remove server" (`Settings.tsx:890-911`,
confirm `:1541-1549` "Remove this server?" / "The desktop will forget its
pairing and saved projects. If the server is reachable, its current token is
also revoked. …"). It calls the preload `authUnpair` → `DELETE /auth/revoke`
with NO `device_id` (`src/main/unpair.ts`) — which on the server is the
**whole-box reset** (`auth.mjs:578` revoke: mints a new identity, drops EVERY
device). That is Electron-local and far too destructive for a phone.

**iOS design — revoke only this phone, as a state machine.**

The flow is a pure reducer `BoxRemovalFlow` (`BoxDevicesModels.swift`,
Foundation-only) driven by `SettingsBoxRemovalStore` (`@MainActor final class`,
in `BoxRemovalStore.swift`, which performs the I/O):

| state | entered when | UI | next |
|---|---|---|---|
| `.confirming` | "Remove server" tapped | confirmation dialog "Remove this server?" / "This phone forgets the box and signs itself out of it. Your desktop and other devices stay connected. To use this box again you'll need a new pairing code." / destructive "Remove" | Remove → `.revoking`; Cancel → `.idle` |
| `.revoking` | Remove | row spinner "Removing…", all Box rows disabled | `GET /auth/devices` → `BoxRemoval.plan(devices:)`; `.revoke(id)` → `DELETE /auth/revoke?device_id=<id>`; result recorded as `remote: RemoteRevokeResult` (`.revoked`, `.alreadySignedOut` (401 on either call, or 404 on DELETE), `.sharedPairing` (current row is primary — no DELETE), `.unknownDevice` (no `current` row — old box — no DELETE), `.unreachable(String)` (transport / 5xx / 429)) → `.deletingLocal` |
| `.deletingLocal` | remote step finished (whatever its result) | same spinner | `KeychainCredentialStore.shared.delete()` succeeds → `.warning(msg)` if `BoxRemoval.message(remote)` is non-nil, else `.leaving`; throws → `.localDeleteFailed(remote, error)` |
| `.localDeleteFailed` | Keychain delete threw (`KeychainCredentialStore.swift:66-70`) | alert "Couldn't remove this box from this phone" / "The box sign-in is still saved on this phone (<error>). Nothing else changed on this phone." buttons "Try again" (→ `.deletingLocal`, **re-runs only the local delete; never repeats the remote revoke**) and "Cancel" (→ `.idle`; the app stays paired — if the remote revoke already happened, the next request 401s and the existing sign-in-again handling applies) | |
| `.warning(msg)` | local delete succeeded and the remote step did not revoke | alert with `msg`, single "OK" | OK → `.leaving` |
| `.leaving` | — | — | post `Notification.Name.mantaBoxRemoved` (declared in `BoxDevicesModels.swift`); `MantaAppRoot` returns to onboarding (mount **M-10-2**). Terminal. |

Ordering guarantee: the root transition happens **only** after the Keychain
delete succeeded **and** any warning was acknowledged — so a relaunch never
resurrects a "removed" pairing, and the warning is never lost.

Warning texts (`BoxRemoval.message(remote)`; `.revoked` and
`.alreadySignedOut` → nil):
- `.unreachable` / `.unknownDevice`: "Removed from this phone. The box couldn't confirm it signed this phone out, so it may still list it — revoke it from Linked devices on another device."
- `.sharedPairing`: "Removed from this phone. This phone shared the desktop's pairing, so the box keeps it — remove it from the desktop if you want it revoked."

The push limitation (D9 below) is stated, not hidden:
the phone does NOT promise that notifications from this box stop. The confirm
dialog's message gets a second paragraph: "Notifications this box already
sends to this phone may keep arriving. To stop them now, turn off
notifications for Manta in iOS Settings." No `unregisterForRemoteNotifications`
call is made (it does not stop the box's sends — see D9 — and would interfere
with the next pairing's registration).

**Wire.**
- `GET /auth/devices` → `{box_id, devices: [{device_id, name, last_seen (epoch ms), created_at (epoch ms), primary: Bool, current: Bool /*NEW*/}]}` (`index.mjs:4130`). 401 → token already dead → treat as "already signed out", proceed locally.
- `DELETE /auth/revoke?device_id=<id>` (Bearer) → 200 `{ok: true, box_id, device_id, reset: false}`; 404 `{error:"device not found"}`; 401; 429 (rate limited, `/auth/*` limiter) (`index.mjs:3955`). **Never** call it without `device_id` from iOS.

**Pure** (`BoxDevicesModels.swift`): `BoxRemoval.plan(devices:) -> .revoke(deviceID) | .sharedPairing | .unknownDevice`,
`BoxRemoval.classify(status:Int?, transportError:Bool) -> RemoteRevokeResult`,
`BoxRemoval.message(_ remote: RemoteRevokeResult) -> String?`,
`BoxRemovalFlow.reduce(state, event) -> state` (events: `remove`, `cancel`,
`remoteFinished(RemoteRevokeResult)`, `localDeleted`, `localDeleteFailed(String)`,
`retryLocal`, `acknowledge`).

### F16. Restart opencode

**Desktop today.** The single restart affordance is the banner shown when a
model/endpoint/registry change sets `opencodeRestartNeeded`
(`Settings.tsx:932-955, 1505-1520`): "Restart opencode" / "Restarting…",
"Later"; failure "Restart failed: <error>". AGENTS.md: restart is reserved for
explicit user action because it drops every in-flight turn.

**Wire.** `opencode:restart` (no args) → `{ok: true}` or `{ok: false, error}`
(`opencodeAdmin.mjs:113`, `rpc.mjs:1887`).

**iOS design.** Anchor `restartOpencodeMobile` renders inline as a button row
"Restart opencode" (Box section). Tap → confirmation dialog "Restart opencode?"
/ "This ends every agent turn currently running in any session." / "Restart".
In flight: row shows spinner "Restarting…", disabled. Result: inline status
under the row — "opencode restarted." (ok tone) or "Restart failed: <error>"
(danger). The same action (shared `SettingsOpencodeRestart` helper) backs the
registries banner (F10).

Client member: `opencodeRestart() async throws -> OkResult` is **owned by
WS10** (D16) and **consumed by WS08** (`08-accounts.md:534,988,1026`; WS08
dropped its own `providerRestartOpencode()`). Order (D20): WS10 in A1, WS08 in A2. The
signature and `OkResult { ok: Bool; error: String? }` are frozen by this spec.

### F17. Linked devices + revoke

**Desktop today.** No UI (the route exists for "the desktop (Stage 5) and any
paired device", `index.mjs:4125`). DECISIONS §6.3: "A linked-device list with
last-seen and one-tap revoke".

**Wire.** As F15 (`GET /auth/devices`, `DELETE /auth/revoke?device_id=`).

**iOS design.** Anchor `linkedDevicesMobile` → `BoxDevicesScreen.swift`.
List sorted: this phone first, then by `last_seen` desc. Row: name, badges
"This phone" (current) / "Main pairing" (primary), secondary "Last active
<relative>" (`RelativeDateTimeFormatter`, "just now" under 60 s) · "Linked
<date>". Swipe action + context menu "Revoke" on rows that are neither current
nor primary → confirmation "Revoke <name>?" / "It's signed out right away and
needs a new pairing code to come back. It may still receive notifications from
this box until notifications are turned off on that device." → `DELETE`.
(Revocation removes the device's bearer only; APNs tokens are stored without a
device association and every stored token receives every push —
`push.mjs:96-130,769-798` — see D9.) Success: row removed +
"Revoked <name>." footer; 404: refetch + "That device was already removed.";
other failure: "Couldn't revoke <name>. <error>". Current row: no revoke, footer
hint "To sign this phone out, use Remove server." Primary row: no revoke, hint
"The main pairing is shared with your desktop — manage it from the desktop."
Pull-to-refresh. Error state "Couldn't load linked devices. <error>" + "Try
again". Old box without `current`: no "This phone" badge, and revoke is still
offered on non-primary rows (the user can tell by name).

**Pure:** `BoxDevicesModels.sorted(_:)`, `.canRevoke(_:)`,
`.lastActiveText(lastSeen:now:)`, decoding of the response (tolerates a missing
`current`).

### F18. Software updates (check / apply), incl. the "running turns end" confirm

**Desktop today.** General → About (`Settings.tsx:1035-1074`, logic
`:577-683`): "Check for updates" / "Checking…", "Checked <time>", one row per
target (dot · label · `current → latest` · action) via `describeUpdateTarget`
(`chatUtils.ts:1357`: `!ok → "Couldn't check"`, `manual → "Update manually"`,
`available → "Update"`, else "Up to date"). Server row → App.tsx confirm
"Update Manta Server?" / "This restarts opencode, which will end every agent
turn currently running in any session. Any unsaved work in a running turn is
lost." / "Update & restart" (`App.tsx:2328-2339`) → `applyServerUpdate`
(`App.tsx:1727`): `{ok:false}` → error; a transport drop is the SUCCESS path
(`isTransientUpdateNetworkError`, `chatUtils.ts:1384`); completion = version
changed after reconnect (`boxUpgradeLanded`, `chatUtils.ts:1431`); safety cap
`BOX_UPGRADE_MAX_MS = 600_000` (`App.tsx:80`). CLI rows → `server:cli-update`
without a confirm (`App.tsx` `runCliUpdate`), then re-check.

**Wire.**
- `server:update-check` (no args) → `{available: Bool, version?: String, notesUrl?: String|null, ok?: Bool, targets?: [UpdateTarget]}`;
  `UpdateTarget = {id, label, current, latest, available, ok, manual, manualUrl?, disruption}` (`types.ts:990-1028`, `rpc.mjs:1915`). Running it also raises the box's normal update push (deduped) — expected.
- `server:update-apply` (no args) → `{ok: Bool, error?: String}`; may never answer (the box restarts) (`rpc.mjs:1903`).
- `server:cli-update` args `[{"cliId": "<id>"}]` → `{ok, before?, after?, changed?, error?}`, never throws (`rpc.mjs:1937`).
- `server:version` (F13) for the landed check.

**Status-preserving transport for the apply call (fixes the lost-status
problem).** `MantaAPIClient`'s private RPC transport keeps only 401 and the
503-upgrade signal and then JSON-parses the body (`MantaAPIClient.swift:923-937,
984-1000`), so an HTML 502 from Caddy/Cloudflare during the box restart becomes
a decode error, indistinguishable from a real failure. WS10 therefore does NOT
use `call` for `server:update-apply`; `BoxRESTClient.rpcRaw(channel:args:)`
(WS10 file, see Client members) POSTs `/rpc/server:update-apply` with body
`{"args": []}` and the bearer, 30 s timeout, and returns
`RawRPCResponse { status: Int?, body: Data, transportError: URLError? }`
(declared in the Foundation-only `SettingsUpdatesModels.swift`, NOT in
`BoxRESTClient.swift`, so the [pkg] classifier never depends on the app-only
HTTP client)
without interpreting it. No edit to `MantaAPIClient.swift` is needed (so no
C1 foundation mount).

`UpdateApplyClassifier.classify(_ r: RawRPCResponse) -> ApplyOutcome`
(pure, `SettingsUpdatesModels.swift`), the port of
`isTransientUpdateNetworkError` (`chatUtils.ts:1384-1410`) plus the RPC envelope
(`rpc.mjs:2700-2712`: 200 `{result}` / 500 `{error}`):

| input | outcome |
|---|---|
| `transportError` code ∈ {`.networkConnectionLost`, `.cannotConnectToHost`, `.timedOut`, `.notConnectedToInternet`, `.cannotFindHost`, `.dnsLookupFailed`, `.cancelled`} | `.restartLikely` |
| any other `transportError` | `.failed(localizedDescription)` |
| status 401 | `.authRequired` |
| status 503 and `UpgradeStatus.isUpgradeRefusal(statusCode: 503, body: body)` (`UpgradeModels.swift:381-391`) | `.upgrading` |
| status ∈ {502, 503, 504, 521, 522, 524} (any body: HTML, text, JSON) | `.restartLikely` |
| status 200, body `{"result": {"ok": true}}` | `.started` |
| status 200, body `{"result": {"ok": false, "error": E}}` | `.failed(E ?? "Server update failed")` — includes `self-update: …` messages, never transient |
| status 200, `result` missing/null or body not JSON | `.failed("The box sent an answer this app couldn't read.")` |
| any other status with JSON `{"error": E}` | `.failed(E)` (e.g. ordinary 500 — box is up, genuine failure) |
| any other status, non-JSON body | `.failed("HTTP <status>")` |

`.restartLikely` and `.started` both enter the restarting wait; only a version
change after reconnect ends it as success (`UpdateTargets.landed`), else the
600 s cap.

**iOS design.** Anchor `updatesMobile` → `SettingsUpdatesScreen.swift`, state in
`SettingsUpdatesStore.swift` (`@MainActor final class`, created by the screen).
- Top: "This app" `<CFBundleShortVersionString>` (informational — App Store /
  TestFlight updates the app itself) and "Manta Server v<x>".
- "Check for updates" button (spinner "Checking…", 15 s timeout → row error
  "Couldn't check"), then "Checked <time>". Auto-runs once on appear.
- Rows: **server** then opencode then other CLIs by label (Swift port of
  `buildUpdateTargets` with the desktop row removed). Tones as desktop. Manual
  rows with `manualUrl` show "Update manually ↗" (opens Safari via
  `openURL`); manual rows without one show "Update manually" muted text.
- Server "Update" → `confirmationDialog` with the desktop title/body/button.
  Then: row spinner "Updating…"; while the event stream is not connected the
  row reads "Restarting the box…". On reconnect (`eventStore.connectionState`
  → connected) call `server:version`; if it differs from the version captured
  at start → row "Updated to v<new>" (ok) and re-run the check. The apply
  call's outcome is classified by `UpdateApplyClassifier` (below):
  `.started` / `.restartLikely` → keep waiting; `.failed(msg)` → row error
  "<msg>" + Update re-enabled; `.authRequired` → row error "Sign in again —
  this phone's pairing was revoked."; `.upgrading` → row error "The box is
  upgrading right now." (the upgrade overlay takes over via the existing
  `.mantaBoxUpgrading` notification).
  600 s cap → "Couldn't confirm the update finished. Check again." and the row
  re-enables. Only one update in flight; every other Update button disabled.
- CLI "Update" → no confirm (parity), row spinner, `{ok:false}` → row error,
  success → re-run the check before clearing the spinner.
- Leaving the screen mid-update drops the in-flight presentation; the next
  check shows the truth (documented, acceptable).

**Pure** (`SettingsUpdatesModels.swift`): `UpdateTargets.build(check:serverVersion:)`,
`UpdateTargets.describe(_:) -> (tone, text)`, `UpdateTargets.hasUpdate(_:)`,
`UpdateTargets.landed(from:current:)`, `UpdateApplyClassifier.classify(_:)`
(table above), `UpdateFlow` reducer (idle → confirming → applying →
restarting → done/failed/timedOut) driven by events (`applyOutcome(ApplyOutcome)`,
`connection(Bool)`, `version(String)`, `tick(now)`).

### F19. Upgrade screen actions: Retry / Check again, Roll back, Copy details

**Desktop today.** `UpgradeGate.tsx` failed state: Retry (label "Check again"
when the failed step is `preflight` or `verify`), disabled with "This failure
can't be retried — roll back instead." when `error.retryable == false`; "Roll
back" (hidden for `preflight`/`verify`) behind confirm "Roll the box back?" /
"The box returns to the previous version with your original history, which the
upgrade did not change. Conversations started since the upgrade will not appear
in the previous version. You will then need to reinstall the previous desktop
version." / "Roll back"; outcome lines "Retry requested" / "Checking again…" /
"Roll-back requested" or the error; "Nothing was changed — your box is exactly
as it was." for preflight; "Copy details" → "Copied to the clipboard" (running,
failed, rolled_back). Logic `upgradeGateLogic.ts:150-400` (`gateReducer` resets
outcomes when the state changes; `describeGateDetails`).

**iOS today.** `UpgradeScreen.swift` is deliberately read-only with hint "Open
Manta on your computer to retry or roll back." (`UpgradeModels.swift`
`UpgradeScreenModel.make`). `UpgradeStore` never calls retry/rollback.

**Wire.** `POST /api/upgrade/retry` and `POST /api/upgrade/rollback` (Bearer,
no body) → HTTP 200 `{ok: true}` or `{ok: false, error}` (`upgradeV2.mjs:1031`);
exempt from the 503 upgrade gate. Desktop client: `httpApi.ts:763`
(`upgradeAction`, 15 s timeout, non-2xx → `HTTP <status>`).

**iOS design.**
- `UpgradeGateState` gains `retry: UpgradeActionOutcome` and
  `rollback: UpgradeActionOutcome` (`.idle | .pending | .ok | .error(String)`);
  `apply(status:)` resets both to `.idle` when `status.state` changes (mirror of
  `gateReducer`).
- `UpgradeScreenModel` gains `failedStep: String?`, `retryLabel`, `canRetry`,
  `retryDisabledReason`, `canRollback`, `nothingChanged: Bool` (preflight),
  `retry`, `rollback`, `details: String` (port of `describeGateDetails`);
  `hint` becomes nil for `.failed`.
- `UpgradeStore` gains `func retry() async` / `func rollback() async` (set
  pending → call → ok/error → `await read()`), with an injected
  `act: @Sendable (UpgradeAction) async -> UpgradeActionResult` defaulting to
  `BoxRESTClient.upgradeAction`.
- `UpgradeScreen` reads `@EnvironmentObject var upgradeStore: UpgradeStore`
  (already in the environment of the `MantaAppRoot` overlay — no signature
  change, no mount) and renders, on `.failed`: primary button (label / spinner
  "Retrying…"/"Checking…" / disabled + reason), destructive "Roll back" behind a
  `confirmationDialog` with the desktop copy, outcome lines, and "Copy details"
  (`UIPasteboard.general.string`, then "Copied to the clipboard"). On
  `.running` and `.rolledBack`: "Copy details" only. Buttons disabled while
  either action is pending.
- 401 → outcome `.error("Sign in again — this phone's pairing was revoked.")`.

### F20. "Link this phone?" confirm after a QR scan or pairing link

**Background.** DECISIONS §5.2.2/§5.3 require a confirm screen; §6.3's
four-character code was **retired** (BET-700, `pairPayload.ts:17`; the server
ignores `verify`, `auth.mjs:494`). Today a scanned/linked payload claims
immediately (`MantaOnboardingFlow.receive`, `MantaOnboarding.swift:90`;
comment at `:381` "no confirmation step").

**iOS design** (`MantaOnboarding.swift`, owned):
- New phase `Phase.confirm` holding the staged payload. `receive(payload:)` →
  if `isSwitching` (the paired "Switch server?" sheet already confirmed,
  `MantaAppRoot.beginSwitch`) go straight to linking as today; otherwise stage
  and set `.confirm`. While in `.confirm`/`.linking`, further `receive` calls
  are ignored (the camera delivers the same payload every frame).
- `MantaLinkConfirmView`: heading "Link this phone?"; sub "It'll be able to run
  commands on the machine below."; card: status dot, "Your box", host in mono
  (from `MantaPairing.claimBaseURL`), divider, "Server ID starts with
  `<first 8 hex>`" + "Check it matches Add a phone on your desktop." (omitted
  when the payload has no box id); primary "Link this phone" →
  `confirmLink()` → linking; text link "This isn't my box" → phase
  `.notMine`.
- `.notMine` (§5.4 "Codes don't match", adapted — no codes now): heading "Don't
  link this"; sub "If you didn't just open Add a phone on your own computer,
  this code didn't come from you."; danger card "Someone may have sent you a
  code that links your phone to their machine — or theirs to yours. Only ever
  scan a code you can see on your own screen."; buttons "Cancel" (clears the
  payload → entry) and "Let me look again" (→ `.confirm`).
- Manual entry (user typed the code) skips the confirm.

**Pure:** `MantaPairing.confirmSummary(_ payload) -> (host: String, idPrefix: String?)`.

### F21. Remove the 32-hex Box ID manual field

**Today.** Manual Setup shows "Box ID (32 hex)" + six-digit code + a hidden
"My server isn't reachable from the internet" URL field
(`MantaOnboarding.swift:409-445`); `manualContinue` requires a valid Box ID or
URL.

**Constraint.** A six-digit code alone cannot address a box: `/auth/claim`
lives on each box's own host and no code→box resolver exists (gateway has no
such route — `src/gateway/index.mjs`). Accepted deferral D8 (master): manual
pairing becomes one "Server address" field + code.

**iOS design.** Replace the Box ID field and the hidden URL field with ONE
always-visible field **"Server address"** (placeholder "Server ID or address"),
help "On your desktop: Settings → Box → Add a phone shows the Server ID. On
another phone: Settings → Box → Add a device shows the server address. Or run
`manta pair` on the box." Prefilled on re-pair from the loaded credentials' `serverUrl` (`try? KeychainCredentialStore.shared.load()?.serverUrl`, as `MantaOnboarding.swift:79-84` already does)
(today it prefills `boxId`). Order: six-digit code first, then Server address,
then "Continue" (enabled only when the code is six digits AND
`resolveManualTarget` returns `.ok`). Errors are shown under the field from the
`.invalid(reason)` result (texts below). `MantaOnboardingFlow.boxId` and
`showAdvanced` are removed; `serverURL` stays.

**Pure:** `MantaPairing.resolveManualTarget(_ raw: String) -> ManualTargetResult`
where `enum ManualTargetResult: Equatable { case ok(serverUrl: String, boxId: String); case invalid(String) }`.
Rules, in order:
1. Trim surrounding whitespace. Empty → `.invalid("Enter your server address — the Server ID or address shown under Add a phone.")`.
2. Any remaining whitespace → `.invalid("A server address can't contain spaces.")`.
3. Exactly 32 hex chars (any case) → lowercase → `.ok("https://<id>.boxes.mantaui.com", boxId: id)`.
4. No `://` present → prepend `https://`.
5. Parse with `URLComponents`; failure → `.invalid("That isn't a valid server address.")`.
6. Scheme (lowercased) must be `https` or `http`, else `.invalid("Use an https:// address.")`.
7. `user`/`password` present, or `query` / `fragment` non-nil → `.invalid("That isn't a valid server address.")`.
8. Host: lowercased, non-empty, only `[a-z0-9.-]`, no leading/trailing `.`, no
   empty label (`..`). (Bracketed IPv6 is not accepted — not used by boxes.)
   Else `.invalid("That isn't a valid server address.")`.
9. Port: absent, or 1…65535; else `.invalid("The port must be between 1 and 65535.")`.
10. `http` is allowed only when `MantaPairing.isPrivateServerURL` is true for the
    result (loopback / RFC1918 / 100.64/10 / `.ts.net`), preserving explicit
    HTTP for private listeners; a public `http` host →
    `.invalid("Use https:// for an address reachable from the internet.")`.
11. Path kept, trailing `/` stripped (reverse-proxy sub-paths keep working as
    they do today).
12. Output `serverUrl` = `<scheme>://<host>[:<port>]<path>`; `boxId` = the first
    label when host matches `^[0-9a-f]{32}\.boxes\.mantaui\.com$`, else `""`
    (as today's disclosure path).

Exact test table (T10):

| input | result |
|---|---|
| `""`, `"   "` | invalid (empty) |
| `"0123ABCD0123abcd0123abcd0123abcd"` | ok `https://0123abcd0123abcd0123abcd0123abcd.boxes.mantaui.com`, box `0123abcd0123abcd0123abcd0123abcd` |
| `"0123abcd0123abcd0123abcd0123abcd.boxes.mantaui.com"` | ok same URL, same box |
| `"100.64.0.9:8787"` | ok `https://100.64.0.9:8787`, box `""` |
| `"http://100.64.0.9:8787/"` | ok `http://100.64.0.9:8787`, box `""` |
| `"http://box.tail1234.ts.net:8787"` | ok `http://box.tail1234.ts.net:8787` |
| `"https://Box.Example.com/manta/"` | ok `https://box.example.com/manta` |
| `"http://example.com"` | invalid (public http) |
| `"ftp://example.com"` | invalid (scheme) |
| `"https://user:pw@example.com"` | invalid |
| `"https://example.com?x=1"`, `"https://example.com#f"` | invalid |
| `"https://"`, `"https://.example.com"`, `"https://a..b"` | invalid (host) |
| `"https://example.com:0"`, `"https://example.com:70000"` | invalid (rule 5 or 9 — test asserts `.invalid`, not the text) |
| `"my box"` | invalid (spaces) |
| `"https://exa_mple.com"` | invalid (host chars) |

### F22. Notification-denied reminder in Settings

**DECISIONS §5.6:** denying notifications must not gate anything; "the only
difference is a quiet, dismissible reminder in Settings."

**iOS design.** `SettingsNotificationReminder.swift`, shown at the very top of
Settings when `UNUserNotificationCenter.current().notificationSettings()`
reports `.denied` (or `.notDetermined`) and the user has not dismissed it.
Card: "Notifications are off" / "You won't hear when an agent needs permission,
asks a question, or finishes." Button: `.denied` → "Turn on in Settings" (opens
`UIApplication.openNotificationSettingsURLString`); `.notDetermined` → "Turn on
notifications" (calls `requestAuthorization([.alert,.sound,.badge])`, then
`MantaPushService.applyRegistrationState()`). Trailing × dismisses; dismissal
stored in UserDefaults `manta.settings.notifReminderDismissed` and cleared
automatically if the status later becomes authorized (so a future denial shows
it again). Re-evaluated on appear and on `scenePhase == .active` (returning from
iOS Settings). No reminder for `.authorized/.provisional/.ephemeral`.

**Pure** (`SettingsNotificationModels.swift`, Foundation-only):
`NotificationReminder.shouldShow(status:dismissed:) -> Bool`,
`NotificationReminder.action(status:) -> .openSettings | .request | nil`,
`NotificationReminder.dismissalAfter(status:dismissed:) -> Bool` (clears on
authorized). Status is a local `enum ReminderAuthStatus` so tests need no
UserNotifications.

---

## Server change (S1) — `current` flag on `GET /auth/devices`

Needed so the phone can revoke **itself** (F15) and label "This phone" (F17)
without the whole-box reset. Additive; never exposes tokens.

- `src/server/devices.mjs` `listDevices(currentToken = null)`: each row gains
  `current: typeof currentToken === "string" && currentToken !== "" && tokenMatches(d.token, currentToken)`.
- `src/server/auth.mjs` `listDevices({ currentToken } = {})` passes it through.
- `src/server/index.mjs:4131`: `authEngine.listDevices({ currentToken: parseBearer(req.headers["authorization"]) })`.
- Response: `{box_id, devices: [{device_id, name, last_seen, created_at, primary, current}]}`. Auth gate unchanged (route stays authenticated). With `MANTA_AUTH_DISABLED=1` every row is `current: false`.
- Node tests: `devices.test.mjs` — current true only for the matching live token,
  false for revoked/other/absent token, no `token` field in any row;
  `auth.test.mjs` — engine passes the token through.

Wave note: accepted by master D7 (wave A1: WS10 edits `devices.mjs`, `auth.mjs`,
`index.mjs`; WS08's wave-A server edit is `ptyWs.mjs` only, so no conflict).

No other server change. Every other feature uses existing channels/routes.

---

## Client members (C1 / D16)

All new `MantaAPIClient` members live in `MantaUI/MantaAPIClient+Settings.swift`
(uses only the `internal` `call`/`callRequired`/`callVoid`/`jsonAny`/`jsonObject`,
`MantaAPIClient.swift:944-977`); wire types in `SettingsWireModels.swift`
(Foundation-only, `Decodable, Equatable, Sendable`). Owned by WS10 — no other
spec declares these names:

| member (signature) | channel | args |
|---|---|---|
| `func serverVersion() async throws -> ServerVersionInfo` — `{version: String, minClient: String?, opencodeVersion: String?}` | `server:version` | `[]` |
| `func serverUpdateCheck() async throws -> ServerUpdateCheck` — `{available: Bool, version: String?, notesUrl: String?, ok: Bool?, targets: [UpdateTarget]?}`; `UpdateTarget {id, label, current: String?, latest: String?, available, ok, manual, manualUrl: String?, disruption: String}` | `server:update-check` | `[]` |
| `func serverCliUpdate(cliID: String) async throws -> CliUpdateResult` — `{ok, before?, after?, changed?, error?}` | `server:cli-update` | `[["cliId": cliID]]` |
| `func restorePreview() async throws -> TopologyRestorePreview` | `tmux:restore-preview` | `[]` |
| `func restoreTopology() async throws -> TopologyRestoreResult` | `tmux:restore-topology` | `[]` |
| `func authPair() async throws -> AuthPairResult` — `{ok, pairingCode?, boxId?, expiresAt?, error?}` | `auth:pair` | `[]` |
| `func opencodeRestart() async throws -> OkResult` — `{ok: Bool, error: String?}` (**also consumed by WS08**) | `opencode:restart` | `[]` |
| `func pluginsRegistry() async throws -> [PluginRegistryRow]` (`inputs[].default` as `JSONValue?`) | `plugins:registry` | `[]` |
| `func forgeStatus(validate: Bool) async throws -> ForgeConnectionStatus` (**also consumed by WS05**, D16) | `forge:status` | `[["validate": validate]]` |
| `func forgeRulesList() async throws -> [ForgeRuleRow]` | `forge:rules-list` | `[]` |
| `func forgeDisconnect() async throws -> OkResult` | `forge:disconnect` | `[]` |
| `func opencodeSetReferences(upsert: [[String: String]]) async throws -> OkResult` | `opencode:set-references` | `[["upsert": upsert]]` |
| `func launchersList() async throws -> [AvailableLauncher]` (**also consumed by WS04**, D21; types + `ExtensionsLaunchers.resolve` in F12) | `launchers:list` | `[]` |

`server:update-apply` is deliberately **not** a `MantaAPIClient` member — it
goes through `BoxRESTClient.rpcRaw` (F18) to keep the HTTP status.

**Consumed, owned elsewhere (not redeclared):**
`configGet()` / `configUpdate(_:)` (existing, `MantaAPIClient.swift:752-760`);
`references() -> [OpencodeReferenceInfo]` (WS03, F11);
`SessionListStore.loadConfig()` / `refresh()` (existing/WS04).

**Non-`MantaAPIClient` HTTP helper** — `BoxRESTClient.swift` (WS10; `struct`,
`Sendable`; base URL + bearer from `KeychainCredentialStore.shared`;
`URLSession` injectable, default `.shared`; posts `.mantaBoxUpgrading` on a 503
upgrade refusal exactly like the RPC transport):
- `func devices() async throws -> BoxDevicesResponse` — `GET /auth/devices`, 15 s; 401 → `MantaError.authRequired`.
- `func revokeDevice(id: String) async -> (status: Int?, transportError: Bool)` — `DELETE /auth/revoke?device_id=<id>`, 15 s; classified by `BoxRemoval.classify`.
- `func upgradeAction(_ action: UpgradeAction) async -> UpgradeActionResult` — `POST /api/upgrade/{retry|rollback}`, 15 s; 200 JSON `{ok, error?}`; non-2xx → `{ok:false, error:"HTTP <status>"}`; 401 → `{ok:false, error:"Sign in again — this phone's pairing was revoked."}`; transport → `{ok:false, error: localizedDescription}`. (`UpgradeAction` = `.retry | .rollback`, `UpgradeActionResult {ok, error?}` declared in `UpgradeModels.swift`.)
- `func rpcRaw(channel: String, args: [Any], timeout: TimeInterval) async -> RawRPCResponse` — status-preserving `/rpc` POST used only for `server:update-apply`.

---

## Tests (C7)

Swift (XCTest, `MantaUITests/`). Files marked **[pkg]** contain only
Foundation-only logic and must also run under `mobile/native/verify.sh` (D19)
— see the Package manifest under Files.

- **T1 `MantaSettingsTests.swift` (edit):** replace `serverUrlMobile` cases with
  `themeMobile` (device-local default "system", modified on "dark");
  `resetAllValues`/`sectionResetValues` exclude `.custom` entries (assert count
  == non-custom entries; `boxStatusMobile` absent); `hapticsEnabled` default
  `true`, configKey `hapticsEnabled`; `worktreePerSession` present (both);
  `SettingsSchema.sections` contains `general` and `extensions`; search
  "linked" finds `linkedDevicesMobile`.
  **Commit path (§0.2)** with an injected `SettingsConfigurationStore` and an
  isolated `UserDefaults(suiteName:)`:
  failing store → `commit` returns false, `current(worktreePerSession)` is the
  previously confirmed value, `lastError == "Couldn't save Create git worktree
  for new sessions."`, `pending`/`saving` empty; succeeding store → returns
  true, value confirmed, `lastError` nil; a second `commit` for the same entry
  while the first is suspended (gated store) returns false and does not issue a
  second update; while suspended `current` shows the pending value and
  `saving` contains the id; `clearError()` clears; device-local commit never
  touches the store.
  **Mutation guard (§0.2)** with a gated store (each `update` suspends until the
  test releases it): (a) commit A pending → `resetAll()` is a no-op (no second
  update issued, `undoMessage` unchanged); release → A confirmed. (b)
  `resetAll()` pending (`batchWriting == true`) → `commit` returns false without
  an update and `current` is unchanged; release → reset values confirmed,
  `batchWriting == false`. (c) reset pending → `undoLastReset()` no-op until
  release, then works. (d) `isMutating` reflects both.
- **T2 `SettingsAppearanceTests.swift` [pkg]:** system/light/dark/garbage/nil →
  `ThemePreference`; `storageKey == "manta.settings.local.themeMobile"`;
  `SettingsDeepLink.target`: `"extensions"` (a non-first section) → `"extensions"`,
  `"general"` → `"general"`, `nil`/`""`/`"secrets"`/`"nope"` → `nil`.
- **T3 `SettingsBoxTests.swift` [pkg]:** `BoxPairing.universalLink` (with/without
  server; output parses back via `MantaPairing.parsePairPayload` to the same
  payload); `qrServerOverride` (nil when equal to the direct URL, nil for public
  custom domain, value for 100.64.x / .ts.net); `manualAddress` (connected
  tailnet URL returned verbatim-normalized; missing → direct URL; trailing `/`
  stripped); `shouldRefresh` inclusive edge; `countdown` ("4:41", low under
  60 s, expired); `parseExpiresAt` with/without fractional seconds;
  `BoxDevicesModels` sort, `canRevoke` (current/primary → false),
  `lastActiveText`, decode with and without `current`;
  `BoxRemoval.plan` (current non-primary → revoke; current primary →
  sharedPairing; none → unknownDevice); `BoxRemoval.classify` (200 → revoked,
  401/404 → alreadySignedOut, 429/5xx/transport → unreachable); `message`
  for each; **`BoxRemovalFlow.reduce`**: remove → revoking; remoteFinished →
  deletingLocal; localDeleteFailed → localDeleteFailed; retryLocal →
  deletingLocal **without** a new revoking state (remote not repeated);
  localDeleted with `.unreachable` → warning; acknowledge → leaving;
  localDeleted with `.revoked` → leaving directly; remote 401 → no warning;
  `.sharedPairing` (offline/shared) → warning; leaving is unreachable until
  the local delete succeeded.
- **T4 `SettingsExtensionsTests.swift` [pkg]:** `validateAlias` / `classifyTarget`
  mirroring every case in `settingsSchema.test.ts` for
  `validateReferenceAlias`/`classifyReferenceTarget`; `upsertPayload` (path vs
  repository, description omitted when blank); `displayTarget`;
  `ExtensionsRegistries.add` (trim, blank, duplicate) / `remove`;
  `AvailableLauncher` decoding (full payload from `launchers.mjs`; missing
  `flags` → `[]`; missing `type` → "boolean"; missing `default` → false;
  missing `id` → throws); `ExtensionsLaunchers.resolve` (saved wins, default
  fallback, nil saved → all defaults, extra saved keys dropped, empty schema →
  `[:]`); `ExtensionsLaunchers.update` (full resolved map written + the toggled
  key, other launchers untouched, unknown launcher → prev unchanged);
  `ExtensionsLaunchers.savedFlags(from:)` (object of bools, non-object skipped,
  non-bool entries skipped, nil config → `[:]`); `ExtensionsForge.secondary`
  (all source × valid combos, exact strings); `ExtensionsFormat.timeout`.
- **T5 `SettingsUpdatesTests.swift` [pkg]:** `UpdateTargets.build` order (server,
  opencode, rest alphabetical; desktop never present; server `ok:false` when
  `check.ok == false`); `describe` tones; **`UpdateApplyClassifier`**, one case
  per table row: HTML body + 502, text body + 504, Cloudflare 521/522/524 →
  restartLikely; 503 `{"upgrade":true}` → upgrading; `URLError(.networkConnectionLost)`
  / `.timedOut` → restartLikely; `URLError(.badURL)` → failed; ordinary 500
  `{"error":"boom"}` → failed("boom"); 500 non-JSON → failed("HTTP 500");
  200 `{"result":{"ok":true}}` → started; 200 `{"result":{"ok":false,"error":"self-update: manifest fetch failed"}}`
  → failed (not transient); 200 malformed / `{"result":null}` → failed(unreadable);
  401 → authRequired. `UpdateFlow` reducer: failed outcome → failed;
  restartLikely → restarting; reconnect + same version → still restarting;
  new version → done; tick past 600 s → timedOut; only one in flight.
- **T6 `SettingsBackupTests.swift` [pkg]:** windows/projects census, every
  status string, `showsRestore`/`restoreEnabled` for loading / loaded(available,
  0 restorable) / loaded(unavailable) / failed; a failed refresh after a loaded
  state yields `.failed` (Restore hidden).
- **T7 `UpgradeModelsTests.swift` [pkg] (edit):** retryLabel/canRetry/canRollback
  per step id; `retryable:false` → disabled + reason; outcomes reset on state
  change; `details` text equals the desktop format for running/failed/rolled_back;
  failed hint nil; `nothingChanged` only for preflight.
- **T8 `UpgradeStoreTests.swift` (edit):** `retry()` pending → ok → re-read;
  error result surfaces message; rollback same; outcome cleared when a frame
  moves failed → running.
- **T9 `MantaOnboardingFlowTests.swift` (edit):** `receive` → `.confirm`
  (not linking); duplicate `receive` while confirming ignored; `confirmLink` →
  linking; `isSwitching` skips confirm; not-mine → cancel clears payload;
  manual continue with code + Server address skips confirm; invalid address
  shows the `.invalid` reason and does not link.
- **T10 `MantaPairingTests.swift` (edit):** `resolveManualTarget` — every row of
  the F21 table; `confirmSummary`.
- **T11 `SettingsNotificationReminderTests.swift` [pkg]:** `shouldShow` /
  `action` / `dismissalAfter` truth table.

Node: `src/server/devices.test.mjs`, `src/server/auth.test.mjs` (S1);
`src/shared/settingsSchema.test.ts` (schema). `npm run typecheck`, `npm test`,
`node scripts/gen-swift-settings.mjs --check` green.

---

## Acceptance (whole workstream)

- [ ] iOS Settings shows General (Theme, Haptics, Software updates, Restore
      windows), Box (status card, Add a device, Linked devices, Restart
      opencode, Remove server), Sessions (incl. both worktree toggles), and
      Extensions (Plugins, GitHub and forge rules, Skill registries, References,
      CLI launch options). The dead "Server URL" field is gone.
- [ ] Every new control either does its action and shows the result, shows an
      actionable error, or is not rendered (no dead controls).
- [ ] Theme override applies app-wide and does not change the desktop.
- [ ] Haptics toggle silences/restores all session-list and turn-complete haptics.
- [ ] Add a device shows a scannable QR that another iPhone's camera opens and
      pairs from; code rotates on expiry while the screen is open; on a
      Tailscale box a second phone pairs via Manual Setup using only the Code
      and Server address shown there.
- [ ] Every config toggle/segment (incl. worktree toggles) is disabled while
      saving and returns to the confirmed value on a failed save, with a
      visible error; Reset / Reset all / Undo are disabled while any save runs,
      and rows are disabled while a reset/undo write runs.
- [ ] `launchersList()`, `AvailableLauncher`, `AvailableLauncherFlag` and
      `ExtensionsLaunchers.resolve/update/savedFlags` exist in WS10 files with
      the pinned signatures before A2 starts; CLI launch options toggles save
      the full resolved map.
- [ ] Opening Settings with `initialSection: "extensions"` lands scrolled to
      Extensions; nil/unknown sections land at the top.
- [ ] Restore windows shows an error + Try again when the preview fails and
      never offers Restore without a successful preview.
- [ ] A box update whose apply call ends in a proxy 5xx / connection drop
      waits for the restart; an ordinary 500 or `{ok:false}` shows the error.
- [ ] Linked devices lists devices with "This phone"; revoking another device
      signs it out (its next request 401s); primary and current rows can't be
      revoked from the list.
- [ ] Remove server revokes only this phone (other devices keep working),
      deletes the Keychain credentials, shows any warning BEFORE leaving, and
      lands on onboarding; a Keychain delete failure keeps the app paired and
      offers "Try again" without re-revoking.
- [ ] The phone never claims that notifications stop after Remove server or
      a revoke (D9 limitation stated in the confirm copy).
- [ ] Restart opencode and server/CLI updates ask before ending running turns
      where the desktop does, and report success/failure.
- [ ] A failed box upgrade can be retried / rolled back / its details copied
      from the phone, with the desktop's labels, confirms and outcome lines.
- [ ] Scanning a pairing QR (or opening a pairing link) shows "Link this phone?"
      before any claim; "This isn't my box" never claims.
- [ ] Manual pairing has no 32-hex Box ID field; code + Server address pairs a
      public box (Server ID or host) and a tailnet box (URL).
- [ ] With notifications denied, Settings shows a dismissible reminder that
      opens iOS Settings; nothing else is gated.
- [ ] `npm run typecheck`, `npm test`, gen `--check`, `mobile/native/verify.sh`
      (D19, [pkg] tests) and `ios-mantaui` `test-unit` green.

---

## Files

**Edit (owned):** `src/shared/settingsSchema.ts`, `src/shared/settingsSchema.test.ts`,
`generated/swift/SettingsSchema.swift` (regenerated only, `npm run gen:swift-settings`),
`mobile/native/MantaUI/SettingsScreen.swift`, `MantaSettingsStore.swift`,
`MantaSettingsModels.swift`, `UpgradeScreen.swift`, `UpgradeStore.swift`,
`UpgradeModels.swift`, `MantaOnboarding.swift`, `MantaPairingModels.swift`;
tests `MantaSettingsTests.swift`, `UpgradeModelsTests.swift`,
`UpgradeStoreTests.swift`, `MantaOnboardingFlowTests.swift`, `MantaPairingTests.swift`.

**Edit (server, S1 — master D7):** `src/server/devices.mjs`, `src/server/auth.mjs`,
`src/server/index.mjs` (one line at `/auth/devices`), `src/server/devices.test.mjs`,
`src/server/auth.test.mjs`.

**Create (`mobile/native/MantaUI/`):**
- Foundation-only (pure; **[pkg]**): `SettingsWireModels.swift`,
  `SettingsAppearance.swift`, `SettingsBackupModels.swift`,
  `SettingsUpdatesModels.swift`, `SettingsNotificationModels.swift`,
  `BoxPairingModels.swift`, `BoxDevicesModels.swift` (incl. `BoxRemoval`,
  `BoxRemovalFlow`, `Notification.Name.mantaBoxRemoved`), `ExtensionsModels.swift`
  (Format/Forge/Registries/References/Launchers helpers).
- App-only: `MantaAPIClient+Settings.swift`, `BoxRESTClient.swift`,
  `SettingsAppearanceView.swift`, `SettingsCustomRows.swift`,
  `SettingsBackupScreen.swift`, `SettingsUpdatesScreen.swift`,
  `SettingsUpdatesStore.swift`, `SettingsOpencodeRestart.swift`,
  `SettingsNotificationReminder.swift`, `BoxStatusCard.swift`,
  `BoxAddDeviceScreen.swift`, `BoxPairingQR.swift`, `BoxDevicesScreen.swift`,
  `BoxRemovalStore.swift`, `ExtensionsPluginsScreen.swift`,
  `ExtensionsForgeScreen.swift`, `ExtensionsRegistriesScreen.swift`,
  `ExtensionsReferencesScreen.swift`, `ExtensionsLaunchersScreen.swift`.
- `MantaLinkConfirmView` / not-mine view live inside `MantaOnboarding.swift`.

**Create (`mobile/native/MantaUITests/`):** `SettingsAppearanceTests.swift`,
`SettingsBoxTests.swift`, `SettingsExtensionsTests.swift`,
`SettingsUpdatesTests.swift`, `SettingsBackupTests.swift`,
`SettingsNotificationReminderTests.swift` (all [pkg]).

**Package manifest (for the integration agent, D18/D19 — WS10 does not edit
`Package.swift` or `project.yml`):**
- add to `MantaUI` target `sources`: `MantaPairingModels.swift` (existing,
  Foundation-only — needed by `BoxPairingModels`), `SettingsWireModels.swift`,
  `SettingsAppearance.swift`, `SettingsBackupModels.swift`,
  `SettingsUpdatesModels.swift`, `SettingsNotificationModels.swift`,
  `BoxPairingModels.swift`, `BoxDevicesModels.swift`, `ExtensionsModels.swift`.
  (`UpgradeModels.swift` and `MantaModels.swift` — needed for `JSONValue` and
  `UpgradeStatus.isUpgradeRefusal` — are already listed; the new action types
  in `UpgradeModels.swift` stay Foundation-only.)
- add to `MantaUITests` `sources`: `SettingsAppearanceTests.swift`,
  `SettingsBoxTests.swift`, `SettingsExtensionsTests.swift`,
  `SettingsUpdatesTests.swift`, `SettingsBackupTests.swift`,
  `SettingsNotificationReminderTests.swift`. (`UpgradeModelsTests.swift`
  already listed.)
- `project.yml`: no change (folder source). `project.pbxproj` is regenerated
  once by the orchestrator (D18); WS10 never edits it.

Verification for the worker: `npm run typecheck`, `npm test`,
`node scripts/gen-swift-settings.mjs --check`; Swift pure logic via
`mobile/native/verify.sh` after applying the manifest locally in its worktree
only for the run (or let the integration agent run it); final gate
`ios-mantaui` `test-unit` (orchestrator).

---

## Mount requests (D18 / D20 / D21 — matches the master's canonical mount ledger)

| ID | Receiving file | Applier | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-10-1 | `MantaAppRoot.swift` (WS04) | WS04, wave A2 (D20/D21) | `SettingsAppearance.storageKey`, `SettingsAppearance.systemValue`, `SettingsAppearance.preference(for:) -> ThemePreference` (`SettingsAppearance.swift`); `ThemePreference.colorScheme: ColorScheme?` (`SettingsAppearanceView.swift`) | Add `@AppStorage(SettingsAppearance.storageKey) private var themePref = SettingsAppearance.systemValue`; on the root `Group`, after the existing `.overlay { … UpgradeScreen … }`: `.preferredColorScheme(SettingsAppearance.preference(for: themePref).colorScheme)` | A1 committed with BOTH `SettingsAppearance.swift` and `SettingsAppearanceView.swift` |
| M-10-2 | `MantaAppRoot.swift` (WS04) | WS04, wave A2 | `Notification.Name.mantaBoxRemoved` (`BoxDevicesModels.swift`); `MantaOnboardingFlow.backToEntry()`, `.isSwitching` (existing, `MantaOnboarding.swift`); consumer-side `SessionListStore.resetForBoxChange()` (existing, WS04) | On the root `Group`: `.onReceive(NotificationCenter.default.publisher(for: .mantaBoxRemoved)) { _ in store.stop(); sessionStore.resetForBoxChange(); flow.isSwitching = false; flow.backToEntry(); paired = false }` | A1 committed with `BoxDevicesModels.swift` |
| M-10-3 | `mobile/native/Package.swift` | Integration agent A, after A2 | WS10 [pkg] manifest (Files → "Package manifest") | Add the listed sources and tests | WS10 (A1) merged |

Not a request: WS04 presenting `SettingsScreen(eventStore:initialSection:)` for
C2 `.settings(section:)` is WS04's own C2 work in its own file
(`04-sessions.md` §11 — WS04's own C2 work).
WS10's side of it is the provider behaviour specified in "C2 deep link" below.

## Mounts applied by this workstream

None — WS10 applies no mount. Mounts INTO WS10-owned files (cross-checked
against 01–09):

| ID | Requested by | Receiving file (WS10) | Applier (D18) | Note |
|---|---|---|---|---|
| M-09-1 | WS09 (`09-models-usage.md` M-09-1) | `SettingsScreen.swift` | Integration agent B, after wave B | Fixed "Models" row directly under `accountsEntry`, `NavigationLink { ModelsScreen() }`, search words per WS09. WS10 keeps `accountsEntry` as the first item of `sectionList` so the insertion point stays obvious. |

No other spec requests a mount in `MantaSettingsStore.swift`,
`MantaSettingsModels.swift`, `UpgradeScreen.swift`, `UpgradeStore.swift`,
`UpgradeModels.swift`, `MantaOnboarding.swift`, `MantaPairingModels.swift` or
the schema (WS07's M-07-3 places its notice beside the `UpgradeScreen` overlay
in `MantaAppRoot`, not inside a WS10 file).

---

## Contracts provided / consumed

- **C1 / D16:** see "Client members". Provided to others: `opencodeRestart()`
  (WS08), `forgeStatus(validate:)` + `ForgeConnectionStatus` (WS05).
  `launchersList()` + `AvailableLauncher` + `AvailableLauncherFlag` +
  `ExtensionsLaunchers.resolve` (WS04, D21). Consumed: WS03 `references()` /
  `OpencodeReferenceInfo` only.
- **C2 deep link (provided to WS04):**
  `SettingsScreen(eventStore: MantaEventStore? = nil, initialSection: String? = nil)`.
  Behaviour (WS10 implements; today's screen has neither the parameter nor any
  scrolling, `SettingsScreen.swift:35-76,156-164`):
  - `sectionList` is wrapped in `ScrollViewReader`; each `sectionView` gets
    `.id("settings-section-\(section.id)")`.
  - Target = `SettingsDeepLink.target(initialSection, available: SettingsSchema.sections.map(\.id))`
    (pure, `SettingsAppearance.swift`, [pkg]): returns the id when it is one of
    the available ids; `nil` for nil, empty or unknown ids (e.g. a desktop-only
    `secrets`/`cto`) → the screen stays at the top.
  - The scroll runs once, after content exists: in `.task` after
    `await store.load()` returns (the list is rendered from the static schema,
    so rows exist; `load()` only fills values), then
    `proxy.scrollTo("settings-section-<id>", anchor: .top)` inside
    `withAnimation(nil)`. A one-shot `@State didApplyInitialSection` stops it
    re-running on later loads. Search mode is off on open, so the section list
    is the visible content.
  - Section ids: `general`, `box`, `accounts`, `models`, `sessions`, `files`,
    `extensions`, `voice` (`SettingsSchema.sections[].id`). WS10 never calls
    `MantaNavigator.open`.
- **C6 (owner):** this spec is the only schema editor; WS04 reads
  `worktreePerSession` / `worktreeCleanOnClose` from box config at action time (F1).
- **C7:** tests as listed; Foundation-only tests also under `verify.sh` (D19).
- **New, provided:** `Notification.Name.mantaBoxRemoved`;
  `SettingsAppearance` / `ThemePreference` (M-10-1);
  `SettingsOpencodeRestart.run(api:) async -> OkResult` (optional reuse; callers
  keep their own confirm copy).
- C3, C4, C5: not used.

---

## Deferred / excluded

All of D1–D3 and the shared-pairing revoke are accepted deferrals (master D8).

- **D1 "Auto-save files the AI sends" (`allowAgentPush`) — excluded.** On desktop
  it means "write each agent-sent file into the Mac's Downloads folder without
  asking". iOS has no Downloads folder and silently writing to the phone's
  Files is not an iOS idiom (saving goes through the share sheet, which WS07's
  agent-file notice already offers). The key is in the SHARED box config, so a
  phone toggle would silently change the desktop's behaviour.
- **D2 Downloads directory — excluded.** A Mac path; meaningless on the phone.
- **D3 opencode port — excluded.** `opencodePort` is read by nothing (grep:
  only `settingsSchema.ts`, `types.ts`, `Settings.tsx`) — a leftover of the
  SSH-tunnel transport. Shipping it on iOS would be a dead control.
- **D4 Plugins on/off toggle and "Open plugins folder" — excluded.** The switch
  lives in the Mac app's local storage (preload bridge, `configKey: null`); the
  box never sees it. The folder is on the Mac.
- **D5 Box-update step progress ("Step n of N") — deferred.** It needs a
  `serverUpdateProgress` subscription and `MantaEventStore`'s raw frame
  handlers cannot be removed, so a per-screen subscription would leak one
  closure per visit. Indeterminate "Updating… / Restarting the box…" ships.
- **D6 Removing a reference — deferred (parity).** Server supports
  `remove: [alias]`; desktop says "Removing a reference isn't available yet".
- **D7 "Download previous version" on the rolled-back screen — excluded** (macOS DMG).
- **D8 Push to existing devices on a new pairing (BET-492)** — server-side,
  already deferred (DECISIONS §6.4a).
- **D9 Stopping notifications on sign-out / revoke — deferred, limitation
  documented in the UI.** Revoking a device removes only its bearer
  (`auth.mjs:592-599`); APNs tokens are stored without any device association
  and every stored token receives every push (`push.mjs:96-130,769-798`), and
  the app re-registers on launch/after pairing (`MantaAppDelegate.swift:155-175`).
  So neither Remove server nor revoking another phone can guarantee
  notifications stop, and calling `unregisterForRemoteNotifications` would not
  fix it (the same device token comes back on the next registration). Reliable
  remote sign-out needs device-associated push tokens and filtering on the box —
  a server change outside D7, so it needs a master amendment. Until then the
  copy states the limitation (F15/F17) and WS10 makes no stop-notifications claim.

---

## Open questions (each has a default)

- **Q1 (for the master owner) Device-associated push tokens (D9).** Amend D7 to
  let a later change associate each APNs token with a device id at
  `push:register-apns` and drop it on revoke (tests: remove A → pair B; revoke
  another phone)? *Default:* not in this effort; the UI states the limitation.
- **Q2 The desktop's own opencode-port field is equally dead.** Out of WS10's
  iOS scope. *Default:* leave desktop unchanged; note for a desktop cleanup.

(Round-0 Q1–Q3 are settled by master D7/D8: S1 accepted, manual pairing = code +
Server address, shared-pairing revoke not offered.)

---

## Review responses (round 1)

| # | Finding | Resolution |
|---|---|---|
| 1 | BLOCKING — `forgeStatus` ownership/validation | Per master D16, WS10 (wave A) owns `forgeStatus(validate: Bool) -> ForgeConnectionStatus` (F9 + Client members); Settings passes `true` (`Settings.tsx:853`), WS05 passes `false` (desktop `ChatPanel.tsx:1055` sends no input). WS05 consumes it and declares no copy. |
| 2 | BLOCKING — worktree toggles not failure-safe | New §0.2: `MantaSettingsStore.commit` becomes awaited and serialized per entry, with `pending`/`saving`; confirmed `values` change only on success; rows disabled while saving; `lastError` is now actually rendered (it never was). F1/F5 use it. T1 adds injected-store tests (failure keeps the confirmed value, success, in-flight second commit refused, pending shown). |
| 3 | BLOCKING — transient update classification / lost HTTP status | `server:update-apply` no longer goes through `MantaAPIClient` (whose private transport discards the status). `BoxRESTClient.rpcRaw` returns status + body + URLError; pure `UpdateApplyClassifier` ports `isTransientUpdateNetworkError` incl. 502/503/504/521/522/524 with any body, excludes structured `self-update:` errors, and treats ordinary 500, malformed 200 and `{ok:false}` as failures. No C1 foundation edit needed. T5 covers each case. |
| 4 | BLOCKING — APNs pruning claim | Removed the claim and the `unregisterForRemoteNotifications` call. New D9 documents the limitation with code evidence; F15/F17 copy states it; Q1 asks the master owner for a D7 amendment (device-associated tokens) rather than promising sign-out. |
| 5 | SHOULD — removal ordering / failures | F15 rewritten as `BoxRemovalFlow` state machine: remote result → Keychain delete → optional warning acknowledgment → root notification. Keychain failure → alert + "Try again" that repeats only the local delete. T3 tests deletion failure, remote 401, shared/offline, warning ordering. |
| 6 | SHOULD — backup preview failure | F7: `BackupPreviewState` with a `.failed` state ("Couldn't load the saved window layout." + Try again); Restore hidden unless a successful preview; a failed refresh discards the old preview. T6 covers initial and refresh failure. |
| 7 | SHOULD — manual fallback on private boxes | F14 shows and copies "Server address" = this phone's normalized connected URL (`BoxPairing.manualAddress`), so a Tailscale box shows its private address. Acceptance case added. |
| 8 | SHOULD — manual address validation | F21 defines 12 explicit rules (whitespace, scheme, userinfo, query/fragment, host charset/labels, port range, http only for private hosts, path kept) returning `.ok/.invalid(reason)`, plus an exact input → output table used verbatim by T10. |
| X6 | Cross-cutting #6 (duplicate client members) | Same as #1. Also: `opencodeRestart()` stays WS10's and is consumed by WS08 (its revision dropped `providerRestartOpencode`); WS10 dropped its own `opencodeReferences()` and consumes WS03 `references()`. (Round-1 text that consumed a WS04 launcher member is superseded by D21 — see round-2 #1: WS10 provides `launchersList()`.) |
| X7 | Cross-cutting #7 (integration ownership) | WS09's mount into `SettingsScreen.swift` is listed under "Mounts applied by this workstream" as applied by integration agent B, not WS10. |
| X10 | Cross-cutting #10 (package/pbxproj) | Removed "regenerate .pbxproj"; WS10 supplies a Package manifest (M-10-3) for the integration agent; pure files are Foundation-only so `verify.sh` runs them (D19). |

---

## Review responses (round2)

| # | Finding | Resolution |
|---|---|---|
| 1 | BLOCKING — launcher provider absent (also cross-cutting #1) | Per D21 WS10 now owns and fully specifies launcher discovery (F12 "Provider"): `AvailableLauncherFlag {key, label, type, default}`, `AvailableLauncher {id, label, flags}` (tolerant decoding), `launchersList() async throws -> [AvailableLauncher]` (`callRequired("launchers:list")`), `ExtensionsLaunchers.resolve(schema:saved:)`, `.update(launchers:launcherID:flagKey:checked:prev:)`, `.savedFlags(from:)`. Added to Client members, Contracts (provided to WS04) and T4 tests. Every WS04-launcher prerequisite/reference removed, incl. the header's A2 prerequisite and review-response X6 (marked superseded). |
| 2 | BLOCKING — M-10-1 vs WS04 receipt (also cross-cutting #6) | WS10 side: M-10-1 row pins `.preferredColorScheme(SettingsAppearance.preference(for: themePref).colorScheme)`, applier WS04 in A2, prerequisite = A1 commit with BOTH `SettingsAppearance.swift` and `SettingsAppearanceView.swift`; same-wave/rebase fallback wording removed. WS04's receiving row (`04-sessions.md:1323`) must be updated by WS04 to this exact call — WS04's contracts list (`:1388`) already names `preference(for:)` + `colorScheme`. |
| 3 | SHOULD — reset/undo vs commit interleaving | §0.2 adds a shared mutation guard (`batchWriting`, `isMutating`): reset/undo are no-ops while any commit saves, commits are refused while a reset/undo write runs, and the screen disables Reset/Reset all/Undo and rows accordingly. T1 adds gated-store interleaving tests (a)–(d). Optimistic reset itself stays deferred. |
| 4 | SHOULD — non-existent members | F18 now cites `UpgradeStatus.isUpgradeRefusal(statusCode: 503, body: body)` (`UpgradeModels.swift:381-391`); F14 uses `KeychainCredentialStore.shared.serverURL?.absoluteString` (`KeychainCredentialStore.swift:21`) and F21's prefill uses the loaded credentials' `serverUrl`. `RawRPCResponse` moved to the Foundation-only `SettingsUpdatesModels.swift` so the [pkg] classifier does not depend on `BoxRESTClient`. |
| 5 | SHOULD — deep-link scrolling + ledger IDs | Contracts "C2 deep link" restores concrete behaviour: `ScrollViewReader`, per-section ids, pure `SettingsDeepLink.target(_:available:)` (nil/unknown → top), one-shot scroll after `load()`; T2 tests a non-first section ("extensions"). Ledger IDs reconciled with the consolidated ledger: M-10-1/M-10-2 (WS04, A2), M-10-3 = Package.swift (integration agent A); WS09's request listed as M-09-1; the Settings presentation is WS04's own C2 work, not a WS10 mount. |
