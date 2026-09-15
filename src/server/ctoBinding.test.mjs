// BET-P3a1: src/server/ctoBinding.test.mjs — the durable singleton CTO
// conversation binding (unified-cto-spec §3.1), incl. the review blockers:
// shared ensure/recover singleflight across engine instances, reservation +
// bind CAS, unknown-create retention (never absence-proof re-creates),
// unsupported-identity persistence, request/body deadlines, strict corrupt
// detection, uncapped archive. Pure logic + injected stores/oc; composition
// tests drive the REAL opencode.mjs client through `_setOcTransport`. No live
// opencode, no network, no model calls.

import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  CONTROL_MARKER_FILENAME,
  CONVERSATION_ROLE,
  CtoBindingError,
  DEFAULT_REQUEST_DEADLINE_MS,
  RECONCILE_ATTEMPTS,
  ROLE_SESSION_TITLE,
  _resetConversationRoleCache,
  capPrevious,
  createCtoBinding,
  defaultControlDir,
  isMarkerSession,
  markerFor,
  normalizeBinding,
  readConversationRole,
} from "./ctoBinding.mjs";
import { bindingStore, internalSessionsStore } from "./ctoStores.mjs";
import { CTO_TITLE_PREFIX, selectReapCandidates } from "./ctoSessions.mjs";
import * as ocModule from "./opencode.mjs";
import { stateHome, statePath } from "../shared/paths.mjs";

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
function fakeOc({ failCreates = 0, createStatus, listError, listResponse, sessions = [], readStates = {} } = {}) {
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
        if (createStatus !== undefined) {
          const err = new Error(`simulated definitive rejection ${createStatus}`);
          err.status = createStatus;
          throw err;
        }
        throw new Error("simulated unknown create failure");
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
      if (listResponse !== undefined) return listResponse;
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

  const session = oc.created[0];
  assert.equal(session.title, ROLE_SESSION_TITLE);
  assert.equal(session.directory, controlDir);
  assert.equal(session.metadata.role, CONVERSATION_ROLE);
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

// ---------------------------------------------------------------------------
// Shared singleflight — ensure + recover, across engine instances (blocker 1)
// ---------------------------------------------------------------------------

test("concurrent ensure AND recover calls join one flight — exactly one creation", async () => {
  const oc = fakeOc();
  const svc = makeService({ oc });
  const results = await Promise.all([
    svc.ensure(),
    svc.recover(),
    svc.ensure(),
    svc.recover(),
    svc.ensure(),
  ]);
  assert.equal(oc.createCalls, 1);
  const ids = new Set(results.map((r) => r.binding.currentSessionId));
  assert.equal(ids.size, 1);
  assert.ok(ids.has(oc.created[0].id));
});

test("two engine instances over the SAME store share the flight — one creation", async () => {
  const oc = fakeOc();
  const store = memoryStore("binding-shared");
  const a = makeService({ oc, store });
  const b = makeService({ oc, store });
  const [ra, rb] = await Promise.all([a.ensure(), b.ensure()]);
  assert.equal(oc.createCalls, 1);
  assert.equal(ra.binding.currentSessionId, rb.binding.currentSessionId);
  assert.ok(rb.binding.currentSessionId);
});

// ---------------------------------------------------------------------------
// CAS — a stale missing lookup must not replace a prior bind (blocker 1)
// ---------------------------------------------------------------------------

test("stale missing lookup + prior bind: reservation CAS defers, the prior bind is never overwritten", async () => {
  const oc = fakeOc({
    sessions: [
      // The concurrently-landed prior replacement, verifiable by its marker.
      { id: "ses_replacement", title: ROLE_SESSION_TITLE, directory: "/x", time: { created: 1, updated: 1 }, metadata: { role: CONVERSATION_ROLE, bindingOperation: "op-prior-bind" } },
    ],
  });
  const store = memoryStore("binding-cas");
  const svc = makeService({ oc, store });
  const first = await svc.ensure();
  const staleSid = first.binding.currentSessionId;
  const staleGeneration = first.binding.generation;

  // The lookup for the bound session is stale (says missing) AND, while it
  // runs, a concurrent bind lands (a prior replacement completes). The
  // reservation CAS must see the moved store and refuse to create.
  oc.readStates[staleSid] = async () => {
    const prior = await store.load();
    await store.save({
      ...prior,
      generation: staleGeneration + 1,
      currentSessionId: "ses_replacement",
      currentOperation: "op-prior-bind",
      previousSessionIds: [...prior.previousSessionIds, staleSid],
    });
    return { state: "missing" };
  };
  await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "deferred");
  assert.equal(oc.createCalls, 1, "the stale pass created NOTHING");

  // The store still shows the prior bind; a fresh ensure verifies and returns it.
  const after = await svc.ensure();
  assert.equal(after.created, false);
  assert.equal(after.binding.currentSessionId, "ses_replacement");
  assert.equal(after.binding.generation, staleGeneration + 1);
});

