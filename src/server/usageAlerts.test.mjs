import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { level, levels, transitions, alertText, providerLabel, createUsageAlerts } from "./usageAlerts.mjs";

const T0 = 1_761_650_000_000;
const win = (over = {}) => ({ kind: "weekly", label: "Weekly", pct: 50, resetsAt: T0 + 3_600_000, ...over });
const snap = (windows, provider = "claude") => ({ provider, providerIDs: ["anthropic"], windows });

function harness({ start = T0 } = {}) {
  const clock = { t: start };
  const frames = [];
  const timers = { pending: null, setTimeout: (fn, ms) => ((timers.pending = { fn, ms }), timers.pending), clearTimeout: () => { timers.pending = null; } };
  const alerts = createUsageAlerts({ now: () => clock.t, publish: (e) => frames.push(e), bootId: "boot-1", timers });
  return { alerts, frames, clock, timers };
}

describe("level boundaries (moved usageEscalation cases)", () => {
  test("89.9 / 90 / 99.9 / 100", () => {
    assert.deepEqual([89.9, 90, 99.9, 100, 150].map(level), ["none", "warn", "warn", "limit", "limit"]);
  });
  test("levels() reads stale windows verbatim", () => {
    assert.deepEqual(levels([snap([win({ pct: 100, stale: true }), win({ kind: "session", pct: 10 })])]), { "claude:weekly": "limit", "claude:session": "none" });
  });
});

describe("transitions", () => {
  const fire = (prev, windows) => transitions(prev, [snap(windows)], T0).map((a) => [a.key, a.level]);
  test("none→warn, none→limit once, warn→limit; holding does not re-fire", () => {
    assert.deepEqual(fire({}, [win({ pct: 91 })]), [["claude:weekly", "warn"]]);
    assert.deepEqual(fire({}, [win({ pct: 100 })]), [["claude:weekly", "limit"]]);
    assert.deepEqual(fire({ "claude:weekly": "warn" }, [win({ pct: 100 })]), [["claude:weekly", "limit"]]);
    assert.deepEqual(fire({ "claude:weekly": "warn" }, [win({ pct: 95 })]), []);
    assert.deepEqual(fire({ "claude:weekly": "limit" }, [win({ pct: 100 })]), []);
  });
  test("a stale window never fires", () => {
    assert.deepEqual(fire({}, [win({ pct: 100, stale: true })]), []);
  });
  test("a drop is not a fire (re-arming is the baseline replacement)", () => {
    assert.deepEqual(fire({ "claude:weekly": "limit" }, [win({ pct: 10 })]), []);
  });
});

describe("alert shape + text", () => {
  test("warn / limit text, provider labels", () => {
    assert.equal(alertText({ provider: "claude", window: { label: "Session (5h)", pct: 92.6 }, level: "warn" }), "Claude Session (5h) 93% used");
    assert.equal(alertText({ provider: "claude", window: { label: "Weekly", pct: 100 }, level: "limit" }), "Weekly limit reached on Claude");
    assert.deepEqual(["claude", "codex", "kimi", "newone"].map(providerLabel), ["Claude", "OpenAI", "Kimi", "Newone"]);
  });
  test("ids are stable: key:level:resetsAt; limit expires at reset, warn after 15 min; sticky only for limit", () => {
    const [w] = transitions({}, [snap([win({ pct: 93 })])], T0);
    const [l] = transitions({}, [snap([win({ pct: 100 })])], T0);
    assert.equal(l.id, `claude:weekly:limit:${T0 + 3_600_000}`);
    assert.deepEqual([w.sticky, w.expiresAt, l.sticky, l.expiresAt], [false, T0 + 15 * 60_000, true, T0 + 3_600_000]);
    const [noReset] = transitions({}, [snap([win({ pct: 100, resetsAt: undefined })])], T0);
    assert.deepEqual([noReset.resetsAt, noReset.expiresAt, noReset.id], [null, null, "claude:weekly:limit:none"]);
  });
});

