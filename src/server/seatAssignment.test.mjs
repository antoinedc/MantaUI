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

// Org affinity (rule 1): a new conversation prefers a seat whose org has ANOTHER seat under 70.
const orgSeat = (n, org) => seat(n, { accountId: `acct-${org}`, orgId: `org-${org}` });
const pick = (loads, over = {}) => {
  const seats = Object.keys(loads).map((n) => orgSeat(n, over.orgs[n]));
  const seatSnapshots = Object.entries(loads).filter(([, v]) => v !== null).map(([n, v]) => snap(n, v));
  return chooseSeat({ mode: "auto", activeSeatId: over.active ?? null, seats, seatSnapshots });
};

test("chooseSeat auto: org A {10, 90}, org B {30, 30} → B·30 (A·10 has no same-org escape route)", () => {
  assert.equal(pick({ 1: 10, 2: 90, 3: 30, 4: 30 }, { orgs: { 1: "A", 2: "A", 3: "B", 4: "B" } }), "seat-3");
});

test("chooseSeat auto: org A {10, 40}, org B {30, 30} → A·10 (everyone has a route: plain least-loaded)", () => {
  assert.equal(pick({ 1: 10, 2: 40, 3: 30, 4: 30 }, { orgs: { 1: "A", 2: "A", 3: "B", 4: "B" } }), "seat-1");
});

test("chooseSeat auto: a single-seat org {5} next to org B {60, 60} → B·60; once B is past 70 the single seat takes it", () => {
  assert.equal(pick({ 1: 5, 2: 60, 3: 60 }, { orgs: { 1: "A", 2: "B", 3: "B" } }), "seat-2");
  assert.equal(pick({ 1: 5, 2: 75, 3: 80 }, { orgs: { 1: "A", 2: "B", 3: "B" } }), "seat-1", "tier 2: under 70, no route anywhere");
});

test("chooseSeat auto: no seat under 70 → today's least-loaded; unknown-load and full seats are never tier 1/2", () => {
  assert.equal(pick({ 1: 90, 2: 75, 3: 80 }, { orgs: { 1: "A", 2: "A", 3: "B" } }), "seat-2");
  // an unreadable same-org sibling is not an escape route, and an unreadable seat is not 'under 70'
  assert.equal(pick({ 1: 10, 2: null, 3: 40, 4: 40 }, { orgs: { 1: "A", 2: "A", 3: "B", 4: "B" } }), "seat-3", "unknown sibling is no route");
  assert.equal(pick({ 1: null, 2: 85 }, { orgs: { 1: "A", 2: "A" } }), "seat-2", "known beats unknown");
  assert.equal(pick({ 1: 10, 2: 10 }, { orgs: { 1: "A", 2: "A" } }), "seat-1");
  // a full (or limited-marked) sibling is not an escape route either, even if its load reads under 70
  const seats = [orgSeat(1, "A"), orgSeat(2, "A"), orgSeat(3, "B"), orgSeat(4, "B")];
  const snaps = [snap(1, 10), snap(2, 30, { exhausted: true }), snap(3, 30), snap(4, 30)];
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats, seatSnapshots: snaps }), "seat-3");
});

test("chooseSeat auto: ties inside the winning tier go to the active seat; a seat with no org info is its own org (no route)", () => {
  assert.equal(pick({ 1: 30, 2: 30, 3: 30, 4: 30 }, { orgs: { 1: "A", 2: "A", 3: "B", 4: "B" }, active: "seat-4" }), "seat-4");
  const seats = [seat(1, { accountId: undefined }), seat(2, { accountId: undefined }), orgSeat(3, "B"), orgSeat(4, "B")];
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats, seatSnapshots: [snap(1, 5), snap(2, 5), snap(3, 40), snap(4, 40)] }), "seat-3", "unidentified seats have no escape route");
});

test("chooseSeat manual: unchanged — the active seat whatever the org layout", () => {
  const seats = [orgSeat(1, "A"), orgSeat(2, "A"), orgSeat(3, "B"), orgSeat(4, "B")];
  const seatSnapshots = [snap(1, 10), snap(2, 90), snap(3, 30), snap(4, 30)];
  assert.equal(chooseSeat({ mode: "manual", activeSeatId: "seat-1", seats, seatSnapshots }), "seat-1");
  assert.equal(chooseSeat({ mode: "manual", activeSeatId: "seat-2", seats, seatSnapshots }), "seat-2");
  // the active seat is dead → plain least-loaded fallback (no escape-route tiering)
  const dead = seats.map((s) => (s.seatId === "seat-2" ? { ...s, usable: false } : s));
  assert.equal(chooseSeat({ mode: "manual", activeSeatId: "seat-2", seats: dead, seatSnapshots }), "seat-1");
});

test("decideSeat: an existing assignment to a usable seat is kept even when another seat is emptier (rule 2)", () => {
  const out = decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: "seat-2", seats: [seat(1), seat(2)], seatSnapshots: [snap(1, 85), snap(2, 1)] });
  assert.deepEqual(out, { seatId: "seat-1", reason: "kept" });
});

test("decideSeat: a vanished or unusable seat releases the conversation: unusable → a recorded move, vanished → a fresh placement", () => {
  const seats = [seat(1, { usable: false }), seat(2)];
  assert.deepEqual(decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: null, seats, seatSnapshots: [] }), { seatId: "seat-2", reason: "moved", from: "seat-1", why: "unusable", trigger: null, crossOrg: false });
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
    onMoved: over.onMoved ?? null,
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
  snaps.splice(0, 2, snap(1, 5), snap(2, 85));
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
  snaps.splice(0, 2, snap(1, 1), snap(2, 85)); // would pick seat-1 for a new conversation
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
  const again = assigner(fakeAccounts(two()), { snaps: [snap(1, 1), snap(2, 85)], load: a.saved });
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

// ---- rules 3–4: 95 / 70 thresholds, same-org preference, cross-org cap ------------

import { CROSS_ORG_CAP_MS, MOVE_BACK_BLOCK_MS, RESET_SOON_MS, decideMove, describeSeatMove, isSeatFull, seatMoveActivityEntry, seatOrgKey } from "./seatAssignment.mjs";

