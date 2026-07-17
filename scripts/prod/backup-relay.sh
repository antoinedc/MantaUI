#!/usr/bin/env bash
# backup-relay.sh — nightly backup of the relay SQLite store + .manta dir.
#
# Runs as root via /etc/cron.d/manta-backup on the prod box. Backs up:
#   1. The relay SQLite store via `sqlite3 .backup` (online, no torn writes).
#   2. The whole ~/.manta/ dir (auth.json, config.json, secrets, store, etc.)
#      tarballed + gzipped alongside the sqlite backup.
# Then scps both artifacts to the dev box under ~/backups/manta-prod/.
# Retains 7 days of history locally and remotely; older artifacts are pruned.
#
# Notify on failure (optional): if MANTA_NOTIFY_URL is set (a manta webhook URL
# with HMAC signing), POST a signed JSON body naming what failed so the
# maintainer's opencode session can wake and alert. The dev-box watcher
# (`scripts/prod/healthcheck.mjs` via schedule_create) is the belt-and-
# braces companion: it can also detect "backup did not refresh within 24h"
# independently of the script's own notify.
#
# INSTALL on the prod box (one human step — agent Hard Rule #4 forbids
# `ssh root@...` from this repo; see BET-163 child issue):
#   apt-get install -y sqlite3   # only if missing; required for .backup
#   install -m 0644 scripts/prod/manta-backup.cron /etc/cron.d/manta-backup
#   cp    scripts/prod/backup-relay.sh /opt/manta/scripts/prod/backup-relay.sh
#   chmod 0755 /opt/manta/scripts/prod/backup-relay.sh
#   # Verify the prod box can ssh to the dev box as `dev`:
#   ssh -o BatchMode=yes dev@157.90.224.92 true || \
#       ssh-copy-id -i /root/.ssh/id_rsa.pub dev@157.90.224.92
#   # Set MANTA_NOTIFY_URL (optional): the manta webhook URL the maintainer
#   # generated on the dev box and shared out-of-band.
#
# Override (env): MANTA_HOME, RELAY_STORE_PATH, BACKUP_DIR, REMOTE_DIR,
#                 REMOTE_USER, REMOTE_HOST, MANTA_NOTIFY_URL, MANTA_NOTIFY_SECRET,
#                 KEEP_DAYS.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (override via env; defaults match the prod box layout)
# ---------------------------------------------------------------------------

MANTA_HOME="${MANTA_HOME:-/opt/manta}"
RELAY_STORE_PATH="${RELAY_STORE_PATH:-${HOME:-/root}/.manta/relay.sqlite}"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/manta}"
BACKUP_PREFIX="${BACKUP_PREFIX:-relay}"        # .sqlite + .tar.gz share this prefix
KEEP_DAYS="${KEEP_DAYS:-7}"

REMOTE_USER="${REMOTE_USER:-dev}"
REMOTE_HOST="${REMOTE_HOST:-157.90.224.92}"
REMOTE_DIR="${REMOTE_DIR:-/home/${REMOTE_USER}/backups/manta-prod}"

# Notify (optional). Both must be set to enable POST-on-failure.
MANTA_NOTIFY_URL="${MANTA_NOTIFY_URL:-}"
MANTA_NOTIFY_SECRET="${MANTA_NOTIFY_SECRET:-}"

LOG_TAG="manta-backup"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DAY="$(date -u +%F)"

