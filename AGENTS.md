# AGENTS.md — context for future sessions

bui is an Electron desktop client for remote `claude` over `ssh`+`tmux`. Pipeline:
**xterm.js (renderer)** ↔ **node-pty (main)** ↔ **ssh/mosh** ↔ **tmux** ↔ **claude**.

See `README.md` for user-facing intro and `HANDOFF.md` for the most recent
session-state snapshot.

## Layout

- `src/main/` — Electron main: pty, transport, tmux primitives, config, IPC.
- `src/renderer/` — React + xterm.js. `Terminal.tsx` is the only place that
  owns an xterm instance.
- `src/preload/` — typed `window.api` bridge.

## Build / run

```
npm install
npm run typecheck
npm run dev      # main-process AND preload changes need a full Ctrl+C + restart
```

The preload bundle is built once at dev-server start; renderer HMR alone won't
pick up new `window.api` methods. If you add an IPC channel and don't see it
on `window.api`, you didn't restart.

Local git repo (initialized 2026-05-14); user rsyncs / pulls to a Mac to run.

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
