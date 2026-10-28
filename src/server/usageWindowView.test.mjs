import { test } from "node:test";
import assert from "node:assert/strict";
import { windowTone, decorateSnapshot } from "./usageWindowView.mjs";

test("tone boundaries 69 / 70 / 89 / 90 / 99 / 100", () => {
  assert.deepEqual([0, 69, 70, 89, 90, 99, 100, 140].map(windowTone), ["under", "under", "warn", "warn", "danger", "danger", "over", "over"]);
});

test("decorateSnapshot adds tone to every window without mutating the input", () => {
  const input = { provider: "claude", windows: [{ kind: "session", pct: 10 }, { kind: "weekly", pct: 95, stale: true }] };
  const out = decorateSnapshot(input);
  assert.deepEqual(out.windows.map((w) => w.tone), ["under", "danger"]);
  assert.equal(out.windows[1].stale, true, "other fields survive; a stale window keeps its pct tone");
  assert.equal(input.windows[0].tone, undefined);
  assert.equal(out.provider, "claude");
});

test("a snapshot with no windows array is tolerated", () => {
  assert.deepEqual(decorateSnapshot({ provider: "x" }).windows, []);
});

test("decorating an already-decorated snapshot returns the same object (carry-forward keeps its reference)", () => {
  const once = decorateSnapshot({ provider: "claude", windows: [{ kind: "session", pct: 10 }] });
  assert.equal(decorateSnapshot(once), once);
});
