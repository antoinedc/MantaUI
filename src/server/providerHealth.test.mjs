import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderHealth, PROVIDER_HEALTH_STATE, MIN_FAILURES_TO_DEPRIORITIZE } from "./providerHealth.mjs";
import { MIN_RATE_LIMIT_BACKOFF_MS, MAX_RATE_LIMIT_BACKOFF_MS } from "./usage.mjs";

// Attribution helper shared by every test: a session "s1" (one per test) maps
// to adapter "claude" -> opencode providerID "anthropic" (a SUPPORTED
// provider, so retry's supported branch is exercised with the real
// adapterForProviderID from usage.mjs). A separate non-adapter providerID,
// "deepseek", is treated as CUSTOM by the real adapter lookup.
const PROVIDER = "anthropic";
const CUSTOM = "deepseek";

function make({ sess = "s1", adapter = "claude", providerID = PROVIDER } = {}) {
  const clock = { t: 1000 };
  const published = [];
  const sessionOf = new Map([[sess, adapter]]);
  let recheckResult = false;
  let recheckCalls = 0;

  const engine = createProviderHealth({
    now: () => clock.t,
    publish: (evt) => published.push(evt),
    getSessionModel: (sid) => {
      const a = sessionOf.get(sid);
      return a == null ? null : { adapterId: a, model: "m" };
    },
    providerIDForAdapter: (a) => ({ claude: "anthropic", codex: "openai", kimi: "kimi-for-coding" }[a] ?? null),
    recheckAtLimit: async () => {
      recheckCalls += 1;
      return recheckResult;
    },
  });

  return {
    clock,
    engine,
    published,
    providerID,
    setRecheck: (v) => {
      recheckResult = v;
    },
    recheckCalls: () => recheckCalls,
    error: (httpStatus, retryAfterMs, sid = sess) =>
      engine.observeEvent({
        type: "session.error",
        properties: {
          sessionID: sid,
          error: {
            ...(httpStatus != null ? { httpStatus } : {}),
            ...(retryAfterMs != null ? { retryAfterMs } : {}),
          },
        },
      }),
    step(sid = sess) {
      engine.observeEvent({
        type: "session.next.step.ended",
        properties: { sessionID: sid, providerID, modelID: "m" },
      });
    },
  };
}

test("402 -> out-of-credit; NO elapsed time re-admits it (anti-clock regression)", () => {
  const { engine, error, clock, providerID } = make();
  error(402);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
  // Hours later the flag is STILL set — the deleted clock-based resume must not
  // sneak back in.
  clock.t += 6 * 60 * 60 * 1000;
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
  clock.t += 30 * 24 * 60 * 60 * 1000;
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
});

test("a successful step for that provider clears out-of-credit", () => {
  const { engine, error, step, providerID } = make();
  error(402);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
  step();
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OK);
});

test("a successful step clears a failing streak", () => {
  const { engine, error, step, providerID } = make();
  error(); // generic failure 1
  error(); // generic failure 2 -> failing
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.FAILING);
  step();
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OK);
});

test("retry() on a CUSTOM provider clears the flag and performs NO fetch", async () => {
  // Seed an out-of-credit flag on the custom provider id, then retry it and
  // assert the meter (recheckAtLimit) is NEVER hit — a custom provider has no
  // meter to re-read, so the user is the evidence and no traffic is sent.
  const f = { calls: 0 };
  const eng = createProviderHealth({
    now: () => 0,
    publish: () => {},
    getSessionModel: () => null,
    providerIDForAdapter: () => null,
    recheckAtLimit: async () => {
      f.calls += 1;
      return true;
    },
  });
  const res = await eng.retry(CUSTOM);
  assert.equal(res.cleared, true, "custom retry clears optimistically");
  assert.equal(res.state, PROVIDER_HEALTH_STATE.OK);
  assert.equal(f.calls, 0, "custom retry must not hit the meter");
});

test("retry() on a SUPPORTED provider re-reads the meter and clears only when it reports funds", async () => {
  const { engine, error, setRecheck, recheckCalls, providerID } = make();
  error(402);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);

  // Meter still at limit -> not cleared, and the meter WAS re-read.
  setRecheck(true);
  let res = await engine.retry(providerID);
  assert.equal(res.cleared, false);
  assert.equal(res.state, PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
  assert.equal(recheckCalls(), 1);

  // Meter reports funds -> cleared.
  setRecheck(false);
  res = await engine.retry(providerID);
  assert.equal(res.cleared, true);
  assert.equal(res.state, PROVIDER_HEALTH_STATE.OK);
  assert.equal(recheckCalls(), 2);
});

