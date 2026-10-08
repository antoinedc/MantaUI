// Multi-account phase 2: sticky per-conversation seat assignment (spec §5.3
// rules 1–2). Pure decisions first, then the service against a fake accounts
// service, then ONE pass over the real accounts service so seatStates (the
// credential source of truth) is exercised end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSIGNMENT_TTL_MS,
  TOUCH_INTERVAL_MS,
  chooseSeat,
  createSeatAssigner,
  decideSeat,
  emptyAssignments,
  normalizeAssignments,
  pruneAssignments,
  resolveRoot,
  seatResult,
} from "./seatAssignment.mjs";
import { createAccountsService } from "./accounts.mjs";

const quiet = { warn() {}, log() {} };
const seat = (n, over = {}) => ({
  seatId: `seat-${n}`,
  accountId: "acct-1",
  live: false,
  usable: true,
  dir: `/d/${n}`,
  file: `/d/${n}/.credentials.json`,
  credential: { expiresAt: 5_000_000 },
  ...over,
});
const snap = (n, pct, extra = {}) => ({ provider: "claude", seatId: `seat-${n}`, windows: [{ kind: "session", pct }], ...extra });

// ---- resolveRoot ------------------------------------------------------------

test("resolveRoot: a plain session is its own conversation", () => {
  assert.deepEqual(resolveRoot({ sessionID: "a", children: {} }), { root: "a", link: null });
});

test("resolveRoot: a sub-agent maps to its parent and the link is recorded", () => {
  assert.deepEqual(resolveRoot({ sessionID: "c", parentSessionID: "p", children: {} }), { root: "p", link: { child: "c", root: "p" } });
});

test("resolveRoot: a known link is not re-recorded; a known child alone resolves to its root", () => {
  const children = { c: { root: "p" } };
  assert.equal(resolveRoot({ sessionID: "c", parentSessionID: "p", children }).link, null);
  assert.deepEqual(resolveRoot({ sessionID: "c", children }), { root: "p", link: null });
});

test("resolveRoot: a grandchild whose parent is itself a known child lands on the ROOT", () => {
  const children = { c: { root: "p" } };
  assert.deepEqual(resolveRoot({ sessionID: "g", parentSessionID: "c", children }), { root: "p", link: { child: "g", root: "p" } });
});

test("resolveRoot: a parent equal to the session is ignored", () => {
  assert.deepEqual(resolveRoot({ sessionID: "a", parentSessionID: "a", children: {} }), { root: "a", link: null });
});

// ---- chooseSeat / decideSeat ------------------------------------------------

test("chooseSeat: manual mode takes the active seat whatever the load", () => {
  const seats = [seat(1), seat(2)];
  assert.equal(chooseSeat({ mode: "manual", activeSeatId: "seat-2", seats, seatSnapshots: [snap(1, 5), snap(2, 90)] }), "seat-2");
});

test("chooseSeat: manual mode with an unusable active seat falls back to the least-loaded usable one", () => {
  const seats = [seat(1), seat(2, { usable: false }), seat(3)];
  assert.equal(chooseSeat({ mode: "manual", activeSeatId: "seat-2", seats, seatSnapshots: [snap(1, 60), snap(3, 10)] }), "seat-3");
});

test("chooseSeat: auto takes the least-loaded seat; ties go to the active seat", () => {
  const seats = [seat(1), seat(2)];
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: [snap(1, 50), snap(2, 20)] }), "seat-2");
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: "seat-2", seats, seatSnapshots: [snap(1, 30), snap(2, 30)] }), "seat-2");
});

test("chooseSeat: a seat with no reading ranks after one with a reading; an exhausted seat last", () => {
  const seats = [seat(1), seat(2), seat(3)];
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats, seatSnapshots: [snap(2, 80)] }), "seat-2");
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats, seatSnapshots: [snap(1, 100, { exhausted: true }), snap(2, 100, { exhausted: true })] }), "seat-3");
});

test("chooseSeat: a seat without usable credentials is never chosen; none usable → null", () => {
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: "seat-1", seats: [seat(1, { usable: false }), seat(2)], seatSnapshots: [snap(1, 0), snap(2, 99)] }), "seat-2");
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats: [seat(1, { usable: false })], seatSnapshots: [] }), null);
});

