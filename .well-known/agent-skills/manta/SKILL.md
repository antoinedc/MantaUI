---
name: manta
description: Install Manta UI, a self-hosted Claude Code and opencode client, on a user-owned Linux box or Mac. Use when the user asks to install Manta, set up the Manta box, run the Manta installer, or wire Claude Code to a self-hosted server they can reach from desktop and phone.
license: MIT
source: https://github.com/antoinedc/MantaUI/blob/main/llms-install.md
canonical_url: https://mantaui.com/.well-known/agent-skills/manta/SKILL.md
---

You are an AI coding agent installing Manta UI's box server on behalf of your
user. Follow this document exactly. Do not improvise install steps: the
installer script is the single mechanism; your job is the interview, running
it with the right knobs, verifying, and reporting.

## Safety invariants (never violate)

- NEVER delete or regenerate `~/.manta/auth.json`. It is the box identity;
  regenerating it unpairs every device the user has.
- NEVER edit `~/.config/opencode/opencode.jsonc` destructively — the installer
  merges what it needs; leave it alone.
- NEVER run the installer as root or with sudo. It is a per-user, user-space
  install (systemd --user + linger). It never installs system packages. If a
  prerequisite is missing (e.g. tmux), show the user the exact install command
  and ask them to run it or approve it — do not run sudo yourself unless the
  user explicitly approves that command.
- NEVER install Node.js or build tools — the installer ships its own Node
  runtime inside the release tarball.
- Re-running the installer is safe: it upgrades in place and preserves identity.

## Step 1 — interview (ask BEFORE running anything)

Ask the user exactly this question:

1. **"Am I running on the Linux box you want to install Manta on, or should I
   install on a remote box over SSH?"** If remote: ask for `user@host` (and
   key/port if needed), then run every command below through
   `ssh user@host '…'`. Verify SSH works with `ssh user@host 'echo ok'` first.

Do NOT ask about chat mode (always installed), model providers, or projects —
the desktop app's onboarding handles those.

## macOS box (Apple Silicon) — read this if the answer was "this Mac"

The installer supports macOS as a box OS **only on Apple Silicon (arm64)**
machines running a recent macOS. **Intel Macs are not supported as a box** —
the installer will refuse with a clear message rather than silently failing;
if the user wants to USE Manta on an Intel Mac, point them at the desktop app
instead (`https://mantaui.com/downloads/Manta-latest.dmg`).

The macOS box path is **loopback + Tailscale-only**. There is NO public
`<box_id>.boxes.mantaui.com` HTTPS endpoint on a macOS box — the installer
deliberately skips the Caddy / Let's Encrypt / gateway DNS section that Linux
boxes run (no `apt`, no Caddy, no public DNS, no root-level privileged
section). To reach a macOS box from off-network, the user needs **Tailscale**
(or another tailnet) installed and running; the installer auto-detects
Tailscale and prints the tailnet URL on success.

The macOS box runs as **launchd LaunchAgents** under the logged-in user
(`~/Library/LaunchAgents/com.mantaui.{server,opencode}.plist`), which load at
GUI login and survive reboot as long as the user is logged in. **A headless /
never-logs-in Mac is NOT supported** — the LaunchAgents never load without a
GUI session. If the user wants 24/7 box availability they need a Linux VPS
(or a Mac that is logged in continuously).

## Step 2 — preflight

Run on the target box:

- `uname -m` — must be `x86_64` or `aarch64` / `arm64` (Linux) OR `arm64`
  (macOS / Apple Silicon). Intel Macs are not supported as a box — stop and
  point the user at the desktop app.
- `for c in curl tar tmux git; do command -v $c >/dev/null || echo "missing: $c"; done`
  plus `command -v sha256sum || command -v shasum` — sha256sum (Linux /
  coreutils) and `shasum` (macOS, ships by default) are both accepted; the
  installer refuses if NEITHER is present. On macOS `shasum` ships out of the
  box; do NOT require the user to `brew install coreutils`. All five are
  hard requirements the installer does NOT install. For any missing one,
  give the user the exact command for their distro
  (`sudo apt-get install -y tmux git` / `sudo dnf install -y tmux git`).
