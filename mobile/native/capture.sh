#!/usr/bin/env bash
# mobile/native/capture.sh — the ONE deterministic iOS-simulator capture recipe
# for the native MantaUI app. This is the permanent, maintained home of the
# recipe proven by BET-451's PoC and first written on the never-merged
# `spike/native-visual` branch; it is rebuilt here under `mobile/` as a kept
# thing, not a copy of the spike's alongside it.
#
# Produces two artefacts into $OUT_DIR (both legs are mandatory — dropping the
# screenshot removes the only coverage of colour/typography/radius, which the
# accessibility hierarchy cannot see):
#   $SCENE.png            — a settled-frame PNG screenshot of the app
#   $SCENE-hierarchy.txt  — the live accessibility element hierarchy as text
#
# Determinism rules (the native analog of scripts/visual/harness.mjs applied to
# a fixed simulator instead of a fixed browser). Every rule exists because a
# capture was flaky without it:
#   - The simulator device AND iOS runtime are PINNED by name+version and
#     resolved to a single UDID. A floating "whatever is available" destination
#     is not reproducible. Resolution fails loudly if the pinned device is
#     missing or ambiguous.
#   - The status bar is OVERRIDDEN to a fixed time and a full, charged battery
#     (the single most common thing that makes iOS captures differ — without it
#     the clock differs in every capture and every future baseline drifts).
#   - The system appearance is pinned to light, and UI animations are REDUCED.
#   - The capture waits on a REAL settled state, never a fixed timer: two
#     consecutive screenshots must be byte-identical before one is kept (a
#     launch transition or material animation still in flight just stays
#     "unstable" until it finishes). The hierarchy dump waits on a real
#     rendered element before it reads the tree.
#   - NO retry-until-pass: if the screenshots never converge, the run fails
#     loudly instead of emitting whichever frame.
#
# Usage:
#   DEVICE_NAME=... RUNTIME_IOS=... OUT_DIR=... SCENE=... mobile/native/capture.sh
#
# Env overrides:
#   DEVICE_NAME   pinned simulator device (default "iPhone 17 Pro")
#   RUNTIME_IOS   pinned iOS runtime version (default "26.5")
#   SCENE         output filename prefix (default "screen")
#   SCENE_MODE    app scene to capture: empty = parent transcript (default),
#                 "child" = the subagent drill-in screen (S4b)
#   OUT_DIR       output directory (default "$REPO/mobile/native/.capture-out")
#   BUILD_DIR     xcodebuild DerivedData (default "$REPO/mobile/native/.build")
#
# Exit 0 = both artefacts written; non-zero = a determinism problem, reported
# loudly, never papered over.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

: "${DEVICE_NAME:=iPhone 17 Pro}"
: "${RUNTIME_IOS:=26.5}"
: "${SCENE:=screen}"
# The capture scenes are EXPLICIT since S2 (BET-594): the app root gates a
# real fresh install into the onboarding flow, so the measurement fixtures are
# only reachable through a non-empty scene. "parent" = the S4b transcript
# parent, "child" = the subagent drill-in, "onboarding-*" = the S2 joiner
# screens.
: "${SCENE_MODE:=parent}"
: "${OUT_DIR:=$REPO_ROOT/mobile/native/.capture-out}"
: "${BUILD_DIR:=$REPO_ROOT/mobile/native/.build}"

PROJECT="$REPO_ROOT/mobile/native/MantaUI.xcodeproj"
SCHEME="MantaUI"
BUNDLE_ID="com.antoinedc.mantaui"
APP_PATH="$BUILD_DIR/Build/Products/Debug-iphonesimulator/MantaUI.app"

mkdir -p "$OUT_DIR"

# -- 1. Resolve the PINNED device to exactly one UDID --------------------------
# The runtime token "26.5" becomes "26-5" to match the CoreSimulator runtime id
# "com.apple.CoreSimulator.SimRuntime.iOS-26-5". We filter devices by BOTH the
# exact name and the exact runtime so an equally-named device on another
# runtime can never be silently captured.
RT_TOKEN="${RUNTIME_IOS//./-}"
UDID="$(xcrun simctl list -j devices available | \
  python3 -c '
