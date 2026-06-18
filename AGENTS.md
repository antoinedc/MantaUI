# AGENTS.md — context for future sessions

bui is an Electron desktop client for remote `claude` over `ssh`+`tmux`. Pipeline:
**xterm.js (renderer)** ↔ **node-pty (main)** ↔ **ssh/mosh** ↔ **tmux** ↔ **claude**.

A secondary mobile/web front-end (`src/server/`) runs on the Linux box itself
and exposes the same tmux server over HTTP+WS. See the "Mobile / web client"
section below.

See `README.md` for user-facing intro and `HANDOFF.md` for the most recent
session-state snapshot.

## Layout

- `src/main/` — Electron main: pty, transport, tmux primitives, config, IPC.
  - `opencode.ts` — HTTP client + SSH tunnel mgmt for chat-mode windows.
  - `index.ts` — IPC handlers, opencode SSE bus, screenshot detector.
- `src/renderer/` — React + xterm.js. `Terminal.tsx` is the only place that
  owns an xterm instance. `ChatPanel.tsx` is the entire chat-mode UI (~3500 LoC).
  - `chatUtils.ts` — pure utility functions extracted for testability (`formatTokens`,
    `formatDuration`, `ctxStageColor`, `filterCommands`, `dedupeAgainstBuiltins`,
    `resolveContextLimit`, `classifyFinish`, `describeTruncation`,
    `isTerminalTodo`, `allTodosTerminal`).
    Import from here; don't redeclare them inline in ChatPanel.
- `src/preload/` — typed `window.api` bridge.
- `src/server/` — Node HTTP+WS server for mobile/web access. Runs **on the
  Linux box**, not the Mac. Serves the React renderer built by `build:mobile`.
  Module tree: `index.mjs` (entry), `tmux.mjs`, `pty.mjs`, `opencode.mjs`,
  `rpc.mjs`, `events.mjs`, `local.mjs`, `status.mjs`.

## Build / run

```
npm install
npm run typecheck
npm test              # vitest (renderer) + node:test (src/server/*.test.mjs)
npm run test:server   # node:test only (src/server/)
npm run test:watch    # vitest watch mode (renderer only)
npm run dev           # main-process AND preload changes need a full Ctrl+C + restart
npm run mobile        # mobile/web server on $BUI_MOBILE_HOST:$BUI_MOBILE_PORT (default 0.0.0.0:8787)
npm run build:mobile  # Vite build of renderer → mobile/www/ for Capacitor
```

The preload bundle is built once at dev-server start; renderer HMR alone won't
pick up new `window.api` methods. If you add an IPC channel and don't see it
on `window.api`, you didn't restart.

Git-synced (since 2026-05-16). Single source of truth:
`git@github.com:antoinedc/better-ui.git` (private). Both the remote dev box
(`dev@157.90.224.92:/home/dev/projects/better-ui`) and the Mac are clones
tracking `origin/main`. **No more rsync** — push from whichever side you
worked on, `git pull` on the other before starting. Commit as you go;
`git log` is the cross-session audit trail.

## Keybindings

Window-scoped, in `App.tsx`. xterm-internal handlers (⌘C/V/F/K) live in
`Terminal.tsx` and only fire when the terminal has focus.

| Shortcut    | Action                                       |
| ----------- | -------------------------------------------- |
| ⌘N          | New project (workspace)                      |
| ⌘T          | New session in active project                |
| ⌘1..9       | Jump to nth (project, window) in sidebar     |
| ⌥⌘↑ / ⌥⌘↓ | Step prev/next session, wraps both ends     |
| ⌘,          | Open Settings                                |

Flat order for ⌘1..9 / ⌥⌘ navigation comes from `flatSessions(projects)` —
the sidebar's top-down (project, window) tuple list. Don't reorder it without
checking the keybind handler.

## File transfer

**Drag in (upload).** Drop a file on the active terminal → main scp's it to
`$HOME/.bui-uploads/<session>/<ts>/` over the existing ControlMaster socket →
resolved absolute path is written into the PTY for claude to read.
`webUtils.getPathForFile(file)` in the preload extracts the local path
(Electron 31+ removed `File.path`, so the renderer can't read it directly).
A window-level dragover/drop swallow in `App.tsx` keeps missed drops from
navigating the renderer to `file://`.

**Click out (peek).** xterm `LinkProvider` for absolute paths + an explicit
click handler on `WebLinksAddon`. Path click → main scp-pulls into a per-host
cache dir under `os.tmpdir()/bui-peek/<hash>/` → `shell.openPath` opens with
the OS default app. URL click → `shell.openExternal`. **Don't rely on
WebLinksAddon's default** — its `window.open` path gets denied by
`setWindowOpenHandler` in `main/index.ts`, so URLs silently no-op.

**OpenSSH 9.x scp gotcha — do NOT shell-quote remote paths.** Since 9.0,
`scp` defaults to the SFTP transport, which passes the post-colon path
verbatim (no remote shell). Wrapping the path in `'…'` makes SFTP look for a
file literally named `'/path/...'` (quotes included) and you get
`No such file or directory`. SFTP handles spaces and special chars natively,
so the raw path is correct. The `mkdir` step in `uploadFiles` still uses
`shellQuote` because that runs through `runSshOnce` (a real remote shell) —
the quoting rule is "shell command yes, scp path no".

**Hourly cleanup** of `~/.bui-uploads/`: `find -mindepth 2 -maxdepth 2 -type d
-mmin +N -exec rm -rf {} +` deletes per-batch `<ts>` directories, then prunes
empty session dirs. Threshold is `uploadCleanupHours` in config (default 1,
`0` disables). Sweep runs once at app load + every hour after; worst-case
staleness ≈ `uploadCleanupHours + 1h`.

**Agent → laptop push (outbox).** The reverse of drag-in: the remote AI drops a
file into `~/.bui-outbox/` (optionally `~/.bui-outbox/<session>/`) and bui pulls
it to the Mac's Downloads folder. It's the mirror image of upload — same warm
ControlMaster, `scpDownload` with the destination flipped (`pullToDownloads` in
`src/main/pty.ts`). Detection is a 3s **outbox poller** in `src/main/index.ts`
(`pollOutboxOnce` → `listOutbox` over SSH → `find -printf '%s\t%p\n'`); it
mirrors the screenshot Desktop watcher's philosophy (cheap periodic check, push
a toast). The outbox is a **one-shot mailbox** — `pullToDownloads` `rm`s the
remote source after a successful pull, so files aren't re-pulled and don't
accumulate. The poller keeps a `seenOutboxPaths` set (cleared on host change)
reconciled against the live listing each tick so a require-confirm toast the
user hasn't answered isn't re-offered every 3s.