const HOUR = 3_600_000;
const full = (n) => snap(n, 100, { exhausted: true });
// A seat in org A (account acct-A) / org B.
const inOrg = (n, org, over = {}) => seat(n, { accountId: `acct-${org}`, orgId: `org-${org}`, ...over });
const move = (existing, seats, snaps, nowMs = 100 * HOUR) => decideMove({ existing: { seatId: "seat-1", ...existing }, seats, seatSnapshots: snaps, nowMs, activeSeatId: null });

test("isSeatFull: provider-flagged exhausted, or an ACTIVE FRESH window at 100%; unknown/inactive/stale is not full", () => {
  assert.equal(isSeatFull(snap(1, 100, { exhausted: true })), true);
  assert.equal(isSeatFull(snap(1, 100)), true);
  assert.equal(isSeatFull(snap(1, 99)), false);
  assert.equal(isSeatFull({ seatId: "s", windows: [{ pct: 100, active: false }, { pct: 20 }] }), false, "an inactive scoped window does not count");
  assert.equal(isSeatFull({ seatId: "s", windows: [{ pct: 100, stale: true }] }), false, "a stale reading is the window that just reset");
  assert.equal(isSeatFull(null), false);
  assert.equal(isSeatFull({ seatId: "s" }), false);
});

test("seatOrgKey: the org when known, else the account — an unidentified account is only 'the same org' as itself", () => {
  assert.equal(seatOrgKey({ seatId: "s1", accountId: "a1", orgId: "o" }), seatOrgKey({ seatId: "s2", accountId: "a2", orgId: "o" }));
  assert.notEqual(seatOrgKey({ seatId: "s1", accountId: "a1", orgId: null }), seatOrgKey({ seatId: "s2", accountId: "a2", orgId: null }));
  assert.equal(seatOrgKey({ seatId: "s1", accountId: "a1", orgId: null }), seatOrgKey({ seatId: "s2", accountId: "a1", orgId: null }));
});

test("decideMove: no move below 95 — 85 stays even with an empty seat next door", () => {
  assert.equal(move({}, [seat(1), seat(2)], [snap(1, 85), snap(2, 0)]), null);
  assert.equal(move({}, [seat(1), seat(2)], [snap(1, 94.9), snap(2, 0)]), null);
  assert.equal(move({}, [seat(1), seat(2)], [{ seatId: "seat-1" }, snap(2, 0)]), null, "no reading is not a trigger");
});

test("decideMove regression: a seat at 94% does NOT move a conversation, at 95% it does (the move line is 95)", () => {
  const seats = [seat(1), seat(2)];
  assert.equal(move({}, seats, [snap(1, 94), snap(2, 0)]), null, "94% stays");
  assert.equal(move({}, seats, [snap(1, 94.99), snap(2, 0)]), null, "94.99% stays");
  const out = move({}, seats, [snap(1, 95), snap(2, 0)]);
  assert.equal(out?.seatId, "seat-2", "95% moves");
  assert.equal(out?.why, "load");
});

test("decideMove: at 95 it moves to a seat under 70 — same org first, then least loaded; reports the window that triggered", () => {
  const seats = [inOrg(1, "A"), inOrg(2, "A"), inOrg(3, "A"), inOrg(4, "B")];
  const two = (n, windows) => ({ provider: "claude", seatId: `seat-${n}`, windows });
  const snaps = [
    two(1, [{ kind: "session", pct: 96 }, { kind: "weekly", pct: 30 }]),
    two(2, [{ kind: "session", pct: 40 }]),
    two(3, [{ kind: "session", pct: 20 }]),
    two(4, [{ kind: "session", pct: 0 }]),
  ];
  assert.deepEqual(move({}, seats, snaps), { seatId: "seat-3", from: "seat-1", why: "load", trigger: { kind: "session", pct: 96 }, crossOrg: false }, "same org beats the emptier other-org seat");
  // the weekly window can be the trigger too
  const weekly = [two(1, [{ kind: "session", pct: 10 }, { kind: "weekly", pct: 97 }]), ...snaps.slice(1)];
  assert.deepEqual(move({}, seats, weekly).trigger, { kind: "weekly", pct: 97 });
});

test("decideMove: a same-org seat at 70+ IS room for a 95% conversation (a free move beats a cache re-send to an emptier other-org seat)", () => {
  const seats = [inOrg(1, "A"), inOrg(2, "A"), inOrg(3, "B")];
  const out = move({}, seats, [snap(1, 97), snap(2, 75), snap(3, 10)]);
  assert.equal(out.seatId, "seat-2");
  assert.equal(out.crossOrg, false);
});

test("decideMove: a 95–99% conversation STAYS when no same-org seat is under 95 and no other-org seat is under 70; a same-org seat at 80 takes it", () => {
  const seats = [inOrg(1, "A"), inOrg(2, "A"), inOrg(3, "B")];
  for (const pct of [95, 97, 99]) assert.equal(move({}, seats, [snap(1, pct), snap(2, 95), snap(3, 70)]), null, `${pct}%`);
  assert.equal(move({}, seats, [snap(1, 95), snap(2, 99.9), snap(3, 80)]), null);
  assert.equal(move({}, seats, [snap(1, 95), { seatId: "seat-2" }, { seatId: "seat-3" }]), null, "unknown load is not proven room");
  for (const pct of [95, 97, 99]) assert.equal(move({}, seats, [snap(1, pct), snap(2, 80), snap(3, 70)])?.seatId, "seat-2", `${pct}% → same org at 80`);
});

test("decideMove soft move: a same-org seat at 94 is a target, at 95 it is not (falls to other-org under 70, else stays)", () => {
  const seats = [inOrg(1, "A"), inOrg(2, "A"), inOrg(3, "B")];
  const at94 = move({}, seats, [snap(1, 97), snap(2, 94), snap(3, 10)]);
  assert.equal(at94.seatId, "seat-2");
  assert.equal(at94.crossOrg, false);
  const at95 = move({}, seats, [snap(1, 97), snap(2, 95), snap(3, 10)]);
  assert.equal(at95.seatId, "seat-3");
  assert.equal(at95.crossOrg, true);
  assert.equal(move({}, seats, [snap(1, 97), snap(2, 95), snap(3, 75)]), null, "nothing qualifies → stays");
  // the least-loaded same-org seat wins within the tier
  assert.equal(move({}, [inOrg(1, "A"), inOrg(2, "A"), inOrg(4, "A")], [snap(1, 97), snap(2, 90), snap(4, 80)]).seatId, "seat-4");
});

