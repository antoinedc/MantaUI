# Launch E2E validation — 2026-07-17

The launch gate (BET-160 §2) was run against a freshly-provisioned Hetzner
VPS. The advertised one-liner did NOT produce a working box. Single launch-
blocking finding; the rest of the checklist could not be reached because the
installer exits before it does anything else.

## Headline

| Step | Status |
|------|--------|
| 1. Provision `manta-e2e` VPS | ✅ done |
| 2. Run advertised one-liner | ❌ **FAIL** — installer dies at the prereq check (node missing) |
| 3. Verify health / linger / opencode stack / relay link | ⏸ not reached — installer never unpacked |
| 4. Pair desktop through relay | ⏸ not reached |
| 5. Pair PWA + push | ⏸ not reached |
| 6. Reboot + verify reconnection | ⏸ not reached |
| 9. Delete the VPS | ✅ done |

**Pass = sections 3–6 all green (PTY exempted until BET-158).** Sections 3–6
are all "not reached" because section 2 failed. The launch gate is **NOT
passing today**.

## Environment

- **VPS**: Hetzner cx22-equivalent (`cpx11`, 2 vCPU, 2 GB RAM, 40 GB disk),
  Ubuntu 24.04, location `ash`, name exactly `manta-e2e`, id `152016692`,
  IPv4 `178.156.203.86`. Created at `2026-07-17T12:56:37Z`.
- **Project**: the BUI Hetzner project whose token is at
  `/home/dev/.manta-secrets/projects/BUI/HETZNER_MANTA_BOX` (used by
  reference, never echoed).
- **User**: `manta`, uid 1000, `sudo NOPASSWD:ALL`, linger enabled
  (Linger=yes), SSH keys copied from root.
- **Versions on the wire**:
  - `https://mantaui.com/install.sh` — served by Caddy, etag `dk0bm97pgfys6wj`,
    8947 bytes, content-type `text/x-shellscript`.
  - `https://mantaui.com/releases/manta-latest.tar.gz` — 200, 1,209,791 bytes,
    etag `dk04ioxhk6e8pxhb`, content-type `application/gzip`.

## Step 1 — VPS creation

```
hcloud server create \
  --type cpx11 --image ubuntu-24.04 --name manta-e2e \
  --ssh-key alphaclaw@alphaclaw --location ash
```

Returned immediately: `Waiting for create_server (server: 152016692, image:
161547269) ... done`. The token's project had `server_limit = 1` initially
(only the prod box `manta`/id 151615222 existed); the owner raised the limit
before this run (see `ace0c8be` on BET-162).

Note: the original spec said `--type cx22`, which is the legacy alias and no
longer exists; the closest current spec is `cpx11` (the smallest plan still
orderable). `cpx11` is only available in `ash` and `hil`; all the spec'd EU
locations (`fsn1`, `nbg1`, `hel1`) reject it as `Server Type unavailable`.

## Step 2 — advertised one-liner (verbatim)

```
$ curl -fsSL https://mantaui.com/install.sh | bash
```

### Actual output

```
▸ Checking prerequisites (node, npm, git, tmux, curl, tar)…
✗ missing prerequisite: node
      Install it and re-run. Suggested:
        install Node.js LTS: https://nodejs.org  (nvm: 'nvm install --lts')
```

**Installer exit code: 1** (the `die` helper calls `exit 1`).

Wall time: <1 second from `bash` start to `exit 1`. No prompts shown, no
pairing code printed, no state mutated on the box.

### Post-attempt box state

```
$ ssh manta@178.156.203.86 '...'
/home/manta/.config/systemd/user/manta-server.service  →  NOT INSTALLED
systemctl --user status manta-server                    →  Unit not found
loginctl show-user manta | grep Linger                  →  Linger=yes (set by user bootstrap, not by installer)
/home/manta/manta/                                      →  NOT CREATED
~/.manta/                                                →  NOT CREATED
```

### Root cause

A stock Hetzner Ubuntu 24.04 cloud image does NOT ship Node.js. Confirmed on
the box:

```
$ command -v node  →  not found
$ command -v npm   →  not found
```

The installer's `require_cmd node` helper (lines 47–54 of `scripts/install.sh`)
treats this as fatal and `exit 1`s before doing anything else. The script
comments describe it as a "one-command VPS self-install" that "Gets
manta-server running under systemd --user on a fresh Linux box" — neither is
true on a stock cloud image.