- **Trust flag `allowAgentPush`** (AppConfig, default OFF, Settings UI). ON =
  pull immediately + informational toast ("↓ name · saved to Downloads ·
  Reveal"). OFF = a confirm toast ("AI sent you a file · Save / ×"); the
  renderer's `saveAgentFile` calls `agentPullFile` on Save. Mirrors
  `chatAutoAllow`'s shape but is a SEPARATE flag — writing to Downloads is a
  different trust boundary than auto-allowing tool runs.
- **`downloadsDir`** (AppConfig) overrides the destination; empty →
  `app.getPath("downloads")`. Resolved in `resolveDownloadsDir()`.
- **Toast** is a single global instance like the screenshot toast:
  `agentFileToast` in the store, App.tsx owns the one `onAgentFileReady`
  listener, the active ChatPanel renders it. De-dupe on collision via
  `uniqueLocalPath` (`report.pdf` → `report (1).pdf`).
- **The AI learns the convention** via the `/send-file` command
  (`docs/opencode-commands/send-file.md`). Install on the remote opencode host:
  `ln -sf <repo>/docs/opencode-commands/send-file.md
  ~/.config/opencode/commands/send-file.md` then restart `bui-opencode`. The
  command just tells the AI to `cp <file> ~/.bui-outbox/` — no MCP server, works
  with any model.
- **Mobile** has no Mac Downloads folder (the server IS the box). A server-side
  outbox poller (`src/server/outbox.mjs`, `startOutboxPoller` wired in
  `index.mjs`) `readdir`s `~/.bui-outbox/` locally every 3s and publishes
  `{kind:"agentFile"}` bus events; the httpApi shim's `onAgentFileReady`
  subscribes to that kind. Every detection is a CONFIRM toast (`autoPulled:false`)
  — there's no silent disk write to a phone/browser. Tapping Save calls
  `agentPullFile`, which triggers a browser download via `GET /api/download`
  (`src/server/index.mjs`, path-traversal-guarded to `~/.bui-outbox/`, deletes
  the source on success — the one-shot mailbox). The mobile `agentPullFile`
  returns `""` (no OS path to reveal) so the toast dismisses instead of showing
  a dead "Reveal" button; `revealInFolder` is a no-op. `MobileApp.tsx` wires the
  `onAgentFileReady` listener (mirror of `App.tsx`). Pure scan logic
  (`createOutboxScanner`, `listOutbox`) is tested in `src/server/outbox.test.mjs`.

## Mobile / web client (`src/server/`)

Node HTTP+WS server that runs **on the Linux box** (no SSH hop). The client
is the full React renderer (`src/renderer/`) built into `mobile/www/` via
`npm run build:mobile` and served statically. Use case: full bui chat+terminal
from a phone or browser with nothing installed on the device.

**Server modules:**
- `tmux.mjs` — tmux list/CRUD/config (pure, testable; `parseSessions` is
  exported for tests)
- `pty.mjs` — node-pty spawn registry keyed by projectName. `spawnRawPty`
  used by the `/pty` WS path; `spawn` used by the RPC `pty:spawn` channel
- `opencode.mjs` — opencode HTTP proxy to `127.0.0.1:4096` (no SSH layer).
  `subscribeEvents` reconnects silently with 1.5s backoff
- `events.mjs` — in-process `createBus()` + `GET /events` SSE endpoint
- `rpc.mjs` — `POST /rpc/<channel>` dispatch; `buildHandlers({tmux,oc,pty,bus,local})`
  maps all `window.api` channels
- `local.mjs` — git worktrees, fs listing, JSON-file-backed config
  (`~/.bui-mobile/config.json`). Desktop-only concepts (Mac clipboard, mosh,
  scp peek) are documented no-ops
- `status.mjs` — ports `src/main/status.ts` activity poller; same BUSY_RE /
  subagent regexes, runs locally, publishes `WindowStatus[]` batches on bus

**`window.api` shim** (`src/renderer/api/httpApi.ts`): implements the full
`Api` contract over `/rpc` + `/events`. Installed in `main.tsx` only when
`window.api` is absent (Electron preload not loaded). Server base read from
`localStorage["bui_server"]`.

**Trust mode (chatAutoAllow)**: the opencode pump in `index.mjs` reads
`configGet()` per `permission.asked` event and auto-replies "always" when
enabled — mirrors `src/main/index.ts` opencodeBusLoop. Config file is
`~/.bui-mobile/config.json`; atomic writes (temp-rename pattern).

**No auth in v1.** Default bind `0.0.0.0:8787`. Internet access is now a
**named Cloudflare tunnel on QUIC**, run by **systemd --user** on the box
(`dev@157.90.224.92`), surviving reboots via `loginctl enable-linger dev`:

- `~/.config/systemd/user/bui-server.service` → `node src/server/index.mjs`
  (`BUI_MOBILE_HOST=127.0.0.1`, port 8787).
- `~/.config/systemd/user/bui-tunnel.service` (`Requires=bui-server`) →
  `cloudflared tunnel --config ~/.cloudflared/config.yml run bui`.
- Permanent URL: **https://bui.useronda.com** (named tunnel
  `6cdca2ea-…`, zone `useronda.com`). Stable across restarts — the iOS
  PWA install stays valid.
- Manage: `systemctl --user {status,restart} bui-tunnel bui-server`;
  logs `journalctl --user -u bui-tunnel`.

**QUIC, not http2.** The old `--protocol http2` quick-tunnel buffered SSE
(`/events` connected but streamed zero bytes → UI never updated). The
named tunnel uses `protocol: quic` in `~/.cloudflared/config.yml`, which
streams SSE correctly (verified 2026-05-17, cloudflared 2026.5.0). The
earlier "QUIC fails on this box" note was stale and is retired — do not
reintroduce `--protocol http2`.

**WS protocol** (`/pty?session=NAME&window=N&cols=&rows=`): unchanged.
Client→server: `{type:"data",data}` or `{type:"resize",cols,rows}`.
Server→client: raw PTY bytes.

**Upload endpoint** (`POST /api/upload?session=NAME`): unchanged layout
(`~/.bui-uploads/<session>/<batch>/<file>`).

**Capacitor wrapper** (`mobile/`): Android APK + iOS scaffold. `npm run apk`
in `mobile/` builds the debug APK. `mobile/sync-web.sh` runs `build:mobile`
to refresh `mobile/www/`.

**Mobile-native shell** (`src/renderer/mobile/`): on the no-`window.api`
branch `main.tsx` renders `<MobileApp/>` instead of `<App/>` — a drill-down
shell (`SessionListScreen` → `SessionScreen`) that reuses `ChatPanel` /
`Terminal` unchanged. CSS is `.mobile`-scoped (`mobile/mobile.css`) so it
never matches the desktop tree. Desktop `App.tsx`/`Sidebar.tsx` are untouched.
Session owner→props mapping is the tested `resolveSessionOwner()` in
`store.ts`. Safe-area/home-indicator inset is applied on the mobile-owned
`.mobile-body` wrapper + its absolute child — **not** on ChatPanel internals
(those selectors would require editing a desktop-invariant file and silently
match nothing).

**Reshaping reused ChatPanel/Terminal internals on mobile:** the desktop
composer footer is one non-wrapping flex row built for a wide panel; at
phone width its children overlap. Fix is always `.mobile`-scoped CSS in
`mobile/mobile.css` — never edit `ChatPanel.tsx`. ChatPanel has no semantic
class hooks (Tailwind utilities only), so target structurally: ChatPanel is
the lone `.mobile-body > div` (h-full flex-col); its composer is that div's
`> div:last-child`; footer rows are matched via `div[class*="flex"]` /
`[class*="justify-between"]` + child position. Established rules: composer
rows `flex-wrap`; hide desktop keyboard-hint span + fork/compact/delete
toolbar (`SessionToolbar` — actions live in the header `⋯` sheet on mobile);
drop the context bar (`span[class*="w-24"]`, unique to ContextBar) but keep
the stage-colored `%`; clamp the empty textarea placeholder to one line via
`textarea:placeholder-shown` (reverts to `pre-wrap` once typed so
`resizeInput` still owns height). Verify on-device: `cd mobile && npm run
apk`, `adb install -r`, screenshot the composer.

## Web Push notifications (`src/server/push.mjs`)

Mobile PWA gets Web Push (VAPID) for events it can't otherwise see when
backgrounded: `permission.asked`, `question.asked`, `session.error` (always),
and `session.idle` → "done" (only if the session was busy AND not being
watched). The **server** decides whether to surface a push (iOS revokes the
subscription if a delivered push shows no notification), so suppression logic
lives in `classifyPushEvent` / `firePush`, not the service worker
(`src/renderer/public/sw.js` → copied to `mobile/www/sw.js` by `build:mobile`).

- **"done" title is the session's `workspace / session-name`** (tmux session /
  window name), resolved by `firePush` via `buildSessionLabel(projects, sid)`
  over `tmux.listProjects()`. Lookup runs ONLY on `session.idle` to avoid a
  tmux query per event; falls back to "Claude is done" when the session isn't
  found. The "from bui" subtitle under the notification is **iOS injecting the
  PWA name** — not in our payload, not removable via the Push API.

- **Multi-device suppression (Discord rule: active on desktop ⇒ no mobile
  push).** The desktop Electron app POSTs `/push/desktop-presence
  {visible}` on focus/blur/system-idle over a best-effort SSH
  `-L 18787:127.0.0.1:8787` forward on the shared ControlMaster
  (`ensurePresenceForward` in `src/main/opencode.ts`; driver in
  `src/main/desktopPresence.ts`). The server tracks `_desktop = {visible,
  lastSeen, lastActive}` and ONLY the "done" push is gated by
  `shouldSuppressForDesktop(desktop, now)` (pure, tested):
  - suppress if desktop is currently `visible`, OR was visible within
    `DESKTOP_GRACE_MS` (30s) — a quick desktop window-switch shouldn't buzz
    the phone;
  - but NOT if `lastSeen` is stale past `DESKTOP_PRESENCE_TTL_MS` (60s) — a
    crashed/asleep desktop must not mute mobile forever (the desktop sends a
    20s heartbeat while focused to stay fresh).
  permission/question/error pushes are blocking and fire on every device
  regardless (mirrors Slack/Discord still escalating mentions/DMs). Presence
  is best-effort: if the mobile server is down or the forward isn't up, the
  POST fails silently and mobile behaves as before (always notifies).

## Mouse mode — design decision, do not re-litigate

**Mouse is ON through the whole pipeline (tmux + claude).** This matches what
claude does in a native terminal: wheel scrolls claude's conversation,
drag-select goes to claude.

