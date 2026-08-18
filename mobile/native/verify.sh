#!/usr/bin/env bash
# Compile + unit-test the app's pure logic on Linux, in Docker.
#
# The Linux dev box has no Swift toolchain, so this runs the official Swift image
# against mobile/native/Package.swift — a manifest listing the Foundation-only
# subset of the app's sources (see the comment in Package.swift).
#
# This is NOT the merge gate. It cannot see anything that touches SwiftUI, UIKit
# or the simulator. The full gate is the Mac plugin:
#   plugin_run("ios-mantaui", { action: "test-unit", branch: "<branch>" })
# Use this for a fast inner loop, that for sign-off.
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="${SWIFT_IMAGE:-swift:6.1}"

exec docker run --rm \
  -v "$PWD:/work" \
  -w /work \
  "$IMAGE" \
  bash -lc "swift build --build-path .build && swift test --build-path .build"