test("429 with retryAfterMs: 0 is clamped to the 2-min floor (does not hot-loop)", () => {
  const { clock, engine, error, providerID } = make();
  error(429, 0);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.RATE_LIMITED);
  clock.t += MIN_RATE_LIMIT_BACKOFF_MS - 1;
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.RATE_LIMITED);
  clock.t += 1;
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OK);
});

test("429 asking for one hour is clamped to the 15-min ceiling", () => {
  const { clock, engine, error, providerID } = make();
  error(429, 60 * 60 * 1000);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.RATE_LIMITED);
  clock.t += MAX_RATE_LIMIT_BACKOFF_MS - 1;
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.RATE_LIMITED);
  clock.t += 1;
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OK);
});

test("429 expiry re-admits with no user action", () => {
  const { clock, engine, error, providerID } = make();
  error(429, 0);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.RATE_LIMITED);
  clock.t += MIN_RATE_LIMIT_BACKOFF_MS;
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OK);
});

test("repeated non-402/429 failures -> failing (soft); CLEARED on next success", () => {
  const { engine, error, step, providerID } = make();
  // A single generic failure must NOT deprioritise yet.
  error();
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OK);
  error();
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.FAILING);
  // A third failure keeps it failing (no flip-flop).
  error();
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.FAILING);
  step();
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OK);
});

test("out-of-credit outranks a concurrent rate-limit in state()", () => {
  const { clock, engine, error, providerID } = make();
  error(402);
  error(429, 0); // both flags set
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
  // The 429 cooldown alone expiring must not clear out-of-credit.
  clock.t += MAX_RATE_LIMIT_BACKOFF_MS + 1;
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
});

test("a supported provider's reader reporting funds on a normal poll clears out-of-credit", () => {
  const { engine, error, providerID } = make();
  error(402);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
  // A normal poll snapshot for the adapter NOT marked exhausted = funds.
  engine.deliverSnapshots([{ provider: "claude", exhausted: false, windows: [] }]);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OK);
});

test("a poll snapshot still marked exhausted does NOT clear out-of-credit", () => {
  const { engine, error, providerID } = make();
  error(402);
  engine.deliverSnapshots([{ provider: "claude", exhausted: true }]);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
  // And no snapshot / a non-matching provider is no evidence either.
  engine.deliverSnapshots([]);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
});

test("deliverSnapshots is inert for a provider that is not out-of-credit", () => {
  const { engine, providerID } = make();
  engine.deliverSnapshots([{ provider: "claude", exhausted: false }]);
  assert.equal(engine.state(providerID), PROVIDER_HEALTH_STATE.OK);
});

test("needs-attention publishes ONCE at the transition, not per observation", () => {
  const { engine, error, published } = make();
  error(429, 0);
  error(429, 0);
  error(429, 0);
  const attention = published.filter((e) => e.kind === "provider-health.needs-attention");
  assert.equal(attention.length, 1);
  assert.equal(attention[0].payload.providerID, PROVIDER);
  assert.equal(attention[0].payload.state, PROVIDER_HEALTH_STATE.RATE_LIMITED);
});

test("needs-attention publishes once for failing, once after recovery relapse", () => {
  const { engine, error, step, published } = make();
  error();
  error();
  error();
  let attention = published.filter((e) => e.kind === "provider-health.needs-attention");
  assert.equal(attention.length, 1);
  assert.equal(attention[0].payload.state, PROVIDER_HEALTH_STATE.FAILING);
  step();
  error();
  error();
  attention = published.filter((e) => e.kind === "provider-health.needs-attention");
  assert.equal(attention.length, 2, "a relapse after recovery is a NEW transition");
});

test("all() enumerates every attributed provider's current state", () => {
  const { engine, error, providerID } = make();
  assert.deepEqual(engine.all(), {});
  error(402);
  assert.deepEqual(engine.all(), { [providerID]: PROVIDER_HEALTH_STATE.OUT_OF_CREDIT });
});

test("unattributable failures (no session / unknown provider) are ignored", () => {
  const { engine, published } = make({ sess: "s-unknown", adapter: "nope" });
  engine.observeEvent({ type: "session.error", properties: { sessionID: "s-unknown", error: { httpStatus: 402 } } });
  assert.deepEqual(engine.all(), {});
  assert.equal(published.filter((e) => e.kind === "provider-health.needs-attention").length, 0);
});
