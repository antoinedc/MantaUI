#!/usr/bin/env bash
# spike/native-visual/capture.sh — the ONE deterministic iOS-simulator capture
# recipe for the SwiftUI reference app.
#
# Produces two artefacts into $OUT_DIR:
#   session-list.png         — a settled-frame PNG screenshot of the session list
#   session-list-hierarchy.txt — the live accessibility element hierarchy (text)
#
# Determinism (the native analog of scripts/visual/harness.mjs's rules, applied
# to a fixed simulator instead of a fixed browser):
#   - The simulator device + iOS runtime are pinned (not "whatever is
#     available"): DEVICE_UDID/DEVICE_NAME must be set. A floating destination
#     is not reproducible.
#   - The status bar is overridden to a fixed time and a full, charged battery
#     (this is the single most common thing that makes iOS captures differ).
#   - UI animations are reduced.
#   - The capture waits on a REAL settled state, never a fixed timer: two
#     consecutive screenshots must be byte-identical before one is kept (a
#     launch transition or material animation still in flight just stays
#     "unstable" until it finishes). The hierarchy dump waits on the "Sessions"
#     title existing before it reads the tree.
#   - No retry-until-pass: if screenshots never converge, the run fails loudly
#     instead of emitting whichever frame.

set -euo pipefail

: "${DEVICE_UDID:?pinned simulator UDID required}"
: "${DEVICE_NAME:?pinned simulator name required}"
: "${APP_PATH:?built .app path required}"
: "${BUNDLE_ID:?app bundle id required}"
: "${OUT_DIR:?output directory required}"
SIMCCTL_DESTINATION="platform=iOS Simulator,id=$DEVICE_UDID"

mkdir -p "$OUT_DIR"

echo "== boot pinned simulator: $DEVICE_NAME ($DEVICE_UDID) =="
# simctl list prints header + runtime header before the device line, so `sed -n
# '2p'` grabbed "-- iOS 26.5 --" and never saw "Booted" — on a real machine a
# second consecutive run hit `boot` on an already-booted device and errored.
# Match on the device line's reported state instead.
STATE=$(xcrun simctl list devices "$DEVICE_UDID" | grep "Booted" | head -1)
echo "state: ${STATE:-not booted}"
if [[ -z "$STATE" ]]; then
  xcrun simctl boot "$DEVICE_UDID"
  # bootstatus -b blocks until the device is fully booted (real state, no sleep).
  xcrun simctl bootstatus "$DEVICE_UDID" -b
  echo "booted: $(xcrun simctl list devices "$DEVICE_UDID" | sed -n '2p')"
else
  echo "already booted"
fi

echo "== override status bar (fixed time, full charged battery) =="
xcrun simctl status_bar "$DEVICE_UDID" override \
  --time "9:41" \
  --batteryState charged \
  --batteryLevel 100 \
  --cellularBars 4 \
  --wifiBars 3

echo "== reduce UI animations =="
xcrun simctl spawn "$DEVICE_UDID" defaults write com.apple.Accessibility ReduceMotionEnabled -bool true 2>/dev/null || true

echo "== install + launch =="
xcrun simctl install "$DEVICE_UDID" "$APP_PATH"
xcrun simctl terminate "$DEVICE_UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl launch "$DEVICE_UDID" "$BUNDLE_ID"

echo "== wait for a settled frame (convergent screenshot, not a timer) =="
TMP_SHOT="$OUT_DIR/.settle.png"
LAST=""
n=0
while [ "$n" -lt 60 ]; do
  xcrun simctl io "$DEVICE_UDID" screenshot "$TMP_SHOT" >/dev/null 2>&1
  if [ -n "$LAST" ] && cmp -s "$TMP_SHOT" "$LAST"; then
    echo "settled at attempt $n"
    cp "$TMP_SHOT" "$OUT_DIR/session-list.png"
    rm -f "$LAST" "$TMP_SHOT"
    break
  fi
  LAST="$OUT_DIR/.last.png"
  cp "$TMP_SHOT" "$LAST"
  n=$((n + 1))
  sleep 0.5
done
if [ ! -f "$OUT_DIR/session-list.png" ]; then
  echo "FAIL: screenshot never converged after $n attempts — frames kept differing."
  echo "This is a real non-determinism (launch transition or animation still running), not noise."
  rm -f "$OUT_DIR/.last.png" "$OUT_DIR/.settle.png"
  exit 1
fi
[ -n "$LAST" ] && rm -f "$LAST"

echo "== dump accessibility hierarchy (XCUITest gate: nav bar exists, no timer) =="
xcrun simctl terminate "$DEVICE_UDID" "$BUNDLE_ID" 2>/dev/null || true
HIER_LOG="$OUT_DIR/.xctest.log"
set +e
xcodebuild \
  -project "$APP_PROJECT" \
  -scheme MantaSpikeRef \
  -destination "$SIMCCTL_DESTINATION" \
  -derivedDataPath "$DERV_DATA" \
  -only-testing:MantaSpikeRefUITests/HierarchyDumpUITests/testDumpSessionListAccessibilityHierarchy \
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
# Redact the two live values that change on every launch — heap object addresses
# (0x…) and the process id — replacing each with a fixed placeholder so the line
# structure and column positions are preserved and the dump is reproducible.
# Nothing else on the line is touched: this is a redaction, not a rewrite.
awk '
  /AX-TREE-BEGIN/{f=1;next}
  /AX-TREE-END/{f=0}
  f{
    gsub(/0x[0-9a-fA-F]+/, "0xADDR")
    gsub(/pid: [0-9]+/, "pid: PID")
    print
  }
' "$HIER_LOG" > "$OUT_DIR/session-list-hierarchy.txt"
rm -f "$HIER_LOG"
echo "words in hierarchy: $(wc -w < "$OUT_DIR/session-list-hierarchy.txt")"

xcrun simctl terminate "$DEVICE_UDID" "$BUNDLE_ID" 2>/dev/null || true

echo "== artefacts =="
ls -la "$OUT_DIR"
echo "PASS"