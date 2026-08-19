// ctoInbound.test.mjs — On-call CTO inbound feed (BET-1165, issue 2/3).
// Pure logic + injected I/O, no live tmux / opencode / multica / push:
//   - inbound routing (live flag off → park; live on → inject; dedupe via seenId)
//   - watcher tick with injected reads (fires on new + matching, no re-fire)
//   - watch registry CRUD (engine confirm-gated, cto.json atomic store round-trip)
//   - gate: confirm → allow via trustedActions; untrusted → needConfirmation;
//     text-loop approve / reject re-dispatch
//   - pure helpers (conditionKeywords / defaultConditionMatches / seenId / preview)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCtoInbound,
  createWatcherPoller,
  createCtoEngine,
  loadCtoStore,
  saveCtoStore,
  conditionKeywords,
  defaultConditionMatches,
  defaultComputeSurfaceSeenId,
  computeConfirmId,
  buildPreview,
  stableHash,
} from "./cto.mjs";

// ---------------------------------------------------------------------------
// Inbound routing + dedupe
// ---------------------------------------------------------------------------

test("inbound parks when the call flag is off and surfaces via fireNotify", async () => {
  const notified = [];
  const inbound = createCtoInbound({ fireNotify: async (a) => notified.push(a) });
  const res = await inbound.inbound({ surface: "session", payload: { message: "hey", urgent: true } });
  assert.equal(res.ok, true);
  assert.equal(res.parked, true);
  assert.equal(res.live, undefined);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].message, "hey");
  assert.equal(notified[0].urgent, true);
});

test("inbound drops a re-delivered event with an already-seen seenId (dedupe)", async () => {
  const notified = [];
  const inbound = createCtoInbound({ fireNotify: async (a) => notified.push(a) });
  await inbound.inbound({ surface: "session", payload: { message: "a" }, seenId: "evt-1" });
  const second = await inbound.inbound({ surface: "session", payload: { message: "b" }, seenId: "evt-1" });
  assert.equal(second.deduped, true);
  assert.equal(notified.length, 1); // only the first surfaced
  // An event with no seenId is never swallowed.
  await inbound.inbound({ surface: "session", payload: { message: "c" } });
  assert.equal(notified.length, 2);
});

test("inbound live route injects into the CTO session when the flag is on (stub seam)", async () => {
  const sent = [];
  const inbound = createCtoInbound({
    isCallActive: () => true,
    ctoSessionID: "cto-ses",
    sendPrompt: async (a) => sent.push(a),
    fireNotify: async () => {},
  });
  const res = await inbound.inbound({ surface: "session", payload: { message: "live" } });
  assert.equal(res.live, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, "cto-ses");
  assert.equal(sent[0].text, "live");
});

test("inbound with no message and no live call surfaces nothing but resolves ok", async () => {
  const notified = [];
  const inbound = createCtoInbound({ fireNotify: async (a) => notified.push(a) });
  const res = await inbound.inbound({ surface: "multica", payload: {} });
  assert.equal(res.ok, true);
  assert.equal(res.parked, true);
  assert.equal(notified.length, 0);
});

// ---------------------------------------------------------------------------
// Gate: confirm → allow via trustedActions; text-loop approve / reject
// ---------------------------------------------------------------------------

function makeEngine(overrides = {}) {
  return createCtoEngine({
    listProjects: async () => [],
    listSessions: async () => [],
    listMessages: async () => [],
    listModels: async () => [],
    getSessionAgent: async () => null,
    listSnapshots: () => [],
    listStopped: async () => ({ records: [], lastLooked: null }),
    searchMessages: async () => ({ supported: true, hits: [] }),
    configGet: async () => ({}),
    gitStatus: async () => "",
    gitBranch: async () => null,
    gitLog: async () => "",
    queryMultica: async () => ({ ok: true }),
    ...overrides,
  });
}

// Gate that reports confirm only for `watch` (the confirm-mode tool).
const gate = (name) => (name === "watch" ? "confirm" : "allow");

test("untrusted confirm-mode tool returns needConfirmation + preview and does NOT act", async () => {
  const watchers = [];
  const engine = makeEngine({
    loadWatches: async () => watchers,
    saveWatches: async (w) => {
      watchers.splice(0, watchers.length, ...w);
    },
  });
  const res = await engine.dispatch("watch", { surface: "multica", query: "q", condition: "a P0 opens" }, { gate });
  assert.equal(res.ok, true);
  assert.equal(res.needConfirmation, true);
  assert.equal(res.tool, "watch");
  assert.equal(typeof res.id, "string");
  assert.ok(res.preview.length > 0);
  assert.equal(watchers.length, 0); // NOT registered yet
});