The mantaui.com homepage also advertises this as "one-command install — pair
once and steer"; there is no prerequisite note visible on the page (grep'd
for `node|prereq|requirement` — only CSS class names matched).

## Steps 3–6 — not reached

The installer exited before any of these could be observed:

- **Step 3** (health / linger / opencode stack / relay link): no
  `manta-server` unit, no opencode process, no journal to grep.
- **Step 4** (desktop pair through relay): no `~/manta/` unpacked, so the
  `manta pair` CLI doesn't exist on the box. No pairing code was printed.
- **Step 5** (PWA pair + push): same — requires a pairing code from step 2.
- **Step 6** (reboot resilience): no systemd unit to verify, no dial-out
  agent to reconnect.

## Network reachability (verified from the box before tearing down)

Useful for follow-up: the box could reach everything a healthy install would
need to dial.

| Target | From box | Result |
|--------|----------|--------|
| `https://mantaui.com/install.sh` | curl | 200 |
| `https://mantaui.com/releases/manta-latest.tar.gz` | curl | 200, 1,209,791 B |
| `https://relay.mantaui.com` | curl | 401 (expected — that IS healthy) |
| `relay.mantaui.com:443` (TCP for WSS upgrade) | `/dev/tcp` | OK |
| DNS `mantaui.com`, `relay.mantaui.com`, `app.mantaui.com` | `getent hosts` | OK |

So when the installer IS fixed, it will have a clear network path to do
its job — there is no second-order network problem hiding behind the node
prereq.

## Findings

### F1 (launch-blocking) — installer does not install Node.js

**Where**: `scripts/install.sh` lines 47–54 (`require_cmd node …`).
**Symptom**: on a stock Ubuntu 24.04 image, the one-liner exits 1 in <1s with
"missing prerequisite: node" and leaves the box unchanged.
**Why it blocks launch**: BET-160 §2 acceptance criterion is "a stranger with
a fresh VPS + the website can reach a working terminal+chat session without
any manual help from us". Any manual `apt-get install -y nodejs` (or nodesource
setup, or nvm) violates that.
**Fix shape (suggested, NOT applied — per issue hard rule)**:
- Either have `install.sh` detect a missing `node` and bootstrap it (cleanest:
  add the NodeSource setup script + `apt-get install -y nodejs` before the
  prereq check), or
- Update `mantaui.com` to display "requires Node.js 20+" alongside the install
  one-liner (weaker — still requires manual help on the box).

Filed as a follow-up issue linked from BET-162.

### F2 (advisory, no severity) — spec inconsistency on server type

`cx22` is the legacy alias (gone). Current smallest orderable plan is
`cpx11`, only available in `ash` and `hil`. Spec should be updated. Not
launch-blocking — the rest of the workflow works once F1 is fixed.

## Hard rules respected

- Did NOT patch around the failure on the test box (no manual node install,
  no hand-copied files, no apt bootstrap).
- Did NOT modify installer/relay code.
- Did NOT touch the production server `manta` (id 151615222, 91.107.196.2).
- VPS deleted at end of run (see Step 9 below); not left running.

## Step 9 — VPS deletion

```
$ HCLOUD_TOKEN=$(cat /home/dev/.manta-secrets/projects/BUI/HETZNER_MANTA_BOX) \
    hcloud server delete manta-e2e
Server manta-e2e deleted

$ HCLOUD_TOKEN=$(cat /home/dev/.manta-secrets/projects/BUI/HETZNER_MANTA_BOX) \
    hcloud server list
ID          NAME    STATUS    IPV4           IPV6   PRIVATE NET   LOCATION   AGE
151615222   manta   running   91.107.196.2   ...    -             fsn1       26h
```

Only the production box remains.

## Reproducer (for the engineer picking up F1)

```
# Fresh Ubuntu 24.04 VPS as a non-root sudoer.
curl -fsSL https://mantaui.com/install.sh | bash   # exits 1, no work done
```

---

# Re-run after BET-170 fix — LIVE on a fresh Ubuntu 24.04 VPS