test("decideMove hard move: a same-org seat with room beats an emptier other-org seat; other-org under 70 beats other-org fuller; unknown load counts as room", () => {
  const seats = [inOrg(1, "A"), inOrg(2, "A"), inOrg(3, "B"), inOrg(4, "B")];
  assert.equal(move({}, seats, [snap(1, 100), snap(2, 92), snap(3, 10), snap(4, 5)]).seatId, "seat-2", "same-org at 92 beats other-org at 5");
  assert.equal(move({}, seats, [full(1), snap(2, 99), snap(3, 85), snap(4, 40)]).seatId, "seat-2", "same-org at 99 is still room");
  assert.equal(move({}, seats, [full(1), full(2), snap(3, 85), snap(4, 40)]).seatId, "seat-4", "no same-org room → other-org under 70");
  assert.equal(move({}, seats, [full(1), full(2), snap(3, 85), snap(4, 90)]).seatId, "seat-3", "no same-org room, none under 70 → least-loaded other-org with room");
  assert.equal(move({}, seats, [full(1), { seatId: "seat-2" }, snap(3, 10), snap(4, 5)]).seatId, "seat-2", "an unreadable same-org seat is still hard-move room");
});

test("decideMove: at 100% (or flagged exhausted) it takes ANY seat with room, same org first", () => {
  const seats = [inOrg(1, "A"), inOrg(2, "A"), inOrg(3, "B")];
  assert.deepEqual(move({}, seats, [snap(1, 100), snap(2, 85), snap(3, 80)]), { seatId: "seat-2", from: "seat-1", why: "exhausted", trigger: { kind: "session", pct: 100 }, crossOrg: false });
  assert.equal(move({}, seats, [full(1), snap(2, 100), snap(3, 80)]).seatId, "seat-3", "a full same-org seat is not room");
  assert.equal(move({}, seats, [full(1), snap(2, 100), full(3)]), null, "nowhere to go → stay");
  // flagged exhausted with no windows still gets a trigger
  assert.deepEqual(move({}, seats, [{ seatId: "seat-1", exhausted: true }, snap(2, 50), snap(3, 0)]).trigger, { kind: "exhausted", pct: 100 });
  // a same-org seat with room beats an emptier other-org one, even a fuller one
  const hard = move({}, seats, [snap(1, 100), snap(2, 85), snap(3, 10)]);
  assert.equal(hard.seatId, "seat-2");
});

test("decideMove: an unusable (signed out / expired) seat releases its conversation; no trigger window; cap does not hold it", () => {
  const seats = [inOrg(1, "A", { usable: false }), inOrg(2, "A"), inOrg(3, "B")];
  assert.deepEqual(move({}, seats, [snap(1, 5), snap(2, 40), snap(3, 10)]), { seatId: "seat-2", from: "seat-1", why: "unusable", trigger: null, crossOrg: false });
  const onlyOther = [inOrg(1, "A", { usable: false }), inOrg(3, "B")];
  const capped = move({ crossOrgMovedAt: 100 * HOUR - HOUR }, onlyOther, [snap(3, 10)]);
  assert.equal(capped.seatId, "seat-3", "a dead seat cannot serve, so the cross-org cap does not trap the conversation on it");
  // even when every other seat is full, a dead seat still hands over
  assert.equal(move({}, [inOrg(1, "A", { usable: false }), inOrg(2, "A")], [full(2)]).seatId, "seat-2");
  assert.equal(move({}, [inOrg(1, "A", { usable: false })], []), null, "no usable seat at all");
});

test("decideMove: cross-org is capped at once per conversation per 5h; same-org moves are not", () => {
  const nowMs = 100 * HOUR;
  const seats = [inOrg(1, "A"), inOrg(2, "A"), inOrg(3, "B")];
  const snaps = [snap(1, 95), snap(2, 96), snap(3, 10)]; // the same org has nothing under 95; only the other org is under 70
  assert.equal(move({}, seats, snaps, nowMs).crossOrg, true, "first cross-org move is allowed");
  assert.equal(move({ crossOrgMovedAt: nowMs - HOUR }, seats, snaps, nowMs), null, "a second one within 5h is refused — it stays");
  assert.equal(move({ crossOrgMovedAt: nowMs - CROSS_ORG_CAP_MS - 1 }, seats, snaps, nowMs).seatId, "seat-3", "after 5h it is allowed again");
  // same-org is never capped by it
  const sameOrg = [snap(1, 95), snap(2, 30), snap(3, 10)];
  assert.equal(move({ crossOrgMovedAt: nowMs - HOUR }, seats, sameOrg, nowMs).seatId, "seat-2");
  // hard move: capped cross-org excluded, falls back to a same-org seat with room
  assert.equal(move({ crossOrgMovedAt: nowMs - HOUR }, seats, [snap(1, 100), snap(2, 85), snap(3, 10)], nowMs).seatId, "seat-2");
  // the cap blocks a SOFT cross-org move; a same-org one is always free
  assert.equal(move({ crossOrgMovedAt: nowMs - HOUR }, seats, [snap(1, 97), snap(2, 90), snap(3, 10)], nowMs).seatId, "seat-2", "soft: same org under 95 is free");
  // a FULL seat is exempt: when its own org has nothing left, it crosses orgs even while capped
  const forced = move({ crossOrgMovedAt: nowMs - HOUR }, seats, [snap(1, 100), snap(2, 100), snap(3, 85)], nowMs);
  assert.equal(forced.seatId, "seat-3", "hard, own org all full, other org has room → moves despite the cap");
  assert.equal(forced.crossOrg, true);
  assert.equal(move({ crossOrgMovedAt: nowMs - HOUR }, [inOrg(1, "A"), inOrg(3, "B")], [snap(1, 100), snap(3, 10)], nowMs).seatId, "seat-3", "full, the only room is cross-org → moves despite the cap");
  // …and an exhausted-flag seat counts as full too
  assert.equal(move({ crossOrgMovedAt: nowMs - HOUR }, [inOrg(1, "A"), inOrg(3, "B")], [full(1), snap(3, 10)], nowMs).seatId, "seat-3");
  // a recently-left other-org seat is still the last resort for a forced move
  assert.equal(move({ crossOrgMovedAt: nowMs - HOUR, left: { "seat-3": nowMs - HOUR } }, [inOrg(1, "A"), inOrg(3, "B")], [snap(1, 100), snap(3, 10)], nowMs).seatId, "seat-3");
  // nothing anywhere with room → stay
  assert.equal(move({ crossOrgMovedAt: nowMs - HOUR }, seats, [snap(1, 100), snap(2, 100), snap(3, 100)], nowMs), null);
  // an unusable seat is exempt: it takes the other-org seat even while capped
  assert.equal(move({ crossOrgMovedAt: nowMs - HOUR }, [inOrg(1, "A", { usable: false }), inOrg(3, "B")], [snap(3, 85)], nowMs).seatId, "seat-3");
});

