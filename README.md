<img src="docs/brand/manta-logo.png" alt="Manta" width="72" />

# Manta UI

Drive `claude` / [opencode](https://opencode.ai) coding sessions running on
your own Linux box, from a desktop app or your phone — terminal and native
chat, over plain HTTPS. The box stays a stock tmux server; closing Manta
leaves your work running, reopening re-attaches.

## AI-assisted setup

Setting up with an AI agent (claude code, opencode, …)? Paste this prompt into
an agent **running on the Linux box** you want to drive:

```
Set up this box as a Manta UI box server. Steps:
1. Run: curl -fsSL https://mantaui.com/install.sh | bash
   It installs the manta box server (~/manta), a systemd --user unit
   (manta-server, port 8787 loopback), enables linger, and prints a 6-digit
   pairing code + the box id. Show me the pairing code and keep the box id.
2. Verify health: systemctl --user status manta-server should be active;
   curl -s http://127.0.0.1:8787/auth/pair mints a fresh code if the first
   one expired (codes are one-time, 5-minute TTL).
3. Chat mode needs opencode: check `opencode --version`; if missing run
   curl -fsSL https://opencode.ai/install | bash. Ensure a systemd --user
   unit runs `opencode serve --port 4096 --hostname 127.0.0.1` (template in
   scripts/systemd/ of ~/manta), and that ~/.config/opencode/opencode.jsonc
   lists the "opencode-claude-auth@latest" plugin (merge, don't clobber).
   I already have claude authenticated on this box (~/.claude), which that
   plugin reuses. Copy ~/manta/docs/opencode-tools/*.ts (real copies, NOT
   symlinks) into ~/.config/opencode/tools/ and append
   ~/manta/docs/opencode-tools/AGENTS.md to ~/.config/opencode/AGENTS.md
   if not already present. Restart opencode-serve.
4. Confirm tmux is installed (hard requirement) and tell me:
   the pairing code, the box id, and whether relay connectivity to
   wss://relay.mantaui.com is up (journalctl --user -u manta-server).
Do not regenerate ~/.manta/auth.json if it exists — that would unpair
every device.
```

Then install the desktop app from [mantaui.com](https://mantaui.com), enter
the pairing code, and get to work.

## How it works

```
 Desktop app (Electron)         Phone (PWA / app)
        │                              │
        └──────────── HTTPS ───────────┘
                       │
        ┌──────────────┴────────────────┐
        │ direct: https://<your-host>   │   ← you bring ingress (tunnel/VPN)
        │ relay:  relay.mantaui.com     │   ← zero inbound setup (box dials out)
        └──────────────┬────────────────┘
                       │
               YOUR LINUX BOX
      manta-server (:8787, loopback)  ── owns tmux, files, config,
        ├── tmux ── your sessions        schedules, secrets, webhooks, push
        └── opencode-serve (:4096) ───── chat mode + AI tools
```

- **The server IS the box.** Everything — sessions, transcripts, uploads,
  schedules, secrets — lives on the Linux box in `~/.manta*`. The desktop and
  phone are thin clients over the same `/rpc` + `/events` (SSE) HTTP surface;
  the desktop only adds OS bridges (clipboard, screenshot, file peek).
- **Auth**: every data route requires `Authorization: Bearer <box_token>`.
  Devices obtain it once via a 6-digit, one-time, 5-minute pairing code
  (minted loopback-only on the box: `curl -s 127.0.0.1:8787/auth/pair`).
  Box identity persists in `~/.manta/auth.json` — never regenerate it.
- **Two window types** per tmux window: a raw **terminal** (xterm.js attached
  over a WebSocket PTY) or a **chat panel** (opencode session; recognized by
  the `@manta-session-id` tmux user-option). They coexist freely.
- **Connectivity**: today a box is reached directly (any HTTPS ingress you
  like — cloudflared, Tailscale, reverse proxy). The **relay**
  (`relay.mantaui.com`) is rolling out as the default: the box dials OUT a
  WebSocket tunnel, devices connect to `relay.mantaui.com/box/<box_id>`, and
  no inbound networking is needed on the box at all. Usage metering and the
  subscription gate live at the relay.

## Quick start (human version)

**On your Linux box** (needs `tmux`; chat mode also needs a working claude
login):

```bash
curl -fsSL https://mantaui.com/install.sh | bash
```

Prints a pairing code. Re-running upgrades in place and preserves identity.

**On your Mac**: download the app from [mantaui.com](https://mantaui.com)
(or run from source: `npm install && npm run dev`), enter the pairing code in
onboarding, pick providers, create your first project (a tmux session).

**On your phone**: open your box's URL (or the relay), add to home screen,
pair with a fresh code. Web Push notifications for permissions/questions/
errors/done work from the PWA.

## Components & where they run

| Component | Where | What |
|---|---|---|
| `manta-server` (`src/server/`) | your box, `127.0.0.1:8787`, systemd --user | THE server: tmux CRUD, PTY WS, opencode proxy, config, schedules, secrets, webhooks, serve-page, Web Push, auth |
| `opencode-serve` | your box, `127.0.0.1:4096`, systemd --user | chat-mode backend (opencode + claude auth plugin) |
| desktop app (`src/main`, `src/preload`, `src/renderer`) | your Mac | thin client + OS bridges; pairing flow |
| mobile client (`mobile/www`, built from `src/renderer`) | served by manta-server | PWA / Capacitor wrapper (same React code as desktop) |
| relay (`src/relay/`) | our infra, `relay.mantaui.com` | box WS dial-out + device HTTP proxy + metering + subscription gate |
| marketing + releases (`website/`, `scripts/install.sh`) | our infra, `mantaui.com` | static site, `install.sh`, release tarballs, desktop binaries |

### State on the box

- `~/.manta/` — identity (`auth.json`), `config.json`, schedules, secrets
  store, webhooks, VAPID keys, served pages
- `~/.manta-uploads/<session>/<batch>/` — attachments (hourly auto-clean)
- `~/.manta-outbox/` — agent→you file handoff (one-shot mailbox)
- `~/.manta-secrets/` — materialized secret files (0600), used by reference
- `~/.config/opencode/` — opencode config, the manta AI tools, agent guidance
- `~/.tmux.conf.pre-manta` — backup if you opted into the tmux config setup

### Ports (all loopback on the box)

| Port | Service |
|---|---|
| 8787 | manta-server (HTTP + WS + SSE) |
| 4096 | opencode-serve |
| 20080 | serve-page file server (behind `*.pages.<domain>` vhost) |
| 20787 | relay (on the relay host only) |

## Installer reference

The installer downloads a pre-built tarball (no dev toolchain needed on the
box), runs `npm ci --omit=dev`, installs the `manta-server` systemd --user
unit, enables linger, health-waits, and prints a pairing code.

Overrides (env):

| Var | Default | Purpose |
|-----|---------|---------|
| `MANTA_TARBALL_URL` | (built from host+version) | full tarball URL — local testing / mirror |
| `MANTA_RELEASE_HOST` | `https://mantaui.com` | host for the default tarball URL |
| `MANTA_HOME` | `~/manta` | where the code is unpacked |
| `MANTA_MOBILE_PORT` | `8787` | server port |

Manage: `systemctl --user {status,restart} manta-server`, logs
`journalctl --user -u manta-server -f`. Fresh pairing code: `npm run pair`
from `~/manta` (each new code supersedes the last).

### Manual install (no tarball)

```bash
git clone git@github.com:antoinedc/MantaUI.git ~/manta
cd ~/manta && npm install && npm run build:mobile
npm run mobile     # server on 0.0.0.0:8787 (MANTA_MOBILE_HOST/PORT override)
npm run pair       # mint a pairing code
```

Systemd: copy `scripts/systemd/manta-server.service`, substitute the
`@@MANTA_HOME@@` / `@@NODE_BIN@@` / `@@MANTA_PORT@@` placeholders into
`~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl
--user enable --now manta-server` and `loginctl enable-linger $USER`.

## Desktop development

Pre-built installers (from the latest release):

- macOS (arm64 + x64, unsigned): <https://mantaui.com/downloads/Manta-latest.dmg>
- Linux (x64 AppImage): <https://mantaui.com/downloads/Manta-latest.AppImage>

The macOS build is unsigned — first launch will be blocked by Gatekeeper.
Right-click the `.dmg` in Finder → **Open** to bypass (or
`xattr -d com.apple.quarantine /Applications/Manta\ UI.app` after install).

Run from source:

```bash
npm install
npm run typecheck
npm test              # vitest (renderer) + node:test (server/relay/scripts)
npm run dev           # main-process/preload changes need full restart, not HMR
```

Onboarding accepts a direct box URL + code today; relay pairing
(`manta://pair?box=<box_id>&code=<code>`) is landing with the relay epic.

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

## AI tools on the box

Chat sessions get manta-native opencode tools (installed from
`docs/opencode-tools/`): **schedule** (cron'd prompts into the same session),
**serve-page** (publish an HTML page to a public URL), **peers**
(see/message sibling agent sessions), **notify** (desktop/mobile
notifications with smart routing), **secrets** (use credentials by reference —
values never enter the transcript), **webhook** (external systems wake the
session by POST). Install/update = copy to `~/.config/opencode/tools/`
(real copies, not symlinks) + restart `opencode-serve`.

## Releases (maintainer runbook)

1. Bump `package.json` version.
2. `npm run pack` → `dist/manta-<version>.tar.gz`; upload to the release
   host: `/var/www/mantaui/releases/manta-<version>.tar.gz` (+ copy to
   `manta-latest.tar.gz`).
3. Desktop: `bash scripts/release/desktop.sh` → `.dmg` / `.AppImage` in
   `dist/desktop/` (signing via `CSC_LINK`/`CSC_KEY_PASSWORD` env; unsigned
   in beta). The script prints the exact `scp` commands to publish to the
   prod box — `/var/www/mantaui/updates/` (electron-updater "generic"
   feed) and `/var/www/mantaui/downloads/` (human-facing binaries,
   including the `Manta-latest.{dmg,AppImage}` copies the website links
   to). Auto-update is wired via `electron-builder.yml` → `publish:
   { provider: generic, url: https://mantaui.com/updates }`;
   electron-updater reads the URL from `app-update.yml` baked at build
   time, no code override needed.
4. Sync `scripts/install.sh` to the site root if it changed.
5. Verify: `curl -sI https://mantaui.com/install.sh` and the tarball URL,
   plus `curl -sI https://mantaui.com/downloads/Manta-latest.dmg` and
   `curl -s https://mantaui.com/updates/latest-mac.yml` (version must
   match `package.json`).

## Production infra (ours)

- **mantaui.com** (Hetzner "manta" box): Caddy → static site + `/install.sh`
  + `/releases/*`; `manta-relay` systemd service behind
  `relay.mantaui.com` (loopback 20787). Deploy = `git -C /opt/manta pull` +
  `systemctl restart manta-relay`; static files re-read per request.
- **app.mantaui.com**: the maintainer box's own tunnel (each user brings
  their own host or uses the relay).
- DNS on Cloudflare (apex/www/relay DNS-only → Caddy does TLS; wildcard
  `*.pages.<domain>` via DNS-01).

## Known gaps

- macOS-first; Linux/Windows desktop builds untested.
- Relay end-to-end (pair + SSE + PTY through `relay.mantaui.com`) is in
  flight — until it lands, a box needs its own ingress for remote access.
- `npm run dev` requires full restart for main-process/preload changes.

## Reporting issues

Include: macOS version + chip, remote OS + `tmux -V`, `opencode --version`,
what you did vs. what happened, DevTools console errors. For chat-mode
issues, `[opencode-bus]` lines in the main-process log are the most useful.
