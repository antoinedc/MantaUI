// Review round 1: the aggregate follows the SERVING seat until requests are
// routed per conversation, and a live login's seat directory is never left stale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_SEEN_WINDOW_MS,
  perConversationRoutingActive,
  notePluginSeen,
  resetPluginSeen,
  aggregationPolicy,
  shouldMirror,
  createAccountsService,
} from "./accounts.mjs";
import { createUsagePoller, recheckAdapterAtLimit } from "./usage.mjs";

const quiet = { warn() {}, log() {} };
const org = { uuid: "org-A", name: "Useronda", organization_type: "claude_team", rate_limit_tier: "default_claude_max_5x" };
const profileOf = (uuid) => ({ account: { uuid, email: `${uuid}@example.com` }, organization: org });
const creds = (access) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `r-${access}`, expiresAt: 9e12 } });
const fakeFetch = (byToken) => async (_u, init) => {
  const p = byToken[String(init?.headers?.Authorization ?? "").replace("Bearer ", "")];
  return { ok: Boolean(p), status: p ? 200 : 401, json: async () => p };
};

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "accounts-serving-"));
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
const seatFile = (paths, id) => join(paths.seatsRoot, "claude", id, ".credentials.json");
async function putSeatDir(paths, id, access) {
  await mkdir(join(paths.seatsRoot, "claude", id), { recursive: true, mode: 0o700 });
  await writeFile(seatFile(paths, id), creds(access), { mode: 0o600 });
}
const putLive = (paths, access) => writeFile(paths.claudeLivePath, creds(access));
const read = (f) => readFile(f, "utf-8");
const accessOf = (raw) => JSON.parse(raw).claudeAiOauth.accessToken;
const mk = (paths, byToken) => createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch(byToken) });
const TWO = { "tok-A": profileOf("u-A"), "tok-B": profileOf("u-B"), "tok-B-live": profileOf("u-B"), "tok-A-live": profileOf("u-A") };

// ---- aggregationPolicy ------------------------------------------------------

test("per-conversation routing is off until the plugin has called resolve, and fades 10 minutes after the last call", () => {
  resetPluginSeen();
  assert.equal(perConversationRoutingActive(1_000_000), false, "no plugin seen → phase-1 behaviour");
  notePluginSeen(1_000_000);
  assert.equal(perConversationRoutingActive(1_000_000), true);
  assert.equal(perConversationRoutingActive(1_000_000 + PLUGIN_SEEN_WINDOW_MS), true);
  assert.equal(perConversationRoutingActive(1_000_000 + PLUGIN_SEEN_WINDOW_MS + 1), false, "plugin gone → back to the serving seat");
  assert.equal(PLUGIN_SEEN_WINDOW_MS, 10 * 60_000);
  resetPluginSeen();
});

test("aggregationPolicy: no per-conversation routing → manual on the serving seat, whatever the store says", () => {
  const plan = { mode: "auto", activeSeatId: "seat-1", servingSeatId: "seat-2" };
  assert.deepEqual(aggregationPolicy({ plan, perConversationRouting: false }), { mode: "manual", activeSeatId: "seat-2" });
});

test("aggregationPolicy: no serving seat known → the store's mode and active seat", () => {
  const plan = { mode: "auto", activeSeatId: "seat-1", servingSeatId: null };
  assert.deepEqual(aggregationPolicy({ plan, perConversationRouting: false }), { mode: "auto", activeSeatId: "seat-1" });
  assert.deepEqual(aggregationPolicy({ plan: { mode: "manual", activeSeatId: "seat-3" }, perConversationRouting: false }), { mode: "manual", activeSeatId: "seat-3" });
});

test("aggregationPolicy: with per-conversation routing the store's choice stands (serving seat ignored)", () => {
  const plan = { mode: "auto", activeSeatId: "seat-1", servingSeatId: "seat-2" };
  assert.deepEqual(aggregationPolicy({ plan, perConversationRouting: true }), { mode: "auto", activeSeatId: "seat-1" });
});

test("aggregationPolicy: defaults to the module flag; tolerates a missing plan", () => {
  const plan = { mode: "auto", activeSeatId: "seat-1", servingSeatId: "seat-2" };
  assert.deepEqual(aggregationPolicy({ plan }), { mode: "manual", activeSeatId: "seat-2" });
  assert.deepEqual(aggregationPolicy({ plan: null, perConversationRouting: true }), { mode: "auto", activeSeatId: null });
});

// ---- poller + recheck follow the serving seat -------------------------------