test("decideMove: a seat left within 5h is never a target for a load move; for a forced move only when it is the only one with room", () => {
  const nowMs = 100 * HOUR;
  const seats = [seat(1), seat(2), seat(3)];
  const left = { "seat-2": nowMs - HOUR };
  assert.equal(move({ left }, seats, [snap(1, 97), snap(2, 5), snap(3, 96)], nowMs), null, "soft: seat-2 is blocked, seat-3 is not under 95 → stay");
  assert.equal(move({ left }, seats, [snap(1, 97), snap(2, 5), snap(3, 60)], nowMs).seatId, "seat-3");
  assert.equal(move({ left }, seats, [snap(1, 100), snap(2, 5), snap(3, 85)], nowMs).seatId, "seat-3", "hard: a non-blocked seat with room wins over the emptier blocked one");
  assert.equal(move({ left }, [seat(1), seat(2)], [snap(1, 100), snap(2, 5)], nowMs).seatId, "seat-2", "hard: the only one with room");
  assert.equal(move({ left: { "seat-2": nowMs - MOVE_BACK_BLOCK_MS - 1 } }, seats, [snap(1, 97), snap(2, 5), snap(3, 80)], nowMs).seatId, "seat-2", "after 5h it is eligible again");
});

test("decideMove: only the conversation's ACTIVE FRESH windows count (an inactive scoped weekly at 99 or a stale 5h reading is not a trigger)", () => {
  const seats = [seat(1), seat(2)];
  const s1 = { seatId: "seat-1", windows: [{ kind: "session", pct: 99, stale: true }, { kind: "weekly_scoped:fable", pct: 99, active: false }, { kind: "weekly", pct: 20 }] };
  assert.equal(move({}, seats, [s1, snap(2, 0)]), null);
});

test("hysteresis: no ping-pong across alternating readings — a conversation that left at 96 does not come back when that seat reads 60", () => {
  const seats = [seat(1), seat(2)];
  let existing = { seatId: "seat-1" };
  let now = 100 * HOUR;
  const moves = [];
  // alternating: whichever seat the conversation is on climbs to ≥95 while the other one sits at 60
  for (let i = 0; i < 12; i++) {
    const onA = existing.seatId === "seat-1";
    const snaps = [snap(1, onA ? 96 : 60), snap(2, onA ? 60 : 96)];
    const d = decideSeat({ existing, mode: "auto", activeSeatId: null, seats, seatSnapshots: snaps, nowMs: now });
    if (d.reason === "moved") {
      moves.push({ at: now, to: d.seatId });
      existing = { seatId: d.seatId, left: { ...(existing.left ?? {}), [d.from]: now } };
    }
    now += 20 * 60_000; // every 20 minutes, 4h in total
  }
  assert.equal(moves.length, 1, `moved ${JSON.stringify(moves)}`);
  assert.equal(moves[0].to, "seat-2");
  // 5h after leaving seat-1 it is eligible again
  const later = decideSeat({ existing, mode: "auto", activeSeatId: null, seats, seatSnapshots: [snap(1, 60), snap(2, 96)], nowMs: 100 * HOUR + 5 * HOUR + 1 });
  assert.equal(later.seatId, "seat-1");
});

test("decideSeat: an existing seat past 95 moves in auto mode with the full record; below 95 it is kept", () => {
  const out = decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: "seat-1", seats: [seat(1), seat(2), seat(3)], seatSnapshots: [full(1), snap(2, 60), snap(3, 20)], nowMs: 10 * HOUR });
  assert.deepEqual(out, { seatId: "seat-3", reason: "moved", from: "seat-1", why: "exhausted", trigger: { kind: "session", pct: 100 }, crossOrg: false });
  const soft = decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: null, seats: [seat(1), seat(2)], seatSnapshots: [snap(1, 99), snap(2, 0)], nowMs: 0 });
  assert.equal(soft.reason, "moved");
  assert.equal(soft.why, "load");
  assert.equal(decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: null, seats: [seat(1), seat(2)], seatSnapshots: [snap(1, 94), snap(2, 0)], nowMs: 0 }).reason, "kept");
});

