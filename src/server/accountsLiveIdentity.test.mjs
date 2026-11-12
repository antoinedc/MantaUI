// The live Claude login's identity lookup (seat routing spec §3.4): a profile call
// that cannot hang, and a cache that does not ask Anthropic about a token it already
// knows is dead (that retry every 30 s was part of what made seat lookups slow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountsService, fetchClaudeProfile } from "./accounts.mjs";

const quiet = { warn() {}, log() {} };
const MIN = 60_000;
const org = { uuid: "org-A", name: "Org", organization_type: "claude_team", rate_limit_tier: "default_claude_max_5x" };
const profile = (uuid) => ({ account: { uuid, email: `${uuid}@x` }, organization: org });
const credsJson = (access, refresh = `r-${access}`) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: 9e12 } });
const bearerOf = (init) => String(init?.headers?.Authorization ?? "").replace("Bearer ", "");

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "live-identity-"));
  await mkdir(join(root, "home"), { recursive: true });
  const livePath = join(root, "home", ".credentials.json");
  return {
    root,
    livePath,
    paths: { storePath: join(root, "state", "accounts.json"), seatsRoot: join(root, "secrets", "accounts"), claudeLivePath: livePath, readLiveCodex: async () => null },
  };
}

/** An accounts service whose fetch answers per token (a function may throw / return a status) and counts calls per token. */
function serviceOver(sb, answer, clock) {
  const calls = [];
  const svc = createAccountsService({
    ...sb.paths,
    log: quiet,
    now: () => clock.t,
    fetchImpl: async (_url, init) => {
      const token = bearerOf(init);
      calls.push(token);
      return answer(token);
    },
  });
  return { svc, calls, count: (tok) => calls.filter((c) => c === tok).length };
}
const ok = (uuid) => ({ ok: true, status: 200, json: async () => profile(uuid) });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });

// ---- fetchClaudeProfile -----------------------------------------------------

test("fetchClaudeProfile: identity / dead (401, 403) / error (anything else), never a throw", async () => {
  const ask = (res) => fetchClaudeProfile("t", async () => (typeof res === "function" ? res() : res));
  assert.equal((await ask({ ok: true, status: 200, json: async () => profile("u-1") })).identity.accountUuid, "u-1");
  assert.deepEqual(await ask(status(401)), { dead: true });
  assert.deepEqual(await ask(status(403)), { dead: true });
  assert.deepEqual(await ask(status(500)), { error: true });
  assert.deepEqual(await ask(status(429)), { error: true });
  assert.deepEqual(await ask({ ok: true, status: 200, json: async () => ({}) }), { error: true }, "a payload with no account uuid is not an identity");
  assert.deepEqual(await ask(() => { throw new Error("ECONNRESET"); }), { error: true });
  assert.deepEqual(await ask(() => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })), { error: true });
});

test("fetchClaudeProfile: a hung request times out — even one that ignores its abort signal", async () => {
  const started = Date.now();
  const stuck = await fetchClaudeProfile("t", () => new Promise(() => {}), { timeoutMs: 25 });
  assert.deepEqual(stuck, { error: true });
  assert.ok(Date.now() - started < 1_000, "gave up quickly");

  let aborted = false;
  const honoring = await fetchClaudeProfile(
    "t",
    (_url, init) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          rej(new Error("aborted"));
        });
      }),
    { timeoutMs: 25 },
  );
  assert.deepEqual(honoring, { error: true });
  assert.equal(aborted, true, "the request itself is aborted, not just abandoned");
});

test("fetchClaudeProfile: the request carries an abort signal, and the token only travels in the Authorization header", async () => {
  let seen;
  await fetchClaudeProfile("sekrit", async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => profile("u") };
  });
  assert.equal(seen.init.headers.Authorization, "Bearer sekrit");
  assert.doesNotMatch(String(seen.url), /sekrit/);
  assert.ok(seen.init.signal instanceof AbortSignal);
});

// ---- the live login cache ---------------------------------------------------

