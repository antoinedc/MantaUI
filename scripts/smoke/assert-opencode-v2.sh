#!/usr/bin/env bash
# assert-opencode-v2.sh — prove a box runs the PINNED OpenCode V2 with Manta's setup.
#
# Used by .github/workflows/macos-install-smoke.yml (after an install, and again after a
# re-install); every path/URL is overridable so it can also be pointed at a sandboxed server.
#
#   WANT_VERSION=2.0.30 bash scripts/smoke/assert-opencode-v2.sh
#
# Asserts:
#   1. `opencode --version` reports exactly the pinned version
#   2. ~/.manta/opencode-password exists, is non-empty, mode 0600
#   3. GET /api/info          → 401 without credentials, 401 with a WRONG password
#   4. GET /api/info          → 200 with HTTP Basic opencode:<password>, reporting the pinned version
#   5. GET /api/plugin        → the Manta plugins (manta, manta.claude-max, manta.optimizer) are
#                               ACTIVE. OpenCode loads plugins lazily (measured: ~4s after start), so
#                               this polls for up to PLUGIN_WAIT_S seconds.
# The password is never printed and never put on a command line (curl reads it from stdin).
set -euo pipefail

WANT_VERSION="${WANT_VERSION:?set WANT_VERSION to the pinned OpenCode version}"
OC_BIN="${OC_BIN:-$HOME/.opencode/bin/opencode}"
OC_URL="${OC_URL:-http://127.0.0.1:4096}"
PW_FILE="${PW_FILE:-$HOME/.manta/opencode-password}"
LOCATION_DIR="${LOCATION_DIR:-$HOME}"
PLUGIN_WAIT_S="${PLUGIN_WAIT_S:-90}"
WANT_PLUGINS="${WANT_PLUGINS:-manta manta.claude-max manta.optimizer}"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. the binary
[ -x "$OC_BIN" ] || fail "$OC_BIN is not an executable"
got="$("$OC_BIN" --version 2>&1 | head -n1)"
want_re="(^|[^0-9.])${WANT_VERSION//./\\.}([^0-9.]|\$)"
[[ "$got" =~ $want_re ]] || fail "opencode --version reported '$got', expected the pinned $WANT_VERSION"
echo "ok: $OC_BIN --version = '$got' (pinned $WANT_VERSION)"

# 2. the password file
[ -s "$PW_FILE" ] || fail "$PW_FILE is missing or empty"
# GNU first: on Linux `stat -f` is "filesystem status" — it succeeds and prints something else.
perm="$(stat -c '%a' "$PW_FILE" 2>/dev/null || stat -f '%Lp' "$PW_FILE")"
[ "$perm" = "600" ] || fail "$PW_FILE has mode $perm, expected 600"
pw="$(tr -d '\r\n' < "$PW_FILE")"
[ -n "$pw" ] || fail "$PW_FILE holds no password"
[ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$pw"
echo "ok: password file present, mode 600, ${#pw} chars"

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }
# `curl -K -` takes the credential from stdin: it never appears in an argument list.
authed() { printf 'user = "opencode:%s"\n' "$1" | curl -s --max-time 10 -K - "${@:2}"; }

# 3. unauthenticated / wrong password → 401
c="$(code "$OC_URL/api/info")"
[ "$c" = "401" ] || fail "GET /api/info without credentials answered $c, expected 401"
c="$(printf 'user = "opencode:%s"\n' "not-the-password" | curl -s -o /dev/null -w '%{http_code}' --max-time 10 -K - "$OC_URL/api/info" || true)"
[ "$c" = "401" ] || fail "GET /api/info with a wrong password answered $c, expected 401"
echo "ok: GET /api/info → 401 without credentials, 401 with a wrong password"

# 4. the real password → 200, reporting the pinned version
body="$(mktemp)"; trap 'rm -f "$body"' EXIT
c="$(printf 'user = "opencode:%s"\n' "$pw" | curl -s -o "$body" -w '%{http_code}' --max-time 10 -K - "$OC_URL/api/info" || true)"
[ "$c" = "200" ] || fail "GET /api/info with the box password answered $c, expected 200"
reported="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version",""))' "$body")"
[ "$reported" = "$WANT_VERSION" ] || fail "the running server reports version '$reported', expected $WANT_VERSION"
echo "ok: GET /api/info → 200 with Basic auth; the RUNNING server is $reported"

# 5. Manta's plugins loaded (lazy: poll)
enc="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$LOCATION_DIR")"
deadline=$((SECONDS + PLUGIN_WAIT_S))
while :; do
  printf 'user = "opencode:%s"\n' "$pw" | curl -s --max-time 10 -K - -o "$body" "$OC_URL/api/plugin?location%5Bdirectory%5D=$enc" || true
  missing="$(python3 - "$body" $WANT_PLUGINS <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1])).get("data", [])
except Exception:
    data = []
active = {p["id"] for p in data if isinstance(p, dict) and p.get("state", {}).get("status") == "active"}
print(" ".join(w for w in sys.argv[2:] if w not in active))
PY
)"
  [ -z "$missing" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "plugins reported by the server (id:status):" >&2
    python3 -c 'import json,sys; [print("  ", p.get("id"), p.get("state",{}).get("status")) for p in json.load(open(sys.argv[1])).get("data",[]) if not str(p.get("id")).startswith("opencode.")]' "$body" >&2 || true
    fail "Manta plugins not active after ${PLUGIN_WAIT_S}s: $missing"
  fi
  sleep 2
done
echo "ok: GET /api/plugin → active: $WANT_PLUGINS"
