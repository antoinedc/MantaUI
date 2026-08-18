// list-cli-bin-dirs.mjs — emit the HOME-relative AI CLI install dirs to
// stdout, one per line.
//
// Single source: HOME_CLI_INSTALL_DIRS in src/shared/cliCatalog.mjs — the
// SAME constant resolveBinary() in src/server/cliUpdates.mjs pins. It is kept
// as a separate small script so scripts/self-update.sh (a POSIX-ish bash
// updater that has NODE_CMD in scope) can consume the machine-readable list
// without duplicating the dirs in shell (BET-1163).
//
// Emitted paths are RELATIVE to $HOME (e.g. `.local/bin`); the caller prepends
// `$HOME/` when building an absolute dir. This mirrors how resolveBinary()
// resolves each entry against its own env.HOME.

import { HOME_CLI_INSTALL_DIRS } from "../src/shared/cliCatalog.mjs";

for (const rel of HOME_CLI_INSTALL_DIRS) {
  process.stdout.write(rel + "\n");
}
