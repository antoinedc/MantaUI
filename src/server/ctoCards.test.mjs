import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKER_AFTER_MS,
  CARD_CREATED,
  CARD_RESOLVED,
  CARD_DISMISSED,
  HEALTH_SOURCE_KIND,
  askResolveInfo,
  askStartInfo,
  createCtoCards,
  isAskResolveEvent,
  isAskStartEvent,
  stableCardId,
} from "./ctoCards.mjs";
import { INBOX_TTL_MS } from "./ctoStores.mjs";

// A fully-injected card harness: real in-memory card store, engine-state,
// ledger and a clock we control. No real fs — pure behavior. The
// `patchEngineState` seam mirrors the real ctoStores.mjs helper's contract
// (a static patch object, or a `(fresh) => patch` function; a key set to
// `undefined` deletes it) but without its mutex — fine for these
// single-threaded, sequential-await tests.
function makeHarness({ pendingBlockers = [], fireNotify = false } = {}) {
  const clock = { ms: 1_000_000 };
  let cardPayload = { v: 1, cards: [] };
  const ledgerRows = [];
  const notified = [];
  let engineState = { v: 1, pendingBlockers: [...pendingBlockers] };
  const patchCalls = [];

  const cards = createCtoCards({
    cardStore: {
      load: async () => cardPayload,
      save: async (p) => {
        cardPayload = p;
      },
    },
    engineState: {
      load: async () => engineState,
      save: async (p) => {
        engineState = p;
      },
    },
    ledger: { append: async (row) => ledgerRows.push(row) },
    ...(fireNotify ? { fireNotify: async (a) => notified.push(a) } : {}),
    now: () => clock.ms,
    patchEngineState: async (mutation) => {
      patchCalls.push(mutation);
      const fresh = engineState;
      const patch = typeof mutation === "function" ? await mutation(fresh) : mutation;
      const next = { ...fresh };
      for (const [k, v] of Object.entries(patch ?? {})) {
        if (v === undefined) delete next[k];
        else next[k] = v;
      }
      engineState = next;
      return next;
    },
  });

  return {
    cards,
    clock,
    ledgerRows,
    notified,
    patchCalls,
    store: () => cardPayload,
    engineStateSnapshot: () => engineState,
    setCardPayload(p) {
      cardPayload = p;
    },
    setPendingBlockers(b) {
      engineState = { v: 1, pendingBlockers: b };
    },
    // BET-1407: pre-load the persisted ask registry (engine-state.json
    // `pendingAsks`) the way a previous boot would have left it.
    setPendingAsks(rows) {
      engineState = { v: 1, pendingBlockers: [], pendingAsks: [...rows] };
    },
    advance(ms) {
      clock.ms += ms;
    },
  };
}

function openCardCount(h) {
  return h.store().cards.filter((c) => c.state === "open").length;
}

// ---------------------------------------------------------------------------

test("stableCardId: same (kind,id) is stable; different ids differ", () => {
  assert.equal(stableCardId("question", "que_1"), stableCardId("question", "que_1"));
  assert.notEqual(stableCardId("question", "que_1"), stableCardId("question", "que_2"));
  assert.notEqual(stableCardId("question", "que_1"), stableCardId("permission", "que_1"));
  assert.match(stableCardId("question", "que_1"), /^[0-9a-f]{24}$/);
});

test("ask event classification helpers", () => {
  assert.equal(isAskStartEvent({ type: "question.asked" }), true);
  assert.equal(isAskStartEvent({ type: "permission.asked" }), true);
  assert.equal(isAskStartEvent({ type: "question.replied" }), false);
  assert.equal(isAskResolveEvent({ type: "question.replied" }), true);
  assert.equal(isAskResolveEvent({ type: "question.rejected" }), true);
  assert.equal(isAskResolveEvent({ type: "permission.replied" }), true);
  assert.equal(isAskResolveEvent({ type: "permission.rejected" }), true);
  assert.equal(isAskResolveEvent({ type: "question.asked" }), false);

  const start = askStartInfo({ type: "question.asked", properties: { sessionID: "s1", id: "que_9" } });
  assert.deepEqual(start, { sourceKind: "question", sourceId: "que_9", sessionID: "s1" });
  // permission -> kind permission
  assert.equal(askStartInfo({ type: "permission.asked", properties: { sessionID: "s1" } }).sourceKind, "permission");
  // resolve info carries session
  assert.deepEqual(askResolveInfo({ type: "permission.replied", properties: { sessionID: "s2" } }), { sessionID: "s2" });
});

