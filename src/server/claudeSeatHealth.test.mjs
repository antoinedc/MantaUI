// A Claude seat whose usage call answers 401: refresh once, retry once, and when
// that does not bring it back the seat is "signed-out"; a later good reading or
// refresh makes it "ok" again. Real accounts service + real usage poller over a
// temp sandbox; only the usage endpoint and the `claude` refresh are faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySeatReadingOk, applySeatSignedOut, createAccountsService, emptyStore } from "./accounts.mjs";
import { createClaudeSeatHealth } from "./claudeSeatHealth.mjs";
import { createUsagePoller } from "./usage.mjs";
import { refreshClaudeSeatAndNote } from "./opencode.mjs";

const quiet = { warn() {}, log() {} };
const creds = (access) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `r-${access}`, expiresAt: 9e12 } });
const org = { uuid: "org-A", name: "Org", organization_type: "claude_team" };
const T0 = 1_800_000_000_000;

async function rig() {
  const root = await mkdtemp(join(tmpdir(), "claude-seat-health-"));
  const paths = {
    storePath: join(root, "state", "accounts.json"),
    seatsRoot: join(root, "secrets", "accounts"),
    claudeLivePath: join(root, "home", ".claude", ".credentials.json"),
    codexAuthPath: join(root, "home", "opencode-auth.json"),
  };
  await mkdir(join(root, "home", ".claude"), { recursive: true });
  for (const [id, tok] of [["seat-1", "tok-A"], ["seat-2", "tok-B"]]) {
    await mkdir(join(paths.seatsRoot, "claude", id), { recursive: true });
    await writeFile(join(paths.seatsRoot, "claude", id, ".credentials.json"), creds(tok));
  }
  await writeFile(paths.claudeLivePath, creds("tok-A-live")); // seat-1 is the live login
  const profiles = {
    "tok-A": { account: { uuid: "u-A" }, organization: org },
    "tok-A-live": { account: { uuid: "u-A" }, organization: org },
    "tok-B": { account: { uuid: "u-B" }, organization: org },
    "tok-B2": { account: { uuid: "u-B" }, organization: org },
  };
  const fetchImpl = async (_u, init) => {
    const p = profiles[String(init?.headers?.Authorization ?? "").replace("Bearer ", "")];
    return { ok: Boolean(p), status: p ? 200 : 401, json: async () => p };
  };
  const accounts = createAccountsService({ ...paths, log: quiet, fetchImpl });
  await accounts.discover({ force: true });

  // What the usage endpoint answers, by token: "ok" | 401.
  const usage = { "tok-A-live": "ok", "tok-A": "ok", "tok-B": 401, "tok-B2": "ok" };
  const adapter = {
    id: "claude",
    providerIDs: ["anthropic"],
    async detect(deps) {
      return Boolean((await deps.readCredentials())?.accessToken);
    },
    async fetch(deps) {
      const token = (await deps.readCredentials()).accessToken;
      reads.push(token);
      if (usage[token] !== "ok") throw Object.assign(new Error(`usage ${usage[token] ?? 401}`), { status: 401 });
      return { provider: "claude", kind: "subscription", windows: [{ kind: "session", label: "5h", pct: 10 }] };
    },
  };
  const reads = [];

  const refreshCalls = [];
  const refresh = { result: { ok: true } };
  const clock = { t: T0 };
  const health = createClaudeSeatHealth({
    seatStates: (p) => accounts.seatStates(p),
    refreshSeat: (target) =>
      refreshClaudeSeatAndNote(accounts, target, async (t) => {
        refreshCalls.push(t.seatId);
        if (refresh.result.ok) {
          await writeFile(join(t.dir, ".credentials.json"), creds("tok-B2")); // the CLI wrote a fresh token
        }
        return refresh.result;
      }),
    markSignedOut: (p, s) => accounts.markSeatSignedOut(p, s),
    noteReadingOk: (p, s) => accounts.noteSeatReadingOk(p, s),
    now: () => clock.t,
    log: quiet,
  });
  const published = [];
  const poller = createUsagePoller({
    adapters: [adapter],
    seats: accounts,
    now: () => clock.t,
    publish: (e) => published.push(e),
    perConversationRouting: true,
    onUnauthorized: (a) => health.onUnauthorized(a),
    onSeatSignedOut: (a) => health.onSignedOut(a),
    onSeatOk: (a) => health.onSeatOk(a),
  });
  const statusOf = async (id = "seat-2") =>
    (await accounts.getStore()).providers.claude.accounts.flatMap((a) => a.seats).find((s) => s.id === id).status;
  const seatReadings = () => poller.seatSnapshots.map((s) => s.seatId).sort();
  return {
    root,
    accounts,
    usage,
    reads,
    refresh,
    refreshCalls,
    clock,
    health,
    poller,
    published,
    statusOf,
    seatReadings,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const origWarn = console.warn;

test("401 → refresh ok → retry ok: the seat stays ok and its reading is published", async () => {
  const r = await rig();
  console.warn = () => {};
  try {
    r.refresh.result = { ok: true };
    await r.poller.tick();
    assert.deepEqual(r.refreshCalls, ["seat-2"], "refreshed once");
    assert.deepEqual(r.reads.filter((t) => t === "tok-B"), ["tok-B"], "the old token was tried once");
    assert.ok(r.reads.includes("tok-B2"), "retried with the refreshed token");
    assert.equal(await r.statusOf(), "ok");
    assert.deepEqual(r.seatReadings(), ["seat-1", "seat-2"]);
  } finally {
    console.warn = origWarn;
    await r.cleanup();
  }
});

test("401 → refresh fails → the seat is signed-out (unusable, accounts.updated fires); the live seat is untouched", async () => {
  const r = await rig();
  console.warn = () => {};
  try {
    const changes = [];
    r.accounts.onChange((e) => changes.push(e.provider));
    r.refresh.result = { ok: false, reason: "failed" };
    await r.poller.tick();
    assert.deepEqual(r.refreshCalls, ["seat-2"]);
    assert.equal(await r.statusOf("seat-2"), "signed-out");
    assert.equal(await r.statusOf("seat-1"), "ok");
    assert.deepEqual(changes, ["claude"]);
    const st = (await r.accounts.seatStates("claude")).seats.find((s) => s.seatId === "seat-2");
    assert.equal(st.usable, false, "the router stops placing conversations on it");
    // the dial keeps the seat that works
    assert.deepEqual(r.seatReadings(), ["seat-1"]);
  } finally {
    console.warn = origWarn;
    await r.cleanup();
  }
});

test("401 → refresh ok → 401 again → signed-out", async () => {
  const r = await rig();
  console.warn = () => {};
  try {
    r.refresh.result = { ok: true };
    r.usage["tok-B2"] = 401; // refreshed, and still refused
    await r.poller.tick();
    assert.deepEqual(r.refreshCalls, ["seat-2"], "only one refresh per 401");
    assert.equal(await r.statusOf(), "signed-out");
  } finally {
    console.warn = origWarn;
    await r.cleanup();
  }
});

test("401 → refresh says the refresh token is expired → expired (existing behaviour), NOT signed-out", async () => {
  const r = await rig();
  console.warn = () => {};
  try {
    r.refresh.result = { ok: false, reason: "refresh-token-expired" };
    await r.poller.tick();
    assert.equal(await r.statusOf(), "expired");
  } finally {
    console.warn = origWarn;
    await r.cleanup();
  }
});

test("a good usage reading brings a signed-out seat back to ok", async () => {
  const r = await rig();
  console.warn = () => {};
  try {
    r.refresh.result = { ok: false, reason: "failed" };
    await r.poller.tick();
    assert.equal(await r.statusOf(), "signed-out");
    // the user signed it back in (new credentials on disk); the usage endpoint accepts them
    await writeFile(join(r.accounts.seatDir("claude", "seat-2"), ".credentials.json"), creds("tok-B2"));
    r.clock.t += 5 * 60_000;
    await r.poller.tick();
    assert.equal(await r.statusOf(), "ok");
    assert.equal((await r.accounts.seatStates("claude")).seats.find((s) => s.seatId === "seat-2").usable, true);
    assert.deepEqual(r.seatReadings(), ["seat-1", "seat-2"]);
  } finally {
    console.warn = origWarn;
    await r.cleanup();
  }
});

test("a refresh success clears signed-out too; rediscovery does not flip it back by itself", async () => {
  const r = await rig();
  try {
    assert.equal(await r.accounts.markSeatSignedOut("claude", "seat-2"), true);
    assert.equal(await r.accounts.markSeatSignedOut("claude", "seat-2"), false, "already signed out → no write");
    await r.accounts.discover({ force: true });
    assert.equal(await r.statusOf(), "signed-out");
    assert.equal(await r.accounts.noteRefreshOutcome("claude", "seat-2", { ok: true, expiresAt: 1 }), true);
    assert.equal(await r.statusOf(), "ok");
  } finally {
    await r.cleanup();
  }
});

test("the live login is never marked: its 401 does not refresh the seat or change its status", async () => {
  const r = await rig();
  console.warn = () => {};
  try {
    r.usage["tok-A-live"] = 401;
    r.usage["tok-B"] = "ok";
    r.refresh.result = { ok: false, reason: "failed" };
    await r.poller.tick();
    assert.deepEqual(r.refreshCalls, []);
    assert.equal(await r.statusOf("seat-1"), "ok");
    assert.equal(await r.accounts.markSeatSignedOut("claude", "seat-9"), false, "an unknown seat is a no-op");
  } finally {
    console.warn = origWarn;
    await r.cleanup();
  }
});

test("single-flight + debounce: a second 401 shortly after does not refresh again (and changes nothing); later it does", async () => {
  const r = await rig();
  console.warn = () => {};
  try {
    r.refresh.result = { ok: false, reason: "failed" };
    await r.poller.tick();
    r.clock.t += 30_000;
    await r.poller.tick();
    assert.deepEqual(r.refreshCalls, ["seat-2"], "debounced");
    assert.equal(await r.statusOf(), "signed-out");
    r.clock.t += 3 * 60_000;
    await r.poller.tick();
    assert.deepEqual(r.refreshCalls, ["seat-2", "seat-2"]);

    // concurrent callers share one refresh
    const r2 = await rig();
    try {
      r2.refresh.result = { ok: false, reason: "failed" };
      const args = { adapterId: "claude", seatId: "seat-2" };
      const [a, b] = await Promise.all([r2.health.onUnauthorized(args), r2.health.onUnauthorized(args)]);
      assert.deepEqual(a, b);
      assert.equal(r2.refreshCalls.length, 1);
    } finally {
      await r2.cleanup();
    }
  } finally {
    console.warn = origWarn;
    await r.cleanup();
  }
});

test("claude health ignores other adapters and the single-credential path", async () => {
  const r = await rig();
  try {
    assert.deepEqual(await r.health.onUnauthorized({ adapterId: "codex", seatId: "seat-2" }), { ok: false, reason: "not-applicable" });
    assert.deepEqual(await r.health.onUnauthorized({ adapterId: "claude", seatId: null }), { ok: false, reason: "not-applicable" });
    assert.deepEqual(await r.health.onUnauthorized({ adapterId: "claude", seatId: "seat-1" }), { ok: false, reason: "not-applicable" }, "live seat");
    await r.health.onSignedOut({ adapterId: "codex", seatId: "seat-2" });
    await r.health.onSignedOut({ adapterId: "claude", seatId: "seat-1" });
    assert.equal(await r.statusOf("seat-2"), "ok");
    assert.equal(await r.statusOf("seat-1"), "ok");
    assert.equal(r.refreshCalls.length, 0);
  } finally {
    await r.cleanup();
  }
});

// ---- the poller's own contract (no accounts service) -----------------------------

function pollerWith({ onUnauthorized, secondFetch = "ok" }) {
  const signedOut = [];
  const ok = [];
  let calls = 0;
  const adapter = {
    id: "claude",
    providerIDs: ["anthropic"],
    detect: async () => true,
    fetch: async () => {
      calls++;
      if (calls === 1 || secondFetch === 401) throw Object.assign(new Error("401"), { status: 401 });
      return { provider: "claude", windows: [{ kind: "session", label: "5h", pct: 1 }] };
    },
  };
  const seats = {
    seatsFor: async () => ({
      mode: "manual",
      activeSeatId: "seat-2",
      seats: [{ accountId: "a", accountLabel: "A", seatId: "seat-2", seatLabel: "Seat 2", deps: {} }],
    }),
  };
  const poller = createUsagePoller({
    adapters: [adapter],
    seats,
    now: () => T0,
    publish() {},
    perConversationRouting: true,
    onUnauthorized,
    onSeatSignedOut: (a) => signedOut.push(a),
    onSeatOk: (a) => ok.push(a),
  });
  return { poller, signedOut, ok };
}

test("poller: signed-out is reported for an unrecovered 401 only — not when recovery was debounced, threw, or is absent", async () => {
  const quietWarn = console.warn;
  console.warn = () => {};
  try {
    let t = pollerWith({ onUnauthorized: async () => ({ ok: false, reason: "failed" }) });
    await t.poller.tick();
    assert.deepEqual(t.signedOut, [{ adapterId: "claude", seatId: "seat-2" }]);
    assert.deepEqual(t.ok, []);

    t = pollerWith({ onUnauthorized: async () => ({ ok: false, reason: "debounced" }) });
    await t.poller.tick();
    assert.deepEqual(t.signedOut, []);

    t = pollerWith({
      onUnauthorized: async () => {
        throw new Error("boom");
      },
    });
    await t.poller.tick();
    assert.deepEqual(t.signedOut, []);

    t = pollerWith({ onUnauthorized: null });
    await t.poller.tick();
    assert.deepEqual(t.signedOut, [], "no recovery wired → no bookkeeping");

    t = pollerWith({ onUnauthorized: async () => ({ ok: true }) });
    await t.poller.tick();
    assert.deepEqual(t.signedOut, []);
    assert.deepEqual(t.ok, [{ adapterId: "claude", seatId: "seat-2" }], "recovered → a good reading");

    t = pollerWith({ onUnauthorized: async () => ({ ok: true }), secondFetch: 401 });
    await t.poller.tick();
    assert.deepEqual(t.signedOut, [{ adapterId: "claude", seatId: "seat-2" }], "refreshed and refused again");
    assert.deepEqual(t.ok, []);
  } finally {
    console.warn = quietWarn;
  }
});

test("poller: a throwing bookkeeping callback never fails the poll", async () => {
  const quietWarn = console.warn;
  console.warn = () => {};
  try {
    const adapter = { id: "claude", providerIDs: [], detect: async () => true, fetch: async () => ({ provider: "claude", windows: [{ kind: "session", label: "5h", pct: 1 }] }) };
    const seats = { seatsFor: async () => ({ mode: "manual", activeSeatId: "s", seats: [{ accountId: "a", accountLabel: "A", seatId: "s", seatLabel: "S", deps: {} }] }) };
    const poller = createUsagePoller({
      adapters: [adapter],
      seats,
      now: () => T0,
      publish() {},
      perConversationRouting: true,
      onSeatOk: async () => {
        throw new Error("store down");
      },
    });
    await poller.tick();
    assert.equal(poller.seatSnapshots.length, 1, "the reading is still published");
  } finally {
    console.warn = quietWarn;
  }
});

test("applySeatSignedOut / applySeatReadingOk: pure, same object when nothing changes, expired is left alone", () => {
  const mk = (status) => {
    const s = emptyStore();
    s.providers.claude.accounts = [{ id: "a", label: "A", orgId: null, orgName: null, plan: null, seats: [{ id: "seat-1", label: "S", email: null, accountUuid: "u", credentialDir: "/d", status }] }];
    return s;
  };
  const seatStatus = (s) => s.providers.claude.accounts[0].seats[0].status;
  const ok = mk("ok");
  assert.equal(seatStatus(applySeatSignedOut(ok, "claude", "seat-1")), "signed-out");
  assert.equal(seatStatus(ok), "ok", "input not mutated");
  assert.equal(seatStatus(applySeatSignedOut(mk("unknown"), "claude", "seat-1")), "signed-out");
  const expired = mk("expired");
  assert.equal(applySeatSignedOut(expired, "claude", "seat-1"), expired);
  const out = mk("signed-out");
  assert.equal(applySeatSignedOut(out, "claude", "seat-1"), out);
  assert.equal(applySeatSignedOut(ok, "claude", "seat-9"), ok);
  assert.equal(applySeatSignedOut(ok, "nope", "seat-1"), ok);
  assert.equal(seatStatus(applySeatReadingOk(out, "claude", "seat-1")), "ok");
  assert.equal(applySeatReadingOk(ok, "claude", "seat-1"), ok);
  assert.equal(applySeatReadingOk(expired, "claude", "seat-1"), expired, "a reading does not clear expired");
});
