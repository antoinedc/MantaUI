// Codex seat OAuth refresh (multi-account phase 2). Fake tokens only; the token
// endpoint is a stub — nothing here touches the network or a real login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  accountIdFromClaims,
  applyTokenResponse,
  decodeJwtClaims,
  extractAccountId,
  readCodexExpiry,
  refreshCodexSeat,
  shouldRefreshCodexAhead,
} from "./codexRefresh.mjs";
import { createCredentialRefreshSweep } from "./opencode.mjs";

const quiet = { log() {}, warn() {} };
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const entry = (over = {}) => ({ type: "oauth", refresh: "OLD-REFRESH", access: "OLD-ACCESS", expires: 1000, accountId: "acct-old", ...over });

test("decodeJwtClaims / accountIdFromClaims: the three claim shapes, in precedence order", () => {
  assert.equal(decodeJwtClaims("garbage"), null);
  assert.equal(accountIdFromClaims({ chatgpt_account_id: "a", "https://api.openai.com/auth": { chatgpt_account_id: "b" } }), "a");
  assert.equal(accountIdFromClaims({ "https://api.openai.com/auth": { chatgpt_account_id: "b" }, organizations: [{ id: "c" }] }), "b");
  assert.equal(accountIdFromClaims({ organizations: [{ id: "c" }] }), "c");
  assert.equal(accountIdFromClaims({}), null);
});

test("extractAccountId: id_token first, then access_token", () => {
  assert.equal(extractAccountId({ id_token: jwt({ chatgpt_account_id: "from-id" }), access_token: jwt({ chatgpt_account_id: "from-access" }) }), "from-id");
  assert.equal(extractAccountId({ id_token: jwt({}), access_token: jwt({ chatgpt_account_id: "from-access" }) }), "from-access");
  assert.equal(extractAccountId({ access_token: "opaque" }), null);
});

test("applyTokenResponse: rotates the refresh token, sets the expiry, keeps the previous account id when none is found", () => {
  const out = applyTokenResponse(entry(), { access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", expires_in: 3600 }, 5000);
  assert.deepEqual(out, { type: "oauth", refresh: "NEW-REFRESH", access: "NEW-ACCESS", expires: 5000 + 3_600_000, accountId: "acct-old" });
  const keep = applyTokenResponse(entry(), { access_token: "N" }, 0);
  assert.equal(keep.refresh, "OLD-REFRESH", "no new refresh token → keep the old one");
  assert.equal(applyTokenResponse(entry(), { id_token: "x" }, 0), null, "no access token → null");
  assert.equal(applyTokenResponse(entry(), { access_token: "N", id_token: jwt({ chatgpt_account_id: "acct-new" }) }, 0).accountId, "acct-new");
});

test("shouldRefreshCodexAhead: 5-minute margin; unknown expiry never triggers", () => {
  assert.equal(shouldRefreshCodexAhead(10 * 60_000, 6 * 60_000), true);
  assert.equal(shouldRefreshCodexAhead(11 * 60_000, 5 * 60_000), false);
  assert.equal(shouldRefreshCodexAhead(null, 0), false);
});

async function seatFile(initial) {
  const dir = await mkdtemp(join(tmpdir(), "codex-refresh-"));
  const file = join(dir, "auth.json");
  await writeFile(file, JSON.stringify(initial), { mode: 0o600 });
  return { dir, file };
}

test("refreshCodexSeat: POSTs the documented form, persists the ROTATED token atomically (0600, {openai:…} kept), reports expiry", async () => {
  const { dir, file } = await seatFile({ openai: entry() });
  try {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", id_token: jwt({ chatgpt_account_id: "acct-new" }), expires_in: 7200 }) };
    };
    const r = await refreshCodexSeat({ seatId: "seat-2", file }, { fetchImpl, now: () => 1_000_000, log: quiet });
    assert.deepEqual(r, { ok: true, expiresAt: 1_000_000 + 7_200_000 });
    assert.equal(seen.url, CODEX_OAUTH_TOKEN_URL);
    assert.equal(seen.init.method, "POST");
    const form = new URLSearchParams(seen.init.body);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "OLD-REFRESH");
    assert.equal(form.get("client_id"), CODEX_CLIENT_ID);
    const saved = JSON.parse(await readFile(file, "utf-8"));
    assert.deepEqual(saved, { openai: { type: "oauth", refresh: "NEW-REFRESH", access: "NEW-ACCESS", expires: 1_000_000 + 7_200_000, accountId: "acct-new" } });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await readCodexExpiry(file), 1_000_000 + 7_200_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshCodexSeat: a rejected refresh token / network error / bad body leaves the file UNTOUCHED and reports a reason without secrets", async () => {
  const { dir, file } = await seatFile({ openai: entry() });
  try {
    const before = await readFile(file, "utf-8");
    const cases = [
      [async () => ({ ok: false, status: 400, json: async () => ({}) }), "refresh-token-rejected"],
      [async () => ({ ok: false, status: 503, json: async () => ({}) }), "http-503"],
      [async () => { throw new Error("ECONNRESET OLD-REFRESH"); }, "network"],
      [async () => ({ ok: true, status: 200, json: async () => ({ nothing: true }) }), "bad-response"],
    ];
    for (const [fetchImpl, reason] of cases) {
      const r = await refreshCodexSeat({ file }, { fetchImpl, log: quiet });
      assert.deepEqual(r, { ok: false, reason });
      assert.equal(await readFile(file, "utf-8"), before);
    }
    assert.deepEqual(await refreshCodexSeat({ file: join(dir, "missing.json") }, { fetchImpl: async () => assert.fail("no call"), log: quiet }), { ok: false, reason: "no-credentials" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshCodexSeat: single-flight per file — one token request even when called twice at once", async () => {
  const { dir, file } = await seatFile({ openai: entry() });
  try {
    let calls = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const fetchImpl = async () => {
      calls++;
      await gate;
      return { ok: true, status: 200, json: async () => ({ access_token: "A2", refresh_token: "R2", expires_in: 60 }) };
    };
    const p1 = refreshCodexSeat({ file }, { fetchImpl, log: quiet });
    const p2 = refreshCodexSeat({ file }, { fetchImpl, log: quiet });
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(calls, 1, "a rotating refresh token must not be spent twice");
    assert.deepEqual(a, b);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the sweep ---------------------------------------------------------------

test("sweep: a non-live Codex seat inside the 5-minute margin is refreshed; one outside it is not; one failing seat does not stop the next", async () => {
  const refreshed = [];
  const expiry = { "/a": 1_000 + 4 * 60_000, "/b": 1_000 + 30 * 60_000, "/c": 1_000 + 60_000 };
  const sweep = createCredentialRefreshSweep({
    readCreds: () => null,
    refresh: async () => {},
    listCodexTargets: async () => [{ seatId: "a", file: "/a" }, { seatId: "b", file: "/b" }, { seatId: "c", file: "/c" }],
    readCodexExpiresAt: async (f) => {
      if (f === "/a") throw new Error("unreadable");
      return expiry[f];
    },
    refreshCodex: async (t) => {
      refreshed.push(t.seatId);
    },
    now: () => 1_000,
  });
  await sweep.sweep();
  assert.deepEqual(refreshed, ["c"]);
});

test("sweep: with no Codex targets (the default) behaves exactly as before", async () => {
  let live = 0;
  const sweep = createCredentialRefreshSweep({ readCreds: () => ({ expiresAt: 1 }), shouldRefresh: () => true, refresh: async () => live++ });
  await sweep.sweep();
  assert.equal(live, 1);
});
