# bui

A macOS desktop client for working with Claude on a remote Linux box over
SSH+tmux. Sidebar of projects (tmux sessions) with multiple windows each;
xterm.js terminal in one tab type, a native React chat panel powered by
[opencode](https://opencode.ai) in the other.

The remote stays a stock tmux server — bui never installs daemons or
agents on it. Closing bui leaves your work running; reopening re-attaches.

## Status

Pre-1.0 / closed beta. macOS-only. Mobile/web client (`src/server/`) is
in-tree but descoped from this beta — ignore it.

## Requirements

**Mac (where bui runs)**
- macOS 12+ on Apple Silicon (Intel may work, untested)
- Node 20+ and `npm`
- Xcode Command Line Tools (`xcode-select --install`) — needed by
  `node-pty` to build at install time
- SSH already set up to your remote box. From a terminal:
  ```bash
  ssh user@your-box        # must succeed without typing a password
  ```
  Use an ssh-agent identity or an entry in `~/.ssh/config`. bui shells out
  to your system `ssh`; it does not manage keys.

**Remote (your own Linux box — VPS, dev server, whatever)**
- `tmux` 3.0+
- `git` (used by the new-project worktree detector)
- For chat mode (optional): `opencode` and a Claude account. Both can be
  installed by the in-app "Bootstrap remote" button, or manually:
  ```bash
  curl -fsSL https://opencode.ai/install | bash
  # then on the remote:
  opencode auth login anthropic
  ```

Mosh is supported but optional — bui auto-detects it on both ends and
falls back to plain SSH. Install with `brew install mosh` locally and
`apt install mosh` (or equivalent) on the remote if you want resilient
mobile connections.

## Run

```bash
npm install
npm run dev
```

No packaged binary yet — a tester runs from source. First launch opens
Settings; fill in:

1. **Remote host** (hostname or IP)
2. **User** (optional — falls back to `~/.ssh/config`)
3. **Identity file** (optional — same)

Click **Save**, then **Test connection** to verify ssh / tmux / opencode
status. If opencode isn't installed yet, **Bootstrap remote** runs the
official installer and writes a minimal `~/.config/opencode/opencode.jsonc`
on the remote. After that, run `opencode auth login anthropic` on the
remote yourself once (the wizard surfaces the exact command) — it opens a
browser flow that can't be driven over ssh.

Optional: in the "Remote tmux config" section, click **Set up tmux config**
to append a small fenced block to your remote `~/.tmux.conf` (mouse on,
status off, allow-passthrough on, snappy escape). bui works without it but
the experience is a bit nicer with it on. Restorable from the same panel.

## Two tab types

- **Terminal window** — xterm.js attached to a tmux window. Same UX as
  `ssh user@host -t tmux a -t name`. Drop-in for any existing tmux
  workflow (claude TUI, vim, REPLs, ad-hoc shells).
- **Chat window** — bui's own React chat panel, backed by opencode. Tool
  calls, permission prompts, slash commands, model picker, file mentions,
  drag-and-drop image / PDF / file attachments, screenshot detection on
  Mac. Requires the chat-mode setup above.

The two coexist: each tmux window is one or the other (recognized by a
`@bui-session-id` tmux user-option).

## Keybindings

| Key | Action |
|-----|--------|
| ⌘N | New project |
| ⌘T | New session in active project |
| ⌘1..9 | Jump to nth (project, window) in sidebar |
| ⌥⌘↑ / ⌥⌘↓ | Step prev/next session |
| ⌘, | Settings |
| ⌘C / ⌘V | Copy / paste (terminal) |
| ⌘F | Search scrollback (terminal) |
| ⌘K | Clear scrollback (terminal) |
| Shift+Enter | Newline in claude TUI (matches iTerm2) |

## Where state lives

- **Mac**: `<userData>/config.json` — host, user, identity file, project
  metadata (default cwd per project), settings.
- **Remote**: tmux sessions/windows are the source of truth.
  - `~/.bui-uploads/<session>/<batch>/` — drag-and-drop attachments. Auto
    cleaned hourly (configurable in Settings; `0` disables).
  - `~/.tmux.conf.pre-bui` — backup of your tmux config if you opted in
    to the bui tmux setup.
  - `~/.config/opencode/opencode.jsonc` — opencode config. Bootstrap writes
    a minimal one; if you had your own, it's backed up to `.pre-bui`.
  - tmux session `bui-opencode` — bui's chat-mode windows talk to a
    long-running `opencode serve` on `127.0.0.1:4096`, tunneled to the Mac
    over SSH `-L 14096:127.0.0.1:4096`. Survives bui restarts.

## Known beta gaps

- No packaged `.app` / `.dmg` — install with `npm install && npm run dev`.
- No auto-update; pull from git for new versions.
- macOS only. Windows/Linux desktop probably needs a few small fixes
  (screenshot detector is already gated; ⌘ keybindings accept Ctrl, but
  the build hasn't been tested).
- Mobile/web client (`src/server/` + `mobile/`) is in-tree but not part of
  this beta. It runs but needs its own setup (Capacitor + tunnel) and
  isn't documented for external testers.
- `npm run dev` requires the preload bundle to be rebuilt — main-process
  changes need a full Ctrl+C + restart, not just HMR.

## Reporting issues

Filing issues in the private GitHub repo or pinging the maintainer
directly is the fastest path. Useful info to include:

- macOS version + Mac chip
- Remote OS + tmux version (`tmux -V`)
- opencode version on the remote (`opencode --version`)
- What you clicked + what you expected vs. what you got
- DevTools console errors (View → Toggle Developer Tools)

For chat-mode issues, the main-process log is on stdout where you ran
`npm run dev` — lines starting with `[opencode-bus]` are particularly
useful for "messages not showing up" bugs.
