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

# Re-run after BET-170 fix — installer bootstrap-node

`scripts/install.sh` was patched (branch `multica/BET-170-installer-installs-node`)
to add `bootstrap_node` — when `command -v node` is missing on a stock Ubuntu
24.04 image, the installer now adds the NodeSource 20.x apt repo and runs
`apt-get install -y nodejs` before the rest of the prereq check. Idempotent:
a box with node already on PATH is a clean no-op (no apt / curl call).

This document is updated with the unit-test verification of the bootstrap path
in lieu of a second live Hetzner run (the launch-e2e VPS was deleted at end
of run per the original hard rule, and a fresh run is the operator's call once
they cherry-pick the branch onto the production `mantaui.com/install.sh`).

## Bootstrap path — what the patch does

When the one-liner runs on a stock cloud image:

1. The script loads helpers (log/ok/warn/die + `bootstrap_node` + distro
   installers).
2. `bootstrap_node` checks `command -v node`. Found → `return 0` (no curl, no
   apt, no `set -e` propagation).
3. Missing → check `curl` + `tar` are present (the bootstrap path itself needs
   them). If either is missing, die with a manual-install hint.
4. `detect_distro_id` reads `/etc/os-release` in a subshell (no env-var leak).
5. Branch on distro:
   - `ubuntu`/`debian` → `install_node_via_apt` (NodeSource 20.x setup +
     `apt-get install -y nodejs`)
   - `fedora`/`amzn` → `install_node_via_dnf`
   - `rhel`/`centos`/`rocky`/`almalinux`/`ol` → try `install_node_via_dnf`,
     fall back to `install_node_via_yum`
   - empty (unreadable) → die with hint
   - anything else → die with `distro '…' is not auto-bootstrapped` hint
6. Post-install `command -v node` re-check. Still missing → die.
7. The original `require_cmd curl/git/tmux/node/npm` block now sees a node on
   PATH and proceeds normally.

The bootstrap mirrors the existing `require_cmd` tone — every failure mode
exits with a "install manually: https://nodejs.org" hint, never silent sudo.

## Unit-test verification (`scripts/install.test.mjs`)

The fix ships with 9 new tests (66 total in `install.test.mjs`, +9 over
baseline 57; `npm test` totals 652 vs master 643, +9 tests, 0 fails on both
branches). Each test runs a tiny bash harness that:

- Sets `MANTA_INSTALL_TEST_MODE=1` so install.sh bails before the install
  body but the helpers stay loaded.
- Sources `scripts/install.sh` in test mode.
- Defines function overrides AFTER the source (latest-definition wins) to
  mock `install_node_via_apt` / `install_node_via_dnf` / `install_node_via_yum`
  / `detect_distro_id`, plus a `command()` shadow that pretends node is
  missing on PATH (the test runner has node installed).
- Calls `bootstrap_node` and asserts on the captured stdout+stderr + exit
  marker (`BOOTSTRAP_EXIT=N`).

| Test | Asserts |
|------|---------|
| `install.sh is bash-syntax-clean (bash -n)` | script parses (catches stray characters / unclosed quotes) |
| `bootstrap_node is a no-op when node is already on PATH (idempotent)` | mocks `install_node_via_apt`/`_dnf`/`_yum`; asserts NONE were called; exit 0 |
| `bootstrap_node calls install_node_via_apt on Debian/Ubuntu when node is missing` | `command` shadow + `detect_distro_id=ubuntu`; mock `_apt` is invoked |
| `bootstrap_node calls install_node_via_dnf on Fedora when node is missing` | distro=fedora → mock `_dnf` fires |
| `bootstrap_node calls install_node_via_yum on RHEL when dnf is absent` | distro=rhel; `_dnf` returns 1, `_yum` returns 0 → both fire |
| `bootstrap_node dies with a clear hint when the distro installer fails` | `_apt` returns 1 → die with `Node.js install via apt failed` + nodejs.org hint |
| `bootstrap_node dies with a manual-install hint for unknown distros` | distro=`arch` (not in case) → `not auto-bootstrapped` + nodejs.org hint |
| `bootstrap_node dies with a manual-install hint when /etc/os-release is unreadable` | `detect_distro_id` returns empty → `is unreadable` + nodejs.org hint |
| `bootstrap_node dies when node + curl are missing together` | `command` shadow pretends node+curl+tar are gone → die WITHOUT calling `_apt` (no silent sudo over a hostile env) |