describe("createUsageAlerts", () => {
  test("the first observation seeds silently (cold start at 100% never alerts; stale then fresh 100% neither)", () => {
    const { alerts, frames } = harness();
    alerts.observe([snap([win({ pct: 100, stale: true })])]);
    assert.equal(frames.length, 0);
    assert.deepEqual(alerts.list().alerts, []);
    alerts.observe([snap([win({ pct: 100 })])]);
    assert.equal(frames.length, 0, "holding a seeded level never fires");
  });

  test("an upward crossing raises one frame with bootId + revision; list() reports it with live actions", () => {
    const { alerts, frames } = harness();
    alerts.observe([snap([win({ pct: 10 })])]);
    alerts.observe([snap([win({ pct: 93 })])]);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].kind, "usage.alert");
    assert.equal(frames[0].payload.bootId, "boot-1");
    assert.equal(frames[0].payload.revision, 1);
    assert.equal(frames[0].payload.alert.level, "warn");
    assert.equal(frames[0].payload.alert.canRemind, true);
    const list = alerts.list();
    assert.deepEqual([list.supported, list.bootId, list.revision, list.alerts.length], [true, "boot-1", 1, 1]);
    assert.equal(list.alerts[0].text, "Claude Weekly 93% used");
  });

  test("fires once while holding; re-arms after a drop; warn→limit raises the limit once", () => {
    const { alerts, frames } = harness();
    alerts.observe([snap([win({ pct: 10 })])]);
    alerts.observe([snap([win({ pct: 91 })])]);
    alerts.observe([snap([win({ pct: 95 })])]);
    assert.equal(frames.length, 1);
    alerts.observe([snap([win({ pct: 100 })])]);
    assert.deepEqual(frames.map((f) => f.payload.alert?.level ?? "retired"), ["warn", "limit"]);
    alerts.observe([snap([win({ pct: 100 })])]);
    assert.equal(frames.length, 2);
    // drop (window reset) retires both, then a new crossing in a new window raises again
    alerts.observe([snap([win({ pct: 5, resetsAt: T0 + 9_999_999_999 })])]);
    assert.equal(frames.filter((f) => f.payload.retired).length, 2);
    alerts.observe([snap([win({ pct: 92, resetsAt: T0 + 9_999_999_999 })])]);
    assert.equal(frames.at(-1).payload.alert.level, "warn");
  });

  test("retirement on level drop: the limit alert goes, a warn alert for the same key stays until it drops below 90", () => {
    const { alerts, frames } = harness();
    alerts.observe([snap([win({ pct: 10 })])]);
    alerts.observe([snap([win({ pct: 91 })])]);
    alerts.observe([snap([win({ pct: 100 })])]);
    alerts.observe([snap([win({ pct: 95 })])]);
    assert.deepEqual(frames.at(-1).payload.retired, [`claude:weekly:limit:${T0 + 3_600_000}`]);
    assert.equal(alerts.list().alerts.length, 1);
  });

  test("retirement on expiresAt (warn after 15 min, limit at the reset instant) via the timer and via list()", () => {
    const { alerts, frames, clock, timers } = harness();
    alerts.observe([snap([win({ pct: 10 })])]);
    alerts.observe([snap([win({ pct: 100 })])]);
    assert.ok(timers.pending, "an expiry timer is armed");
    clock.t = T0 + 3_600_000 + 1;
    timers.pending.fn(); // the timer fires
    assert.deepEqual(frames.at(-1).payload.retired.length, 1);
    assert.deepEqual(alerts.list().alerts, []);
    assert.equal(timers.pending, null, "no more expiries → timer cleared");

    // lazily retired by list() too
    const h = harness();
    h.alerts.observe([snap([win({ pct: 10 })])]);
    h.alerts.observe([snap([win({ pct: 91 })])]);
    h.clock.t = T0 + 15 * 60_000 + 1;
    assert.deepEqual(h.alerts.list().alerts, []);
    assert.equal(h.frames.at(-1).payload.retired.length, 1);
  });

  test("revision increases by exactly one per raise and per retirement; each change publishes exactly one frame carrying it", () => {
    const { alerts, frames } = harness();
    alerts.observe([snap([win({ pct: 10 }), win({ kind: "session", label: "5h", pct: 10 })])]);
    alerts.observe([snap([win({ pct: 91 }), win({ kind: "session", label: "5h", pct: 100 })])]); // two raises in one observation
    alerts.observe([snap([win({ pct: 10 }), win({ kind: "session", label: "5h", pct: 10 })])]); // two retirements
    assert.deepEqual(frames.map((f) => f.payload.revision), [1, 2, 3, 4]);
    assert.equal(alerts.list().revision, 4);
  });

  test("bootId is constant per instance and differs across instances", () => {
    const a = createUsageAlerts({ publish() {} });
    const b = createUsageAlerts({ publish() {} });
    assert.equal(a.list().bootId, a.list().bootId);
    assert.notEqual(a.list().bootId, b.list().bootId);
  });

  test("an alert without a reset time cannot be reminded / kept-going", () => {
    const { alerts, frames } = harness();
    alerts.observe([snap([win({ pct: 10, resetsAt: undefined })])]);
    alerts.observe([snap([win({ pct: 100, resetsAt: undefined })])]);
    assert.deepEqual([frames[0].payload.alert.canRemind, frames[0].payload.alert.canKeepGoing, frames[0].payload.alert.expiresAt], [false, false, null]);
  });

  test("no fireNotify / push dependency: the factory takes only now/publish/bootId/timers", () => {
    assert.equal(createUsageAlerts.length, 0);
    const a = createUsageAlerts({ publish() {} });
    assert.deepEqual(Object.keys(a).sort(), ["list", "observe", "remind", "stop", "sweep"]);
  });
});

