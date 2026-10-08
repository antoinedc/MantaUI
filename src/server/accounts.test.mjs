import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyStore,
  normalizeStore,
  planFromOrganization,
  identityFromProfile,
  resolveSeatSource,
  mergeFindings,
  settleProvider,
  nextId,
  compareIds,
  allSeats,
  createAccountsService,
  cleanLabel,
  renameInState,
  removeSeatInState,
  planSeatPlacement,
  addSeatToState,
} from "./accounts.mjs";

const quiet = { warn() {}, log() {} };

// ---- fixtures (all tokens/ids are fake) -----------------------------------

const orgA = { uuid: "org-A", name: "Useronda", organization_type: "claude_team", rate_limit_tier: "default_claude_max_5x", seat_tier: "team_tier_1" };
const profileOf = (uuid, email, org = orgA) => ({ account: { uuid, email }, organization: org });
const idOf = (uuid, email, org = orgA) => identityFromProfile(profileOf(uuid, email, org));

const credsJson = (access, refresh = `r-${access}`) =>
  JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: 9e12 } });

// Fake Anthropic profile endpoint keyed by the Bearer access token.
function fakeFetch(byToken, calls = []) {
  return async (url, init) => {
    const tok = String(init?.headers?.Authorization ?? "").replace("Bearer ", "");
    calls.push(tok);
    const p = byToken[tok];
    return { ok: Boolean(p), status: p ? 200 : 401, json: async () => p };
  };
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "accounts-test-"));
  const paths = {
    root,
    storePath: join(root, "state", "accounts.json"),
    seatsRoot: join(root, "secrets", "accounts"),
    claudeLivePath: join(root, "home", ".claude", ".credentials.json"),
    codexAuthPath: join(root, "home", "opencode-auth.json"),
  };
  await mkdir(join(root, "home", ".claude"), { recursive: true });
  return paths;
}
async function putSeatDir(paths, id, access) {
  const dir = join(paths.seatsRoot, "claude", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".credentials.json"), credsJson(access));
  return dir;
}
const putLive = (paths, access) => writeFile(paths.claudeLivePath, credsJson(access));

// ---- pure: profile → identity ----------------------------------------------

