# Release publishing: disk guard, feed-last uploads, desktop pruning

Status: agreed 2026-11-20. Scope: release pipeline only (CI/Codemagic + one script).

## Problem

On 2026-11-19 the prod web box (`root@91.107.196.2`, webroot `/var/www/mantaui`,
38 GB disk) was 100% full. The `mac-v1.5.0` publish uploaded `latest-mac.yml` first,
then the update ZIP was cut off at 42 MB of 112 MB. Every Mac was offered 1.5.0 and
could not install it. Causes:

1. Nothing ever deletes old release files (desktop installers since 0.0.x, ~14 GB).
2. Nothing checks free space before uploading.
3. The mac and Windows publish steps upload the feed (`latest-mac.yml` / `latest.yml`)
   BEFORE the binaries it names, and `scp` writes straight to the final filename, so a
   failed upload leaves a live feed pointing at a missing or truncated file.

## Behaviour

### `scripts/release/prod-disk.sh` (new, runs ON the prod box)

Invoked over ssh as `ssh <host> bash -s -- <command> <args…> < scripts/release/prod-disk.sh`
(the box has no repo checkout of this script; the workflow streams it). Commands:

- `guard <bytes> <dir>` — exits non-zero, printing `need <N> free, have <M>` in
  human units, when free space on `<dir>`'s filesystem is below `<bytes>` + 2 GiB margin.
- `prune-desktop <keep> <dir>…` — in each `<dir>` (non-recursive), find desktop artifacts
  named `Manta UI-<version>-*` or `Manta-UI-<version>-*` (also `Manta-Staging…` variants
  if they follow the same `-<version>-` shape). Group by `<version>`, version-sort
  (`sort -V`), keep the newest `<keep>` versions, delete the rest. Never deletes any
  other file (`latest*.yml`, `Manta-latest*.dmg/.exe`, `server.json`, anything else).
  Prints each deleted file and the total freed. `<keep>` must be an integer ≥ 2, else exit 2.
- Anything else → usage, exit 2. `set -euo pipefail`, POSIX tools only (GNU coreutils
  on the box: `df --output=avail -B1`, `sort -V`).

Server tarballs (`releases/manta-*`) are NEVER pruned: a box rolling back an upgrade
re-installs its previous release, which can be old.

### Mac publish (`codemagic.yaml`, step "Publish to mantaui.com (optional)")

1. Before uploading: `guard` with the total size of the files about to be uploaded
   (`.dmg` ×2 + `.zip`) against `$MANTA_FEED_DIR`.
2. Upload every binary to `<name>.part`, then rename to `<name>` on the box (one ssh
   `mv`), so a cut-off upload never sits under a name the feed points at.
3. Upload `latest-mac.yml` LAST (also via `.part` + rename).
4. Refresh the canonical DMG as today.
5. After success: `prune-desktop 3 $MANTA_FEED_DIR $MANTA_DOWNLOADS_DIR`.

### Windows publish (`.github/workflows/windows-desktop-build.yml`)

Same shape: guard (exe ×2), `.part` + rename for the exe uploads, `latest.yml` LAST,
canonical copy as today, then `prune-desktop 3` on both dirs.

### Server tarballs (`.github/workflows/server-tarball-deploy.yml`)

`guard` with the summed tarball sizes before the upload loop. No pruning. Ordering is
already manifest-last.

### `scripts/release/publish.sh` (manual path)

If it uploads desktop artifacts or tarballs, apply the same guard and feed-last order.
Don't restructure it otherwise.

## Tests

`scripts/release/prod-disk.test.mjs` (node:test, picked up by `npm test`'s
`scripts/release/*.test.mjs` glob), running the script locally with `bash`:
- prune keeps the newest N versions across both name shapes and mixed extensions,
  version-sorts correctly (`0.0.9` < `0.0.10` < `1.0.0`), never touches
  `latest-mac.yml`, `latest.yml`, `Manta-latest.dmg`, `Manta-latest-x64.exe`,
  `server.json` or unrelated files; `keep` < 2 or non-numeric → exit 2.
- guard passes with a tiny request, fails with an absurd one (e.g. 10^18 bytes) with
  the message.
- unknown command → exit 2.

## Libraries considered

| Need | Chosen | Considered / why |
|---|---|---|
| Free-space check + pruning on the web box | ~60-line bash script | It runs on a bare box over ssh; a tool like logrotate/tmpreaper doesn't do version-aware retention, and adding a dependency to a prod box for this isn't worth it. |
| Atomic upload | `scp` to `.part` + `mv` | `rsync --partial-dir`/`--delay-updates` would do it but isn't guaranteed on the Codemagic/Windows runners; `mv` within one filesystem is atomic. |