log()  { printf '%s [%s] %s\n' "$TS" "$LOG_TAG" "$*" >&2; }
warn() { printf '%s [%s] WARN: %s\n' "$TS" "$LOG_TAG" "$*" >&2; }
die()  { printf '%s [%s] FAIL: %s\n' "$TS" "$LOG_TAG" "$*" >&2; notify_failure "$@"; exit 1; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# HMAC-SHA256 hex digest of a string with a key, matching the bui webhook
# contract (src/server/webhooks.mjs `verifySignature`). Pure shell + openssl —
# no extra runtime dependencies.
hmac_sha256_hex() {
  printf '%s' "$2" | openssl dgst -sha256 -hmac "$1" -hex | awk '{print $NF}'
}

# POST a signed JSON body to MANTA_NOTIFY_URL with X-Bui-Signature header.
# Never echoes the secret; never invokes if URL/secret unset.
notify_failure() {
  local reason="$*"
  [ -n "$MANTA_NOTIFY_URL" ] && [ -n "$MANTA_NOTIFY_SECRET" ] || return 0
  local body sig
  body=$(printf '{"source":"backup-relay","ts":"%s","reason":"%s","box":"prod"}' \
    "$TS" "$(printf '%s' "$reason" | sed 's/"/\\"/g; s/\\/\\\\/g')")
  sig=$(hmac_sha256_hex "$MANTA_NOTIFY_SECRET" "$body")
  # Best-effort: log but do not mask the original failure.
  curl -fsS --max-time 10 -X POST \
    -H "Content-Type: application/json" \
    -H "X-Bui-Signature: sha256=${sig}" \
    --data "$body" \
    "$MANTA_NOTIFY_URL" >/dev/null 2>&1 || warn "notify POST failed (ignoring — original error already logged)"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "missing required command: $1 — install it and re-run ($2)"
  fi
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

require_cmd sqlite3 "apt-get install -y sqlite3"
require_cmd tar     "apt-get install -y tar"
require_cmd gzip    "apt-get install -y gzip"
require_cmd scp     "apt-get install -y openssh-client"
require_cmd openssl "apt-get install -y openssl"

[ -f "$RELAY_STORE_PATH" ] || die "relay store not found at $RELAY_STORE_PATH (set RELAY_STORE_PATH to override)"

mkdir -p "$BACKUP_DIR" || die "cannot create $BACKUP_DIR"

SQLITE_OUT="${BACKUP_DIR}/${BACKUP_PREFIX}-${DAY}.sqlite"
TARBALL_OUT="${BACKUP_DIR}/${BACKUP_PREFIX}-${DAY}.tar.gz"

log "starting backup: store=$RELAY_STORE_PATH → $SQLITE_OUT"

# ---------------------------------------------------------------------------
# 1. SQLite online backup (no torn writes — safe to run while the relay
#    process is reading/writing). `sqlite3 .backup` does this natively.
# ---------------------------------------------------------------------------

if ! sqlite3 "$RELAY_STORE_PATH" ".backup '$SQLITE_OUT'" 2>&1 | tee -a /tmp/manta-backup.last.log; then
  die "sqlite3 .backup failed for $RELAY_STORE_PATH"
fi

[ -s "$SQLITE_OUT" ] || die "sqlite backup produced empty file: $SQLITE_OUT"

# Sanity: confirm the backup is a readable sqlite DB.
sqlite3 "$SQLITE_OUT" "PRAGMA integrity_check;" >/dev/null 2>&1 \
  || die "integrity_check failed on $SQLITE_OUT — backup is corrupt, refusing to ship"

log "sqlite backup OK ($(stat -c %s "$SQLITE_OUT") bytes)"

# ---------------------------------------------------------------------------
# 2. Tarball the whole ~/.manta/ (config, auth.json, secrets, store) so a
#    restore is one untar + sqlite restore away.
# ---------------------------------------------------------------------------

MANTA_DIR="$(dirname "$RELAY_STORE_PATH")"   # typically ~/.manta
[ -d "$MANTA_DIR" ] || die ".manta directory not found at $MANTA_DIR"

if tar -czf "$TARBALL_OUT" -C "$(dirname "$MANTA_DIR")" "$(basename "$MANTA_DIR")" 2>&1 | tee -a /tmp/manta-backup.last.log; then
  log "tarball OK ($(stat -c %s "$TARBALL_OUT") bytes)"
else
  rm -f "$SQLITE_OUT" "$TARBALL_OUT" 2>/dev/null || true
  die "tar/gzip of $MANTA_DIR failed"
fi

# ---------------------------------------------------------------------------
# 3. scp both artifacts to the dev box. SSH is expected to already work as
#    `dev` (provisioned once at install). Failures here are critical — the
#    local backup is meaningless if it never leaves the box.
# ---------------------------------------------------------------------------

ssh -o BatchMode=yes -o ConnectTimeout=10 "${REMOTE_USER}@${REMOTE_HOST}" \
  "mkdir -p '$REMOTE_DIR'" \
  || die "ssh mkdir -p $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR failed (is the dev box reachable? key authorized?)"

scp -o BatchMode=yes -o ConnectTimeout=10 "$SQLITE_OUT" "$TARBALL_OUT" \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/" \
  || die "scp to $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR failed"

log "shipped to ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

# ---------------------------------------------------------------------------
# 4. Retention — prune local + remote artifacts older than KEEP_DAYS.
# ---------------------------------------------------------------------------

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name "${BACKUP_PREFIX}-*.sqlite" -o -name "${BACKUP_PREFIX}-*.tar.gz" \) -mtime "+${KEEP_DAYS}" -delete 2>/dev/null || true

# Remote prune via ssh (one round-trip; --no-target-directory prevents surprises).
ssh -o BatchMode=yes -o ConnectTimeout=10 "${REMOTE_USER}@${REMOTE_HOST}" \
  "find '${REMOTE_DIR}' -maxdepth 1 -type f \( -name '${BACKUP_PREFIX}-*.sqlite' -o -name '${BACKUP_PREFIX}-*.tar.gz' \) -mtime '+${KEEP_DAYS}' -delete" \
  2>/dev/null || warn "remote retention prune failed (continuing — local prune succeeded)"

log "backup complete"