import json, sys
data = json.load(sys.stdin)
name, rt_token = sys.argv[1], sys.argv[2]
hits = []
for rt, devs in data.get("devices", {}).items():
    if rt != "com.apple.CoreSimulator.SimRuntime.iOS-" + rt_token:
        continue
    for d in devs:
        if d["name"] == name:
            hits.append(d["udid"])
if not hits:
    sys.exit("FAIL: pinned device %r on iOS %s not found in available simulators" % (name, sys.argv[3]))
if len(hits) > 1:
    sys.exit("FAIL: pinned device %r is ambiguous (%d matches) on iOS %s" % (name, len(hits), sys.argv[3]))
print(hits[0])
' "$DEVICE_NAME" "$RT_TOKEN" "$RUNTIME_IOS")"
echo "pinned device: $DEVICE_NAME (iOS $RUNTIME_IOS) -> $UDID"
SIMCCTL_DESTINATION="platform=iOS Simulator,id=$UDID"

# -- 2. Boot the pinned simulator (idempotent) --------------------------------
STATE="$(xcrun simctl list devices "$UDID" | grep "Booted" | head -1)"
echo "device state: ${STATE:-not booted}"
if [[ -z "$STATE" ]]; then
  xcrun simctl boot "$UDID"
  # bootstatus -b blocks until fully booted (real state, no sleep).
  xcrun simctl bootstatus "$UDID" -b
fi
# Give CoreSimulator a moment so the booted device is actually usable.
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

# -- 3. Pin the status bar to a fixed time + full charged battery -------------
echo "== override status bar (fixed time 9:41, charged 100%) =="
xcrun simctl status_bar "$UDID" override \
  --time "9:41" \
  --batteryState charged \
  --batteryLevel 100 \
  --cellularBars 4 \
  --wifiBars 3

echo "== pin appearance to light =="
xcrun simctl ui "$UDID" appearance light >/dev/null 2>&1 || true

echo "== reduce UI animations =="
xcrun simctl spawn "$UDID" defaults write com.apple.Accessibility ReduceMotionEnabled -bool true >/dev/null 2>&1 || true

# -- 4. Build the app (Debug, simulator) --------------------------------------
echo "== build $SCHEME for simulator =="
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -destination "$SIMCCTL_DESTINATION" \
  -derivedDataPath "$BUILD_DIR" \
  build >/dev/null 2>&1
if [ ! -d "$APP_PATH" ]; then
  echo "FAIL: build did not produce $APP_PATH"
  exit 1
fi

# -- 5. Install + launch, then wait for a SETTLED frame -----------------------
# Two consecutive byte-identical screenshots must agree before one is kept. No
# retry-until-pass: if the frame never converges the run fails loudly.
echo "== install + launch (scene: '${SCENE_MODE:-parent}') =="
xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
# The scene is delivered to the app by TWO channels so both capture legs see
# the same scene: a SIMCTL_CHILD_ env var (the only way `simctl launch` gives
# the screenshot leg's process its environment) AND a UserDefaults value (the
# hierarchy leg's app is launched by the XCUITest runner, which inherits
# neither of those, but the app reads UserDefaults itself). Both are explicit
# per scene, so the selection is deterministic and the legs cannot disagree.
if [ -n "$SCENE_MODE" ]; then
  export SIMCTL_CHILD_MANTA_SCENE="$SCENE_MODE"
  xcrun simctl spawn "$UDID" defaults write "$BUNDLE_ID" MantaScene -string "$SCENE_MODE" >/dev/null 2>&1 || true
else
  unset SIMCTL_CHILD_MANTA_SCENE
  xcrun simctl spawn "$UDID" defaults delete "$BUNDLE_ID" MantaScene >/dev/null 2>&1 || true
fi
xcrun simctl launch "$UDID" "$BUNDLE_ID"

