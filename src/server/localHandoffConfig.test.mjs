import { test } from "node:test";
import assert from "node:assert/strict";
import { configGet, configUpdate } from "./local.mjs";

// Runs in the sandboxed state dir (testSandbox.mjs), never the production config.

test("handoffMode defaults to auto (the user's decision) and round-trips through the generic config channel", async () => {
  assert.equal((await configGet()).handoffMode, "auto");
  await configUpdate({ handoffMode: "suggest" });
  assert.equal((await configGet()).handoffMode, "suggest");
  await configUpdate({ handoffMode: "off" });
  assert.equal((await configGet()).handoffMode, "off");
  await configUpdate({ handoffMode: "auto" });
});