A previous design tried to turn mouse OFF in both tmux and claude so xterm.js
could own selection and drag-select wouldn't snap. That broke wheel-scroll
inside the claude TUI: xterm.js falls back to wheel→arrow keys in alt-screen,
and claude treats up/down as prompt-history navigation. Claude even surfaces
this with a "Scroll wheel is sending arrow keys · use PgUp/PgDn to scroll"
hint, which is its way of telling you mouse forwarding is broken.

Do NOT reintroduce:
- `tmux set -g mouse off` overrides at attach time.
- `CLAUDE_CODE_DISABLE_MOUSE=1` in the claude launch command.
- xterm.js parser handlers that swallow DECSET 1000/1002/1003/1006 enables.

If a user reports drag-select "snapping to bottom" while *in shell scrollback*
(not the claude TUI), the culprit is usually a tmux `copy-pipe-and-cancel`
binding on `MouseDragEnd1Pane`. `-and-cancel` exits copy mode, which snaps
the viewport. That's a tmux-side rebinding (e.g. `copy-pipe-no-clear` plus
`set-clipboard external`), not a bui-side override. The claude TUI itself
does not enter tmux copy mode for drags — claude has its own mouse tracking
and tmux passes through.

## Tmux config approach — drop-in, no surprises

bui does NOT modify `~/.tmux.conf` automatically. Settings shows config
status read-only; `tmuxSetupConfig` exists but is opt-in via UI only.
Backup at `~/.tmux.conf.pre-bui` on the remote if it was ever modified.

## State

- **Source of truth**: tmux on the remote. `tmux list-sessions` + `list-windows -a`.
- **Local config** (`<userData>/config.json`): `{host, user, identityFile, transport, projects[{tmuxSession, defaultCwd}], opencodePort, chatAutoAllow, defaultModel, skillRegistryUrls}`.
- **No local sessions table.** Project = tmux session, app session = tmux window.

## Patterns worth knowing

- **New window / new chat-session cwd inheritance** — every code path that
  creates a tmux window or an opencode session resolves cwd to the project's
  stored `defaultCwd` when the renderer's input is empty OR the literal `"~"`.
  Helper `resolveProjectCwd(sessionName, inputCwd)` lives in
  `src/main/index.ts` (desktop) and is duplicated inside `buildHandlers` in
  `src/server/rpc.mjs` (mobile). Applied by: `tmux:new-window`,
  `opencode:clear-session`, `opencode:fork-session`. **Renderer must pass
  `cwd ?? ""`**, NOT `cwd || "~"` — the literal tilde would defeat the
  resolver. Server tests in `src/server/rpc.test.mjs` cover empty / tilde /
  explicit-path inputs.
  - **GOTCHA — opencode does NOT reject a tilde dir; it silently corrupts
    it.** `resolveProjectCwd` deliberately returns a possibly-tilde path
    (`~/projects/x`) — it picks *which* cwd, not an absolute one. opencode's
    `session.create` requires an absolute directory and resolves a
    tilde-relative one against its OWN server process cwd (the remote
    `$HOME`), persisting the corrupt `/home/<user>/~/projects/x` into session
    metadata forever. Expansion is therefore mandatory at the **single
    creation chokepoint**, NOT in `resolveProjectCwd`:
    `createSession` expands a leading `~` itself — desktop
    (`src/main/opencode.ts`) via the now-exported
    `expandRemotePath` (remote `cd && pwd` over the SSH ControlMaster);
    mobile (`src/server/opencode.mjs`) via `expandTilde` against the server
    process's own `$HOME` (it runs on the opencode host). `forkSession` is
    unaffected — it inherits the parent's directory from opencode and passes
    no cwd. The new-window path (`pty.ts:maybeCreateChatSession`) expands
    independently before `createSession`; that earlier expansion is now
    redundant but harmless. Regression tests:
    `createSession expands a leading ~ …` in `src/server/opencode.test.mjs`
    (red/green verified). Do NOT "simplify" by moving expansion back into a
    caller — the chokepoint is what makes the corruption unreachable.
- **Queued message drain — ONLY on `session.idle`, never mid-turn.** When
  the user submits while `running` is true, the text gets pushed to
  `messageQueue` and the input clears. The `[running, messageQueue]`
  effect in `ChatPanel.tsx` dispatches the next queued item the moment
  `running` flips false (i.e. opencode emits `session.idle` or
  `session.status{type:"idle"}`). Do NOT add an SSE-handler drain on
  `message.part.updated` with tool `state.status === "completed"` (or any
  other intra-turn signal): a tool completing inside an active turn is
  NOT end-of-turn (the assistant is about to write more text or call
  another tool), and posting a new prompt in that window makes opencode
  abort the in-flight assistant message to start the new turn —
  `MessageAbortedError` lands in the sendError banner and the prior
  assistant message is marked aborted in the transcript. Slightly slower
  drain (waits for true idle), but the queued message lands cleanly as a
  normal turn.
- **TodoWrite checklist auto-dismissal** — when every item in the pinned
  `ActiveTodos` is terminal (`completed` or `cancelled`) at the moment the
  user submits their next prompt, `todosDismissed` flips true and the card
  hides until opencode emits a fresh `todo.updated`. Without this, finished
  checklists stayed pinned forever and read as "still active work". The
  `allTodosTerminal()` predicate lives in `chatUtils.ts` (tested); the
  dismissal state is local to `ChatPanel`. Reset triggers: session change,
  any incoming `todo.updated`. Do NOT clear on idle/`session.idle` —
  the user keeps the visual confirmation right up to their next turn.
- **Model persistence across sessions** — model selection is per-session in
  `localStorage` (`bui:chat:<sessionId>:model`). On `/clear`, the handler
  captures the returned `newSessionId` and copies the current override into
  the new key before calling `refresh()`. `modelOverride` initial state falls
  back to `AppConfig.defaultModel` (from store) when no localStorage entry
  exists, so new sessions pick up the global default automatically.
- **One PTY per active project**, kept mounted across renders. Switching
  between sessions inside a project uses `tmux select-window` over a
  side-channel ssh (no PTY reconnect).
- **OSC 52 → Mac clipboard** via custom parser handler in `Terminal.tsx`
  (xterm.js's built-in addon-clipboard doesn't work in Electron because
  `navigator.clipboard.writeText` is gated on user gesture).
- **ResizeObserver skips fit when container is hidden** (< 50px). Without
  this, switching projects re-flows scrollback at min width.
- **Active-effect resize dance** (`Terminal.tsx`) does wide-then-narrow on
  re-activation to un-wrap lines cramped while hidden. Don't simplify this;
  a naive shrink-then-restore doesn't actually coalesce wrapped lines.
- **Shift+Enter → newline** in `Terminal.tsx`. xterm.js routes input through
  a hidden textarea; the browser default for Shift+Enter there is to insert
  `\n`, which the inner claude TUI then receives as submit. We catch the
  event in `attachCustomKeyEventHandler`, call `preventDefault()` to kill
  the textarea side, and manually `ptyWrite("\x1b\r")` — the same sequence
  iTerm2's `/terminal-setup` sends. Don't drop the `preventDefault()`.
