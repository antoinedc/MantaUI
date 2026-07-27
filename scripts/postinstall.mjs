// postinstall.mjs — the repo's ONLY postinstall step.
//
// WHY THIS FILE EXISTS: npm runs `postinstall` through the platform's shell —
// `sh` on macOS/Linux, `cmd.exe` on Windows. The previous inline command was
//
//   electron-rebuild -f -w node-pty || true; bash scripts/rename-dev-app.sh || true
//
// which cmd.exe cannot run at all: it has no `bash`, no `true`, and does not
// treat `;` as a separator. `npm ci` therefore failed outright on Windows,
// before a single line of the app was built. A tiny node script is the one
// form of "shell" every platform npm runs on already has.
//
// The electron-rebuild half is GONE, not ported. It rebuilt node-pty against
// Electron's ABI, but node-pty is a BOX SERVER dependency (src/server/pty.mjs,
// run by plain node under systemd) and the desktop app never imports it —
// electron-builder.yml excludes it from the package and sets
// `npmRebuild: false`. Rebuilding it for Electron was at best wasted work and
// at worst broke the server's copy. If a native dependency is ever added to
// the DESKTOP, reinstate the rebuild there rather than here.
//
// This script must NEVER fail an install. Everything it does is cosmetic
// developer convenience; any error is reported and swallowed.

import { spawnSync } from "node:child_process";

// The dev-bundle rename is macOS-only by construction (it edits an Info.plist
// via PlistBuddy). The shell script self-no-ops elsewhere, but there is no
// reason to spawn a bash we may not have.
if (process.platform === "darwin") {
  const r = spawnSync("bash", ["scripts/rename-dev-app.sh"], {
    stdio: "inherit",
  });
  if (r.error) {
    console.warn(`postinstall: rename-dev-app skipped (${r.error.message})`);
  }
}
