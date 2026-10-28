# WS10 — Settings, extensions, box, updates, upgrade actions, pairing

Status: draft · Date: 2026-10-28 · Parent: `00-master.md` · Wave: **A**

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
(`SettingsScreen.toggleRow`) and persist through `MantaSettingsStore.commit` →
`config:update`. No new Swift view.

**Contract to WS04 (consumed there):** WS04's create flow pre-selects "own
worktree" from `config["worktreePerSession"] == true`, and its close flow runs
the worktree prompt only when `config["worktreeCleanOnClose"] == true`, reading
the box config at the moment of the action (`MantaAPIClient.configGet()`), not a
cached copy. Until WS04 lands, the toggles are honest on iOS because they
already change desktop behaviour (shared config) — not dead.

**Acceptance**
- Both toggles appear under Sessions on iOS, reflect the box value on open, and
  a change is visible on the desktop's Settings after its next config read.
- A failed save shows the existing `lastError` text; the toggle does not stay
  in a state the box rejected (see §F5 note on `commit`).

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
- New pure type in `SettingsAppearance.swift`:
  ```swift
  enum SettingsAppearance {
    static let storageKey = "manta.settings.local.themeMobile"   // must equal MantaSettingsStore's key for entry "themeMobile"
    static let systemValue = "system"
    static func colorScheme(for stored: String?) -> ColorScheme?  // "light"→.light, "dark"→.dark, anything else→nil (follow system)
  }
  ```
- `SettingsScreen` applies `.preferredColorScheme(SettingsAppearance.colorScheme(for: themePref))`
  on its own `NavigationStack` (via `@AppStorage(SettingsAppearance.storageKey)`)
  so the change is visible the instant the user taps it.