test("planFromOrganization: type + max tier", () => {
  assert.equal(planFromOrganization(orgA), "Team · Max 5x");
  assert.equal(planFromOrganization({ organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" }), "Max 20x");
  assert.equal(planFromOrganization({ organization_type: "claude_max" }), "Max");
  assert.equal(planFromOrganization({ organization_type: "claude_pro" }), "Pro");
  assert.equal(planFromOrganization({}), null);
  assert.equal(planFromOrganization(undefined), null);
});

test("identityFromProfile: needs an account uuid; carries org", () => {
  const id = idOf("u-1", "a@example.com");
  assert.deepEqual(id, { accountUuid: "u-1", email: "a@example.com", orgId: "org-A", orgName: "Useronda", plan: "Team · Max 5x" });
  assert.equal(identityFromProfile({ organization: orgA }), null);
  assert.equal(identityFromProfile(null), null);
});

test("ids: natural order and next free", () => {
  assert.deepEqual(["seat-10", "seat-2", "seat-1", "zzz"].sort(compareIds), ["seat-1", "seat-2", "seat-10", "zzz"]);
  assert.equal(nextId("seat", ["seat-1", "seat-3"]), "seat-2");
  assert.equal(nextId("acct", []), "acct-1");
});

// ---- pure: credential source resolution ------------------------------------

const seatOf = (over = {}) => ({ id: "seat-1", label: "Seat 1", email: null, accountUuid: "u-1", credentialDir: "/d/seat-1", status: "ok", ...over });

test("resolveSeatSource: live login is this seat → LIVE file (fresh copy beats the seat dir)", () => {
  assert.deepEqual(resolveSeatSource({ seat: seatOf(), liveUuid: "u-1", liveAvailable: true, seatCount: 2 }), { kind: "live" });
});

test("resolveSeatSource: live login is someone else → the seat's own directory", () => {
  assert.deepEqual(resolveSeatSource({ seat: seatOf(), liveUuid: "u-2", liveAvailable: true, seatCount: 2 }), { kind: "dir", dir: "/d/seat-1" });
});

test("resolveSeatSource: live identity unknown (lookup failed) → directory when the seat has one", () => {
  assert.deepEqual(resolveSeatSource({ seat: seatOf(), liveUuid: null, liveAvailable: true, seatCount: 2 }), { kind: "dir", dir: "/d/seat-1" });
});

test("resolveSeatSource: a swap flips the source without any re-migration", () => {
  const seat = seatOf();
  assert.equal(resolveSeatSource({ seat, liveUuid: "u-1", liveAvailable: true, seatCount: 2 }).kind, "live");
  assert.equal(resolveSeatSource({ seat, liveUuid: "u-2", liveAvailable: true, seatCount: 2 }).kind, "dir");
});

test("resolveSeatSource: live-only seat (no dir) follows the live file only while it is not known to be someone else", () => {
  const liveOnly = seatOf({ credentialDir: null });
  assert.equal(resolveSeatSource({ seat: liveOnly, liveUuid: "u-1", liveAvailable: true, seatCount: 1 }).kind, "live");
  assert.equal(resolveSeatSource({ seat: liveOnly, liveUuid: "u-2", liveAvailable: true, seatCount: 1 }).kind, "none");
  assert.equal(resolveSeatSource({ seat: liveOnly, liveUuid: null, liveAvailable: true, seatCount: 1 }).kind, "live");
  assert.equal(resolveSeatSource({ seat: liveOnly, liveUuid: "u-1", liveAvailable: false, seatCount: 1 }).kind, "none");
});

test("resolveSeatSource: a lone unidentified seat with a dir reads live when live is also unidentified; with 2+ seats it does not", () => {
  const unknown = seatOf({ accountUuid: null, status: "unknown" });
  assert.equal(resolveSeatSource({ seat: unknown, liveUuid: null, liveAvailable: true, seatCount: 1 }).kind, "live");
  assert.equal(resolveSeatSource({ seat: unknown, liveUuid: null, liveAvailable: true, seatCount: 2 }).kind, "dir");
});

// ---- pure: merge ------------------------------------------------------------

const defaults = { defaultAccountLabel: "Claude" };

test("mergeFindings: two seat dirs of one org become ONE account with two seats; live twin adds nothing", () => {
  const out = mergeFindings(emptyStore().providers.claude, {
    dirs: [
      { id: "seat-2", dir: "/d/seat-2", identity: idOf("u-B", "b@example.com") },
      { id: "seat-1", dir: "/d/seat-1", identity: idOf("u-A", "a@example.com") },
    ],
    live: { present: true, identity: idOf("u-B", "b@example.com") },
  }, defaults);
  assert.equal(out.accounts.length, 1);
  const [acct] = out.accounts;
  assert.equal(acct.label, "Useronda");
  assert.equal(acct.orgId, "org-A");
  assert.equal(acct.plan, "Team · Max 5x");
  assert.deepEqual(acct.seats.map((s) => [s.id, s.label, s.accountUuid, s.status]), [
    ["seat-1", "Seat 1", "u-A", "ok"],
    ["seat-2", "Seat 2", "u-B", "ok"],
  ]);
});

test("mergeFindings: seats of different orgs land in different accounts", () => {
  const other = { ...orgA, uuid: "org-Z", name: "Personal", organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" };
  const out = mergeFindings(emptyStore().providers.claude, {
    dirs: [
      { id: "seat-1", dir: "/d/1", identity: idOf("u-A", "a@e.com") },
      { id: "seat-2", dir: "/d/2", identity: idOf("u-Z", "z@e.com", other) },
    ],
    live: null,
  }, defaults);
  assert.equal(out.accounts.length, 2);
  assert.deepEqual(out.accounts.map((a) => a.label).sort(), ["Personal", "Useronda"]);
});

test("mergeFindings: the live login with no seat directory becomes a live-only seat (no dir)", () => {
  const out = mergeFindings(emptyStore().providers.claude, {
    dirs: [], live: { present: true, identity: idOf("u-A", "a@e.com") },
  }, defaults);
  const seats = allSeats(out);
  assert.equal(seats.length, 1);
  assert.equal(seats[0].credentialDir, null);
  assert.equal(seats[0].id, "seat-1");
  assert.equal(seats[0].accountUuid, "u-A");
});

test("mergeFindings: a live-only seat does not collide with a seat directory's id", () => {
  const out = mergeFindings(emptyStore().providers.claude, {
    dirs: [{ id: "seat-1", dir: "/d/1", identity: idOf("u-A", "a@e.com") }],
    live: { present: true, identity: idOf("u-L", "l@e.com") },
  }, defaults);
  assert.deepEqual(allSeats(out).map((s) => s.id), ["seat-1", "seat-2"]);
  assert.equal(allSeats(out).find((s) => s.id === "seat-2").credentialDir, null);
});

test("mergeFindings: idempotent — same findings twice change nothing", () => {
  const findings = {
    dirs: [
      { id: "seat-1", dir: "/d/1", identity: idOf("u-A", "a@e.com") },
      { id: "seat-2", dir: "/d/2", identity: idOf("u-B", "b@e.com") },
    ],
    live: { present: true, identity: idOf("u-B", "b@e.com") },
  };
  const once = mergeFindings(emptyStore().providers.claude, findings, defaults);
  assert.deepEqual(mergeFindings(once, findings, defaults), once);
});

test("mergeFindings: does not mutate the input state", () => {
  const input = emptyStore().providers.claude;
  const snapshot = structuredClone(input);
  mergeFindings(input, { dirs: [{ id: "seat-1", dir: "/d/1", identity: idOf("u-A", "a@e.com") }], live: null }, defaults);
  assert.deepEqual(input, snapshot);
});

test("mergeFindings: a failed profile call records the seat as unknown (not dropped); a later success identifies it IN PLACE", () => {
  const first = mergeFindings(emptyStore().providers.claude, {
    dirs: [{ id: "seat-1", dir: "/d/1", identity: null }], live: null,
  }, defaults);
  assert.equal(allSeats(first)[0].status, "unknown");
  assert.equal(allSeats(first)[0].accountUuid, null);
  assert.equal(first.accounts[0].label, "Claude");

  const second = mergeFindings(first, {
    dirs: [{ id: "seat-1", dir: "/d/1", identity: idOf("u-A", "a@e.com") }], live: null,
  }, defaults);
  assert.equal(allSeats(second).length, 1);
  assert.equal(allSeats(second)[0].status, "ok");
  assert.equal(second.accounts.length, 1);
  assert.equal(second.accounts[0].label, "Useronda", "the placeholder account was replaced, not kept beside it");
});

test("mergeFindings: a user-edited seat label survives re-identification", () => {
  let st = mergeFindings(emptyStore().providers.claude, {
    dirs: [{ id: "seat-1", dir: "/d/1", identity: null }], live: null,
  }, defaults);
  st.accounts[0].seats[0].label = "My laptop";
  st = mergeFindings(st, { dirs: [{ id: "seat-1", dir: "/d/1", identity: idOf("u-A", "a@e.com") }], live: null }, defaults);
  assert.equal(allSeats(st)[0].label, "My laptop");
});

test("mergeFindings: the same login found as a seat dir AND the live file is one seat (dir adopted by the live-only seat)", () => {
  const live = mergeFindings(emptyStore().providers.claude, { dirs: [], live: { present: true, identity: idOf("u-A", "a@e.com") } }, defaults);
  const out = mergeFindings(live, { dirs: [{ id: "seat-9", dir: "/d/9", identity: idOf("u-A", "a@e.com") }], live: { present: true, identity: idOf("u-A", "a@e.com") } }, defaults);
  assert.equal(allSeats(out).length, 1);
  assert.equal(allSeats(out)[0].credentialDir, "/d/9");
  assert.equal(allSeats(out)[0].id, "seat-1");
});

test("mergeFindings: unidentifiable live login with NO other seat is recorded unknown once; with other seats it is not duplicated", () => {
  const solo = mergeFindings(emptyStore().providers.claude, { dirs: [], live: { present: true, identity: null } }, defaults);
  assert.equal(allSeats(solo).length, 1);
  assert.equal(allSeats(solo)[0].status, "unknown");
  assert.equal(allSeats(mergeFindings(solo, { dirs: [], live: { present: true, identity: null } }, defaults)).length, 1);

  const withDirs = mergeFindings(emptyStore().providers.claude, {
    dirs: [{ id: "seat-1", dir: "/d/1", identity: idOf("u-A", "a@e.com") }],
    live: { present: true, identity: null },
  }, defaults);
  assert.equal(allSeats(withDirs).length, 1);
});

test("mergeFindings: an unknown live placeholder is filled when identity arrives, or dropped if it is a twin of a known seat", () => {
  const placeholder = mergeFindings(emptyStore().providers.claude, { dirs: [], live: { present: true, identity: null } }, defaults);
  const filled = mergeFindings(placeholder, { dirs: [], live: { present: true, identity: idOf("u-A", "a@e.com") } }, defaults);
  assert.equal(allSeats(filled).length, 1);
  assert.equal(allSeats(filled)[0].accountUuid, "u-A");

  const twin = mergeFindings(placeholder, {
    dirs: [{ id: "seat-5", dir: "/d/5", identity: idOf("u-A", "a@e.com") }],
    live: { present: true, identity: idOf("u-A", "a@e.com") },
  }, defaults);
  assert.equal(allSeats(twin).length, 1);
});

test("settleProvider: auto once a second seat appears, never flipped again; active seat defaults to the live one", () => {
  const two = mergeFindings(emptyStore().providers.claude, {
    dirs: [
      { id: "seat-1", dir: "/d/1", identity: idOf("u-A", "a@e.com") },
      { id: "seat-2", dir: "/d/2", identity: idOf("u-B", "b@e.com") },
    ],
    live: null,
  }, defaults);
  const settled = settleProvider(emptyStore().providers.claude, two, "seat-2");
  assert.equal(settled.mode, "auto");
  assert.equal(settled.activeSeatId, "seat-2");

  const userChoseManual = { ...settled, mode: "manual", activeSeatId: "seat-1" };
  const again = settleProvider(settled, userChoseManual, "seat-2");
  assert.equal(again.mode, "manual");
  assert.equal(again.activeSeatId, "seat-1");
});

test("settleProvider: a single seat stays manual; a dangling active seat is repaired", () => {
  const one = mergeFindings(emptyStore().providers.claude, { dirs: [{ id: "seat-1", dir: "/d/1", identity: idOf("u-A", "a@e.com") }], live: null }, defaults);
  assert.equal(settleProvider(emptyStore().providers.claude, one, null).mode, "manual");
  const dangling = { ...one, activeSeatId: "seat-gone" };
  assert.equal(settleProvider(one, dangling, null).activeSeatId, "seat-1");
});

test("normalizeStore: tolerates garbage and keeps both providers", () => {
  assert.deepEqual(normalizeStore(null), emptyStore());
  assert.deepEqual(normalizeStore("x"), emptyStore());
  const n = normalizeStore({ providers: { claude: { mode: "auto", accounts: [{ id: "a", seats: [{ id: "s" }, { nope: 1 }] }, 7] } } });
  assert.equal(n.providers.claude.mode, "auto");
  assert.equal(n.providers.claude.accounts[0].seats.length, 1);
  assert.equal(n.providers.claude.accounts[0].seats[0].status, "unknown");
  assert.ok(n.providers.codex);
});

// ---- the service, against temp dirs + a fake profile endpoint ---------------

test("service: discovers this box's shape (2 seat dirs, live == seat-2) into one account, store is 0600", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B-old");
    await putLive(paths, "tok-B-live");
    const svc = createAccountsService({
      ...paths,
      log: quiet,
      fetchImpl: fakeFetch({
        "tok-A": profileOf("u-A", "a@e.com"),
        "tok-B-old": profileOf("u-B", "b@e.com"),
        "tok-B-live": profileOf("u-B", "b@e.com"),
      }),
    });
    await svc.discover({ force: true });
    const store = JSON.parse(await readFile(paths.storePath, "utf-8"));
    const claude = store.providers.claude;
    assert.equal(claude.accounts.length, 1);
    assert.deepEqual(claude.accounts[0].seats.map((s) => s.id), ["seat-1", "seat-2"]);
    assert.equal(claude.mode, "auto");
    assert.equal(claude.activeSeatId, "seat-2", "the live login's seat is the default active seat");
    assert.equal((await stat(paths.storePath)).mode & 0o777, 0o600);
    // No credential material in the metadata file.
    const raw = await readFile(paths.storePath, "utf-8");
    for (const secret of ["tok-A", "tok-B-old", "tok-B-live", "r-tok"]) assert.equal(raw.includes(secret), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: re-running is cheap — identified seats cost no profile call; only the (cached) live login", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putLive(paths, "tok-A-live");
    const calls = [];
    const svc = createAccountsService({
      ...paths,
      log: quiet,
      fetchImpl: fakeFetch({ "tok-A": profileOf("u-A", "a@e.com"), "tok-A-live": profileOf("u-A", "a@e.com") }, calls),
    });
    await svc.discover({ force: true });
    const first = calls.length;
    assert.equal(first, 2);
    const before = await readFile(paths.storePath, "utf-8");
    await svc.discover({ force: true });
    await svc.discover({ force: true });
    assert.equal(calls.length, first, "no further profile calls");
    assert.equal(await readFile(paths.storePath, "utf-8"), before, "store unchanged");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: a profile failure at startup does not throw, records the seat unknown, and the next run fixes it", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    let up = false;
    const svc = createAccountsService({
      ...paths,
      log: quiet,
      fetchImpl: async (url, init) =>
        up ? fakeFetch({ "tok-A": profileOf("u-A", "a@e.com") })(url, init) : (() => { throw new Error("network down"); })(),
    });
    await svc.discover({ force: true });
    let store = await svc.getStore();
    assert.equal(allSeats(store.providers.claude)[0].status, "unknown");
    up = true;
    await svc.discover({ force: true });
    store = await svc.getStore();
    assert.equal(allSeats(store.providers.claude)[0].status, "ok");
    assert.equal(allSeats(store.providers.claude)[0].email, "a@e.com");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: a directory with no credentials file is not a seat", async () => {
  const paths = await sandbox();
  try {
    await mkdir(join(paths.seatsRoot, "claude", "seat-9"), { recursive: true });
    await writeFile(join(paths.seatsRoot, "claude", "active"), "seat-9");
    const svc = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({}) });
    await svc.discover({ force: true });
    assert.equal(allSeats((await svc.getStore()).providers.claude).length, 0);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: seatsFor reads the LIVE file for the seat whose login is live, the seat dir for the other", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B-old");
    await putLive(paths, "tok-B-live");
    const svc = createAccountsService({
      ...paths,
      log: quiet,
      fetchImpl: fakeFetch({
        "tok-A": profileOf("u-A", "a@e.com"),
        "tok-B-old": profileOf("u-B", "b@e.com"),
        "tok-B-live": profileOf("u-B", "b@e.com"),
      }),
    });
    const plan = await svc.seatsFor("claude");
    assert.equal(plan.mode, "auto");
    const bySeat = Object.fromEntries(plan.seats.map((s) => [s.seatId, s]));
    assert.equal((await bySeat["seat-1"].deps.readCredentials()).accessToken, "tok-A");
    assert.equal((await bySeat["seat-2"].deps.readCredentials()).accessToken, "tok-B-live");
    assert.equal(bySeat["seat-1"].accountLabel, "Useronda");
    assert.equal(bySeat["seat-1"].seatLabel, "Seat 1");

    // A manual swap: seat-1's login becomes the live one. No re-migration needed.
    await putLive(paths, "tok-A-fresh");
    const svc2 = createAccountsService({
      ...paths,
      log: quiet,
      fetchImpl: fakeFetch({ "tok-A-fresh": profileOf("u-A", "a@e.com") }),
    });
    const plan2 = await svc2.seatsFor("claude");
    const by2 = Object.fromEntries(plan2.seats.map((s) => [s.seatId, s]));
    assert.equal((await by2["seat-1"].deps.readCredentials()).accessToken, "tok-A-fresh");
    // seat-2 was live earlier, so its directory was kept in step with the live
    // file (tok-B-live) — the swap away reads the FRESH copy, not tok-B-old.
    assert.equal((await by2["seat-2"].deps.readCredentials()).accessToken, "tok-B-live");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: the live identity is cached by live token — a swap is noticed at once, an unchanged login costs no call", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B");
    await putLive(paths, "tok-B-live");
    const calls = [];
    let t = 1_000;
    const svc = createAccountsService({
      ...paths,
      log: quiet,
      now: () => t,
      fetchImpl: fakeFetch({
        "tok-A": profileOf("u-A", "a@e.com"),
        "tok-B": profileOf("u-B", "b@e.com"),
        "tok-B-live": profileOf("u-B", "b@e.com"),
        "tok-A-live": profileOf("u-A", "a@e.com"),
      }, calls),
    });
    await svc.seatsFor("claude");
    const afterFirst = calls.length;
    t += 5_000;
    await svc.seatsFor("claude");
    assert.equal(calls.length, afterFirst, "unchanged live token: cached");

    await putLive(paths, "tok-A-live"); // the live file now holds seat-1's login
    t += 61_000; // past the discovery rate limit
    const plan = await svc.seatsFor("claude");
    assert.equal(calls.includes("tok-A-live"), true, "new live token was re-identified immediately");
    const by = Object.fromEntries(plan.seats.map((s) => [s.seatId, s]));
    assert.equal((await by["seat-1"].deps.readCredentials()).accessToken, "tok-A-live");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: claudeRefreshTargets = seats NOT read from the live file", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B");
    await putLive(paths, "tok-B-live");
    const svc = createAccountsService({
      ...paths,
      log: quiet,
      fetchImpl: fakeFetch({
        "tok-A": profileOf("u-A", "a@e.com"),
        "tok-B": profileOf("u-B", "b@e.com"),
        "tok-B-live": profileOf("u-B", "b@e.com"),
      }),
    });
    const targets = await svc.claudeRefreshTargets();
    assert.deepEqual(targets, [{ seatId: "seat-1", dir: join(paths.seatsRoot, "claude", "seat-1") }]);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: a single live-only Claude login (the common box) is one seat reading the live file; no refresh target", async () => {
  const paths = await sandbox();
  try {
    await putLive(paths, "tok-L");
    const svc = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({ "tok-L": profileOf("u-L", "l@e.com") }) });
    const plan = await svc.seatsFor("claude");
    assert.equal(plan.seats.length, 1);
    assert.equal(plan.mode, "manual");
    assert.equal((await plan.seats[0].deps.readCredentials()).accessToken, "tok-L");
    assert.deepEqual(await svc.claudeRefreshTargets(), []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: no logins at all → seatsFor is null (the poller keeps its single-credential path)", async () => {
  const paths = await sandbox();
  try {
    const svc = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({}) });
    assert.equal(await svc.seatsFor("claude"), null);
    assert.equal(await svc.seatsFor("codex"), null);
    assert.equal(await svc.seatsFor("kimi"), null);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: Codex — opencode's openai entry is COPIED to seat-1 (0600/0700); auth.json is untouched", async () => {
  const paths = await sandbox();
  try {
    const authText = JSON.stringify({
      anthropic: { type: "oauth", access: "should-not-be-copied" },
      openai: { type: "oauth", refresh: "r-codex", access: "a-codex", expires: 9e12, accountId: "chatgpt-1" },
    });
    await writeFile(paths.codexAuthPath, authText);
    const svc = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({}) });
    await svc.discover({ force: true });

    const store = await svc.getStore();
    const codex = store.providers.codex;
    assert.equal(codex.accounts.length, 1);
    assert.equal(codex.accounts[0].label, "ChatGPT");
    assert.equal(codex.accounts[0].seats[0].accountUuid, "chatgpt-1");

    const dir = join(paths.seatsRoot, "codex", "seat-1");
    const copy = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8"));
    assert.equal(copy.openai.access, "a-codex");
    assert.equal("anthropic" in copy, false);
    assert.equal((await stat(join(dir, "auth.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal(await readFile(paths.codexAuthPath, "utf-8"), authText, "original left in place");
    assert.equal((await readFile(paths.storePath, "utf-8")).includes("a-codex"), false);

    // Idempotent: a second run adds no seat.
    await svc.discover({ force: true });
    assert.equal(allSeats((await svc.getStore()).providers.codex).length, 1);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: Codex seatsFor reads auth.json (fresh) when the accountId matches, the copy when opencode has switched account", async () => {
  const paths = await sandbox();
  try {
    const entry = (access, accountId) => JSON.stringify({ openai: { type: "oauth", refresh: "r", access, expires: 9e12, accountId } });
    await writeFile(paths.codexAuthPath, entry("a-orig", "chatgpt-1"));
    const svc = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({}) });
    await svc.discover({ force: true });

    await writeFile(paths.codexAuthPath, entry("a-refreshed", "chatgpt-1"));
    let plan = await svc.seatsFor("codex");
    assert.equal(await plan.seats[0].deps.readToken(), "a-refreshed");

    await writeFile(paths.codexAuthPath, entry("a-other", "chatgpt-2"));
    plan = await svc.seatsFor("codex");
    // The copy was mirrored from the refreshed auth.json while it was live.
    assert.equal(await plan.seats[0].deps.readToken(), "a-refreshed");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: no openai entry → no codex seat, nothing written", async () => {
  const paths = await sandbox();
  try {
    await writeFile(paths.codexAuthPath, JSON.stringify({ anthropic: { type: "oauth", access: "x" } }));
    const svc = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({}) });
    await svc.discover({ force: true });
    assert.equal(allSeats((await svc.getStore()).providers.codex).length, 0);
    await assert.rejects(stat(join(paths.seatsRoot, "codex")));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

// ---- phase 3: pure store mutations behind accounts:* ------------------------

const provOf = (over = {}) => ({
  mode: "manual",
  activeSeatId: "seat-1",
  accounts: [
    {
      id: "acct-1",
      label: "Work",
      orgId: "org-A",
      orgName: "Useronda",
      plan: "Team",
      seats: [seatOf({ id: "seat-1", accountUuid: "u-1" }), seatOf({ id: "seat-2", label: "Seat 2", accountUuid: "u-2" })],
    },
    { id: "acct-2", label: "Home", orgId: "org-B", orgName: "Home", plan: "Pro", seats: [seatOf({ id: "seat-3", label: "Seat 3", accountUuid: "u-3" })] },
  ],
  ...over,
});

test("cleanLabel: trims, 1-40 chars, no control characters", () => {
  assert.equal(cleanLabel("  Work  "), "Work");
  assert.equal(cleanLabel("x".repeat(40)), "x".repeat(40));
  assert.equal(cleanLabel("x".repeat(41)), null);
  assert.equal(cleanLabel("   "), null);
  assert.equal(cleanLabel(""), null);
  assert.equal(cleanLabel("a\nb"), null);
  assert.equal(cleanLabel("a\u0007b"), null);
  assert.equal(cleanLabel(42), null);
  assert.equal(cleanLabel(undefined), null);
  assert.equal(cleanLabel("Café · Seat 2"), "Café · Seat 2");
});

test("renameInState: renames a seat or an account, null for an unknown id, input not mutated", () => {
  const before = provOf();
  const snapshot = JSON.stringify(before);
  assert.equal(renameInState(before, { kind: "seat", id: "seat-2", label: "Boss" }).accounts[0].seats[1].label, "Boss");
  assert.equal(renameInState(before, { kind: "account", id: "acct-2", label: "Mine" }).accounts[1].label, "Mine");
  assert.equal(renameInState(before, { kind: "seat", id: "nope", label: "x" }), null);
  assert.equal(renameInState(before, { kind: "account", id: "seat-1", label: "x" }), null);
  assert.equal(renameInState(before, { kind: "bogus", id: "seat-1", label: "x" }), null);
  assert.equal(JSON.stringify(before), snapshot);
});

test("removeSeatInState: drops the seat, an emptied account goes with it, active seat is re-pointed", () => {
  const { state, seat } = removeSeatInState(provOf(), "seat-3");
  assert.equal(seat.id, "seat-3");
  assert.deepEqual(state.accounts.map((a) => a.id), ["acct-1"]);
  const r = removeSeatInState(provOf({ activeSeatId: "seat-2" }), "seat-2", "seat-1");
  assert.equal(r.state.activeSeatId, "seat-1", "active falls back to the live seat");
  const r2 = removeSeatInState(provOf({ activeSeatId: "seat-2" }), "seat-2");
  assert.equal(r2.state.activeSeatId, "seat-1", "...else the first remaining seat");
  const r3 = removeSeatInState(provOf({ activeSeatId: "seat-1" }), "seat-3");
  assert.equal(r3.state.activeSeatId, "seat-1", "an unrelated removal leaves the active seat");
  assert.equal(removeSeatInState(provOf(), "nope").seat, null);
});

test("planSeatPlacement: duplicate login, different org (only with a chosen Claude account), else place", () => {
  const state = provOf();
  assert.equal(planSeatPlacement({ state, provider: "claude", identity: idOf("u-2", "b@e.com") }).kind, "duplicate");
  assert.equal(planSeatPlacement({ state, provider: "claude", identity: idOf("u-9", "z@e.com") }).kind, "place");
  const other = idOf("u-9", "z@e.com", { uuid: "org-Z", name: "Zeta", organization_type: "claude_pro" });
  assert.equal(planSeatPlacement({ state, provider: "claude", identity: other }).kind, "place", "no account chosen: grouped by org later");
  const diff = planSeatPlacement({ state, provider: "claude", identity: other, accountId: "acct-1" });
  assert.deepEqual(diff, { kind: "different-org", orgName: "Zeta" });
  assert.equal(planSeatPlacement({ state, provider: "claude", identity: idOf("u-9", "z@e.com"), accountId: "acct-1" }).kind, "place", "same org");
  assert.equal(planSeatPlacement({ state, provider: "codex", identity: { accountUuid: "u-9", orgId: "other" }, accountId: "acct-1" }).kind, "place", "codex has no org to compare");
  assert.equal(planSeatPlacement({ state, provider: "codex", identity: { accountUuid: "u-1" } }).kind, "duplicate");
  assert.equal(planSeatPlacement({ state, provider: "codex", identity: { accountUuid: null } }).kind, "place", "an unidentified login cannot be a duplicate");
});

test("addSeatToState: a chosen account; Claude groups by org; Codex always opens a new account; second seat flips auto", () => {
  const seat4 = { id: "seat-4", label: "Seat 4", email: null, accountUuid: "u-4", credentialDir: "/d/4", status: "ok" };
  const into = addSeatToState(provOf(), { provider: "claude", seat: seat4, identity: idOf("u-4", "d@e.com"), accountId: "acct-2", defaultAccountLabel: "Claude" });
  assert.deepEqual(into.accounts[1].seats.map((s) => s.id), ["seat-3", "seat-4"]);
  assert.equal(addSeatToState(provOf(), { provider: "claude", seat: seat4, identity: null, accountId: "nope", defaultAccountLabel: "Claude" }), null);

  const byOrg = addSeatToState(provOf(), { provider: "claude", seat: seat4, identity: idOf("u-4", "d@e.com"), defaultAccountLabel: "Claude" });
  assert.deepEqual(byOrg.accounts[0].seats.map((s) => s.id), ["seat-1", "seat-2", "seat-4"], "same org → same account");
  const newOrg = addSeatToState(provOf(), { provider: "claude", seat: seat4, identity: idOf("u-4", "d@e.com", { uuid: "org-N", name: "Neo", organization_type: "claude_pro" }), defaultAccountLabel: "Claude" });
  assert.equal(newOrg.accounts.length, 3);
  assert.equal(newOrg.accounts[2].label, "Neo");

  const codexOne = { mode: "manual", activeSeatId: "seat-1", accounts: [{ id: "acct-1", label: "ChatGPT", orgId: null, orgName: null, plan: null, seats: [seatOf({ id: "seat-1", accountUuid: "c-1" })] }] };
  const codex = addSeatToState(codexOne, { provider: "codex", seat: { ...seat4, accountUuid: "c-2" }, identity: { accountUuid: "c-2", email: null, orgId: null, orgName: null, plan: null }, defaultAccountLabel: "ChatGPT" });
  assert.equal(codex.accounts.length, 2, "a Codex login is its own account");
  assert.equal(codex.accounts[1].label, "ChatGPT 2");
  assert.equal(codex.mode, "auto", "the second seat turns automatic mode on");
  const third = addSeatToState(provOf({ mode: "manual" }), { provider: "claude", seat: seat4, identity: idOf("u-4", "d@e.com"), accountId: "acct-1", defaultAccountLabel: "Claude" });
  assert.equal(third.mode, "manual", "mode is only defaulted when going 1 → 2 seats");
});

// ---- phase 3: the service's write path --------------------------------------

test("service.mutate: atomic write, change listener fires for the changed provider only, refusal writes nothing", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    const svc = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({ "tok-A": profileOf("u-A", "a@e.com") }) });
    await svc.discover({ force: true });
    const seen = [];
    const off = svc.onChange((e) => seen.push(e.provider));
    const ok = await svc.mutate("claude", (st) => ({ ...st, mode: "auto" }));
    assert.equal(ok.ok, true);
    assert.deepEqual(seen, ["claude"]);
    assert.equal((await svc.getStore()).providers.claude.mode, "auto");
    assert.equal(JSON.parse(await readFile(paths.storePath, "utf-8")).providers.claude.mode, "auto");
    assert.equal(((await stat(paths.storePath)).mode & 0o777).toString(8), "600");
    const before = await readFile(paths.storePath, "utf-8");
    assert.deepEqual(await svc.mutate("claude", () => null), { ok: false });
    assert.equal(await readFile(paths.storePath, "utf-8"), before, "a refused mutation writes nothing");
    assert.deepEqual(await svc.mutate("bogus", (s) => s), { ok: false });
    off();
    await svc.mutate("claude", (st) => ({ ...st, mode: "manual" }));
    assert.deepEqual(seen, ["claude"], "unsubscribed");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service.mutate: concurrent mutations serialize (no lost update)", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    const svc = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({ "tok-A": profileOf("u-A", "a@e.com") }) });
    await svc.discover({ force: true });
    await Promise.all([
      svc.mutate("claude", async (st) => {
        await new Promise((r) => setTimeout(r, 15));
        return { ...st, mode: "manual" };
      }),
      svc.mutate("claude", (st) => ({ ...st, accounts: st.accounts.map((a) => ({ ...a, label: "Renamed" })) })),
    ]);
    const claude = (await svc.getStore()).providers.claude;
    assert.equal(claude.mode, "manual");
    assert.equal(claude.accounts[0].label, "Renamed");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: a mutation landing DURING discovery wins — discovery's stale result is dropped, not written over it", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    let release;
    const gate = new Promise((r) => (release = r));
    let held = false;
    const svc = createAccountsService({
      ...paths,
      log: quiet,
      fetchImpl: async (url, init) => {
        if (!held) {
          held = true;
          await gate; // discovery is mid-flight (waiting on the profile call)
        }
        return fakeFetch({ "tok-A": profileOf("u-A", "a@e.com") })(url, init);
      },
    });
    const first = svc.discover({ force: true });
    await new Promise((r) => setTimeout(r, 10));
    await svc.mutate("claude", (st) => ({ ...st, mode: "manual", activeSeatId: "keep-me" }));
    release();
    await first;
    const claude = (await svc.getStore()).providers.claude;
    assert.equal(claude.activeSeatId, "keep-me", "the user's change survived");
    assert.equal(claude.mode, "manual");
    await svc.discover({ force: true });
    assert.equal(allSeats((await svc.getStore()).providers.claude).length, 1, "discovery catches up on the next run");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: a RESERVED seat id is not adopted by discovery (the sign-in decides first), and is taken for new ids", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B");
    const svc = createAccountsService({
      ...paths,
      log: quiet,
      fetchImpl: fakeFetch({ "tok-A": profileOf("u-A", "a@e.com"), "tok-B": profileOf("u-B", "b@e.com") }),
    });
    svc.reserveSeat("claude", "seat-2");
    await svc.discover({ force: true });
    assert.deepEqual(allSeats((await svc.getStore()).providers.claude).map((s) => s.id), ["seat-1"]);
    assert.ok((await svc.takenSeatIds("claude")).includes("seat-2"));
    svc.releaseSeat("claude", "seat-2");
    await svc.discover({ force: true });
    assert.deepEqual(allSeats((await svc.getStore()).providers.claude).map((s) => s.id), ["seat-1", "seat-2"]);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service.deleteSeatDir: removes a directory under the seats root and REFUSES anything outside it", async () => {
  const paths = await sandbox();
  try {
    const dir = await putSeatDir(paths, "seat-7", "tok");
    const svc = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({}) });
    assert.equal(await svc.deleteSeatDir(dir), true);
    await assert.rejects(stat(dir));
    const outside = join(paths.root, "home");
    assert.equal(await svc.deleteSeatDir(outside), false);
    assert.equal(await svc.deleteSeatDir(paths.seatsRoot), false, "the root itself");
    assert.equal(await svc.deleteSeatDir(join(paths.seatsRoot, "..", "home")), false, "a traversal");
    assert.equal(await svc.deleteSeatDir(""), false);
    assert.ok((await stat(outside)).isDirectory());
    // Never a whole provider directory (every seat of it), nor a nested path.
    const other = await putSeatDir(paths, "seat-8", "tok");
    assert.equal(await svc.deleteSeatDir(join(paths.seatsRoot, "claude")), false, "a provider dir");
    assert.equal(await svc.deleteSeatDir(join(other, "sub")), false, "below a seat dir");
    assert.ok((await stat(other)).isDirectory());
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