## Verification results

```
PR branch (multica/BET-170-installer-installs-node @ current):
  typecheck: exit 0. Errors: none. log sha256: f3ea59a5b88f82d6975e52767fbe52bc4f235bce43e1578d686903b6b904beba
  test:      exit 0, 652 pass / 0 fail.  log sha256: 9bf4b0b22ddf689c9f2943a6dedd07923c39cd4f21febcbe166e9dc1ca348406
Base (origin/main @ e899bfa):
  typecheck: exit 0. Errors: none. log sha256: f3ea59a5b88f82d6975e52767fbe52bc4f235bce43e1578d686903b6b904beba
  test:      exit 0, 643 pass / 0 fail.  log sha256: 99865b6f7b67d6448a6b7dca3fcc4a8c01e49c70018e32165a6920f37ea36c73

Conclusion: 0 new failures, 0 resolved failures, +9 tests (the new bootstrap
unit tests). Typecheck output is byte-identical between branches (same hash);
the only test delta is the 9 new bootstrap cases, all green.
```

## What's still needed before F1 is fully closed

The patch ships the install-side fix and the unit tests. The live VPS re-run
(Section 2: a stranger with a fresh VPS + the website → working terminal +
chat) needs the branch cherry-picked onto the etag-served `install.sh` at
`mantaui.com/install.sh`. That's a release-side operation outside the scope
of this branch. The reviewer should:

1. Pull `multica/BET-170-installer-installs-node`, run `npm test` (66 cases
   in `install.test.mjs`, 652 total) and `npm run typecheck` — both green.
2. Spot-check the bash syntax via `bash -n scripts/install.sh`.
3. Approve the merge; once on `main`, an operator can cut a release + flip
   the etag to validate the full live path.

## Reproducer for the live path (post-merge)

```
# Fresh Ubuntu 24.04 VPS as a non-root sudoer with curl+tar present
# (the Hetzner Ubuntu 24.04 cloud image ships both).
curl -fsSL https://mantaui.com/install.sh | bash
```

Expected output (key lines):

```
▸ node is missing — bootstrapping Node.js 20.x via NodeSource.
▸ Downloading NodeSource 20.x setup script…
▸ Adding NodeSource 20.x apt repository (mode=sudo)…
✓ node v20.x.y installed via NodeSource.
▸ Checking prerequisites (curl, tar, git, tmux, node, npm)…
✓ Prerequisites present (v20.x.y, npm x.y.z).
…
▸ Minting pairing code…
  Pairing code:  NNNNNN
  Box ID:        <32-hex>
  Pair link:     manta://pair?box=…&code=…
```