- App-wide application is a **mount request** in `MantaAppRoot.swift` (M1).
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
- The toggle row for `hapticsEnabled` uses `try await store.setBool(entry, v)`
  (the awaiting path, `MantaSettingsStore.swift` `setBool`) instead of
  `commit`; on success it calls `sessionStore.loadConfig()`
  (`@EnvironmentObject SessionListStore` — available inside the full-screen
  cover); on failure it reverts the switch and shows "Couldn't save Haptics."
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
- A failed preview → render no status line (desktop rule: never assert "No
  backup yet" from an error).

**iOS design.** Anchor `backupMobile` → NavigationLink row "Restore windows" →
`SettingsBackupScreen.swift`. Screen: intro copy; status line; primary button
"Restore windows" (disabled + footnote "Every saved window is already open."
when `restorable == 0`; hidden when `available == false`); after restore an
inline result banner with the server `message` (ok tone) or the error (danger
tone), then re-preview and `await sessionStore.refresh()` so the list shows
the restored windows. Loading: `MantaLoader` inline while previewing.

**Pure logic** (`SettingsBackupModels.swift`, `enum BackupSummary`):
`windows(preview) = ops.count + skipped.count`,
`projects(preview) = Set((ops+skipped).map(\.tmuxSession)).count`,
`statusLine(preview, now:)` → the exact strings above.

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
- `forge:status` args `[{"validate": true}]` → `{connected: true, login: String|null, kind: "github", source: "cli"|"env"|"stored"|null, valid: Bool|null}` or `{connected: false}` (`types.ts:622`, `rpc.mjs:952`).
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

**iOS design.** Anchor `referencesMobile` → `ExtensionsReferencesScreen.swift`:
list + a Form section "Add a reference" with the three fields, inline field
errors (desktop strings), "Add" button with spinner; success clears the form,
refetches, shows "Reference added"; failure shows "Couldn't add reference:
<error>". No remove (parity; see Deferred D6).

**Pure (exact ports, with the TS test cases mirrored):**
`ExtensionsReferences.validateAlias(_:) -> String?`,
`ExtensionsReferences.classifyTarget(_:) -> Kind (.path | .repository)`,
`ExtensionsReferences.upsertPayload(alias:target:description:) -> [String: Any]`,
`ExtensionsReferences.displayTarget(_ ref) -> String`.

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

**iOS design.** Anchor `launcherFlagsMobile` → `ExtensionsLaunchersScreen.swift`:
one `Section` per launcher with flags, a `Toggle` per flag. Empty: "No AI CLI
with launch options is installed on your box." Errors as desktop.

**Pure:** `ExtensionsLaunchers.resolve(schema:saved:)`,
`ExtensionsLaunchers.update(launchers:launcherID:flagKey:checked:prev:)` — exact
ports.

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
- Below: "Code" + six digits (monospace, large), "Server ID" + boxId
  (monospace, selectable), countdown pill (`TimelineView(.periodic(every: 1))`),
  "Refresh code" button (spinner "Refreshing…").
- Auto-rotate: when `now >= expiresAt` while visible, mint again (guarded so
  only one mint is in flight).
- Footer: "Prefer to type it? On the other device choose Enter a code and type
  the six digits and this server's address."
- `UIApplication.shared.isIdleTimerDisabled = true` while the screen is up (so
  the code stays on screen while someone scans), restored on disappear.
- Error: "Couldn't create a pairing code. <error>" + "Try again".

**Pure** (`BoxPairingModels.swift`, `enum BoxPairing`):
`universalLink(boxId:code:serverUrl:) -> String` (exact port of
`buildUniversalPairLink`, encoding with `.urlQueryAllowed` minus `&=+/:`— must
round-trip through `MantaPairing.parsePairPayload`),
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

**iOS design — revoke only this phone.**
1. Confirmation dialog "Remove this server?" / "This phone forgets the box and
   signs itself out of it. Your desktop and other devices stay connected. To
   use this box again you'll need a new pairing code." Destructive button
   "Remove".
2. `GET /auth/devices` (with the **new** `current` flag, §S1) → find the row
   with `current == true`.
3. If found and `primary == false` → `DELETE /auth/revoke?device_id=<id>` with
   the phone's bearer.
4. Always (even if 2/3 failed): `UIApplication.shared.unregisterForRemoteNotifications()`
   (the box's push fan-out prunes the dead APNs token on its next send),
   `KeychainCredentialStore.shared.delete()`, `PendingPromptStore` untouched,
   then post `Notification.Name.mantaBoxRemoved` (new, declared in
   `BoxRemoval.swift`) — `MantaAppRoot` returns to onboarding (mount M2).
5. Outcome copy (shown on the onboarding entry screen is not possible, so shown
   BEFORE leaving, as the dialog's follow-up alert only when remote revoke did
   not happen): "Removed from this phone. The box couldn't be reached, so it
   still lists this phone — revoke it from Linked devices on another device."
   (unreachable / 5xx), or "Removed from this phone. This phone shared the
   desktop's pairing, so the box keeps it — remove it from the desktop if you
   want it revoked." (`primary == true`), or the same "couldn't be reached"
   text when no `current` row was returned (old box). Success path: no alert,
   straight to onboarding.

**Wire.**
- `GET /auth/devices` → `{box_id, devices: [{device_id, name, last_seen (epoch ms), created_at (epoch ms), primary: Bool, current: Bool /*NEW*/}]}` (`index.mjs:4130`). 401 → token already dead → treat as "already signed out", proceed locally.
- `DELETE /auth/revoke?device_id=<id>` (Bearer) → 200 `{ok: true, box_id, device_id, reset: false}`; 404 `{error:"device not found"}`; 401; 429 (rate limited, `/auth/*` limiter) (`index.mjs:3955`). **Never** call it without `device_id` from iOS.

**Pure** (`BoxDevicesModels.swift`): `BoxRemoval.plan(devices:) -> .revoke(deviceID) | .localOnlyShared | .localOnlyUnknown`,
`BoxRemoval.message(plan:, remoteResult:) -> String?`.

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
needs a new pairing code to come back." → `DELETE`. Success: row removed +
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
  at start → row "Updated to v<new>" (ok) and re-run the check. `{ok:false,
  error}` → row error "<error>" + Update re-enabled. A thrown
  `MantaError.transport` / `URLError` → treated as the restart (keep waiting).
  600 s cap → "Couldn't confirm the update finished. Check again." and the row
  re-enables. Only one update in flight; every other Update button disabled.
- CLI "Update" → no confirm (parity), row spinner, `{ok:false}` → row error,
  success → re-run the check before clearing the spinner.
- Leaving the screen mid-update drops the in-flight presentation; the next
  check shows the truth (documented, acceptable).

**Pure** (`SettingsUpdatesModels.swift`): `UpdateTargets.build(check:serverVersion:)`,
`UpdateTargets.describe(_:) -> (tone, text)`, `UpdateTargets.hasUpdate(_:)`,
`UpdateTargets.landed(from:current:)`, `UpdateTargets.isTransient(_ error: Error) -> Bool`
(URLError / `MantaError.transport` → true; `MantaError.server` containing
"self-update:" → false), `UpdateFlow` reducer (idle → confirming → applying →
restarting → done/failed/timedOut) driven by events (`applyResult`,
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
such route — `src/gateway/index.mjs`). §5.2.9's "the server resolves it" is
unbuilt (Open question Q1).

**iOS design.** Replace the Box ID field and the hidden URL field with ONE
always-visible field **"Server address"** (placeholder "Server ID or URL from
Add a phone"), help "Find it on your desktop under Settings → Box → Add a phone,
or run `manta pair` on the box." It accepts: a bare 32-hex Server ID, a host
(`<id>.boxes.mantaui.com`, a tailnet name, `100.x.y.z:8787`) or a full
`http(s)://` URL. Prefilled from the Keychain's `serverUrl` on re-pair (today it
prefills `boxId`). Order: six-digit code first, then Server address, then
"Continue". Error: "Enter your server address — the Server ID or URL shown under
Add a phone." `MantaOnboardingFlow.boxId`, `showAdvanced` are removed;
`serverURL` stays.

**Pure:** `MantaPairing.resolveManualTarget(_ raw: String) -> (serverUrl: String, boxId: String)?`:
32-hex → `boxDirectURL`; scheme-less host → `https://` + host (then
`normalizeServerURL`); URL → `normalizeServerURL`; boxId = the first DNS label
when the host is `<32hex>.boxes.mantaui.com`, else "" (as today's disclosure
path). Blank/garbage → nil.

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

**Pure:** `NotificationReminder.shouldShow(status:dismissed:) -> Bool`,
`NotificationReminder.action(status:) -> .openSettings | .request | nil`
(status passed as a small local enum so tests need no UserNotifications).

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

Wave note: this edits `index.mjs`. Per master "Server-file conflicts", WS10 must
serialise behind any other wave-A workstream editing `index.mjs`.

No other server change. Every other feature uses existing channels/routes.

---

## API layer (C1)

`MantaUI/MantaAPIClient+Settings.swift` (new; uses only the `internal`
`call`/`callRequired`/`callVoid`/`jsonAny`/`jsonObject` from C1). Wire types live
next to it in `SettingsWireModels.swift`:

| method | channel | args | returns |
|---|---|---|---|
| `serverVersion()` | `server:version` | `[]` | `ServerVersionInfo {version, minClient?, opencodeVersion?}` |
| `serverUpdateCheck()` | `server:update-check` | `[]` | `ServerUpdateCheck` |
| `serverUpdateApply()` | `server:update-apply` | `[]` | `UpdateApplyResult {ok, error?}` |
| `serverCliUpdate(_ id)` | `server:cli-update` | `[["cliId": id]]` | `CliUpdateResult {ok, before?, after?, changed?, error?}` |
| `restorePreview()` | `tmux:restore-preview` | `[]` | `TopologyRestorePreview` |
| `restoreTopology()` | `tmux:restore-topology` | `[]` | `TopologyRestoreResult` |
| `authPair()` | `auth:pair` | `[]` | `AuthPairResult {ok, pairingCode?, boxId?, expiresAt?, error?}` |
| `opencodeRestart()` | `opencode:restart` | `[]` | `OkResult {ok, error?}` |
| `pluginsRegistry()` | `plugins:registry` | `[]` | `[PluginRegistryRow]` |
| `forgeStatus()` | `forge:status` | `[["validate": true]]` | `ForgeStatus` |
| `forgeRulesList()` | `forge:rules-list` | `[]` | `[ForgeRuleRow]` |
| `forgeDisconnect()` | `forge:disconnect` | `[]` | `OkResult` |
| `opencodeReferences()` | `opencode:references` | `[]` | `[OpencodeReference]` |
| `opencodeSetReferences(upsert:)` | `opencode:set-references` | `[["upsert": [...]]]` | `OkResult` |
| `launchersList()` | `launchers:list` | `[]` | `[AvailableLauncher]` |

Config reads/writes reuse the existing `configGet()` / `configUpdate(_:)`.
`PluginRegistryRow.inputs[].default` decodes as `JSONValue?`.

REST (not `/rpc`) lives in `BoxRESTClient.swift` (new; `struct`, Sendable;
base URL + bearer from `KeychainCredentialStore.shared`, `URLSession.shared`,
15 s timeout; 401 → `MantaError.authRequired`; posts `.mantaBoxUpgrading` on a
503 upgrade refusal like the RPC transport):
`devices() -> BoxDevicesResponse`, `revokeDevice(id:) -> RevokeOutcome
(.ok | .notFound | .unauthorized | .rateLimited | .failed(String))`,
`upgradeAction(_: UpgradeAction) -> UpgradeActionResult {ok, error?}`.

---

## Tests (C7)

Swift (XCTest, `MantaUITests/`):

- **T1 `MantaSettingsTests.swift` (edit):** replace `serverUrlMobile` cases with
  `themeMobile` (device-local default "system", modified on "dark");
  `resetAllValues`/`sectionResetValues` exclude `.custom` entries (assert count
  == non-custom entries; `boxStatusMobile` absent); `hapticsEnabled` default
  `true`, configKey `hapticsEnabled`; `worktreePerSession` present (both);
  `SettingsSchema.sections` contains `general` and `extensions`; search
  "linked" finds `linkedDevicesMobile`.
- **T2 `SettingsAppearanceTests.swift`:** system/light/dark/garbage/nil mapping;
  `storageKey` equals `"manta.settings.local." + "themeMobile"`.
- **T3 `SettingsBoxTests.swift`:** `BoxPairing.universalLink` (with/without
  server; output parses back via `MantaPairing.parsePairPayload` to the same
  payload), `qrServerOverride` (nil when equal to the direct URL, nil for public
  custom domain, value for 100.64.x / .ts.net), `shouldRefresh` inclusive edge,
  `countdown` ("4:41", low under 60 s, expired), `parseExpiresAt` with/without
  fractional seconds; `BoxDevicesModels` sort, `canRevoke` (current/primary →
  false), `lastActiveText`, decode with and without `current`;
  `BoxRemoval.plan` (current non-primary → revoke; current primary →
  localOnlyShared; none → localOnlyUnknown) and messages.
- **T4 `SettingsExtensionsTests.swift`:** `validateAlias` / `classifyTarget`
  mirroring every case in `settingsSchema.test.ts` for
  `validateReferenceAlias`/`classifyReferenceTarget`; `upsertPayload` (path vs
  repository, description omitted when blank); `ExtensionsRegistries.add`
  (trim, blank, duplicate); `ExtensionsLaunchers.resolve/update` (saved wins,
  default fallback, full map written); `ExtensionsForge.secondary` (all source ×
  valid combos, exact strings); `ExtensionsFormat.timeout`.
- **T5 `SettingsUpdatesTests.swift`:** `UpdateTargets.build` order (server,
  opencode, rest alphabetical; desktop never present; `ok:false` server when
  `check.ok == false`); `describe` tones; `isTransient`; `UpdateFlow` reducer:
  applyResult ok:false → failed; transport error → restarting; reconnect +
  same version → still restarting; new version → done; tick past 600 s → timedOut.
- **T6 `SettingsBackupTests.swift`:** windows/projects census and every status string.
- **T7 `UpgradeModelsTests.swift` (edit):** retryLabel/canRetry/canRollback per
  step id; `retryable:false`; outcomes reset on state change; `details` text
  equals the desktop format for running/failed/rolled_back; failed hint nil.
- **T8 `UpgradeStoreTests.swift` (edit):** `retry()` pending → ok → re-read;
  error result surfaces message; outcome cleared when a frame moves
  failed → running.
- **T9 `MantaOnboardingFlowTests.swift` (edit):** `receive` → `.confirm`
  (not linking); duplicate `receive` while confirming ignored; `confirmLink` →
  linking; `isSwitching` skips confirm; not-mine → cancel clears payload;
  manual continue with code + Server address skips confirm.
- **T10 `MantaPairingTests.swift` (edit):** `resolveManualTarget` (32-hex,
  `id.boxes.mantaui.com`, `100.64.0.9:8787`, `https://x/`, blank, garbage);
  `confirmSummary`.
- **T11 `SettingsNotificationReminderTests.swift`:** `shouldShow` / `action`
  truth table.

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
      pairs from; code rotates on expiry while the screen is open.
- [ ] Linked devices lists devices with "This phone"; revoking another device
      signs it out (its next request 401s); primary and current rows can't be
      revoked from the list.
- [ ] Remove server revokes only this phone (other devices keep working),
      deletes the Keychain credentials, and lands on onboarding.
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
- [ ] `npm run typecheck`, `npm test`, gen `--check`, and `ios-mantaui`
      `test-unit` green.

---

## Files

**Edit (owned):** `src/shared/settingsSchema.ts`, `src/shared/settingsSchema.test.ts`,
`generated/swift/SettingsSchema.swift` (regenerated only),
`mobile/native/MantaUI/SettingsScreen.swift`, `MantaSettingsStore.swift`,
`MantaSettingsModels.swift`, `UpgradeScreen.swift`, `UpgradeStore.swift`,
`UpgradeModels.swift`, `MantaOnboarding.swift`, `MantaPairingModels.swift`;
tests `MantaSettingsTests.swift`, `UpgradeModelsTests.swift`,
`UpgradeStoreTests.swift`, `MantaOnboardingFlowTests.swift`, `MantaPairingTests.swift`.

**Edit (server, S1):** `src/server/devices.mjs`, `src/server/auth.mjs`,
`src/server/index.mjs` (one line at `/auth/devices`), `src/server/devices.test.mjs`,
`src/server/auth.test.mjs`.

**Create (`mobile/native/MantaUI/`):** `MantaAPIClient+Settings.swift`,
`SettingsWireModels.swift`, `SettingsCustomRows.swift`, `SettingsAppearance.swift`,
`SettingsBackupScreen.swift`, `SettingsBackupModels.swift`,
`SettingsUpdatesScreen.swift`, `SettingsUpdatesStore.swift`,
`SettingsUpdatesModels.swift`, `SettingsOpencodeRestart.swift`,
`SettingsNotificationReminder.swift`, `BoxRESTClient.swift`, `BoxRemoval.swift`,
`BoxStatusCard.swift`, `BoxAddDeviceScreen.swift`, `BoxPairingQR.swift`,
`BoxPairingModels.swift`, `BoxDevicesScreen.swift`, `BoxDevicesModels.swift`,
`ExtensionsPluginsScreen.swift`, `ExtensionsForgeScreen.swift`,
`ExtensionsRegistriesScreen.swift`, `ExtensionsReferencesScreen.swift`,
`ExtensionsLaunchersScreen.swift`, `ExtensionsModels.swift`
(Format/Forge/Registries/References/Launchers pure helpers).
`MantaLinkConfirmView` / not-mine view live inside `MantaOnboarding.swift`.

**Create (`mobile/native/MantaUITests/`):** `SettingsAppearanceTests.swift`,
`SettingsBoxTests.swift`, `SettingsExtensionsTests.swift`,
`SettingsUpdatesTests.swift`, `SettingsBackupTests.swift`,
`SettingsNotificationReminderTests.swift`.

`project.yml` needs no change (folder sources); regenerate `.pbxproj` via the
`ios-regen-pbxproj` plugin.

---

## Mount requests (files owned by WS04 — wave A)

- **M1 `MantaAppRoot.swift`** — app-wide theme. Add
  `@AppStorage(SettingsAppearance.storageKey) private var themePref = SettingsAppearance.systemValue`
  and on the root `Group`:
  `.preferredColorScheme(SettingsAppearance.colorScheme(for: themePref))`.
- **M2 `MantaAppRoot.swift`** — leave the box after Remove server. Add
  ```swift
  .onReceive(NotificationCenter.default.publisher(for: .mantaBoxRemoved)) { _ in
      store.stop()
      sessionStore.resetForBoxChange()
      flow.isSwitching = false
      flow.backToEntry()
      paired = false
  }
  ```
- **M3 `SessionListView.swift:158`** — C2 `.settings(section:)`: present
  `SettingsScreen(eventStore: eventStore, initialSection: section)`. WS10 adds
  the `initialSection: String? = nil` init parameter; the screen scrolls to that
  section id with `ScrollViewReader` on appear. Default nil keeps today's call
  compiling, so M3 can land any time.

---

## Contracts provided / consumed

- **C1 (consumed):** uses `call/callRequired/callVoid/jsonAny/jsonObject`; adds
  only `MantaAPIClient+Settings.swift`.
- **C2 (provided to WS04):** `SettingsScreen(eventStore:initialSection:)`;
  section ids are `SettingsSchema.sections[].id` (`general`, `box`, `accounts`,
  `models`, `sessions`, `files`, `extensions`, `voice`). WS10 never calls
  `MantaNavigator.open`.
- **C6 (owner):** this spec is the only schema editor; WS04 must not add schema
  entries — it reads `worktreePerSession` / `worktreeCleanOnClose` from box
  config (F1).
- **C7:** tests as listed.
- **New, provided:** `Notification.Name.mantaBoxRemoved` (`BoxRemoval.swift`);
  `SettingsAppearance` (M1); `SettingsOpencodeRestart.run(api:) async -> OkResult`
  — WS08/WS09 may reuse it if their own flows need a user-confirmed restart
  (they keep their own confirm copy).
- C3, C4, C5: not used.

---

## Deferred / excluded

- **D1 "Auto-save files the AI sends" (`allowAgentPush`) — excluded.** On desktop
  it means "write each agent-sent file into the Mac's Downloads folder without
  asking". iOS has no Downloads folder and silently writing to the phone's
  Files is not an iOS idiom (saving goes through the share sheet, which WS07's
  agent-file notice already offers). The key is in the SHARED box config, so a
  phone toggle would silently change the desktop's behaviour.
- **D2 Downloads directory — excluded.** A Mac path; meaningless on the phone.
- **D3 opencode port — excluded.** `opencodePort` is read by nothing (grep:
  only `settingsSchema.ts`, `types.ts`, `Settings.tsx`) — it is a leftover of the
  SSH-tunnel transport. Shipping it on iOS would be a dead control.
- **D4 Plugins on/off toggle and "Open plugins folder" — excluded.** The switch
  lives in the Mac app's local storage (preload bridge, `configKey: null`); the
  box never sees it, so the phone can neither read nor write it. The folder is
  on the Mac. Master spec out-of-scope already covers execution.
- **D5 Box-update step progress ("Step n of N") — deferred.** It needs a
  subscription to `serverUpdateProgress` frames, and `MantaEventStore`'s raw
  frame handlers cannot be removed, so a per-screen subscription would leak one
  closure per Settings visit. Indeterminate "Updating… / Restarting the box…"
  ships instead. Revisit if WS02 adds handler removal.
- **D6 Removing a reference — deferred (parity).** The server supports
  `remove: [alias]` but the desktop says "Removing a reference isn't available
  yet"; keep both clients aligned. Easy follow-up for both.
- **D7 "Download previous version" on the rolled-back screen — excluded.** It
  downloads the macOS DMG; nothing to do on a phone.
- **D8 Push to existing devices on a new pairing (BET-492)** — server-side,
  already deferred by the owner (DECISIONS §6.4a).

---

## Open questions (each has a default)

- **Q1 Six-digit-only manual pairing.** DECISIONS §5.2.9 wants the code alone,
  "the server resolves it", but no resolver exists and adding one is a gateway +
  security decision. *Default:* ship F21's single "Server address" field now;
  file a follow-up for a gateway code→box lookup.
- **Q2 Accept the additive `current` field on `GET /auth/devices` (S1)?** Without
  it the phone cannot revoke only itself. *Default:* yes.
- **Q3 Revoking the primary (desktop-shared) device from a phone.** The server
  allows it, and it would lock the desktop out. *Default:* not offered on iOS.
- **Q4 The desktop's own opencode-port field is equally dead.** Out of WS10's
  iOS scope. *Default:* leave desktop unchanged; note for a desktop cleanup.
