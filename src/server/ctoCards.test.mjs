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

// A fully-injected card harness: real in-memory card store, engine-state,
// ledger and a clock we control. No real fs — pure behavior.
function makeHarness({ pendingBlockers = [] } = {}) {
  const clock = { ms: 1_000_000 };
  let cardPayload = { v: 1, cards: [] };
  const ledgerRows = [];
  let engineState = { v: 1, pendingBlockers: [...pendingBlockers] };

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
    now: () => clock.ms,
  });

  return {
    cards,
    clock,
    ledgerRows,
    store: () => cardPayload,
    setCardPayload(p) {
      cardPayload = p;
    },
    setPendingBlockers(b) {
      engineState = { v: 1, pendingBlockers: b };
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

  // Resolved health cards are ignored (never re-created).
  h.setPendingBlockers([{ id: "b1", resolved: true }]);
  await h.cards.ingestHealthEscalations();
  assert.equal(h.store().cards.filter((c) => c.state === "open").length, 1);

  // Recovery (engine resumed) resolves the health card.
  await h.cards.onHealthRecovered();
  assert.equal(h.store().cards.filter((c) => c.state === "open").length, 0);
  assert.equal(h.ledgerRows.filter((r) => r.kind === CARD_RESOLVED).length, 1);
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
  const clock = { ms: 1_000_000 };
  let cardPayload = { v: 1, cards: [] };
  const ledgerRows = [];
  const notified = [];
  const cards = createCtoCards({
    cardStore: {
      load: async () => cardPayload,
      save: async (p) => {
        cardPayload = p;
      },
    },
    engineState: { load: async () => ({ v: 1 }), save: async () => {} },
    ledger: { append: async (row) => ledgerRows.push(row) },
    fireNotify: async (a) => notified.push(a),
    now: () => clock.ms,
  });

  const r = await cards.onInboxBlocker({
    message: "build is red",
    title: "CI broken",
    refs: ["BET-777"],
    tag: "ci",
    sessionID: "ses-9",
    ts: clock.ms,
  });
  assert.equal(r.notified, true);
  // Exactly ONE notification, blocking tier, via the shared router.
  assert.equal(notified.length, 1);
  assert.equal(notified[0].message, "build is red");
  assert.equal(notified[0].title, "CI broken");
  assert.equal(notified[0].urgent, true);
  assert.equal(notified[0].sessionID, "ses-9");

  // The inbox blocker becomes a card at > 10 min like any ask.
  clock.ms += BLOCKER_AFTER_MS;
  const p = await cards.promoteDue();
  assert.equal(p.changed, true);
  const open = cardPayload.cards.filter((c) => c.state === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].sourceKind, "inbox");
  assert.deepEqual(open[0].refs, ["BET-777"]);
});

test("upsertDecision: writes a decision card, and regenerating the same id upserts (no duplicate)", async () => {
  const clock = { ms: 1_000_000 };
  let cardPayload = { v: 1, cards: [] };
  const ledgerRows = [];
  const cards = createCtoCards({
    cardStore: {
      load: async () => cardPayload,
      save: async (p) => {
        cardPayload = p;
      },
    },
    engineState: { load: async () => ({ v: 1 }), save: async () => {} },
    ledger: { append: async (row) => ledgerRows.push(row) },
    now: () => clock.ms,
  });

  const first = await cards.upsertDecision({
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
  assert.equal(openCardCount({ store: () => cardPayload }), 1);

  // regeneration with the same stable id — updates in place, no second card
  clock.ms += 1000;
  const regen = await cards.upsertDecision({
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
  assert.equal(openCardCount({ store: () => cardPayload }), 1);
  const open = cardPayload.cards.filter((c) => c.state === "open");
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
    assert.deepEqual(o.action.payload, { tool: "vercel", answer: o.answer });
  }
  assert.ok(h.ledgerRows.some((row) => row.kind === CARD_CREATED && row.variant === "connect"));
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