test("10-min card timer: no card before threshold, card after; NO notification path", async () => {
  const h = makeHarness();
  const t0 = h.clock.ms;

  await h.cards.onAskStart({ sourceKind: "question", sourceId: "que_1", sessionID: "s1", body: "Pick one?", ts: t0 });

  // A minute of ticks below the threshold → never a card.
  for (let i = 0; i < 9; i++) {
    h.advance(60_000);
    await h.cards.promoteDue();
    assert.equal(openCardCount(h), 0, `no card yet at ${h.clock.ms - t0}ms`);
  }

  // Just under 10 min → still none.
  assert.equal(h.clock.ms - t0, 9 * 60_000);

  // Cross the 10-min threshold → a blocker card appears.
  h.advance(60_000);
  assert.equal(h.clock.ms - t0, BLOCKER_AFTER_MS);
  const r = await h.cards.promoteDue();
  assert.equal(r.changed, true);
  assert.equal(r.promoted, 1);
  assert.equal(openCardCount(h), 1);
  const card = h.store().cards[0];
  assert.equal(card.variant, "blocker");
  assert.equal(card.state, "open");
  assert.equal(card.sourceKind, "question");
  assert.equal(card.pendingSince, t0);
  assert.deepEqual(card.refs, ["s1"]);

  // The ONLY new artifact is the card — no notification is ever emitted by this
  // module. The ledger holds the activation entry, and no ledger row (or
  // anything else) represents a push/notify.
  assert.ok(h.ledgerRows.some((r) => r.kind === CARD_CREATED));
  assert.ok(h.ledgerRows.every((r) => !String(r.kind).toLowerCase().includes("notify")));
});

test("re-detection upserts by stable id, never duplicates", async () => {
  const h = makeHarness();
  const t0 = h.clock.ms;
  await h.cards.onAskStart({ sourceKind: "permission", sourceId: "per_5", sessionID: "s3", body: "", ts: t0 });

  h.advance(BLOCKER_AFTER_MS);
  await h.cards.promoteDue();
  const first = h.store().cards[0];
  const firstId = first.id;
  const firstCreated = first.created;

  // Same ask still pending → re-running promoteDue (and a duplicate ask-start
  // from the scoped stream) must NOT create a second card.
  h.advance(60_000);
  await h.cards.onAskStart({ sourceKind: "permission", sourceId: "per_5", sessionID: "s3", body: "", ts: h.clock.ms });
  await h.cards.promoteDue();

  const open = h.store().cards.filter((c) => c.state === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].id, firstId);
  // The card's age is preserved (created not reset by re-detection).
  assert.equal(open[0].created, firstCreated);
  assert.equal(open[0].pendingSince, t0);
});

test("liveness: every resolve event transition resolves the open card", async () => {
  for (const type of ["question.replied", "question.rejected", "permission.replied", "permission.rejected"]) {
    const h = makeHarness();
    const t0 = h.clock.ms;
    await h.cards.onAskStart({ sourceKind: "question", sourceId: "que_x", sessionID: "sQ", body: "", ts: t0 });
    h.advance(BLOCKER_AFTER_MS);
    await h.cards.promoteDue();
    assert.equal(openCardCount(h), 1);

    // Answer / reject the ask → predicate false → card resolves.
    await h.cards.onAskResolved({ sessionID: "sQ", ts: h.clock.ms });
    assert.equal(openCardCount(h), 0, `${type} should resolve`);
    const row = h.ledgerRows.filter((r) => r.kind === CARD_RESOLVED);
    assert.equal(row.length, 1, `${type} resolves exactly once`);
  }
});

test("liveness: a blocked session being deleted (abort) resolves the card", async () => {
  const h = makeHarness();
  await h.cards.onAskStart({ sourceKind: "question", sourceId: "que_d", sessionID: "sD", body: "", ts: h.clock.ms });
  h.advance(BLOCKER_AFTER_MS);
  await h.cards.promoteDue();
  assert.equal(openCardCount(h), 1);

  await h.cards.onAskResolved({ sessionID: "sD" });
  assert.equal(openCardCount(h), 0);
  assert.equal(h.ledgerRows.filter((r) => r.kind === CARD_RESOLVED).length, 1);
});