- The installer installs Caddy (apt repo) if absent, then registers the box
  with the hosted push gateway (`https://gateway.mantaui.com`) so the public
  hostname `<box_id>.boxes.mantaui.com` resolves and serves HTTPS. The box
  needs outbound HTTPS to the gateway AND inbound TCP 80/443 (Let's Encrypt
  HTTP-01). Tell the user to open these ports if a firewall blocks them.
  This step is the only place the installer uses `sudo` — see
  "Sudden failure playbook" below for the bring-your-own-proxy fallback
  when sudo isn't available or the distro isn't Debian/Ubuntu.
- `test -f ~/.claude/.credentials.json && echo present || echo missing` —
  chat mode reuses the box's claude login. If missing, tell the user: chat
  will 401 until they run `claude` once on this box and log in. Offer to
  pause here while they do (then `systemctl --user restart opencode-serve`
  after install), or continue and remind them at the end. Continue either way.
- Do NOT check for or install Node — the installer vendors its own runtime.

## Step 3 — install

    curl -fsSL https://mantaui.com/install.sh | bash

Watch the output. The installer is idempotent and prints its own diagnostics.
It downloads a self-contained release (app + Node runtime), verifies its
checksum, installs to `~/manta`, installs + configures Caddy, registers the
box with the push gateway, sets up `manta-server` and `opencode-serve`
systemd --user units, enables linger, and ends by printing a 6-digit pairing
code, the box id, and a `manta://pair` link. Capture all of those for your
final report.

**macOS box:** the installer runs the same way — `curl … | bash` on the Mac
terminal while logged in. It will (a) auto-detect the Mac, (b) skip the Caddy /
Let's Encrypt / gateway DNS section, (c) install two LaunchAgents under
`~/Library/LaunchAgents/` instead of systemd units, and (d) print the tailnet
URL instead of `<box_id>.boxes.mantaui.com` if Tailscale is detected, or a
loopback-only message otherwise. The pair code + box id + `manta://pair` link
are still printed at the end.

## Step 4 — verify

Linux box:

- `systemctl --user is-active manta-server` → `active`
- `systemctl --user is-active opencode-serve` → `active`
- `systemctl is-active caddy` → `active`
- `curl -s http://127.0.0.1:8787/auth/status` → responds (any JSON)
- `curl -fsS https://<box_id>.boxes.mantaui.com/auth/status` → responds
  (any JSON — proves Caddy TLS + the gateway registration both landed)
- If the public hostname doesn't resolve: `dig +short <box_id>.boxes.mantaui.com`
  should return the box's public IP within ~5 minutes. If it doesn't, the
  gateway registration failed — check
  `journalctl --user -u manta-server -n 50` for the `[push] gateway send failed`
  / `register` lines.

macOS box (Apple Silicon):

- `launchctl print gui/$(id -u)/com.mantaui.server` → reports `state = running`
- `launchctl print gui/$(id -u)/com.mantaui.opencode` → reports `state = running`
- `curl -s http://127.0.0.1:8787/auth/status` → responds (any JSON)
- If Tailscale is detected: `curl -fsS http://<tailscale-ip>:8787/auth/status`
  → responds from off-network devices on the same tailnet
- `tail -F ~/.manta/server.log` and `tail -F ~/.manta/opencode.log` for
  log tails (these are the `StandardOutPath`/`StandardErrorPath` paths the
  LaunchAgent plists declare)
- `<box_id>.boxes.mantaui.com` will NOT resolve from a macOS box — that
  endpoint only exists for Linux boxes. The tailnet URL above is the
  off-network access path on macOS.

Pairing codes are one-time with a ~5 minute TTL. If the printed code expires
before the user enters it, mint a fresh one:
`curl -s http://127.0.0.1:8787/auth/pair` (loopback-only, run on the box).

## Step 5 — failure playbook

- **Installer died at a checksum mismatch** → corrupt download or a release
  being published right now; re-run once. If it persists, report it to the
  user verbatim.
- **Installer died with "missing prerequisite: sha256sum or shasum"** →
  neither sha256sum (Linux/coreutils) nor shasum (macOS) is on PATH. Linux:
  install coreutils (`apt-get install -y coreutils` / `dnf install -y
  coreutils`). macOS: `shasum` ships by default; if it's missing the user
  has likely stripped `/usr/bin` from PATH — fix PATH first, then re-run.
- **Installer died at "server did not become healthy"** →
  Linux: `journalctl --user -u manta-server -n 50`; macOS:
  `tail -n 50 ~/.manta/server.log`. Most common cause is a stale partial
  install — re-run the installer (safe; the previous install is kept at
  `~/manta.prev` until a run succeeds).
