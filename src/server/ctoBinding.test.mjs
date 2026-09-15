// BET-P3a1: src/server/ctoBinding.test.mjs — the durable singleton CTO
// conversation binding (unified-cto-spec §3.1). Pure logic + injected
// stores/oc; the composition tests drive the REAL opencode.mjs client through
// `_setOcTransport` to prove the additive metadata option reaches the wire
// and reads back. No live opencode, no network, no model calls.

import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  BINDING_ROLE,
  CONTROL_MARKER_FILENAME,
  CtoBindingError,
  PREVIOUS_SESSION_IDS_CAP,
  RECONCILE_ATTEMPTS,
  ROLE_SESSION_TITLE,
  capPrevious,
  createCtoBinding,
  defaultControlDir,
  isMarkerSession,
  markerFor,
  normalizeBinding,
} from "./ctoBinding.mjs";
import { bindingStore } from "./ctoStores.mjs";
import { CTO_TITLE_PREFIX, selectReapCandidates } from "./ctoSessions.mjs";
import * as ocModule from "./opencode.mjs";
import { statePath } from "../shared/paths.mjs";

const noopSleep = async () => {};

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function memoryStore(name, initial = { v: 1 }) {
  let payload = initial;
  return {
    name,
    path: `${name}-${randomUUID()}.json`,
    async load() {
      return payload;
    },
    async save(next) {
      payload = next;
    },
  };
}

/**
 * In-memory oc double implementing exactly the surface the binding service
 * is allowed to touch. `sendPrompt` is a tripwire: ensure/recover/getBinding
 * must never invoke the model.
 */
function fakeOc({ failCreates = 0, listError, sessions = [], readStates = {} } = {}) {
  const created = [];
  let seq = 0;
  const oc = {
    created,
    createCalls: 0,
    listCalls: 0,
    readCalls: 0,
    sendPromptCalls: 0,
    failCreatesRemaining: failCreates,
    readStates,
    async sendPrompt() {
      oc.sendPromptCalls++;
      throw new Error("binding service must never call sendPrompt");
    },
    async createSession({ directory, title, metadata }) {
      oc.createCalls++;
      if (oc.failCreatesRemaining > 0) {
        oc.failCreatesRemaining--;
        throw new Error("simulated create failure");
      }
      const session = {
        id: `ses_fake${++seq}`,
        title,
        directory,
        projectID: "global",
        time: { created: Date.now(), updated: Date.now() },
        metadata: structuredClone(metadata ?? null),
      };
      created.push(session);
      return structuredClone(session);
    },
    async listSessions() {
      oc.listCalls++;
      if (listError) throw listError;
      return structuredClone([...sessions, ...created]);
    },
    async readSession(id) {
      oc.readCalls++;
      const override = readStates[id];
      if (override !== undefined) {
        return typeof override === "function" ? override(oc.readCalls) : override;
      }
      const session = [...sessions, ...created].find((s) => s.id === id);
      return session ? { state: "found", session: structuredClone(session) } : { state: "missing" };
    },
  };
  return oc;
}

function tempControlDir(label) {
  return statePath("cto-binding-test", label, "conversation");
}

function makeService({ oc, store = memoryStore("binding"), controlDir = tempControlDir(randomUUID()), ...rest } = {}) {
  return createCtoBinding({ oc, store, controlDir, sleep: noopSleep, ...rest });
}

const EMPTY_BINDING = {
  v: 1,
  generation: 0,
  currentSessionId: null,
  currentOperation: null,
  previousSessionIds: [],
  pendingOperation: null,
};

// ---------------------------------------------------------------------------
// ensure — create once, bind, stamp the exact marker
// ---------------------------------------------------------------------------

test("ensure creates exactly one role session, binds generation 1, and stamps the exact identity marker", async () => {
  const controlDir = tempControlDir(randomUUID());
  const oc = fakeOc();
  const svc = makeService({ oc, controlDir });
  const first = await svc.ensure();

  assert.equal(oc.createCalls, 1);
  assert.equal(first.created, true);
  assert.equal(first.binding.generation, 1);
  assert.equal(first.binding.currentSessionId, oc.created[0].id);
  assert.ok(first.binding.currentOperation);
  assert.equal(first.binding.pendingOperation, null);

  // The marker receipt: the session record carries the exact marker.
  const session = oc.created[0];
  assert.equal(session.title, ROLE_SESSION_TITLE);
  assert.equal(session.directory, controlDir);
  assert.equal(session.metadata.role, BINDING_ROLE);
  assert.equal(session.metadata.bindingOperation, first.binding.currentOperation);
  assert.equal(session.metadata.bindingGeneration, 1);

  // Second ensure: same binding, no second creation.
  const second = await svc.ensure();
  assert.equal(second.created, false);
  assert.equal(oc.createCalls, 1);
  assert.deepEqual(second.binding, first.binding);
});

