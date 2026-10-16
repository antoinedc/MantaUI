// upgrade-clis.test.mjs — the release PINS opencode; the generic CLI upgrader must never run
// `opencode upgrade` (slice C3). Static: the script is a side-effecting CLI, so importing it to
// run main() would spawn real upgrades.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_CLIS } from "./upgrade-clis.mjs";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "upgrade-clis.mjs"), "utf8");

test("opencode is pinned, and the loop skips every pinned CLI before it prints or runs anything", () => {
  assert.ok(PINNED_CLIS.includes("opencode"));
  const skip = SRC.indexOf("if (PINNED_CLIS.includes(r.id)) continue;");
  assert.ok(skip > 0, "the pinned-CLI skip exists");
  assert.ok(skip < SRC.indexOf("MANTA_PROGRESS ${progressStep}"), "…and comes before the progress line / runUpgrade");
  assert.ok(skip < SRC.indexOf("await runUpgrade("));
});

test("importing the module does not run the upgrader", () => {
  // If main() ran on import this file would have spawned real upgrade commands (and written a state file).
  assert.match(SRC, /if \(process\.argv\[1\] && import\.meta\.url === new URL\(`file:\/\/\$\{process\.argv\[1\]\}`\)\.href\) main\(\);/);
});
