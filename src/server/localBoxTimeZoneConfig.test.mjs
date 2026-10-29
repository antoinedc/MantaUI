import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { configGet, configUpdate } from "./local.mjs";

// Runs in the sandboxed state dir (testSandbox.mjs), never the production config.

test("boxTimeZone reads null when never set, round-trips through the config channel, and leaves other keys alone", async () => {
  const before = await configGet();
  assert.equal(before.boxTimeZone, null, "a config without the key reads null");
  const { chatAutoAllow, handoffMode, uploadCleanupHours } = before;
  await configUpdate({ boxTimeZone: "Europe/Paris" });
  const after = await configGet();
  assert.equal(after.boxTimeZone, "Europe/Paris");
  assert.deepEqual({ chatAutoAllow: after.chatAutoAllow, handoffMode: after.handoffMode, uploadCleanupHours: after.uploadCleanupHours }, { chatAutoAllow, handoffMode, uploadCleanupHours });

  // "reload": a fresh process reads the persisted file, not this process's cache.
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", 'import { configGet } from "./src/server/local.mjs"; console.log(JSON.stringify((await configGet()).boxTimeZone));'],
    { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" },
  );
  assert.equal(JSON.parse(out.trim()), "Europe/Paris");
});