const win = (pct) => [{ kind: "session", label: "5h", pct }];
function adapter(readings) {
  return {
    id: "claude",
    providerIDs: ["anthropic"],
    detect: async () => true,
    async fetch(deps) {
      const r = readings[deps.token];
      return { provider: "claude", kind: "subscription", windows: win(r.pct), ...(r.exhausted ? { exhausted: true } : {}) };
    },
  };
}
const seatDef = (n) => ({ accountId: "acct-1", accountLabel: "Work", seatId: `seat-${n}`, seatLabel: `Seat ${n}`, deps: { token: `tok-${n}` } });
const planOf = (over) => ({ mode: "auto", activeSeatId: "seat-2", servingSeatId: "seat-1", seats: [seatDef(1), seatDef(2)], ...over });

async function aggregateOf(readings, plan, perConversationRouting) {
  const poller = createUsagePoller({
    adapters: [adapter(readings)],
    seats: { seatsFor: async () => plan },
    perConversationRouting,
    now: () => 1_800_000_000_000,
    publish: () => {},
  });
  await poller.tick();
  return poller.snapshots[0];
}

test("live seat at 97% + other seat at 29% → the aggregate shows 97% (phase-1 truth)", async () => {
  const agg = await aggregateOf({ "tok-1": { pct: 97 }, "tok-2": { pct: 29 } }, planOf(), false);
  assert.equal(agg.windows[0].pct, 97);
});

test("live seat exhausted + other seat fine → the aggregate is exhausted", async () => {
  const agg = await aggregateOf({ "tok-1": { pct: 100, exhausted: true }, "tok-2": { pct: 29 } }, planOf(), false);
  assert.equal(agg.exhausted, true);
});

test("the other seat exhausted while the live one has room → NOT exhausted", async () => {
  const agg = await aggregateOf({ "tok-1": { pct: 20 }, "tok-2": { pct: 100, exhausted: true } }, planOf(), false);
  assert.equal("exhausted" in agg, false);
  assert.equal(agg.windows[0].pct, 20);
});

test("with per-conversation routing ON the aggregate is the least-loaded seat again (auto) and exhausted only when all are", async () => {
  const readings = { "tok-1": { pct: 100, exhausted: true }, "tok-2": { pct: 29 } };
  const agg = await aggregateOf(readings, planOf(), true);
  assert.equal(agg.windows[0].pct, 29);
  assert.equal("exhausted" in agg, false);
});

test("the routing flag may be a clock function (the plugin-seen check): evaluated per tick", async () => {
  const readings = { "tok-1": { pct: 97 }, "tok-2": { pct: 29 } };
  assert.equal((await aggregateOf(readings, planOf(), () => false)).windows[0].pct, 97);
  assert.equal((await aggregateOf(readings, planOf(), () => true)).windows[0].pct, 29);
});

test("routing off + the serving seat has NO reading → no provider aggregate is published (not another seat's headroom)", async () => {
  // seat-1 is the serving (live) seat but its usage call fails; seat-2 reads fine.
  const failing = {
    id: "claude",
    providerIDs: ["anthropic"],
    detect: async () => true,
    async fetch(deps) {
      if (deps.token === "tok-1") throw new Error("usage endpoint down");
      return { provider: "claude", kind: "subscription", windows: win(29) };
    },
  };
  const run = async (routing, plan) => {
    const published = [];
    const poller = createUsagePoller({
      adapters: [failing],
      seats: { seatsFor: async () => plan },
      perConversationRouting: routing,
      now: () => 1_800_000_000_000,
      publish: (e) => published.push(e),
    });
    await poller.tick();
    return { snapshots: poller.snapshots, seatSnapshots: poller.seatSnapshots, published };
  };
  const off = await run(false, planOf());
  assert.deepEqual(off.snapshots, [], "nothing published for the provider while its serving seat cannot be read");
  assert.deepEqual(off.seatSnapshots.map((s) => s.seatId), ["seat-2"], "the per-seat reading is still there");
  const on = await run(true, planOf());
  assert.equal(on.snapshots[0].windows[0].pct, 29, "with routing on the aggregate may use any seat");
  const noServing = await run(false, planOf({ servingSeatId: null }));
  assert.equal(noServing.snapshots[0].windows[0].pct, 29, "no serving seat known → the store's mode applies");
});

test("no serving seat known → the store's mode applies even with the flag off", async () => {
  const agg = await aggregateOf({ "tok-1": { pct: 97 }, "tok-2": { pct: 29 } }, planOf({ servingSeatId: null }), false);
  assert.equal(agg.windows[0].pct, 29);
});

