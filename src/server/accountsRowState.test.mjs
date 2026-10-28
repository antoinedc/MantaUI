import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAccountState, accountRowControl, usagePace, subscriptionReading, buildAccountRowStates } from "./accountsRowState.mjs";

const row = (over) => ({ className: "Supported", connected: true, health: "unknown", reading: null, balance: null, ...over });

test("K2: precedence of the state text", () => {
  assert.deepEqual(describeAccountState(row({ health: "out-of-credit", reading: { label: "5h", pct: 10 } })), { text: "Out of credit", tone: "danger" });
  assert.deepEqual(describeAccountState(row({ health: "rate-limited", retryInMinutes: 7 })), { text: "Rate limited · retry in 7m", tone: "warn" });
  assert.deepEqual(describeAccountState(row({ health: "rate-limited" })), { text: "Rate limited", tone: "warn" });
  assert.deepEqual(describeAccountState(row({ health: "failing" })), { text: "Not responding", tone: "warn" });
  assert.deepEqual(describeAccountState(row({ managedExternally: true, managedBy: "the Claude CLI", reading: { label: "5h", pct: 50 } })), { text: "connected · signed in with the Claude CLI", tone: "ok" });
  assert.deepEqual(describeAccountState(row({ reading: { label: "5h", pct: 95, pace: "over pace" } })), { text: "5h 95% · over pace", tone: "danger" });
  assert.deepEqual(describeAccountState(row({ reading: { label: "5h", pct: 70, pace: null } })), { text: "5h 70%", tone: "warn" });
  assert.deepEqual(describeAccountState(row({ reading: { label: "5h", pct: 10, pace: null } })).tone, "ok");
  assert.deepEqual(describeAccountState(row({ balance: 4.5 })), { text: "$4.50 remaining", tone: "danger" });
  assert.deepEqual(describeAccountState(row({ balance: 12 })), { text: "$12.00 remaining", tone: "ok" });
  assert.deepEqual(describeAccountState(row({ connected: false })), { text: "Not connected", tone: "quiet" });
  assert.deepEqual(describeAccountState(row()), { text: "No usage data", tone: "quiet" });
});

test("K2: control precedence", () => {
  assert.equal(accountRowControl(row({ health: "out-of-credit" })), "retry");
  assert.equal(accountRowControl(row({ managedExternally: true })), "none");
  assert.equal(accountRowControl(row()), "disconnect");
  assert.equal(accountRowControl(row({ connected: false })), "connect");
  assert.equal(accountRowControl(row({ className: "Custom" })), "none");
  assert.equal(accountRowControl(row({ className: "Custom", health: "out-of-credit" })), "retry");
});

test("K2: pace needs timing and reading uses the first window", () => {
  assert.equal(usagePace({ pct: 50 }, 5), null);
  const w = { pct: 50, startedAt: 0, resetsAt: 100 };
  assert.equal(usagePace(w, 100 * 0.5), "on pace");
  assert.equal(usagePace({ ...w, pct: 20 }, 50), "under pace");
  assert.equal(usagePace({ ...w, pct: 90 }, 50), "over pace");
  assert.equal(subscriptionReading(undefined, 0), null);
  assert.equal(subscriptionReading({ windows: [] }, 0), null);
  assert.equal(subscriptionReading({ windows: [{ pct: "x" }] }, 0), null);
  assert.deepEqual(subscriptionReading({ windows: [{ label: "5h", pct: 30 }] }, 0), { label: "5h", pct: 30, pace: null });
});

test("K2: rows for subscriptions and custom endpoints, from the reads the desktop made", () => {
  const out = buildAccountRowStates({
    nowMs: 1_000_000,
    statuses: [
      { id: "anthropic", connected: true, managedExternally: false },
      { id: "openai", connected: false },
      { id: "kimi", connected: true },
    ],
    providers: [
      { id: "anthropic", hasApiKey: true, enabledModels: [] },
      { id: "acme", hasApiKey: true, enabledModels: ["m1"] },
      { id: "bare", hasApiKey: false, enabledModels: [] },
    ],
    snapshots: [
      { providerIDs: ["anthropic"], windows: [{ label: "5h", pct: 42 }] },
      { providerIDs: ["kimi"], exhausted: true },
    ],
    health: { providers: { openai: { state: "rate-limited", retryInMs: 61_000 } }, endpoints: { "acme/m1": { state: "dead" } } },
  });
  assert.deepEqual(out.rows.anthropic, { text: "5h 42%", tone: "ok", control: "disconnect", registerLine: null });
  assert.deepEqual(out.rows.openai, { text: "Rate limited · retry in 2m", tone: "warn", control: "connect", registerLine: null });
  assert.equal(out.rows.kimi.control, "retry", "an exhausted reader refuses work even before health sees a 402");
  assert.equal(out.rows.acme.registerLine, "Dead");
  assert.equal(out.rows.acme.text, "No usage data");
  assert.equal(out.rows.bare.text, "Not connected");
  assert.equal(out.rows.bare.registerLine, null);
  assert.equal(Object.keys(out.rows).includes("anthropic") && out.rows.anthropic.text, "5h 42%", "a custom entry sharing a subscription id is not duplicated");
});

test("K2: an enabled endpoint with an empty register reads Unproven; no data at all degrades, never throws", () => {
  const out = buildAccountRowStates({ nowMs: 0, providers: [{ id: "x", hasApiKey: true, enabledModels: ["a", "b"] }] });
  assert.equal(out.rows.x.registerLine, "Unproven");
  assert.deepEqual(buildAccountRowStates({ nowMs: 0 }), { rows: {} });
});