test("a trusted action in trustedActions runs without confirmation", async () => {
  const watchers = [];
  const engine = makeEngine({
    loadWatches: async () => watchers,
    saveWatches: async (w) => {
      watchers.splice(0, watchers.length, ...w);
    },
  });
  const res = await engine.dispatch(
    "watch",
    { surface: "multica", query: "q", condition: "a P0 opens" },
    { gate, trustedActions: ["watch"] },
  );
  assert.equal(res.ok, true);
  assert.equal(res.needConfirmation, undefined);
  assert.equal(watchers.length, 1);
  assert.equal(watchers[0].surface, "multica");
});

test("text loop: approveConfirm(id) then re-dispatch of the same tool+args runs it", async () => {
  const watchers = [];
  const engine = makeEngine({
    loadWatches: async () => watchers,
    saveWatches: async (w) => {
      watchers.splice(0, watchers.length, ...w);
    },
  });
  const args = { surface: "multica", query: "q", condition: "a P0 opens" };
  const first = await engine.dispatch("watch", args, { gate });
  assert.equal(first.needConfirmation, true);
  assert.equal(watchers.length, 0);
  // user says "go ahead"
  assert.equal(engine.approveConfirm(first.id), true);
  const second = await engine.dispatch("watch", args, { gate });
  assert.equal(second.needConfirmation, undefined);
  assert.equal(watchers.length, 1);
});

test("text loop: rejectConfirm(id) aborts and the tool stays blocked until approved again", async () => {
  const watchers = [];
  const engine = makeEngine({
    loadWatches: async () => watchers,
    saveWatches: async (w) => {
      watchers.splice(0, watchers.length, ...w);
    },
  });
  const args = { surface: "multica", query: "q", condition: "a P0 opens" };
  const first = await engine.dispatch("watch", args, { gate });
  // user says "no"
  assert.equal(engine.rejectConfirm(first.id), true);
  const second = await engine.dispatch("watch", args, { gate });
  assert.equal(second.needConfirmation, true); // still blocked
  assert.equal(watchers.length, 0);
});

// ---------------------------------------------------------------------------
// Watch registry CRUD (engine + cto.json atomic store round-trip)
// ---------------------------------------------------------------------------

test("watch registry CRUD through the engine (watch / list_watches / unwatch)", async () => {
  const watchers = [];
  const engine = makeEngine({
    loadWatches: async () => watchers,
    saveWatches: async (w) => {
      watchers.splice(0, watchers.length, ...w);
    },
  });
  const gated = { gate, trustedActions: ["watch"] };
  const added = await engine.dispatch("watch", { surface: "multica", query: "q", condition: "a P0 opens" }, gated);
  assert.equal(added.ok, true);
  const id = added.data.watch.id;
  assert.equal(watchers.length, 1);
  assert.equal(watchers[0].active, true);
  assert.equal(watchers[0].lastFiredAt, null);

  const list = await engine.dispatch("list_watches", {});
  assert.equal(list.data.watches.length, 1);

  const removed = await engine.dispatch("unwatch", { id }, {});
  assert.equal(removed.data.removed, true);
  assert.equal(watchers.length, 0);
});

test("cto.json store load/save round-trips watches atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cto-store-"));
  const path = join(dir, "cto.json");
  const init = loadCtoStore(path);
  assert.deepEqual(init.watches, []);
  const store = loadCtoStore(path);
  store.watches = [
    { id: "w1", surface: "multica", query: "q", condition: "a P0 opens", active: true, lastFiredAt: null, createdAt: 1 },
  ];
  await saveCtoStore(store, path);
  const reloaded = loadCtoStore(path);
  assert.equal(reloaded.watches.length, 1);
  assert.equal(reloaded.watches[0].surface, "multica");
});

// ---------------------------------------------------------------------------
// Watcher poller with injected reads
// ---------------------------------------------------------------------------

test("watcher tick fires inbound when condition matches and seenId is new; no re-fire on the same read", async () => {
  const readOnce = { ok: true, data: { issues: [{ identifier: "BET-1", status: "critical", title: "P0 outage" }] } };
  const fired = [];
  const poller = createWatcherPoller({
    loadWatches: async () => [
      { id: "w1", surface: "multica", query: "q", condition: "a P0 opens", active: true, lastFiredAt: null },
    ],
    saveWatches: async () => {},
    readSurface: async () => readOnce,
    sendToInbound: async (input) => fired.push(input),
  });
  await poller.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].surface, "multica");
  assert.equal(typeof fired[0].seenId, "string");
  assert.ok(fired[0].payload.message.includes("P0"), "message carries the matching snippet");
  // Same (unchanged) read on the next tick → seenId unchanged → no re-fire.
  await poller.tick();
  assert.equal(fired.length, 1);
});