describe("remind", () => {
  const setup = () => {
    const h = harness();
    h.alerts.observe([snap([win({ pct: 10 })])]);
    h.alerts.observe([snap([win({ pct: 100 })])]);
    const jobs = [];
    const createJob = async (i) => (jobs.push(i), { ok: true, job: { id: "j1", ...i } });
    return { ...h, jobs, createJob };
  };

  test("creates a one-shot notify job at resetsAt + 60 000 from the CURRENT snapshot", async () => {
    const { alerts, jobs, createJob } = setup();
    const r = await alerts.remind({ key: "claude:weekly", sessionID: "ses_1" }, { createJob });
    assert.equal(r.ok, true);
    assert.equal(r.fireAt, T0 + 3_600_000 + 60_000);
    assert.deepEqual(jobs[0], {
      fireAt: T0 + 3_600_000 + 60_000,
      kind: "notify",
      recurring: false,
      sessionID: "ses_1",
      prompt: "Claude Weekly has reset — you can keep working.",
      label: "Reminder: Claude Weekly reset",
    });
  });

  test("refuses expired / no-reset / no-session and never calls createJob", async () => {
    const h = setup();
    h.clock.t = T0 + 3_600_001;
    const expired = await h.alerts.remind({ key: "claude:weekly", sessionID: "s" }, { createJob: h.createJob });
    assert.deepEqual([expired.ok, expired.code, expired.message], [false, "expired", "This window has already reset — you can keep working."]);

    const none = harness();
    none.alerts.observe([snap([win({ resetsAt: undefined })])]);
    const noReset = await none.alerts.remind({ key: "claude:weekly", sessionID: "s" }, { createJob: none.createJob ?? (async () => ({ ok: true })) });
    assert.deepEqual([noReset.ok, noReset.code, noReset.message], [false, "no-reset", "This window has no reset time."]);
    const unknownKey = await none.alerts.remind({ key: "x:y", sessionID: "s" }, { createJob: async () => ({ ok: true }) });
    assert.equal(unknownKey.code, "no-reset");

    const h2 = setup();
    const noSession = await h2.alerts.remind({ key: "claude:weekly" }, { createJob: h2.createJob });
    assert.deepEqual([noSession.ok, noSession.code, noSession.message], [false, "no-session", "Open a chat to set a reminder."]);
    assert.equal(h.jobs.length + h2.jobs.length, 0);
  });

  test("a scheduler failure is reported, not swallowed", async () => {
    const { alerts } = setup();
    const r = await alerts.remind({ key: "claude:weekly", sessionID: "s" }, { createJob: async () => ({ ok: false, error: "bad cron" }) });
    assert.deepEqual([r.ok, r.code, r.message], [false, "schedule-failed", "Couldn't set a reminder: bad cron"]);
  });
});