test("resolved writes an ACTIVITY-LEDGER entry, NOT a verdict", async () => {
  const h = makeHarness();
  await h.cards.onAskStart({ sourceKind: "question", sourceId: "que_v", sessionID: "sV", body: "", ts: h.clock.ms });
  h.advance(BLOCKER_AFTER_MS);
  await h.cards.promoteDue();
  await h.cards.onAskResolved({ sessionID: "sV" });

  // The card is gone from cards.json (open cards only live there)...
  assert.equal(openCardCount(h), 0);
  // ...and its only ledger trace is card.resolved, prefixed card.* (activity),
  // never a verdict-shaped entry — self-resolution must not pollute acceptance.
  const resolvedRows = h.ledgerRows.filter((r) => r.kind === CARD_RESOLVED);
  assert.equal(resolvedRows.length, 1);
  assert.ok(
    h.ledgerRows.every((r) => typeof r.kind === "string" && !r.kind.includes("verdict")),
    "no verdict entry written",
  );
});

test("health escalation: watchdog pendingBlockers become health cards; recovery resolves them", async () => {
  const h = makeHarness({
    pendingBlockers: [
      { id: "b1", kind: "blocker", source: "watchdog", reason: "ambient spend 5 > 4x expected", ts: 500, resolved: false },
    ],
  });

  await h.cards.ingestHealthEscalations();
  const open = h.store().cards.filter((c) => c.state === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].sourceKind, HEALTH_SOURCE_KIND);
  assert.equal(open[0].variant, "blocker");
  assert.ok(open[0].body.includes("ambient spend"), "body carries the watchdog reason");

  // BET-1463 (defect 1): ingesting the entry stamps it consumed on its own —
  // no manual setPendingBlockers needed to simulate this any more.
  assert.equal(h.engineStateSnapshot().pendingBlockers[0].resolved, true);

  // Resolved health cards are ignored (never re-created).
  await h.cards.ingestHealthEscalations();
  assert.equal(h.store().cards.filter((c) => c.state === "open").length, 1);

  // Recovery (engine resumed) resolves the health card.
  await h.cards.onHealthRecovered();
  assert.equal(h.store().cards.filter((c) => c.state === "open").length, 0);
  assert.equal(h.ledgerRows.filter((r) => r.kind === CARD_RESOLVED).length, 1);
});

test("BET-1463 defect 1: ingesting a pending blocker stamps the entry consumed; a second ingest creates NO second card and appends NO second ledger row", async () => {
  const h = makeHarness({
    pendingBlockers: [{ id: "b1", source: "watchdog", reason: "r1", ts: 500, resolved: false }],
  });

  const r1 = await h.cards.ingestHealthEscalations();
  assert.equal(r1.changed, true);
  assert.equal(h.store().cards.filter((c) => c.state === "open").length, 1);
  const createdRows = h.ledgerRows.filter((r) => r.kind === CARD_CREATED);
  assert.equal(createdRows.length, 1);

  // Same entry, unresolved-by-hand-mutation would be the OLD bug; here the
  // engine-state store itself was stamped by the first ingest.
  const r2 = await h.cards.ingestHealthEscalations();
  assert.equal(r2.changed, false, "the consumed entry is skipped, not re-upserted");
  assert.equal(h.store().cards.filter((c) => c.state === "open").length, 1, "still exactly one card");
  assert.equal(h.ledgerRows.filter((r) => r.kind === CARD_CREATED).length, 1, "no second card.created row");
});

// BET-1463 defect 1 shared setup: one tripped watchdog blocker, escalated
// into its single open health card.
async function escalatedHealthHarness() {
  const h = makeHarness({
    pendingBlockers: [{ id: "b1", source: "watchdog", reason: "ambient spend", ts: 500, resolved: false }],
  });
  await h.cards.ingestHealthEscalations();
  const cardId = h.store().cards.find((c) => c.state === "open").id;
  return { h, cardId };
}