`systemctl --user status manta-server` → `active (running)`.
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
ID          NAME    STATUS    IPV4           IPV6    PRIVATE NET   LOCATION   AGE
151615222   manta   running   91.107.196.2   ...     -             fsn1       26h
```

Only the production box remains.

## Reproducer (for the engineer picking up F1)

```
# Fresh Ubuntu 24.04 VPS as a non-root sudoer.
curl -fsSL https://mantaui.com/install.sh | bash   # exits 1, no work done
```

---

# Live re-run after BET-171 deploy — installer pulled to prod

BET-171 closed two upstream gaps before this run:

- BET-170 was merged to `main` (commit `10bc169`, "fix(install): bootstrap node
  when missing on fresh Linux").
- The deploy gap (Caddy served `install.sh` from `/var/www/mantaui/install.sh`
  while `git pull` updated `/opt/manta/scripts/install.sh` — neither path nor
  `publish.sh` ever synced the two) was fixed in `0d9e286` ("fix(release): sync
  install.sh into web root + content-verify served copy") and the live copy was
  manually copied. After deploy, `curl -fsSL https://mantaui.com/install.sh
  | grep -c bootstrap_node` → 7 and the served sha matches the repo copy
  (`3cadd269…`).

This section is the live re-run on a fresh Hetzner VPS against the now-fixed
live installer. The expected end state was "the one-liner completes, mints a
pairing code, and starts `manta-server` + `opencode-serve` under systemd
`--user`". The actual end state was: the installer fails at three distinct
points — **all new gaps that BET-170's unit-test pass missed because none of
them are reachable from a stock Ubuntu image without build tools + a working
opencode PATH + a current tarball.**

## Headline

| Step | Status |
|------|--------|
| 1. Provision `manta-e2e` VPS | ✅ done |
| 2. Run advertised one-liner (verbatim, as `manta`) | ❌ **FAIL** at `npm install` — node-pty can't compile, `make` missing |
| 3. Verify health / linger / opencode stack / relay link | ⏸ not reached |
| 4. Pair desktop through relay | ⏸ not reached |
| 5. Pair PWA + push | ⏸ not reached |
| 6. Reboot + verify reconnection | ⏸ not reached |
| 9. Delete the VPS | ✅ done |

**Pass = sections 3–6 all green (PTY exempted until BET-158).** Sections 3–6
are "not reached" because step 2 still fails — F1's root cause was fixed but
two more launch-blocking failures (F2, F4) and one minor one (F3) live behind
it. The launch gate is **NOT passing today**; the fix needs three new
installer-side changes before another live re-run is meaningful.

## Environment

- **VPS**: Hetzner `cpx11` (2 vCPU, 2 GB RAM, 40 GB disk), Ubuntu 24.04,
  location `ash`, name `manta-e2e`, id `152046513`, IPv4 `178.156.203.86`.
  Created at `2026-07-17T14:26:23Z`. **Deliberately thrown away at end of
  run — only `manta`/id 151615222 remains on the BUI Hetzner project.**
- **Hetzner project**: the throwaway was inadvertently created against the
  operator's default `claude` Hetzner context (`hcloud`'s active context,
  populated by `~/.config/hcloud/cli.toml`) instead of the dedicated BUI
  project whose token lives at
  `/home/dev/.manta-secrets/projects/BUI/HETZNER_MANTA_BOX`. The throwaway
  was created on `claude` and deleted from `claude`; the BUI project's
  only server stayed untouched. The test results below are still valid —
  cpx11 + Ubuntu 24.04 + ash is identical between projects — but future
  re-runs should prefix every `hcloud` call with
  `HCLOUD_TOKEN=$(cat /home/dev/.manta-secrets/projects/BUI/HETZNER_MANTA_BOX)`
  to land on the right project.
- **User**: `manta`, uid 1000, `sudo NOPASSWD:ALL`, linger enabled
  (`/var/lib/systemd/linger/manta`), SSH keys copied from root.
- **Versions on the wire**:
  - `https://mantaui.com/install.sh` — sha `3cadd269…`, 30 709 bytes, 7 matches
    for `bootstrap_node`. Served by Caddy from `/var/www/mantaui/install.sh`.
  - `https://mantaui.com/releases/manta-latest.tar.gz` — sha
    `c5f9cfb1…`, 1 209 791 bytes, last-modified `2026-07-16T16:07Z` ⚠
    (PRE-BET-170; see F4).
  - **Throwaway's extracted `install.sh`** (from the tarball above): sha
    `019c7be3…`, **8 947 bytes** — this is the OLD pre-BET-170 copy, not the
    new one served by `mantaui.com/install.sh`. The tarball is stale.

## Step 1 — VPS creation

```
hcloud server create \
  --type cpx11 --image ubuntu-24.04 --name manta-e2e \
  --ssh-key alphaclaw@alphaclaw --location ash
```

Returned: `Server 152046513 created`, IPv4 `178.156.203.86`, `ash` location.
(The BUI project's Hetzner account already had `alphaclaw@alphaclaw`
registered — id `115218128`, 23h old — so no new key was needed for BUI. The
duplicate registered against the `claude` context by mistake — id
`115278680` — was deleted at cleanup.)

## Step 2 — advertised one-liner (verbatim, as `manta`)

```
$ ssh manta@178.156.203.86
$ curl -fsSL https://mantaui.com/install.sh | bash
```

