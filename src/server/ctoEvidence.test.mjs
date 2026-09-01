// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";
import { makeMemoryStores } from "./ctoTestStores.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLastSeen,
  presenceState,
  isPipelineSession,
  normalizeEvidence,
  heavyWorkAllowed,
  PRESENT_PROOF_MS,
} from "./ctoEvidence.mjs";
import { createCtoEngine } from "./ctoEngine.mjs";

// A tiny engine harness for the ingestion-level tests (dedupe, cto-exclusion).
// Fully injected: no fs, no real stores (the in-memory `stores` bundle covers
// every store the engine's defaults bind), a fake clock, resolved owner/project.
function makeHarness({ owner = "user", project = "proj" } = {}) {
  const ledgerRows = [];
  const clock = { ms: 1_000_000 };
  const stores = makeMemoryStores();
  stores.ledger.append = async (r) => ledgerRows.push(r);
  const engine = createCtoEngine({
    stores,
    killSwitch: { isPaused: async () => false, pause: async () => {}, resume: async () => {} },
    publish: () => {},
    now: () => clock.ms,
    getSessionInfo: async () => ({ owner, project }),
    getDesktopPresence: () => ({ lastSeen: 0, idleSeconds: 0, lockedSeconds: null, awayAt: Infinity }),
    getLastDesktopHeartbeat: () => 0,
  });
  return { engine, ledgerRows, clock };
}

const flush = () => new Promise((r) => setImmediate(r));

const T = 1_000_000;

// ----- computeLastSeen -----

test("computeLastSeen returns the max of the three signals", () => {
  const r = computeLastSeen({
    desktopHeartbeatTs: 100,
    appOpenTs: 300,
    promptTs: 200,
  });
  assert.equal(r, 300);
});

test("computeLastSeen ignores absent / invalid signals and returns 0 when none", () => {
  assert.equal(computeLastSeen({ desktopHeartbeatTs: undefined, appOpenTs: 0, promptTs: null }), 0);
  assert.equal(computeLastSeen({ desktopHeartbeatTs: NaN, appOpenTs: "x", promptTs: -5 }), 0);
  assert.equal(computeLastSeen({}), 0);
  assert.equal(computeLastSeen(), 0);
});

// ----- presenceState (incl. unknown transitions) -----

test("presenceState: desktop-present when heartbeated, within TTL, before awayAt", () => {
  assert.equal(presenceState({ heartbeats: { lastSeen: T, awayAt: T + 600_000 }, lastSeen: T, now: T }), "present");
});

test("presenceState: away when heartbeated but past awayAt (within TTL)", () => {
  assert.equal(presenceState({ heartbeats: { lastSeen: T - 60_000, awayAt: T }, lastSeen: T, now: T }), "away");
});

test("presenceState: gone when the heartbeat lapsed the TTL", () => {
  assert.equal(presenceState({ heartbeats: { lastSeen: T - 120_000, awayAt: T - 120_000 + 600_000 }, lastSeen: T - 120_000, now: T }), "gone");
});

test("presenceState: unknown when never heartbeated and no recent activity", () => {
  assert.equal(presenceState({ heartbeats: false, lastSeen: 0, now: T }), "unknown");
  assert.equal(presenceState({ heartbeats: null, lastSeen: null, now: T }), "unknown");
  assert.equal(presenceState({ heartbeats: {}, lastSeen: T - (PRESENT_PROOF_MS + 1), now: T }), "unknown");
});

test("presenceState: recently proven present without a heartbeat (app-open/prompt)", () => {
  assert.equal(presenceState({ heartbeats: false, lastSeen: T, now: T }), "present");
  assert.equal(presenceState({ heartbeats: false, lastSeen: T - (PRESENT_PROOF_MS - 1), now: T }), "present");
});

test("presenceState: bare boolean true (has heartbeated) uses lastSeen", () => {
  assert.equal(presenceState({ heartbeats: true, lastSeen: T, now: T }), "present");
  assert.equal(presenceState({ heartbeats: true, lastSeen: T - 120_000, now: T }), "gone");
});

// ----- heavyWorkAllowed (unknown treated as present — §3.4 rule 3) -----

test("heavyWorkAllowed: only away/gone allow heavy work; present/unknown do not", () => {
  assert.equal(heavyWorkAllowed("away"), true);
  assert.equal(heavyWorkAllowed("gone"), true);
  assert.equal(heavyWorkAllowed("present"), false);
  assert.equal(heavyWorkAllowed("unknown"), false);
});

