<img src="docs/brand/manta-logo.png" alt="Manta" width="72" />

# Manta

Drive [Claude Code](https://docs.claude.com/en/docs/claude-code) and
[opencode](https://opencode.ai) running on your own Linux box or Mac.
Real tmux, real terminal, native chat panel, and a remote iPhone app or
any browser. Self-hosted, open source, MIT licensed.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platforms: Linux · macOS · iOS · Web](https://img.shields.io/badge/Platforms-Linux%20·%20macOS%20·%20iOS%20·%20Web-lightgrey.svg)](#install)
[![Built with Electron](https://img.shields.io/badge/Electron-Desktop-9feaf9.svg)](https://www.electronjs.org)
[![Docs](https://img.shields.io/badge/Docs-AGENTS.md-blueviolet.svg)](AGENTS.md)

![Hero screenshot: desktop sidebar with three projects, live chat panel mid-turn](docs/brand/manta-lockup.png)

## Install

Paste this into an agent that can reach the box (Claude Code, opencode,
Cursor, …):

```
Set up a Linux box as a Manta box server.
Fetch https://mantaui.com/llms-install.md and follow it exactly.
Ask me its interview questions before running anything.
```

The agent runs the installer and prints the 6-digit pairing code.
Or run it yourself:

```bash
curl -fsSL https://mantaui.com/install.sh | bash
```

The installer downloads a self-contained tarball (vendored Node
runtime, prebuilt native bindings), writes systemd --user units
(Linux) or launchd LaunchAgents (macOS Apple Silicon), registers with
the push gateway, provisions a Let's Encrypt cert on
`<box_id>.boxes.mantaui.com`, and prints the 6-digit pairing code.
Linux needs `tmux` and `git` plus inbound TCP 80 + 443 open; macOS
boxes skip Caddy and Let's Encrypt and reach the tailnet or loopback.

To install from git:

```bash
git clone git@github.com:antoinedc/MantaUI.git ~/manta
cd ~/manta && npm install && npm run build:mobile
npm run mobile     # server on 0.0.0.0:8787
npm run pair       # mint a pairing code
```

Download the desktop app from
[mantaui.com](https://mantaui.com/downloads/Manta-latest.dmg) (macOS
arm64 + x64, Developer ID signed but not notarized; right-click in
Finder and choose **Open** to bypass Gatekeeper the first time).
Linux: `Manta-latest.AppImage`. Open the app, paste the pairing code,
pick providers, create your first project.

For the phone: native iPhone app, or any browser, same React code as
the desktop. Open `https://<box_id>.boxes.mantaui.com`, add to home
screen, pair with a fresh code. Native push (APNs) lands via the
hosted gateway.

## Features

- **The agent keeps running without you.** Real tmux on your box.
  Close every client; the session, scrollback, and work continue.
- **The phone is the same app.** Full transcript, live tool output,
  permission cards, voice, file upload.
- **The installer decides how you reach the box.** Probes
  `tailscale status`; if Tailscale is up it uses the tailnet and
  skips Caddy, public DNS, and Let's Encrypt. Otherwise it provisions
  a per-box hostname on `<box_id>.boxes.mantaui.com` with a Let's
  Encrypt cert.
- **The agent can act between turns.** Schedules itself, gets woken
  by webhooks, sends notifications, references secrets, and messages
  sibling sessions.

### Sessions and terminal

- Persistent tmux sessions that survive every client disconnecting
- A real terminal and a chat panel per tmux window, switchable
- Git worktree per session, optional removal on close

### Chat and review

- Permission and question cards the agent waits on
- Live command output, inline diffs, per-turn context bar with cache
  breakdown
- Inline subagent rendering in the transcript
- Model picker with per-session persistence and a global default

### Phone app and notifications

- Auto-detected ingress (tailnet or Caddy plus Let's Encrypt)
- A native iPhone app, and any browser everywhere else, both full
  clients
- Push notifications with cross-device routing and 90-second
  desktop-first escalation

### Agent-native tools

- `schedule`, `webhook`, `notify`, `secrets`, `peers`, `serve-page`,
  installed from `docs/opencode-tools/`. The agent calls them like any
  other opencode tool.

### Files and voice

- Drag-drop upload, screenshot auto-detect, agent-to-you outbox
- Voice push-to-talk for dictation and command mode

### Security

- Every request authenticated with a 128-bit `box_token` bearer
  secret, paired via a 6-digit, one-time, 5-minute code
- Secrets-by-reference: values never enter the transcript
- No telemetry; the box only dials out for APNs

## How it works

```
 Desktop app (Electron)         Phone (native iPhone app, or any browser)
          │                              │
          └──────────── HTTPS ───────────┘
                         │
          ┌──────────────┴────────────────┐
          │ https://<box_id>.boxes.mantaui.com   │   the box serves its
          │ Caddy fronts the box's loopback      │   own public hostname
          │ 127.0.0.1:8787, no relay             │   via DNS + LE cert
          └──────────────┬──────────────────────┘
                         │
                 YOUR LINUX BOX (or Mac)
       manta-server (:8787)  owns tmux, files, config,
         ├── tmux               your sessions
         └── opencode-serve (:4096) chat mode + agent tools
                         │
                         └── HTTPS POST ──▶ gateway.mantaui.com
                                              hosted push gateway,
                                              signs Apple JWT, delivers
                                              APNs (Web Push box-local)
```

**The server is the box.** Sessions, transcripts, uploads, schedules,
and secrets all live on the Linux box or Mac in `~/.manta*`. The
desktop and phone are thin clients over `/rpc` plus `/events` (SSE);
the desktop only adds OS bridges (clipboard, screenshot, file peek).

**Auth.** Every data route requires `Authorization: Bearer
<box_token>`. Devices obtain it once via a 6-digit, one-time,
5-minute pairing code minted loopback-only on the box
(`curl -s 127.0.0.1:8787/auth/pair`). Box identity persists in
`~/.manta/auth.json`; never regenerate it.

**Two window types** per tmux window: a raw **terminal** (xterm.js
attached over a WebSocket PTY) or a **chat panel** (opencode session).
They coexist freely.

## Technical details

Transport: `/rpc` (JSON-over-HTTPS) for requests, `/events`
(Server-Sent Events) for streaming, WebSocket for terminal PTYs. No
long-poll, no relay hop.

State on the box: `~/.manta/` (identity, config, schedules, secrets,
webhooks, VAPID keys, served pages); `~/.manta-uploads/<session>/<batch>/`
(attachments, hourly auto-clean); `~/.manta-outbox/` (agent-to-you
file handoffs); `~/.manta-secrets/` (materialized secret files at 0600,
used by reference); `~/.config/opencode/` (opencode config and the
manta agent tools).

Ports (all loopback on the box): 8787 manta-server; 4096
opencode-serve; 20081 hosted push gateway (not on customer boxes).

Components: `manta-server` (`src/server/`) runs at `127.0.0.1:8787`
and owns tmux CRUD, PTY WebSocket, opencode proxy, auth, schedules,
secrets, webhooks, serve-page, Web Push, APNs fanout via gateway.
`opencode-serve` runs at `127.0.0.1:4096` as the chat backend. Caddy
terminates TLS and reverse-proxies
`<box_id>.boxes.mantaui.com` to `127.0.0.1:8787`. The desktop app
(`src/main`, `src/preload`, `src/renderer`) is a thin client plus OS
bridges. The mobile client (`mobile/www`) is a native iPhone app or
any browser, same React code as desktop. `manta-gateway`
(`src/gateway/`) runs on our infra for hosted push fanout and DNS
automation.

Installer: downloads a self-contained tarball that ships a vendored
Node runtime plus prebuilt production `node_modules`. The box only
needs `curl`, `tar`, `sha256sum`, `tmux`, and `git`; no Node
preinstall, no compilers, no package-manager calls. Override
`MANTA_TARBALL_URL` for local testing or a mirror (skips the manifest
fetch and sha256 check with a warning). Manage with
`systemctl --user {status,restart} manta-server`; logs at
`journalctl --user -u manta-server -f`. Mint a fresh pairing code with
`npm run pair` from `~/manta`; each new code supersedes the last.

## AI tools on the box

Chat sessions get manta-native opencode tools from
`docs/opencode-tools/`:

- **`schedule`** cron'd prompts into the same session.
- **`serve-page`** publish an HTML page to a public URL.
- **`peers`** see and message sibling agent sessions in the workspace.
- **`notify`** desktop and mobile notifications with cross-device
  routing.
- **`secrets`** reference credentials by name; values never enter the
  transcript.
- **`webhook`** external systems wake the session by POST.

Install or update: copy to `~/.config/opencode/tools/` (real copies,
not symlinks) and restart `opencode-serve`.

## Development

```bash
npm install
npm run typecheck
npm test              # vitest (renderer) plus node:test (server, gateway, scripts)
npm run dev           # main-process and preload changes need a full restart, not HMR
npm run build:mobile  # rebuild mobile bundle after renderer changes
```

See `AGENTS.md` for the full architecture, IPC contract, and release
pipeline.

Keybindings: ⌘N new project · ⌘T new session · ⌘1..9 jump to nth ·
⌥⌘↑/⌥⌘↓ prev/next · ⌘, settings · ⌘C/⌘V copy/paste in terminal ·
⌘F search scrollback · ⌘K clear scrollback · Shift+Enter newline in
claude TUI.

## Comparison

| | Manta | Orca | Conductor | Termius plus SSH |
|---|---|---|---|---|
| License | MIT | MIT | Proprietary | Proprietary |
| Agents run on | Your VPS or Mac | Your Mac | Your Mac | Your VPS |
| Mobile parity | Full client | Read-mostly | No phone app | SSH terminal |
| Push routing | Desktop-first with escalation | None | None | None |
| Permissions | Explicit cards | yolo pre-filled | No sandboxing | Manual |
| Schedule, webhook, secrets, peers | Yes | No | No | No |
| Self-hosted | Yes (on your box) | Tailscale required | No | N/A |

Where Orca and Conductor genuinely beat Manta: 30-agent fan-out,
embedded browser, Monaco editor, diff review, cross-platform desktop,
Conductor's PR and merge tail. Full pages: [vs Orca](https://mantaui.com/vs-orca), [vs Conductor](https://mantaui.com/vs-conductor), [vs Termius plus SSH](https://mantaui.com/vs-ssh-tmux).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reports.

## License

[MIT](LICENSE). Maintainers see [docs/releasing.md](docs/releasing.md) for release procedure, rollback, and prod box ops