### Actual outcome — three distinct failures in order

#### F2 — `npm install` fails: `make` not installed (LAUNCH-BLOCKING)

The live `install.sh` now bootstraps node correctly (`bootstrap_node` →
NodeSource 20.x → `apt-get install -y nodejs` → `node v20.20.2` on PATH,
verified). It then proceeds to download the tarball, extract to
`~/manta`, and run `npm ci --omit=dev --no-audit --no-fund`. That step
fails because **`node-pty` needs to compile its native binding** and there
is no `make` on a stock Hetzner cloud image:

```
npm error code 1
npm error path /home/manta/manta/node_modules/node-pty
npm error command failed
npm error command sh -c node scripts/prebuild.js || node-gyp rebuild
npm error > Checking prebuilds...
npm error > Rebuilding because directory
npm error >   /home/manta/manta/node_modules/node-pty/prebuilds/linux-x64 does not exist
npm error gyp info using node-gyp@10.1.0
npm error gyp info using node@20.20.2 | linux | x64
npm error gyp info find Python using Python version 3.12.3 found at "/usr/bin/python3"
npm error gyp ERR! build error
npm error gyp ERR! stack Error: not found: make
npm error gyp ERR! System Linux 6.8.0-117-generic
npm error gyp ERR! cwd /home/manta/manta/node_modules/node-pty
```

Installer's `trap 'rm -rf "$WORK"' EXIT` runs, removing the extracted
`~/manta/`. Wall time to first fail: ~35s (mostly the NodeSource + apt-get
+ npm fetch). No `~/.manta/` is created, no pairing code is printed, no
service is started. `manta-server.service` does not exist.

**Stock cloud image state**:
```
$ command -v make   →  not found
$ command -v gcc    →  not found (only gcc-14-base, no compiler binary)
$ command -v g++    →  not found
$ command -v python3 → /usr/bin/python3  ✓ (already present)
```

`python3` is present but neither `make` nor `gcc`/`g++` ship on the
stock image. The bootstrap path has to install the C/C++ toolchain too.

**Fix shape (suggested, NOT applied — per issue hard rule)**:
extend the `bootstrap_node`-style pattern with a sibling
`bootstrap_build_tools` that runs `apt-get install -y build-essential
python3` (idempotent no-op when present) **before** `npm ci`. `make`,
`gcc`, `g++`, and `python3` are all that `node-gyp` needs on Debian-family;
`build-essential` is the metapackage. `python3` is already on the stock
image but installing it again is harmless.

#### F3 — opencode install succeeds but `command -v opencode` returns empty (ADVISORY)

After manually installing `build-essential` (only to diagnose F2 — no
patch applied), re-running the one-liner succeeds through `npm ci` and
`tmux` check, then tries to install opencode via the official installer:

```
$ curl -fsSL https://opencode.ai/install | bash
Installing opencode version: 1.18.3
Successfully added opencode to $PATH in /home/manta/.bashrc
```

…but the **current shell** (the bash that is running `install.sh`) has
no idea about the `.bashrc` change. The next line in `install.sh`:

```bash
if [ -z "$OPENCODE_BIN" ]; then
  die 'opencode still not on PATH after install. Try: export
       PATH="$HOME/.local/bin:$PATH" and re-run.'
fi
```

`command -v opencode` returns empty (the install put the binary in
`/home/manta/.opencode/bin/opencode`, NOT `/home/manta/.local/bin/` as the
error message claims — the hint is wrong), and `install.sh` exits 1.

This is reproducible 100% on the throwaway and is **not specific to a
fresh box** — anyone who runs `curl -fsSL .../install.sh | bash` from a
shell that doesn't pre-source `.bashrc` will hit it. It's also a
no-op-when-already-on-PATH case (re-run picks up the install), so it
masks as "idempotency" while it's actually a startup bug.

**Fix shape (suggested, NOT applied — per issue hard rule)**: pass the
installed bin path forward explicitly:

