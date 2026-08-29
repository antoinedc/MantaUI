// BET-1419 overnight wiring tests (§11): window open → plan dispatch through
// the delegate seams; §11.6 preemption on the user's return; the §9.2 veto
// card lifecycle; the tonight queue verbs. The overnight machine itself is
// tested in ctoOvernight.test.mjs — these tests assert the WIRING.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCtoEngine } from "./ctoEngine.mjs";
import { createOvernightScheduler } from "./ctoOvernight.mjs";

const HOUR = 3_600_000;

// Minimal harness: fake clock, in-memory stores, injected delegate seams +
// overnight scheduler. Presence is "gone" (stale desktop beat), profile seam
// returns a caller-controlled trough, and the queue pre-seeds engine-state.
function makeHarness({ trough = null, queue = [], projects = [], tier = "high", overnightEnabled = true } = {}) {
  const clock = { ms: 1_700_000_000_000 };
  const now = () => clock.ms;
  const ledgerRows = [];
  const engineStateObj = { v: 1, pendingBlockers: [], tonightQueue: JSON.parse(JSON.stringify(queue)) };
  const overnightStoreObj = { v: 1, window: null };
  const published = [];
  const startedJobs = [];
  const pausedJobs = [];
  const listedJobs = [];
  const vetoCards = [];
  const config = { ctoEnabled: true, ctoTier: tier, ctoOvernightEnabled: overnightEnabled };

  const overnight = createOvernightScheduler({
    store: {
      load: async () => ({ ...overnightStoreObj }),
      save: async (payload) => {
        overnightStoreObj.window = payload.window ?? null;
        overnightStoreObj.counters = payload.counters;
      },
    },
    now,
    budget: async () => null,
    ledger: { append: async (row) => ledgerRows.push(row) },
  });

  const engine = createCtoEngine({
    configGet: async () => ({ ...config }),
    tierGet: async () => config.ctoTier,
    now,
    ledger: {
      append: async (row) => ledgerRows.push(row),
      read: async () => [...ledgerRows],
    },
    engineState: {
      load: async () => JSON.parse(JSON.stringify(engineStateObj)),
      save: async (payload) => {
        if (Array.isArray(payload?.tonightQueue)) engineStateObj.tonightQueue = payload.tonightQueue;
        if (payload?.pendingBlockers) engineStateObj.pendingBlockers = payload.pendingBlockers;
        if (payload?.rollupCursor) engineStateObj.rollupCursor = payload.rollupCursor;
        if (payload?.backfillProgress) engineStateObj.backfillProgress = payload.backfillProgress;
        if (payload?.backfillStartInstant !== undefined) engineStateObj.backfillStartInstant = payload.backfillStartInstant;
      },
    },
    killSwitch: {
      isPaused: async () => false,
      pause: async () => {},
      resume: async () => {},
    },
    publish: (evt) => published.push(evt),
    getCounts: async () => ({ needsYouCount: 0, generationInFlight: false, tonightCount: 0 }),
    budget: { isCapHit: async () => false, record: async () => ({ usd: 0, dayKey: "0" }) },
    cards: {
      onAskStart: async () => {},
      onAskResolved: async () => ({ changed: false }),
      onHealthRecovered: async () => {},
      promoteDue: async () => ({}),
      ingestHealthEscalations: async () => ({}),
      listOpen: async () => [...vetoCards],
      resolveById: async (id) => {
        const i = vetoCards.findIndex((c) => c.id === id);
        if (i >= 0) vetoCards.splice(i, 1);
        return { changed: i >= 0 };
      },
      dismissById: async () => ({ changed: false }),
      upsertDecision: async () => ({ changed: true }),
      upsertVeto: async (card) => {
        const row = { variant: "veto", ...card };
        const i = vetoCards.findIndex((c) => c.id === card.id);
        if (i >= 0) vetoCards[i] = { ...vetoCards[i], ...row };
        else vetoCards.push(row);
        return { changed: true };
      },
    },
    // §5.4: stale desktop beat (> 90s TTL) → presence "gone"; hasDesktop true.
    getDesktopPresence: () => ({ lastSeen: clock.ms - 10 * 60_000 }),
    getLastDesktopHeartbeat: () => clock.ms - 10 * 60_000,
    // BET-1419: the trough seam the tests control.
    profile: { getQuietTrough: () => trough },
    overnight,
    startDelegateJob: async (input) => {
      startedJobs.push(input);
      return { ok: true, job: { id: `job-${startedJobs.length}` } };
    },
    listDelegateJobs: async () => [...listedJobs],
    pauseDelegateJob: async (id) => {
      pausedJobs.push(id);
      return { ok: true };
    },
    listProjects: async () => projects,
  });

  return {
    engine,
    clock,
    now,
    overnight,
    ledgerRows,
    startedJobs,
    pausedJobs,
    listedJobs,
    vetoCards,
    published,
    engineStateObj,
    overnightStoreObj,
    setQueue(rows) {
      engineStateObj.tonightQueue = rows;
    },
    advance(ms) {
      clock.ms += ms;
    },
  };
}