test("ensure never invokes the model, and getBinding is a pure store read (zero oc calls)", async () => {
  const oc = fakeOc();
  const svc = makeService({ oc });
  await svc.ensure();
  assert.equal(oc.sendPromptCalls, 0);

  const callsBefore = oc.createCalls + oc.listCalls + oc.readCalls;
  const binding = await svc.getBinding();
  assert.equal(binding.currentSessionId, oc.created[0].id);
  assert.equal(oc.createCalls + oc.listCalls + oc.readCalls, callsBefore);
});

test("ensure requires an oc client (production composition is explicit)", () => {
  assert.throws(() => createCtoBinding(), /oc client with createSession/);
  assert.throws(() => createCtoBinding({ oc: { createSession() {} } }), /oc client with createSession/);
});

test("concurrent ensure calls join one flight — exactly one creation", async () => {
  const oc = fakeOc();
  const svc = makeService({ oc });
  const results = await Promise.all(Array.from({ length: 5 }, () => svc.ensure()));
  assert.equal(oc.createCalls, 1);
  const ids = new Set(results.map((r) => r.binding.currentSessionId));
  assert.equal(ids.size, 1);
  assert.ok(ids.has(oc.created[0].id));
});

// ---------------------------------------------------------------------------
// Durable role, not ephemeral: never reaped, provenance tombstoned
// ---------------------------------------------------------------------------

test("the durable role session never matches the ephemeral reaper (title prefix) and is not a reap candidate", async () => {
  assert.ok(!ROLE_SESSION_TITLE.startsWith(CTO_TITLE_PREFIX));
  const oc = fakeOc();
  const svc = makeService({ oc });
  const { binding } = await svc.ensure();
  const session = oc.created.find((s) => s.id === binding.currentSessionId);
  assert.deepEqual(selectReapCandidates({ sessions: [session], nowMs: Date.now() + 10 * 60_000 }), []);
});

test("the bound session is registered in the never-swept provenance tombstones (CTO-owned, not a TTL registry)", async () => {
  const oc = fakeOc();
  const provenanceStore = memoryStore("prov");
  const svc = makeService({ oc, provenanceStore });
  const { binding } = await svc.ensure();
  const payload = await provenanceStore.load();
  assert.ok(Array.isArray(payload.ids));
  assert.ok(payload.ids.includes(binding.currentSessionId));
  // Idempotent: re-ensuring does not duplicate the tombstone.
  await svc.ensure();
  const again = await provenanceStore.load();
  assert.equal(again.ids.filter((id) => id === binding.currentSessionId).length, 1);
});

// ---------------------------------------------------------------------------
// Control directory — exists, owned, marked, never a repository
// ---------------------------------------------------------------------------

test("the control directory is created 0700, marker file written, and opencode points at it", async () => {
  const oc = fakeOc();
  const controlDir = tempControlDir(randomUUID());
  const svc = makeService({ oc, controlDir });
  await svc.ensure();

  const dirStat = await stat(controlDir);
  assert.equal(dirStat.mode & 0o777, 0o700);
  const marker = JSON.parse(await readFile(join(controlDir, CONTROL_MARKER_FILENAME), "utf8"));
  assert.equal(marker.kind, "manta-cto-control-directory");
  assert.equal(marker.role, BINDING_ROLE);
  assert.equal(oc.created[0].directory, controlDir);
});

test("defaultControlDir resolves inside the state-home sandbox (never the live box)", () => {
  const sandbox = process.env.MANTA_STATE_HOME;
  assert.ok(sandbox && sandbox.trim() !== "");
  assert.ok(defaultControlDir().startsWith(sandbox));
});

test("a .git inside the control directory refuses to bind — no repository execution", async () => {
  const oc = fakeOc();
  const controlDir = tempControlDir(randomUUID());
  const svc = makeService({ oc, controlDir });
  await mkdir(join(controlDir, ".git"), { recursive: true });
  await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "control-directory-repository");
  assert.equal(oc.createCalls, 0);
});

// ---------------------------------------------------------------------------
// Crash recovery — reserve before create, adopt by exact marker
// ---------------------------------------------------------------------------