test("decideSeat: a signed-out seat that still exists is a MOVE with reason 'unusable' (not a silent re-assignment)", () => {
  const out = decideSeat({ existing: { seatId: "seat-1" }, mode: "auto", activeSeatId: null, seats: [seat(1, { usable: false }), seat(2)], seatSnapshots: [], nowMs: 0 });
  assert.equal(out.reason, "moved");
  assert.equal(out.why, "unusable");
  assert.equal(out.trigger, null);
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

test("describeSeatMove / seatMoveActivityEntry: a short human line, counts and labels only", () => {
  const evt = { sessionId: "ses_secret", provider: "claude", from: "seat-1", to: "seat-2", fromLabel: "Seat 1", toLabel: "Seat 2", reason: "load", trigger: { kind: "session", pct: 96 }, crossOrg: false };
  assert.equal(describeSeatMove(evt), "Moved a conversation from Seat 1 (96% of 5h) to Seat 2");
  assert.match(describeSeatMove({ ...evt, trigger: { kind: "weekly", pct: 97 }, crossOrg: true }), /\(97% of weekly\) to Seat 2 — another org, history re-sent$/);
  assert.match(describeSeatMove({ ...evt, reason: "exhausted", trigger: { kind: "session", pct: 100 } }), /\(5h limit reached\)/);
  assert.match(describeSeatMove({ ...evt, reason: "unusable", trigger: null }), /\(signed out\)/);
  const entry = seatMoveActivityEntry(evt);
  assert.equal(entry.kind, "seat-move");
  assert.equal(entry.verdict, "applied");
  assert.deepEqual(entry.evidence, { reason: "load", windowPct: 96, window: "5h" });
  assert.doesNotMatch(JSON.stringify(entry), /ses_secret/, "never a session id");
});

// ---- the service: records, events, cap ---------------------------------------

test("the service records an automatic move with its trigger, publishes the event, and does not bounce back", async () => {
  const snaps = [snap(1, 20), snap(2, 50)];
  const events = [];
  const a = assigner(fakeAccounts(two({ seats: [seat(1, { label: "Seat 1" }), seat(2, { label: "Work · Seat 2" })] })), { snaps, onMoved: (e) => events.push(e) });
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-1");
  snaps.splice(0, 2, snap(1, 96), snap(2, 50)); // seat-1 reaches 96, seat-2 is under 70
  const moved = await a.svc.resolve("claude", "c");
  assert.equal(moved.seatId, "seat-2");
  const rec = a.saved.providers.claude.c;
  assert.equal(rec.seatId, "seat-2");
  assert.equal(rec.movedFrom, "seat-1");
  assert.equal(rec.reason, "load");
  assert.deepEqual(rec.trigger, { kind: "session", pct: 96 });
  assert.equal(rec.crossOrg, false);
  assert.equal(rec.crossOrgMovedAt, undefined);
  assert.equal(typeof rec.movedAt, "number");
  assert.deepEqual(Object.keys(rec.left), ["seat-1"], "a pressure move blocks the seat it left");
  assert.deepEqual(events, [{ sessionId: "c", provider: "claude", from: "seat-1", to: "seat-2", fromLabel: "Seat 1", toLabel: "Work · Seat 2", reason: "load", trigger: { kind: "session", pct: 96 }, crossOrg: false }]);
  // seat-2 climbs to 95 while seat-1 recovers to 60 — seat-1 was left an hour ago: stays
  a.tick(HOUR);
  snaps.splice(0, 2, snap(1, 60), snap(2, 95));
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-2");
  assert.equal(events.length, 1);
  // …until seat-2 is FULL and seat-1 is the only one with room
  snaps.splice(0, 2, snap(1, 10), full(2));
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-1");
  assert.equal(events.length, 2);
  assert.equal(events[1].reason, "exhausted");
});

test("the service: a manual switch is recorded as a move but NOT announced; a full seat with nowhere to go keeps its conversation", async () => {
  const events = [];
  const snaps = [snap(1, 20), snap(2, 20)];
  const acc = fakeAccounts(two({ seats: [seat(1), seat(2)] }));
  const a = assigner(acc, { snaps, onMoved: (e) => events.push(e) });
  const first = await a.svc.resolve("claude", "c");
  snaps.splice(0, 2, full(1), full(2));
  const again = await a.svc.resolve("claude", "c");
  assert.equal(again.seatId, first.seatId);
  assert.equal(a.saved.providers.claude.c.movedFrom, undefined);
  acc.state.claude = { ...acc.state.claude, mode: "manual", activeSeatId: "seat-2" };
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-2");
  assert.equal(a.saved.providers.claude.c.reason, "manual");
  assert.equal(events.length, 0);
});

test("the service: a cross-org move stamps crossOrgMovedAt and a second one within 5h is refused; same-org is free", async () => {
  const snaps = [snap(1, 20), snap(2, 80), snap(3, 80)];
  const events = [];
  const seats = [inOrg(1, "A"), inOrg(2, "A"), inOrg(3, "B")];
  const a = assigner(fakeAccounts(two({ seats })), { snaps, onMoved: (e) => events.push(e) });
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-1");
  snaps.splice(0, 3, snap(1, 97), snap(2, 96), snap(3, 30)); // the same org has nothing under 95; only the other org has room under 70
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-3");
  const rec = a.saved.providers.claude.c;
  assert.equal(rec.crossOrg, true);
  assert.equal(typeof rec.crossOrgMovedAt, "number");
  assert.equal(events[0].crossOrg, true);
  // 2h later seat-3 (org B) reaches 97; only seat-2 (same org as seat-1, other org than seat-3) is under 70 → cross-org again → refused
  a.tick(2 * HOUR);
  snaps.splice(0, 3, snap(1, 97), snap(2, 30), snap(3, 97));
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-3", "capped: stays");
  assert.equal(events.length, 1);
  // 4h more: 6h since the first cross-org move — allowed (seat-1 was left 6h ago too)
  a.tick(4 * HOUR);
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-2");
  assert.equal(events.length, 2);
});

test("the service: a capped conversation whose whole org is full still crosses orgs (no stall until reset)", async () => {
  const snaps = [snap(1, 20), snap(2, 80), snap(3, 80)];
  const events = [];
  const seats = [inOrg(1, "A"), inOrg(2, "A"), inOrg(3, "B")];
  const a = assigner(fakeAccounts(two({ seats })), { snaps, onMoved: (e) => events.push(e) });
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-1");
  snaps.splice(0, 3, snap(1, 97), snap(2, 96), snap(3, 30));
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-3", "first cross-org move");
  a.tick(HOUR);
  snaps.splice(0, 3, snap(1, 20), snap(2, 30), snap(3, 100)); // seat-3 (org B, its only seat) is now full
  assert.equal((await a.svc.resolve("claude", "c")).seatId, "seat-2", "forced back across orgs within the cap window");
  assert.equal(events.at(-1).crossOrg, true);
  assert.equal(events.at(-1).reason, "exhausted");
});

test("move bookkeeping survives a save/load round trip", () => {
  const raw = { providers: { claude: { c: { seatId: "seat-2", assignedAt: 5, lastUsedAt: 6, movedFrom: "seat-1", movedAt: 5, reason: "load", trigger: { kind: "session", pct: 96 }, crossOrg: true, crossOrgMovedAt: 5, left: { "seat-1": 5, bad: "x" } } } } };
  const out = normalizeAssignments(raw);
  assert.deepEqual(out.providers.claude.c, { seatId: "seat-2", assignedAt: 5, lastUsedAt: 6, movedFrom: "seat-1", movedAt: 5, reason: "load", trigger: { kind: "session", pct: 96 }, crossOrg: true, crossOrgMovedAt: 5, left: { "seat-1": 5 } });
  const legacy = normalizeAssignments({ providers: { claude: { c: { seatId: "seat-2", assignedAt: 5, lastUsedAt: 6, movedFrom: "seat-1", movedAt: 5, reason: "exhausted", trigger: { kind: 3 } } } } });
  assert.deepEqual(legacy.providers.claude.c, { seatId: "seat-2", assignedAt: 5, lastUsedAt: 6, movedFrom: "seat-1", movedAt: 5, reason: "exhausted" });
});

test("decideMove: the dead-seat fallback is plain least-loaded over the other usable seats (every other seat is full)", () => {
  const seats = [inOrg(1, "A", { usable: false }), inOrg(2, "A"), inOrg(3, "B"), inOrg(4, "B")];
  // Org B has the only same-org pair (an escape route for a NEW conversation) — the fallback must ignore that.
  const snaps = [snap(2, 10, { exhausted: true }), snap(3, 50, { exhausted: true }), snap(4, 60, { exhausted: true })];
  const out = move({}, seats, snaps);
  assert.equal(out.seatId, "seat-2", "the least-loaded seat, whatever its org");
  assert.equal(out.why, "unusable");
});

test("the service: a new conversation on org A {10, 90} / org B {30, 30} lands on B — and so does the next-seat hint", async () => {
  const seats = [inOrg(1, "A"), inOrg(2, "A"), inOrg(3, "B"), inOrg(4, "B")];
  const snaps = [snap(1, 10), snap(2, 90), snap(3, 30), snap(4, 30)];
  const a = assigner(fakeAccounts(two({ seats, activeSeatId: "seat-1" })), { snaps });
  const placed = await a.svc.resolve("claude", "conv-new");
  assert.equal(placed.seatId, "seat-3");
  const { nextSeatFor } = await import("./accountsViews.mjs");
  assert.equal(
    nextSeatFor({ mode: "auto", activeSeatId: "seat-1", seats: seats.map((s) => ({ seatId: s.seatId, usable: s.usable, accountId: s.accountId, orgId: s.orgId })), seatSnapshots: snaps }),
    placed.seatId,
    "the hint names the seat the resolver then picks",
  );
});

// ---- model-scoped limits: a capped model must not make a seat full for every model ----

const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5";
// 5h at `pct`, plus a model-scoped Fable weekly at `fablePct`.
const scoped = (n, pct, fablePct, extra = {}) => ({
  provider: "claude",
  seatId: `seat-${n}`,
  windows: [{ kind: "session", pct }, { kind: "weekly_scoped:fable", scope: "Fable", pct: fablePct }],
  ...extra,
});

test("isSeatFull: a 100% model-scoped window fills the seat only for its own model", () => {
  const s = scoped(1, 0, 100);
  assert.equal(isSeatFull(s), false, "model unknown → scoped ignored");
  assert.equal(isSeatFull(s, { model: OPUS }), false);
  assert.equal(isSeatFull(s, { model: FABLE }), true);
});

test("decideMove: a conversation on a 5h-full seat moves to a seat whose only 100% window is Fable-scoped — for Opus, not for Fable", () => {
  const seats = [seat(1), seat(2), seat(3)];
  const snaps = [snap(1, 100), scoped(2, 0, 100), scoped(3, 0, 100)];
  const run = (model) => decideMove({ existing: { seatId: "seat-1" }, seats, seatSnapshots: snaps, nowMs: 100 * HOUR, activeSeatId: null, model });
  const opus = run(OPUS);
  assert.equal(opus?.why, "exhausted");
  assert.ok(["seat-2", "seat-3"].includes(opus.seatId));
  assert.equal(run(null)?.seatId, opus.seatId, "model unknown → scoped ignored → same move");
  assert.equal(run(FABLE), null, "for Fable every other seat is full");
  // …and when one seat has Fable room, that is the Fable target.
  const withRoom = [snap(1, 100), scoped(2, 0, 100), scoped(3, 30, 40)];
  assert.equal(decideMove({ existing: { seatId: "seat-1" }, seats, seatSnapshots: withRoom, nowMs: 100 * HOUR, model: FABLE }).seatId, "seat-3");
});

test("decideMove: a conversation on a seat whose only full window is the Fable scope stays put when it is not on Fable", () => {
  const seats = [seat(1), seat(2)];
  const snaps = [scoped(1, 10, 100), snap(2, 0)];
  assert.equal(decideMove({ existing: { seatId: "seat-1" }, seats, seatSnapshots: snaps, nowMs: 100 * HOUR, model: OPUS }), null);
  assert.equal(decideMove({ existing: { seatId: "seat-1" }, seats, seatSnapshots: snaps, nowMs: 100 * HOUR, model: FABLE })?.seatId, "seat-2");
});

test("chooseSeat / decideSeat: a Fable-capped seat is a placement target for Opus, never for Fable", () => {
  const seats = [seat(1), seat(2)];
  const snaps = [scoped(1, 0, 100), snap(2, 50)];
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats, seatSnapshots: snaps, model: OPUS }), "seat-1");
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats, seatSnapshots: snaps, model: FABLE }), "seat-2");
  assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats, seatSnapshots: snaps }), "seat-1", "no model → scoped ignored");
  const d = decideSeat({ existing: { seatId: "seat-2" }, mode: "auto", activeSeatId: null, seats, seatSnapshots: [scoped(1, 0, 100), snap(2, 100)], nowMs: 100 * HOUR, model: OPUS });
  assert.equal(d.reason, "moved");
  assert.equal(d.seatId, "seat-1");
});

