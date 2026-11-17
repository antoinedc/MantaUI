import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, createSecretScanner } from "./secretScan.mjs";

// A fake secretlint: flags `AKIA…` style tokens.
const fakeLint = async () => ({
  preset: { meta: { id: "fake-preset" } },
  lintSource: async ({ source }) => {
    const messages = [];
    for (const m of source.content.matchAll(/AKIA[A-Z0-9]{16}/g)) messages.push({ type: "message", ruleId: "aws", range: [m.index, m.index + m[0].length] });
    return { messages };
  },
});

test("flags library hits and exact matches against the secrets store", async () => {
  const s = createSecretScanner({ loadLint: fakeLint, secretValues: () => ["correct-horse-battery"] });
  const r = await s.scan("key AKIAABCDEFGHIJKLMNOP and pw correct-horse-battery done");
  assert.equal(r.clean, false);
  assert.deepEqual(r.hits.map((h) => h.source).sort(), ["secretlint", "store"]);
  assert.equal((await s.scan("nothing here")).clean, true);
});

test("redact replaces every hit, merging overlaps", async () => {
  const s = createSecretScanner({ loadLint: fakeLint, secretValues: () => ["hunter2hunter2"] });
  const r = await s.redact("a AKIAABCDEFGHIJKLMNOP b hunter2hunter2 c hunter2hunter2");
  assert.equal(r.text, `a ${REDACTED} b ${REDACTED} c ${REDACTED}`);
  assert.equal(r.redacted, 3);
});

test("fails closed when the library cannot load: not clean, unavailable", async () => {
  const s = createSecretScanner({
    loadLint: async () => {
      throw new Error("missing");
    },
    secretValues: () => [],
  });
  const r = await s.scan("hello");
  assert.equal(r.clean, false);
  assert.equal(r.unavailable, true);
  assert.equal((await s.redact("hello")).unavailable, true);
});

test("the real secretlint recommended preset flags a GitHub token (skipped when the package isn't installed)", async (t) => {
  let ok = true;
  try {
    await import("@secretlint/core");
  } catch {
    ok = false;
  }
  if (!ok) return t.skip("@secretlint/core is not installed in this checkout");
  const s = createSecretScanner({ secretValues: () => [] });
  const token = `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2).slice(0, 36)}`;
  const hit = await s.scan(`export TOKEN=${token}`);
  assert.equal(hit.unavailable, false);
  assert.equal(hit.clean, false);
  assert.ok(hit.hits.some((h) => h.source === "secretlint"));
  const red = await s.redact(`export TOKEN=${token}\n`);
  assert.ok(!red.text.includes("ghp_"));
  assert.equal((await s.scan("Run npm test and read the README.")).clean, true);
});