test("crash after remote create before binding — a fresh instance recovers by exact marker, no duplicate", async () => {
  const controlDir = tempControlDir(randomUUID());
  const oc = fakeOc();
  let payload = { ...EMPTY_BINDING };
  let saves = 0;
  const store = {
    name: "binding-crash",
    path: "binding-crash.json",
    async load() {
      return payload;
    },
    async save(next) {
      saves++;
      if (saves === 2) throw new Error("simulated crash: bind write lost"); // reserve=1 ok, bind=2 dies
      payload = next;
    },
  };

  // The dying process: reservation lands, create lands remotely, the bind
  // write is lost. The retry sleep throwing simulates the hard kill before
  // the loop could self-heal — the store state is exactly post-crash state.
  const dying = createCtoBinding({ oc, store, controlDir, sleep: async () => { throw new Error("simulated hard kill"); } });
  await assert.rejects(() => dying.ensure(), /simulated hard kill/);
  assert.equal(oc.createCalls, 1);
  assert.ok(payload.pendingOperation, "reservation survives the crash");
  const reservedOp = payload.pendingOperation;

  // A fresh process (same store, same opencode) recovers without duplicating.
  const fresh = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });
  const result = await fresh.ensure();
  assert.equal(result.created, false);
  assert.ok(result.actions.some((a) => a.action === "adopted"));
  assert.equal(oc.createCalls, 1);
  assert.equal(result.binding.currentSessionId, oc.created[0].id);
  assert.equal(result.binding.currentOperation, reservedOp.operation);
  assert.equal(result.binding.generation, reservedOp.generation);
  assert.equal(result.binding.pendingOperation, null);
});

test("recovery matches the EXACT operation marker — same-titled decoys with other or missing markers are never adopted", async () => {
  const controlDir = tempControlDir(randomUUID());
  const decoys = [
    { id: "ses_decoy-same-title", title: ROLE_SESSION_TITLE, directory: controlDir, metadata: null, time: { created: 1, updated: 1 } },
    { id: "ses_decoy-other-op", title: ROLE_SESSION_TITLE, directory: controlDir, metadata: { role: BINDING_ROLE, bindingOperation: "op-someone-else" }, time: { created: 1, updated: 1 } },
    { id: "ses_decoy-role-only", title: "cto:ambient", directory: controlDir, metadata: { role: BINDING_ROLE }, time: { created: 1, updated: 1 } },
  ];
  const oc = fakeOc({ sessions: decoys });
  const store = memoryStore("binding-decoy");
  // A crash-style reservation whose session never landed.
  await store.save({ ...EMPTY_BINDING, pendingOperation: { operation: "op-lost", generation: 1, directory: controlDir, startedAt: Date.now() } });
  const svc = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });

  const result = await svc.ensure();
  // The scan proved definitive absence (page non-full) → cleared → fresh create.
  assert.ok(result.actions.some((a) => a.action === "reservation-cleared"));
  assert.equal(oc.createCalls, 1);
  assert.equal(result.binding.currentSessionId, oc.created[0].id);
  assert.notEqual(result.binding.currentSessionId, "ses_decoy-same-title");
  assert.notEqual(result.binding.currentSessionId, "ses_decoy-other-op");
  assert.equal(result.binding.generation, 1);
});

test("a failed create leaves the reservation for marker reconciliation, then the bounded retry succeeds — no blind duplicate", async () => {
  const oc = fakeOc({ failCreates: 1 });
  const svc = makeService({ oc });
  const result = await svc.ensure();
  assert.equal(oc.createCalls, 2, "first attempt failed unknown, second ran after reconcile-to-absent");
  assert.equal(result.created, true);
  assert.equal(result.binding.pendingOperation, null);
  assert.equal(oc.created.length, 1, "the failed attempt left no session to adopt");
  assert.equal(result.binding.currentSessionId, oc.created[0].id);
});

test("an unresolvable pending marker (opencode unreachable) fails LOUDLY after bounded attempts — no create, reservation kept", async () => {
  const controlDir = tempControlDir(randomUUID());
  const store = memoryStore("binding-stuck");
  await store.save({ ...EMPTY_BINDING, pendingOperation: { operation: "op-stuck", generation: 1, directory: controlDir, startedAt: Date.now() } });
  const oc = fakeOc({ listError: new Error("opencode down") });
  const svc = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });

  await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "unknown-state");
  assert.equal(oc.createCalls, 0);
  assert.ok(oc.listCalls >= RECONCILE_ATTEMPTS, "bounded scan attempts happened");
  const after = await store.load();
  assert.equal(after.pendingOperation?.operation, "op-stuck", "reservation preserved for recovery");
});

