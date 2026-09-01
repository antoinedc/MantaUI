// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

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
function makeHarness({ trough = null, queue = [], projects = [], tier = "high", overnightEnabled = true, budgetPlan = null, listProjectsFn = null } = {}) {
  const clock = { ms: 1_700_000_000_000 };
  const now = () => clock.ms;
  const ledgerRows = [];
  const engineStateObj = { v: 1, pendingBlockers: [], tonightQueue: JSON.parse(JSON.stringify(queue)) };
  const overnightStoreObj = { v: 1, window: null };
  const verdictsObj = { v: 1, entries: [] };
  const trustObj = { v: 1, tiers: {}, stats: {}, pending: [] };
  const published = [];
  const startedJobs = [];
  const pausedJobs = [];
  const listedJobs = [];
  const vetoCards = [];

  // Raw engine-state writer (the shared shape of the production writers).
  // BET-1403 (cycle 4): a `trust` key in the payload is IGNORED — the trust
  // ladder persists to its own store, so a stale snapshot-spread save can no
  // longer carry trust state in or out of this file.
  function saveEngineStateRaw(payload = {}) {
    if (Array.isArray(payload?.tonightQueue)) engineStateObj.tonightQueue = payload.tonightQueue;
    if (payload?.pendingBlockers) engineStateObj.pendingBlockers = payload.pendingBlockers;
    if (payload?.rollupCursor) engineStateObj.rollupCursor = payload.rollupCursor;
    if (payload?.backfillProgress) engineStateObj.backfillProgress = payload.backfillProgress;
    if (payload?.backfillStartInstant !== undefined) engineStateObj.backfillStartInstant = payload.backfillStartInstant;
  }
  const config = { ctoEnabled: true, ctoTier: tier, ctoOvernight: overnightEnabled };
  let curTrough = trough;

  const overnight = createOvernightScheduler({
    store: {
      load: async () => ({ ...overnightStoreObj }),
      save: async (payload) => {
        overnightStoreObj.window = payload.window ?? null;
        overnightStoreObj.counters = payload.counters;
      },
    },
    now,
    budget: async () => budgetPlan,
    ledger: { append: async (row) => ledgerRows.push(row) },
  });

  const engine = createCtoEngine({
    configGet: async () => ({ ...config }),
    tierGet: async () => config.ctoTier,
    now,
    // §9.5 verdict ledger, in-memory so tests never share the sandboxed file.
    verdicts: {
      load: async () => JSON.parse(JSON.stringify(verdictsObj)),
      save: async (payload) => {
        verdictsObj.v = payload?.v ?? 1;
        verdictsObj.entries = Array.isArray(payload?.entries) ? JSON.parse(JSON.stringify(payload.entries)) : [];
      },
    },
    // BET-1403: the trust ladder's own store (in-memory, isolated from
    // engine-state writers).
    trustStore: {
      load: async () => JSON.parse(JSON.stringify(trustObj)),
      save: async (payload) => {
        const copy = JSON.parse(JSON.stringify(payload ?? {}));
        trustObj.v = copy.v ?? 1;
        trustObj.tiers = copy.tiers ?? {};
        trustObj.stats = copy.stats ?? {};
        trustObj.pending = Array.isArray(copy.pending) ? copy.pending : [];
      },
    },
    ledger: {
      append: async (row) => ledgerRows.push(row),
      read: async () => [...ledgerRows],
    },
    engineState: {
      load: async () => JSON.parse(JSON.stringify(engineStateObj)),
      save: saveEngineStateRaw,
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
    profile: { getQuietTrough: () => curTrough },
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
    listProjects: listProjectsFn ?? (async () => projects),
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
    setTrough(t) {
      curTrough = t;
    },
    // Test seam: a raw engine-state write (the hostile snapshot-spread shape
    // from the pre-cycle-4 writers).
    engineStateSave: saveEngineStateRaw,
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
  assert.ok(h.ledgerRows.some((r) => r.kind === "cto.overnight.job_started" && r.id === "tq:1" && r.estTokens > 0));
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

test("overnight: an unreadable project list skips + retains the queue row (transient, not a verdict)", async () => {
  const h = makeHarness({ trough: TROUGH, queue: [QUEUE_TASK], listProjectsFn: async () => {
    throw new Error("tmux down");
  } });
  await h.engine.tick();
  assert.equal(h.startedJobs.length, 0);
  assert.ok(h.ledgerRows.some((r) => r.kind === "cto.overnight.skip" && r.reason?.includes("no tracked project session")));
  assert.deepEqual(h.engineStateObj.tonightQueue, [QUEUE_TASK], "a transient project-list failure retains the row");
  assert.equal(h.engineStateObj.pendingBlockers.length, 0, "no needs-you item for a transient failure");
});

test("overnight: a queue entry with no tracked project session is removed on the FIRST skip (one final row + needs-you), never re-skipped (BET-1426)", async () => {
  const h = makeHarness({ trough: TROUGH, queue: [QUEUE_TASK], projects: [] });
  await h.engine.tick();
  assert.equal(h.startedJobs.length, 0);
  const final = h.ledgerRows.find((r) => r.kind === "cto.overnight.skip" && r.id === "tq:1");
  assert.ok(final, "one final skip row for the removed entry");
  assert.ok(final.reason?.includes("no tracked project session"));
  assert.equal(final.removed, true, "the row records the removal");
  assert.deepEqual(h.engineStateObj.tonightQueue, [], "the unresolvable entry leaves the queue");
  assert.ok(
    h.engineStateObj.pendingBlockers.some((b) => b.reason?.includes("Reconcile the ledger")),
    "a needs-you blocker records the removal",
  );

  // §10.4: the tonight count reflects the removal.
  const s = await h.engine.getState();
  assert.equal(s.tonightCount, 0);

  // The next tick of the open window writes NO further skip rows for the
  // removed entry — the repeated-skip loop is gone.
  h.advance(60 * 1000);
  await h.engine.tick();
  assert.equal(
    h.ledgerRows.filter((r) => r.kind === "cto.overnight.skip" && r.id === "tq:1").length,
    1,
    "no re-skip for the removed entry on the next tick",
  );
});

// A watcher hit ledger row as the standing-query engine writes it (the
// BET-1428 shape carries the hosting project; older rows don't).
function watcherHitRow(overrides = {}) {
  return {
    kind: "watcher.hit",
    salience: "high",
    watcherId: "w1",
    predicateKind: "event-pattern",
    text: "P0 cluster in the deploy logs",
    refs: [],
    ts: 0,
    ...overrides,
  };
}

test("overnight: a watcher hit with a tracked project hosts the investigation there and runs once per window (BET-1428)", async () => {
  const h = makeHarness({ trough: TROUGH, projects: [PROJECT_ROW] });
  h.ledgerRows.push(watcherHitRow({ ts: h.now() - 60_000, project: "/repo" }));
  await h.engine.tick();

  assert.equal(h.startedJobs.length, 1, "the watcher-driven investigation starts");
  assert.equal(h.startedJobs[0].parentSessionID, "sess-1", "hosted in the project that produced the hit");
  assert.equal(h.startedJobs[0].parentDirectory, "/repo");
  assert.match(h.startedJobs[0].prompt, /P0 cluster/, "the hit text becomes the investigation prompt");
  const startedRow = h.ledgerRows.find((r) => r.kind === "cto.overnight.job_started" && r.id === "wh:w1");
  assert.ok(startedRow, "the job_started row is keyed by the watcher-hit id");
  assert.equal(startedRow.project, "/repo");
  assert.equal(startedRow.category, "watcher");

  // The hit stays in the trailing-24h ledger — the startedIds dedupe keeps
  // the next tick of the open window from re-running it.
  h.advance(60 * 1000);
  await h.engine.tick();
  assert.equal(h.startedJobs.length, 1, "no re-run on the next tick");
  assert.equal(
    h.ledgerRows.filter((r) => r.kind === "cto.overnight.job_started" && r.id === "wh:w1").length,
    1,
  );
});

test("overnight: a watcher hit with no hostable project skips ONCE per window, not per tick (BET-1428)", async () => {
  const h = makeHarness({ trough: TROUGH, projects: [PROJECT_ROW] });
  h.ledgerRows.push(watcherHitRow({ watcherId: "w2", ts: h.now() - 60_000 }));
  await h.engine.tick();
  assert.equal(h.startedJobs.length, 0);
  assert.equal(
    h.ledgerRows.filter((r) => r.kind === "cto.overnight.skip" && r.id === "wh:w2").length,
    1,
    "one skip row for the unhostable hit",
  );

  // The hit remains a candidate for the whole 24h collection window; the
  // per-window skip dedupe keeps the ledger quiet while the retry stays live.
  h.advance(60 * 1000);
  await h.engine.tick();
  h.advance(60 * 1000);
  await h.engine.tick();
  assert.equal(
    h.ledgerRows.filter((r) => r.kind === "cto.overnight.skip" && r.id === "wh:w2").length,
    1,
    "still one skip row after two more ticks",
  );
  assert.equal(h.startedJobs.length, 0);
});

test("overnight: a hit whose project no longer resolves skips once per window, and a mid-window session opens the retry (BET-1428)", async () => {
  const h = makeHarness({ trough: TROUGH, projects: [PROJECT_ROW] });
  h.ledgerRows.push(watcherHitRow({ watcherId: "w3", ts: h.now() - 60_000, project: "/gone" }));
  await h.engine.tick();
  assert.equal(h.startedJobs.length, 0);
  assert.equal(
    h.ledgerRows.filter((r) => r.kind === "cto.overnight.skip" && r.id === "wh:w3").length,
    1,
  );
  h.advance(60 * 1000);
  await h.engine.tick();
  assert.equal(
    h.ledgerRows.filter((r) => r.kind === "cto.overnight.skip" && r.id === "wh:w3").length,
    1,
    "no repeated row while /gone stays untracked",
  );

  // A project session for /gone opens → the retry starts it; the dedupe
  // suppressed rows, never the candidate.
  const grown = makeHarness({ trough: TROUGH, projects: [PROJECT_ROW, { tmuxSession: "s2", defaultCwd: "/gone", windows: [{ opencodeSessionId: "sess-2" }] }] });
  grown.ledgerRows.push(watcherHitRow({ watcherId: "w3", ts: grown.now() - 60_000, project: "/gone" }));
  await grown.engine.tick();
  assert.equal(grown.startedJobs.length, 1, "the retry runs once the project resolves");
  assert.equal(grown.startedJobs[0].parentDirectory, "/gone");
});

test("overnight: cap-blocked candidates re-skip silently — one row per candidate per window, retries stay live (BET-1428)", async () => {
  const tasks = [];
  for (let i = 0; i < 4; i++) tasks.push({ ...QUEUE_TASK, id: `tq:${i}`, project: `/repo${i}` });
  const projects = tasks.map((t, i) => ({
    tmuxSession: `s${i}`,
    defaultCwd: `/repo${i}`,
    windows: [{ opencodeSessionId: `sess-${i}` }],
  }));
  const h = makeHarness({ trough: TROUGH, queue: tasks, projects, budgetPlan: { spendableFrac: 4 } });
  h.listedJobs.push({ id: "r1", actor: "cto", status: "running" }, { id: "r2", actor: "cto", status: "running" });
  await h.engine.tick();
  assert.equal(h.startedJobs.length, 0, "the sub-cap of 2 is already full");
  assert.equal(
    h.ledgerRows.filter((r) => r.kind === "cto.overnight.skip" && r.reason === "rate_limit:concurrentDelegate").length,
    4,
    "one cap-skip row per candidate",
  );

  h.advance(60 * 1000);
  await h.engine.tick();
  assert.equal(
    h.ledgerRows.filter((r) => r.kind === "cto.overnight.skip" && r.reason === "rate_limit:concurrentDelegate").length,
    4,
    "retries are silent while the cap stays full",
  );

  // A freed slot starts the retried candidate — the dedupe suppressed rows,
  // never the retry.
  h.listedJobs.length = 0;
  h.advance(60 * 1000);
  await h.engine.tick();
  assert.equal(h.startedJobs.length, 2, "a freed sub-cap slot starts candidates on a later tick");
});

test("overnight: dispatch enforces the §3.3 concurrent sub-cap (2) by counting running cto jobs + accepted starts", async () => {
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push({ ...QUEUE_TASK, id: `tq:${i}`, project: `/repo${i}` });
  }
  const projects = tasks.map((t, i) => ({
    tmuxSession: `s${i}`,
    defaultCwd: `/repo${i}`,
    windows: [{ opencodeSessionId: `sess-${i}` }],
  }));
  // A fat budget seam (spendableFrac 5) lets the plan select all 5 candidates
  // in ONE tick — the cap must still hold at dispatch time, not in the plan.
  // Two cto-actor jobs are already running → zero new starts, each blocked
  // candidate ledgered for the next tick, queue untouched.
  const capped = makeHarness({ trough: TROUGH, queue: tasks, projects, budgetPlan: { spendableFrac: 5 } });
  capped.listedJobs.push({ id: "r1", actor: "cto", status: "running" }, { id: "r2", actor: "cto", status: "running" });
  await capped.engine.tick();
  assert.equal(capped.startedJobs.length, 0, "2 running cto jobs → the sub-cap of 2 allows no new start");
  assert.ok(
    capped.ledgerRows.filter((r) => r.kind === "cto.overnight.skip" && r.reason === "rate_limit:concurrentDelegate").length >= 1,
    "each blocked candidate is ledgered for the next tick",
  );
  assert.deepEqual(
    capped.engineStateObj.tonightQueue.map((t) => t.id),
    tasks.map((t) => t.id),
    "queued tasks survive a cap-blocked dispatch",
  );

  // One running cto job → exactly one accepted start; the rest wait.
  const one = makeHarness({ trough: TROUGH, queue: tasks, projects, budgetPlan: { spendableFrac: 5 } });
  one.listedJobs.push({ id: "r1", actor: "cto", status: "running" });
  await one.engine.tick();
  assert.equal(one.startedJobs.length, 1, "one free sub-cap slot → exactly one start");
  assert.ok(one.ledgerRows.some((r) => r.kind === "cto.overnight.skip" && r.reason === "rate_limit:concurrentDelegate"));

  // user-actor running jobs don't consume the cto sub-cap.
  const userJobs = makeHarness({ trough: TROUGH, queue: tasks, projects, budgetPlan: { spendableFrac: 5 } });
  userJobs.listedJobs.push({ id: "u1", actor: "user", status: "running" }, { id: "u2", actor: "user", status: "running" });
  await userJobs.engine.tick();
  assert.equal(userJobs.startedJobs.length, 2, "user jobs don't count against the cto sub-cap");
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

  // Cancel tonight → countdown cleared, card resolved, veto verdict recorded,
  // and the veto stamp lands on THIS trough (the machine's open path reads it).
  const r = await h.engine.tonightCancel();
  assert.equal(r.ok, true);
  assert.equal(h.overnightStoreObj.window?.countdown ?? null, null);
  assert.equal(h.overnightStoreObj.window?.vetoedTroughStartMs, due, "the veto stamp names this trough");
  assert.equal(h.vetoCards.length, 0, "the veto card resolved on cancel");
  assert.ok(h.ledgerRows.some((row) => row.kind === "cto.overnight.veto"));

  // BET-1403 §9.4: the cancel verdict is stamped with the canonical action
  // class the veto window guards (queue-tonight — the §9.3 eligibility map's
  // class), and the veto-window record's rejection advanced exactly once.
  const verdicts = (await h.engine.listVerdicts()).filter((v) => v?.subject?.type === "veto-window");
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].subject.class, "queue-tonight", "the veto verdict carries the canonical action class");
  const trustAfterCancel = await h.engine.trust.getState();
  assert.equal(trustAfterCancel.stats["queue-tonight"]?.vb, 1, "a cancel feeds the veto record's rejection");
  assert.equal(trustAfterCancel.stats["queue-tonight"]?.va ?? 0, 0);

  // Still in the pre-window: the veto suppresses BOTH the card re-arm and the
  // countdown — a cancel is not a countdown reset (§9.2).
  h.advance(5 * 60_000);
  await h.engine.tick();
  assert.equal(h.overnightStoreObj.window?.countdown ?? null, null, "no countdown re-arm after a veto");
  assert.equal(h.vetoCards.length, 0, "no veto card re-arm after a veto");

  // THE §9.2 CONTRACT: the clock advances INTO the trough while the user is
  // absent — the window must NOT re-open and nothing may execute unannounced.
  h.advance(30 * 60_000);
  await h.engine.tick();
  assert.notEqual(h.overnightStoreObj.window?.state, "open", "a vetoed trough never re-opens");
  assert.equal(h.startedJobs.length, 0, "a canceled night runs nothing");

  // The stamp is per-trough: tomorrow's trough arms a fresh veto card again.
  const next = { startMs: due + 24 * HOUR, endMs: due + 30 * HOUR };
  h.setTrough(next);
  h.advance(24 * HOUR - 20 * 60_000);
  await h.engine.tick();
  assert.equal(h.vetoCards.length, 1, "the next night arms a fresh veto card — the veto expired with its trough");

  // A later tick with the window OPEN resolves a lingering card, not a new one.
  const openTrough = { startMs: h.now(), endMs: h.now() + 6 * HOUR };
  h.setTrough(openTrough);
  h.advance(60 * 60_000);
  await h.engine.tick();
  assert.equal(h.overnightStoreObj.window?.state, "open", "the fresh trough opens normally (absent, in trough)");
  assert.equal(h.vetoCards.length, 0);

  // BET-1403 §9.4: that resolution was the EXECUTED path — the announced
  // window elapsed uncancelled and the run opened, so the veto record's
  // acceptance advanced (the va side of the veto→act bar). Both sides of the
  // record are now fed by the same machinery, exactly once per window.
  const trustAfterOpen = await h.engine.trust.getState();
  assert.equal(trustAfterOpen.stats["queue-tonight"]?.va, 1, "the executed window feeds the veto record's acceptance");
  assert.equal(trustAfterOpen.stats["queue-tonight"]?.vb, 1, "the earlier cancel is still on the record");
});

test("overnight: an executed window feeds the veto record's acceptance (BET-1403 §9.4 veto→act bar)", async () => {
  const due = h0().startMs;
  const h = makeHarness({ trough: { startMs: due, endMs: due + 6 * HOUR }, queue: [QUEUE_TASK], projects: [] });

  // Arm the veto card in the pre-window (no cancel this time).
  h.clock.ms = due - 20 * 60_000;
  await h.engine.tick();
  assert.equal(h.vetoCards.length, 1);

  // The clock enters the trough while the user is absent: the window opens
  // (the machine's open path fulfils the countdown) and the next tick resolves
  // the lingering veto card as fulfilled.
  h.advance(25 * 60_000);
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.overnightStoreObj.window?.state, "open", "the unannounced-veto window opened");
  assert.equal(h.vetoCards.length, 0, "the veto card resolved once the window opened");

  // The veto-window record's acceptance advanced under the canonical class —
  // the va/vb pair the veto→act promotion bar (§9.4) reads.
  const st = await h.engine.trust.getState();
  assert.equal(st.stats["queue-tonight"]?.va, 1, "an executed window feeds the veto record's acceptance");
  assert.equal(st.stats["queue-tonight"]?.vb ?? 0, 0);

  // And a cancel on a LATER night demotes the rolling pressure the same way —
  // both sides of the record are fed by the same machinery. BET-1426: night 1
  // consumed (removed) the unresolvable queue row, so a fresh accepted task
  // backs tomorrow's candidates — an empty queue arms no veto card.
  const nextDue = due + 24 * HOUR;
  h.setQueue([{ ...QUEUE_TASK, id: "tq:next" }]);
  h.setTrough({ startMs: nextDue, endMs: nextDue + 6 * HOUR });
  h.advance(24 * HOUR - 25 * 60_000);
  await h.engine.tick(); // arm tomorrow's card
  assert.equal(h.vetoCards.length, 1, "the next night arms a fresh veto card");
  await h.engine.tonightCancel();
  const st2 = await h.engine.trust.getState();
  assert.equal(st2.stats["queue-tonight"]?.va, 1);
  assert.equal(st2.stats["queue-tonight"]?.vb, 1, "the later cancel feeds the rejection side too");
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

  // BET-1426: adds resolve against the tracked projects — one hostable
  // project auto-resolves a project-less add; the named "/repo" matches.
  const h = makeHarness({ trough: TROUGH, projects: [PROJECT_ROW] });
  const ok = await h.engine.tonightAdd({ name: "Nightly sweep", prompt: "sweep", project: "/repo", value: 1, confidence: 0.8 });
  assert.equal(ok.ok, true);
  assert.equal(ok.task.cls, "queue-tonight");
  assert.equal(ok.task.project, "/repo");
  assert.equal(ok.projectResolved, "explicit");
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

  // Remove drops the entry AND its pinned slot. Drain first: the remove's
  // §9.5 verdict fires its counter sinks fire-and-forget, and a best-effort
  // engine-state write from an in-flight sink must settle before the store is
  // read (a stale full-state snapshot would otherwise clobber the queue row).
  const removed = await h.engine.tonightRemove(h.engineStateObj.tonightQueue[0].id);
  assert.equal(removed.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.engineStateObj.tonightQueue.length, 11);
});

