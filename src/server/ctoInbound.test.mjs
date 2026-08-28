// ctoInbound.test.mjs — On-call CTO inbound feed (BET-1165, issue 2/3).
// Pure logic + injected I/O, no live tmux / opencode / multica / push:
//   - inbound routing (live flag off → park; live on → inject; dedupe via seenId)
//   - watch registry CRUD (engine confirm-gated, cto.json atomic store round-trip)
//   - gate: confirm → allow via trustedActions; untrusted → needConfirmation;
//     text-loop approve / reject re-dispatch
//   - pure helpers (seenId / preview)
//
// The old watcher poller tests were removed in BET-1398 — the poller is
// superseded by the event-driven standing-query engine (ctoWatchers.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCtoInbound,
  createCtoEngine,
  loadCtoStore,
  saveCtoStore,
  computeConfirmId,
  buildPreview,
  stableHash,
} from "./cto.mjs";

// ---------------------------------------------------------------------------
// Inbound routing + dedupe (BET-1397: parked notes persist to the inbox store;
// only a `blocker` kind enters the A8 card path via registerBlocker)
// ---------------------------------------------------------------------------

function memInbox() {
  const state = { v: 1, entries: [] };
  return {
    load: async () => state,
    save: async (s) => {
      state.entries = s?.entries ?? [];
    },
    entries: () => state.entries,
  };
}

test("inbound parks a bare {message} as a blocker: persisted to the inbox + routed to the blocker card (one path)", async () => {
  const inbox = memInbox();
  const blockers = [];
  const inbound = createCtoInbound({
    loadInbox: inbox.load,
    saveInbox: inbox.save,
    registerBlocker: async (e) => blockers.push(e),
  });
  const res = await inbound.inbound({ surface: "session", payload: { message: "hey", sessionID: "ses-1" } });
  assert.equal(res.ok, true);
  assert.equal(res.parked, true);
  assert.equal(res.kind, "blocker"); // bare {message} → blocker default
  assert.equal(inbox.entries().length, 1);
  assert.equal(inbox.entries()[0].kind, "blocker");
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].message, "hey");
});

test("inbound persists a non-blocker kind silently (no card, no notify)", async () => {
  const inbox = memInbox();
  let blockers = 0;
  const inbound = createCtoInbound({
    loadInbox: inbox.load,
    saveInbox: inbox.save,
    registerBlocker: async () => {
      blockers += 1;
    },
  });
  const res = await inbound.inbound({ surface: "session", payload: { kind: "fyi", message: "heads up" } });
  assert.equal(res.parked, true);
  assert.equal(res.kind, "fyi");
  assert.equal(inbox.entries().length, 1);
  assert.equal(inbox.entries()[0].kind, "fyi");
  assert.equal(blockers, 0);
});

test("inbound dedupes a re-delivered event with an already-seen seenId; no-seenId never swallows", async () => {
  const inbox = memInbox();
  const inbound = createCtoInbound({
    loadInbox: inbox.load,
    saveInbox: inbox.save,
  });
  await inbound.inbound({ surface: "session", payload: { message: "a" }, seenId: "evt-1" });
  const second = await inbound.inbound({ surface: "session", payload: { message: "b" }, seenId: "evt-1" });
  assert.equal(second.deduped, true);
  assert.equal(inbox.entries().length, 1); // only the first persisted
  await inbound.inbound({ surface: "session", payload: { message: "c" } });
  assert.equal(inbox.entries().length, 2);
});

test("inbound coalesces notes sharing a tag into one entry (refs union, count bumped)", async () => {
  const inbox = memInbox();
  const inbound = createCtoInbound({
    loadInbox: inbox.load,
    saveInbox: inbox.save,
  });
  await inbound.inbound({
    surface: "session",
    payload: { kind: "finding", message: "deploy flaky", tag: "deploy", refs: ["BET-1"], sessionID: "s1" },
  });
  const res = await inbound.inbound({
    surface: "session",
    payload: { kind: "finding", message: "deploy flaky again", tag: "deploy", refs: ["BET-2", "BET-1"], sessionID: "s2" },
  });
  assert.equal(res.coalesced, true);
  const entries = inbox.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 2);
  assert.deepEqual(entries[0].refs, ["BET-1", "BET-2"]);
});

test("inbound live route injects into the CTO session when the flag is on (stub seam)", async () => {
  const sent = [];
  const inbound = createCtoInbound({
    isCallActive: () => true,
    ctoSessionID: "cto-ses",
    sendPrompt: async (a) => sent.push(a),
  });
  const res = await inbound.inbound({ surface: "session", payload: { message: "live" } });
  assert.equal(res.live, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, "cto-ses");
  assert.equal(sent[0].text, "live");
});

test("inbound with no message and no live call writes nothing but resolves ok", async () => {
  const inbox = memInbox();
  const inbound = createCtoInbound({ loadInbox: inbox.load, saveInbox: inbox.save });
  const res = await inbound.inbound({ surface: "multica", payload: {} });
  assert.equal(res.ok, true);
  assert.equal(res.parked, true);
  assert.equal(res.dropped, true);
  assert.equal(inbox.entries().length, 0);
});

test("normalizeInboxKind maps unknown/bare to blocker; coalesceInboxEntry unions refs + bumps count", async () => {
  const { normalizeInboxKind, coalesceInboxEntry } = await import("./cto.mjs");
  assert.equal(normalizeInboxKind("finding"), "finding");
  assert.equal(normalizeInboxKind("blocker"), "blocker");
  assert.equal(normalizeInboxKind(undefined), "blocker");
  assert.equal(normalizeInboxKind("weird"), "blocker");
  const merged = coalesceInboxEntry(
    { refs: ["a"], count: 1, message: "x", read: true },
    { refs: ["b", "a"], message: "y" },
    100,
  );
  assert.deepEqual(merged.refs, ["a", "b"]);
  assert.equal(merged.count, 2);
  assert.equal(merged.ts, 100);
  assert.equal(merged.read, false);
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

test("read_inbox returns the inbox (filterable) without marking read or writing", async () => {
  const state = {
    v: 1,
    entries: [
      { id: "a", kind: "fyi", message: "heads up", tag: null, read: false, ts: 1, count: 1, expires: 500 },
      { id: "b", kind: "blocker", message: "stop", tag: "t", read: true, ts: 2, count: 1, expires: 500 },
      { id: "c", kind: "fyi", message: "expired", read: false, ts: 0, count: 1, expires: 10 },
    ],
  };
  const engine = makeEngine({
    loadInbox: async () => state,
    now: () => 100,
  });
  const all = await engine.dispatch("read_inbox", {});
  assert.equal(all.ok, true);
  // The expired note (expires 10 < now 100) is absent from the view.
  assert.deepEqual(all.data.entries.map((e) => e.id).sort(), ["a", "b"]);
  // Filter by kind.
  const fyi = await engine.dispatch("read_inbox", { kind: "fyi" });
  assert.deepEqual(fyi.data.entries.map((e) => e.id), ["a"]);
  // Filter by read state.
  const unread = await engine.dispatch("read_inbox", { read: false });
  assert.deepEqual(unread.data.entries.map((e) => e.id), ["a"]);
  // READ-ONLY: the store was not written (entries untouched, ids keep read=false).
  assert.equal(state.entries.find((e) => e.id === "a").read, false);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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