// ----- isPipelineSession -----

test("isPipelineSession: only user and job produce evidence", () => {
  assert.equal(isPipelineSession("user"), true);
  assert.equal(isPipelineSession("job"), true);
  assert.equal(isPipelineSession("cto"), false);
  assert.equal(isPipelineSession(null), false);
  assert.equal(isPipelineSession(undefined), false);
  assert.equal(isPipelineSession(""), false);
  assert.equal(isPipelineSession("watcher"), false);
});

// ----- normalizeEvidence -----

test("normalizeEvidence folds a user prompt into a none-salience evidence row", () => {
  const row = normalizeEvidence(
    { type: "message.part.updated", properties: { sessionID: "s1", message: { role: "user" } } },
    { owner: "user", project: "proj", now: T },
  );
  assert.deepEqual(row, {
    ts: T,
    sessionID: "s1",
    project: "proj",
    kind: "prompt",
    salience: "none",
    refs: ["s1"],
  });
});

test("normalizeEvidence marks error/permission/question high-salience", () => {
  const err = normalizeEvidence({ type: "session.error", properties: { sessionID: "s1" } }, { now: T });
  assert.equal(err.kind, "error");
  assert.equal(err.salience, "high");
  const perm = normalizeEvidence({ type: "permission.asked", properties: { sessionID: "s1" } }, { now: T });
  assert.equal(perm.kind, "permission");
  assert.equal(perm.salience, "high");
  const q = normalizeEvidence({ type: "question.asked", properties: { sessionID: "s1" } }, { now: T });
  assert.equal(q.kind, "question");
  assert.equal(q.salience, "high");
});

test("normalizeEvidence drops cto-owned sessions at ingestion", () => {
  const row = normalizeEvidence(
    { type: "session.error", properties: { sessionID: "cto-1" } },
    { owner: "cto", now: T },
  );
  assert.equal(row, null);
});

test("normalizeEvidence returns null for unclassifiable noise", () => {
  assert.equal(normalizeEvidence({ type: "config.updated" }, { now: T }), null);
  assert.equal(normalizeEvidence({ type: "session.next.agent.switched", properties: { sessionID: "s1" } }, { now: T }), null);
  assert.equal(normalizeEvidence(null, { now: T }), null);
});

test("normalizeEvidence uses default owner user when absent", () => {
  const row = normalizeEvidence({ type: "session.idle", properties: { sessionID: "s1" } }, { now: T });
  assert.equal(row.kind, "turn.done");
  assert.equal(row.sessionID, "s1");
  assert.equal(row.salience, "none");
});

// ----- Engine-level: dedupe + cto exclusion across bus deliveries -----

test("observeEvent dedupes a globally+scoped duplicate into one ledger row", async () => {
  const h = makeHarness();
  const evt = { id: "evt-1", type: "session.created", properties: { sessionID: "s1" } };
  h.engine.observeEvent(evt);
  h.engine.observeEvent(evt);
  await flush();
  assert.equal(h.ledgerRows.length, 1);
  const row = h.ledgerRows[0];
  assert.equal(row.channel, "event");
  assert.equal(row.kind, "session.created");
  assert.equal(row.sessionID, "s1");
  assert.equal(row.project, "proj");
  assert.deepEqual(row.refs, ["s1"]);
});

test("observeEvent drops cto-owned sessions (no self-observation)", async () => {
  const h = makeHarness({ owner: "cto" });
  h.engine.observeEvent({ id: "evt-2", type: "session.error", properties: { sessionID: "cto-1" } });
  await flush();
  assert.equal(h.ledgerRows.length, 0);
});

test("getPresence exposes state/lastSeen/absenceDelta from live desktop + prompt signals", async () => {
  const h = makeHarness();
  // No desktop heartbeat, no prompts → unknown, absenceDelta = now (0 lastSeen).
  assert.equal(h.engine.getPresence().state, "unknown");
  assert.equal(h.engine.getPresence().lastSeen, 0);
  // A user prompt lands → proves present within the proof window.
  h.engine.observeEvent({ type: "user.message.created", properties: { sessionID: "s1" } });
  await flush();
  const p = h.engine.getPresence();
  assert.equal(p.state, "present");
  assert.equal(p.lastSeen, 1_000_000);
  assert.equal(p.absenceDelta, 0);
});