test("tonightAdd project resolution (BET-1426): explicit canonicalize, auto-resolve on a single hostable project, refuse otherwise", async () => {
  // Explicit: the named dir resolves → stored (canonicalized to the owning
  // project's defaultCwd when they differ).
  const two = makeHarness({
    trough: TROUGH,
    projects: [
      PROJECT_ROW,
      { tmuxSession: "s2", defaultCwd: "/other", windows: [{ opencodeSessionId: "sess-2" }] },
    ],
  });
  const explicit = await two.engine.tonightAdd({ name: "A", project: "/repo" });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.projectResolved, "explicit");
  assert.equal(explicit.task.project, "/repo");
  assert.ok(two.ledgerRows.some((r) => r.kind === "cto.overnight.queue_add" && r.id === explicit.task.id && r.resolved === "explicit" && r.project === "/repo"));

  // A subdir that matches via a window path canonicalizes to defaultCwd.
  const winRow = { tmuxSession: "s3", defaultCwd: "/canonical", windows: [{ opencodeSessionId: "sess-3", paneCurrentPath: "/canonical/sub" }] };
  const win = makeHarness({ trough: TROUGH, projects: [winRow] });
  const canon = await win.engine.tonightAdd({ name: "E", project: "/canonical/sub" });
  assert.equal(canon.ok, true);
  assert.equal(canon.task.project, "/canonical", "the canonical project dir is stored, not the raw match path");

  // Ambiguous: two hostable projects, the named project unresolvable → refuse.
  const ambiguous = await two.engine.tonightAdd({ name: "B", project: "/nowhere" });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error ?? "", /project/);

  // Ambiguous: no project named at all → refuse (can't pick a host).
  const noName2 = await two.engine.tonightAdd({ name: "B2" });
  assert.equal(noName2.ok, false);
  assert.match(noName2.error ?? "", /project/);

  // Auto-resolve: missing project + exactly one hostable project → queued
  // under it, noted in the ack and the ledger row.
  const single = makeHarness({ trough: TROUGH, projects: [PROJECT_ROW] });
  const auto = await single.engine.tonightAdd({ name: "C" });
  assert.equal(auto.ok, true);
  assert.equal(auto.projectResolved, "auto");
  assert.equal(auto.task.project, "/repo");
  assert.ok(single.ledgerRows.some((r) => r.kind === "cto.overnight.queue_add" && r.id === auto.task.id && r.resolved === "auto" && r.project === "/repo"));

  // Auto-resolve also rescues a NAMED-but-unresolvable project when exactly
  // one hostable project exists (the triage's missing-or-unresolvable branch).
  const auto2 = await single.engine.tonightAdd({ name: "C2", project: "/ghost" });
  assert.equal(auto2.ok, true);
  assert.equal(auto2.projectResolved, "auto");
  assert.equal(auto2.task.project, "/repo");

  // Refuse: zero hostable projects (nothing can ever host the job).
  const none = makeHarness({ trough: TROUGH, projects: [] });
  const refused = await none.engine.tonightAdd({ name: "D" });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /no tracked project session/);

  // Refuse: an unreadable project list cannot verify resolvability — the
  // queue only ever holds runnable rows, so the add fails loudly.
  const unreadable = makeHarness({ trough: TROUGH, projects: [], listProjectsFn: async () => {
    throw new Error("tmux down");
  } });
  const unverifiable = await unreadable.engine.tonightAdd({ name: "F", project: "/repo" });
  assert.equal(unverifiable.ok, false);
  assert.match(unverifiable.error ?? "", /cannot verify/);
  assert.equal(unreadable.engineStateObj.tonightQueue.length, 0);
});