test("decideSeat: an existing assignment to a usable seat is kept even when another seat is emptier (rule 2)", () => {
  const out = decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: "seat-2", seats: [seat(1), seat(2)], seatSnapshots: [snap(1, 95), snap(2, 1)] });
  assert.deepEqual(out, { seatId: "seat-1", reason: "kept" });
});

test("decideSeat: a vanished or unusable seat releases the conversation to a fresh choice", () => {
  const seats = [seat(1, { usable: false }), seat(2)];
  assert.deepEqual(decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: null, seats, seatSnapshots: [] }), { seatId: "seat-2", reason: "assigned" });
  assert.deepEqual(decideSeat({ existing: { seatId: "seat-9" }, mode: "auto", activeSeatId: null, seats: [seat(2)], seatSnapshots: [] }), { seatId: "seat-2", reason: "assigned" });
  assert.deepEqual(decideSeat({ existing: null, mode: "auto", activeSeatId: null, seats: [seat(1, { usable: false })], seatSnapshots: [] }), { seatId: null, reason: "none" });
});

// ---- seatResult -------------------------------------------------------------

test("seatResult: a live seat carries NO credential; a directory seat names its FILE — never a token", () => {
  assert.deepEqual(seatResult("claude", seat(1, { live: true, dir: null, file: null, credential: null })), { seatId: "seat-1", live: true });
  assert.deepEqual(seatResult("claude", seat(2)), { seatId: "seat-2", live: false, provider: "claude", credentialFile: "/d/2/.credentials.json", expiresAt: 5_000_000 });
  assert.deepEqual(seatResult("codex", seat(3, { credential: { expiresAt: null } })), { seatId: "seat-3", live: false, provider: "codex", credentialFile: "/d/3/.credentials.json" });
  // a seat with nothing readable falls back to live
  assert.deepEqual(seatResult("claude", seat(4, { credential: null })), { seatId: "seat-4", live: true });
  for (const r of [seatResult("claude", seat(2)), seatResult("codex", seat(3))]) {
    assert.doesNotMatch(JSON.stringify(r), /token/i, "no token field or value in an answer");
  }
});

// ---- store hygiene ----------------------------------------------------------

test("normalizeAssignments: garbage in, a well-formed store out", () => {
  assert.deepEqual(normalizeAssignments(null), emptyAssignments());
  const out = normalizeAssignments({
    providers: { claude: { c1: { seatId: "seat-1", assignedAt: 5 }, c2: { seatId: 7 }, "": { seatId: "x" } }, nope: {} },
    children: { k: { root: "c1", at: 3 }, bad: {} },
  });
  assert.deepEqual(out.providers.claude, { c1: { seatId: "seat-1", assignedAt: 5, lastUsedAt: 5 } });
  assert.deepEqual(out.children, { k: { root: "c1", at: 3 } });
});

test("pruneAssignments: drops what nobody touched for 30 days, keeps the rest; same object when nothing to drop", () => {
  const now = 100 * 24 * 3600_000;
  const store = emptyAssignments();
  store.providers.claude.old = { seatId: "seat-1", assignedAt: 0, lastUsedAt: now - ASSIGNMENT_TTL_MS - 1 };
  store.providers.claude.fresh = { seatId: "seat-1", assignedAt: 0, lastUsedAt: now - 1000 };
  store.children.oldkid = { root: "old", at: now - ASSIGNMENT_TTL_MS - 1 };
  store.children.kid = { root: "fresh", at: now };
  const out = pruneAssignments(store, now);
  assert.deepEqual(Object.keys(out.providers.claude), ["fresh"]);
  assert.deepEqual(Object.keys(out.children), ["kid"]);
  assert.equal(pruneAssignments(out, now), out);
});

// ---- the service, fake accounts ---------------------------------------------

function fakeAccounts(initial) {
  const state = { claude: initial, codex: null };
  return {
    state,
    async seatStates(provider) {
      return state[provider] ?? null;
    },
  };
}
function assigner(accounts, over = {}) {
  let saved = null;
  const saves = [];
  let t = 1_000_000;
  const svc = createSeatAssigner({
    accounts,
    listSeatSnapshots: () => over.snaps ?? [],
    refreshSeatCredentials: over.refresh ?? (async () => ({ ok: true })),
    load: () => over.load ?? saved,
    save: async (d) => {
      saved = structuredClone(d);
      saves.push(saved);
    },
    now: () => t,
    notePluginSeen: over.notePluginSeen ?? (() => {}),
    log: quiet,
  });
  return { svc, saves, tick: (ms) => (t += ms), get saved() { return saved; } };
}
const two = (over = {}) => ({ mode: "auto", activeSeatId: "seat-1", seats: [seat(1, { live: true, dir: null, credential: null }), seat(2)], ...over });