- **`systemctl --user` errors with "Failed to connect to bus"** → Linux only —
  the user SSH'd in without a session bus; run
  `export XDG_RUNTIME_DIR=/run/user/$(id -u)` and retry, and make sure
  `loginctl enable-linger $USER` succeeded (may need sudo).
- **`<box_id>.boxes.mantaui.com` never resolves** → Linux only — box could
  not reach the gateway at registration time (firewall, captive portal, DNS).
  Re-run the installer once the user fixes outbound HTTPS to
  `gateway.mantaui.com:443`. (macOS never gets this hostname — see "macOS
  box" above.)
- **Caddy reload fails on a non-standard port 80/443 binding** → Linux only —
  another service (Apache, nginx, Traefik) is already bound. Stop it, or
  edit the Caddy vhost on the box to a non-standard port + your own reverse
  proxy.
- **Installer warns "Caddy/gateway section skipped: passwordless sudo
  is not configured"** → Linux only — the installer continues normally (the
  loopback server + pairing code still work), but `<box_id>.boxes.mantaui.com`
  won't be set up by the installer. The user can either configure
  passwordless sudo (`$USER ALL=(ALL) NOPASSWD:ALL` in
  `/etc/sudoers.d/`) and re-run, OR bring their own reverse proxy
  pointing at `127.0.0.1:8787`. The install prints the exact apt + gpg +
  tee commands to run by hand.
- **Installer warns "distro X is not in the v1 supported list"** → Linux only —
  same as above (install continues, BYO proxy). v1 supports Debian,
  Ubuntu, and any distro with `ID_LIKE=debian` (Linux Mint, Raspbian,
  elementary OS). RHEL / Fedora / Arch / Alpine: out of scope for v1.
- **Installer refuses with "unsupported Mac: x86_64"** → Intel Mac. Direct
  the user to the desktop app download
  (`https://mantaui.com/downloads/Manta-latest.dmg`).
- **macOS LaunchAgents never load** → the Mac isn't logged in (no GUI
  session). Headless-never-logs-in Macs are not supported; use a Linux VPS
  for 24/7 box availability.
- **macOS box is unreachable from off-network and Tailscale isn't
  installed** → the only way to reach a macOS box from off-network is a
  tailnet (Tailscale or equivalent). Install Tailscale on the Mac and
  re-run the installer — it auto-detects the tailnet IP and prints it.
- **Chat 401s** → `~/.claude/.credentials.json` missing (see preflight); after
  the user logs in, Linux: `systemctl --user restart opencode-serve`;
  macOS: `launchctl kickstart -k gui/$(id -u)/com.mantaui.opencode`.
- Anything else: re-run the installer first (idempotent), then read the
  journals (Linux: `journalctl --user -u manta-server -n 50`; macOS:
  `tail -n 50 ~/.manta/server.log`) before attempting manual fixes.

## Step 6 — report back to the user

Tell the user, in this order:

1. The **pair page** as the single clickable entry point — the box hosts a
   3-step wizard that walks them through downloading the desktop app,
   connecting it, and (optionally) installing the mobile app:

   - **Linux box:** [Open this link to connect your devices](https://<box_id>.boxes.mantaui.com/pair#box=<box_id>&code=<code>)
   - **macOS box:** the installer prints the tailnet URL (or the loopback
     URL if no Tailscale) in the same pair block — use that. There is no
     public `<box_id>.boxes.mantaui.com` on macOS.

   The **pairing code** (and that it expires in ~5 minutes — you can mint a
   fresh one any time) and the **box id** below, as a fallback if they
   prefer to enter the values manually in the desktop app.
2. Linux: devices connect directly to `https://<box_id>.boxes.mantaui.com` —
   desktop: paste the `manta://pair` link or enter the code; phone: install
   the app / open the URL and pair the same way.
   macOS: devices reach the box at the tailnet URL printed by the installer
   (e.g. `http://<tailscale-ip>:8787`) — same pairing flow.
3. Everything else (providers, first project) happens in the desktop app's
   onboarding.
4. If claude login was missing: remind them to run `claude` on the box, then
   `systemctl --user restart opencode-serve` (Linux) or
   `launchctl kickstart -k gui/$(id -u)/com.mantaui.opencode` (macOS).
