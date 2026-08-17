// usageResume.test.mjs — the resume engine (BET-1048). Pure decision logic +
// injected I/O only — no live provider, no real timers, no filesystem.
//
// Covers the BET-1048 acceptance: gating on recovery (every window, not just
// the named one); stagger order + spacing; refusal re-queue up to an attempt
// cap then flagged; mid-turn deferral (routes through the shared delivery
// path); late resume after a simulated sleep; and a regression that the old
// fixed reset+60s fire instant is gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEEP_GOING_PROMPT,
  STAGGER_MS,
  MAX_RESUME_ATTEMPTS,
  windowsFromSnapshots,
  planResumeBatch,
  refusalAction,
  providerState,
  createUsageResumeEngine,
} from "./usageResume.mjs";

const T0 = 1_000_000;

// Flush the microtask + macrotask queues so fire-and-forget async callbacks
// (sendOne / handleRefusal) settle deterministically.
const flush = () => new Promise((r) => setTimeout(r, 0));

function snapshotsFor(windowsByProvider) {
  return Object.entries(windowsByProvider).map(([provider, windows]) => ({ provider, windows }));
}

function fakeTimers() {
  const pending = [];
  let id = 0;
  return {
    pending,
    setTimeoutFn: (fn, ms) => {
      const t = { id: ++id, fn, ms };
      pending.push(t);
      return { id: t.id, unref() {} };
    },
    clearTimeoutFn: (t) => {
      const i = pending.findIndex((p) => p.id === t?.id);
      if (i >= 0) pending.splice(i, 1);
    },
    fireAll() {
      const due = pending.splice(0);
      for (const t of due) t.fn();
    },
  };
}

// Build an engine wired to fakes. `records` is the live record; `windows` the
// current usage snapshots (adapter -> windows). Mirrors stoppedStore's pure
// load/save so attempts bumps propagate back into `records`.
function harness({ records = [], over = {} } = {}) {
  const timers = fakeTimers();
  const recordsLive = structuredClone(records);
  const called = { deliver: [], markRan: [], bumpAttempts: [], published: [], forceRecheck: 0 };
  const engine = createUsageResumeEngine({
    load: async () => ({ records: recordsLive, lastLooked: null }),
    markRan: async ({ conversation }) => {
      called.markRan.push(conversation);
      recordsLive.splice(recordsLive.findIndex((r) => r.conversation === conversation), 1);
    },
    bumpAttempts: async ({ conversation }) => {
      called.bumpAttempts.push(conversation);
      const r = recordsLive.find((x) => x.conversation === conversation);
      if (r) r.attempts = (r.attempts ?? 0) + 1;
    },
    deliver: async (args) => {
      called.deliver.push(args);
      return { delivered: true, queued: false };
    },
    providerIDForAdapter: (a) => ({ claude: "anthropic" })[a] ?? null,
    forceRecheck: async () => {
      called.forceRecheck += 1;
    },
    publish: (evt) => called.published.push(evt),
    now: () => T0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...over,
  });
  return { engine, timers, called, recordsLive };
}

function armed(conversation, stopper = {}) {
  return {
    conversation,
    workspace: "ws",
    provider: "claude",
    model: "claude-opus-4-7",
    window: "session",
    stoppedAt: 100,
    armed: true,
    attempts: 1,
    ...stopper,
  };
}

function win(kind, pct, resetsAt) {
  return { kind, label: kind, pct, ...(resetsAt != null ? { resetsAt } : {}) };
}

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

test("windowsFromSnapshots groups windows by adapter and drops empties", () => {
  assert.deepEqual(
    windowsFromSnapshots([
      { provider: "claude", windows: [win("session", 40), win("weekly", 10)] },
      { provider: "codex", windows: [] },
      { provider: "kimi", windows: [win("monthly", 99)] },
    ]),
    { claude: [win("session", 40), win("weekly", 10)], kimi: [win("monthly", 99)] },
  );
  assert.deepEqual(windowsFromSnapshots(null), {});
  // A provider whose only windows are null/empty is absent (never a reading).
  assert.equal(windowsFromSnapshots([{ provider: "claude", windows: [null] }]).claude, undefined);
});

