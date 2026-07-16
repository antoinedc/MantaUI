#!/usr/bin/env bash
# rename-dev-app.sh — make `npm run dev` show "Better UI" instead of "Electron"
# in macOS notifications, the menu bar, and the dock.
#
# WHY: the renderer fires notifications via the Web Notification API. On macOS
# the OS attributes those to the *bundle* that's running. In dev that bundle is
# the generic node_modules/electron/dist/Electron.app, whose CFBundleName is
# "Electron" — so notifications read "Electron" no matter what app.setName() says
# (setName only fixes packaged builds). This patches the dev bundle's Info.plist.
#
# Run this on the MAC, once after every `npm install` (it re-extracts Electron):
#   bash scripts/rename-dev-app.sh
#
# It's macOS-only and idempotent. No-ops cleanly on Linux/CI.

set -euo pipefail

APP_NAME="Manta UI"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "rename-dev-app: not macOS — nothing to do."
  exit 0
fi

PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
if [[ ! -f "$PLIST" ]]; then
  echo "rename-dev-app: $PLIST not found (run from repo root after npm install)."
  exit 0
fi

set_key() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"
}

set_key CFBundleName "$APP_NAME"
set_key CFBundleDisplayName "$APP_NAME"

# Refresh Launch Services so the new name is picked up without a logout.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "node_modules/electron/dist/Electron.app" 2>/dev/null || true

echo "rename-dev-app: dev Electron bundle renamed to \"$APP_NAME\"."
echo "Restart \`npm run dev\` for it to take effect."
