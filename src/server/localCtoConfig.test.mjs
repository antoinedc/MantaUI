import { test } from "node:test";
import assert from "node:assert/strict";
import { configUpdate, configGet } from "./local.mjs";

// The settings schema addresses the on-call CTO block through nested keys
// ("cto.enabled", "cto.model", …). configUpdate must write those to the nested
// `cto.*` path the server reads — not as a flat top-level key. Runs in the
// sandboxed state dir (testSandbox.mjs), never production config.

test("configUpdate writes dotted cto.* keys into the nested cto block", async () => {
  await configUpdate({ "cto.enabled": true, "cto.model": "gpt-4o-realtime-preview", "cto.trustedActions": ["a", "b"] });
  const cfg = await configGet();
  assert.equal(cfg.cto.enabled, true);
  assert.equal(cfg.cto.model, "gpt-4o-realtime-preview");
  assert.deepEqual(cfg.cto.trustedActions, ["a", "b"]);
  // No flat dotted key leaked to the top level.
  assert.equal(cfg["cto.enabled"], undefined);
});

test("configUpdate flat keys still merge at the top level", async () => {
  await configUpdate({ voiceNoteTtlHours: 5 });
  const cfg = await configGet();
  assert.equal(cfg.voiceNoteTtlHours, 5);
  assert.equal(typeof cfg.cto.enabled, "boolean");
});
