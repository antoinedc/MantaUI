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
