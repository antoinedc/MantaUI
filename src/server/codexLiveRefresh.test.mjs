// Refreshing the LIVE Codex login (opencode's own `openai` entry) while Codex is
// idle. Fake tokens, a fake token endpoint, a fake "opencode" that owns a temp
// auth.json — nothing here touches the network or a real login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveCodexRefresher, createUnauthorizedHandler } from "./codexLiveRefresh.mjs";
import { readCodexEntry } from "./codexRefresh.mjs";
import { createCredentialRefreshSweep, createLiveCodexRefresher as createProdLiveRefresher, readLiveCodexEntry, _setOcTransport } from "./opencode.mjs";
import { createAccountsService, readCodexEntryFile } from "./accounts.mjs";
import { createUsagePoller } from "./usage.mjs";
import { codexAdapter } from "./usageAdapters/codex.mjs";

const quiet = { log() {}, warn() {} };
const NOW = 10_000_000;
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const entry = (over = {}) => ({ type: "oauth", refresh: "OLD-REFRESH", access: "OLD-ACCESS", expires: NOW - 64 * 3_600_000, accountId: "acct-1", ...over });
const tokenOk = (over = {}) => ({ ok: true, status: 200, json: async () => ({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", expires_in: 3600, ...over }) });

// A fake opencode: owns auth.json; `persist` is its PUT /auth/openai.
async function box(initial = entry(), { persistOk = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "codex-live-"));
  const file = join(dir, "auth.json");
  await writeFile(file, JSON.stringify({ openai: initial }));
  const persisted = [];
  const persist = async (e) => {
    persisted.push(e);
    if (!persistOk) return { ok: false, error: "unreachable" };
    await writeFile(file, JSON.stringify({ openai: e }));
    return { ok: true };
  };
  return { dir, file, persisted, persist, readEntry: () => readCodexEntry(file), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function refresher(b, over = {}) {
  const tokenCalls = [];
  const r = createLiveCodexRefresher({
    readEntry: b.readEntry,
    persist: b.persist,
    flightKey: b.file,
    fetchImpl: async (url, init) => {
      tokenCalls.push({ url, body: new URLSearchParams(init.body) });
      return tokenOk();
    },
    now: () => NOW,
    log: quiet,
    sleep: async () => {},
    ...over,
  });
  return { r, tokenCalls };
}

test("live login expired → refreshed, persisted THROUGH opencode's API (rotated token), verified, then mirrored", async () => {
  const b = await box();
  try {
    const mirrored = [];
    const { r, tokenCalls } = refresher(b, { afterPersist: async (e) => mirrored.push(e.access) });
    const out = await r.refresh();
    assert.deepEqual(out, { ok: true, expiresAt: NOW + 3_600_000 });
    assert.equal(tokenCalls.length, 1);
    assert.equal(tokenCalls[0].url, "https://auth.openai.com/oauth/token");
    assert.equal(tokenCalls[0].body.get("grant_type"), "refresh_token");
    assert.equal(tokenCalls[0].body.get("refresh_token"), "OLD-REFRESH");
    assert.equal(tokenCalls[0].body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(b.persisted.length, 1, "written once, through the API");
    assert.deepEqual(b.persisted[0], { type: "oauth", refresh: "NEW-REFRESH", access: "NEW-ACCESS", expires: NOW + 3_600_000, accountId: "acct-1" });
    assert.equal(JSON.parse(await readFile(b.file, "utf-8")).openai.access, "NEW-ACCESS");
    assert.equal((await b.readEntry()).refresh, "NEW-REFRESH", "read back = what opencode now holds");
    assert.deepEqual(mirrored, ["NEW-ACCESS"]);
  } finally {
    await b.cleanup();
  }
});

test("accountId: taken from the token claims, previous one kept when the response has none", async () => {
  const b = await box();
  try {
    const { r } = refresher(b, { fetchImpl: async () => tokenOk({ id_token: jwt({ chatgpt_account_id: "acct-2" }) }) });
    await r.refresh();
    assert.equal(b.persisted[0].accountId, "acct-2");
  } finally {
    await b.cleanup();
  }
  const b2 = await box();
  try {
    const { r } = refresher(b2);
    await r.refresh();
    assert.equal(b2.persisted[0].accountId, "acct-1");
  } finally {
    await b2.cleanup();
  }
});

test("a fresh login is left untouched: no token call, nothing written", async () => {
  const b = await box(entry({ expires: NOW + 3_600_000 }));
  try {
    const { r, tokenCalls } = refresher(b);
    assert.deepEqual(await r.refresh(), { ok: true, skipped: "fresh" });
    assert.equal(tokenCalls.length, 0);
    assert.equal(b.persisted.length, 0);
  } finally {
    await b.cleanup();
  }
});

test("inside the 5-minute margin counts as due", async () => {
  const b = await box(entry({ expires: NOW + 4 * 60_000 }));
  try {
    const { r, tokenCalls } = refresher(b);
    assert.equal((await r.refresh()).ok, true);
    assert.equal(tokenCalls.length, 1);
  } finally {
    await b.cleanup();
  }
});

test("opencode refreshed it meanwhile: the entry is re-read on every call, so a fresher one is never overwritten or re-refreshed", async () => {
  const b = await box();
  try {
    const { r, tokenCalls } = refresher(b);
    // the sweep decided "expired" earlier; opencode refreshes before the next call
    await writeFile(b.file, JSON.stringify({ openai: entry({ access: "OPENCODE-ACCESS", refresh: "OPENCODE-REFRESH", expires: NOW + 3_600_000 }) }));
    assert.deepEqual(await r.refresh(), { ok: true, skipped: "fresh" });
    assert.equal(tokenCalls.length, 0);
    assert.equal(b.persisted.length, 0);
    assert.equal((await b.readEntry()).refresh, "OPENCODE-REFRESH");
  } finally {
    await b.cleanup();
  }
});

test("a 401 for a token opencode no longer holds is skipped (somebody refreshed it); for the token it still holds it refreshes even when not yet 'expired'", async () => {
  const b = await box(entry({ access: "CURRENT", expires: NOW + 3_600_000 }));
  try {
    const { r, tokenCalls } = refresher(b);
    assert.deepEqual(await r.refresh({ rejectedAccess: "SOMETHING-OLDER" }), { ok: true, skipped: "already-fresher" });
    assert.equal(tokenCalls.length, 0);
    assert.equal((await r.refresh({ rejectedAccess: "CURRENT" })).ok, true);
    assert.equal(tokenCalls.length, 1);
    assert.equal(b.persisted.length, 1);
  } finally {
    await b.cleanup();
  }
});

test("refresh failure (token refused / network / bad body): logged, NOTHING written", async () => {
  const cases = [
    [async () => ({ ok: false, status: 400, json: async () => ({}) }), "refresh-token-rejected"],
    [async () => ({ ok: false, status: 503, json: async () => ({}) }), "http-503"],
    [async () => { throw new Error("ECONNRESET OLD-REFRESH"); }, "network"],
    [async () => ({ ok: true, status: 200, json: async () => ({ nothing: true }) }), "bad-response"],
  ];
  for (const [fetchImpl, reason] of cases) {
    const b = await box();
    try {
      const logs = [];
      const { r } = refresher(b, { fetchImpl, log: { log: (...a) => logs.push(a.join(" ")) } });
      const before = await readFile(b.file, "utf-8");
      assert.deepEqual(await r.refresh(), { ok: false, reason });
      assert.equal(b.persisted.length, 0);
      assert.equal(await readFile(b.file, "utf-8"), before);
      assert.ok(!logs.some((l) => l.includes("OLD-REFRESH")), "no token in the log");
    } finally {
      await b.cleanup();
    }
  }
});

test("no credentials / no refresh token → reported, no call", async () => {
  const b = await box(entry({ refresh: "" }));
  try {
    const { r, tokenCalls } = refresher(b);
    assert.deepEqual(await r.refresh(), { ok: false, reason: "no-refresh-token" });
    assert.equal(tokenCalls.length, 0);
  } finally {
    await b.cleanup();
  }
  const { r } = refresher({ readEntry: async () => null, persist: async () => ({ ok: true }), file: "x" });
  assert.deepEqual(await r.refresh(), { ok: false, reason: "no-credentials" });
});

test("opencode unreachable when persisting: the rotated entry is kept and persisted on the NEXT call without spending another refresh token", async () => {
  const b = await box();
  try {
    let up = false;
    const persist = async (e) => {
      b.persisted.push(e);
      if (!up) return { ok: false, error: "unreachable" };
      await writeFile(b.file, JSON.stringify({ openai: e }));
      return { ok: true };
    };
    const { r, tokenCalls } = refresher(b, { persist });
    assert.deepEqual(await r.refresh(), { ok: false, reason: "persist-failed" });
    assert.equal(tokenCalls.length, 1);
    assert.equal(b.persisted.length, 3, "retried within the call");
    up = true;
    const out = await r.refresh();
    assert.equal(out.ok, true);
    assert.equal(tokenCalls.length, 1, "no second token request — the old refresh token is already burned");
    assert.equal((await b.readEntry()).refresh, "NEW-REFRESH");
  } finally {
    await b.cleanup();
  }
});

test("a persist that does not read back is a failure, and a pending entry is dropped once opencode moved on by itself", async () => {
  const b = await box();
  try {
    let mode = "ignore";
    const persist = async (e) => {
      if (mode === "write") await writeFile(b.file, JSON.stringify({ openai: e }));
      return { ok: true };
    };
    const { r, tokenCalls } = refresher(b, { persist });
    assert.deepEqual(await r.refresh(), { ok: false, reason: "verify-failed" });
    // opencode refreshes the login itself in the meantime
    await writeFile(b.file, JSON.stringify({ openai: entry({ access: "THEIRS", refresh: "THEIR-REFRESH", expires: NOW + 3_600_000 }) }));
    mode = "write";
    assert.deepEqual(await r.refresh(), { ok: true, skipped: "fresh" });
    assert.equal((await b.readEntry()).refresh, "THEIR-REFRESH", "ours never overwrote theirs");
    assert.equal(tokenCalls.length, 1);
  } finally {
    await b.cleanup();
  }
});

test("concurrent proactive sweep + a 401-triggered refresh → ONE token call", async () => {
  const b = await box();
  try {
    let release;
    const gate = new Promise((res) => (release = res));
    let calls = 0;
    const live = createLiveCodexRefresher({
      readEntry: b.readEntry,
      persist: b.persist,
      flightKey: b.file,
      fetchImpl: async () => {
        calls++;
        await gate;
        return tokenOk();
      },
      now: () => NOW,
      log: quiet,
      sleep: async () => {},
    });
    const sweep = createCredentialRefreshSweep({ readCreds: () => null, refresh: async () => {}, refreshLiveCodex: () => live.refresh() });
    const onUnauthorized = createUnauthorizedHandler({ live, seatStates: async () => null, refreshSeat: async () => ({ ok: false }) });
    const p1 = sweep.sweep();
    const p2 = onUnauthorized({ adapterId: "codex", seatId: null, rejectedToken: "OLD-ACCESS" });
    const p3 = live.refresh({ force: true });
    await new Promise((res) => setTimeout(res, 20));
    release();
    const [, second, third] = await Promise.all([p1, p2, p3]);
    assert.equal(calls, 1, "a rotating refresh token must not be spent twice");
    assert.equal(b.persisted.length, 1);
    assert.equal(second.ok, true);
    assert.deepEqual(second, third);
  } finally {
    await b.cleanup();
  }
});

test("sweep: the live Codex refresh runs even when the Claude refresh throws, and is optional", async () => {
  let n = 0;
  const sweep = createCredentialRefreshSweep({
    readCreds: () => ({ expiresAt: 1 }),
    shouldRefresh: () => true,
    refresh: async () => { throw new Error("boom"); },
    refreshLiveCodex: async () => { n++; },
  });
  await sweep.sweep();
  assert.equal(n, 1);
  const throwing = createCredentialRefreshSweep({ readCreds: () => null, refreshLiveCodex: async () => { throw new Error("x"); } });
  await throwing.sweep();
  await createCredentialRefreshSweep({ readCreds: () => null }).sweep();
});

// ---- the usage poller's 401 recovery -----------------------------------------

function usageData() {
  return { plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 3600 } } };
}

// codexAdapter, but reading the access token from OUR temp file (the real adapter reads opencode's store).
function adapterReading(b) {
  const readToken = async () => (await b.readEntry())?.access ?? "";
  return {
    ...codexAdapter,
    detect: (d) => codexAdapter.detect({ ...d, readToken }),
    fetch: (d) => codexAdapter.fetch({ ...d, readToken }),
  };
}

test("poll gets 401 → one refresh, the fetch is retried once in the same tick, and the snapshot is published (dial back)", async () => {
  const b = await box();
  try {
    const { r, tokenCalls } = refresher(b);
    const handler = createUnauthorizedHandler({ live: r, seatStates: async () => null, refreshSeat: async () => ({ ok: false }), now: () => NOW });
    const seen = [];
    const fetchImpl = async (url, init) => {
      const tok = init.headers.Authorization.replace("Bearer ", "");
      seen.push(tok);
      return tok === "NEW-ACCESS" ? { ok: true, status: 200, json: async () => usageData() } : { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
    };
    const published = [];
    const poller = createUsagePoller({
      adapters: [adapterReading(b)],
      fetchImpl,
      now: () => NOW,
      publish: (evt) => published.push(evt),
      onUnauthorized: handler,
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
    });
    await poller.tick();
    assert.deepEqual(seen, ["OLD-ACCESS", "NEW-ACCESS"]);
    assert.equal(tokenCalls.length, 1);
    assert.equal(b.persisted.length, 1);
    assert.equal(poller.snapshots.length, 1);
    assert.equal(poller.snapshots[0].provider, "codex");
    assert.equal(published.length, 1);
  } finally {
    await b.cleanup();
  }
});

test("poll 401 whose refresh fails: no retry storm — one refresh attempt, the original failure stands, debounced on the next tick", async () => {
  const b = await box();
  try {
    const tokenCalls = [];
    const { r } = refresher(b, { fetchImpl: async () => (tokenCalls.push(1), { ok: false, status: 400, json: async () => ({}) }) });
    const handler = createUnauthorizedHandler({ live: r, seatStates: async () => null, refreshSeat: async () => ({ ok: false }), now: () => NOW });
    let fetches = 0;
    const poller = createUsagePoller({
      adapters: [adapterReading(b)],
      fetchImpl: async () => {
        fetches++;
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
      },
      now: () => NOW,
      publish: () => {},
      onUnauthorized: handler,
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
    });
    await poller.tick();
    await poller.tick();
    assert.equal(poller.snapshots.length, 0);
    assert.equal(tokenCalls.length, 1, "second tick is inside the debounce window");
    assert.equal(fetches, 2, "one fetch per tick; no retry when the refresh failed");
    assert.equal(b.persisted.length, 0);
  } finally {
    await b.cleanup();
  }
});

test("without an onUnauthorized hook a 401 behaves exactly as before", async () => {
  const b = await box();
  try {
    let fetches = 0;
    const poller = createUsagePoller({
      adapters: [adapterReading(b)],
      fetchImpl: async () => {
        fetches++;
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
      },
      now: () => NOW,
      publish: () => {},
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
    });
    await poller.tick();
    assert.equal(fetches, 1);
    assert.equal(poller.snapshots.length, 0);
  } finally {
    await b.cleanup();
  }
});

test("per-seat 401: a live seat refreshes the live login; a directory seat refreshes ITS file; the handler ignores other providers", async () => {
  const calls = [];
  const live = { refresh: async (o) => (calls.push(["live", o]), { ok: true }) };
  const seats = {
    seats: [
      { seatId: "seat-1", live: true, file: null },
      { seatId: "seat-2", live: false, file: "/seats/seat-2/auth.json" },
    ],
  };
  let t = 0;
  const h = createUnauthorizedHandler({
    live,
    seatStates: async () => seats,
    refreshSeat: async (target) => (calls.push(["seat", target]), { ok: true }),
    now: () => (t += 10 * 60_000),
  });
  assert.deepEqual(await h({ adapterId: "codex", seatId: "seat-1", rejectedToken: "tok" }), { ok: true });
  assert.deepEqual(await h({ adapterId: "codex", seatId: "seat-2", rejectedToken: "tok" }), { ok: true });
  assert.deepEqual(await h({ adapterId: "claude", seatId: "seat-1" }), { ok: false });
  assert.deepEqual(await h({ adapterId: "codex", seatId: "nope" }), { ok: false });
  assert.deepEqual(calls, [["live", { rejectedAccess: "tok" }], ["seat", { seatId: "seat-2", file: "/seats/seat-2/auth.json" }]]);
});

test("handler debounce: a login refused again inside the window is not refreshed again; a skipped refresh does not start the window", async () => {
  let t = 0;
  const calls = [];
  let skip = true;
  const live = { refresh: async () => (calls.push("live"), skip ? { ok: true, skipped: "already-fresher" } : { ok: true }) };
  const h = createUnauthorizedHandler({ live, seatStates: async () => null, refreshSeat: async () => ({ ok: false }), now: () => t, debounceMs: 60_000 });
  await h({ adapterId: "codex" });
  await h({ adapterId: "codex" });
  assert.equal(calls.length, 2, "skipped → no window");
  skip = false;
  await h({ adapterId: "codex" });
  assert.deepEqual(await h({ adapterId: "codex" }), { ok: false, reason: "debounced" });
  t = 61_000;
  await h({ adapterId: "codex" });
  assert.equal(calls.length, 4);
});

// ---- mirroring into the seat directory (real accounts service, temp dirs) ----

test("after the live login is refreshed, mirrorLiveLogin updates the seat directory copy that IS that login", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-mirror-"));
  try {
    const liveFile = join(root, "home", "opencode-auth.json");
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(liveFile, JSON.stringify({ openai: entry() }));
    const accounts = createAccountsService({
      storePath: join(root, "state", "accounts.json"),
      seatsRoot: join(root, "secrets", "accounts"),
      claudeLivePath: join(root, "home", ".claude", ".credentials.json"),
      readLiveCodex: () => readCodexEntryFile(liveFile),
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      log: quiet,
    });
    await accounts.discover({ force: true });
    const seatFile = join(root, "secrets", "accounts", "codex", "seat-1", "auth.json");
    assert.equal(JSON.parse(await readFile(seatFile, "utf-8")).openai.refresh, "OLD-REFRESH");

    const live = createLiveCodexRefresher({
      readEntry: () => readCodexEntry(liveFile),
      persist: async (e) => (await writeFile(liveFile, JSON.stringify({ openai: e })), { ok: true }),
      afterPersist: () => accounts.mirrorLiveLogin("codex"),
      flightKey: liveFile,
      fetchImpl: async () => tokenOk(),
      now: () => NOW,
      log: quiet,
    });
    assert.equal((await live.refresh()).ok, true);
    const mirrored = JSON.parse(await readFile(seatFile, "utf-8")).openai;
    assert.equal(mirrored.refresh, "NEW-REFRESH");
    assert.equal(mirrored.access, "NEW-ACCESS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The LIVE login on V2: read from, and persisted to, opencode's credential store
// (`GET/POST /api/credential`). A fake of exactly that API: POST CREATES a credential and (like the
// real server, verified against the pinned 2.0.30) activates it, deactivating the others — the
// previous rows stay behind holding rotated-out tokens.
// ---------------------------------------------------------------------------------------------
function fakeCredentialStore(initialRows, { activateOnPost = true } = {}) {
  const store = { rows: initialRows.map((r) => structuredClone(r)), posts: [], gets: 0, activateOnPost };
  let n = 0;
  const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
  _setOcTransport(async (url, init = {}) => {
    const u = new URL(String(url));
    const m = init.method ?? "GET";
    if (m === "GET" && u.pathname === "/api/credential") {
      store.gets++;
      return json({ data: store.rows });
    }
    if (m === "GET" && u.pathname === "/api/integration/openai") return json({ data: { id: "openai", methods: [{ type: "key" }, { id: "chatgpt-token-sharing", type: "oauth" }] } });
    if (m === "POST" && u.pathname === "/api/credential") {
      const body = JSON.parse(init.body);
      store.posts.push(body);
      if (store.activateOnPost) for (const r of store.rows) if (r.integrationID === body.integrationID) r.active = false;
      store.rows.push({ id: `cred_new${++n}`, integrationID: body.integrationID, label: "default", active: store.activateOnPost, value: body.value });
      return json({ data: { id: `cred_new${n}` } });
    }
    return new Response(`unexpected ${m} ${u.pathname}`, { status: 599 });
  });
  return store;
}
const row = (id, access, refresh, { active = false, expires = NOW - 3_600_000, accountID = "acct-1" } = {}) => ({
  id, integrationID: "openai", label: "default", active,
  value: { type: "oauth", methodID: "chatgpt-token-sharing", access, refresh, expires, ...(accountID ? { metadata: { accountID } } : {}) },
});
const activeRows = (st) => st.rows.filter((r) => r.active);

test("V2 live refresh cycle: read the ACTIVE credential → refresh once → persist (creates + activates) → read back the NEW active one → mirror", async () => {
  const st = fakeCredentialStore([row("cred_burned", "BURNED-A", "BURNED-R"), row("cred_live", "OLD-ACCESS", "OLD-REFRESH", { active: true })]);
  try {
    const tokenCalls = [];
    const mirrored = [];
    const r = createProdLiveRefresher(
      { mirrorLiveLogin: async () => mirrored.push((await readLiveCodexEntry()).access) },
      { fetchImpl: async (url, init) => (tokenCalls.push(new URLSearchParams(init.body).get("refresh_token")), tokenOk()), now: () => NOW, log: quiet, sleep: async () => {} },
    );
    // Two concurrent callers share ONE refresh (the rotating refresh token is spent once).
    const [a, b] = await Promise.all([r.refresh(), r.refresh()]);
    assert.deepEqual(a, { ok: true, expiresAt: NOW + 3_600_000 });
    assert.deepEqual(b, a);
    assert.deepEqual(tokenCalls, ["OLD-REFRESH"], "refreshed with the ACTIVE credential's refresh token, never a burned row's, and only once");
    assert.equal(st.posts.length, 1);
    assert.equal(st.posts[0].activate, true);
    assert.equal(st.posts[0].value.metadata.accountID, "acct-1", "the account id travels with the rotated login");
    assert.equal(st.rows.length, 3, "a new credential was created (V2 has no in-place replace)");
    assert.deepEqual(activeRows(st).map((x) => x.value.access), ["NEW-ACCESS"], "exactly one active row, the new one");
    const back = await readLiveCodexEntry();
    assert.deepEqual(back, { type: "oauth", access: "NEW-ACCESS", refresh: "NEW-REFRESH", expires: NOW + 3_600_000, accountId: "acct-1" });
    assert.deepEqual(mirrored, ["NEW-ACCESS"], "the mirror runs after the persist and sees the new login");
    assert.doesNotMatch(JSON.stringify([a, b]), /ACCESS|REFRESH/, "no token in a result");
  } finally {
    _setOcTransport(null);
  }
});

test("V2 live refresh: a fresh active credential is left alone (no token call, no write)", async () => {
  const st = fakeCredentialStore([row("cred_live", "FRESH-A", "FRESH-R", { active: true, expires: NOW + 3 * 3_600_000 })]);
  try {
    let tokenCalls = 0;
    const r = createProdLiveRefresher(null, { fetchImpl: async () => (tokenCalls++, tokenOk()), now: () => NOW, log: quiet, sleep: async () => {} });
    assert.deepEqual(await r.refresh(), { ok: true, skipped: "fresh" });
    assert.equal(tokenCalls, 0);
    assert.equal(st.posts.length, 0);
  } finally {
    _setOcTransport(null);
  }
});

test("V2 live refresh: if the new credential does NOT become the active one, the read-back catches it; the rotated login is kept and re-persisted next time without burning another refresh token", async () => {
  const st = fakeCredentialStore([row("cred_live", "OLD-ACCESS", "OLD-REFRESH", { active: true })], { activateOnPost: false });
  try {
    const tokenCalls = [];
    const r = createProdLiveRefresher(null, { fetchImpl: async (url, init) => (tokenCalls.push(new URLSearchParams(init.body).get("refresh_token")), tokenOk()), now: () => NOW, log: quiet, sleep: async () => {} });
    assert.deepEqual(await r.refresh(), { ok: false, reason: "verify-failed" });
    assert.equal(st.posts.length, 3, "persisting was retried");
    assert.equal(tokenCalls.length, 1);
    // The store now behaves: the next call re-persists the held rotated entry instead of refreshing again.
    st.activateOnPost = true;
    const again = await r.refresh();
    assert.equal(again.ok, true);
    assert.equal(tokenCalls.length, 1, "the burned refresh token is not spent twice");
    assert.equal((await readLiveCodexEntry()).access, "NEW-ACCESS");
  } finally {
    _setOcTransport(null);
  }
});

test("the accounts service reads the live Codex login from V2 by default: discovery creates seat 1 from the ACTIVE credential (account id from metadata)", async () => {
  fakeCredentialStore([row("cred_burned", "BURNED-A", "BURNED-R", { accountID: "acct-OLD" }), row("cred_live", "LIVE-A", "LIVE-R", { active: true, expires: NOW + 3_600_000, accountID: "acct-live" })]);
  const root = await mkdtemp(join(tmpdir(), "codex-v2-live-"));
  try {
    const accounts = createAccountsService({
      storePath: join(root, "state", "accounts.json"),
      seatsRoot: join(root, "secrets", "accounts"),
      claudeLivePath: join(root, "home", ".claude", ".credentials.json"),
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      log: quiet,
    }); // no readLiveCodex injected: the production default
    await accounts.discover({ force: true });
    const store = await accounts.getStore();
    assert.equal(store.providers.codex.accounts[0].seats[0].accountUuid, "acct-live");
    const seatFile = JSON.parse(await readFile(join(root, "secrets", "accounts", "codex", "seat-1", "auth.json"), "utf-8"));
    assert.equal(seatFile.openai.access, "LIVE-A", "the seat copy is the active login, not a rotated-out row");
    assert.equal(seatFile.openai.accountId, "acct-live");
  } finally {
    _setOcTransport(null);
    await rm(root, { recursive: true, force: true });
  }
});
