<img src="docs/brand/manta-logo.png" alt="Manta" width="72" />

# Manta UI

Drive `claude` / [opencode](https://opencode.ai) coding sessions running on
your own Linux box, from a desktop app or your phone — terminal and native
chat, over plain HTTPS. The box stays a stock tmux server; closing Manta
leaves your work running, reopening re-attaches.

## AI-assisted setup

Setting up with an AI agent (claude code, opencode, cursor, …)? Paste this
into an agent that can reach the box:

```
Set up a Linux box as a Manta UI box server.
Fetch https://mantaui.com/llms-install.md and follow it exactly.
Ask me its interview questions before running anything.
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
         │ https://<box_id>.boxes.mantaui.com   │   ← the box serves its
         │ (Caddy fronts the box's loopback     │      own public hostname
         │  127.0.0.1:8787, no relay)           │      via DNS + LE cert
         └──────────────┬────────────────┘
                        │
                YOUR LINUX BOX
      manta-server (:8787, loopback)  ── owns tmux, files, config,
        ├── tmux ── your sessions        schedules, secrets, webhooks, push
        └── opencode-serve (:4096) ───── chat mode + AI tools
                       │
                       └── HTTPS POST ──▶ gateway.mantaui.com
                                              (hosted push gateway —
                                               signs Apple JWT and
                                               delivers APNs)
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
- **Connectivity**: direct HTTPS is the only mode. The installer writes
  `<box_id>.boxes.mantaui.com` into the DNS zone, provisions a Let's
  Encrypt cert through Caddy on the box, and registers the box with the
  hosted push gateway (`gateway.mantaui.com`) — which is the ONLY thing
  still operated by us (APNs structurally needs our Apple key, which
  cannot live on customer boxes). Native APNs delivery goes
  box → gateway → APNs. Web Push (VAPID, for the PWA) stays box-local.

## Quick start (human version)

**On your Linux box** (needs `tmux`; chat mode also needs a working claude
login; needs outbound HTTPS to `gateway.mantaui.com:443` and inbound TCP
80+443 for the installer's Caddy + Let's Encrypt):

```bash
curl -fsSL https://mantaui.com/install.sh | bash
```

Prints a pairing code. Re-running upgrades in place and preserves identity.

**On your Mac**: download the app from [mantaui.com](https://mantaui.com)
(or run from source: `npm install && npm run dev`), enter the pairing code in
onboarding, pick providers, create your first project (a tmux session).

**On your phone**: open `https://<box_id>.boxes.mantaui.com`, add to home
screen, pair with a fresh code. Native push (APNs) lands via the gateway for
permissions/questions/errors/done.

## Components & where they run

| Component | Where | What |
|---|---|---|
| `manta-server` (`src/server/`) | your box, `127.0.0.1:8787`, systemd --user | THE server: tmux CRUD, PTY WS, opencode proxy, config, schedules, secrets, webhooks, serve-page, Web Push, APNs fanout via gateway, auth |
| `opencode-serve` | your box, `127.0.0.1:4096`, systemd --user | chat-mode backend (opencode + claude auth plugin) |
| Caddy | your box, systemd | TLS termination + reverse proxy on `<box_id>.boxes.mantaui.com` → 127.0.0.1:8787 |
| desktop app (`src/main`, `src/preload`, `src/renderer`) | your Mac | thin client + OS bridges; pairing flow |
| mobile client (`mobile/www`, built from `src/renderer`) | served by manta-server | PWA / Capacitor wrapper (same React code as desktop) |
| `manta-gateway` (`src/gateway/`) | our infra, `gateway.mantaui.com` | hosted push fanout (APNs JWT + send) + DNS automation for `<box_id>.boxes.mantaui.com` |
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
| 20081 | (gateway only — not on customer boxes) |

## Installer reference

The installer downloads a self-contained tarball that ships a vendored Node
runtime + prebuilt production `node_modules` (node-pty's native binding
already compiled). The box only needs `curl`, `tar`, `sha256sum`, `tmux`,
and `git` — no Node preinstall, no compilers, no `sudo`, no package-manager
calls. (Every launch-gate E2E failure previously came from the installer
silently trying to `apt install nodejs` and friends; v2 removes that
seam entirely.)

What the installer does: fetch a key=value manifest over HTTPS → read
`file_linux_x64` + `sha256_linux_x64` from it → download the tarball →
sha256-verify → extract → atomic swap into `~/manta` → install + configure
Caddy → register the box with the push gateway → write systemd units
pointing at the vendored node → start → poll DNS until
`<box_id>.boxes.mantaui.com` resolves → print a pairing code.

Overrides (env):

| Var | Default | Purpose |
|-----|---------|---------|
| `MANTA_TARBALL_URL` | (built from manifest) | full tarball URL — local testing / mirror (skips manifest fetch + sha256 check, with a warn) |
| `MANTA_RELEASE_HOST` | `https://mantaui.com` | host for the manifest + tarball |
| `MANTA_HOME` | `~/manta` | where the code is unpacked |
| `MANTA_VERSION` | `latest` | manifest version to fetch (e.g. `0.0.1`) |
| `MANTA_MOBILE_PORT` | `8787` | server port |
| `MANTA_GATEWAY_BASE` | `https://gateway.mantaui.com` | push gateway base (override ONLY for tests / dev boxes) |

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
npm test              # vitest (renderer) + node:test (server/gateway/scripts)
npm run dev           # main-process/preload changes need full restart, not HMR
```

Onboarding accepts a pair link (`manta://pair?box=<box_id>&code=<code>`)
or the box's direct URL + code. The desktop app pastes the link from
`scripts/install.sh` output and resolves it to
`https://<box_id>.boxes.mantaui.com`.

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

In order. No decisions, no extra steps:

1. Bump `package.json` version.
2. Build the box-server tarballs (one invocation per arch; requires BOTH
   arches before `publish.sh` will proceed):
   - `node scripts/release/pack.mjs --arch x64` — produces
     `dist/manta-<version>-linux-x64.tar.gz` (the self-contained
     tarball) AND `dist/manta-<version>-linux-x64.txt` (the per-arch
     key=value manifest sidecar).
   - `node scripts/release/pack.mjs --arch arm64` — same two outputs
     with `linux-arm64` in the filename. Run on a native arm64 host
     (the arm64 `node-pty` binding cannot be cross-compiled; the
     `server-tarball-deploy.yml` workflow builds both arches in a
     matrix on a `server-v<version>` tag — see `AGENTS.md` "Release &
     CD pipeline").
   - `node scripts/release/merge-manifest.mjs \
       dist/manta-<version>-linux-x64.txt \
       dist/manta-<version>-linux-arm64.txt \
       --out dist/manta-<version>.txt` — assembles the combined
     key=value manifest `install.sh` fetches at runtime.
3. (Mac only, on a Mac) `bash scripts/release/desktop.sh` — produces
   `dist/desktop/*.dmg` and the `latest-*.yml` updater feeds. Linux
   builds run on any host.
4. `bash scripts/release/publish.sh` — uploads both per-arch tarballs
   + the combined manifest, restarts `manta-server` on prod,
   HEAD-checks every URL, tags `v<version>`. Idempotent: re-publishing
   the same version is a safe no-op. Override the target with
   `MANTA_PROD_HOST=...` for staging.

Done.

**Rollback:** the atomic pointer is `manta-latest.txt` (the combined
manifest), not a tarball — `publish.sh` uploads every release's
per-arch tarballs (`manta-<version>-linux-x64.tar.gz` +
`manta-<version>-linux-arm64.tar.gz`) into `/var/www/mantaui/releases/`
and never deletes the previous release's files, so reversing the
manifest pointer is all that's needed to restore an older release on
the box:

```
ssh $MANTA_PROD_HOST 'cd /var/www/mantaui/releases \\
    && cp -f manta-<prev-version>.txt manta-latest.txt \\
    && git -C /opt/manta checkout v<prev-version> \\
    && systemctl restart manta-server'
```

If `manta-<prev-version>.txt` is missing on the prod box, recover it
by re-merging the previous release's per-arch sidecars (still served
under their versioned filenames) on any host that has
`scripts/release/merge-manifest.mjs`:

```
scp $MANTA_PROD_HOST:/var/www/mantaui/releases/manta-<prev-version>-{linux-x64,linux-arm64}.txt .
node scripts/release/merge-manifest.mjs \
    manta-<prev-version>-linux-x64.txt \
    manta-<prev-version>-linux-arm64.txt \
    --out manta-<prev-version>.txt
scp manta-<prev-version>.txt $MANTA_PROD_HOST:/var/www/mantaui/releases/
```

## Production infra (ours)

- **mantaui.com** (Hetzner "manta" box): Caddy → static site + `/install.sh`
  + `/releases/*`. Deploy = scp static files into `/var/www/mantaui/`.
- **gateway.mantaui.com** (same Hetzner box, separate Caddy vhost →
  loopback `:20081`): the hosted push gateway. `systemd manta-gateway`.
  Deploy = `git -C /opt/manta pull` + `systemctl restart manta-gateway`;
  static files re-read per request.
- **app.mantaui.com**: the maintainer box's own tunnel (each user brings
  their own host).
