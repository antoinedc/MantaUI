#!/bin/sh
# Xcode Cloud post-clone step.
#
# Xcode Cloud clones the repo, then (before resolving dependencies / building)
# runs this script from the directory that contains the Xcode project's
# `ci_scripts/` folder — i.e. mobile/ios/App. Its job is to reproduce, in the
# ephemeral macOS build environment, everything `npm run apk` / a local dev
# would do before opening Xcode:
#
#   1. install root JS deps and build the web bundle into mobile/www
#      (the iOS app's webDir); `mobile/www` is a committed build artifact but
#      we rebuild it here so a tag always ships fresh renderer code.
#   2. install mobile/ JS deps (Capacitor CLI + @capacitor/ios live here; the
#      Podfile references ../../node_modules/@capacitor/ios).
#   3. `npx cap sync ios` — copies www into the native project and wires pods.
#   4. `pod install` so the .xcworkspace Xcode Cloud builds has its Pods.
#
# Fail hard on any error so a broken build surfaces in the Xcode Cloud log
# instead of producing a stale/broken archive.
set -e

echo "===> ci_post_clone.sh starting (pwd: $(pwd))"

# Xcode Cloud runs this from mobile/ios/App/ci_scripts OR mobile/ios/App
# depending on version; normalize to the repo root regardless.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# ci_scripts -> App -> ios -> mobile -> repo root
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
echo "===> repo root: $REPO_ROOT"

# --- Node toolchain -------------------------------------------------------
# Xcode Cloud macOS images do NOT ship Node. Install via Homebrew (present on
# the image). Pin to the major version the project builds with locally.
if ! command -v node >/dev/null 2>&1; then
  echo "===> node not found; installing via Homebrew"
  brew install node@22
  brew link --overwrite --force node@22
fi
echo "===> node $(node -v) / npm $(npm -v)"

# --- 1. Root deps + web bundle -------------------------------------------
cd "$REPO_ROOT"
echo "===> npm ci (repo root)"
npm ci
echo "===> npm run build:mobile (renderer -> mobile/www)"
npm run build:mobile

# --- 2. Mobile deps -------------------------------------------------------
cd "$REPO_ROOT/mobile"
echo "===> npm ci (mobile/)"
npm ci

# --- 3. Capacitor sync ----------------------------------------------------
echo "===> npx cap sync ios"
npx cap sync ios

# --- 4. CocoaPods ---------------------------------------------------------
cd "$REPO_ROOT/mobile/ios/App"
if ! command -v pod >/dev/null 2>&1; then
  echo "===> cocoapods not found; installing"
  brew install cocoapods
fi
echo "===> pod install"
pod install --repo-update

echo "===> ci_post_clone.sh done"
