import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "../shared/paths.mjs";

// Sandboxed state dir (testSandbox.mjs). The config is seeded BEFORE local.mjs
// is imported, because it caches the first load.
const CONFIG = statePath("config.json");

test("an unmarked config on disk migrates to suggest ONCE, the result is persisted with its marker, and a later pick sticks", async () => {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ projects: [], handoffMode: "auto", groqApiKey: "k" }));
  const { configGet, configUpdate } = await import("./local.mjs");
  const cfg = await configGet();
  assert.equal(cfg.handoffMode, "suggest");
  assert.equal(cfg.groqApiKey, "k");
  const onDisk = JSON.parse(readFileSync(CONFIG, "utf8"));
  assert.equal(onDisk.handoffMode, "suggest");
  assert.equal(onDisk.handoffModeDefaultMigrated, true, "marker and value are written together");
  await configUpdate({ handoffMode: "auto" });
  assert.equal(JSON.parse(readFileSync(CONFIG, "utf8")).handoffMode, "auto");
  assert.equal(JSON.parse(readFileSync(CONFIG, "utf8")).handoffModeDefaultMigrated, true, "a deliberate auto carries the marker, so the next boot leaves it");
});