// ---------------------------------------------------------------------------
// Unknown create outcome — reservation retained, never absence-proof re-created
// ---------------------------------------------------------------------------

test("an unknown create failure retains the reservation; a marker-absent scan NEVER re-creates", async () => {
  const controlDir = tempControlDir(randomUUID());
  const oc = fakeOc({ failCreates: 1 }); // throws WITHOUT a status → unknown
  const store = memoryStore("binding-unknown");
  const svc = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });

  await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "create-unknown");
  assert.equal(oc.createCalls, 1, "one create attempt per ensure — no in-service retry loop");
  assert.ok((await store.load()).pendingOperation, "reservation retained");

  // A later ensure scans; the marker is absent; it must STILL not create.
  await assert.rejects(svc.ensure(), (err) => err.code === "unknown-state");
  assert.equal(oc.createCalls, 1);
  assert.ok((await store.load()).pendingOperation);
});

test("a retained reservation settles when the marker session becomes identifiable (late landing)", async () => {
  const controlDir = tempControlDir(randomUUID());
  const oc = fakeOc({ failCreates: 1 });
  const store = memoryStore("binding-settle");
  const svc = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });

  await assert.rejects(svc.ensure(), () => true); // unknown outcome, retained
  const op = (await store.load()).pendingOperation;
  assert.ok(op);

  // The in-flight create lands LATE (after the earlier list snapshot) with
  // the exact marker: the next ensure settles by identification, not absence.
  oc.created.push({
    id: "ses_late-landing",
    title: ROLE_SESSION_TITLE,
    directory: controlDir,
    time: { created: 1, updated: 1 },
    metadata: markerFor(op),
  });
  const result = await svc.ensure();
  assert.equal(result.created, false);
  assert.ok(result.actions.some((a) => a.action === "adopted"));
  assert.equal(result.binding.currentSessionId, "ses_late-landing");
  assert.equal(oc.createCalls, 1);
  assert.equal(result.binding.pendingOperation, null);
});

test("a DEFINITIVE opencode rejection (4xx) clears its own reservation; the next ensure may create", async () => {
  const oc = fakeOc({ failCreates: 1, createStatus: 400 });
  const store = memoryStore("binding-reject");
  const svc = makeService({ oc, store });

  await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "create-rejected");
  assert.equal(oc.createCalls, 1);
  assert.equal((await store.load()).pendingOperation ?? null, null, "definitive rejection clears the reservation");

  const second = await svc.ensure();
  assert.equal(second.created, true);
  assert.equal(oc.createCalls, 2);
  assert.equal(second.binding.currentSessionId, oc.created[0].id);
});

test("a malformed list response is uncertainty, never [] / absence — reservation retained", async () => {
  const controlDir = tempControlDir(randomUUID());
  for (const malformed of [null, "garbage", 42, { not: "an array" }]) {
    const store = memoryStore("binding-malformed");
    await store.save({ ...EMPTY_BINDING, pendingOperation: { operation: `op-${randomUUID()}`, generation: 1, directory: controlDir, startedAt: Date.now() } });
    const oc = fakeOc({ listResponse: malformed });
    const svc = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });
    await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "unknown-state");
    assert.equal(oc.createCalls, 0, `${typeof malformed} list response must not read as absence`);
    assert.ok((await store.load()).pendingOperation);
  }
});

// ---------------------------------------------------------------------------
// Unsupported identity — created sid persisted, terminal, never a loop (blocker 2)
// ---------------------------------------------------------------------------