// The invariant both defect-1 teardown paths must hold: the entry itself is
// GONE (not just marked resolved — otherwise a later card tick's ingest has
// something to resurrect from) and a subsequent ingest cannot bring the
// card back.
async function assertNoResurrection(h) {
  assert.equal(h.engineStateSnapshot().pendingBlockers.length, 0);
  const r = await h.cards.ingestHealthEscalations();
  assert.equal(r.changed, false);
  assert.equal(h.store().cards.filter((c) => c.state === "open").length, 0, "no resurrection on a later card tick");
}

test("BET-1463 defect 1: resolving a health card removes its pendingBlockers entry, and a subsequent ingest does not recreate it (Resume regression)", async () => {
  const { h, cardId } = await escalatedHealthHarness();
  assert.equal(h.engineStateSnapshot().pendingBlockers.length, 1, "entry still present, just stamped consumed");

  // User presses Resume -> onHealthRecovered resolves the open health card.
  await h.cards.onHealthRecovered();
  assert.equal(h.store().cards.filter((c) => c.state === "open").length, 0);
  await assertNoResurrection(h);
  assert.equal(h.store().cards.find((c) => c.id === cardId), undefined);
});

test("BET-1463 defect 1: dismissing a health card also drops its pendingBlockers entry", async () => {
  const { h, cardId } = await escalatedHealthHarness();

  await h.cards.dismissById(cardId, { reason: "user dismissed" });
  await assertNoResurrection(h);
});

test("BET-1463 defect 2: a no-op re-upsert returns changed:false and appends no ledger row", async () => {
  const h = makeHarness();
  const args = {
    sourceKind: "question",
    sourceId: "que_noop",
    sessionID: "sN",
    title: "Question waiting",
    body: "Pick one?",
    refs: ["sN"],
    ts: h.clock.ms,
    pendingSince: h.clock.ms,
  };

  const first = await h.cards.upsertBlocker(args);
  assert.equal(first.changed, true);
  assert.equal(first.isNew, true);
  assert.equal(h.ledgerRows.filter((r) => r.kind === CARD_CREATED).length, 1);

  // Time moves on (as promoteDue's re-check would do), but nothing about the
  // ask actually changed — re-upserting identical content must be a no-op.
  h.advance(60_000);
  const second = await h.cards.upsertBlocker({ ...args, ts: h.clock.ms });
  assert.equal(second.changed, false);
  assert.equal(second.isNew, false);
  assert.equal(h.ledgerRows.filter((r) => r.kind === CARD_CREATED).length, 1, "no second ledger row");
  assert.equal(h.store().cards.filter((c) => c.state === "open").length, 1);

  // A genuine content change still upserts.
  h.advance(1000);
  const third = await h.cards.upsertBlocker({ ...args, ts: h.clock.ms, body: "Pick one? (updated)" });
  assert.equal(third.changed, true);
  assert.equal(h.ledgerRows.filter((r) => r.kind === CARD_CREATED).length, 2);
});

test("createCtoCards exports upsertBlocker", () => {
  const cards = createCtoCards();
  assert.equal(typeof cards.upsertBlocker, "function");
});

test("BET-1463: 82 pendingBlockers entries from the SAME watchdog trip source fold into ONE card, not 82", async () => {
  // The literal shape of the 2026-08-31 incident: repeated watchdog trips
  // each wrote a uniquely-id'd pendingBlockers entry with the same source.
  const pendingBlockers = Array.from({ length: 82 }, (_, i) => ({
    id: `trip-${i}`,
    kind: "blocker",
    source: "watchdog",
    reason: `ambient spend ${i} > 4x expected`,
    ts: 1_000_000 + i * 60_000,
    resolved: false,
  }));
  const h = makeHarness({ pendingBlockers });

  const r1 = await h.cards.ingestHealthEscalations();
  assert.equal(r1.changed, true);
  const open1 = h.store().cards.filter((c) => c.state === "open");
  assert.equal(open1.length, 1, "at most one card after the first tick");
  assert.equal(open1[0].pendingSince, 1_000_000, "pendingSince is the EARLIEST outstanding trip");
  assert.ok(open1[0].body.includes("81"), "body carries the MOST RECENT reason");

  const r2 = await h.cards.ingestHealthEscalations();
  assert.equal(r2.changed, false, "second tick produces no new card / no new write");
  assert.equal(h.store().cards.filter((c) => c.state === "open").length, 1);
  assert.equal(
    h.engineStateSnapshot().pendingBlockers.filter((b) => b.resolved !== true).length,
    0,
    "every entry stamped consumed",
  );
});