test("normalizeAssignments: a valid model is kept, an invalid one dropped", () => {
  const out = normalizeAssignments({ providers: { claude: {
    ok: { seatId: "seat-1", assignedAt: 5, model: OPUS },
    num: { seatId: "seat-1", assignedAt: 5, model: 7 },
    empty: { seatId: "seat-1", assignedAt: 5, model: "" },
    long: { seatId: "seat-1", assignedAt: 5, model: "m".repeat(201) },
  } } });
  assert.equal(out.providers.claude.ok.model, OPUS);
  for (const k of ["num", "empty", "long"]) assert.equal("model" in out.providers.claude[k], false, k);
});

// Today's live scenario: 3 seats, the conversation's seat at 100% of its 5h, the other
// two at 0% of 5h but 100% of the Fable weekly. An Opus conversation must move.
const liveSeats = () => two({ seats: [seat(1), seat(2), seat(3)], activeSeatId: "seat-1" });
const liveSnaps = [snap(1, 100), scoped(2, 0, 100), scoped(3, 0, 100)];

test("the service: resolve records the request's model, only rewriting the store when it changes", async () => {
  const a = assigner(fakeAccounts(liveSeats()), { snaps: [snap(1, 10), snap(2, 50), snap(3, 50)] });
  await a.svc.resolve("claude", "c1", null, { model: OPUS });
  assert.equal(a.svc.assignments("claude").c1.model, OPUS);
  const saves = a.saves.length;
  await a.svc.resolve("claude", "c1", null, { model: OPUS });
  assert.equal(a.saves.length, saves, "same model → no write");
  await a.svc.resolve("claude", "c1", null, { model: FABLE });
  assert.equal(a.svc.assignments("claude").c1.model, FABLE);
  assert.equal(a.saves.length, saves + 1, "a changed model is persisted");
  assert.equal(a.saved.providers.claude.c1.model, FABLE);
  await a.svc.resolve("claude", "c1", null, { model: "m".repeat(201) });
  assert.equal(a.svc.assignments("claude").c1.model, FABLE, "a malformed model is ignored");
  await a.svc.resolve("claude", "c1");
  assert.equal(a.svc.assignments("claude").c1.model, FABLE, "no model keeps the stored one");
});