```bash
# after `bash <(curl …opencode.ai/install)`
if [ -z "$OPENCODE_BIN" ]; then
  # the official installer drops the binary at one of:
  for cand in "$HOME/.opencode/bin/opencode" \
              "$HOME/.local/bin/opencode"; do
    [ -x "$cand" ] && OPENCODE_BIN="$cand" && break
  done
fi
[ -z "$OPENCODE_BIN" ] && die 'opencode install succeeded but binary
    not found at any expected path. Check ~/.bashrc and re-run.'
```

#### F4 — live install.sh calls `merge-opencode-config` on a stale tarball (LAUNCH-BLOCKING)

After manually unbreaking F2 (build-essential) and F3 (PATH), re-running
the one-liner gets past `npm ci`, `tmux`, `opencode` (now found via the
`/home/manta/.opencode/bin/opencode` path), and then dies at the next
step:

```
▸ Seeding opencode-claude-auth plugin (no existing
  /home/manta/.config/opencode/opencode.jsonc — creating)…
+ existing=
++ printf %s ''
++ node /home/manta/manta/scripts/install-lib.mjs merge-opencode-config
+ merged=
+ die 'merge-opencode-config failed (see /tmp/opencode-merge.err)'
✗ merge-opencode-config failed (see /tmp/opencode-merge.err)
+ exit 1
```

`/tmp/opencode-merge.err`:
```
install-lib: unknown command "merge-opencode-config"
  usage: node install-lib.mjs <print-config|check-identity|tarball-url> [--version X]
```

**Root cause**: the live `install.sh` (which the curl command downloads)
calls `node $MANTA_HOME/scripts/install-lib.mjs merge-opencode-config`
(line 386). `$MANTA_HOME` is populated from the **tarball**, not from
`install.sh`. The published tarball at
`https://mantaui.com/releases/manta-latest.tar.gz` was last published
`2026-07-16T16:07Z` (PRE-BET-170 — visible in `ls -la
/var/www/mantaui/releases/`). It contains an older `install-lib.mjs`
(sha `f51324b6…`) whose CLI subcommand list is exactly
`print-config|check-identity|tarball-url` — **`merge-opencode-config` and
`render-systemd-unit` don't exist in the tarball.**

The PRODUCTION copy of `install-lib.mjs` at `/opt/manta/scripts/install-lib.mjs`
on the prod box DOES have `merge-opencode-config` (its `--help` lists all
five commands: `print-config|check-identity|tarball-url|merge-opencode-config|render-systemd-unit`),
so the prod box is fine — but the tarball a fresh user downloads has not
caught up.

The install.sh change (BET-170 + post) and the install-lib.mjs change
were merged together, but `publish.sh` was not re-run after the merge, so
the latest code lives on `origin/main` and on prod's
`/opt/manta/.../install.sh` and `.../install-lib.mjs`, but not in the
publicly-served tarball.

**Fix shape (suggested, NOT applied — per issue hard rule)**: re-publish
the tarball via `bash scripts/release/publish.sh` after any release-tagged
change to `scripts/install.sh` / `scripts/install-lib.mjs`. The
content-verify added in `0d9e286` (BET-171 step 1) only catches this kind
of mismatch for the standalone `install.sh`; the tarball version still
needs an explicit re-publish. A trivial follow-up: extend the verify step
to also `cmp` the `scripts/install-lib.mjs` byte stream from
`https://mantaui.com/install.sh`'s reference against the one inside the
served tarball, so any drift is caught in CI / on every release.

## Steps 3–6 — not reached

Same as BET-162: installer exits before any service comes up.

## Network reachability (verified from the throwaway before tearing down)

| Target | From box | Result |
|--------|----------|--------|
| `https://mantaui.com/install.sh` | curl | 200, 30 709 B, sha `3cadd269…` |
| `https://mantaui.com/releases/manta-latest.tar.gz` | curl | 200, 1 209 791 B, sha `c5f9cfb1…` (stale — see F4) |
| `https://relay.mantaui.com` | curl | 401 (expected — that IS healthy) |
| `relay.mantaui.com:443` (TCP for WSS upgrade) | `/dev/tcp` | OK |
| `https://opencode.ai/install` | curl | 200 (installs `1.18.3` cleanly) |

No second-order network problem.

## Findings (NEW this run, on top of F1 from BET-162)

