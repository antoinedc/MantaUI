// Multi-account phase 2: a Claude seat whose refresh token is dead becomes
// "expired" (never chosen), and a later successful refresh makes it "ok" again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRefreshOutcome, createAccountsService, emptyStore } from "./accounts.mjs";
import { createSeatAssigner } from "./seatAssignment.mjs";
import { createCredentialRefreshSweep, refreshClaudeSeatAndNote, refreshCodexSeatAndNote } from "./opencode.mjs";

const quiet = { warn() {}, log() {} };
const storeWith = (status, provider = "claude") => {
  const s = emptyStore();
  s.providers[provider].accounts = [{ id: "acct-1", label: "A", orgId: null, orgName: null, plan: null, seats: [
    { id: "seat-1", label: "Seat 1", email: null, accountUuid: "u1", credentialDir: "/d/1", status: "ok" },
    { id: "seat-2", label: "Seat 2", email: null, accountUuid: "u2", credentialDir: "/d/2", status },
  ] }];
  return s;
};
const statusOf = (store, provider = "claude") => store.providers[provider].accounts[0].seats[1].status;

test("applyRefreshOutcome: refresh-token-expired → expired; success on an expired seat → ok", () => {
  const ok = storeWith("ok");
  const expired = applyRefreshOutcome(ok, "claude", "seat-2", { ok: false, reason: "refresh-token-expired" });
  assert.equal(statusOf(expired), "expired");
  assert.equal(statusOf(ok), "ok", "the input is not mutated");
  const back = applyRefreshOutcome(expired, "claude", "seat-2", { ok: true, expiresAt: 9 });
  assert.equal(statusOf(back), "ok");
});

test("applyRefreshOutcome: a transient failure, an unrelated status, an unknown seat or provider changes nothing (same object)", () => {
  const ok = storeWith("ok");
  assert.equal(applyRefreshOutcome(ok, "claude", "seat-2", { ok: false, reason: "failed" }), ok);
  assert.equal(applyRefreshOutcome(ok, "claude", "seat-2", { ok: false, reason: "no-credentials" }), ok);
  assert.equal(applyRefreshOutcome(ok, "claude", "seat-2", { ok: true }), ok, "a success on a healthy seat is not a change");
  assert.equal(applyRefreshOutcome(ok, "claude", "seat-9", { ok: false, reason: "refresh-token-expired" }), ok);
  assert.equal(applyRefreshOutcome(ok, "claude", "seat-2", undefined), ok);
  const out = storeWith("signed-out");
  assert.equal(applyRefreshOutcome(out, "claude", "seat-2", { ok: false, reason: "refresh-token-expired" }), out, "a status set by something else is not overwritten");
  assert.equal(applyRefreshOutcome(out, "claude", "seat-2", { ok: true }), out);
  const codex = storeWith("ok", "codex");
  assert.equal(applyRefreshOutcome(codex, "codex", "seat-2", { ok: false, reason: "refresh-token-expired" }), codex, "each provider has its own dead-token reason");
  assert.equal(applyRefreshOutcome(ok, "claude", "seat-2", { ok: false, reason: "refresh-token-rejected" }), ok);
  for (const reason of ["network", "http-503", "bad-response", "write-failed", "no-credentials", "no-refresh-token"]) {
    assert.equal(applyRefreshOutcome(codex, "codex", "seat-2", { ok: false, reason }), codex, `${reason} is transient`);
  }
});

test("applyRefreshOutcome: Codex refresh-token-rejected → expired; success → ok again", () => {
  const ok = storeWith("ok", "codex");
  const expired = applyRefreshOutcome(ok, "codex", "seat-2", { ok: false, reason: "refresh-token-rejected" });
  assert.equal(statusOf(expired, "codex"), "expired");
  assert.equal(statusOf(ok, "codex"), "ok", "the input is not mutated");
  assert.equal(applyRefreshOutcome(expired, "codex", "seat-2", { ok: false, reason: "refresh-token-rejected" }), expired, "already expired → no change");
  assert.equal(statusOf(applyRefreshOutcome(expired, "codex", "seat-2", { ok: true, expiresAt: 9 }), "codex"), "ok");
});