test("overnight: queue-tonight verdicts fold into the overnight Thompson counters", async () => {
  const h = makeHarness({ trough: TROUGH, projects: [] });
  await h.engine.recordVerdict({ subject: { type: "suggestion", id: "card-1", class: "queue-tonight" }, verdict: "accept" });
  await new Promise((r) => setImmediate(r));
  const counters = await h.overnight.readCounters();
  assert.equal(counters?.["queue-tonight"]?.alpha, 1, "accept folds a success counter");
});

test("durability: a trust fold survives a queue-edit save landing after it (mirrored-order regression, BET-1403 cycle 4)", async () => {
  const h = makeHarness({ trough: TROUGH, queue: [QUEUE_TASK], projects: [] });

  // The trust fold lands first (a verdict's fire-and-forget sink writes the
  // trust ladder's own store).
  await h.engine.recordVerdict({ subject: { type: "suggestion", id: "card-2", class: "queue-tonight" }, verdict: "accept" });
  await new Promise((r) => setImmediate(r));
  const afterFold = await h.engine.trust.getState();
  assert.equal(afterFold.stats["queue-tonight"]?.a, 1);

  // Then a queue edit lands — AND the hostile old writer shape runs: a whole
  // engine-state save spreading a STALE pre-fold snapshot that still carries
  // an `es.trust` fossil key. When trust lived under es.trust this reverted
  // the fold; with the dedicated store the tier/counter change survives and
  // the queue edit lands normally.
  const removed = await h.engine.tonightRemove(h.engineStateObj.tonightQueue[0].id);
  assert.equal(removed.ok, true);
  await h.engineStateSave({ v: 1, trust: { tiers: {}, stats: {} }, tonightQueue: [{ id: "tq:stale" }] });
  await new Promise((r) => setImmediate(r));

  const after = await h.engine.trust.getState();
  // Two folds landed: the accept verdict (a=1) and the remove's own edit
  // verdict (a=2) — BOTH survived the hostile stale engine-state save, which
  // under es.trust would have reverted the record to the pre-fold snapshot.
  assert.equal(after.stats["queue-tonight"]?.a, 2, "the trust folds survived the stale engine-state save");
  assert.deepEqual(h.engineStateObj.tonightQueue, [{ id: "tq:stale" }], "the queue edit landed");
});