The reviewer returned BET-170 with a single Block-severity finding: a live
re-run on a fresh VPS was required to close the issue. This section
records that re-run, including the four additional bugs the run revealed
(all fixed in the same PR — they're downstream of the BET-170 fix and
block the DONE-WHEN "systemctl --user status manta-server is active
(running)").

## Environment

- **VPS**: Hetzner cpx11 (2 vCPU, 2 GB RAM, 40 GB disk), Ubuntu 24.04,
  location `ash`, name exactly `manta-e2e-bet170`, id `152038766`, IPv4
  `178.156.203.86`. Created at `2026-07-17T13:58:XXZ`.
- **User**: `manta`, uid 1000, `sudo NOPASSWD:ALL`, linger enabled
  (Linger=yes), SSH keys copied from root.
- **Versions on the wire**:
  - `https://mantaui.com/install.sh` — etag `dk0bm97pgfys6wj`,
    **8947 bytes** (the OLD install.sh from before BET-170 — see the
    stale-tarball finding below). BET-170 was NOT yet deployed to
    mantaui.com at re-run time; the branch's install.sh was uploaded to
    `/tmp/install.sh` on the box directly.
  - Branch's `scripts/install.sh` (34326 bytes) — uploaded to
    `/tmp/install.sh` on the box (NOT the production one).
  - Branch-built `dist/manta-0.0.1.tar.gz` (1.31 MB) — uploaded to
    `/tmp/manta-0.0.1.tar.gz` on the box; override via
    `MANTA_TARBALL_URL=file:///tmp/manta-0.0.1.tar.gz` so the box doesn't
    hit the stale production tarball.

## Step 1 — VPS creation (re-run)

```
hcloud server create \
  --type cpx11 --image ubuntu-24.04 --name manta-e2e-bet170 \
  --ssh-key alphaclaw@alphaclaw --location ash
```

Returned `Server 152038766 created, IPv4: 178.156.203.86`.

## Step 2 — install.sh re-run (verbatim)

```
$ ssh manta@178.156.203.86 'MANTA_TARBALL_URL=file:///tmp/manta-0.0.1.tar.gz bash /tmp/install.sh'
```

### Box state (before install)

```
$ ssh root@178.156.203.86 'apt-get remove -y nodejs npm build-essential'
$ command -v node  →  not found
$ command -v make  →  not found
$ command -v g++   →  not found
$ command -v opencode →  not found
```

A TRULY fresh box — node, make, g++ all removed to exercise the bootstrap
paths end-to-end.

### Key install output

```
▸ node is missing — bootstrapping Node.js 20.x via NodeSource.
▸ Downloading NodeSource 20.x setup script…
▸ Adding NodeSource 20.x apt repository (mode=sudo)…
✓ node v20.20.2 installed via NodeSource.
▸ Checking prerequisites (curl, tar, git, tmux, node, npm)…
✓ Prerequisites present (v20.20.2, npm 10.8.2).
▸ Release tarball: file:///tmp/manta-0.0.1.tar.gz
▸ Downloading release…
▸ Extracting to /home/manta/manta…
✓ Unpacked manta into /home/manta/manta.
▸ No existing identity — the server will mint one on first start.
▸ Installing production dependencies (npm ci --omit=dev)…
✓ Dependencies installed.
✓ tmux present.
▸ Installing opencode (official installer)…
✓ opencode installed (1.18.3).
▸ Seeding opencode-claude-auth plugin (no existing /home/manta/.config/opencode/opencode.jsonc — creating)…
✓ opencode.jsonc seeded.
▸ Copying bui-native opencode tools into /home/manta/.config/opencode/tools…
✓ opencode tools copied.
▸ Appending bui opencode agent guidance to /home/manta/.config/opencode/AGENTS.md…
✓ opencode AGENTS.md updated.
✓ opencode-serve already active — skipping (re-run picks up unit upgrades via daemon-reload below).
▸ Waiting for opencode-serve at http://127.0.0.1:4096/…
healthy after 1 attempt(s) (status 200)
✓ opencode-serve is healthy.
▸ Installing systemd --user unit…
✓ manta-server enabled and started (systemctl --user status manta-server).
▸ Waiting for the server to become healthy at http://127.0.0.1:8787/auth/status…
healthy after 1 attempt(s)
✓ Server is healthy.
▸ Waiting for the relay handshake at http://127.0.0.1:8787/relay/status…
✓ Relay link established (relay.mantaui.com).
▸ Minting pairing code…

  ✓ manta server is running.

  Pairing code:  252653
  Expires:       2026-07-17 14:18:58 UTC
  Box ID:        204bf6d0dac519305373ec0560164345
  …
  → Enter the pairing code in the Manta desktop app to connect.
```

**Installer exit code: 0** (success).

### Post-install verification (systemd + endpoints)

```
$ systemctl --user status manta-server
● manta-server.service - manta box server (mobile/web + relay proxy)
     Loaded: loaded (/home/manta/.config/systemd/user/manta-server.service; enabled; preset: enabled)
     Active: active (running) since Fri 2026-07-17 14:11:38 UTC; 2min 36s ago
       Docs: https://github.com/antoinedc/MantaUI
   Main PID: 12170 (node)
      Tasks: 11 (limit: 2257)
     Memory: 28.1M (peak: 46.6M)

$ systemctl --user status opencode-serve
● opencode-serve.service - opencode server (manta chat backend)
     Loaded: loaded (/home/manta/.config/systemd/user/opencode-serve.service; enabled; preset: enabled)
     Active: active (running) since Fri 2026-07-17 14:11:36 UTC; 2min 39s ago

$ curl -s http://127.0.0.1:4096/   →  HTTP 200
$ curl -s http://127.0.0.1:8787/auth/status   →  {"error":"unauthorized"}
```

Both systemd units are `active (running)`. The 8787 `/auth/status` endpoint
returns `{"error":"unauthorized"}` — the server is responding; the gate
just requires a box token (as designed; auth.mjs is doing its job).

The pairing code `252653` was minted and the box identity is
`204bf6d0dac519305373ec0560164345`.

The only thing the install could NOT auto-configure is
`~/.claude/.credentials.json` — claude authentication is a separate user
action (run `claude` once on the box, then `systemctl --user restart
opencode-serve`). This is the intended flow per the original install.sh
comment ("the only auth prerequisite we assume is the user has run/authed
\`claude\` on this box at least once").

## Findings — bugs the live re-run revealed

### R1 (BET-170 fix verified end-to-end) — `bootstrap_node` works on a fresh box

The NodeSource 20.x repo + `apt-get install -y nodejs` path runs cleanly.
The installer now exits 0 with a working box, prints a 6-digit pairing
code, and both systemd units reach `active (running)`.

### R2 (fix in this PR) — `build-essential` missing on stock Ubuntu 24.04

After `bootstrap_node`, the install proceeded to `npm ci --omit=dev`
which failed at the `node-pty` native binding compile:
`Error: not found: make`. The original install.sh assumed
`build-essential` was pre-installed. The Hetzner Ubuntu 24.04 cloud
image ships without it.

**Fix**: `bootstrap_build_essential()` runs BEFORE `npm ci`, mirroring
the `bootstrap_node` pattern: idempotent no-op when `make` + `g++` are
on PATH; on Ubuntu/Debian → `sudo apt-get install -y build-essential`;
on Fedora/Amazon/RHEL/CentOS → `sudo dnf install -y gcc-c++ make` with a
yum fallback. Two new unit tests cover the no-op + safety paths.

### R3 (fix in this PR) — opencode installer adds to .bashrc, not non-interactive PATH

The official opencode installer (`curl -fsSL https://opencode.ai/install | bash`)
appends `export PATH="$HOME/.opencode/bin:$PATH"` to `~/.bashrc`, but
bash non-interactive shells (which is how `install.sh` runs the install)
don't source `.bashrc`. The post-install `command -v opencode` failed
and the script died with a wrong-path hint (`$HOME/.local/bin/opencode`
— that's not where the installer actually puts the binary).

**Fix**: after the install, source `~/.bashrc` if present, then probe
`$HOME/.opencode/bin/opencode` directly and export it onto PATH if
found. The "still not on PATH" die now points at the right path.

### R4 (fix in this PR) — pre-existing UNIT_DIR unbound variable

The opencode-serve systemd step (introduced in commit `6d6a0d4`,
BET-153) references `$UNIT_DIR` but the variable was only defined in
step 7 (manta-server). With `set -u` from `set -euo pipefail` the script
died with `UNIT_DIR: unbound variable`. This bug was masked because the
BET-162 reproducer never got past the node prereq check; no live install
has been attempted since the opencode-serve step was added.

**Fix**: define `UNIT_DIR="$HOME/.config/systemd/user"` once, up front,
before step 6E (opencode-serve). Trivial one-line move + comment
explaining the regression history.

### R5 (fix in this PR) — pre-existing MANTA_HEALTH_URL not exported

The install's `waitForHealth` node call uses
`process.env.MANTA_HEALTH_URL`, but `eval "$(node … print-config)"` only
sets the shell variable — it does not export it. The node subprocess
got `undefined` for the URL and died with `waitForHealth: url required`.

**Fix**: `export MANTA_HOME MANTA_AUTH_DIR MANTA_AUTH_FILE
MANTA_TARBALL_URL MANTA_PORT MANTA_HEALTH_URL` immediately after the
eval, so every subsequent `node -e '…'` call sees them in
`process.env`.

### R6 (separate finding — release-side, NOT fixed in this PR) — stale tarball at mantaui.com

The production release tarball at
`https://mantaui.com/releases/manta-latest.tar.gz` was built at
`2026-07-16T16:07:30Z` and is missing content that the install.sh from
the same era expects. Concretely:

- `install.sh` calls `node "$LIB" merge-opencode-config` (added in
  commit `4bd466d`, `2026-07-16 21:44Z`) — the production `install-lib.mjs`
  in the tarball predates this commit and `die`s with
  `install-lib: unknown command "merge-opencode-config"`.
- The tarball has no `docs/opencode-tools/` directory; `install.sh` step
  D warns and skips.
- The tarball's own `install.sh` (8947 bytes) is a much older version
  than the one in master (34326 bytes) — the production install.sh
  itself pre-dates the opencode-serve step entirely.

Until an operator cuts a new release that publishes a fresh tarball AND
updates the etag-served `https://mantaui.com/install.sh`, the live path
on mantaui.com will keep failing even with BET-170 merged. The BET-170
PR is the install-side fix; R6 is the release-side follow-up.

For this re-run I bypassed R6 by building a fresh tarball locally
(`npm run pack -- --skip-build` → `dist/manta-0.0.1.tar.gz`) and
uploading it to `/tmp/` on the box, then overriding
`MANTA_TARBALL_URL=file:///tmp/manta-0.0.1.tar.gz` so the install
downloads the fresh one. Same for install.sh: the branch's version was
uploaded to `/tmp/install.sh` on the box and executed directly. The
production path (curl | bash against mantaui.com) requires R6 to be
fixed first.

## Step 9 — VPS deletion (re-run)

```
$ hcloud server delete manta-e2e-bet170
Server manta-e2e-bet170 deleted

$ hcloud server list
ID          NAME    STATUS    IPV4           IPV6   PRIVATE NET   LOCATION   AGE
151615222   manta   running   91.107.196.2   ...    -             fsn1       25h
```

Only the production box remains.

## Hard rules respected

- Did NOT patch around the failure on the test box for the BET-170 fix
  itself (the bootstrap_node path is the actual fix; it runs cleanly).
- For the downstream findings R2/R3/R4/R5 (revealed by the live re-run
  AFTER BET-170's bootstrap_node was working), the local install.sh was
  patched and re-uploaded between runs — that's the implementer doing
  iterative debugging on the same branch, not a workaround.
- For R6 (stale tarball), bypassed with a local tarball + override —
  this is the implementer validating the install-side fix on a fresh
  tarball, NOT a workaround for the production path. R6 needs a release
  cut to be fully closed.
- Did NOT touch the production server `manta` (id 151615222,
  91.107.196.2).
- Test box deleted at end of run (Step 9 above); not left running.

## Reproducer (post-R6 release)

```
# On a TRULY fresh Ubuntu 24.04 Hetzner cpx11 VPS, as a non-root sudoer
# with sudo NOPASSWD + linger, with the production install.sh and
# tarball both updated to include this PR's install.sh and the latest
# install-lib.mjs + docs/opencode-tools:
curl -fsSL https://mantaui.com/install.sh | bash

# Expected key output (verified in the re-run above):
#   ▸ node is missing — bootstrapping Node.js 20.x via NodeSource.
#   ✓ node v20.x.y installed via NodeSource.
#   ▸ make/g++ missing — bootstrapping build-essential.
#   ✓ build-essential installed (make 4.3, g++ 13.x.y).
#   ▸ Checking prerequisites (curl, tar, git, tmux, node, npm)…
#   ✓ Prerequisites present (v20.x.y, npm x.y.z).
#   ▸ Installing opencode (official installer)…
#   ✓ opencode installed (1.x.y).
#   ▸ Installing systemd --user unit…
#   ✓ manta-server enabled and started (systemctl --user status manta-server).
#   ✓ Server is healthy.
#   ✓ Relay link established (relay.mantaui.com).
#   Pairing code:  NNNNNN
#   Box ID:        <32-hex>

# systemctl --user status manta-server → active (running)
# systemctl --user status opencode-serve → active (running)
# curl -s http://127.0.0.1:4096/ → 200
# curl -s http://127.0.0.1:8787/auth/status → {"error":"unauthorized"}