test("dismiss moves a card out of cards.json with a card.dismissed ledger row", async () => {
  const h = makeHarness();
  await h.cards.onAskStart({ sourceKind: "question", sourceId: "que_m", sessionID: "sM", body: "", ts: h.clock.ms });
  h.advance(BLOCKER_AFTER_MS);
  await h.cards.promoteDue();
  const id = h.store().cards[0].id;

  const r = await h.cards.dismissById(id, { reason: "user dismissed" });
  assert.equal(r.changed, true);
  assert.equal(openCardCount(h), 0);
  assert.equal(h.ledgerRows.filter((x) => x.kind === CARD_DISMISSED).length, 1);
});

test("countOpen reflects only open cards", async () => {
  const h = makeHarness();
  assert.equal(await h.cards.countOpen(), 0);
  await h.cards.onAskStart({ sourceKind: "question", sourceId: "que_c", sessionID: "sC", body: "", ts: h.clock.ms });
  h.advance(BLOCKER_AFTER_MS);
  await h.cards.promoteDue();
  assert.equal(await h.cards.countOpen(), 1);
  await h.cards.onAskResolved({ sessionID: "sC" });
  assert.equal(await h.cards.countOpen(), 0);
});

test("BET-1397 source 3: an inbox blocker fires the blocking-tier notify exactly once and promotes a card", async () => {
  const h = makeHarness({ fireNotify: true });
  const r = await h.cards.onInboxBlocker({
    message: "build is red",
    title: "CI broken",
    refs: ["BET-777"],
    tag: "ci",
    sessionID: "ses-9",
    ts: h.clock.ms,
  });
  assert.equal(r.notified, true);
  // Exactly ONE notification, blocking tier, via the shared router.
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].message, "build is red");
  assert.equal(h.notified[0].title, "CI broken");
  assert.equal(h.notified[0].urgent, true);
  assert.equal(h.notified[0].sessionID, "ses-9");

  // The inbox blocker becomes a card at > 10 min like any ask.
  h.advance(BLOCKER_AFTER_MS);
  const p = await h.cards.promoteDue();
  assert.equal(p.changed, true);
  const open = h.store().cards.filter((c) => c.state === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].sourceKind, "inbox");
  assert.deepEqual(open[0].refs, ["BET-777"]);
});

test("upsertDecision: writes a decision card, and regenerating the same id upserts (no duplicate)", async () => {
  const h = makeHarness();
  const first = await h.cards.upsertDecision({
    id: "sugg-1",
    title: "Restart the stuck build",
    why: "Start-job: the build has been red for hours.",
    refs: ["c1"],
    sourceKind: "failure-recurrence",
    cls: "start-job",
    score: 0.7,
    options: [{ label: "Kick", action: { type: "start-job", payload: { prompt: "retry" } } }],
  });
  assert.equal(first.changed, true);
  assert.equal(first.isNew, true);
  assert.equal(openCardCount(h), 1);

  // regeneration with the same stable id — updates in place, no second card
  h.advance(1000);
  const regen = await h.cards.upsertDecision({
    id: "sugg-1",
    title: "Restart the stuck build (still red)",
    why: "Updated why.",
    refs: ["c1", "c2"],
    sourceKind: "failure-recurrence",
    cls: "start-job",
    score: 0.9,
    options: [{ label: "Kick", action: { type: "start-job", payload: { prompt: "retry-again" } } }],
  });
  assert.equal(regen.changed, true);
  assert.equal(regen.isNew, false);
  assert.equal(openCardCount(h), 1);
  const open = h.store().cards.filter((c) => c.state === "open");
  assert.equal(open[0].title, "Restart the stuck build (still red)");
  assert.equal(open[0].created, 1_000_000); // created preserved across regeneration
  assert.equal(open[0].variant, "decision");
});

// ---------------------------------------------------------------------------
// BET-1419 — the veto-window card (§9.2/§10.3)
// ---------------------------------------------------------------------------