test("a created session whose metadata was not preserved persists the sid + unsupported identity and stops", async () => {
  const controlDir = tempControlDir(randomUUID());
  const oc = fakeOc();
  // Simulate an opencode regression: the session record loses its metadata.
  const origCreate = oc.createSession;
  oc.createSession = async (args) => {
    const s = await origCreate(args);
    // Mutate the STORED record (what readSession returns), not the clone.
    oc.created[oc.created.length - 1].metadata = null;
    void s;
    return structuredClone(oc.created[oc.created.length - 1]);
  };
  const store = memoryStore("binding-unsupported");
  const svc = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });

  await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "unsupported-identity");
  assert.equal(oc.createCalls, 1);

  // The sid + failure state are PERSISTED (not lost with the error).
  const pending = (await store.load()).pendingOperation;
  assert.ok(pending?.unsupportedIdentity === true);
  assert.equal(pending.createdSessionId, oc.created[0].id);

  // Every later ensure fails explicitly and NEVER creates again — no 3-create loop.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(svc.ensure(), (err) => err.code === "unsupported-identity");
    await assert.rejects(svc.recover(), (err) => err.code === "unsupported-identity");
  }
  assert.equal(oc.createCalls, 1);
  assert.equal(oc.listCalls, 0, "no marker scan can adopt an unidentifiable session");
});

// ---------------------------------------------------------------------------
// Deadlines — hung headers / hung body through the actual transport signal (blocker 3)
// ---------------------------------------------------------------------------

test("every oc call carries an AbortSignal deadline: hung create headers fail bounded through the transport signal", async () => {
  const deadlineMs = 120;
  const signals = [];
  const prev = ocModule._setOcTransport((url, init = {}) => {
    signals.push(init.signal);
    // (a) hung HEADERS: the transport promise never settles...
    return new Promise(() => {});
  });
  ocModule._resetSessionDirectoryCache();
  // AbortSignal.timeout timers deliberately do NOT keep the event loop alive —
  // hold it open for the deadline ourselves.
  const keepAlive = setTimeout(() => {}, deadlineMs + 500);
  try {
    const svc = createCtoBinding({
      oc: { createSession: ocModule.createSession, listSessions: ocModule.listSessions, readSession: ocModule.readSession },
      store: memoryStore("binding-deadline"),
      controlDir: tempControlDir(randomUUID()),
      sleep: noopSleep,
      requestDeadlineMs: deadlineMs,
    });
    const t0 = Date.now();
    // (a) hung create headers → the deadline classifies the create as unknown.
    await assert.rejects(
      svc.ensure(),
      (err) => err instanceof CtoBindingError && err.code === "create-unknown" && /deadline/.test(err.message),
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= deadlineMs - 30, `deadline respected (${elapsed}ms)`);
    assert.ok(elapsed < DEFAULT_REQUEST_DEADLINE_MS, "bounded well under the default");

    // The signal reached the actual transport (http.request honors it) and
    // fired at the deadline.
    assert.equal(signals.length, 1, "one deadline signal per bounded call");
    assert.equal(signals[0].aborted, true, "the transport signal actually aborted");
  } finally {
    clearTimeout(keepAlive);
    ocModule._setOcTransport(prev);
    ocModule._resetSessionDirectoryCache();
  }
});

test("a hung response BODY on the liveness read is bounded uncertainty, never a replacement", async () => {
  const deadlineMs = 120;
  const signals = [];
  const prev = ocModule._setOcTransport(async (url, init = {}) => {
    signals.push(init.signal);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([123])); // headers arrive...
      }, // ...the body never closes
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  });
  const keepAlive = setTimeout(() => {}, deadlineMs + 500);
  try {
    const store = memoryStore("binding-body-deadline");
    await store.save({ ...EMPTY_BINDING, generation: 1, currentSessionId: "ses_bound", currentOperation: "op-bound" });
    const svc = createCtoBinding({
      oc: { createSession: ocModule.createSession, listSessions: ocModule.listSessions, readSession: ocModule.readSession },
      store,
      controlDir: tempControlDir(randomUUID()),
      sleep: noopSleep,
      requestDeadlineMs: deadlineMs,
    });
    const t0 = Date.now();
    const result = await svc.ensure();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= deadlineMs - 30 && elapsed < DEFAULT_REQUEST_DEADLINE_MS, `bounded (${elapsed}ms)`);
    assert.equal(result.uncertain, true);
    assert.equal(result.uncertainReason, "unknown");
    assert.equal(result.binding.currentSessionId, "ses_bound");
    assert.equal(signals[0].aborted, true);
  } finally {
    clearTimeout(keepAlive);
    ocModule._setOcTransport(prev);
  }
});