- DNS on Cloudflare (apex/www/gateway DNS-only → Caddy does TLS; per-box
  `<box_id>.boxes.mantaui.com` A records managed by the gateway via OVH's
  API; wildcard `*.pages.<domain>` via DNS-01).

### Prod box ops

Ops scripts + configs are committed under `scripts/prod/` so the box is
rebuildable from git. None of these touch application code; the install
steps in each file's header are human-only (agent Hard Rule #4 forbids
`ssh root@...`).

- **Monitoring** (`scripts/prod/healthcheck.mjs`, scheduled every 10 min
  on the dev box via `schedule_create`): off-site probes of `mantaui.com`,
  `gateway.mantaui.com/healthz` (200 = healthy), `app.mantaui.com`,
  `/install.sh`, `/releases/manta-latest.tar.gz` (and the live
  `manta-latest.txt` manifest's `sha256_linux_x64` must match the served
  tarball). On failure the opencode turn calls `notify` urgent:true naming
  the failing URL.
- **Log caps** (`scripts/prod/systemd-journald.conf`,
  `scripts/prod/caddy-logrotate`): journald capped at 500M; Caddy access
  logs (only if they exist on the box — check first) rotated daily with
  14 generations.
- **Patches** (`scripts/prod/50unattended-upgrades`): security origin
  only; updates left to a human reboot window.
- **Brute-force** (`scripts/prod/jail.local`): sshd jail only — no HTTP
  jail (Caddy/the box server have their own rate limits).

## Known gaps

- macOS-first; Linux/Windows desktop builds untested.
- `npm run dev` requires full restart for main-process/preload changes.

## Reporting issues

Include: macOS version + chip, remote OS + `tmux -V`, `opencode --version`,
what you did vs. what happened, DevTools console errors. For chat-mode
issues, `[opencode-bus]` lines in the main-process log are the most useful.