test("a marker outside the provable list-page window is uncertainty, not absence — no create", async () => {
  const controlDir = tempControlDir(randomUUID());
  const startedAt = 1_000_000;
  // Full page (100) of entries all updated AFTER the reservation instant:
  // the marker session could have scrolled off the newest-100 page.
  const fullPage = Array.from({ length: 100 }, (_, i) => ({
    id: `ses_churn${i}`,
    title: `churn ${i}`,
    metadata: null,
    time: { created: startedAt + 5_000, updated: startedAt + 5_000 + i },
  }));
  const store = memoryStore("binding-horizon");
  await store.save({ ...EMPTY_BINDING, pendingOperation: { operation: "op-old", generation: 1, directory: controlDir, startedAt } });
  const oc = fakeOc({ sessions: fullPage });
  const svc = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });

  await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "unknown-state");
  assert.equal(oc.createCalls, 0);
  assert.equal((await store.load()).pendingOperation?.operation, "op-old");
});

test("a marker whose window IS provable (page oldest predates the op) resolves as definitive absence", async () => {
  const controlDir = tempControlDir(randomUUID());
  const startedAt = 1_000_000;
  // Full page, but its oldest entry predates the reservation instant — a
  // created session would rank above it, so absence from the page proves
  // the create never landed.
  const fullPage = Array.from({ length: 100 }, (_, i) => ({
    id: `ses_old${i}`,
    title: `old ${i}`,
    metadata: null,
    time: { created: startedAt - 10_000, updated: startedAt - 10_000 + i },
  }));
  const store = memoryStore("binding-window");
  await store.save({ ...EMPTY_BINDING, pendingOperation: { operation: "op-old", generation: 1, directory: controlDir, startedAt } });
  const oc = fakeOc({ sessions: fullPage });
  const svc = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });

  const result = await svc.ensure();
  assert.ok(result.actions.some((a) => a.action === "reservation-cleared"));
  assert.equal(result.created, true);
  assert.equal(oc.createCalls, 1);
  assert.equal(result.binding.generation, 1);
});

// ---------------------------------------------------------------------------
// ensure on a bound session — only 404 replaces; timeouts never duplicate
// ---------------------------------------------------------------------------

test("a transient lookup failure on the bound session surfaces uncertainty and never duplicates", async () => {
  const oc = fakeOc();
  const svc = makeService({ oc });
  const first = await svc.ensure();
  const boundId = first.binding.currentSessionId;

  oc.readStates[boundId] = () => ({ state: "unknown" });
  const second = await svc.ensure();
  assert.equal(second.created, false);
  assert.equal(second.uncertain, true);
  assert.equal(second.uncertainReason, "unknown");
  assert.equal(second.binding.currentSessionId, boundId);
  assert.equal(oc.createCalls, 1);
});

test("a metadata mismatch on the live bound session is surfaced, never adopted or replaced", async () => {
  const oc = fakeOc();
  const svc = makeService({ oc });
  const first = await svc.ensure();
  const boundId = first.binding.currentSessionId;

  oc.readStates[boundId] = () => ({
    state: "found",
    session: { id: boundId, title: ROLE_SESSION_TITLE, metadata: { role: "user_session" } },
  });
  const second = await svc.ensure();
  assert.equal(second.uncertain, true);
  assert.equal(second.uncertainReason, "mismatch");
  assert.equal(second.binding.currentSessionId, boundId);
  assert.equal(oc.createCalls, 1);
});

test("a DEFINITIVELY absent bound session is replaced: generation bumps, history preserves the archive reference", async () => {
  const oc = fakeOc();
  const svc = makeService({ oc });
  const first = await svc.ensure();
  const oldId = first.binding.currentSessionId;

  oc.readStates[oldId] = () => ({ state: "missing" });
  const second = await svc.ensure();
  assert.equal(second.created, true);
  assert.equal(second.replaced, true);
  assert.equal(second.binding.generation, 2);
  assert.deepEqual(second.binding.previousSessionIds, [oldId]);
  assert.notEqual(second.binding.currentSessionId, oldId);
  // The old session is NOT deleted — the archive reference still resolves.
  assert.ok((await oc.listSessions()).some((s) => s.id === oldId));
});