test("recheckAdapterAtLimit agrees with the poller: follows the serving seat, or the store's choice when routing is per conversation", async () => {
  const pcts = { "tok-1": 100, "tok-2": 10 };
  const fetchImpl = async (_u, init) => {
    const tok = String(init.headers.Authorization).replace("Bearer ", "");
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ five_hour: { utilization: pcts[tok] } }) };
  };
  const seatDeps = (n) => ({ ...seatDef(n), deps: { readCredentials: async () => ({ accessToken: `tok-${n}` }) } });
  const plan = (over) => ({ mode: "auto", activeSeatId: "seat-2", servingSeatId: "seat-1", seats: [seatDeps(1), seatDeps(2)], ...over });
  const run = (p, flag) => recheckAdapterAtLimit("claude", { fetchImpl, seatsFor: async () => p, perConversationRouting: flag });

  assert.equal(await run(plan(), false), true, "the live seat is at its limit → at limit, though seat-2 has room");
  assert.equal(await run(plan({ servingSeatId: "seat-2" }), false), false);
  assert.equal(await run(plan(), true), false, "per-conversation routing: auto → every seat must be at limit");
  assert.equal(await run(plan({ servingSeatId: null, mode: "manual", activeSeatId: "seat-1" }), false), true);
});

// ---- servingSeatId from the real service ------------------------------------

