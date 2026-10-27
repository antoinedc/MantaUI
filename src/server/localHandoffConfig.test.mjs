import { test } from "node:test";
import assert from "node:assert/strict";
import { configGet, configUpdate } from "./local.mjs";

// Runs in the sandboxed state dir (testSandbox.mjs), never the production config.

test("handoffMode (the box default) is suggest and round-trips through the generic config channel", async () => {
  assert.equal((await configGet()).handoffMode, "suggest");
  assert.equal((await configGet()).handoffModeDefaultMigrated, true, "a fresh config counts as migrated, so a deliberate pick is never reset");
  await configUpdate({ handoffMode: "auto" });
  assert.equal((await configGet()).handoffMode, "auto");
  await configUpdate({ handoffMode: "off" });
  assert.equal((await configGet()).handoffMode, "off");
  await configUpdate({ handoffMode: "suggest" });
});
