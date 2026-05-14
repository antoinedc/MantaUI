# better-ui

A desktop client for remote Claude Code sessions. Replaces the clank-style
"SSH into a tmux holding `claude`" workflow with a real app: project sidebar,
multiple sessions, native scrollback, native copy/paste, native search.

Architecture is intentionally thin:

- **Local (Electron)**: spawns `ssh` as a PTY subprocess via `node-pty`,
  pipes stdio to xterm.js in the renderer.
- **Remote**: nothing custom — just `ssh`, `tmux`, and `claude` in `$PATH`.
  Each session is a tmux session named `claude-<uuid>`. Persistence is
  free — closing the app leaves sessions running; reopening re-attaches.

## Requirements

**Mac (where the app runs)**
- Node 20+
- Xcode CLT (for `node-pty` native build): `xcode-select --install`
- `ssh` configured so `ssh user@host` works without prompts (key in agent or
  `~/.ssh/config` set up — the app shells out to system ssh).

**Remote**
- `tmux` ≥ 3.0
- `claude` in `$PATH`
- ssh server (assumed)

## Run (dev)

```bash
npm install
npm run dev
```

First launch opens Settings — enter your remote host (and optionally user /
identity file). Then create a project (name + default cwd on the remote),
then a session under it.

## Build

```bash
npm run build
```

Produces `out/{main,preload,renderer}/`. Wrap with `electron-builder` later
to ship a `.app`.

## Keybindings (current)

| Key | Action |
|-----|--------|
| `Cmd+,` | Open Settings |
| `Cmd+1..9` | Switch to session 1..9 in active project |
| `Cmd+C` (selection) | Copy to system clipboard |
| `Cmd+V` | Paste into terminal |
| `Cmd+F` | Search in scrollback (prompt-based, will get a real bar) |
| `Cmd+K` | Clear scrollback |
| `Ctrl+C` (no selection) | SIGINT (passes through) |

## Where state lives

`<userData>/config.json` — projects, sessions, ssh target. Single JSON file,
no SQLite for the MVP.

On the remote, state lives in tmux. Inspect with `tmux ls` on the host.

## Known MVP gaps

- Settings UI is the only way to configure the host (no host picker / multi-host)
- Search is a `prompt()` instead of an inline bar
- No command palette yet (Cmd+K is taken by clear; will likely move)
- No session rename
- No "reconnecting…" banner — if SSH dies the terminal just freezes; you
  currently delete the session and create a new one (tmux state is preserved)
- Reconnect-on-resume is not automatic; closing/reopening a session re-attaches
  cleanly because of tmux, but transient SSH drops aren't auto-reconnected mid-session

## Why no Tauri

The plan is Tauri (smaller, faster). Going Electron-first avoids needing the
Rust toolchain and lets us iterate on the UX which is the part that actually
matters. Once the UX feels right, porting the main process to Rust is mechanical.
