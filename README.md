<img src="docs/brand/manta-logo.png" alt="Manta" width="72" />

# Manta UI

Electron + mobile/web client for driving remote `claude` / opencode coding
sessions over HTTPS, from desktop or phone.

Sidebar of projects (tmux sessions) with multiple windows each; xterm.js
terminal in one tab type, a native React chat panel powered by
[opencode](https://opencode.ai) in the other.

The remote stays a stock tmux server — Manta never installs daemons or
agents on it. Closing Manta leaves your work running; reopening re-attaches.

## Status

Pre-1.0 / closed beta. macOS-only. Mobile/web client (`src/server/`) is
in-tree but descoped from this beta — ignore it.

## Requirements

**Mac (where Manta runs)**
- macOS 12+ on Apple Silicon (Intel may work, untested)
- Node 20+ and `npm`
- Xcode Command Line Tools (`xcode-select --install`) — needed by
  `node-pty` to build at install time

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

## Run

```bash
npm install
npm run dev
```

No packaged binary yet — a tester runs from source. First launch opens
the onboarding flow:

1. **Pair with your box.** Run the self-install script on your Linux box:
   ```bash
   curl -fsSL https://app.mantaui.com/install.sh | bash
   ```
   It installs bui-server, starts it, and prints a 6-digit pairing code.
   Enter the code in the Manta onboarding screen (along with your box's URL).
2. **Pick AI providers.** After pairing, select which providers to use
   (Anthropic comes pre-connected via opencode auth; add OpenAI/DeepSeek/etc.
   with your own API keys).
3. **Create your first project.** Enter a directory path, and Manta creates
   a tmux session for it.

Optional: in the "Remote tmux config" section, click **Set up tmux config**
to append a small fenced block to your remote `~/.tmux.conf` (mouse on,
status off, allow-passthrough on, snappy escape). Manta works without it but
the experience is a bit nicer with it on. Restorable from the same panel.

## Two tab types

- **Terminal window** — xterm.js attached to a tmux window. Same UX as
  `ssh user@host -t tmux a -t name`. Drop-in for any existing tmux
  workflow (claude TUI, vim, REPLs, ad-hoc shells).
- **Chat window** — Manta's own React chat panel, backed by opencode. Tool
  calls, permission prompts, slash commands, model picker, file mentions,
  drag-and-drop image / PDF / file attachments, screenshot detection on
  Mac. Requires the chat-mode setup above.

The two coexist: each tmux window is one or the other (recognized by a
`@manta-session-id` tmux user-option).

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

- **Mac**: `<userData>/config.json` — `serverUrl`, `boxId`, `boxToken`, project
  metadata (default cwd per project), settings.
- **Remote**: tmux sessions/windows are the source of truth.
  - `~/.manta-uploads/<session>/<batch>/` — drag-and-drop attachments. Auto
    cleaned hourly (configurable in Settings; `0` disables).
  - `~/.tmux.conf.pre-manta` — backup of your tmux config if you opted in
    to the Manta tmux setup.
  - `~/.config/opencode/opencode.jsonc` — opencode config. Bootstrap writes
    a minimal one; if you had your own, it's backed up to `.pre-manta`.
  - the **`opencode-serve` systemd --user service** (NOT a `bui-opencode` tmux
    session — that reference elsewhere is stale) — chat-mode windows talk to
    this long-running `opencode serve` on `127.0.0.1:4096`, proxied by
    bui-server (no SSH hop). Survives Manta restarts.

## Box server (mobile/web) — self-install

The box server (`src/server/`) powers the mobile/web client and the desktop
pairing flow. On a fresh Linux VPS, one command installs and starts it and
prints a 6-digit pairing code to enter in the desktop app:

```bash
curl -fsSL https://app.mantaui.com/install.sh | bash
```

The installer downloads a pre-built release tarball (no dev toolchain needed on
the box), runs `npm ci --omit=dev`, installs a `systemd --user` unit
(`manta-server.service`), waits for the server to come up on `127.0.0.1:8787`, then
runs `bui pair` and prints the code. Re-running upgrades in place and **preserves
your box identity** in `~/.manta/` — the server owns identity (`ensureAuth`
in `src/server/auth.mjs`); the installer never regenerates it.

Overrides (env):

| Var | Default | Purpose |
|-----|---------|---------|
| `MANTA_TARBALL_URL` | (built from host+version) | full tarball URL — local testing / mirror |
| `MANTA_RELEASE_HOST` | `https://app.mantaui.com` | host for the default tarball URL |
| `MANTA_HOME` | `~/bui` | where the code is unpacked |
| `MANTA_MOBILE_PORT` | `8787` | server port |

Manage it: `systemctl --user {status,restart} bui-server`, logs
`journalctl --user -u bui-server -f`. Mint a fresh pairing code any time with
`bui pair` (or `npm run pair` from `~/bui`) — each new code supersedes the last.

Exposing the box to your phone/desktop is up to you in v1 (Tailscale/VPN, a
reverse proxy to `127.0.0.1:8787`, or the documented cloudflared setup). The
operated relay replaces this later.

### Manual install (fallback — no release tarball)

If you'd rather clone the repo directly (e.g. during development, or before a
release tarball exists):

```bash
git clone git@github.com:antoinedc/MantaUI.git ~/bui
cd ~/bui
npm install
npm run build:mobile        # build the renderer bundle into mobile/www/
npm run mobile              # start the server on 0.0.0.0:8787 (MANTA_MOBILE_HOST/PORT override)
```

Then, on the box, mint a pairing code:

```bash
npm run pair               # GET 127.0.0.1:8787/auth/pair, prints the code
```

To run it under systemd yourself, copy `scripts/systemd/manta-server.service`,
substitute the `@@MANTA_HOME@@` / `@@NODE_BIN@@` / `@@MANTA_PORT@@` placeholders,
drop it in `~/.config/systemd/user/`, then
`systemctl --user daemon-reload && systemctl --user enable --now bui-server`
(and `loginctl enable-linger $USER` so it survives logout).

### Cutting a release tarball

`npm run pack` builds the renderer and produces `dist/bui-<version>.tar.gz`
(shipping a pre-built `mobile/www/`, so the box needs no renderer toolchain).
Upload it to `<release-host>/releases/bui-<version>.tar.gz`.

## Building the desktop app

To build a packaged `.dmg` (macOS) or `.AppImage` (Linux):

```bash
npm run pack:desktop
```

This runs `electron-vite build` to bundle the app, then `electron-builder` to
produce the platform-specific artifact in `dist/desktop/`. Auto-update is
configured to use GitHub Releases — after a build, `electron-builder` uploads
the artifact and generates a `latest.yml` for `electron-updater` to consume.

Signing identities (macOS code signing + notarization) are read from
environment variables (`CSC_LINK`, `CSC_KEY_PASSWORD`) and are NOT committed
to the repo. Set them in CI or locally before building.

## Known beta gaps

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