echo "== wait for a settled frame (convergent screenshot, not a timer) =="
TMP_SHOT="$OUT_DIR/.settle.png"
LAST=""
n=0
converged=0
while [ "$n" -lt 90 ]; do
  xcrun simctl io "$UDID" screenshot "$TMP_SHOT" >/dev/null 2>&1
  if [ -n "$LAST" ] && cmp -s "$TMP_SHOT" "$LAST"; then
    echo "settled at attempt $n"
    cp "$TMP_SHOT" "$OUT_DIR/$SCENE.png"
    rm -f "$LAST" "$TMP_SHOT"
    converged=1
    break
  fi
  LAST="$OUT_DIR/.last.png"
  cp "$TMP_SHOT" "$LAST"
  n=$((n + 1))
  sleep 0.5
done
if [ "$converged" != "1" ]; then
  echo "FAIL: screenshot never converged after $n attempts — frames kept differing."
  echo "This is a real non-determinism (launch transition or animation still running), not noise."
  rm -f "$OUT_DIR/.last.png" "$OUT_DIR/.settle.png"
  exit 1
fi

# -- 6. Dump the accessibility hierarchy as normalised, diffable text ---------
# The XCUITest prints the live tree between bounded markers. Live values that
# change on every launch — heap object addresses (0x…) and the process id —
# are REDACTED to fixed placeholders so the line structure and column positions
# are preserved and the dump is reproducible. Nothing else on a line is touched.
echo "== dump accessibility hierarchy =="
xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
HIER_LOG="$OUT_DIR/.xctest.log"
set +e
# The XCUITest runner does not inherit the shell env, so arm the scene via the
# app's OWN UserDefaults (which the app reads at launch) rather than relying on
# forwarding an env var through the test harness.
if [ -n "$SCENE_MODE" ]; then
  xcrun simctl spawn "$UDID" defaults write "$BUNDLE_ID" MantaScene -string "$SCENE_MODE" >/dev/null 2>&1 || true
else
  xcrun simctl spawn "$UDID" defaults delete "$BUNDLE_ID" MantaScene >/dev/null 2>&1 || true
fi
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -destination "$SIMCCTL_DESTINATION" \
  -derivedDataPath "$BUILD_DIR" \
  -only-testing:MantaUIUITests/MantaUIHierarchyCaptureUITests/testDumpAccessibilityHierarchy \
  test > "$HIER_LOG" 2>&1
RC=$?
set -e
if [ "$RC" != "0" ]; then
  echo "FAIL: XCUITest failed (rc=$RC). Tail:"
  tail -40 "$HIER_LOG"
  rm -f "$HIER_LOG"
  exit 1
fi
if ! grep -q 'AX-TREE-BEGIN' "$HIER_LOG"; then
  echo "FAIL: AX-TREE markers missing from test output."
  rm -f "$HIER_LOG"
  exit 1
fi
awk '
  /AX-TREE-BEGIN/{f=1;next}
  /AX-TREE-END/{f=0}
  f{
    # XCTest instrumentation note ("t = NN.NNs Requesting snapshot…") carries a
    # wall-clock timestamp and an inline pid, so it is non-deterministic. Drop
    # the whole line; everything inside the markers is preserved otherwise.
    if ($0 ~ /^[ \t]*t =[ \t]*[0-9.]+s/) next
    gsub(/0x[0-9a-fA-F]+/, "0xADDR")
    gsub(/pid: [0-9]+/, "pid: PID")
    gsub(/\bpid [0-9]+/, "pid PID")
    print
  }
' "$HIER_LOG" > "$OUT_DIR/$SCENE-hierarchy.txt"
rm -f "$HIER_LOG"

# The hierarchy must be captureable as PARSEABLE text, not just bytes. Verify a
# minimum signal: labelled/identified elements with a frame survive the dump.
parseable="$(python3 -c '
import re, sys
lines = [l for l in open(sys.argv[1], encoding="utf-8").read().splitlines() if l.strip()]
frame_label = sum(1 for l in lines if re.search(r"0xADDR, \{\{[-\d.]+", l) and ("label:" in l or "identifier:" in l))
print(frame_label)
' "$OUT_DIR/$SCENE-hierarchy.txt")"
echo "elements carrying a frame + label/identifier: $parseable"
if [ -z "$parseable" ] || [ "$parseable" -eq 0 ]; then
  echo "FAIL: hierarchy captured but contains no parseable element (frame+label)."
  exit 1
fi

xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true

echo "== artefacts =="
ls -la "$OUT_DIR"
echo "PASS"