// Fixed trough helper for the veto-card test (a window that starts "now").
function h0() {
  return { startMs: 1_700_000_000_000 + 6 * HOUR, endMs: 1_700_000_000_000 + 12 * HOUR };
}

test("overnight: canceling mid-run pauses the job and vetoes the rest of the trough", async () => {
  const h = makeHarness({ trough: TROUGH, queue: [QUEUE_TASK], projects: [PROJECT_ROW] });
  await h.engine.tick();
  assert.equal(h.overnightStoreObj.window?.state, "open");
  assert.equal(h.startedJobs.length, 1);
  h.listedJobs.push({ id: "job-1", actor: "cto", status: "running" });

  const r = await h.engine.tonightCancel();
  assert.equal(r.ok, true);
  assert.deepEqual(h.pausedJobs, ["job-1"], "the running cto job is paused");
  assert.equal(h.overnightStoreObj.window?.state, "closed", "the window closes on cancel");
  assert.equal(h.overnightStoreObj.window?.vetoedTroughStartMs, TROUGH.startMs, "the rest of tonight is vetoed too");

  h.advance(30 * 60_000);
  await h.engine.tick();
  assert.notEqual(h.overnightStoreObj.window?.state, "open", "no re-open after a mid-run cancel");
  assert.equal(h.startedJobs.length, 1, "no further dispatch on a vetoed trough");
});