test("successive replacements accumulate generation history without deleting archives", async () => {
  const oc = fakeOc();
  const svc = makeService({ oc });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const result = await svc.ensure();
    ids.push(result.binding.currentSessionId);
    if (i < 2) oc.readStates[ids[i]] = () => ({ state: "missing" });
  }
  const binding = await svc.getBinding();
  assert.equal(binding.generation, 3);
  assert.deepEqual(binding.previousSessionIds, [ids[0], ids[1]]);
  assert.ok(oc.created.length >= 3);
});

// ---------------------------------------------------------------------------
// recover() — explicit reconcile pass
// ---------------------------------------------------------------------------

test("recover(): nothing bound is a no-op (creation is ensure's job); bound+alive is a no-op", async () => {
  const oc = fakeOc();
  const svc = makeService({ oc });
  const empty = await svc.recover();
  assert.equal(empty.binding.currentSessionId, null);
  assert.equal(oc.createCalls, 0);

  await svc.ensure();
  const alive = await svc.recover();
  assert.equal(alive.replaced, undefined);
  assert.equal(alive.uncertain, undefined);
  assert.equal(oc.createCalls, 1);
});

test("recover(): definitively absent bound session is replaced with a replacement generation", async () => {
  const oc = fakeOc();
  const svc = makeService({ oc });
  const first = await svc.ensure();
  const oldId = first.binding.currentSessionId;
  oc.readStates[oldId] = () => ({ state: "missing" });

  const recovered = await svc.recover();
  assert.equal(recovered.replaced, true);
  assert.equal(recovered.binding.generation, 2);
  assert.ok(recovered.binding.previousSessionIds.includes(oldId));
  assert.ok(recovered.actions.some((a) => a.action === "replaced"));
});

test("recover(): a crashed reservation whose session landed is adopted by exact marker", async () => {
  const controlDir = tempControlDir(randomUUID());
  const oc = fakeOc();
  const store = memoryStore("binding-recover");
  const svc = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });
  // Simulate the crash window directly: reserve the marker, create remotely,
  // persist only the reservation — then recover.
  const op = { operation: `op-${randomUUID()}`, generation: 1, directory: controlDir, startedAt: Date.now() };
  const session = await oc.createSession({ directory: controlDir, title: ROLE_SESSION_TITLE, metadata: markerFor(op) });
  await store.save({ ...EMPTY_BINDING, pendingOperation: op });

  const recovered = await svc.recover();
  assert.ok(recovered.actions.some((a) => a.action === "adopted"));
  assert.equal(recovered.binding.currentSessionId, session.id);
  assert.equal(recovered.binding.currentOperation, op.operation);
  assert.equal(oc.createCalls, 1);
});

// ---------------------------------------------------------------------------
// Corrupt store — loud, never silently "unbound"
// ---------------------------------------------------------------------------

