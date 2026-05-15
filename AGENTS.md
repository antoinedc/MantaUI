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
  owns an xterm instance. `ChatPanel.tsx` is the entire chat-mode UI (~3400 LoC).
- `src/preload/` — typed `window.api` bridge.
- `src/server/` — standalone Node HTTP+WS server + plain-JS web client for
  mobile access. Runs **on the Linux box**, not the Mac. No build step.

## Build / run

```
npm install
npm run typecheck
npm run dev      # main-process AND preload changes need a full Ctrl+C + restart
npm run mobile   # mobile/web server on $BUI_MOBILE_HOST:$BUI_MOBILE_PORT (default 0.0.0.0:8787)
```

The preload bundle is built once at dev-server start; renderer HMR alone won't
pick up new `window.api` methods. If you add an IPC channel and don't see it
on `window.api`, you didn't restart.

Local git repo (initialized 2026-05-14); user rsyncs / pulls to a Mac to run.
Commit as you go — `git log` is the cross-session audit trail. No remote yet.

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

Second front-end alongside the Electron app. A small Node HTTP+WS server runs
**on the Linux box itself** (the box that hosts tmux), serving a touch-friendly
single-page client. No ssh/mosh hop — tmux and node-pty live in the same
process. Use case: get to your sessions from a phone with nothing installed
on the device.

`index.mjs` is plain JS (no TS, no bundler) so `node` runs it directly. The
client UI is hand-written HTML + JS in `public/{index.html,app.js}`; vendored
`xterm` and `addon-fit` are served straight out of `node_modules/` at
`/vendor/*`. If this grows past a screen of state, add a build step — for
now the lack of one is the point.

**No auth in v1.** Anyone who can reach the port gets shell-attach to every
tmux session running as this user. Default bind is `0.0.0.0:8787` — fine on
a LAN or behind Tailscale, **catastrophic** on a public-IP box. For internet
access, bind to `127.0.0.1` (`BUI_MOBILE_HOST=127.0.0.1`) and front it with
`cloudflared tunnel --url http://127.0.0.1:8787 --protocol http2`. The
`--protocol http2` flag matters here: QUIC handshake fails on this box
("control stream encountered a failure" loop), HTTP/2 connects cleanly.

**WS protocol** (`/pty?session=NAME&window=N&cols=&rows=`): client→server
text frames are JSON `{type:"data",data}` or `{type:"resize",cols,rows}`;
server→client frames are raw PTY output. One node-pty per connection,
killed on socket close. Session name is regex-restricted to
`[A-Za-z0-9._-]+` before being passed to `tmux attach-session -t`.

**Upload endpoint** (`POST /api/upload?session=NAME`) takes raw bytes in the
body plus headers `X-Filename` (URL-encoded basename) and `X-Batch-Id`
(millis). Files land in `$HOME/.bui-uploads/<session>/<batch>/<file>` — the
**same layout as the Electron drag-drop path**, so the existing hourly
cleanup applies whenever the Electron app is running against this same box.
No multipart parser on purpose. The client types the returned path into the
active PTY at the cursor (single-quoted only if it contains shell-meta).

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
- **Local config** (`<userData>/config.json`): only `{host, user, identityFile, transport, projects[{tmuxSession, defaultCwd}]}`.
- **No local sessions table.** Project = tmux session, app session = tmux window.

## Patterns worth knowing

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
| `src/renderer/ChatPanel.tsx` | entire chat UI (~3400 LoC), intentionally monolithic |
| `src/renderer/App.tsx` | mounts ChatPanels keyed by session id |

**AppConfig additions**: `opencodePort` (default 14096), `chatAutoAllow`
(auto-reply "always" to all permission requests — like `--dangerously-skip-permissions`).

**Gotchas**:
- Sessions persist FileParts forever. A bad-mime FilePart (e.g. `application/json`)
  in history causes every subsequent Anthropic call to fail. Fix:
  `DELETE /session/{sid}/message/{mid}/part/{pid}` on each offender.
- `/api/model` leaks `apiKey` — never forward it. Use `/provider` instead
  (already done in `opencode.ts`).
- Mobile path (`src/server/index.mjs`) is NOT shimmed for any of the chat-mode
  IPCs. Whoever lands mobile needs to add those shims.

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

## Suggested next moves (as of 2026-05-15)

- **Mobile responsive layout** — biggest remaining item. ChatPanel already uses
  only `window.api.*`; main work is sidebar-as-drawer + touch targets + IPC
  shims in `src/server/index.mjs`.
- **Tests** — none for chat UI yet.
- **Global model preference** — currently per-session in localStorage.
- **Remove debug logs** from screenshot detector once confirmed stable
  (`[screenshot]` prefixed `console.log` calls in `main/index.ts`).
