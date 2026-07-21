# Manta UI — AI agent install guide

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

## Step 2 — preflight

Run on the target box:

- `uname -m` — must be `x86_64`. Anything else: stop and tell the user only
  x86_64 Linux is supported today.
- `for c in curl tar sha256sum tmux git; do command -v $c >/dev/null || echo "missing: $c"; done`
  — all five are hard requirements the installer does NOT install. For any
  missing one, give the user the exact command for their distro
  (`sudo apt-get install -y tmux git` / `sudo dnf install -y tmux git`;
  `sha256sum` is in coreutils) and wait for them to run or approve it.
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

## Step 4 — verify

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

Pairing codes are one-time with a ~5 minute TTL. If the printed code expires
before the user enters it, mint a fresh one:
`curl -s http://127.0.0.1:8787/auth/pair` (loopback-only, run on the box).

## Step 5 — failure playbook

- **Installer died at a checksum mismatch** → corrupt download or a release
  being published right now; re-run once. If it persists, report it to the
  user verbatim.
- **Installer died at "server did not become healthy"** →
  `journalctl --user -u manta-server -n 50`; most common cause is a stale
  partial install — re-run the installer (safe; the previous install is kept
  at `~/manta.prev` until a run succeeds).
- **`systemctl --user` errors with "Failed to connect to bus"** → the user
  SSH'd in without a session bus; run
  `export XDG_RUNTIME_DIR=/run/user/$(id -u)` and retry, and make sure
  `loginctl enable-linger $USER` succeeded (may need sudo).
- **`<box_id>.boxes.mantaui.com` never resolves** → box could not reach the
  gateway at registration time (firewall, captive portal, DNS). Re-run the
  installer once the user fixes outbound HTTPS to `gateway.mantaui.com:443`.
- **Caddy reload fails on a non-standard port 80/443 binding** → another
  service (Apache, nginx, Traefik) is already bound. Stop it, or edit the
  Caddy vhost on the box to a non-standard port + your own reverse proxy.
- **Installer warns "Caddy/gateway section skipped: passwordless sudo
  is not configured"** → the installer continues normally (the loopback
  server + pairing code still work), but `<box_id>.boxes.mantaui.com`
  won't be set up by the installer. The user can either configure
  passwordless sudo (`$USER ALL=(ALL) NOPASSWD:ALL` in
  `/etc/sudoers.d/`) and re-run, OR bring their own reverse proxy
  pointing at `127.0.0.1:8787`. The install prints the exact apt + gpg +
  tee commands to run by hand.
- **Installer warns "distro X is not in the v1 supported list"** →
  same as above (install continues, BYO proxy). v1 supports Debian,
  Ubuntu, and any distro with `ID_LIKE=debian` (Linux Mint, Raspbian,
  elementary OS). RHEL / Fedora / Arch / Alpine: out of scope for v1.
- **Chat 401s** → `~/.claude/.credentials.json` missing (see preflight); after
  the user logs in, `systemctl --user restart opencode-serve`.
- Anything else: re-run the installer first (idempotent), then read the
  journals of both units before attempting manual fixes.

## Step 6 — report back to the user

Tell the user, in this order:

1. The **pairing code** (and that it expires in ~5 minutes — you can mint a
   fresh one any time) and the **box id**.
2. Devices connect directly to `https://<box_id>.boxes.mantaui.com` —
   desktop: paste the `manta://pair` link or enter the code; phone: install
   the app / open the URL and pair the same way.
3. Everything else (providers, first project) happens in the desktop app's
   onboarding.
4. If claude login was missing: remind them to run `claude` on the box, then
   `systemctl --user restart opencode-serve`.
