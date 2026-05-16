import { test } from "node:test";
import assert from "node:assert/strict";
import { createBus } from "./events.mjs";

test("bus delivers published events to subscribers and stops after unsubscribe", () => {
  const bus = createBus();
  const got = [];
  const off = bus.subscribe((e) => got.push(e));
  bus.publish({ kind: "opencode", payload: { type: "x" } });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "opencode");
  off();
  bus.publish({ kind: "opencode", payload: { type: "y" } });
  assert.equal(got.length, 1);
});