- **Chat transcript pin-to-bottom — pre-commit pin state derived from the
  live DOM in a layout effect, not from event-cached state (v4).** Four
  designs in this saga, each fixing the previous one's bug:

  - v1 (pre-631b03e): 80px symmetric threshold. 30px scroll-up left
    pin=true, next delta snapped.
  - v2 (631b03e): 8px re-pin + wheel/touch/key intent un-pin. Missed
    scrollbar-handle drag (no wheel/touch/key event) and got snapped on
    every `session.status` busy/idle oscillation by a `running` edge
    effect.
  - v3 (f1b7341): single 8px symmetric threshold + one `scroll` listener.
    Right idea, wrong substrate — `scroll` events are async (rAF-batched),
    but `setMessages` → render → effect is sync in the same task. So mid-
    streaming wheel-up was eaten: the delta's effect read the STALE
    pin=true (last scroll event), snapped to bottom, THEN the queued
    scroll event for the wheel-up dispatched against the post-snap
    position and re-affirmed pin=true. User's scroll silently erased.
  - v4 (current): the post-commit stick decision reads the live DOM in a
    `useLayoutEffect` (synchronous post-commit, pre-paint) and computes
    pre-commit distance from a tracked `prevScrollHeight` ref:

      prevDist = max(0, prevScrollHeight - scrollTop - clientHeight)

    `scrollTop` is preserved by the browser when content is appended, so
    this is the user's true pre-commit position. No event timing. No
    stale ref. The pure helper is `wasAtBottomBeforeCommit()` in
    `chatUtils.ts` (tested with explicit v3-regression cases).

  The `scroll` listener still updates `pinnedToBottom.current` via
  `classifyScrollForPin()` as a back-channel for callers OUTSIDE the
  messages commit (the RunningIndicator `atBottom` prop, the isActive
  re-pin effect). `resizeInput` does NOT use the cached boolean — it
  reads the live DOM via `classifyScrollForPin` for the same staleness
  reason. **Do NOT re-introduce a messages-effect that reads
  `pinnedToBottom.current` instead of `wasAtBottomBeforeCommit`** — that
  is the v3 regression.

  Trade-off baked in: scrolls of < 8px (single-pixel jiggles) stay pinned
  and get snapped on the next delta. Intentional — most wheel detents are
  40-100px, a sub-8px scroll is almost certainly accidental, and
  re-engaging follow by scrolling to the bottom is trivial.

  **Force-pin paths are limited and explicit**: `submit()` sets
  `pinnedToBottom.current = true` AND resets `prevScrollHeight.current =
  0` just before its optimistic `setMessages`. The reset matters —
  `wasAtBottomBeforeCommit` returns true unconditionally when
  `prevScrollHeight=0` (first-commit branch), which forces the stick even
  if the user had scrolled into history before submitting. That's it.
  Queue drains route through the same `submit()` path so they inherit
  this force-pin for free. The old `running` false→true edge effect is
  gone — it fired on every busy/idle oscillation and yanked the viewport
  mid-turn. **Do NOT reintroduce a `running`-derived force-pin.**

  Also gone: asymmetric hysteresis with a dead-zone (re-introduces v1's
  bug — the dead zone PRESERVES prior state); wheel/touch/key intent
  listeners (load-bearing only for v2's missing un-pin path; v4 doesn't
  need them); the v3 `[messages, liveTodos]` regular effect that read
  `pinnedToBottom.current` (replaced by the `useLayoutEffect` that reads
  `wasAtBottomBeforeCommit`).

## New-project dialog (`Sidebar.tsx`)

Two helpers run against the entered `defaultCwd` over the warm
ControlMaster socket, both in `src/main/pty.ts`:

- **`listWorktrees(cwd)`** — `cd <cwd> && git worktree list --porcelain`.
  If >1 worktree, the dialog pauses to show "Detected N git worktrees.
  Open a session for each?" with Yes / Just main. On Yes, the first
  worktree becomes the tmux session's initial window; the rest are added
  as new windows. Each window's `cwd` is the worktree's own path.
- **`listPathCompletions(cwd)`** — `ls -1Ap <parent> | grep '/$'`.
  Powers the shell-style ghost-text autocomplete in the cwd input.

Locked decisions for these flows:

- **Window names use the worktree directory basename**, not the branch.
  Antoine's worktree folders are already named meaningfully
  (`ethernal`, `ethernal-marketing`); branch names lose that context.
  See `worktreeName()` in `Sidebar.tsx`. Don't "fix" this back to branch.
- **Autocomplete is shell-LCP, not first-match.** Single match → suggest
  full path + `/` (so the next Tab descends). Multiple matches with a
  longer common prefix → suggest the LCP only (never commit to one
  ambiguous sibling). No suggestion when typed is already the LCP. The
  reducer is in `refreshCwdSuggestion()`.
- **Ghost-text rendering trick**: the wrapper `<div>` carries the
  background + border, the `<input>` is `bg-transparent`, and an
  absolute-positioned overlay sits between them with the typed prefix in
  `invisible` and the suggestion tail in `text-text-faint`. Both input
  and overlay use `font-mono` so the invisible prefix and the muted
  tail align character-for-character with the caret. If you change the
  font on one, change both — or alignment drifts a pixel per character.
- The fan-out flow only fires on project create. There's no live
  re-sync if worktrees come and go later (same scope as the "live
  refresh polling" roadmap item).

## Per-window activity poller (`src/main/status.ts`)

Drives the blue/amber dot in the sidebar. Polls every 2s via one SSH call
that runs `tmux list-windows -a` followed by `tmux capture-pane -p -S -40`
for every window, then parses the captured text. Reuses the existing
ControlMaster socket so each tick is cheap (~30–60ms total).

Detection rules — these are **heuristics over Claude's TUI rendering**, not
a contract. They will break the next time Claude rewords its status line:

- **Running** (`BUSY_RE`): a line matching
  `^[✻✳✶✽✢·*]\s+\S+…[^\n]*\([^)\n]+·[^)\n]*\)` — spinner glyph + verb with
  Unicode ellipsis + parens-with-`·`. The `^` anchor matters: assistant
  messages and code blocks are always indented, so a chat reply that quotes
  `✻ Ruminating… (10s · ...)` does not match.
- **Done** (no match): same line becomes `✻ Cogitated for 39s` — past
  tense, no ellipsis, no parens. Requiring `…` is what distinguishes live
  from done.
- **Subagents**: `^●\s+Task\(` lines whose next ⎿ child within 3 lines is
  `⎿  Running…`. Other tool calls (Bash, Read, etc.) also briefly render
  `⎿  Running…` but they don't get counted because their parent header is
  not `Task(`. Column-0 anchor again — same self-reference trap.

If the indicator goes dark across all windows after a Claude update, dump
`tmux capture-pane -p -S -40 -t <session>:<idx>` while a window is busy and
compare against the regexes. The bottom of an alt-screen has the spinner
~10 lines above the input box, so a naive tail-line check misses it; the
regex matches anywhere in the captured body.

**Chat-mode windows are NOT served by this poller.** Their tmux pane runs
`sleep infinity` (the holder); `capture-pane` returns blank output, BUSY_RE
can't match, so the poller would silently report `running:false` forever
for chat windows. Sidebar status for chat-mode flows through a separate
path: an `onOpencodeEvent` subscription in `App.tsx` calls
`setChatRunning(sessionId, running)` on `session.status` / `session.idle`
and `setChatAttention(sessionId, kind)` on `question.asked` /
`permission.asked` / `*.replied` / `*.rejected`. `applyStatusBatch`
preserves chat windows' prior status across poller ticks (looking up
`w.opencodeSessionId`) so the poller never clobbers the live SSE state.
Attention kinds: `"idle"` (running→idle while user wasn't on the window,
amber dot), `"question"` (Question tool blocked the turn, pulsing red
dot + `?`), `"permission"` (permission.asked blocked a tool, pulsing red
dot + `!`). `chatAutoAllow` suppresses `permission.asked` at the bus
layer in both transports, so the sidebar naturally stays quiet in trust
mode.

## Chat-mode windows

A second window type alongside the claude-TUI window. A tmux window running
`sleep infinity` (holder pane) with bui's own React `ChatPanel` overlaid on
top, talking to an opencode session over HTTP+SSH tunnel.

**Recognition**: presence of `@bui-session-id` tmux user-option on the window
is THE signal the renderer uses to show `ChatPanel` instead of `Terminal`.

**Architecture**:
- opencode runs in tmux session `bui-opencode` on the Linux box, port 4096,
  bound to 127.0.0.1. Mac connects via SSH `-L 14096:127.0.0.1:4096`.
- Renderer never talks to opencode directly — only via `window.api.*`.
- Main owns ONE long-lived SSE stream (`/event`) and fans events to the renderer.
  ChatPanel filters by sessionID.
- Anthropic auth via `opencode-claude-auth@latest` plugin in
  `~/.config/opencode/opencode.jsonc` (Claude Max sub, `~/.claude/.credentials.json`).

**SSH `-L` forward self-heal (`src/main/forwardHeal.ts`)** — the
`-L 14096:127.0.0.1:4096` forward is attached to the shared SSH
ControlMaster (`/tmp/bui-cm-%C`, `ControlPersist=10m`). GOTCHA: killing
the app and relaunching **within the 10-min persist window** leaves the
old instance's ControlMaster *and its port-14096 forward* alive as an
orphan. The new instance's `ensureForward` (`src/main/opencode.ts`) starts
its own master (so `ssh -O check` passes) but `ssh -O forward` is rejected
with `Port forwarding failed` because the orphan still binds 14096 —
surfaces as `Error invoking remote method 'opencode:messages': ssh -O
forward exited 255`. On a port-forwarding failure `ensureForward` now:
identifies the port holder via `lsof`, and if it's one of *our* own
`/tmp/bui-cm-*` sockets that is NOT the live master, `ssh -O exit`s that
specific orphan socket and retries once. A non-ssh holder or a foreign ssh
tunnel is reported, never killed. Decision logic is pure + unit-tested in
`forwardHeal.ts` (`isPortForwardingFailure`, `parseLsofListeners`,
`decideEviction`); the spawn glue stays thin in `opencode.ts`. This
recurs on every kill-relaunch dev cycle — do not regress the heal path.

