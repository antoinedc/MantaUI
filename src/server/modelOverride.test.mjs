// modelOverride.test.mjs — tests for the per-model display override feature
// (Settings → Models → edit). Kept in its own file (rather than inside the
// large opencode.test.mjs) because the duplication gate scans any CHANGED
// file against itself, and opencode.test.mjs carries pre-existing
// `subscribeEvents` teardown clones that would fail the gate the moment the
// file is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyModelOverride, listModels, _setOcTransport } from "./opencode.mjs";

function withMockFetch(handler, fn) {
  _setOcTransport(handler);
  return fn().finally(() => _setOcTransport(null));
}

test("applyModelOverride trims + merges changed fields, preserves untouched", () => {
  const base = {
    id: "claude-opus-4-7",
    providerID: "anthropic",
    name: "Claude Opus 4.7",
    limit: { context: 1_000_000, output: 128_000 },
    variants: [{ id: "high" }],
  };
  const merged = applyModelOverride(base, {
    name: "  My Opus  ",
    description: "  Custom  ",
    context: 200_000,
  });
  assert.notEqual(merged, base);
  assert.equal(base.name, "Claude Opus 4.7");
  assert.equal(merged.name, "My Opus");
  assert.equal(merged.description, "Custom");
  assert.equal(merged.limit.context, 200_000);
  assert.equal(merged.limit.output, 128_000); // other limit keys survive
  assert.equal(merged.variants, base.variants); // non-limit refs untouched
});

test("applyModelOverride skips empty/invalid fields and no override", () => {
  const base = { id: "gpt-5", providerID: "openai", name: "GPT-5" };
  const partial = applyModelOverride(base, { name: "   ", description: "", context: 0 });
  assert.equal(partial.name, "GPT-5");
  assert.equal(partial.description, undefined);
  assert.equal(partial.limit, undefined);
  assert.equal(applyModelOverride(base, undefined), base);
  assert.equal(applyModelOverride(base, null), base);
});

test("listModels applies overrides keyed by providerID/modelID", async () => {
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          connected: ["anthropic"],
          all: [
            {
              id: "anthropic",
              models: {
                "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const out = await listModels({
        "anthropic/claude-sonnet-4-6": { name: "My Sonnet", description: "Custom", context: 1_000_000 },
      });
      assert.equal(out.length, 1);
      assert.equal(out[0].name, "My Sonnet");
      assert.equal(out[0].description, "Custom");
      assert.equal(out[0].limit.context, 1_000_000);
    },
  );
});