const TROUGH = { startMs: 1_700_000_000_000 - 30 * 60_000, endMs: 1_700_000_000_000 + 5.5 * HOUR };
const QUEUE_TASK = {
  id: "tq:1",
  name: "Reconcile the ledger",
  prompt: "Reconcile the ledger and report.",
  project: "/repo",
  value: 1,
  confidence: 0.8,
  predictedCost: 1,
  refs: [],
  cls: "queue-tonight",
  originId: null,
  addedMs: 1_699_900_000_000,
};
const PROJECT_ROW = { tmuxSession: "s1", defaultCwd: "/repo", windows: [{ opencodeSessionId: "sess-1" }] };

test("overnight: window opens in the trough while absent → dispatches via the cto actor seam with the window sweep allowance", async () => {
  const h = makeHarness({ trough: TROUGH, queue: [QUEUE_TASK], projects: [PROJECT_ROW] });
  await h.engine.tick();

  assert.equal(h.startedJobs.length, 1, "one overnight job started");
  const job = h.startedJobs[0];
  assert.equal(job.parentSessionID, "sess-1");
  assert.equal(job.parentDirectory, "/repo");
  assert.ok(job.sweepAllowanceMs > 0 && job.sweepAllowanceMs <= TROUGH.endMs - h.now(), "sweep allowance = window remaining");
  assert.match(job.prompt, /Reconcile the ledger/);
  assert.deepEqual(h.engineStateObj.tonightQueue, [], "a started task leaves the queue");
  assert.ok(h.ledgerRows.some((r) => r.kind === "cto.overnight.job_started" && r.id === "tq:1"));
  assert.equal(h.overnightStoreObj.window?.state, "open");

  const s = await h.engine.getState();
  assert.equal(s.tonightCount, 0);
});

test("overnight: no window without the trough or the Overnight switch (or at tier < high)", async () => {
  const offTrough = makeHarness({ trough: null, queue: [QUEUE_TASK], projects: [PROJECT_ROW] });
  await offTrough.engine.tick();
  assert.equal(offTrough.startedJobs.length, 0);
  assert.notEqual(offTrough.overnightStoreObj.window?.state, "open");

  const lowTier = makeHarness({ trough: TROUGH, queue: [QUEUE_TASK], projects: [PROJECT_ROW], tier: "medium" });
  await lowTier.engine.tick();
  assert.equal(lowTier.startedJobs.length, 0);

  const switchOff = makeHarness({ trough: TROUGH, queue: [QUEUE_TASK], projects: [PROJECT_ROW], overnightEnabled: false });
  await switchOff.engine.tick();
  assert.equal(switchOff.startedJobs.length, 0);
  assert.deepEqual(switchOff.engineStateObj.tonightQueue, [QUEUE_TASK]);
});

test("overnight: a candidate with no tracked project session is skipped and ledgered, not dropped", async () => {
  const h = makeHarness({ trough: TROUGH, queue: [QUEUE_TASK], projects: [] });
  await h.engine.tick();
  assert.equal(h.startedJobs.length, 0);
  assert.ok(h.ledgerRows.some((r) => r.kind === "cto.overnight.skip" && r.reason?.includes("no tracked project session")));
  assert.deepEqual(h.engineStateObj.tonightQueue, [QUEUE_TASK], "the queued task survives a skip");
});

test("overnight: dispatch honors the §3.3 concurrent sub-cap (2) via the rate tracker", async () => {
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push({ ...QUEUE_TASK, id: `tq:${i}`, project: `/repo${i}` });
  }
  const projects = tasks.map((t, i) => ({
    tmuxSession: `s${i}`,
    defaultCwd: `/repo${i}`,
    windows: [{ opencodeSessionId: `sess-${i}` }],
  }));
  const h = makeHarness({ trough: TROUGH, queue: tasks, projects });
  await h.engine.tick();
  assert.ok(h.startedJobs.length <= 2, `at most 2 concurrent overnight starts (got ${h.startedJobs.length})`);
});

test("overnight: user prompt preempts — running cto jobs paused and the window closes (§11.6)", async () => {
  const h = makeHarness({ trough: TROUGH, queue: [QUEUE_TASK], projects: [PROJECT_ROW] });
  await h.engine.tick();
  assert.equal(h.overnightStoreObj.window?.state, "open");
  h.listedJobs.push({ id: "job-1", actor: "cto", status: "running" }, { id: "job-2", actor: "user", status: "running" });

  h.engine.observeEvent({ type: "user.message.created" });
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(h.pausedJobs, ["job-1"], "only the cto-actor job is paused");
  assert.equal(h.overnightStoreObj.window?.state, "closed");
  assert.equal(h.overnightStoreObj.window?.closeReason, "user-return");
});