test("upsertVeto: writes a variant=veto card with the countdown dueMs", async () => {
  const h = makeHarness();
  const r = await h.cards.upsertVeto({
    id: "overnight:veto",
    title: "Overnight run planned",
    body: "3 tasks queued for tonight's window.",
    dueMs: 2_000_000,
    options: [{ label: "Cancel tonight", action: { type: "veto-cancel", payload: {} } }],
  });
  assert.equal(r.changed, true);
  assert.equal(r.isNew, true);
  const rows = h.store().cards.filter((c) => c.state === "open");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].variant, "veto");
  assert.equal(rows[0].dueMs, 2_000_000);
  assert.equal(rows[0].sourceKind, "overnight");
  assert.ok(h.ledgerRows.some((row) => row.kind === CARD_CREATED && row.variant === "veto"));
});

test("upsertVeto: re-arming updates in place (never dups), created preserved", async () => {
  const h = makeHarness();
  await h.cards.upsertVeto({ id: "overnight:veto", title: "t1", dueMs: 2_000_000 });
  h.advance(5_000);
  const r2 = await h.cards.upsertVeto({ id: "overnight:veto", title: "t2", dueMs: 3_000_000 });
  assert.equal(r2.isNew, false);
  const open = h.store().cards.filter((c) => c.state === "open");
  assert.equal(open.length, 1, "one open veto card at a time");
  assert.equal(open[0].title, "t2");
  assert.equal(open[0].dueMs, 3_000_000);
  assert.equal(open[0].created, 1_000_000, "created preserved across re-arm");
});

test("upsertVeto: refuses a missing id", async () => {
  const h = makeHarness();
  const r = await h.cards.upsertVeto({ title: "no id" });
  assert.equal(r.changed, false);
  assert.equal(openCardCount(h), 0);
});

// ---------------------------------------------------------------------------
// BET-1395 connect-ask cards (§7.4 / §10.3 connect variant)
// ---------------------------------------------------------------------------

test("upsertConnect: writes a variant=connect card with the three bound answers", async () => {
  const h = makeHarness();
  const r = await h.cards.upsertConnect({
    toolId: "vercel",
    title: "Connect Vercel (read-only)?",
    body: "Vercel showed up 3× across 2 week(s) of agent work",
    evidence: ["transcript: cli:vercel", "secret: VERCEL_TOKEN"],
    refs: ["vercel"],
  });
  assert.equal(r.changed, true);
  assert.equal(r.isNew, true);
  const card = h.store().cards.find((c) => c.variant === "connect");
  assert.ok(card);
  assert.equal(card.sourceKind, "tool");
  assert.equal(card.sourceId, "vercel");
  assert.deepEqual(card.refs, ["vercel"]);
  assert.deepEqual(
    card.options.map((o) => o.answer),
    ["connect", "not-now", "never"],
  );
  for (const o of card.options) {
    assert.equal(o.action.type, "tool-connect");
    // BET-1404: the payload carries the ring the ask was about — the
    // metadata default here, "deep_read" for the deep-read ask's card.
    assert.deepEqual(o.action.payload, { tool: "vercel", answer: o.answer, ring: "metadata" });
  }
  assert.ok(h.ledgerRows.some((row) => row.kind === CARD_CREATED && row.variant === "connect"));
});

test("upsertConnect: the deep_read ask gets its own card id and ring-tagged payloads", async () => {
  const h = makeHarness();
  await h.cards.upsertConnect({ toolId: "vercel", title: "meta", refs: ["vercel"] });
  const r = await h.cards.upsertConnect({
    toolId: "vercel",
    ring: "deep_read",
    title: "deep",
    refs: ["vercel"],
  });
  assert.equal(r.changed, true);
  const deep = h.store().cards.find((c) => c.variant === "connect" && c.title === "deep");
  assert.ok(deep);
  assert.equal(deep.sourceId, "vercel:deep", "a distinct stable id — the metadata card is untouched");
  for (const o of deep.options) {
    assert.deepEqual(o.action.payload, { tool: "vercel", answer: o.answer, ring: "deep_read" });
  }
});

test("upsertConnect: re-raising the same tool upserts in place (no dup)", async () => {
  const h = makeHarness();
  await h.cards.upsertConnect({ toolId: "vercel", title: "first", refs: ["vercel"] });
  h.advance(1000);
  const r = await h.cards.upsertConnect({ toolId: "vercel", title: "second", refs: ["vercel"] });
  assert.equal(r.isNew, false);
  const open = h.store().cards.filter((c) => c.variant === "connect" && c.state === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].title, "second");
});