test("a hung list response on a pending reservation fails bounded and retains the reservation", async () => {
  const deadlineMs = 100;
  const signals = [];
  const prev = ocModule._setOcTransport(() => {
    return new Promise((resolve) => {
      signals.push(true);
      void resolve; // hung headers — never resolves
    });
  });
  const keepAlive = setTimeout(() => {}, deadlineMs * RECONCILE_ATTEMPTS + 1000);
  try {
    const controlDir = tempControlDir(randomUUID());
    const store = memoryStore("binding-list-deadline");
    await store.save({ ...EMPTY_BINDING, pendingOperation: { operation: "op-hung", generation: 1, directory: controlDir, startedAt: Date.now() } });
    const svc = createCtoBinding({
      oc: { createSession: ocModule.createSession, listSessions: ocModule.listSessions, readSession: ocModule.readSession },
      store,
      controlDir,
      sleep: noopSleep,
      requestDeadlineMs: deadlineMs,
    });
    await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "unknown-state");
    assert.ok(signals.length >= RECONCILE_ATTEMPTS, "bounded scan attempts");
    assert.equal((await store.load()).pendingOperation?.operation, "op-hung", "retained");
  } finally {
    clearTimeout(keepAlive);
    ocModule._setOcTransport(prev);
  }
});

test("a create that times out is an UNKNOWN outcome — reservation retained, no blind retry", async () => {
  const deadlineMs = 100;
  const oc = fakeOc();
  oc.createSession = async () => {
    oc.createCalls++;
    return new Promise(() => {});
  }; // hung create
  const store = memoryStore("binding-create-deadline");
  const svc = makeService({ oc, store, requestDeadlineMs: deadlineMs });
  const keepAlive = setTimeout(() => {}, deadlineMs * 2 + 500);

  try {
    await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "create-unknown");
    assert.equal(oc.createCalls, 1);
    assert.ok((await store.load()).pendingOperation, "retained for marker settlement");
    // A retry does NOT create again while the outcome is unsettled.
    await assert.rejects(svc.ensure(), (err) => err.code === "unknown-state");
    assert.equal(oc.createCalls, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

// ---------------------------------------------------------------------------
// Durable role, not ephemeral: never reaped, distinct provenance (blocker 4)
// ---------------------------------------------------------------------------

test("the durable role session never matches the ephemeral reaper (title prefix) and is not a reap candidate", async () => {
  assert.ok(!ROLE_SESSION_TITLE.startsWith(CTO_TITLE_PREFIX));
  const oc = fakeOc();
  const svc = makeService({ oc });
  const { binding } = await svc.ensure();
  const session = oc.created.find((s) => s.id === binding.currentSessionId);
  assert.deepEqual(selectReapCandidates({ sessions: [session], nowMs: Date.now() + 10 * 60_000 }), []);
});

test("the durable conversation is NOT registered in the generic internal tombstones — provenance is the binding itself", async () => {
  _resetConversationRoleCache();
  const oc = fakeOc();
  // The DEFAULT (sandboxed) binding store — readConversationRole reads it.
  const svc = createCtoBinding({ oc, controlDir: tempControlDir(randomUUID()), sleep: noopSleep });
  const { binding } = await svc.ensure();

  const tombstones = await internalSessionsStore.load();
  assert.ok(!Array.isArray(tombstones.ids) || !tombstones.ids.includes(binding.currentSessionId));

  // The distinct role lookup: current sid → conversation; anything else → no.
  assert.equal(await readConversationRole(binding.currentSessionId), true);
  assert.equal(await readConversationRole("ses_something-else"), false);
  assert.equal(await readConversationRole(null), false);
  assert.equal(await readConversationRole(binding.previousSessionIds[0] ?? "ses_other"), false);
});

// ---------------------------------------------------------------------------
// Control directory — exists, owned, marked, never a repository, never redirected
// ---------------------------------------------------------------------------

test("the control directory is created 0700 (enforced), marker written, and opencode points at it", async () => {
  const oc = fakeOc();
  const controlDir = tempControlDir(randomUUID());
  const svc = makeService({ oc, controlDir });
  await svc.ensure();

  const dirStat = await stat(controlDir);
  assert.equal(dirStat.mode & 0o777, 0o700);
  // Pre-existing wider permissions are corrected on every ensure.
  await chmod(controlDir, 0o755);
  await svc.ensure();
  assert.equal((await stat(controlDir)).mode & 0o777, 0o700);
  const marker = JSON.parse(await readFile(join(controlDir, CONTROL_MARKER_FILENAME), "utf8"));
  assert.equal(marker.kind, "manta-cto-control-directory");
  assert.equal(marker.role, CONVERSATION_ROLE);
  assert.equal(oc.created[0].directory, controlDir);
});

test("defaultControlDir resolves inside the state-home sandbox (never the live box)", () => {
  const sandbox = stateHome();
  assert.ok(sandbox && sandbox.trim() !== "");
  assert.ok(defaultControlDir().startsWith(sandbox));
});

test("a .git in the control directory OR ANY ANCESTOR up to the state home refuses to bind", async () => {
  const controlDir = tempControlDir(randomUUID());
  const oc = fakeOc();
  const svc = makeService({ oc, controlDir });

  // Direct .git
  await mkdir(join(controlDir, ".git"), { recursive: true });
  await assert.rejects(svc.ensure(), (err) => err.code === "control-directory-repository");
  assert.equal(oc.createCalls, 0);

  // Ancestor .git (the label directory between controlDir and the state home)
  const labelDir = dirname(controlDir);
  await rm(join(controlDir, ".git"), { recursive: true });
  await mkdir(join(labelDir, ".git"), { recursive: true });
  await assert.rejects(svc.ensure(), (err) => err.code === "control-directory-repository");
  assert.equal(oc.createCalls, 0);
});

test("a symlink redirecting the control directory outside the state home is refused", async () => {
  const { mkdtemp, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const external = await mkdtemp(join(tmpdir(), "cto-p3a1-external-"));
  const controlDir = tempControlDir(randomUUID());
  await mkdir(dirname(controlDir), { recursive: true });
  await symlink(external, controlDir, "dir");
  const oc = fakeOc();
  const svc = makeService({ oc, controlDir });
  try {
    await assert.rejects(
      svc.ensure(),
      (err) => err.code === "control-directory-outside-state-home",
    );
    assert.equal(oc.createCalls, 0);
  } finally {
    await rm(controlDir);
    await rm(external, { recursive: true, force: true });
  }
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

  const dying = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });
  // With no in-service create retry, the lost bind write IS the crash: the
  // process dies right here, store holding the reservation, session existing.
  await assert.rejects(() => dying.ensure(), /bind write lost/);
  assert.equal(oc.createCalls, 1);
  assert.ok(payload.pendingOperation, "reservation survives the crash");
  const reservedOp = payload.pendingOperation;
  assert.equal(reservedOp.expectedGeneration, 0);
  assert.equal(reservedOp.expectedCurrentSessionId, null);

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
    { id: "ses_decoy-other-op", title: ROLE_SESSION_TITLE, directory: controlDir, metadata: { role: CONVERSATION_ROLE, bindingOperation: "op-someone-else" }, time: { created: 1, updated: 1 } },
    { id: "ses_decoy-role-only", title: "cto:ambient", directory: controlDir, metadata: { role: CONVERSATION_ROLE }, time: { created: 1, updated: 1 } },
  ];
  const oc = fakeOc({ sessions: decoys });
  const store = memoryStore("binding-decoy");
  // A crash-style reservation whose session never landed: the marker scan
  // finds nothing (decoys never match), the reservation is RETAINED, and no
  // duplicate is created.
  await store.save({ ...EMPTY_BINDING, pendingOperation: { operation: "op-lost", generation: 1, directory: controlDir, startedAt: Date.now() } });
  const svc = createCtoBinding({ oc, store, controlDir, sleep: noopSleep });

  await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "unknown-state");
  assert.equal(oc.createCalls, 0);
  assert.notEqual((await store.load()).pendingOperation, null);
  const recoverResult = await svc.recover();
  assert.equal(recoverResult.uncertain, true);
  assert.equal(oc.createCalls, 0);
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
  assert.ok((await oc.listSessions()).some((s) => s.id === oldId));
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
// Archive — never capped, never dropped; queries paginate (blocker 6)
// ---------------------------------------------------------------------------

test("more than 10 generations: the archive keeps EVERY reference; pagination slices without dropping", async () => {
  const oc = fakeOc();
  const store = memoryStore("binding-archive");
  const svc = createCtoBinding({ oc, store, controlDir: tempControlDir(randomUUID()), sleep: noopSleep });
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const result = await svc.ensure();
    ids.push(result.binding.currentSessionId);
    oc.readStates[ids[i]] = () => ({ state: "missing" });
  }
  const binding = await svc.getBinding();
  assert.equal(binding.generation, 12);
  assert.equal(binding.previousSessionIds.length, 11, "every replaced session is preserved");
  assert.deepEqual(binding.previousSessionIds, ids.slice(0, 11));

  // Pagination: most-recent-first windows, store untouched.
  const page = await svc.getBinding({ previousLimit: 3 });
  assert.deepEqual(page.previousSessionIds, ids.slice(8, 11));
  assert.equal(page.previousSessionIdsTotal, 11);
  const page2 = await svc.getBinding({ previousLimit: 3, previousOffset: 3 });
  assert.deepEqual(page2.previousSessionIds, ids.slice(5, 8));
  assert.equal(page2.previousSessionIdsTotal, 11);
  await assert.rejects(svc.getBinding({ previousLimit: 0 }), /previousLimit/);
  assert.deepEqual(capPrevious(["a", "a", "b"]), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// Corrupt store — loud, never silently "unbound" (blocker 5)
// ---------------------------------------------------------------------------

test("strict top-level null/array/string payloads are CORRUPTION, never the default; only a missing file initializes", async () => {
  const oc = fakeOc();
  await mkdir(dirname(bindingStore.path), { recursive: true });
  for (const corrupt of ["null", "[1,2]", '"str"', "{ definitely not json"]) {
    await writeFile(bindingStore.path, corrupt, "utf8");
    const svc = createCtoBinding({ oc, controlDir: tempControlDir(randomUUID()), sleep: noopSleep });
    await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "store-unreadable");
    await assert.rejects(svc.getBinding(), () => true);
    assert.equal(oc.createCalls, 0, `${corrupt} must never read as unbound`);
  }

  // A MISSING store file is the only default-initializing state.
  const { rm: rmFile } = await import("node:fs/promises");
  await rmFile(bindingStore.path, { force: true });
  const fresh = createCtoBinding({ oc, controlDir: tempControlDir(randomUUID()), sleep: noopSleep });
  const result = await fresh.ensure();
  assert.equal(result.created, true);
});

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

test("isMarkerSession requires role AND the exact operation (never title, never role alone)", () => {
  const op = { operation: "op-1", generation: 1, directory: "/x", startedAt: 1 };
  const marked = { id: "s", title: "anything", metadata: markerFor(op) };
  assert.equal(isMarkerSession(marked, "op-1"), true);
  assert.equal(isMarkerSession(marked, "op-2"), false);
  assert.equal(isMarkerSession({ id: "s", title: "anything", metadata: { role: CONVERSATION_ROLE } }, "op-1"), false);
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
          throw new Error("listSessions not exercised in this composition test");
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
    assert.equal(post.body.metadata.role, CONVERSATION_ROLE);
    assert.equal(post.body.metadata.bindingOperation, result.binding.currentOperation);
    assert.equal(post.query.directory, controlDir);

    const found = await ocModule.readSession(result.binding.currentSessionId);
    assert.equal(found.state, "found");
    assert.equal(found.session.metadata.bindingOperation, result.binding.currentOperation);

    assert.equal((await ocModule.readSession("ses_never-created")).state, "missing");
    failNextRead = true;
    assert.equal((await ocModule.readSession(result.binding.currentSessionId)).state, "unknown");
  } finally {
    ocModule._setOcTransport(prev);
    ocModule._resetSessionDirectoryCache();
  }
});

test("production composition: a 400 create carries err.status → the service treats it as a definitive rejection", async () => {
  const prev = ocModule._setOcTransport(async () =>
    new Response(JSON.stringify({ error: "bad request" }), { status: 400, headers: { "content-type": "application/json" } }),
  );
  try {
    const store = memoryStore("binding-composition-reject");
    const svc = createCtoBinding({
      oc: {
        createSession: ocModule.createSession,
        listSessions: ocModule.listSessions,
        readSession: ocModule.readSession,
      },
      store,
      controlDir: tempControlDir(randomUUID()),
      sleep: noopSleep,
    });
    await assert.rejects(svc.ensure(), (err) => err instanceof CtoBindingError && err.code === "create-rejected");
    assert.equal((await store.load()).pendingOperation ?? null, null, "definitive rejection clears its reservation");
  } finally {
    ocModule._setOcTransport(prev);
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