test("no seats / unknown provider state → live pass-through with no seat; one seat → that seat, live", async () => {
  const none = assigner(fakeAccounts(null));
  assert.deepEqual(await none.svc.resolve("claude", "s1"), { seatId: null, live: true });
  const one = assigner(fakeAccounts({ mode: "auto", activeSeatId: "seat-1", seats: [seat(1)] }));
  assert.deepEqual(await one.svc.resolve("claude", "s1"), { seatId: "seat-1", live: true });
  assert.equal(one.saves.length, 0, "a single seat records nothing");
});

test("rule 1+2: first request picks least-loaded; later requests keep it even when loads flip", async () => {
  const snaps = [snap(1, 80), snap(2, 10)];
  const a = assigner(fakeAccounts(two()), { snaps });
  const first = await a.svc.resolve("claude", "conv-1");
  assert.equal(first.seatId, "seat-2");
  assert.equal(first.live, false);
  assert.equal(first.credentialFile, "/d/2/.credentials.json");
  snaps.splice(0, 2, snap(1, 5), snap(2, 99));
  assert.equal((await a.svc.resolve("claude", "conv-1")).seatId, "seat-2", "sticky");
  assert.equal((await a.svc.resolve("claude", "conv-2")).seatId, "seat-1", "a NEW conversation uses the new loads");
});

test("a live seat is returned live:true with no token", async () => {
  const a = assigner(fakeAccounts(two()), { snaps: [snap(1, 5), snap(2, 50)] });
  assert.deepEqual(await a.svc.resolve("claude", "c"), { seatId: "seat-1", live: true });
});

test("a sub-agent resolves to its parent's seat, and a deeper chain follows the recorded link", async () => {
  const snaps = [snap(1, 80), snap(2, 10)];
  const a = assigner(fakeAccounts(two()), { snaps });
  const parent = await a.svc.resolve("claude", "p");
  snaps.splice(0, 2, snap(1, 1), snap(2, 99)); // would pick seat-1 for a new conversation
  const child = await a.svc.resolve("claude", "c", "p");
  assert.equal(child.seatId, parent.seatId);
  const grand = await a.svc.resolve("claude", "g", "c");
  assert.equal(grand.seatId, parent.seatId);
  const childAlone = await a.svc.resolve("claude", "c");
  assert.equal(childAlone.seatId, parent.seatId, "known child without the header still maps to its root");
  assert.equal(Object.keys(a.saved.providers.claude).length, 1, "one conversation, one assignment");
});

test("concurrent first requests of one conversation (parent + sub-agent) land on one seat", async () => {
  const a = assigner(fakeAccounts(two()), { snaps: [snap(1, 30), snap(2, 30)] });
  const [x, y] = await Promise.all([a.svc.resolve("claude", "p"), a.svc.resolve("claude", "c", "p")]);
  assert.equal(x.seatId, y.seatId);
});

test("manual mode → the active seat for a new conversation", async () => {
  const a = assigner(fakeAccounts(two({ mode: "manual", activeSeatId: "seat-2" })), { snaps: [snap(1, 0), snap(2, 99)] });
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-2");
});

test("a seat that goes signed-out releases its conversations to a usable seat; none usable → pass-through", async () => {
  const acc = fakeAccounts(two());
  const a = assigner(acc, { snaps: [snap(1, 90), snap(2, 10)] });
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-2");
  acc.state.claude = two({ seats: [seat(1, { live: true, dir: null, credential: null }), seat(2, { usable: false, credential: null })] });
  assert.deepEqual(await a.svc.resolve("claude", "c"), { seatId: "seat-1", live: true });
  acc.state.claude = two({ seats: [seat(1, { usable: false, live: false, credential: null }), seat(2, { usable: false, credential: null })] });
  assert.deepEqual(await a.svc.resolve("claude", "other"), { seatId: null, live: true });
});