const creds = (access) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `r-${access}`, expiresAt: 9e12 } });
const org = { uuid: "org-A", name: "Org", organization_type: "claude_team" };
const fakeFetch = (byToken) => async (_u, init) => {
  const p = byToken[String(init?.headers?.Authorization ?? "").replace("Bearer ", "")];
  return { ok: Boolean(p), status: p ? 200 : 401, json: async () => p };
};

async function rig() {
  const root = await mkdtemp(join(tmpdir(), "seat-status-"));
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
  return { root, accounts: createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch(profiles) }) };
}

test("service: an expired seat is not usable, so the router never chooses it; success brings it back", async () => {
  const { root, accounts } = await rig();
  try {
    const find = async () => (await accounts.seatStates("claude")).seats.find((s) => s.seatId === "seat-2");
    assert.equal((await find()).usable, true);
    assert.equal(await accounts.noteRefreshOutcome("claude", "seat-2", { ok: false, reason: "refresh-token-expired" }), true);
    assert.equal((await find()).usable, false);
    assert.equal((await accounts.getStore()).providers.claude.accounts[0].seats.find((s) => s.id === "seat-2").status, "expired");

    // …and rediscovery (which re-identifies seats) does not flip it back by itself.
    await accounts.discover({ force: true });
    assert.equal((await find()).usable, false);

    const svc = createSeatAssigner({ accounts, listSeatSnapshots: () => [{ provider: "claude", seatId: "seat-1", windows: [{ pct: 90 }] }, { provider: "claude", seatId: "seat-2", windows: [{ pct: 0 }] }], refreshSeatCredentials: async () => ({}), load: () => null, save: async () => {}, notePluginSeen: () => {}, log: quiet });
    assert.deepEqual(await svc.resolve("claude", "conv"), { seatId: "seat-1", live: true }, "the emptier seat is expired, so the conversation takes the other one");

    assert.equal(await accounts.noteRefreshOutcome("claude", "seat-2", { ok: true, expiresAt: 1 }), true);
    assert.equal((await find()).usable, true);
    assert.equal(await accounts.noteRefreshOutcome("claude", "seat-2", { ok: true }), false, "already ok → no write");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshClaudeSeatAndNote: records the outcome and returns the refresh result untouched; a recording failure cannot fail the refresh", async () => {
  const noted = [];
  const seats = { noteRefreshOutcome: async (...a) => void noted.push(a) };
  const result = { ok: false, reason: "refresh-token-expired" };
  assert.equal(await refreshClaudeSeatAndNote(seats, { seatId: "seat-2", dir: "/d" }, async () => result), result);
  assert.deepEqual(noted, [["claude", "seat-2", result]]);
  const alive = await refreshClaudeSeatAndNote({ noteRefreshOutcome: async () => { throw new Error("x"); } }, { seatId: "s", dir: "/d" }, async () => ({ ok: true }));
  assert.deepEqual(alive, { ok: true });
});

// ---- Codex ---------------------------------------------------------------------

async function codexRig() {
  const root = await mkdtemp(join(tmpdir(), "seat-status-codex-"));
  const paths = {
    storePath: join(root, "state", "accounts.json"),
    seatsRoot: join(root, "secrets", "accounts"),
    claudeLivePath: join(root, "home", ".claude", ".credentials.json"),
    codexAuthPath: join(root, "home", "opencode-auth.json"),
  };
  await mkdir(join(root, "home"), { recursive: true });
  const entry = (access, id) => ({ type: "oauth", refresh: `r-${id}`, access, expires: 9e12, accountId: id });
  await writeFile(paths.codexAuthPath, JSON.stringify({ openai: entry("LIVE-A", "acct-A") }));
  const accounts = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({}) });
  await accounts.discover({ force: true }); // seat-1 = the live login, copied into the seat store
  // a second, non-live Codex seat
  const dir = join(paths.seatsRoot, "codex", "seat-2");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth.json"), JSON.stringify({ openai: entry("SEAT2-B", "acct-B") }));
  const store = JSON.parse(await (await import("node:fs/promises")).readFile(paths.storePath, "utf-8"));
  store.providers.codex.accounts[0].seats.push({ id: "seat-2", label: "Seat 2", email: null, accountUuid: "acct-B", credentialDir: dir, status: "ok" });
  await writeFile(paths.storePath, JSON.stringify(store));
  return { root, paths, make: () => createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch({}) }), dir };
}