// BET-1481: the invalid-args early return carries the same { ok:false } shape
// as the other three card writers — a future caller branching on ok (the
// BET-1477 contract) must not read undefined as truthy-success here.
test("upsertConnect: refuses a missing/non-string toolId with ok:false", async () => {
  const h = makeHarness();
  const r = await h.cards.upsertConnect({ title: "no toolId" });
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.equal(r.isNew, false);
  const r2 = await h.cards.upsertConnect({ toolId: 42 });
  assert.equal(r2.ok, false);
  assert.equal(openCardCount(h), 0);
  assert.ok(!h.ledgerRows.some((row) => row.kind === CARD_CREATED && row.variant === "connect"));
});

test("resolveConnectCards: resolves the open card for the tool and writes the ledger row", async () => {
  const h = makeHarness();
  await h.cards.upsertConnect({ toolId: "vercel", title: "t", refs: ["vercel"] });
  await h.cards.upsertConnect({ toolId: "stripe", title: "t2", refs: ["stripe"] });
  const r = await h.cards.resolveConnectCards("vercel", "connect answer: connect");
  assert.equal(r.changed, true);
  const open = h.store().cards.filter((c) => c.state === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].sourceId, "stripe");
  assert.ok(h.ledgerRows.some((row) => row.kind === CARD_RESOLVED && row.sourceId === "vercel"));
  // Resolving an absent tool changes nothing.
  const r2 = await h.cards.resolveConnectCards("ghost", "no-op");
  assert.equal(r2.changed, false);
});

// ---------------------------------------------------------------------------
// BET-1407: the in-flight ask registry is persisted (engine-state.json
// `pendingAsks`) through the SAME patchEngineState seam the pendingBlockers
// writers use, seeded back on start, bounded by the existing blocker
// retention window, and consumed on promotion/resolution.
// ---------------------------------------------------------------------------

test("BET-1407: onAskStart persists the ask into engine-state pendingAsks; re-registration replaces, never duplicates", async () => {
  const h = makeHarness();
  await h.cards.onAskStart({ sourceKind: "question", sourceId: "que_1", sessionID: "s1", body: "Pick one?", ts: h.clock.ms });
  let rows = h.engineStateSnapshot().pendingAsks;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { sourceKind: "question", sourceId: "que_1", sessionID: "s1", body: "Pick one?", askedAt: h.clock.ms });
  // Duplicate registration (global + scoped event) replaces the row — one
  // entry per ask in both registry halves.
  h.advance(1000);
  await h.cards.onAskStart({ sourceKind: "question", sourceId: "que_1", sessionID: "s1", body: "Pick one?", ts: h.clock.ms });
  rows = h.engineStateSnapshot().pendingAsks;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].askedAt, h.clock.ms);
  // Memory and store agree on the same key set.
  assert.equal(h.engineStateSnapshot().pendingAsks.length, 1);
});

test("BET-1407: onInboxBlocker persists its registration under the same idiom (keyed by sessionID or sourceId)", async () => {
  const h = makeHarness({ fireNotify: true });
  await h.cards.onInboxBlocker({ message: "deploy failed", tag: "deploy", sessionID: "s7", ts: h.clock.ms });
  let rows = h.engineStateSnapshot().pendingAsks;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionID, "s7");
  assert.equal(rows[0].sourceKind, "inbox");
  // A sessionless note keys by its stable source id.
  await h.cards.onInboxBlocker({ message: "disk almost full", tag: "disk", ts: h.clock.ms });
  rows = h.engineStateSnapshot().pendingAsks;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].sessionID, undefined);
  assert.ok(rows[1].sourceId);
});