test("assignments persist and survive a restart; lastUsedAt is touched at most hourly", async () => {
  const a = assigner(fakeAccounts(two()), { snaps: [snap(1, 80), snap(2, 10)] });
  await a.svc.resolve("claude", "c");
  assert.equal(a.saves.length, 1);
  await a.svc.resolve("claude", "c");
  assert.equal(a.saves.length, 1, "no write on an ordinary repeat");
  a.tick(TOUCH_INTERVAL_MS);
  await a.svc.resolve("claude", "c");
  assert.equal(a.saves.length, 2, "an hourly touch");

  // "Restart": a new assigner over the saved file keeps the seat even though loads now say otherwise.
  const again = assigner(fakeAccounts(two()), { snaps: [snap(1, 1), snap(2, 99)], load: a.saved });
  assert.equal((await again.svc.resolve("claude", "c")).seatId, "seat-2");
});

test("a failing save never fails the request", async () => {
  const svc = createSeatAssigner({
    accounts: fakeAccounts(two()),
    listSeatSnapshots: () => [snap(1, 80), snap(2, 10)],
    refreshSeatCredentials: async () => ({}),
    load: () => null,
    save: async () => {
      throw new Error("disk full");
    },
    notePluginSeen: () => {},
    log: quiet,
  });
  const r = await svc.resolve("claude", "c");
  assert.equal(r.seatId, "seat-2");
  assert.equal(r.credentialFile, "/d/2/.credentials.json");
});

test("bad input is rejected; every resolve and nothing else stamps plugin presence", async () => {
  let seen = 0;
  const a = assigner(fakeAccounts(two()), { notePluginSeen: () => seen++ });
  await assert.rejects(a.svc.resolve("kimi", "c"), /unknown provider/);
  await assert.rejects(a.svc.resolve("claude", ""), /invalid sessionID/);
  await assert.rejects(a.svc.resolve("claude", "c", 7), /invalid parentSessionID/);
  assert.equal(seen, 3, "any call proves the plugin is there, valid or not");
});

// ---- refreshSeat ------------------------------------------------------------

test("refreshSeat: refreshes a non-live seat, returns the re-read state; single-flight per seat", async () => {
  const acc = fakeAccounts(two());
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const a = assigner(acc, {
    refresh: async (provider, t) => {
      calls++;
      assert.deepEqual([provider, t.seatId, t.dir], ["claude", "seat-2", "/d/2"]);
      await gate;
      acc.state.claude = two({ seats: [two().seats[0], seat(2, { credential: { expiresAt: 9_000_000 } })] });
    },
  });
  const p1 = a.svc.refreshSeat("claude", "seat-2");
  const p2 = a.svc.refreshSeat("claude", "seat-2");
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(calls, 1);
  assert.deepEqual(r1, r2);
  assert.equal(r1.expiresAt, 9_000_000, "the re-read state after the refresh");
});

test("refreshSeat: a live seat is never refreshed here; an unknown seat is null", async () => {
  let calls = 0;
  const a = assigner(fakeAccounts(two()), { refresh: async () => calls++ });
  assert.deepEqual(await a.svc.refreshSeat("claude", "seat-1"), { seatId: "seat-1", live: true });
  assert.equal(calls, 0);
  assert.equal(await a.svc.refreshSeat("claude", "seat-9"), null);
});

test("refreshSeat: a refresh that throws still answers with the current state", async () => {
  const a = assigner(fakeAccounts(two()), { refresh: async () => { throw new Error("cli missing"); } });
  assert.equal((await a.svc.refreshSeat("claude", "seat-2")).credentialFile, "/d/2/.credentials.json");
});

// ---- real accounts service: seatStates --------------------------------------

const creds = (access, extra = {}) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `r-${access}`, expiresAt: 9e12, ...extra } });
const org = { uuid: "org-A", name: "Org", organization_type: "claude_team", rate_limit_tier: "default_claude_max_5x" };
const fakeFetch = (byToken) => async (_u, init) => {
  const p = byToken[String(init?.headers?.Authorization ?? "").replace("Bearer ", "")];
  return { ok: Boolean(p), status: p ? 200 : 401, json: async () => p };
};