test("gating: not sent while ANY window for the provider is at its limit", () => {
  const rec = [armed("a")];
  // Session under limit, weekly still exhausted → must NOT send. "Every window
  // checked, not just the named one": the record named the session window, but
  // the exhausted weekly window still blocks.
  const blocked = planResumeBatch(rec, { claude: [win("session", 40), win("weekly", 100)] }, { now: () => T0 });
  assert.equal(blocked.sends.length, 0);
  assert.equal(blocked.flagged.length, 0);

  // Same record, all windows under limit → send.
  const unblocked = planResumeBatch(rec, { claude: [win("session", 40), win("weekly", 10)] }, { now: () => T0 });
  assert.equal(unblocked.sends.length, 1);
  assert.equal(unblocked.sends[0].conversation, "a");
});

test("gating: no reading for the provider → wait (nothing sent, never resume on an absent reading)", () => {
  // An absent/empty reading (e.g. the pre-first-poll empty snapshot set at
  // boot) is categorically different from "recovered": we must not resume on
  // zero evidence that quota returned.
  const { sends } = planResumeBatch([armed("a")], {}, { now: () => T0 });
  assert.equal(sends.length, 0);
});

test("stagger: sends are ordered oldest-first and spaced a few seconds apart", () => {
  const rec = [
    armed("c", { stoppedAt: 300 }),
    armed("a", { stoppedAt: 100 }),
    armed("b", { stoppedAt: 200 }),
  ];
  const { sends } = planResumeBatch(rec, { claude: [win("session", 30)] }, { now: () => T0 });
  assert.deepEqual(
    sends.map((s) => s.conversation),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    sends.map((s) => s.at),
    [T0, T0 + STAGGER_MS, T0 + 2 * STAGGER_MS],
  );
  // Each send carries the model pinned in the record.
  for (const s of sends) assert.equal(s.model, "claude-opus-4-7");
});

test("flagged: an entry that exhausted its attempts is never sent again", () => {
  const rec = [armed("a", { attempts: MAX_RESUME_ATTEMPTS + 1 })];
  const { sends, flagged } = planResumeBatch(rec, { claude: [win("session", 30)] }, { now: () => T0 });
  assert.equal(sends.length, 0);
  assert.deepEqual(flagged.map((f) => f.conversation), ["a"]);
});

test("nextRecheckAt is the earliest future reset of still-limited providers (not reset+60s)", () => {
  const rec = [armed("a"), armed("b", { provider: "kimi" })];
  const windows = {
    claude: [win("session", 100, T0 + 60_000)],
    kimi: [win("monthly", 100, T0 + 500_000)],
  };
  const { sends, nextRecheckAt } = planResumeBatch(rec, windows, { now: () => T0 });
  assert.equal(sends.length, 0); // still limited → nothing sent
  // The engine re-checks AT the reset instant, not reset+60s — the offset the
  // old path fired on is gone.
  assert.equal(nextRecheckAt, T0 + 60_000);
});

test("providerState distinguishes wait / ready / flagged", () => {
  assert.equal(providerState(armed("a"), [{ pct: 30 }]), "ready");
  assert.equal(providerState(armed("a"), [{ pct: 100 }]), "wait");
  assert.equal(providerState(armed("a", { attempts: 99 }), [{ pct: 30 }], { maxAttempts: 3 }), "flagged");
});

test("refusalAction re-queues up to the cap, then flags", () => {
  assert.deepEqual(refusalAction(armed("a", { attempts: 1 })), { action: "requeue" });
  assert.deepEqual(refusalAction(armed("a", { attempts: 2 })), { action: "requeue" });
  assert.deepEqual(refusalAction(armed("a", { attempts: MAX_RESUME_ATTEMPTS })), {
    action: "flag",
    attempts: MAX_RESUME_ATTEMPTS + 1,
  });
});