test("watcher tick respects an inactive/disabled watch", async () => {
  const fired = [];
  const poller = createWatcherPoller({
    loadWatches: async () => [
      { id: "w1", surface: "multica", query: "q", condition: "a P0 opens", active: false, lastFiredAt: null },
    ],
    saveWatches: async () => {},
    readSurface: async () => ({ ok: true, data: { issues: [{ identifier: "BET-1", status: "critical", title: "P0 outage" }] } }),
    sendToInbound: async (input) => fired.push(input),
  });
  await poller.tick();
  assert.equal(fired.length, 0);
});

test("watcher tick does not fire when the condition does not match", async () => {
  const fired = [];
  // read has no P0 and no keyword from the condition ("P0")
  const poller = createWatcherPoller({
    loadWatches: async () => [
      { id: "w1", surface: "multica", query: "q", condition: "a P0 opens", active: true, lastFiredAt: null },
    ],
    saveWatches: async () => {},
    readSurface: async () => ({ ok: true, data: { issues: [{ identifier: "BET-2", status: "todo", title: "chore" }] } }),
    sendToInbound: async (input) => fired.push(input),
  });
  await poller.tick();
  assert.equal(fired.length, 0);
});

test("watcher tick survives a failed surface read (skips the watch, keeps going)", async () => {
  const fired = [];
  let calls = 0;
  const poller = createWatcherPoller({
    loadWatches: async () => [
      { id: "w1", surface: "multica", query: "q", condition: "a P0 opens", active: true, lastFiredAt: null },
      { id: "w2", surface: "multica", query: "q2", condition: "a P0 opens", active: true, lastFiredAt: null },
    ],
    saveWatches: async () => {},
    readSurface: async () => {
      calls += 1;
      if (calls === 1) throw new Error("surface down");
      return { ok: true, data: { issues: [{ identifier: "BET-1", status: "critical", title: "P0 outage" }] } };
    },
    sendToInbound: async (input) => fired.push(input),
  });
  await poller.tick();
  // w1's read threw (skipped, no throw out of the tick); w2's read succeeded.
  assert.equal(fired.length, 1);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("conditionKeywords strips stopwords and normalizes case", () => {
  assert.deepEqual(conditionKeywords("a P0 opens"), ["p0"]);
  assert.deepEqual(conditionKeywords("deploy failed"), ["deploy", "failed"]);
  assert.deepEqual(conditionKeywords(""), []);
});

test("defaultConditionMatches is a keyword hit (case-insensitive) or true on empty condition", () => {
  const read = { data: { issues: [{ identifier: "BET-1", title: "P0 Outage" }] } };
  assert.equal(defaultConditionMatches("a P0 opens", read), true);
  assert.equal(defaultConditionMatches("deploy failed", read), false);
  assert.equal(defaultConditionMatches("", read), true);
});

test("defaultComputeSurfaceSeenId is stable for identical reads, differs for changed ones", () => {
  const readA = { data: { issues: [{ identifier: "BET-1" }] } };
  const readB = { data: { issues: [{ identifier: "BET-1" }, { identifier: "BET-2" }] } };
  assert.equal(defaultComputeSurfaceSeenId(readA), defaultComputeSurfaceSeenId(readA));
  assert.notEqual(defaultComputeSurfaceSeenId(readA), defaultComputeSurfaceSeenId(readB));
  // An explicit seenId on the read always wins.
  assert.equal(defaultComputeSurfaceSeenId({ seenId: "abc" }), "abc");
});

test("computeConfirmId is deterministic per (tool, args) and buildPreview summarizes", () => {
  assert.equal(computeConfirmId("watch", { surface: "multica" }), computeConfirmId("watch", { surface: "multica" }));
  assert.notEqual(computeConfirmId("watch", { surface: "multica" }), computeConfirmId("watch", { surface: "delegate" }));
  const preview = buildPreview({ name: "watch", description: "Register a watcher\nover two lines" }, { surface: "multica", condition: "a P0 opens" });
  assert.ok(preview.includes("watch"));
  assert.ok(preview.includes("surface=multica"));
  assert.ok(preview.length > 0);
});

test("stableHash is a short stable hash", () => {
  assert.equal(stableHash("x"), stableHash("x"));
  assert.ok(stableHash("x").length >= 1);
  assert.notEqual(stableHash("x"), stableHash("y"));
});