test("overnight: veto card arms 30 min before the trough, cancels on the veto verdict, resolves once open", async () => {
  // Inside the pre-window: 20 min before the trough's start.
  const due = h0().startMs;
  const h = makeHarness({ trough: { startMs: due, endMs: due + 6 * HOUR }, queue: [QUEUE_TASK], projects: [] });
  h.clock.ms = due - 20 * 60_000;
  await h.engine.tick();

  assert.equal(h.overnightStoreObj.window?.countdown?.dueMs, due, "countdown armed at the trough start");
  assert.equal(h.vetoCards.length, 1);
  assert.equal(h.vetoCards[0].variant, "veto");
  assert.equal(h.vetoCards[0].dueMs, due);
  assert.ok(h.ledgerRows.some((r) => r.kind === "cto.overnight.veto_card"));

  // Cancel tonight → countdown cleared, card resolved, veto verdict recorded.
  const r = await h.engine.tonightCancel();
  assert.equal(r.ok, true);
  assert.equal(h.overnightStoreObj.window?.countdown ?? null, null);
  assert.equal(h.vetoCards.length, 0, "the veto card resolved on cancel");
  assert.ok(h.ledgerRows.some((row) => row.kind === "cto.overnight.veto"));

  // A later tick with the window OPEN resolves a lingering card, not a new one.
  await h.engine.tick();
  assert.equal(h.vetoCards.length, 0);
});

test("overnight: run-now opens the window outside the trough and dispatches", async () => {
  const h = makeHarness({ trough: null, queue: [QUEUE_TASK], projects: [PROJECT_ROW] });
  const r = await h.engine.tonightRunNow();
  assert.equal(r.ok, true);
  await h.engine.tick();
  assert.equal(h.startedJobs.length, 1, "run-now opens the window even without a trough");
  assert.equal(h.overnightStoreObj.window?.openedBy, "run-now");
});

test("tonight verbs: add gates on the switch, caps at 12, remove + reorder pin the order", async () => {
  const offSwitch = makeHarness({ trough: TROUGH, projects: [], overnightEnabled: false });
  const denied = await offSwitch.engine.tonightAdd({ name: "X" });
  assert.equal(denied.ok, false, "overnight switch off → refused");
  assert.equal(offSwitch.engineStateObj.tonightQueue.length, 0);

  const h = makeHarness({ trough: TROUGH, projects: [] });
  const ok = await h.engine.tonightAdd({ name: "Nightly sweep", prompt: "sweep", project: "/repo", value: 1, confidence: 0.8 });
  assert.equal(ok.ok, true);
  assert.equal(ok.task.cls, "queue-tonight");
  assert.deepEqual(h.engineStateObj.tonightQueue.map((t) => t.name), ["Nightly sweep"]);

  const noName = await h.engine.tonightAdd({ name: "   " });
  assert.equal(noName.ok, false);

  // Cap: fill to 12, the 13th add is refused with a note.
  for (let i = 0; i < 11; i++) await h.engine.tonightAdd({ name: `t${i}` });
  assert.equal(h.engineStateObj.tonightQueue.length, 12);
  const full = await h.engine.tonightAdd({ name: "one too many" });
  assert.equal(full.ok, false);
  assert.match(full.error ?? "", /full/);

  // Reorder pins the window order (normalized into the window row).
  const pinned = await h.engine.tonightReorder(h.engineStateObj.tonightQueue.map((t) => t.id).reverse());
  assert.equal(pinned.ok, true);
  assert.equal(h.overnightStoreObj.window?.pinnedOrder?.length, 12);

  // Remove drops the entry AND its pinned slot.
  const removed = await h.engine.tonightRemove(h.engineStateObj.tonightQueue[0].id);
  assert.equal(removed.ok, true);
  assert.equal(h.engineStateObj.tonightQueue.length, 11);
});

test("overnight: queue-tonight verdicts fold into the overnight Thompson counters", async () => {
  const h = makeHarness({ trough: TROUGH, projects: [] });
  await h.engine.recordVerdict({ subject: { type: "suggestion", id: "card-1", class: "queue-tonight" }, verdict: "accept" });
  await new Promise((r) => setImmediate(r));
  const counters = await h.overnight.readCounters();
  assert.equal(counters?.["queue-tonight"]?.alpha, 1, "accept folds a success counter");
});

// Fixed trough helper for the veto-card test (a window that starts "now").
function h0() {
  return { startMs: 1_700_000_000_000 + 6 * HOUR, endMs: 1_700_000_000_000 + 12 * HOUR };
}