// ---------------------------------------------------------------------------
// Engine (I/O seam)
// ---------------------------------------------------------------------------

test("engine: recovered batch is sent staggered, on the pinned model, literal 'Keep going'", async () => {
  const { engine, timers, called } = harness({
    records: [
      armed("a", { stoppedAt: 100 }),
      armed("b", { stoppedAt: 200 }),
      armed("c", { stoppedAt: 300 }),
    ],
    windows: { claude: [win("session", 20)] },
  });
  await engine.deliverSnapshots(snapshotsFor({ claude: [win("session", 20)] }));
  // Nothing sent yet — sends are staggered.
  assert.equal(called.deliver.length, 0);
  assert.deepEqual(
    timers.pending.map((t) => t.ms),
    [0, STAGGER_MS, 2 * STAGGER_MS],
  );
  timers.fireAll();
  await flush();
  assert.equal(called.deliver.length, 3);
  for (const d of called.deliver) {
    assert.equal(d.text, KEEP_GOING_PROMPT);
    assert.deepEqual(d.model, { providerID: "anthropic", modelID: "claude-opus-4-7" });
  }
});

test("engine: nothing sent while a window is at its limit, and a recheck is armed at the reset", async () => {
  const { engine, timers, called } = harness({
    records: [armed("a")],
    windows: { claude: [win("session", 100, T0 + 60_000)] },
  });
  await engine.deliverSnapshots(snapshotsFor({ claude: [win("session", 100, T0 + 60_000)] }));
  assert.equal(called.deliver.length, 0);
  // One recheck timer at the reset instant (60s away) — no second polling loop.
  assert.deepEqual(timers.pending.map((t) => t.ms), [60_000]);
  timers.fireAll();
  await flush();
  // The recheck fires the poller, which re-fetches and republishes — the
  // engine itself sends nothing (that happens on the next deliverSnapshots).
  assert.equal(called.forceRecheck, 1);
  assert.equal(called.deliver.length, 0);
});

test("engine: boot with an empty snapshot set sends nothing until a real reading exists", async () => {
  const { engine, timers, called } = harness({
    records: [armed("a")],
  });
  // The poller's first tick is still in flight at boot, so the snapshot set is
  // empty (listSnapshots() returns []). Resuming here would send "Keep going"
  // with zero evidence quota returned — the exact failure mode this issue
  // exists to eliminate. Must be wait, not ready.
  await engine.deliverSnapshots([]);
  assert.equal(called.deliver.length, 0);
  assert.deepEqual(timers.pending.map((t) => t.ms), []); // nothing armed either

  // The warmup's first real poll supplies a fresh reading showing recovery →
  // then (and only then) the continuation goes out.
  await engine.deliverSnapshots(snapshotsFor({ claude: [win("session", 20)] }));
  assert.equal(called.deliver.length, 0); // staggered, not yet fired
  timers.fireAll();
  await flush();
  assert.equal(called.deliver.length, 1);
  assert.equal(called.deliver[0].text, KEEP_GOING_PROMPT);
});

test("engine: refusal re-queues, retried on the next check, flagged after the cap", async () => {
  const err = {
    type: "session.error",
    properties: { sessionID: "a", error: { name: "Error", data: { message: "you've hit your weekly limit" } } },
  };
  const { engine, timers, called, recordsLive } = harness({
    records: [armed("a", { attempts: 1 })],
    windows: { claude: [win("session", 20)] },
  });

  // attempts=1: first resume → refused → re-queue (attempts=2), no flag.
  await engine.deliverSnapshots(snapshotsFor({ claude: [win("session", 20)] }));
  timers.fireAll();
  await flush();
  assert.equal(called.deliver.length, 1);
  engine.observeEvent(err);
  await flush();
  assert.equal(called.bumpAttempts.length, 1);
  assert.equal(recordsLive[0].attempts, 2);
  assert.equal(called.published.some((e) => e.kind === "usage-stopped.needs-attention"), false);
  assert.deepEqual(called.markRan, []); // refused → entry stays in the record

  // attempts=2: same refusal → re-queue (attempts=3).
  await engine.deliverSnapshots(snapshotsFor({ claude: [win("session", 20)] }));
  timers.fireAll();
  await flush();
  engine.observeEvent(err);
  await flush();
  assert.equal(recordsLive[0].attempts, 3);

  // attempts=3: third refusal pushes past the cap → bumped to 4 and flagged.
  await engine.deliverSnapshots(snapshotsFor({ claude: [win("session", 20)] }));
  timers.fireAll();
  await flush();
  engine.observeEvent(err);
  await flush();
  assert.equal(recordsLive[0].attempts, MAX_RESUME_ATTEMPTS + 1);
  assert.equal(called.published.some((e) => e.kind === "usage-stopped.needs-attention"), true);
  assert.deepEqual(called.markRan, []);

  // A further check never sends again: flagged.
  await engine.deliverSnapshots(snapshotsFor({ claude: [win("session", 20)] }));
  assert.equal(called.deliver.length, 3); // no new sends after flagging
});

