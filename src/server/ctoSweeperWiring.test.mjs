// BET-1469: fail fast, before ANY test body runs, when this file is executed
// outside the state sandbox. A CTO store module imported unsandboxed resolves
// its paths against the LIVE box state (~/.manta) and a test would write
// production data. `npm test` / `npm run test:server` set MANTA_STATE_HOME via
// scripts/testSandbox.mjs before any module is evaluated; a bare
// `node --test <file>` does not.
if (!process.env.MANTA_STATE_HOME) {
  throw new Error(
    "MANTA_STATE_HOME is not set — refusing to run CTO tests against the live box state. " +
      "Run via `npm test` or `npm run test:server` (both --import ./scripts/testSandbox.mjs), " +
      "or set MANTA_STATE_HOME to a throwaway directory first.",
  );
}

// ctoSweeperWiring.test.mjs — BET-1464 defect 1 wiring gate. index.mjs cannot
// be imported (it boots the server on import), so the sweeper's startup
// wiring is asserted by a source scan: the poller must be imported from
// ctoStores.mjs, started alongside the other CTO pollers (after the watchdog
// poller, in the CTO poller family block), and bound to a stop handle — the
// exact pattern every other CTO poller follows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, "index.mjs"), "utf8");

test("wiring: index.mjs starts the CTO store retention sweeper (BET-1464 defect 1)", () => {
  assert.ok(
    /import \{[^}]*startCtoStoreSweeper[^}]*\} from "\.\/ctoStores\.mjs"/.test(indexSource),
    "startCtoStoreSweeper must be imported from ./ctoStores.mjs",
  );
  assert.ok(
    /const stopCtoStoreSweeper = startCtoStoreSweeper\(\{/.test(indexSource),
    "the sweeper must be started and its stop handle bound, like every other CTO poller",
  );
  assert.ok(
    indexSource.includes("CTO_STORE_SWEEP_INTERVAL_MS"),
    "the sweep interval must come from the shared constant",
  );
  // Same poller family as the engine/digest/suggest/watchdog pollers: the
  // sweeper's start sits inside the CTO startup block, after the watchdog.
  const watchdogStart = indexSource.indexOf("startPoller(adaptiveCtoWatchdog.tick");
  const sweeperStart = indexSource.indexOf("startCtoStoreSweeper({");
  assert.ok(watchdogStart !== -1, "the watchdog poller block must exist (family anchor)");
  assert.ok(
    sweeperStart > watchdogStart,
    "the sweeper must start within the CTO poller family (after the watchdog poller)",
  );
});