// ---- a live login that is not a seat yet gets its own directory ------------------

test("mergeFindings: ids the caller says are taken are never reused for a live-only seat", () => {
  const out = mergeFindings(emptyStore().providers.claude, {
    dirs: [{ id: "seat-1", dir: "/d/1", identity: idOf("u-A", "a@e.com") }],
    live: { present: true, identity: idOf("u-L", "l@e.com") },
    takenIds: ["seat-2", "seat-3"],
  }, defaults);
  assert.deepEqual(allSeats(out).map((s) => s.id), ["seat-1", "seat-4"]);
});

test("service: a NEW live identity (the old connect flow replaced the live login) is registered WITH its own 0700/0600 directory, and the seat survives the live login changing again", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putLive(paths, "tok-Z-live"); // someone else's login landed in the live file
    const fetchImpl = fakeFetch({
      "tok-A": profileOf("u-A", "a@e.com"),
      "tok-Z-live": profileOf("u-Z", "z@e.com", { ...orgA, uuid: "org-Z", name: "Zeta" }),
      "tok-A-live": profileOf("u-A", "a@e.com"),
    });
    let t = 1_000;
    const svc = createAccountsService({ ...paths, log: quiet, now: () => t, fetchImpl });
    await svc.discover({ force: true });

    const store = await svc.getStore();
    const zeta = allSeats(store.providers.claude).find((x) => x.accountUuid === "u-Z");
    assert.ok(zeta, "the new live identity is a seat");
    assert.ok(zeta.credentialDir, "…with a directory of its own");
    assert.ok(zeta.credentialDir.startsWith(join(paths.seatsRoot, "claude")), "under the seats root");
    const file = join(zeta.credentialDir, ".credentials.json");
    assert.equal((await stat(zeta.credentialDir)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await readFile(file, "utf-8"), credsJson("tok-Z-live"), "a copy of the live login");
    assert.equal(await readFile(paths.claudeLivePath, "utf-8"), credsJson("tok-Z-live"), "the live file is untouched");

    // The live login changes again (the box's own `claude` signs in as seat-1's
    // account). The new seat keeps working from its directory.
    await putLive(paths, "tok-A-live");
    t += 120_000;
    const plan = await svc.seatsFor("claude");
    const by = Object.fromEntries(plan.seats.map((x) => [x.seatId, x]));
    assert.equal((await by[zeta.id].deps.readCredentials()).accessToken, "tok-Z-live", "still signed in");
    assert.equal((await by["seat-1"].deps.readCredentials()).accessToken, "tok-A-live");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: a first-time live login (no seats yet) is registered with a directory copy too, and re-running discovery does not rewrite it", async () => {
  const paths = await sandbox();
  try {
    await putLive(paths, "tok-L");
    const svc = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({ "tok-L": profileOf("u-L", "l@e.com") }) });
    await svc.discover({ force: true });
    const seat = allSeats((await svc.getStore()).providers.claude)[0];
    assert.equal(seat.id, "seat-1");
    const file = join(seat.credentialDir, ".credentials.json");
    assert.equal(await readFile(file, "utf-8"), credsJson("tok-L"));
    const before = (await stat(file)).mtimeMs;
    await svc.discover({ force: true });
    assert.equal((await stat(file)).mtimeMs, before, "idempotent");
    assert.equal((await readdir(join(paths.seatsRoot, "claude"))).length, 1);
    // …and being live it is still read from the live file, never a refresh target.
    assert.deepEqual(await svc.claudeRefreshTargets(), []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("service: the new live seat never takes the directory of a sign-in that is still in flight", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await mkdir(join(paths.seatsRoot, "claude", "seat-2"), { recursive: true }); // a login waiting for its credentials
    await putLive(paths, "tok-Z-live");
    const svc = createAccountsService({
      ...paths,
      log: quiet,
      fetchImpl: fakeFetch({ "tok-A": profileOf("u-A", "a@e.com"), "tok-Z-live": profileOf("u-Z", "z@e.com") }),
    });
    svc.reserveSeat("claude", "seat-2");
    await svc.discover({ force: true });
    const zeta = allSeats((await svc.getStore()).providers.claude).find((x) => x.accountUuid === "u-Z");
    assert.equal(zeta.id, "seat-3");
    await assert.rejects(stat(join(paths.seatsRoot, "claude", "seat-2", ".credentials.json")), "the in-flight directory was not written to");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
