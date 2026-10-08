import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccountsEvents } from "./accountsEvents.mjs";

function rig() {
  let t = 10_000;
  const published = [];
  const timers = [];
  const events = createAccountsEvents({
    publish: (e) => published.push(e),
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { fn, ms, fired: false };
      timers.push(h);
      return h;
    },
  });
  return {
    events,
    published,
    timers,
    advance: (ms) => (t += ms),
    fire: () => {
      for (const h of timers) if (!h.fired) {
        h.fired = true;
        h.fn();
      }
    },
  };
}

test("accounts.updated: the first change goes out at once, with the provider", () => {
  const r = rig();
  r.events.updated("claude");
  assert.deepEqual(r.published, [{ kind: "accounts.updated", payload: { provider: "claude" } }]);
});

test("accounts.updated: a burst inside a second collapses to ONE trailing announcement (never dropped, never flooded)", () => {
  const r = rig();
  r.events.updated("claude");
  r.advance(100);
  r.events.updated("claude");
  r.events.updated("claude");
  r.advance(100);
  r.events.updated("claude");
  assert.equal(r.published.length, 1);
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, 900, "scheduled for the end of the window, measured from the first change");
  r.advance(800);
  r.fire();
  assert.equal(r.published.length, 2);
});

test("accounts.updated: a change after the window announces immediately again", () => {
  const r = rig();
  r.events.updated("claude");
  r.advance(1000);
  r.events.updated("claude");
  assert.equal(r.published.length, 2);
  assert.equal(r.timers.length, 0);
});

test("accounts.updated: throttled PER provider — claude does not delay codex", () => {
  const r = rig();
  r.events.updated("claude");
  r.events.updated("codex");
  assert.deepEqual(r.published.map((e) => e.payload.provider), ["claude", "codex"]);
});

test("accounts.updated: ignores a missing provider; a throwing publisher never breaks the caller", () => {
  const r = rig();
  r.events.updated(undefined);
  r.events.updated("");
  assert.equal(r.published.length, 0);
  const broken = createAccountsEvents({ publish: () => { throw new Error("subscriber blew up"); } });
  broken.updated("claude");
  broken.moved({ sessionId: "s", provider: "claude", from: "a", to: "b", reason: "exhausted" });
});

test("accounts.moved: immediate, never throttled, exactly the contract's fields", () => {
  const r = rig();
  const evt = { sessionId: "ses_1", provider: "claude", from: "seat-1", to: "seat-2", reason: "exhausted", extra: "dropped" };
  r.events.moved(evt);
  r.events.moved({ ...evt, sessionId: "ses_2" });
  assert.equal(r.published.length, 2);
  assert.deepEqual(r.published[0], {
    kind: "accounts.moved",
    payload: { sessionId: "ses_1", provider: "claude", from: "seat-1", to: "seat-2", fromLabel: "seat-1", toLabel: "seat-2", reason: "exhausted", trigger: null, crossOrg: false },
  });
  r.events.moved({
    sessionId: "ses_3", provider: "claude", from: "seat-1", to: "seat-2", fromLabel: "Seat 1", toLabel: "Work · Seat 2",
    reason: "load", trigger: { kind: "session", pct: 91 }, crossOrg: true,
  });
  assert.deepEqual(r.published[2].payload, {
    sessionId: "ses_3", provider: "claude", from: "seat-1", to: "seat-2", fromLabel: "Seat 1", toLabel: "Work · Seat 2",
    reason: "load", trigger: { kind: "session", pct: 91 }, crossOrg: true,
  });
});
