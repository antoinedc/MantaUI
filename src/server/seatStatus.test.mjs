// Multi-account phase 2: a Claude seat whose refresh token is dead becomes
// "expired" (never chosen), and a later successful refresh makes it "ok" again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRefreshOutcome, createAccountsService, emptyStore } from "./accounts.mjs";
import { createSeatAssigner } from "./seatAssignment.mjs";
import { refreshClaudeSeatAndNote } from "./opencode.mjs";

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
  assert.equal(applyRefreshOutcome(codex, "codex", "seat-2", { ok: false, reason: "refresh-token-expired" }), codex, "Claude only");
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
