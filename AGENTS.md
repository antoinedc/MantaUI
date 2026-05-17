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
    `formatDuration`, `ctxStageColor`, `filterCommands`, `dedupeAgainstBuiltins`).
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
- **Local config** (`<userData>/config.json`): `{host, user, identityFile, transport, projects[{tmuxSession, defaultCwd}], opencodePort, chatAutoAllow, defaultModel}`.
- **No local sessions table.** Project = tmux session, app session = tmux window.

## Patterns worth knowing

- **New window cwd inheritance** — desktop: `index.ts` `tmuxNewWindow` handler
  resolves cwd as `input.cwd || project.defaultCwd || "~"`. Mobile server
  (`rpc.mjs` `tmux:new-window`): does the same config lookup when `cwd` is
  absent — without it, tmux silently inherits `$HOME`. Always pass or resolve
  `defaultCwd`; never let the fallback reach tmux unchecked.
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
picks its own default.

**v2-only endpoints** (used alongside the v1 base):
- `GET /question` — list pending Question tool requests
- `POST /question/{id}/reply` — body `{answers: string[][]}` (one array of selected
  option labels per question)
- `POST /question/{id}/reject` — dismiss without answering
- `GET /vcs?directory=<cwd>` — `{branch?, default_branch?}` for the session cwd.
  Initial value for the `⎇ <branch>` footer (the SSE event below only fires on
  change). Exposed as `window.api.opencodeVcsBranch(directory)` —
  `opencode:vcs-branch` IPC.
- SSE events consumed in ChatPanel's `onOpencodeEvent` handler beyond the
  basics (`session.idle/status/error/compacted`, `message.part.*`, `permission.*`,
  `question.*`):
  - `session.next.step.ended` — live token/cost snapshot. `stepTokens` state
    is preferred over the transcript-scraped `latestTokens` so the footer
    ctx bar updates between tool calls, not just on re-fetch. `finish ===
    "max_tokens"` also pre-seeds `sendError` with a truncation message
    (without clobbering a more-specific `session.error`).
  - `session.next.compaction.{started,delta,ended}` — drives the inline
    `CompactionCard` above the running indicator. `.ended` holds the
    "Compacted" confirmation for 2.5s then clears (the `session.compacted`
    refetch has landed by then).
  - `todo.updated` — `liveTodos` state, preferred over transcript-scraped
    `activeTodos`. Lets the `ActiveTodos` card flip items between
    in_progress/completed live.
  - `vcs.branch.updated` — keeps the footer's branch indicator current.
    Properties have no `sessionID` so the early sessionID filter at the top
    of `onOpencodeEvent` short-circuits (undefined → falsy).
  - `session.status` with `type === "retry"` — drives the `RetryCard` above
    the running indicator with `attempt`, `message`, and an optional
    `action {title, message, label, link?}`. Cleared on next `busy`/`idle`.

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
- `branch` is pure state (initial fetch + `vcs.branch.updated`)
When adding a new live-event consumer in ChatPanel, follow the same shape:
`useState` reset on session change, set in the SSE handler, consumed via a
`liveX ?? transcript-derived` selector. Don't try to mutate messages
in-place — the canonical refetch will overwrite you.

**Typed `session.error` names.** The `session.error` handler switches on
`err.name` to prepend a context-appropriate prefix before the raw message:
`ProviderAuthError` → "Auth error: …", `ContextOverflowError` → "Context
full — try /compact: …", `MessageOutputLengthError` → "Response truncated
(hit output limit)", `StructuredOutputError`, `ApiError`. Add new branches
when opencode introduces new error class names; unknown names fall through
to the raw message.

**Gotchas**:
- Sessions persist FileParts forever. A bad-mime FilePart (e.g. `application/json`)
  in history causes every subsequent Anthropic call to fail. Fix:
  `DELETE /session/{sid}/message/{mid}/part/{pid}` on each offender.
- `/api/model` leaks `apiKey` — never forward it. Use `/provider` instead
  (already done in `opencode.ts`).
- The `/question` endpoint returns 404 on older opencode servers (pre-v2). The
  fetch in ChatPanel is wrapped in `.catch(() => {})` — non-fatal.
- `GET /vcs` returns 200 with `{branch: null}` for non-git cwds. Coalesce to
  `null` in the renderer; don't treat as error.
- `vcs.branch.updated` events carry no `sessionID` — they pass the
  per-session filter by accident. Acceptable: there's only one branch per
  cwd, but be aware if you ever scope event handling more strictly.

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

## Open work (as of 2026-05-17)

- **Subagent / Task tool rendering in chat-mode.** `task` tool part falls
  through to the generic `default:` branch of `ToolBody`. v2 SDK exposes
  `session.created` with `parentID` + `session.next.tool.*` events for inline
  child rows. Needs per-session debounce map + allowing child session ids
  through the early sessionID filter in `onOpencodeEvent`.
- **Global model preference** — `AppConfig.defaultModel` (Settings UI, persisted to `config.json`). New sessions and `/clear` fall back to this when no per-session localStorage entry exists. `/clear` also carries the current per-session override forward to the new session id before refresh.
- **Live refresh polling** — sidebar updates only on bui's own actions.
- **Command palette (⌘K)** — fuzzy switch + actions (~150 lines).
- **Reconnect-on-drop UI** — SSH has no reconnect banner today.
- **Mobile create flow** — `+` on the mobile session list currently only
  re-syncs; the new-session/new-project modal (desktop `Sidebar.tsx`) is not
  yet lifted into a mobile sheet.