test("the service: reconsider uses the stored model — an Opus conversation on a 5h-full seat moves past Fable-capped seats", async () => {
  const snaps = [snap(1, 10), snap(2, 10), snap(3, 10)];
  const moved = [];
  const a = assigner(fakeAccounts(liveSeats()), { snaps, onMoved: (e) => moved.push(e) });
  // The conversation is placed on seat-1 for Opus, then seat-1 hits its 5h limit.
  const first = await a.svc.resolve("claude", "opus-conv", null, { model: OPUS });
  assert.equal(first.seatId, "seat-1", "least-loaded tie goes to the active seat");
  snaps.splice(0, snaps.length, ...liveSnaps);
  assert.equal(a.svc.conversationSeatFull("claude", "opus-conv"), true);
  const res = await a.svc.reconsider("claude", "opus-conv");
  assert.equal(res.moved, true);
  assert.ok(["seat-2", "seat-3"].includes(res.to));
  assert.equal(res.reason, "exhausted");
  assert.equal(a.svc.assignments("claude")["opus-conv"].model, OPUS, "the model survives the move");
  assert.equal(moved.length, 1);
});

test("the service: a Fable conversation in the same situation has nowhere to go; a conversation with no stored model is treated as unknown (scoped ignored)", async () => {
  const snaps = [snap(1, 10), snap(2, 10), snap(3, 10)];
  const a = assigner(fakeAccounts(liveSeats()), { snaps });
  await a.svc.resolve("claude", "fable-conv", null, { model: FABLE });
  await a.svc.resolve("claude", "legacy-conv"); // a plugin that sends no model
  snaps.splice(0, snaps.length, ...liveSnaps);
  assert.deepEqual(await a.svc.reconsider("claude", "fable-conv"), { moved: false });
  assert.equal((await a.svc.reconsider("claude", "legacy-conv")).moved, true);
  // A model passed to reconsider (the model of the request that just failed) beats the stored one.
  const c = assigner(fakeAccounts(liveSeats()), { snaps });
  c.svc._store().providers.claude.x = { seatId: "seat-1", assignedAt: 1, lastUsedAt: 1, model: OPUS };
  assert.deepEqual(await c.svc.reconsider("claude", "x", { model: FABLE }), { moved: false });
  assert.equal((await c.svc.reconsider("claude", "x", { model: OPUS })).moved, true);
});

test("the service: a sub-agent on another model decides with its own model but never overwrites the conversation's stored model", async () => {
  const a = assigner(fakeAccounts(liveSeats()), { snaps: [snap(1, 10), snap(2, 50), snap(3, 50)] });
  await a.svc.resolve("claude", "root", null, { model: OPUS });
  const saves = a.saves.length;
  await a.svc.resolve("claude", "kid", "root", { model: "claude-sonnet-5-5" });
  await a.svc.resolve("claude", "root", null, { model: OPUS });
  await a.svc.resolve("claude", "kid", "root", { model: "claude-sonnet-5-5" });
  assert.equal(a.svc.assignments("claude").root.model, OPUS);
  assert.equal(a.saves.length, saves + 1, "only the child link is written, no model flip-flop");
});

// ---- rule 4: use it or lose it ----------------------------------------------

