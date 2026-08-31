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