test("a corrupt binding store fails ensure loudly and creates nothing (never resets to unbound)", async () => {
  const oc = fakeOc();
  await mkdir(dirname(bindingStore.path), { recursive: true });
  await writeFile(bindingStore.path, "{ definitely not json", "utf8");
  const svc = createCtoBinding({ oc, controlDir: tempControlDir(randomUUID()), sleep: noopSleep });
  await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "store-unreadable");
  await assert.rejects(svc.getBinding(), (err) => err.code === "store-unreadable");
  assert.equal(oc.createCalls, 0);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("normalizeBinding validates strictly and fails loudly on violations", () => {
  assert.deepEqual(normalizeBinding({}), {
    generation: 0,
    currentSessionId: null,
    currentOperation: null,
    previousSessionIds: [],
    pendingOperation: null,
  });
  assert.throws(() => normalizeBinding({ generation: -1 }), /invalid generation/);
  assert.throws(() => normalizeBinding({ generation: 1.5 }), /invalid generation/);
  assert.throws(() => normalizeBinding({ currentSessionId: "ses_x" }), /currentOperation/);
  assert.throws(() => normalizeBinding({ currentOperation: "op_x" }), /currentOperation/);
  assert.throws(() => normalizeBinding({ currentSessionId: 42 }), /currentSessionId/);
  assert.throws(() => normalizeBinding({ previousSessionIds: [7] }), /previousSessionIds/);
  assert.throws(() => normalizeBinding({ pendingOperation: { operation: "op" } }), /pendingOperation/);
  assert.equal(normalizeBinding({ currentSessionId: "ses_x", currentOperation: "op_x" }).currentSessionId, "ses_x");
});

test("capPrevious dedupes and keeps the most recent archives under the cap", () => {
  assert.deepEqual(capPrevious(["a", "b", "a", "c"], 2), ["b", "c"]);
  assert.deepEqual(capPrevious([], 3), []);
  const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
  assert.equal(capPrevious(ids, PREVIOUS_SESSION_IDS_CAP).length, PREVIOUS_SESSION_IDS_CAP);
  assert.deepEqual(capPrevious(ids, PREVIOUS_SESSION_IDS_CAP), ids.slice(-PREVIOUS_SESSION_IDS_CAP));
});

test("isMarkerSession requires role AND the exact operation (never title, never role alone)", () => {
  const op = { operation: "op-1", generation: 1, directory: "/x", startedAt: 1 };
  const marked = { id: "s", title: "anything", metadata: markerFor(op) };
  assert.equal(isMarkerSession(marked, "op-1"), true);
  assert.equal(isMarkerSession(marked, "op-2"), false);
  assert.equal(isMarkerSession({ id: "s", title: "anything", metadata: { role: BINDING_ROLE } }, "op-1"), false);
  assert.equal(isMarkerSession({ id: "s", title: ROLE_SESSION_TITLE, metadata: null }, "op-1"), false);
  assert.equal(isMarkerSession(null, "op-1"), false);
});

// ---------------------------------------------------------------------------
// Production composition — the REAL opencode client over a mocked transport
// ---------------------------------------------------------------------------

test("production composition: real opencode.mjs createSession sends the metadata marker on the wire and readSession reads it back", async () => {
  const calls = [];
  const sessions = new Map();
  let seq = 0;
  let failNextRead = false;
  const prev = ocModule._setOcTransport(async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
    if (method === "POST" && u.pathname === "/session") {
      const session = {
        id: `ses_live${++seq}`,
        title: body.title,
        directory: u.searchParams.get("directory"),
        projectID: "global",
        time: { created: 1, updated: 1 },
        metadata: body.metadata ?? null,
      };
      sessions.set(session.id, session);
      return new Response(JSON.stringify(session), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && u.pathname.startsWith("/session/")) {
      const id = decodeURIComponent(u.pathname.slice("/session/".length));
      if (failNextRead) {
        failNextRead = false;
        return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      if (sessions.has(id)) {
        return new Response(JSON.stringify(sessions.get(id)), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: `unexpected ${method} ${u.pathname}` }), { status: 500 });
  });
  ocModule._resetSessionDirectoryCache();
  try {
    const controlDir = tempControlDir(randomUUID());
    const svc = createCtoBinding({
      oc: {
        createSession: ocModule.createSession,
        readSession: ocModule.readSession,
        listSessions: async () => {
          throw new Error("listSessions not exercised in the composition test");
        },
      },
      store: memoryStore("binding-composition"),
      controlDir,
      sleep: noopSleep,
    });
    const result = await svc.ensure();
    assert.equal(result.created, true);

    const post = calls.find((c) => c.method === "POST" && c.path === "/session");
    assert.ok(post, "the binding create hit POST /session");
    assert.equal(post.body.title, ROLE_SESSION_TITLE);
    assert.equal(post.body.metadata.role, BINDING_ROLE);
    assert.equal(post.body.metadata.bindingOperation, result.binding.currentOperation);
    assert.equal(post.query.directory, controlDir);

    // The receipt read-back: real readSession, found with the exact marker.
    const found = await ocModule.readSession(result.binding.currentSessionId);
    assert.equal(found.state, "found");
    assert.equal(found.session.metadata.bindingOperation, result.binding.currentOperation);

    // Three states: missing (404) and unknown (5xx).
    assert.equal((await ocModule.readSession("ses_never-created")).state, "missing");
    failNextRead = true;
    assert.equal((await ocModule.readSession(result.binding.currentSessionId)).state, "unknown");
  } finally {
    ocModule._setOcTransport(prev);
    ocModule._resetSessionDirectoryCache();
  }
});

test("production composition: createSession rejects a non-object metadata before any wire call", async () => {
  const prev = ocModule._setOcTransport(async () => {
    throw new Error("no wire call expected");
  });
  try {
    await assert.rejects(() => ocModule.createSession({ directory: "/tmp/x", metadata: null }), /plain object/);
    await assert.rejects(() => ocModule.createSession({ directory: "/tmp/x", metadata: ["role"] }), /plain object/);
    await assert.rejects(() => ocModule.createSession({ directory: "/tmp/x", metadata: "role" }), /plain object/);
  } finally {
    ocModule._setOcTransport(prev);
  }
});