test("seatStates (real accounts service): a live seat has no credential; a directory seat exposes its FILE and expiry, never a token", async () => {
  const root = await mkdtemp(join(tmpdir(), "seat-assign-"));
  try {
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
    await writeFile(paths.claudeLivePath, creds("tok-A-live"));
    const profiles = {
      "tok-A": { account: { uuid: "u-A", email: "a@x" }, organization: org },
      "tok-A-live": { account: { uuid: "u-A", email: "a@x" }, organization: org },
      "tok-B": { account: { uuid: "u-B", email: "b@x" }, organization: org },
    };
    const accounts = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch(profiles) });
    const states = await accounts.seatStates("claude");
    const byId = Object.fromEntries(states.seats.map((s) => [s.seatId, s]));
    assert.equal(byId["seat-1"].live, true);
    assert.equal(byId["seat-1"].credential, null, "a live seat never carries a credential");
    assert.equal(byId["seat-2"].live, false);
    assert.deepEqual(byId["seat-2"].credential, { expiresAt: 9e12 }, "expiry only — the service never hands out a token");
    assert.equal(byId["seat-2"].file, join(paths.seatsRoot, "claude", "seat-2", ".credentials.json"));
    assert.equal(byId["seat-2"].usable, true);
    assert.doesNotMatch(JSON.stringify(states), /tok-[AB]/);

    const svc = createSeatAssigner({
      accounts,
      listSeatSnapshots: () => [snap(1, 80), snap(2, 10)],
      refreshSeatCredentials: async () => ({}),
      load: () => null,
      save: async () => {},
      notePluginSeen: () => {},
      log: quiet,
    });
    const r = await svc.resolve("claude", "conv");
    assert.equal(r.seatId, "seat-2");
    assert.equal(r.credentialFile, join(paths.seatsRoot, "claude", "seat-2", ".credentials.json"));
    assert.equal(r.expiresAt, 9e12);
    assert.doesNotMatch(JSON.stringify(r), /tok-/);
    assert.equal(await accounts.seatStates("kimi"), null);
    const targets = await accounts.codexRefreshTargets();
    assert.deepEqual(targets, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seatStates (real): a seat whose credentials are unreadable is not usable and is never assigned", async () => {
  const root = await mkdtemp(join(tmpdir(), "seat-assign-"));
  try {
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
    await writeFile(paths.claudeLivePath, creds("tok-A-live"));
    const profiles = {
      "tok-A": { account: { uuid: "u-A" }, organization: org },
      "tok-A-live": { account: { uuid: "u-A" }, organization: org },
      "tok-B": { account: { uuid: "u-B" }, organization: org },
    };
    const accounts = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch(profiles) });
    await accounts.seatStates("claude"); // discover
    await writeFile(join(paths.seatsRoot, "claude", "seat-2", ".credentials.json"), "{}");
    const states = await accounts.seatStates("claude");
    assert.equal(states.seats.find((s) => s.seatId === "seat-2").usable, false);
    const svc = createSeatAssigner({ accounts, listSeatSnapshots: () => [snap(1, 99), snap(2, 0)], refreshSeatCredentials: async () => ({}), load: () => null, save: async () => {}, notePluginSeen: () => {}, log: quiet });
    assert.deepEqual(await svc.resolve("claude", "conv"), { seatId: "seat-1", live: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- the exhausted-seat floor (rule 3, minimal) ------------------------------

import { MOVE_BACK_BLOCK_MS, chooseMoveTarget, isSeatFull } from "./seatAssignment.mjs";

const HOUR = 3_600_000;
const full = (n) => snap(n, 100, { exhausted: true });

test("isSeatFull: provider-flagged exhausted, or an ACTIVE FRESH window at 100%; unknown/inactive/stale is not full", () => {
  assert.equal(isSeatFull(snap(1, 100, { exhausted: true })), true);
  assert.equal(isSeatFull(snap(1, 100)), true);
  assert.equal(isSeatFull(snap(1, 99)), false);
  assert.equal(isSeatFull({ seatId: "s", windows: [{ pct: 100, active: false }, { pct: 20 }] }), false, "an inactive scoped window does not count");
  assert.equal(isSeatFull({ seatId: "s", windows: [{ pct: 100, stale: true }] }), false, "a stale reading is the window that just reset");
  assert.equal(isSeatFull(null), false);
  assert.equal(isSeatFull({ seatId: "s" }), false);
});

test("decideSeat: an existing seat that is FULL is released to a seat with room (auto mode)", () => {
  const out = decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: "seat-1", seats: [seat(1), seat(2), seat(3)], seatSnapshots: [full(1), snap(2, 60), snap(3, 20)], nowMs: 10 * HOUR });
  assert.deepEqual(out, { seatId: "seat-3", reason: "moved", from: "seat-1" });
});

test("decideSeat: a seat at 99% is kept (that is phase 4's 90% rule, not this floor)", () => {
  const out = decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: null, seats: [seat(1), seat(2)], seatSnapshots: [snap(1, 99), snap(2, 0)], nowMs: 0 });
  assert.equal(out.reason, "kept");
});