**Key files**:

| File | What |
|---|---|
| `src/main/opencode.ts` | HTTP client, SSE consumer, ssh tunnel mgmt |
| `src/main/index.ts` | IPC handlers, opencode SSE bus, screenshot detector |
| `src/main/pty.ts` | `tmuxRestampSessionId`, `tmuxNewChatWindow` |
| `src/renderer/ChatPanel.tsx` | entire chat UI (~4150 LoC), intentionally monolithic |
| `src/renderer/App.tsx` | mounts ChatPanels keyed by session id |

**AppConfig additions**: `opencodePort` (default 14096), `chatAutoAllow`
(auto-reply "always" to all permission requests — like `--dangerously-skip-permissions`).
`chatAutoAllow` does NOT apply to Question tool requests — those always need
explicit user choice. `defaultModel: { providerID, modelID }` — global default
for all new and cleared sessions; settable in Settings; `null`/absent = opencode
picks its own default. `skillRegistryUrls: string[]` — extra opencode skill
registry URLs (Settings UI). On save, the `configUpdate` handler reads remote
`~/.config/opencode/opencode.jsonc`, deep-merges only the `skills.urls` key,
and writes it back via `runSshOnce`. **Merge is JSONC-comment-stripped** (`//`
single-line only) before `JSON.parse`; if it's unparseable we start from `{}`
rather than corrupting other keys. The default registry
(`https://antoinedc.github.io/bui-skills`) ships in the opencode binary once
the upstream PR (anomalyco/opencode#28068) lands; these are user-added extras.
`cacheTtl: "5m" | "1h"` — Anthropic prompt cache TTL (default `"1h"`).
Display-only: drives the stale-cache pill threshold in ChatPanel's
footer. bui does NOT set the real `cache_control.ttl` on Anthropic
requests — opencode does — so this setting must match what opencode is
configured to send.

**v2-only endpoints** (used alongside the v1 base):
- `GET /question` — list pending Question tool requests
- `POST /question/{id}/reply` — body `{answers: string[][]}` (one array of selected
  option labels per question)
- `POST /question/{id}/reject` — dismiss without answering
- `GET /vcs?directory=<cwd>` — `{branch?, default_branch?}` for the session
  cwd. **bui does NOT use this.** opencode caches the branch per-worker and
  its internal watcher misses terminal-side `git checkout`s, so `/vcs`
  returns stale data forever ("main" even when HEAD is on `feature/x`) and
  the `vcs.branch.updated` SSE below never fires for those switches. The
  `opencode:vcs-branch` IPC (`window.api.opencodeVcsBranch(directory)`)
  bypasses opencode entirely: main spawns
  `git -C <cwd> branch --show-current` over the warm SSH ControlMaster
  (~30ms); the mobile server uses `child_process.spawn("git", ...)` locally.
  ChatPanel polls every 5s and on every submit, so terminal-side checkouts
  reflect within one tick. If you ever need branch info elsewhere, use the
  same IPC — never call `/vcs` directly.
- SSE events consumed in ChatPanel's `onOpencodeEvent` handler beyond the
  basics (`session.idle/status/error/compacted`, `message.part.*`, `permission.*`,
  `question.*`):
  - `session.next.step.ended` — live token/cost snapshot. `stepTokens` state
    is preferred over the transcript-scraped `latestTokens` so the footer
    ctx bar updates between tool calls, not just on re-fetch. `properties.
    finish` is classified via `classifyFinish()` into `"output-cap" |
    "context-wall" | "tool-cutoff" | null` (covers Anthropic `max_tokens` /
    `model_context_window_exceeded`, OpenAI `length`, Gemini `MAX_TOKENS`).
    Non-null results land in `finishByMessageId: Map<messageID,
    TruncationKind>` and render an inline orange `⚠ truncated (…)` pill
    on the matching `MessageRow` next to the turn-duration footer.
    `tool-cutoff` is promoted from `max_tokens` when the message's last
    non-step part is a `tool` — silently-fatal case where the tool JSON is
    incomplete; the badge tells the user a retry is needed. The legacy
    `sendError` banner also fires (finish-aware copy via
    `describeTruncation().label`), without clobbering a more-specific
    `session.error`.
  - `session.next.compaction.{started,delta,ended}` — drives the inline
    `CompactionCard` above the running indicator. `.ended` holds the
    "Compacted" confirmation for 2.5s then clears (the `session.compacted`
    refetch has landed by then).
  - `todo.updated` — `liveTodos` state, preferred over transcript-scraped
    `activeTodos`. Lets the `ActiveTodos` card flip items between
    in_progress/completed live.
  - `vcs.branch.updated` — keeps the footer's branch indicator current
    when opencode itself notices a change (rare in practice: its watcher
    misses terminal-side `git checkout`s — see the `/vcs` note above for
    why we don't rely on this event). The handler is still wired because
    when opencode DOES emit it, the value is correct, but the 5s poll +
    submit refetch is the authoritative path. Properties have no
    `sessionID` so the early sessionID filter at the top of
    `onOpencodeEvent` short-circuits (undefined → falsy).
  - On `todo.updated`, `todosDismissed` is reset to `false` so a fresh
    TodoWrite resurfaces the card even if the prior list was user-dismissed.
  - `session.status` with `type === "retry"` — drives the `RetryCard` above
    the running indicator with `attempt`, `message`, and an optional
    `action {title, message, label, link?}`. Cleared on next `busy`/`idle`.
  - `command.executed` — fired right after opencode creates the user
    message that holds an expanded slash-command template. Properties
    `{name, arguments, messageID, sessionID}` populate `commandByMessageId:
    Map<messageID, {name, arguments}>`. `MessageRow` reads the map and
    swaps the user-text gray bar for `UserCommandBar` — a collapsed
    `› ▸ /name args` row with a chevron that expands to the full template
    body. Without this, invoking a large skill (e.g. gsd-*) dumped the
    entire SKILL.md as the user's turn.

The `QuestionCard` component (bottom of `ChatPanel.tsx`) renders above
`PermissionCard`. Each card shows question header + body text, clickable option
buttons (toggleable multi-select when `multiple:true`), optional free-text input
(`custom:true`), and Submit / Cancel. Submit is disabled until every question in
the request has at least one selection or custom text.

**Pattern: live-event state preferred over transcript-derived `useMemo`.**
The transcript only refreshes on the 300ms debounced refetch — a long tool
roundtrip leaves footers and cards stale until the next part arrives.
Several `useMemo` selectors over `messages` now check a "live" state first
and fall back to the message scan:
- `latestTokens` prefers `stepTokens` (from `session.next.step.ended`)
- `activeTodos` prefers `liveTodos` (from `todo.updated`)
- `branch` is pure state (initial fetch + 5s poll + submit refetch +
  best-effort `vcs.branch.updated`; see `/vcs` note above)
- `finishByMessageId` is pure state (from `session.next.step.ended`'s
  `properties.finish`) — survives refetch because the canonical messages
  payload doesn't carry per-step finish metadata.
- `commandByMessageId` is pure state (from `command.executed`) — same
  reason: the canonical messages payload has no command-origin field, so
  re-fetch can't restore the `/name args` collapsed view.
When adding a new live-event consumer in ChatPanel, follow the same shape:
`useState` reset on session change, set in the SSE handler, consumed via a
`liveX ?? transcript-derived` selector. Don't try to mutate messages
in-place — the canonical refetch will overwrite you.

**ContextBar denominator is the active model's real `limit.context`**, not
a hardcoded 200k. `resolveContextLimit(activeModel)` reads
`model.limit.context` (Opus 4.7 = 1M, Sonnet 4 = 200k) so the bar reflects
what the provider will actually accept; falls back to `ASSUMED_CONTEXT_TOKENS`
(200k) only when no model is selected yet. Tooltip at ≥90% surfaces
"consider /compact soon"; at 100% says "Compact recommended". If you add
a new place that shows ctx %, use the same helper — don't reintroduce the
200k hardcode.

**ContextBar numerator = input + cache.read + cache.write** (all three
Anthropic input buckets are disjoint and ALL consume the request's context
window). Earlier code used `input + cache.read` and under-counted on
cache-warming turns. Math + per-segment widths live in
`computeContextBreakdown()` in `chatUtils.ts` (tested). The bar is
SEGMENTED: fresh-input slice in the stage color, cache.write slice in
amber (`#f59e0b`), cache.read slice in teal (`#0ea5a4`). Mobile CSS hides
the bar on `span[class*="w-24"]` — don't rename that class without
updating `mobile.css`.

**Stale prompt-cache pill — "/clear to save Nk tokens"** in the footer.
Anthropic's prompt cache has a sliding TTL (5m default, 1h opt-in via
`cache_control.ttl`). When the session has been idle past the TTL, the
next user message re-bills the entire cached prefix as
`cache_creation_input_tokens` (full rate + 25% for 5m, 2× for 1h). The
pill surfaces this in the ContextBar component (`ChatPanel.tsx`) when:
`!running && idleMs >= ttlMs && cachedTokens >= STALE_CACHE_MIN_TOKENS`
(5k). The TTL is **NOT set by bui** — opencode picks the
`cache_control.ttl` value when it builds each Anthropic request. bui only
predicts staleness based on `AppConfig.cacheTtl` ("5m" | "1h", default
"1h", configurable in Settings). If staleness fires at the wrong time,
the config doesn't match opencode's setting — the tooltip says so. The
predicate (`computeStaleCache`), TTL → ms (`selectCacheTtlMs`), and
"last assistant completion" selector (`selectLastAssistantCompletion`)
are pure + tested in `chatUtils.ts`. ChatPanel runs a 10s
`setInterval` (gated on `!running && lastCompleted != null &&
cachedTokens >= min`) to re-evaluate the predicate over time without
remounting; same pattern as the RunningIndicator's 1s elapsed-time tick
but coarser since staleness is a 5-min / 1-hr scale.

**Buffered text-delta streaming.** opencode emits `message.part.delta`
events ~character-by-character for text/reasoning parts. The naive
"setMessages on every delta" policy produces visible markdown jitter:
bullets appear before their content, code fences flash as inline-code
before closing, Prism re-tokenizes a growing code block on every
keystroke. Instead, deltas accumulate in `pendingDeltas: Map<partID,
{messageID, field, text}>` (a ref in ChatPanel) and flush at section
boundaries computed by the pure `findFlushBoundary(buffer)` helper in
`chatUtils.ts`:

- Paragraph breaks (`\n\n`) **outside** an open code block.
- The newline immediately after a closing ` ``` ` fence (so whole code
  blocks appear at once — no half-formed fence rendered as inline code).
- The largest valid boundary wins (deepest flushable prefix).
- 250ms max-age fallback (FLUSH_MAX_AGE_MS) so a single long paragraph
  doesn't stall.

Force-flushed on: `session.next.step.ended` (step narration complete —
flush before next step starts), `message.part.updated` /
`session.idle` / `session.status` / `session.compacted` /
`session.error` / `message.updated` (BEFORE the refetch, otherwise the
canonical-transcript pull races the buffer's max-age timer and the
trailing paragraph gets discarded), and on session change / unmount.

Race tolerance: if a delta arrives before the part's `message.part.updated`
snapshot (so `mergeBufferedDeltas` reports the partID as unmatched), the
flush scheduler triggers `scheduleRefetch()` and the buffered text waits
for the next flush — the refetch creates the part in state, the next
flush merges the buffer cleanly.

Pure logic (`findFlushBoundary`, `mergeBufferedDeltas`) lives in
`chatUtils.ts` with full unit-test coverage including the tricky cases
(open code block suppresses `\n\n` boundaries, empty code block, multiple
fences in one buffer, inline backticks don't toggle fence state).

**Transcript row memoization — REQUIRED for input perf.** The chat
input's `input` state lives in `ChatPanel`, so every keystroke
re-renders the whole component. Without `React.memo` on transcript
rows that cascade re-runs `react-markdown` + Prism for every assistant
message — visibly laggy past ~50 messages. Memoized leaf components:
`MessageRow`, `AssistantPart`, `MarkdownBody`, `CodeBlock`, `ToolCall`,
`ToolOutput`, `ActiveTodos`, `UserCommandBar`. All use the default
shallow comparator; props passed in `messages.map()` are either
primitives or Map lookups from panel-scope `useMemo`s
(`userCommandInfo`, `turnInfo`, `finishByMessageId`, `commandByMessageId`).
**Do not build fresh objects inline inside `messages.map`** — the
`{name, arguments}` cmdInfo literal used to do this and silently
defeated the memo on every keystroke. `userCommandInfo` precomputes
the Map once, the map callback just does an O(1) lookup. If you add
a new prop to MessageRow, either make it primitive or back it with
a memoized lookup; otherwise the keystroke lag returns.

`@`-typeahead file lookup is debounced 80ms (`fileSearchTimer`) so a
fast typist doesn't pile up parallel SSH-tunneled `opencodeFindFiles`
requests; the seq guard remains so any stale response is discarded.

**Typed `session.error` names.** The `session.error` handler switches on
`err.name` to prepend a context-appropriate prefix before the raw message:
`ProviderAuthError` → "Auth error: …", `ContextOverflowError` → "Context
full — try /compact: …", `MessageOutputLengthError` → "Response truncated
(hit output limit)", `StructuredOutputError`, `ApiError`. Add new branches
when opencode introduces new error class names; unknown names fall through
to the raw message.

**Per-project SSE scope** — every session-mutating POST
(`prompt_async`, `command`, `fork`, `compact`) carries
`?directory=<session.directory>` so opencode runs tools inside the project
worktree. opencode's `/event` stream is ALSO scoped by `?directory=`: events
from a scoped POST land only on the matching scoped subscription, NOT on
the global stream. The bus in `src/main/index.ts` therefore opens **one
`/event` stream per directory** in addition to the global stream:

- `sessionDirectoryCache` in `src/main/opencode.ts` maps `sessionId →
  directory`; populated by `createSession`, `forkSession`, and `listSessions`
  (via a side-effect loop), and lazy-filled by `GET /session/{id}` on miss.
- `onSessionDirectoryAdded` lets the bus auto-spawn a stream whenever a new
  directory shows up in the cache.
- On startup the bus opens the global stream, replays
  `knownSessionDirectories()`, and calls `opencodeListSessions(config)` to
  prime the cache from server-side sessions (recovers from restarts).
- **GOTCHA — every cache write MUST go through `rememberSessionDirectory`,
  never a bare `sessionDirectoryCache.set`.** Only `rememberSessionDirectory`
  fires the `onSessionDirectoryAdded` listeners; a bare `.set` populates the
  map but the bus never learns to open the scoped stream. This was the exact
  "SSE broken in *existing* sessions, fine in new ones" bug:
  `getSessionDirectoryQuery`'s lazy-fetch branch used a bare `.set`, so an
  existing/restored session resolved on its first prompt never opened its
  scoped stream and every response event vanished. Fixed in BOTH transports
  (`src/main/opencode.ts` + `src/server/opencode.mjs` had the identical
  bug). Regression test: `sendPrompt lazy-fetch notifies directory
  listeners …` in `src/server/opencode.test.mjs` (red/green verified).
- **Readiness gate (desktop)** — even with the listener firing, the scoped
  stream opens asynchronously while the prompt POST is already in flight.
  `setDirectoryReadyGate` (registered by the bus in `src/main/index.ts`) lets
  `getSessionDirectoryQuery` await the scoped subscription being live before
  the scoped POST goes out. Bounded at 5s — a wedged server degrades to
  "send anyway", never freezes the prompt. Readiness re-arms on stream
  disconnect so reconnect-window prompts wait for the new subscription.
- **Success-path instrumentation** — the bus logs `[opencode-bus] stream
  CONNECTED dir=…`, the open-stream set, and a sampled per-dir event trace
  (event#0, then every 50th) to the dev log. The earlier `debug(...)` commits
  only logged the main-process cwd path, not SSE success — "nothing prints"
  was undiagnosable. Keep this; it's how you tell "events flowing for a dir"
  from "silent" (the bug signature).

Symptom you'll see if this breaks again: user message shows optimistically,
assistant turn stays blank forever, no JS errors. The transcript
(`GET .../message`) shows the response was generated and persisted — it
just never streams to the renderer because the matching scoped stream
isn't open. Verify with
`curl -sN 'http://127.0.0.1:4096/event?directory=<cwd>'` while a prompt is
in flight: you should see `message.part.delta` frames.

The mobile server (`src/server/opencode.mjs`) mirrors this with its own
`sessionDirectoryCache` and `subscribeEvents()` that opens global + one
scoped stream per known directory. Both code paths share the same contract;
when changing one, change the other.
- Sessions persist FileParts forever. A bad-mime FilePart (e.g. `application/json`)
  in history causes every subsequent Anthropic call to fail. Fix:
  `DELETE /session/{sid}/message/{mid}/part/{pid}` on each offender.
- `/api/model` leaks `apiKey` — never forward it. Use `/provider` instead
  (already done in `opencode.ts`).
- The `/question` endpoint returns 404 on older opencode servers (pre-v2). The
  fetch in ChatPanel is wrapped in `.catch(() => {})` — non-fatal.
- `opencodeVcsBranch` returns `null` for non-git cwds, detached HEAD,
  empty cwd, or transport failure. The renderer renders nothing for `null`
  (the `⎇ <branch>` indicator is gated on truthy branch). Don't treat
  `null` as an error.
- `vcs.branch.updated` events carry no `sessionID` — they pass the
  per-session filter by accident. Acceptable: there's only one branch per
  cwd, but be aware if you ever scope event handling more strictly.

## Subagent rendering (read-only, Phase 1)

When the parent agent invokes the `task` tool, opencode spawns a CHILD
session and runs the subagent inside it. The child's events flow on the
**same scoped `/event?directory=` stream** as the parent (child inherits
parent cwd), but with the child's `sessionID` — so the early sessionID
filter in `onOpencodeEvent` would drop them. Phase 1 renders the subagent
inline (collapsed by default, expand for full child transcript) without
spawning a tmux window for it. Phase 2 ("Open as session") is the open
work bullet at the bottom — promotes the child into its own chat-mode
window.

**Wire shape — verified live + against OpenAPI** (`/doc` endpoint, opencode
v2):

```js
// Parent's task tool part:
{ type: "tool", tool: "task", callID: "toolu_…", state: {
    status: "pending" | "running" | "completed" | "error",
    title: "Find skill loading code",        // opencode-generated
    input: { description, prompt, subagent_type },
    output: "I now have…",                    // present when completed
    metadata: {
      parentSessionId: "ses_parent",          // ourselves
      sessionId:       "ses_child",           // ← child id, present from
                                              //   first metadata write
      model: { providerID, modelID },
      truncated: false,
    },
    time: { start, end },                     // end set on completion
} }
```

**Child id discovery — two converging sources:**
1. `collectChildSessionIds(messages)` walks the transcript for
   `state.metadata.sessionId` on every task part. Used to seed the
   `childSessionIds` allowlist on initial fetch AND every refetch.
2. `session.created` events whose `properties.info.parentID === sessionId`
   add the new child id to the allowlist (covers the brief window before
   the parent's task part is stamped). **GOTCHA — registration MUST run
   BEFORE the per-session filter**, otherwise the filter drops the event
   whose payload would register the child:
   `EventSessionCreated.properties.sessionID` per opencode's OpenAPI is the
   NEW child's id, which is not in the allowlist yet (this event is what
   would add it). The pure `registerChildSessionFromCreated(ev, sessionId,
   childIds)` helper handles registration and is called before
   `shouldDropEventForSessionFilter(...)` in `onOpencodeEvent`. The
   regression is locked in by `shouldDropEventForSessionFilter REGRESSION:
   session.created for a new child …` in `chatUtils.test.ts`.

**The sessionID filter** (`shouldDropEventForSessionFilter` in
`chatUtils.ts`, called from `onOpencodeEvent`) is 3-state, not 2-state:
- `evSessionID === sessionId` → main session event, normal handling.
- `evSessionID ∈ childSessionIds` → CHILD event, routed to the subagent
  branch (re-fetches the child's transcript when its card is expanded;
  updates `liveChildStatus` on `session.idle` / `session.status`; triggers
  a parent refetch so the task part's `state.status` flips).
- otherwise → dropped (unless it's a self-filtering lifecycle event:
  `question.*` / `permission.*`).

**State pattern matches the "live-event preferred" rule** from the rest of
ChatPanel:
- `childSessionIds: Ref<Set<string>>` — allowlist consulted by the SSE
  handler; a ref so the closure reads current value without resubscribing.
- `childMessages: Map<childId, OpencodeMessage[]>` — lazily fetched on
  first expand; refetched (300ms debounce) on subsequent SSE traffic
  while expanded; ALSO refetched on re-expand when the child is still
  running (the cached snapshot would otherwise be stale until the next
  live event hits the now-expanded card).
- `childFetchState: Map<childId, "loading"|"error">` — drives the
  spinner / retry hint in collapsed-but-pending state.
- `liveChildStatus: Map<childId, "running"|"idle">` — overrides the
  parent's stale `state.status` snapshot for the header badge.
- `expandedTasks: Set<childId>` + `expandedTasksRef` mirror — the SSE
  handler gates per-child refetches on whether the card is expanded
  (closed cards don't burn fetch traffic).

**TaskContext** (provided by ChatPanel around the scroll container) is
how `TaskBody` reads this state without breaking the existing
MessageRow/AssistantPart/ToolCall/ToolBody memo chain. **Don't pass the
context value as a prop** — `taskContextValue` is memoized for keystroke
stability; provider value identity is what matters.

**Sidebar `·N` indicator for chat-mode subagents** flows through a new
`setChatSubagents(sessionId, count)` store action (mirrors
`setChatRunning` / `setChatAttention`). ChatPanel pushes
`countRunningSubagents(messages, liveChildStatus)` via a 1-effect
derivation. The store no-ops when the count is unchanged (perf:
ChatPanel re-derives on every message update, which is many per second
during streaming). The TUI poller's regex can't see chat-mode panes
(holder pane runs `sleep infinity`), so this is the **sole** update
path for the chat-window `·N` count.

**Helpers** (all pure + tested in `chatUtils.ts`):
- `extractSubagentInfo(part)` — returns `SubagentInfo | null`. Null when
  not a task part OR when `state.metadata.sessionId` isn't stamped yet
  (the pre-stamp window). Brittle on the wire format — if a test on this
  fails, opencode changed the task tool's metadata shape.
- `collectChildSessionIds(messages)` — for seeding the allowlist.
- `countRunningSubagents(messages, liveStatus)` — for the sidebar count.
  Live `idle` overrides transcript `running` (covers the stale-snapshot
  case); live `running` overrides transcript `completed` (covers the
  refetch-race case); missing live falls back to transcript.
- `summarizeChildSession(childMessages)` — `{toolCount, lastToolName,
  tokens}` for the collapsed header.

**What is NOT handled in Phase 1:**
- Nested subagents (sub-subagents) render recursively today because
  `TaskBody` re-enters the same `ToolBody` switch, but the second-level
  collapsed header is visually identical to the first — could become
  confusing on deep trees. No depth limit imposed.
- Permission/question requests originating in a child session are NOT
  surfaced in the parent's `PermissionCard` / `QuestionCard`. They reach
  the renderer (we no longer drop them via the filter), but the existing
  cards key on the parent's sessionId. Future: tag with "from subagent: X".
- "Open as session" — see the open-work bullet at the bottom.

## Voice / speech-to-text (Groq)

Push-to-talk mic button in the chat input. Hold = record. Tap (≤500ms) =
**dictate** — transcript inserted at the caret. Hold-with-⌥ (desktop) or
long-press ≥500ms (touch) = **command** mode — transcript routed through
the rules classifier and (on no match) a Groq llama call returning a
structured `VoiceAction` that's dispatched panel-side (clear/compact/fork/
abort/model/answer/permission/etc) or App-side (switch-window/new-session/
open-settings, via a `bui-voice-app-action` `CustomEvent`).

**Audio pipeline (identical on both transports):**
1. `useVoiceRecorder` (`src/renderer/voice.ts`) drives a `MediaRecorder`
   over `getUserMedia({audio:true})`. Mime selection prefers
   `audio/webm;codecs=opus` (Chromium), falls back to `audio/mp4` (iOS
   WKWebView — the only thing Apple ships).
2. On release, `window.api.voiceTranscribe({buffer, mime})` ships the
   `ArrayBuffer` to main/server. The mobile HTTP shim base64-encodes the
   buffer because the RPC body is JSON; `rpc.mjs` decodes back to a
   `Buffer`.
3. `src/shared/groq.mjs` POSTs multipart to
   `https://api.groq.com/openai/v1/audio/transcriptions` with the
   configured key + model (default `whisper-large-v3-turbo`).
4. In command mode, the renderer follows up with
   `voiceClassifyCommand({transcript})`. `src/shared/voiceClassifier.mjs`
   runs the rules first (zero-cost), falls back to
   `chat/completions` with JSON-mode (default
   `llama-3.1-8b-instant`) — `coerceLlmAction` validates the reply and
   degrades to `{kind:"unknown",transcript}` on malformed input.

**Why classify on the server side:** the Groq API key never leaves main/
server, same trust boundary as opencode auth. The renderer only ever sees
audio bytes and the final `VoiceAction`.

**Settings:** `groqApiKey` (gates the mic button — empty = hidden),
`voiceTranscriptionModel`, `voiceCommandModel`. All three live in
AppConfig and the store; UI in `Settings.tsx` and `MobileSettings.tsx`.
Stored plaintext, same as other bui credentials.

**Mobile permissions:** `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` in
`mobile/android/.../AndroidManifest.xml`; `NSMicrophoneUsageDescription`
in `mobile/ios/.../Info.plist`. Without these the first
`getUserMedia({audio:true})` call insta-rejects with `NotAllowedError`
before the OS prompt fires.

**Pure helpers (tested):**
- `classifyByRules`, `normalizeTranscript`, `coerceLlmAction`,
  `buildClassifierPrompt` in `src/shared/voiceClassifier.mjs`
  (tested by `src/shared/voiceClassifier.test.ts`).
- `pickRecorderMime`, `fuzzyMatchModel`, `resolveQuestionAnswer`,
  `describeVoiceAction` in `src/renderer/voice.ts` (tested by
  `src/renderer/voice.test.ts`).

**Locked decisions:**
- Modifier-based mode switch on ONE button — don't add a second
  "command" button to the composer. Mobile composer real estate is
  already tight (see "Reshaping reused ChatPanel/Terminal internals on
  mobile" above).
- **`useVoiceRecorder` owns the long-press → command promotion** — the
  button passes `start("dictate")` and the HOOK schedules the
  `longPressMs` timer that flips its own `modeRef` + the exposed
  `mode` state. The MicButton reads `mode` from the hook for its
  label. Do NOT reintroduce a parallel `modeRef` in the button —
  that was PR #4's W2 bug: the button promoted its own ref but never
  told the hook, so long-press on touch always transcribed as
  dictate. The hook's `mode` is the single source of truth.
- **`MediaRecorder.start(250)` timeslice** — without it, iOS WKWebView
  17.x sometimes delivers the final `dataavailable` AFTER `onstop`,
  leaving an empty chunks array. 250ms forces periodic emission. The
  chunks just concatenate in the Blob constructor.
- **Cancel checked AFTER `getUserMedia` resolves** — a fast press
  release (cancel before mic permission resolves) used to leave the
  recorder running until the 60s `maxDurationMs` cap. We check
  `cancelledRef.current` between the await and the recorder
  construction; if true, tear the stream tracks down and bail.
- **Phase guard uses a ref, not state** — `phaseRef.current` is
  updated synchronously by `setPhaseSync` so two `pointerdown` events
  inside the same React commit can't both pass the re-entrancy guard.
- **Voice action dispatcher picks the NEWEST pending card** via a
  local `findLast` helper, not `.find()`. Matches the visual stack:
  the topmost PermissionCard / QuestionCard is the most recent ask,
  which is what the user is looking at when they say "yes" / "reject".
- **"reject" falls through from permission to question** — when no
  permission is pending but a question is, "reject" dismisses the
  question via `rejectQuestion`. `allow-once` / `allow-always` have
  no question equivalent and surface a hint if no permission is open.
- Rules-first classifier — never go LLM-only. The bare `yes`/`no` /
  `clear` / `compact` paths fire in ~0ms with no token spend.
- Batch transcription (no streaming) — Groq's HTTP API has no native
  streaming STT endpoint and short clips return in ~200-500ms. Don't
  reintroduce a chunked-streaming spike; it under-delivered vs the
  added complexity in spike testing.
- Numeric switch-window indices in 1..9 only — both the rules
  classifier and `coerceLlmAction` reject out-of-range and string-typed
  indices, matching ⌘1..9's domain.

## File upload paths (chat-mode)

Three upload paths all land in `~/.bui-uploads/<session>/<ts>/` on the remote:

1. **Drag-drop** — `image/*`, PDF, audio, video → FilePart chip.
   Everything else → `@<abs-path>` text appended to textarea.
2. **Paste** (`⌘V` in chat input) — intercepts `image/*` clipboard items,
   calls `uploadBuffer` IPC (bytes → Mac tmpfile → scp). Same chip as drag-drop.
3. **Screenshot detector** — two parallel paths in `main/index.ts`:
   - *Clipboard poller* (500ms): fingerprints clipboard via `availableFormats()`
     + image size. Fires on `⌘⇧Control+3/4`. Pushes `screenshotDetected` IPC.
   - *Desktop watcher* (`fs.watch ~/Desktop`): matches
     `Screenshot YYYY-MM-DD at HH.MM.SS.png`. Fires on `⌘⇧3/4`. 300ms settle
     delay before pushing.
   ChatPanel shows a toast: "Screenshot in clipboard" / "Screenshot: <name>"
   with "Add to chat" (uploads + chip) and "×" dismiss.
   **Do NOT add `document.hidden` check** — bui loses focus during the screenshot
   gesture so the event would always be dropped.

`uploadBuffer` in `pty.ts`: writes `ArrayBuffer` to Mac tmpfile, calls
`uploadFiles`, `mv` on remote to restore original filename, deletes tmpfile.

## Testing

Two separate test suites — both run via `npm test`:

**Renderer** (Vitest): `src/renderer/chatUtils.test.ts`. Pure utility
functions only — no DOM, no Electron mocking. When adding logic to
`ChatPanel.tsx` expressible as a pure function, extract to `chatUtils.ts`
and add a test there. `vitest.config.ts` excludes `src/server/**`.

**Server** (node:test): `src/server/*.test.mjs` — `tmux.test.mjs`,
`events.test.mjs`, `rpc.test.mjs`, `opencode.test.mjs`, `local.test.mjs`,
`status.test.mjs`. Run standalone with `npm run test:server`. Pure logic
only — no live tmux or opencode. Add tests for any new pure-parseable logic
in the server modules.

## Custom opencode commands

Global commands (`~/.claude/commands/*.md`) are symlinked into
`~/.config/opencode/commands/` so opencode's `/command` API picks them up.
When adding a new command file: `ln -sf ~/.claude/commands/<name>.md ~/.config/opencode/commands/`
then restart the `bui-opencode` tmux session for opencode to reload.

## Work tracking (Multica)

bui has a Multica workspace for structured issue dispatch to AI agents.

- **Workspace**: https://multica.ai/better-ui (ID: `264c89bb-4659-4570-af7b-5f8daaf87985`)
- **Agent**: `better-ui-dev` (ID: `87bf6d8f-5fd0-4fb6-8dd8-a5e7c36b0747`) — OpenCode runtime, covers the full codebase
- **Skill**: `verify-build-better-ui` (ID: `95d4a528-3756-4ee0-a4e2-bf072e54399a`) — runs `npm run typecheck && npm test`

**Source of truth**: `.multica/` directory in this repo. Edit files there, commit, then push to Cloud.

```bash
# Push updated agent instructions
multica agent update 87bf6d8f-5fd0-4fb6-8dd8-a5e7c36b0747 \
  --instructions "$(cat .multica/agents/better-ui-dev.md)"

# Push updated skill
multica skill update 95d4a528-3756-4ee0-a4e2-bf072e54399a \
  --content "$(sed '/^---$/,/^---$/d' .multica/skills/verify-build/SKILL.md)"

# Push updated workspace context
multica workspace update 264c89bb-4659-4570-af7b-5f8daaf87985 \
  --context-stdin < .multica/workspace-context.md

# Create and assign an issue
multica issue create --title "..." --description "..." --project <project-id> --priority medium
multica issue assign <key> --to better-ui-dev

# Check status
multica daemon status
multica runtime list
```

Full CLI cheat sheet: `/home/dev/projects/shared/multica/setup.md`

## Open work (as of 2026-05-18)

- **Open subagent as its own chat-mode window.** Phase 1 ships read-only
  inline subagent rendering (see "Subagent rendering" section above).
  Phase 2 is the "Open as session" affordance: a button on the TaskBody
  header that creates a fresh chat-mode tmux window stamped with the
  child's existing opencode sessionId — no new opencode session. The
  plumbing is already there (`pty.ts:tmuxNewWindow`'s `existingSessionId`
  param + `maybeCreateChatSession` short-circuit; the fork handler is
  the template to copy minus the fork POST). Needs a new
  `IPC.opencodeAdoptSession` channel mirrored on desktop + mobile, with
  `rememberSessionDirectory` exported from both transports so the
  per-directory SSE stream opens before the renderer mounts the panel.
- **Global model preference** — `AppConfig.defaultModel` (Settings UI, persisted to `config.json`). New sessions and `/clear` fall back to this when no per-session localStorage entry exists. `/clear` also carries the current per-session override forward to the new session id before refresh.
- **Live refresh polling** — sidebar updates only on bui's own actions.
- **Command palette (⌘K)** — fuzzy switch + actions (~150 lines).
- **Reconnect-on-drop UI** — SSH has no reconnect banner today.
- **Mobile create flow** — `+` on the mobile session list currently only
  re-syncs; the new-session/new-project modal (desktop `Sidebar.tsx`) is not
  yet lifted into a mobile sheet.