test("seatsFor reports the seat whose login is live as servingSeatId", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B");
    await putLive(paths, "tok-B-live");
    const plan = await mk(paths, TWO).seatsFor("claude");
    assert.equal(plan.servingSeatId, "seat-2");
    await putLive(paths, "tok-A-live");
    const swapped = await mk(paths, TWO).seatsFor("claude");
    assert.equal(swapped.servingSeatId, "seat-1");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("seatsFor: no live login → servingSeatId null", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    const plan = await mk(paths, TWO).seatsFor("claude");
    assert.equal(plan.servingSeatId, null);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

// ---- mirroring --------------------------------------------------------------

test("shouldMirror: only on a live source with a positive identity match and a directory", () => {
  const seat = { id: "s", accountUuid: "u-1", credentialDir: "/d" };
  assert.equal(shouldMirror({ seat, source: { kind: "live" }, liveUuid: "u-1" }), true);
  assert.equal(shouldMirror({ seat, source: { kind: "dir", dir: "/d" }, liveUuid: "u-1" }), false);
  assert.equal(shouldMirror({ seat, source: { kind: "live" }, liveUuid: "u-2" }), false);
  assert.equal(shouldMirror({ seat, source: { kind: "live" }, liveUuid: null }), false);
  assert.equal(shouldMirror({ seat: { ...seat, accountUuid: null }, source: { kind: "live" }, liveUuid: "u-1" }), false);
  assert.equal(shouldMirror({ seat: { ...seat, credentialDir: null }, source: { kind: "live" }, liveUuid: "u-1" }), false);
});

test("mirror: a live seat's directory is brought up to the live file, byte for byte, 0600 (dir 0700); live is never written", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B-old");
    await putLive(paths, "tok-B-live");
    const liveBefore = await read(paths.claudeLivePath);
    const otherBefore = await read(seatFile(paths, "seat-1"));
    await mk(paths, { ...TWO, "tok-B-old": profileOf("u-B") }).seatsFor("claude");

    assert.equal(await read(seatFile(paths, "seat-2")), liveBefore);
    assert.equal(accessOf(await read(seatFile(paths, "seat-2"))), "tok-B-live");
    assert.equal((await stat(seatFile(paths, "seat-2"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(paths.seatsRoot, "claude", "seat-2"))).mode & 0o777, 0o700);
    assert.equal(await read(paths.claudeLivePath), liveBefore, "never the other direction");
    assert.equal(await read(seatFile(paths, "seat-1")), otherBefore, "a seat that is not live is untouched");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("mirror: skipped when the content is already identical (no write)", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putLive(paths, "tok-A");
    await writeFile(seatFile(paths, "seat-1"), await read(paths.claudeLivePath), { mode: 0o600 });
    const before = await stat(seatFile(paths, "seat-1"));
    await mk(paths, TWO).seatsFor("claude");
    await mk(paths, TWO).seatsFor("claude");
    const after = await stat(seatFile(paths, "seat-1"));
    assert.equal(after.ino, before.ino, "an atomic write would have replaced the inode");
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("mirror: keeps following the live file as it refreshes", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B");
    await putLive(paths, "tok-B-live");
    const svc = mk(paths, { ...TWO, "tok-B-live2": profileOf("u-B") });
    await svc.seatsFor("claude");
    assert.equal(accessOf(await read(seatFile(paths, "seat-2"))), "tok-B-live");
    // The CLI refreshes the live login in place (new access token, same login).
    await writeFile(paths.claudeLivePath, JSON.stringify({ claudeAiOauth: { accessToken: "tok-B-live2", refreshToken: "r-tok-B-live", expiresAt: 9.1e12 } }));
    await svc.seatsFor("claude");
    assert.equal(accessOf(await read(seatFile(paths, "seat-2"))), "tok-B-live2");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("mirror: never for an identity MISMATCH — the live login is nobody's seat", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B");
    await putLive(paths, "tok-Z-live");
    const b1 = await read(seatFile(paths, "seat-1"));
    const b2 = await read(seatFile(paths, "seat-2"));
    await mk(paths, { ...TWO, "tok-Z-live": profileOf("u-Z") }).seatsFor("claude");
    assert.equal(await read(seatFile(paths, "seat-1")), b1);
    assert.equal(await read(seatFile(paths, "seat-2")), b2);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("mirror: never when the live identity is UNKNOWN (profile call fails), even for a lone unidentified seat", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putLive(paths, "tok-whoever");
    const before = await read(seatFile(paths, "seat-1"));
    const svc = mk(paths, {}); // every profile lookup fails
    const plan = await svc.seatsFor("claude");
    assert.ok(plan, "the seat is still usable via the fallback");
    assert.equal(await read(seatFile(paths, "seat-1")), before);

    const two = await sandbox();
    try {
      await putSeatDir(two, "seat-1", "tok-A");
      await putSeatDir(two, "seat-2", "tok-B");
      await putLive(two, "tok-B-live");
      const b = await read(seatFile(two, "seat-2"));
      await mk(two, { "tok-A": profileOf("u-A"), "tok-B": profileOf("u-B") }).seatsFor("claude"); // live lookup 401s
      assert.equal(await read(seatFile(two, "seat-2")), b);
    } finally {
      await rm(two.root, { recursive: true, force: true });
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("mirror: a garbled live file is never copied over a good seat copy", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putLive(paths, "tok-A-live");
    const svc = mk(paths, TWO);
    await svc.seatsFor("claude");
    const good = await read(seatFile(paths, "seat-1"));
    await writeFile(paths.claudeLivePath, "{ truncated");
    await svc.seatsFor("claude");
    assert.equal(await read(seatFile(paths, "seat-1")), good);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("mirror: discovery itself mirrors (server start), before any poll", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B");
    await putLive(paths, "tok-B-live");
    await mk(paths, TWO).discover({ force: true });
    assert.equal(accessOf(await read(seatFile(paths, "seat-2"))), "tok-B-live");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("mirror: Codex — the seat copy is {openai: entry} from auth.json, 0600, only when it differs", async () => {
  const paths = await sandbox();
  try {
    const entry = (access) => ({ type: "oauth", refresh: "r", access, expires: 9e12, accountId: "chatgpt-1" });
    await writeFile(paths.codexAuthPath, JSON.stringify({ openai: entry("a-1"), anthropic: { type: "oauth", access: "no" } }));
    const svc = mk(paths, {});
    await svc.discover({ force: true });
    const copy = join(paths.seatsRoot, "codex", "seat-1", "auth.json");
    assert.equal(JSON.parse(await read(copy)).openai.access, "a-1");

    await writeFile(paths.codexAuthPath, JSON.stringify({ openai: entry("a-2") }));
    await svc.seatsFor("codex");
    assert.deepEqual(JSON.parse(await read(copy)), { openai: entry("a-2") });
    assert.equal((await stat(copy)).mode & 0o777, 0o600);

    const ino = (await stat(copy)).ino;
    await svc.seatsFor("codex");
    assert.equal((await stat(copy)).ino, ino, "identical → no rewrite");

    // A different ChatGPT account becomes live: the seat-1 copy must not be overwritten with it.
    await writeFile(paths.codexAuthPath, JSON.stringify({ openai: { ...entry("a-other"), accountId: "chatgpt-2" } }));
    await svc.seatsFor("codex");
    assert.equal(JSON.parse(await read(copy)).openai.access, "a-2");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

// ---- refresh sweep targets --------------------------------------------------

test("a Claude seat read from the LIVE file is never a refresh target; the other seat is", async () => {
  const paths = await sandbox();
  try {
    await putSeatDir(paths, "seat-1", "tok-A");
    await putSeatDir(paths, "seat-2", "tok-B");
    await putLive(paths, "tok-B-live");
    const svc = mk(paths, TWO);
    assert.deepEqual((await svc.claudeRefreshTargets()).map((t) => t.seatId), ["seat-1"]);
    await putLive(paths, "tok-A-live");
    assert.deepEqual((await mk(paths, TWO).claudeRefreshTargets()).map((t) => t.seatId), ["seat-2"]);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