test("BET-1407: promoteDue consumes the promoted ask — removed from the registry and engine-state, no re-promotion", async () => {
  const h = makeHarness();
  const t0 = h.clock.ms;
  await h.cards.onAskStart({ sourceKind: "question", sourceId: "que_1", sessionID: "s1", body: "Pick one?", ts: t0 });
  h.advance(BLOCKER_AFTER_MS + 60_000);
  const r = await h.cards.promoteDue();
  assert.equal(r.promoted, 1);
  assert.equal(openCardCount(h), 1);
  // The registry entry is gone from BOTH halves once the card owns the surface.
  assert.equal(h.engineStateSnapshot().pendingAsks.length, 0);
  // A second tick re-promotes nothing (no card dup, no registry resurrection).
  const r2 = await h.cards.promoteDue();
  assert.equal(r2.promoted, 0);
  assert.equal(r2.changed, false);
  assert.equal(openCardCount(h), 1);
  assert.equal(h.engineStateSnapshot().pendingAsks.length, 0);
});

test("BET-1407: onAskResolved prunes the persisted registry row", async () => {
  const h = makeHarness();
  await h.cards.onAskStart({ sourceKind: "question", sourceId: "que_1", sessionID: "s1", body: "Pick one?", ts: h.clock.ms });
  assert.equal(h.engineStateSnapshot().pendingAsks.length, 1);
  await h.cards.onAskResolved({ sessionID: "s1", ts: h.clock.ms });
  assert.equal(h.engineStateSnapshot().pendingAsks.length, 0);
});

test("BET-1407: seedPendingAsks restores in-flight asks — an ask past the 10-min threshold promotes on the next tick", async () => {
  const h = makeHarness();
  const t0 = h.clock.ms;
  // What a previous boot persisted: one ask that crossed the threshold while
  // the box was down, one young ask.
  h.setPendingAsks([
    { sourceKind: "question", sourceId: "que_old", sessionID: "s_old", body: "Old ask", askedAt: t0 - (BLOCKER_AFTER_MS + 60_000) },
    { sourceKind: "question", sourceId: "que_new", sessionID: "s_new", body: "Young ask", askedAt: t0 - 60_000 },
  ]);
  const seeded = await h.cards.seedPendingAsks();
  assert.equal(seeded.seeded, 2);
  assert.equal(seeded.dropped, 0);
  // The straddled ask promotes — the card is not lost to the restart.
  const r = await h.cards.promoteDue();
  assert.equal(r.promoted, 1);
  const open = h.store().cards.filter((c) => c.variant === "blocker" && c.state === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].sessionID, "s_old");
  // The consumed entry leaves the persisted registry; the young ask remains.
  assert.deepEqual(h.engineStateSnapshot().pendingAsks.map((a) => a.sessionID), ["s_new"]);
});

test("BET-1407: seedPendingAsks drops asks past the existing blocker retention window (INBOX_TTL_MS.blocker) from both halves", async () => {
  const h = makeHarness();
  const t0 = h.clock.ms;
  const cutoff = t0 - INBOX_TTL_MS.blocker;
  h.setPendingAsks([
    { sourceKind: "question", sourceId: "que_rot", sessionID: "s_rot", body: "rotted", askedAt: cutoff - 1 },
    { sourceKind: "question", sourceId: "que_edge", sessionID: "s_edge", body: "at the cutoff is kept", askedAt: cutoff },
    { sourceKind: "question", sourceId: "que_young", sessionID: "s_young", body: "young", askedAt: t0 - 60_000 },
  ]);
  const seeded = await h.cards.seedPendingAsks();
  assert.equal(seeded.seeded, 2);
  assert.equal(seeded.dropped, 1);
  // Dropped from the persisted half too (the file must not accumulate).
  assert.deepEqual(h.engineStateSnapshot().pendingAsks.map((a) => a.sessionID), ["s_edge", "s_young"]);
  // Malformed rows (unkeyable / unageable) are unreconstructable — dropped.
  h.setPendingAsks([
    { sourceKind: "question", sourceId: "que_x", body: "no askedAt" },
    { body: "no key", askedAt: t0 },
  ]);
  const seeded2 = await h.cards.seedPendingAsks();
  assert.equal(seeded2.seeded, 0);
  assert.equal(seeded2.dropped, 2);
  assert.equal(h.engineStateSnapshot().pendingAsks.length, 0);
});

test("BET-1407: seedPendingAsks with no persisted registry is a pure no-op (no engine-state write)", async () => {
  const h = makeHarness();
  const patchesBefore = h.patchCalls.length;
  const seeded = await h.cards.seedPendingAsks();
  assert.deepEqual(seeded, { seeded: 0, dropped: 0 });
  assert.equal(h.patchCalls.length, patchesBefore);
});
