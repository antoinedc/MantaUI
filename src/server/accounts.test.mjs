import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
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