test("decideSeat: when NO other usable seat has room, the conversation stays", () => {
  const seats = [seat(1), seat(2), seat(3, { usable: false })];
  assert.equal(decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: null, seats, seatSnapshots: [full(1), full(2), snap(3, 0)], nowMs: 0 }).reason, "kept");
  assert.equal(decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: null, seats: [seat(1), seat(2, { usable: false })], seatSnapshots: [full(1), snap(2, 0)], nowMs: 0 }).reason, "kept", "an unusable seat is not 'room'");
});

test("decideSeat: manual mode never moves on its own", () => {
  const out = decideSeat({ existing: { seatId: "seat-1" }, mode: "manual", activeSeatId: "seat-1", seats: [seat(1), seat(2)], seatSnapshots: [full(1), snap(2, 0)], nowMs: 0 });
  assert.equal(out.reason, "kept");
});

test("chooseMoveTarget: a seat left within 5h is skipped while another has room, used when it is the only one", () => {
  const nowMs = 20 * HOUR;
  const seats = [seat(1), seat(2), seat(3)];
  const existing = { seatId: "seat-2", left: { "seat-1": nowMs - HOUR } };
  const snaps = [snap(1, 5), full(2), snap(3, 70)];
  assert.equal(chooseMoveTarget({ existing, seats, seatSnapshots: snaps, nowMs }), "seat-3", "seat-1 is emptier but was left an hour ago");
  assert.equal(chooseMoveTarget({ existing, seats: [seat(1), seat(2)], seatSnapshots: snaps, nowMs }), "seat-1", "the only one with room");
  const old = { seatId: "seat-2", left: { "seat-1": nowMs - MOVE_BACK_BLOCK_MS - 1 } };
  assert.equal(chooseMoveTarget({ existing: old, seats, seatSnapshots: snaps, nowMs }), "seat-1", "after 5h it is eligible again");
});

test("the service records the move and then does not bounce back", async () => {
  const snaps = [snap(1, 20), snap(2, 50)];
  const a = assigner(fakeAccounts(two({ seats: [seat(1), seat(2)] })), { snaps });
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-1");
  snaps.splice(0, 2, full(1), snap(2, 50)); // seat-1 fills up
  const moved = await a.svc.resolve("claude", "c");
  assert.equal(moved.seatId, "seat-2");
  const rec = a.saved.providers.claude.c;
  assert.equal(rec.seatId, "seat-2");
  assert.equal(rec.movedFrom, "seat-1");
  assert.equal(rec.reason, "exhausted");
  assert.equal(typeof rec.movedAt, "number");
  // Now seat-1 has room again and seat-2 fills up: seat-1 was left < 5h ago, but is the ONLY one with room.
  a.tick(HOUR);
  snaps.splice(0, 2, snap(1, 10), full(2));
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-1", "the only seat with room wins over the 5h block");
});

test("the service: a full seat with nowhere to go keeps its conversation (no record change)", async () => {
  const snaps = [snap(1, 20), snap(2, 20)];
  const a = assigner(fakeAccounts(two({ seats: [seat(1), seat(2)] })), { snaps });
  const first = await a.svc.resolve("claude", "c");
  snaps.splice(0, 2, full(1), full(2));
  const again = await a.svc.resolve("claude", "c");
  assert.equal(again.seatId, first.seatId);
  assert.equal(a.saved.providers.claude.c.movedFrom, undefined);
});

test("move bookkeeping survives a save/load round trip", () => {
  const out = normalizeAssignments({ providers: { claude: { c: { seatId: "seat-2", assignedAt: 5, lastUsedAt: 6, movedFrom: "seat-1", movedAt: 5, reason: "exhausted", left: { "seat-1": 5, bad: "x" } } } } });
  assert.deepEqual(out.providers.claude.c, { seatId: "seat-2", assignedAt: 5, lastUsedAt: 6, movedFrom: "seat-1", movedAt: 5, reason: "exhausted", left: { "seat-1": 5 } });
});
