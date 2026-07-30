# Releases (maintainer runbook)

In order. No decisions, no extra steps:

1. Bump `package.json` version.
2. Build the box-server tarballs (one invocation per arch; requires BOTH
   arches before `publish.sh` will proceed):
   - `node scripts/release/pack.mjs --arch x64` produces
     `dist/manta-<version>-linux-x64.tar.gz` (the self-contained
     tarball) AND `dist/manta-<version>-linux-x64.txt` (the per-arch
     key=value manifest sidecar).
   - `node scripts/release/pack.mjs --arch arm64` produces the same two
     outputs with `linux-arm64` in the filename. Run on a native arm64
     host (the arm64 `node-pty` binding cannot be cross-compiled; the
     `server-tarball-deploy.yml` workflow builds both arches in a
     matrix on a `server-v<version>` tag, see `AGENTS.md` "Release &
     CD pipeline").
   - `node scripts/release/merge-manifest.mjs \
       dist/manta-<version>-linux-x64.txt \
       dist/manta-<version>-linux-arm64.txt \
       --out dist/manta-<version>.txt` assembles the combined
     key=value manifest `install.sh` fetches at runtime.
3. (Mac only, on a Mac) `bash scripts/release/desktop.sh` produces
   `dist/desktop/*.dmg` and the `latest-*.yml` updater feeds. Linux
   builds run on any host. The Windows installer is NOT built here —
   it needs a Windows host and is produced by the
   `windows-desktop-build.yml` workflow as an artifact only (see
   `AGENTS.md` "Windows desktop (`win-v*`)").
4. `bash scripts/release/publish.sh` uploads both per-arch tarballs
   plus the combined manifest, restarts `manta-server` on prod,
   HEAD-checks every URL, tags `v<version>`. Idempotent: re-publishing
   the same version is a safe no-op. Override the target with
   `MANTA_PROD_HOST=...` for staging.

Done.

## Staging install

Staging is a parallel `staging/` subtree on the same prod webroot,
served as `https://mantaui.com/staging/...` (see the "Staging channel"
section in `AGENTS.md` and the per-channel value table in
`src/shared/channel.mjs`, BET-370). It is **manual-only** — tag triggers
(`web-v*`, `server-v*`, `mac-v*`) keep meaning prod; staging is triggered
by hand after the spec change lands.

`install.sh` is served **byte-identical** across channels (no build-time
substitution — `scripts/release/publish.sh` copies the same file to both
`/var/www/mantaui/` and `/var/www/mantaui/staging/`). The staging URL
signals "staging" to a human, but once piped into bash the script has no
way to recover the URL it was fetched from — it falls back to
`MANTA_CHANNEL=${MANTA_CHANNEL:-prod}`. So the canonical staging
curl-install command exports the channel explicitly:

```
curl -fsSL https://mantaui.com/staging/install.sh | MANTA_CHANNEL=staging bash
```

Without `MANTA_CHANNEL=staging` the script defaults to prod: it pulls the
tarball from the prod release host (`https://mantaui.com/releases/...`) and
prints a `manta://` (not `manta-staging://`) pair link at the end — a
staging URL that behaves identically to prod, including a prod pair-link
scheme baked into the `manta` CLI shim and the manta-server systemd unit.

The two callers that already set this correctly (BET-386):

- **The desktop app's SSH orchestrator** (`src/main/installer/installer.ts`)
  resolves the build channel and passes `MANTA_CHANNEL=<channel>` in the
  same curl-pipe command as `MANTA_RELEASE_HOST`.
- **An operator who manually exports `MANTA_CHANNEL`** before running or
  piping `install.sh` — i.e. the command above.

The raw `curl -fsSL https://mantaui.com/staging/install.sh | bash` path
(without the env var) is the only gap: it's internal/QA-only (BET-370
scoped "nothing about the box" out, and the primary user-facing paths —
the SSH-orchestrated desktop install and prod's default curl command — are
unaffected), so this section exists to close it before anyone writes a
staging curl-install doc elsewhere.

## Rollback

The atomic pointer is `manta-latest.txt` (the combined manifest), not
a tarball. `publish.sh` uploads every release's per-arch tarballs
(`manta-<version>-linux-x64.tar.gz` plus
`manta-<version>-linux-arm64.tar.gz`) into
`/var/www/mantaui/releases/` and never deletes the previous release's
files, so reversing the manifest pointer is all that's needed to
restore an older release on the box:

```
ssh $MANTA_PROD_HOST 'cd /var/www/mantaui/releases \
    && cp -f manta-<prev-version>.txt manta-latest.txt \
    && git -C /opt/manta checkout v<prev-version> \
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

- **mantaui.com** (Hetzner "manta" box): Caddy serves the static site
  plus `/install.sh` plus `/releases/*`. Deploy = scp static files
  into `/var/www/mantaui/`.
- **gateway.mantaui.com** (same Hetzner box, separate Caddy vhost
  reverse-proxying loopback `:20081`): the hosted push gateway.
  `systemd manta-gateway`. Deploy = `git -C /opt/manta pull` plus
  `systemctl restart manta-gateway`; static files re-read per request.
- **app.mantaui.com**: the maintainer box's own tunnel (each user
  brings their own host).
- DNS on Cloudflare (apex/www/gateway DNS-only: Caddy does TLS;
  per-box `<box_id>.boxes.mantaui.com` A records managed by the
  gateway via OVH's API; wildcard `*.pages.<domain>` via DNS-01).

### Prod box ops

Ops scripts and configs are committed under `scripts/prod/` so the box
is rebuildable from git. None of these touch application code; the
install steps in each file's header are human-only (agent Hard Rule
#4 forbids `ssh root@...`).

- **Monitoring** (`scripts/prod/healthcheck.mjs`, scheduled every 10
  min on the dev box via `schedule_create`): off-site probes of
  `mantaui.com`, `gateway.mantaui.com/healthz` (200 = healthy),
  `app.mantaui.com`, and `/install.sh`, plus the per-arch tarball
  drift check: HEAD the tarballs the live `manta-latest.txt` manifest
  declares (`file_linux_x64=`, `file_linux_arm64=`) AND sha256-verify
  each against the manifest's `sha256_linux_x64` plus
  `sha256_linux_arm64`. Same loop publish.sh runs at verify-time,
  pushed out off-site so it catches tarballs that drift from the
  manifest AFTER publish (BET-171 F4 class, BET-264 two-arch). On
  failure the opencode turn calls `notify` urgent:true naming the
  failing URL.
- **Log caps** (`scripts/prod/systemd-journald.conf`,
  `scripts/prod/caddy-logrotate`): journald capped at 500M; Caddy
  access logs (only if they exist on the box, check first) rotated
  daily with 14 generations.
- **Patches** (`scripts/prod/50unattended-upgrades`): security origin
  only; updates left to a human reboot window.
- **Brute-force** (`scripts/prod/jail.local`): sshd jail only, no HTTP
  jail (Caddy and the box server have their own rate limits).