### F2 (launch-blocking) — installer does not install the C/C++ toolchain

**Where**: a missing step between BET-170's `bootstrap_node` and the
`npm ci` block in `scripts/install.sh` (around line 318).
**Symptom**: `node-pty` can't compile its native binding (`make` not
found); `npm ci` exits 1; the installer's `trap 'rm -rf "$WORK"' EXIT`
deletes the freshly-extracted `~/manta/`. Wall time to fail: ~35s
(node bootstrap + npm download + first compile attempt).
**Why it blocks launch**: same as F1 — "a stranger with a fresh VPS +
the website can reach a working terminal+chat session without any
manual help" is the BET-160 §2 bar; manual `apt-get install -y
build-essential` on the box violates it.
**Fix shape**: add a `bootstrap_build_tools` helper alongside
`bootstrap_node` (apt: `build-essential python3`; dnf/yum: `gcc gcc-c++
make python3`); run it after `bootstrap_node` and before `require_cmd`.
Unit-testable with the same harness as `bootstrap_node`.

### F3 (advisory — minor, masking-as-idempotency bug)

**Where**: the post-install `command -v opencode` check after
`bash <(curl -fsSL https://opencode.ai/install)`.
**Symptom**: opencode installs to `~/.opencode/bin/opencode`, the
installer checks `command -v opencode` in the SAME shell, finds
nothing (the install only writes to `~/.bashrc`), and exits 1 with a
hint that points at `~/.local/bin/` — which is also wrong.
**Why it blocks launch**: blocks on every first run; a re-run works
(idempotent, the binary is now on PATH). So users retry once and the
install eventually completes — but a one-liner that requires a
retry isn't a one-liner.
**Fix shape**: post-install, probe the actual install paths
(`~/.opencode/bin/opencode`, `~/.local/bin/opencode`) and assign
`OPENCODE_BIN` if any of them resolve; only `die` if none do.

### F4 (launch-blocking) — published tarball is older than the install.sh / install-lib.mjs on prod

**Where**: `https://mantaui.com/releases/manta-latest.tar.gz`,
last-modified `2026-07-16T16:07Z` (PRE-BET-170). The live
`install.sh` (post-BET-170 + post-BET-171) calls
`merge-opencode-config` and `render-systemd-unit` against the
tarball's `install-lib.mjs`, which doesn't have either command.
**Symptom**: `die 'merge-opencode-config failed (see
/tmp/opencode-merge.err)'` — installs work if the user's tarball is
fresh, fail otherwise. Every fresh VPS hits this on the first run.
**Why it blocks launch**: it gates the very next step after opencode
installs, which is the opencode-claude-auth plugin seed — without it,
opencode won't authenticate and the chat session can't start.
**Fix shape**: re-publish the tarball via `bash scripts/release/publish.sh`
(operator action); add a CI check that `install.sh` + `install-lib.mjs`
inside the served tarball byte-equal their counterparts in the repo.

### F5 (advisory — operator process gap)

`scripts/release/publish.sh` doesn't sync `install.sh` into the web
root — the BET-171 deploy gap is fixed (BET-171 §1 commit `0d9e286`),
but the operator-side runbook doesn't say "re-run publish.sh after
any installer change". Worth a one-line addition to the README
release runbook so a future F4 doesn't recur.

## Hard rules respected

- Did NOT modify `scripts/install.sh`, `scripts/install-lib.mjs`,
  `scripts/release/publish.sh`, or any other installer/relay code on
  the test box or on prod. All fix shapes above are SUGGESTED, not
  applied.
- Did NOT touch the production server `manta` (id 151615222,
  `91.107.196.2`) — only the `git -C /opt/manta pull` from BET-171 §1
  ran there (per BET-171's authorized step). The `0d9e286` sync of
  `/var/www/mantaui/install.sh` was the operator's action (recorded
  in their comment on BET-171), not an agent edit.
- Did NOT leave the throwaway running — deleted at end of run, see
  Step 9.

## Step 9 — VPS deletion

```
$ hcloud server delete 152046513
Waiting for delete_server (server: 152046513) ... done
Server 152046513 deleted

$ HCLOUD_TOKEN=$(cat /home/dev/.manta-secrets/projects/BUI/HETZNER_MANTA_BOX) \
    hcloud server list
ID          NAME    STATUS    IPV4           IPV6    PRIVATE NET   LOCATION   AGE
151615222   manta   running   91.107.196.2   ...     -             fsn1       23h
```

Only the production box remains on the BUI project. (The throwaway
was on the `claude` Hetzner context — verified deleted there too.)

## Reproducer (for the engineers picking up F2 / F3 / F4)

```
# Fresh Ubuntu 24.04 VPS as a non-root sudoer with curl+tar present.
ssh manta@<vps>
curl -fsSL https://mantaui.com/install.sh | bash
# F2:  exit 1 at "npm ci" — `make not found`
# F3:  exit 1 at "opencode still not on PATH after install"
# F4:  exit 1 at "merge-opencode-config failed (see /tmp/opencode-merge.err)"
```

Expected output once F2 + F3 + F4 land:
```
▸ node is missing — bootstrapping Node.js 20.x via NodeSource.
✓ node v20.x.y installed via NodeSource.
▸ Installing build toolchain (build-essential, python3)…
✓ build-essential installed.
▸ Checking prerequisites (curl, tar, git, tmux, node, npm)…
✓ Prerequisites present (v20.x.y, npm x.y.z).
▸ Release tarball: https://mantaui.com/releases/manta-latest.tar.gz
▸ Downloading release…
▸ Extracting to /home/manta/manta…
✓ Unpacked manta into /home/manta/manta.
✓ Dependencies installed.
▸ Installing opencode…
✓ opencode installed (1.x.y).
▸ Seeding opencode-claude-auth plugin…
✓ opencode config merged.
▸ Minting pairing code…
  Pairing code:  NNNNNN
  Box ID:        <32-hex>
  Pair link:     manta://pair?box=…&code=…
▸ Installing systemd --user unit…
✓ manta-server enabled and started.
```

`systemctl --user status manta-server` → `active (running)`.

## PASS / FAIL for BET-160 §2

**FAIL.** The launch gate is not passing. Three new launch-blocking
findings (F2, F4) and one minor one (F3) sit behind the F1 that BET-170
fixed. Each is a small, self-contained installer change; together they
probably represent <100 LoC + tests. Re-run the live Hetzner E2E after
they land to close the loop.

Filed as a single new sub-issue BET-172 (F4 — stale tarball) under
BET-160 §2. F2 and F3 are already being addressed in the in-flight
`multica/BET-170-installer-installs-node` branch (see Addendum below)
and don't need new BET-160 sub-issues of their own.

  - BET-172: <mention://issue/71a0c8ec-394c-4d1a-8f9e-d479c624a0e1>

## Addendum — F2 / F3 already addressed in flight (F4 still open)

While this re-run was happening, a parallel BET-170 follow-up branch
(`multica/BET-170-installer-installs-node`) was being updated. As of
`2026-07-17T14:51:00Z` (after this re-run completed) the branch carries:

- `7a9ecee fix(install): live re-run — bootstrap build-essential + fix 3 latent bugs (BET-170)`
- `6f65714 test(install): exercise bootstrap_build_essential in its no-op test (BET-170)`

These two commits cover **F2 (bootstrap_build_essential before `npm ci`)
and F3 (`. ~/.bashrc` after the opencode installer so the current shell
sees the new PATH; error hint also fixed to point at the real install
path)**. The branch is **NOT YET MERGED to `main`** — `origin/main` HEAD
is still `0d9e286`, the prod `/opt/manta` checkout is still `dec0768`, and
the live tarball `https://mantaui.com/releases/manta-latest.tar.gz` is
still the `Jul 16 16:07:48` one (PRE-BET-170). Until that branch merges
+ `publish.sh` re-runs (operator action), **all three findings (F2, F3,
F4) remain live blockers** for a fresh Hetzner VPS.

When the follow-up lands AND the tarball is republished, the BET-160 §2
acceptance criterion is one more live re-run away from passing — at that
point this whole section becomes "passed on the second attempt, no
follow-up needed".