test("service (codex): a rejected refresh token expires the seat so it is never chosen; success brings it back", async () => {
  const { root, make } = await codexRig();
  try {
    const accounts = make();
    const find = async () => (await accounts.seatStates("codex")).seats.find((s) => s.seatId === "seat-2");
    assert.equal((await find()).usable, true);
    assert.equal(await accounts.noteRefreshOutcome("codex", "seat-2", { ok: false, reason: "refresh-token-rejected" }), true);
    assert.equal((await find()).usable, false);
    const snaps = [{ provider: "codex", seatId: "seat-1", windows: [{ pct: 95 }] }, { provider: "codex", seatId: "seat-2", windows: [{ pct: 0 }] }];
    const svc = createSeatAssigner({ accounts, listSeatSnapshots: () => snaps, refreshSeatCredentials: async () => ({}), load: () => null, save: async () => {}, notePluginSeen: () => {}, log: quiet });
    assert.equal((await svc.resolve("codex", "conv")).seatId, "seat-1", "the emptier seat is expired, so the other one is chosen");
    assert.equal(await accounts.noteRefreshOutcome("codex", "seat-2", { ok: true, expiresAt: 1 }), true);
    assert.equal((await find()).usable, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service: an expired seat that becomes the LIVE login (re-signed in) is usable again without waiting for a refresh", async () => {
  const { root, make, paths } = await codexRig();
  try {
    const accounts = make();
    await accounts.noteRefreshOutcome("codex", "seat-2", { ok: false, reason: "refresh-token-rejected" });
    // The user signs in as acct-B in opencode: it is now the live login.
    await writeFile(paths.codexAuthPath, JSON.stringify({ openai: { type: "oauth", refresh: "r-new", access: "LIVE-B", expires: 9e12, accountId: "acct-B" } }));
    const seat2 = (await make().seatStates("codex")).seats.find((s) => s.seatId === "seat-2");
    assert.equal(seat2.live, true);
    assert.equal(seat2.usable, true, "opencode owns and refreshes the live login");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshCodexSeatAndNote: records the outcome, returns the refresh result untouched, survives a bookkeeping failure", async () => {
  const noted = [];
  const result = { ok: false, reason: "refresh-token-rejected" };
  assert.equal(await refreshCodexSeatAndNote({ noteRefreshOutcome: async (...a) => void noted.push(a) }, { seatId: "seat-2", file: "/f" }, async () => result), result);
  assert.deepEqual(noted, [["codex", "seat-2", result]]);
  assert.deepEqual(await refreshCodexSeatAndNote({ noteRefreshOutcome: async () => { throw new Error("x"); } }, { seatId: "s", file: "/f" }, async () => ({ ok: true })), { ok: true });
});

test("the proactive sweep's Codex refresh path notes the outcome when given the noting refresher", async () => {
  const noted = [];
  const seats = { noteRefreshOutcome: async (...a) => void noted.push(a) };
  const sweep = createCredentialRefreshSweep({
    readCreds: () => null,
    listCodexTargets: async () => [{ seatId: "seat-2", file: "/f" }],
    readCodexExpiresAt: async () => 1,
    refreshCodex: (t) => refreshCodexSeatAndNote(seats, t, async () => ({ ok: false, reason: "refresh-token-rejected" })),
    now: () => 10 * 60_000,
  });
  await sweep.sweep();
  assert.deepEqual(noted, [["codex", "seat-2", { ok: false, reason: "refresh-token-rejected" }]]);
});