test("a login Anthropic refused (401) is remembered as dead until the live file's token changes — no TTL", async () => {
  const sb = await sandbox();
  try {
    const clock = { t: 1_000_000 };
    await writeFile(sb.livePath, credsJson("tok-dead"));
    const s = serviceOver(sb, (tok) => (tok === "tok-new" ? ok("u-new") : status(401)), clock);
    await s.svc.discover({ force: true });
    assert.equal(s.count("tok-dead"), 1);
    for (const advance of [31 * 1000, 61 * MIN, 24 * 60 * MIN]) {
      clock.t += advance;
      await s.svc.discover({ force: true });
      await s.svc.seatStates("claude");
    }
    assert.equal(s.count("tok-dead"), 1, "never asked again about the same token, however long it has been");

    // A new login lands in the file: asked at once.
    await writeFile(sb.livePath, credsJson("tok-new"));
    await s.svc.discover({ force: true });
    assert.equal(s.count("tok-new"), 1);
    const states = await s.svc.seatStates("claude");
    assert.equal(states.seats.length, 1, "and now identified: the new login is a seat");
  } finally {
    await rm(sb.root, { recursive: true, force: true });
  }
});

test("a token whose refresh rotated the file (same account, new tokens) is asked about again", async () => {
  const sb = await sandbox();
  try {
    const clock = { t: 1 };
    await writeFile(sb.livePath, credsJson("tok-1", "r-same"));
    const s = serviceOver(sb, (tok) => (tok === "tok-2" ? ok("u-1") : status(401)), clock);
    await s.svc.discover({ force: true });
    await writeFile(sb.livePath, credsJson("tok-2", "r-same")); // only the access token moved
    await s.svc.discover({ force: true });
    assert.equal(s.count("tok-2"), 1, "any change of the file's token is noticed");
  } finally {
    await rm(sb.root, { recursive: true, force: true });
  }
});

test("an empty token is 'absent': no call at all, and the login is not present", async () => {
  const sb = await sandbox();
  try {
    const clock = { t: 1 };
    await writeFile(sb.livePath, JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } }));
    const s = serviceOver(sb, () => status(401), clock);
    await s.svc.discover({ force: true });
    const states = await s.svc.seatStates("claude");
    assert.equal(s.calls.length, 0);
    assert.deepEqual(states.seats, []);
  } finally {
    await rm(sb.root, { recursive: true, force: true });
  }
});

test("a network error is retried after 60 s, not before", async () => {
  const sb = await sandbox();
  try {
    const clock = { t: 5_000_000 };
    await writeFile(sb.livePath, credsJson("tok-net"));
    let down = true;
    const s = serviceOver(sb, () => {
      if (down) throw new Error("ENETUNREACH");
      return ok("u-net");
    }, clock);
    await s.svc.discover({ force: true });
    assert.equal(s.count("tok-net"), 1);
    clock.t += 59_000;
    await s.svc.discover({ force: true });
    assert.equal(s.count("tok-net"), 1, "still inside the retry delay");
    clock.t += 2_000;
    down = false;
    await s.svc.discover({ force: true });
    assert.equal(s.count("tok-net"), 2, "past 60 s it asks again");
    assert.equal((await s.svc.seatStates("claude")).seats.length, 1, "and the identity landed");
  } finally {
    await rm(sb.root, { recursive: true, force: true });
  }
});

test("an identified login is trusted for an hour", async () => {
  const sb = await sandbox();
  try {
    const clock = { t: 1_000 };
    await writeFile(sb.livePath, credsJson("tok-ok"));
    const s = serviceOver(sb, () => ok("u-ok"), clock);
    await s.svc.discover({ force: true });
    clock.t += 59 * MIN;
    await s.svc.discover({ force: true });
    await s.svc.seatStates("claude");
    assert.equal(s.count("tok-ok"), 1);
    clock.t += 2 * MIN;
    await s.svc.discover({ force: true });
    assert.equal(s.count("tok-ok"), 2);
  } finally {
    await rm(sb.root, { recursive: true, force: true });
  }
});
