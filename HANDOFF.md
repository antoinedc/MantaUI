# bui — handoff for next session

## What this project is

bui is an Electron desktop app for working with claude-code remotely. It replaces clank-style "ssh into a tmux holding `claude`" workflows with a real macOS app: project sidebar, multiple sessions per project, native scrollback/copy/paste/keybindings, mosh-or-ssh transport with auto-detection.

Source: `/home/dev/projects/better-ui/` on the remote (157.90.224.92, user `dev`). Builds + runs on Mac via `npm install && npm run dev` after rsync/git pull.

## Architecture (current)

**Thin layer over tmux.** Tmux on the remote is the source of truth. The app is just a UI client.

- **Project = tmux session, app session = tmux window.** Sidebar reads from `tmux list-sessions` + `tmux list-windows -a`. No local sessions table.
- **Local config** (`<userData>/config.json`): only `{ host, user, identityFile, projects[{tmuxSession, defaultCwd}], transport }`. Projects entry exists *only* to remember `defaultCwd` per session (UI convenience).
- **Shared default tmux socket** — bui sees what `tmux ls` would show (Capo, Ethernal, Leasebot, Ronda, UI, etc.). Designed to be a drop-in for existing tmux users.
- **One SSH/mosh PTY per active project.** Switching sessions within a project = `tmux select-window` over a side-channel SSH (no PTY reconnect).
- **Transport**: auto-detects mosh on both ends. Mosh local at `/opt/homebrew/bin/mosh`, mosh-server is on remote. Settings has `Auto / Mosh / SSH` dropdown. Title-bar badge shows `mosh` (green) or `ssh` (gray).

## Current code state

- `src/main/pty.ts` — tmux primitives (list, new-session, new-window, rename, kill, select-window). spawnPty (mosh-or-ssh + tmux attach). Includes `tmuxConfigStatus`, `tmuxSetupConfig`, `tmuxRestoreConfig` for managing the user's `~/.tmux.conf` (append a fenced bui block / restore from backup). No runtime mouse override — that experiment was reverted.
- `src/main/transport.ts` — local + remote mosh detection, cached.
- `src/main/index.ts` — IPC handlers. `tmuxSetupConfig` is opt-in via the Settings UI only (no auto-run on refresh).
- `src/main/config.ts` — load/save local config with migration from old shape.
- `src/preload/index.ts` — typed `window.api`.
- `src/renderer/Terminal.tsx` — xterm.js per project, kept mounted. Cmd+C copy / Cmd+V paste / Cmd+F search / Cmd+K clear scrollback. Custom OSC 52 handler that goes through Electron main-process clipboard (see "What works" #5).
- `src/renderer/Sidebar.tsx` — tree of projects + sessions, inline rename (double-click), per-project + and × buttons, 2-button kill confirm.
- `src/renderer/App.tsx` — keybindings: Cmd+T new session, Cmd+Shift+T new project, Cmd+1..9 switch, Cmd+, settings.
- `src/renderer/Settings.tsx` — host/user/identity, transport, restore-tmux-config button.

## What works

1. Project + session CRUD (create, rename, kill) — all proper tmux operations under the hood.
2. Inline rename (double-click name).
3. Sidebar shows all tmux sessions on the remote (synced clank's old sessions too).
4. SSH and mosh transports both work; auto-detect; manual override in settings.
5. **OSC 52 → Mac clipboard (when bytes arrive)** — custom OSC handler in xterm.js fires `window.api.clipboardWriteText` which uses Electron's main-process `clipboard` module. Verified working when invoked via `_term.write('\x1b]52;c;<b64>\x1b\\')` in DevTools.
6. Cmd+V paste from clipboard works fine.
7. Cmd+T / Cmd+Shift+T / Cmd+1..9 keybindings.
8. Wheel scroll enters tmux's native scroll mode (with `mouse on` in tmux).
9. Cramping fix: ResizeObserver skips fit when container is hidden, so scrollback doesn't get crammed at min width when switching away.

## Mouse mode — native parity (current design)

Mouse mode stays ON through the whole pipeline: tmux passes through, claude
receives mouse events natively, wheel scrolls claude's conversation, drag-
select goes to claude. This matches how claude behaves in any native
terminal (iTerm2, Terminal.app, Alacritty).

Earlier in this project an "xterm.js owns the mouse" design was tried —
`tmux set -g mouse off` plus `CLAUDE_CODE_DISABLE_MOUSE=1` so xterm.js could
handle drag-select natively. It broke wheel-scroll inside the claude TUI:
xterm.js falls back to wheel→arrow keys in alt-screen, and claude treats
up/down as prompt-history. Claude reports it directly with a "Scroll wheel
is sending arrow keys" hint. That whole approach is reverted — see
`AGENTS.md` for the do-not-relitigate notes.

If drag-select "snaps to bottom" while you're in shell scrollback (not the
claude TUI), the cause is a tmux `MouseDragEnd1Pane → copy-pipe-and-cancel`
binding — `-and-cancel` exits copy mode and tmux snaps the viewport. Fix is
tmux-side (e.g. `copy-pipe-no-clear` + `set-clipboard external`). Claude TUI
itself does not enter tmux copy mode for drags.

Cmd+C in xterm.js still works for selections that originate client-side
(shell scrollback, or Shift+drag if the user wants to bypass the inner
app's mouse capture).

## What hasn't been built

From the roadmap (in priority order):
1. **Command palette (Cmd+K)** — fuzzy switch projects/sessions + actions (rename, kill, new). ~150 lines.
2. **Reconnect-on-drop UI** — currently mosh handles silently; for SSH there's no banner.
3. **Live refresh polling** — sidebar only updates after our own actions; if user creates a session in another tmux client we don't notice.
4. **Drag-and-drop reordering** — `tmux swap-window` / `move-window`.
5. **Right-click context menus.**

## Key environment

- Server: `dev@157.90.224.92`, tmux 3.4, mosh-server installed.
- Mac: mosh installed (`/opt/homebrew/bin/mosh`), Node 20+.
- Backups on server: `~/.tmux.conf.pre-bui` (symlink to a timestamped file in `~/`).
- Node deps install + native rebuild work cleanly. `npm run typecheck && npm run build` passes.

## Build / test

```bash
cd /home/dev/projects/better-ui
npm install
npm run typecheck
npm run build
npm run dev    # full Electron + Vite dev mode
```

User runs `npm run dev` on the Mac after rsync; main-process changes require a full Ctrl+C + restart of `npm run dev`, not just HMR.