{
  const NOW = 100 * HOUR;
  const MIN = 60_000;
  // A seat whose 5h window is at `pct` and resets in `inMs` (null → not started).
  const at = (n, pct, inMs = null, extra = {}) => ({
    provider: "claude",
    seatId: `seat-${n}`,
    windows: [{ kind: "session", pct, ...(inMs == null ? {} : { resetsAt: NOW + inMs }) }],
    ...extra,
  });
  const org = (n, over) => inOrg(n, "A", over);

  test("rule 4: a NEW conversation takes the seat resetting within the hour over a freshly reset one", () => {
    const seats = [org(1), org(2), org(3)];
    const snaps = [at(1, 0), at(2, 60, 30 * MIN), at(3, 10, 3 * HOUR)];
    assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats, seatSnapshots: snaps, nowMs: NOW }), "seat-2");
    assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats, seatSnapshots: snaps }), "seat-1", "no clock → least-loaded as before");
    assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats, seatSnapshots: [at(1, 0), at(2, 60, 2 * HOUR), at(3, 10, 3 * HOUR)], nowMs: NOW }), "seat-1", "outside the hour → least-loaded");
    assert.equal(chooseSeat({ mode: "manual", activeSeatId: "seat-3", seats, seatSnapshots: snaps, nowMs: NOW }), "seat-3", "manual untouched");
    // the escape-route tier still comes first: a soon seat is only preferred within its tier
    const lone = [org(1), org(2), inOrg(3, "B")];
    assert.equal(chooseSeat({ mode: "auto", activeSeatId: null, seats: lone, seatSnapshots: [at(1, 20), at(2, 30), at(3, 10, 10 * MIN)], nowMs: NOW }), "seat-1");
  });

  test("rule 4: a conversation below 95 moves to a same-org seat resetting within the hour (under 70) — reason reset-soon", () => {
    const seats = [org(1), org(2), org(3)];
    const snaps = [at(1, 5, 4 * HOUR), at(2, 50, 30 * MIN), at(3, 0)];
    assert.deepEqual(move({}, seats, snaps, NOW), { seatId: "seat-2", from: "seat-1", why: "reset-soon", trigger: null, crossOrg: false });
    assert.equal(move({}, seats, [at(1, 5), at(2, 50, 30 * MIN)], NOW)?.seatId, "seat-2", "own window not started");
  });

  test("rule 4: no reset-soon move when its own seat resets soon too, the target has no room, was left within 5h, or is another org", () => {
    const seats = [org(1), org(2)];
    assert.equal(move({}, seats, [at(1, 5, 40 * MIN), at(2, 50, 20 * MIN)], NOW), null, "own seat resets within the hour");
    assert.equal(move({}, seats, [at(1, 5), at(2, 70, 20 * MIN)], NOW), null, "target at 70");
    assert.equal(move({}, seats, [at(1, 5), at(2, 100, 20 * MIN, { exhausted: true })], NOW), null, "target full");
    assert.equal(move({ left: { "seat-2": NOW - HOUR } }, seats, [at(1, 5), at(2, 50, 20 * MIN)], NOW), null, "left within 5h");
    assert.equal(move({}, [org(1), inOrg(2, "B")], [at(1, 5), at(2, 50, 20 * MIN)], NOW), null, "another org: no re-send for this");
    assert.equal(move({}, seats, [at(1, 5), at(2, 50, RESET_SOON_MS + MIN)], NOW), null, "outside the hour");
  });

  test("rule 4: a load move (95) prefers, among its targets, the one resetting within the hour", () => {
    const seats = [org(1), org(2), org(3)];
    const out = move({}, seats, [at(1, 96, 3 * HOUR), at(2, 10, 4 * HOUR), at(3, 50, 15 * MIN)], NOW);
    assert.equal(out.seatId, "seat-3");
    assert.equal(out.why, "load");
  });

  test("rule 4: describeSeatMove names a reset-soon move", () => {
    assert.equal(
      describeSeatMove({ fromLabel: "Seat 1", toLabel: "Seat 2", reason: "reset-soon", trigger: null }),
      "Moved a conversation from Seat 1 to Seat 2 (its limit resets within the hour — its remaining quota goes first)",
    );
  });

  test("rule 4, the service: a reset-soon move is recorded and announced; the conversation then stays", async () => {
    const states = { mode: "auto", activeSeatId: "seat-1", seats: [org(1, { live: true }), org(2, { live: true })] };
    const snaps = [at(1, 0), at(2, 80)];
    const moved = [];
    let saved = null;
    let t = NOW;
    const svc = createSeatAssigner({
      accounts: { seatStates: async () => structuredClone(states) },
      listSeatSnapshots: () => snaps,
      refreshSeatCredentials: async () => ({}),
      load: () => saved,
      save: async (d) => (saved = structuredClone(d)),
      now: () => t,
      notePluginSeen: () => {},
      onMoved: (e) => moved.push(e),
      log: quiet,
    });
    assert.equal((await svc.resolve("claude", "conv")).seatId, "seat-1");
    snaps.splice(0, 2, at(1, 5, 4 * HOUR), at(2, 50, 30 * MIN));
    assert.equal((await svc.resolve("claude", "conv")).seatId, "seat-2");
    assert.equal(saved.providers.claude.conv.reason, "reset-soon");
    assert.equal(moved.length, 1);
    assert.equal(moved[0].reason, "reset-soon");
    assert.equal(saved.providers.claude.conv.movedFrom, "seat-1");
    assert.ok(!("seat-1" in (saved.providers.claude.conv.left ?? {})), "a reset-soon move does not block the seat it left");
    t += 10 * MIN;
    assert.equal((await svc.resolve("claude", "conv")).seatId, "seat-2", "on a seat that resets soon it stays");
  });

  test("rule 4, the service: a reset-soon move keeps the unexpired left entries it already had, and adds none", async () => {
    const states = { mode: "auto", activeSeatId: "seat-1", seats: [org(1, { live: true }), org(2, { live: true }), org(3, { live: true })] };
    const snaps = [at(1, 5, 4 * HOUR), at(2, 50, 30 * MIN), at(3, 99)];
    let saved = {
      providers: { claude: { conv: { seatId: "seat-1", assignedAt: NOW - HOUR, lastUsedAt: NOW - HOUR, left: { "seat-3": NOW - HOUR, "seat-9": NOW - 6 * HOUR } } }, codex: {} },
      children: {},
    };
    const svc = createSeatAssigner({
      accounts: { seatStates: async () => structuredClone(states) },
      listSeatSnapshots: () => snaps,
      refreshSeatCredentials: async () => ({}),
      load: () => saved,
      save: async (d) => (saved = structuredClone(d)),
      now: () => NOW,
      notePluginSeen: () => {},
      log: quiet,
    });
    assert.equal((await svc.resolve("claude", "conv")).seatId, "seat-2");
    const rec = saved.providers.claude.conv;
    assert.equal(rec.reason, "reset-soon");
    assert.deepEqual(rec.left, { "seat-3": NOW - HOUR }, "the unexpired entry survives, the expired one is dropped, seat-1 is not added");
  });
}