test("engine: successful resume removes the entry on idle (mid-turn defers via delivery, not before)", async () => {
  const { engine, timers, called, recordsLive } = harness({
    records: [armed("a")],
    windows: { claude: [win("session", 20)] },
  });
  await engine.deliverSnapshots(snapshotsFor({ claude: [win("session", 20)] }));
  timers.fireAll();
  await flush();
  assert.equal(called.deliver.length, 1);
  // Conversation is mid-turn: nothing is marked ran or refused before idle.
  assert.deepEqual(called.markRan, []);
  assert.deepEqual(called.bumpAttempts, []);
  // It goes idle without a plan-limit refusal → resume succeeded → entry leaves
  // the record.
  engine.observeEvent({ type: "session.idle", properties: { sessionID: "a" } });
  await flush();
  assert.deepEqual(called.markRan, ["a"]);
  assert.equal(recordsLive.length, 0);
});

test("engine: late resume — recovers however late, with no expiry", async () => {
  // The reset instant passed hours ago while the box was asleep; on wake the
  // engine re-evaluates and sends despite the elapsed time. Deliberate: no
  // "late" expiry.
  const { engine, timers, called } = harness({
    records: [armed("a")],
    windows: { claude: [win("session", 0, T0 - 5 * 60 * 60_000)] }, // reset long past, usage recovered
  });
  await engine.deliverSnapshots(snapshotsFor({ claude: [win("session", 0, T0 - 5 * 60 * 60_000)] }));
  timers.fireAll();
  await flush();
  assert.equal(called.deliver.length, 1);
  assert.equal(called.deliver[0].text, KEEP_GOING_PROMPT);
});

test("regression: the engine never fires at a fixed reset+60s offset", async () => {
  // The old path armed a continuation to fire at reset + 60_000 regardless of
  // recovery. The new engine (a) re-checks AT the reset instant (nextRecheckAt
  // === resetsAt, not resetsAt + 60s) and (b) never schedules a send while the
  // meter is still limited even if the clock has passed reset+60s.
  const windows = { claude: [win("session", 100, T0)] }; // reset instant is NOW
  const { sends, nextRecheckAt } = planResumeBatch([armed("a")], windows, { now: () => T0 });
  assert.equal(nextRecheckAt, T0); // not T0 + 60_000
  assert.equal(sends.length, 0); // still at limit → nothing forced at +60s

  // And a reflect-style source check: the renderer's per-conversation
  // continuation scheduling (the confirm-dialog state + the "schedule a
  // 'Keep going' prompt job" callbacks that created the old scheduler job) is
  // gone — arming now lives in the box-side record and the engine resumes it.
  const fs = await import("node:fs");
  const appSrc = fs.readFileSync(new URL("../renderer/App.tsx", import.meta.url), "utf8");
  assert.ok(!appSrc.includes("confirmKeepGoing"), "renderer per-continuation scheduler job is gone");
  assert.ok(!appSrc.includes("setKeepGoing"), "renderer 'Keep going' confirm dialog + its state are gone");
});
