// The accounts:* channels (spec §8 Contract v2), against the REAL accounts
// service + seat assigner over a temp sandbox. Only the world is faked: the
// Anthropic profile endpoint, the claude-login launcher, opencode's OAuth flow
// and its auth store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountsService, identityFromProfile, allSeats } from "./accounts.mjs";
import { createSeatAssigner } from "./seatAssignment.mjs";
import { createAccountsManager, ACCOUNTS_SAFE_ERROR_MESSAGE } from "./accountsManager.mjs";

const quiet = { warn() {}, log() {} };
const orgA = { uuid: "org-A", name: "Useronda", organization_type: "claude_team", rate_limit_tier: "default_claude_max_5x" };
const orgZ = { uuid: "org-Z", name: "Zeta", organization_type: "claude_pro" };
const profileOf = (uuid, email, org = orgA) => ({ account: { uuid, email }, organization: org });
const credsJson = (access) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `r-${access}`, expiresAt: 9e12 } });
const oauth = (access, accountId, extra = {}) => ({ type: "oauth", access, refresh: `r-${access}`, expires: 9e12, accountId, ...extra });

// The profile endpoint: a mutable table, so a test can "log in" a new token.
function fakeFetch(table) {
  return async (_url, init) => {
    const tok = String(init?.headers?.Authorization ?? "").replace("Bearer ", "");
    const p = table[tok];
    return { ok: Boolean(p), status: p ? 200 : 401, json: async () => p };
  };
}

async function rig({ codex = false, claude = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "acct-mgr-"));
  const paths = {
    storePath: join(root, "state", "accounts.json"),
    seatsRoot: join(root, "secrets", "accounts"),
    claudeLivePath: join(root, "home", ".claude", ".credentials.json"),
    codexAuthPath: join(root, "home", "opencode-auth.json"),
  };
  await mkdir(join(root, "home", ".claude"), { recursive: true });
  const profiles = { "tok-A": profileOf("u-A", "a@example.com"), "tok-B": profileOf("u-B", "b@example.com") };
  if (claude) {
    for (const [id, tok] of [["seat-1", "tok-A"], ["seat-2", "tok-B"]]) {
      await mkdir(join(paths.seatsRoot, "claude", id), { recursive: true });
      await writeFile(join(paths.seatsRoot, "claude", id, ".credentials.json"), credsJson(tok));
    }
    await writeFile(paths.claudeLivePath, credsJson("tok-B")); // seat-2 is live
  }
  if (codex) await writeFile(paths.codexAuthPath, JSON.stringify({ openai: oauth("cx-A", "gpt-A") }));
  const accounts = createAccountsService({ ...paths, log: quiet, fetchImpl: fakeFetch(profiles) });
  await accounts.discover({ force: true });

  let assignStore = null;
  let snaps = [];
  const moves = [];
  const seatAssigner = createSeatAssigner({
    accounts,
    listSeatSnapshots: () => snaps,
    refreshSeatCredentials: async () => ({}),
    load: () => assignStore,
    save: async (d) => {
      assignStore = structuredClone(d);
    },
    notePluginSeen: () => {},
    onMoved: (e) => moves.push(e),
    log: quiet,
  });

  const calls = { claudeStart: [], claudeCancel: [], restore: [], codexStart: 0 };
  const state = { restoreOk: true, codexShape: "oauth-auto", epoch: 7 };
  const mgr = createAccountsManager({
    accounts,
    seatAssigner,
    listSeatSnapshots: () => snaps,
    routingActive: () => true,
    claudeLogin: {
      start: async (dir, seatId) => {
        calls.claudeStart.push({ dir, seatId });
        return { action: "start", shape: "claude-login", sessionKey: `claude-login-${seatId}`, startedAt: 1, cwd: "/home" };
      },
      cancel: (k) => calls.claudeCancel.push(k),
    },
    codex: {
      startConnect: async () => {
        calls.codexStart++;
        return { action: "start", shape: state.codexShape, url: "https://auth.example/device", methodIndex: 0 };
      },
      oauthEpoch: () => state.epoch,
      livePath: () => paths.codexAuthPath,
      restoreEntry: async (entry) => {
        calls.restore.push(entry.access);
        if (!state.restoreOk) return { ok: false };
        await writeFile(paths.codexAuthPath, JSON.stringify({ openai: entry }));
        return { ok: true };
      },
    },
    fetchProfile: async (token) => identityFromProfile(profiles[token]),
    log: quiet,
    timings: state.timings,
  });
  return {
    root,
    paths,
    accounts,
    seatAssigner,
    mgr,
    calls,
    state,
    profiles,
    moves,
    setSnaps: (s) => (snaps = s),
    cleanup: () => rm(root, { recursive: true, force: true }),
    exists: (p) => stat(p).then(() => true, () => false),
  };
}
const ch = (r, name, input) => r.mgr.channels[name](input);
const allViewSeats = (view) => view.accounts.flatMap((a) => a.seats);

// ---- list --------------------------------------------------------------------

test("accounts:list: providers with ≥1 seat, the §8 shape, no secrets", async () => {
  const r = await rig();
  try {
    const { providers } = await ch(r, "accounts:list", {});
    assert.deepEqual(providers.map((p) => p.provider), ["claude"], "codex has no seat → omitted");
    const v = providers[0];
    assert.equal(v.mode, "auto");
    assert.equal(v.routingActive, true);
    assert.equal(v.accounts.length, 1);
    const seats = allViewSeats(v);
    assert.deepEqual(seats.map((s) => [s.id, s.live, s.status, s.email]), [
      ["seat-1", false, "ok", "a@example.com"],
      ["seat-2", true, "ok", "b@example.com"],
    ]);
    assert.doesNotMatch(JSON.stringify(providers), /tok-|secrets|credentialDir|accountUuid|u-A|u-B/);
  } finally {
    await r.cleanup();
  }
});

// ---- mode / active / rename --------------------------------------------------

test("set-mode / set-active: persisted, return the ProviderView; bad input → contract errors", async () => {
  const r = await rig();
  try {
    const m = await ch(r, "accounts:set-mode", { provider: "claude", mode: "manual" });
    assert.equal(m.mode, "manual");
    assert.equal((await r.accounts.getStore()).providers.claude.mode, "manual");
    const a = await ch(r, "accounts:set-active", { provider: "claude", seatId: "seat-1" });
    assert.equal(a.activeSeatId, "seat-1");
    assert.equal(a.nextSeatId, "seat-1", "manual: the next seat is the active seat");
    assert.deepEqual(await ch(r, "accounts:set-active", { provider: "claude", seatId: "seat-99" }), { error: "unknown-seat" });
    assert.deepEqual(await ch(r, "accounts:set-active", { provider: "nope", seatId: "seat-1" }), { error: "unknown-provider" });
    assert.deepEqual(await ch(r, "accounts:set-mode", { provider: "claude", mode: "turbo" }), { error: "unknown-provider" });
    assert.deepEqual(await ch(r, "accounts:set-mode", { provider: "codex", mode: "auto" }), { error: "unknown-provider" }, "no seats for that provider");
    assert.deepEqual(await ch(r, "accounts:set-mode", undefined), { error: "unknown-provider" });
  } finally {
    await r.cleanup();
  }
});

test("rename: seat and account; label is trimmed; 1–40 chars, no control characters; unknown id", async () => {
  const r = await rig();
  try {
    const a = await ch(r, "accounts:rename", { provider: "claude", kind: "seat", id: "seat-1", label: "  Boss  " });
    assert.equal(allViewSeats(a).find((s) => s.id === "seat-1").label, "Boss");
    const b = await ch(r, "accounts:rename", { provider: "claude", kind: "account", id: "acct-1", label: "Work" });
    assert.equal(b.accounts[0].label, "Work");
    for (const bad of ["", "   ", "x".repeat(41), "a\nb", 5, undefined]) {
      assert.deepEqual(await ch(r, "accounts:rename", { provider: "claude", kind: "seat", id: "seat-1", label: bad }), { error: "invalid-label" }, JSON.stringify(bad));
    }
    assert.deepEqual(await ch(r, "accounts:rename", { provider: "claude", kind: "seat", id: "nope", label: "x" }), { error: "unknown-seat" });
    assert.deepEqual(await ch(r, "accounts:rename", { provider: "claude", kind: "weird", id: "seat-1", label: "x" }), { error: "unknown-seat" });
    assert.deepEqual(await ch(r, "accounts:rename", { provider: "x", kind: "seat", id: "seat-1", label: "x" }), { error: "unknown-provider" });
    const stored = (await r.accounts.getStore()).providers.claude;
    assert.equal(allSeats(stored).find((s) => s.id === "seat-1").label, "Boss");
  } finally {
    await r.cleanup();
  }
});

// ---- manual mode end to end ---------------------------------------------------

test("manual mode: set-active makes the resolver send EVERY conversation (even one stored on another seat) to it; session-seat answers", async () => {
  const r = await rig();
  try {
    // Auto: place a conversation on seat-1 (least loaded).
    r.setSnaps([{ provider: "claude", seatId: "seat-1", windows: [{ kind: "session", pct: 5 }] }, { provider: "claude", seatId: "seat-2", windows: [{ kind: "session", pct: 60 }] }]);
    assert.equal((await r.seatAssigner.resolve("claude", "ses_1")).seatId, "seat-1");
    let s = await ch(r, "accounts:session-seat", { sessionId: "ses_1" });
    assert.deepEqual([s.provider, s.seatId, s.seatLabel, s.accountLabel, s.lastMove], ["claude", "seat-1", "Seat 1", "Useronda", undefined]);

    await ch(r, "accounts:set-mode", { provider: "claude", mode: "manual" });
    await ch(r, "accounts:set-active", { provider: "claude", seatId: "seat-2" });
    // session-seat reflects the pending switch at once
    s = await ch(r, "accounts:session-seat", { sessionId: "ses_1" });
    assert.equal(s.seatId, "seat-2");
    // The resolver ignores the stored assignment…
    const res = await r.seatAssigner.resolve("claude", "ses_1");
    assert.equal(res.seatId, "seat-2");
    assert.equal(res.live, true, "seat-2 is the live login → pass-through");
    // …and records the move so session-seat has a lastMove.
    s = await ch(r, "accounts:session-seat", { sessionId: "ses_1" });
    assert.equal(s.seatId, "seat-2");
    assert.equal(s.lastMove.from, "seat-1");
    assert.equal(s.lastMove.fromLabel, "Seat 1");
    assert.equal(s.lastMove.reason, "manual");
    assert.equal(r.moves.length, 0, "no accounts.moved for a manual switch");
    // Counts: manual mode — all of the provider's assignments sit on the active seat.
    const view = (await ch(r, "accounts:list", {})).providers[0];
    assert.equal(allViewSeats(view).find((x) => x.id === "seat-2").conversations, 1);
    assert.equal(allViewSeats(view).find((x) => x.id === "seat-1").conversations, 0);
    assert.equal(view.nextSeatId, "seat-2");
    assert.equal(await ch(r, "accounts:session-seat", { sessionId: "unknown" }), null);
    assert.equal(await ch(r, "accounts:session-seat", {}), null);
  } finally {
    await r.cleanup();
  }
});

test("auto mode view: nextSeatId is the least-loaded seat; conversations counted per seat", async () => {
  const r = await rig();
  try {
    r.setSnaps([{ provider: "claude", seatId: "seat-1", windows: [{ kind: "session", pct: 70 }] }, { provider: "claude", seatId: "seat-2", windows: [{ kind: "session", pct: 10 }] }]);
    await r.seatAssigner.resolve("claude", "a");
    await r.seatAssigner.resolve("claude", "b");
    const v = (await ch(r, "accounts:list", {})).providers[0];
    assert.equal(v.nextSeatId, "seat-2");
    assert.equal(allViewSeats(v).find((x) => x.id === "seat-2").conversations, 2);
    assert.equal(allViewSeats(v).find((x) => x.id === "seat-2").load, 10);
  } finally {
    await r.cleanup();
  }
});

// ---- remove ---------------------------------------------------------------------

test("remove-seat: refused for the live seat; otherwise the seat, its directory and its conversations' assignments go", async () => {
  const r = await rig();
  try {
    assert.deepEqual(await ch(r, "accounts:remove-seat", { provider: "claude", seatId: "seat-2" }), { error: "live-seat" });
    assert.deepEqual(await ch(r, "accounts:remove-seat", { provider: "claude", seatId: "seat-99" }), { error: "unknown-seat" });
    assert.deepEqual(await ch(r, "accounts:remove-seat", { provider: "zzz", seatId: "seat-1" }), { error: "unknown-provider" });
    r.setSnaps([{ provider: "claude", seatId: "seat-1", windows: [{ kind: "session", pct: 1 }] }, { provider: "claude", seatId: "seat-2", windows: [{ kind: "session", pct: 50 }] }]);
    await r.seatAssigner.resolve("claude", "ses_x");
    assert.equal(r.seatAssigner.assignments("claude").ses_x.seatId, "seat-1");
    const dir = join(r.paths.seatsRoot, "claude", "seat-1");
    assert.equal(await r.exists(dir), true);
    await ch(r, "accounts:set-active", { provider: "claude", seatId: "seat-1" });

    const v = await ch(r, "accounts:remove-seat", { provider: "claude", seatId: "seat-1" });
    assert.deepEqual(allViewSeats(v).map((s) => s.id), ["seat-2"]);
    assert.equal(v.activeSeatId, "seat-2", "the active seat moved to a surviving seat");
    assert.equal(await r.exists(dir), false, "directory deleted");
    assert.deepEqual(r.seatAssigner.assignments("claude"), {}, "its conversations are re-placed on the next request");
    assert.equal(await ch(r, "accounts:session-seat", { sessionId: "ses_x" }), null);
    // Discovery does not bring it back.
    await r.accounts.discover({ force: true });
    assert.deepEqual(allSeats((await r.accounts.getStore()).providers.claude).map((s) => s.id), ["seat-2"]);
  } finally {
    await r.cleanup();
  }
});

// ---- add seat: Claude -----------------------------------------------------------

test("add-seat (claude): a fresh 0700 directory, the launcher is given THAT directory, connect is the claude-login shape; nothing is a seat yet", async () => {
  const r = await rig();
  try {
    const out = await ch(r, "accounts:add-seat", { provider: "claude" });
    assert.equal(out.seatId, "seat-3");
    assert.equal(out.connect.shape, "claude-login");
    assert.equal(out.connect.sessionKey, "claude-login-seat-3");
    const dir = join(r.paths.seatsRoot, "claude", "seat-3");
    assert.deepEqual(r.calls.claudeStart, [{ dir, seatId: "seat-3" }]);
    assert.equal(((await stat(dir)).mode & 0o777).toString(8), "700");
    assert.deepEqual(await ch(r, "accounts:seat-status", { seatId: "seat-3" }), { state: "pending" });
    const v = (await ch(r, "accounts:list", {})).providers[0];
    assert.deepEqual(allViewSeats(v).map((s) => s.id), ["seat-1", "seat-2"], "a pending seat is not listed");
    // Discovery must not adopt the half-made directory either.
    await writeFile(join(dir, ".credentials.json"), credsJson("tok-C"));
    await r.accounts.discover({ force: true });
    assert.equal(allSeats((await r.accounts.getStore()).providers.claude).length, 2, "reserved while the sign-in decides");
  } finally {
    await r.cleanup();
  }
});

test("add-seat (claude): login completes → identified, grouped by org, labelled, announced; a second add gets the next id", async () => {
  const r = await rig();
  try {
    r.profiles["tok-C"] = profileOf("u-C", "c@example.com");
    const { seatId } = await ch(r, "accounts:add-seat", { provider: "claude", label: "  Spare " });
    await writeFile(join(r.paths.seatsRoot, "claude", seatId, ".credentials.json"), credsJson("tok-C"));
    const st = await ch(r, "accounts:seat-status", { seatId });
    assert.equal(st.state, "ok");
    assert.equal(st.seat.id, "seat-3");
    assert.equal(st.seat.label, "Spare");
    assert.equal(st.seat.email, "c@example.com");
    assert.equal(st.seat.live, false);
    const v = (await ch(r, "accounts:list", {})).providers[0];
    assert.equal(v.accounts.length, 1, "same org → same account");
    assert.deepEqual(allViewSeats(v).map((s) => s.id), ["seat-1", "seat-2", "seat-3"]);
    // Idempotent: asking again still answers ok, and does not place twice.
    assert.equal((await ch(r, "accounts:seat-status", { seatId })).state, "ok");
    assert.equal(allSeats((await r.accounts.getStore()).providers.claude).length, 3);
    // Next add takes a fresh id, never a reused one.
    assert.equal((await ch(r, "accounts:add-seat", { provider: "claude" })).seatId, "seat-4");
  } finally {
    await r.cleanup();
  }
});

test("add-seat (claude): the same login again → failed/duplicate-login and the NEW directory is deleted", async () => {
  const r = await rig();
  try {
    r.profiles["tok-A2"] = profileOf("u-A", "a@example.com"); // same person as seat-1
    const { seatId } = await ch(r, "accounts:add-seat", { provider: "claude" });
    const dir = join(r.paths.seatsRoot, "claude", seatId);
    await writeFile(join(dir, ".credentials.json"), credsJson("tok-A2"));
    assert.deepEqual(await ch(r, "accounts:seat-status", { seatId }), { state: "failed", error: "duplicate-login" });
    assert.equal(await r.exists(dir), false);
    assert.equal(allSeats((await r.accounts.getStore()).providers.claude).length, 2);
    assert.equal(r.calls.claudeCancel.length, 1, "the login process is stopped too");
    // The answer stays stable.
    assert.deepEqual(await ch(r, "accounts:seat-status", { seatId }), { state: "failed", error: "duplicate-login" });
  } finally {
    await r.cleanup();
  }
});

test("add-seat (claude) with accountId + a DIFFERENT org: failed/different-org(orgName), parked (dir kept) until confirm", async () => {
  const r = await rig();
  try {
    r.profiles["tok-Z"] = profileOf("u-Z", "z@example.com", orgZ);
    const { seatId } = await ch(r, "accounts:add-seat", { provider: "claude", accountId: "acct-1" });
    const dir = join(r.paths.seatsRoot, "claude", seatId);
    await writeFile(join(dir, ".credentials.json"), credsJson("tok-Z"));
    assert.deepEqual(await ch(r, "accounts:seat-status", { seatId }), { state: "failed", error: "different-org", orgName: "Zeta" });
    assert.equal(await r.exists(dir), true, "kept, unplaced");
    assert.equal(allSeats((await r.accounts.getStore()).providers.claude).length, 2);
    await r.accounts.discover({ force: true });
    assert.equal(allSeats((await r.accounts.getStore()).providers.claude).length, 2, "discovery leaves the parked seat alone");

    const v = await ch(r, "accounts:add-seat-confirm", { seatId, newAccount: true });
    assert.equal(v.accounts.length, 2, "its own account, labelled by its org");
    assert.equal(v.accounts[1].label, "Zeta");
    assert.deepEqual(v.accounts[1].seats.map((s) => s.id), ["seat-3"]);
    assert.equal((await ch(r, "accounts:seat-status", { seatId })).state, "ok");
  } finally {
    await r.cleanup();
  }
});

test("add-seat-confirm {newAccount:false}: the seat goes into the account the user chose anyway; confirm of a non-parked seat → unknown-seat", async () => {
  const r = await rig();
  try {
    r.profiles["tok-Z"] = profileOf("u-Z", "z@example.com", orgZ);
    const { seatId } = await ch(r, "accounts:add-seat", { provider: "claude", accountId: "acct-1" });
    await writeFile(join(r.paths.seatsRoot, "claude", seatId, ".credentials.json"), credsJson("tok-Z"));
    await ch(r, "accounts:seat-status", { seatId });
    const v = await ch(r, "accounts:add-seat-confirm", { seatId, newAccount: false });
    assert.equal(v.accounts.length, 1);
    assert.equal(v.accounts[0].seats.length, 3);
    assert.deepEqual(await ch(r, "accounts:add-seat-confirm", { seatId, newAccount: false }), { error: "unknown-seat" }, "already placed");
    assert.deepEqual(await ch(r, "accounts:add-seat-confirm", { seatId: "ghost", newAccount: true }), { error: "unknown-seat" });
  } finally {
    await r.cleanup();
  }
});

test("cancel-seat: stops the login, deletes the directory, forgets the flow; unknown / repeated cancel is still {ok:true}", async () => {
  const r = await rig();
  try {
    const { seatId, connect } = await ch(r, "accounts:add-seat", { provider: "claude" });
    const dir = join(r.paths.seatsRoot, "claude", seatId);
    assert.equal(await r.exists(dir), true);
    assert.deepEqual(await ch(r, "accounts:cancel-seat", { seatId }), { ok: true });
    assert.equal(await r.exists(dir), false);
    assert.deepEqual(r.calls.claudeCancel, [connect.sessionKey]);
    assert.deepEqual(await ch(r, "accounts:cancel-seat", { seatId }), { ok: true });
    assert.deepEqual(await ch(r, "accounts:cancel-seat", { seatId: "ghost" }), { ok: true });
    assert.deepEqual(await ch(r, "accounts:seat-status", { seatId }), { state: "failed", error: "login-failed" });
    // The id is free again and discovery would not resurrect it.
    assert.equal((await ch(r, "accounts:add-seat", { provider: "claude" })).seatId, "seat-3");
  } finally {
    await r.cleanup();
  }
});

test("cancel of a PARKED different-org seat deletes it too", async () => {
  const r = await rig();
  try {
    r.profiles["tok-Z"] = profileOf("u-Z", "z@example.com", orgZ);
    const { seatId } = await ch(r, "accounts:add-seat", { provider: "claude", accountId: "acct-1" });
    const dir = join(r.paths.seatsRoot, "claude", seatId);
    await writeFile(join(dir, ".credentials.json"), credsJson("tok-Z"));
    await ch(r, "accounts:seat-status", { seatId });
    await ch(r, "accounts:cancel-seat", { seatId });
    assert.equal(await r.exists(dir), false);
  } finally {
    await r.cleanup();
  }
});

test("add-seat: validation (provider, label, accountId) and a launcher that fails to start leave nothing behind", async () => {
  const r = await rig();
  try {
    assert.deepEqual(await ch(r, "accounts:add-seat", { provider: "nope" }), { error: "unknown-provider" });
    assert.deepEqual(await ch(r, "accounts:add-seat", { provider: "claude", label: "x".repeat(50) }), { error: "invalid-label" });
    assert.deepEqual(await ch(r, "accounts:add-seat", { provider: "claude", accountId: "acct-404" }), { error: "unknown-seat" });
    assert.equal((await readdirSafe(join(r.paths.seatsRoot, "claude"))).length, 2, "nothing created for refused requests");

    const broken = await rig();
    try {
      broken.calls.claudeStart.length = 0;
      const mgr = createAccountsManager({
        accounts: broken.accounts,
        seatAssigner: broken.seatAssigner,
        claudeLogin: { start: async () => { throw new Error("spawn failed: /secret/path"); }, cancel() {} },
        codex: {},
        log: quiet,
      });
      assert.deepEqual(await mgr.channels["accounts:add-seat"]({ provider: "claude" }), { error: "login-failed" });
      assert.equal((await readdirSafe(join(broken.paths.seatsRoot, "claude"))).length, 2, "the new directory was removed");
      await broken.accounts.discover({ force: true });
      assert.equal(allSeats((await broken.accounts.getStore()).providers.claude).length, 2);
    } finally {
      await broken.cleanup();
    }
  } finally {
    await r.cleanup();
  }
});

async function readdirSafe(p) {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(p)).filter((n) => n.startsWith("seat-"));
}

test("a sign-in that never produces credentials fails after the timeout, deleting its directory", async () => {
  const r = await rig();
  try {
    r.state.timings = { loginTimeoutMs: 0 };
    const mgr = createAccountsManager({
      accounts: r.accounts,
      seatAssigner: r.seatAssigner,
      claudeLogin: { start: async (dir, seatId) => ({ shape: "claude-login", sessionKey: `k-${seatId}` }), cancel: (k) => r.calls.claudeCancel.push(k) },
      codex: {},
      timings: { loginTimeoutMs: 0 },
      log: quiet,
    });
    const { seatId } = await mgr.channels["accounts:add-seat"]({ provider: "claude" });
    const dir = join(r.paths.seatsRoot, "claude", seatId);
    await new Promise((res) => setTimeout(res, 5));
    assert.deepEqual(await mgr.channels["accounts:seat-status"]({ seatId }), { state: "failed", error: "login-failed" });
    assert.equal(await r.exists(dir), false);
  } finally {
    await r.cleanup();
  }
});

test("unexpected failures surface ONE safe literal — never a path or errno text", async () => {
  const r = await rig();
  try {
    const mgr = createAccountsManager({
      accounts: { ...r.accounts, seatStates: async () => { throw new Error("ENOENT: /home/dev/.manta-secrets/accounts/claude/seat-1"); } },
      seatAssigner: r.seatAssigner,
      claudeLogin: {},
      codex: {},
      log: quiet,
    });
    await assert.rejects(mgr.channels["accounts:list"]({}), (e) => e.message === ACCOUNTS_SAFE_ERROR_MESSAGE && !/ENOENT|home/.test(e.message));
  } finally {
    await r.cleanup();
  }
});

// ---- add seat: Codex ------------------------------------------------------------

test("add-seat (codex): borrows opencode's slot — the new login is saved as a seat (0600) and the previous live login is restored", async () => {
  const r = await rig({ codex: true, claude: false });
  try {
    assert.equal(allSeats((await r.accounts.getStore()).providers.codex).length, 1, "the live login was adopted as seat-1");
    const out = await ch(r, "accounts:add-seat", { provider: "codex", label: "Second" });
    assert.equal(out.seatId, "seat-2");
    assert.equal(out.connect.shape, "oauth-auto");
    assert.equal(r.calls.codexStart, 1);
    assert.deepEqual(await ch(r, "accounts:seat-status", { seatId: "seat-2" }), { state: "pending" });

    // opencode stores the NEW login in its one slot…
    await writeFile(r.paths.codexAuthPath, JSON.stringify({ openai: oauth("cx-B", "gpt-B") }));
    // …and tells us it landed.
    await r.mgr.onProviderLoginLanded({ id: "openai", epoch: 7 });

    const st = await ch(r, "accounts:seat-status", { seatId: "seat-2" });
    assert.equal(st.state, "ok");
    assert.equal(st.seat.id, "seat-2");
    assert.equal(st.seat.label, "Second");
    assert.equal(st.seat.live, false, "the live login did not change");
    const saved = JSON.parse(await readFile(join(r.paths.seatsRoot, "codex", "seat-2", "auth.json"), "utf-8"));
    assert.equal(saved.openai.access, "cx-B");
    assert.equal(((await stat(join(r.paths.seatsRoot, "codex", "seat-2", "auth.json"))).mode & 0o777).toString(8), "600");
    assert.equal(JSON.parse(await readFile(r.paths.codexAuthPath, "utf-8")).openai.access, "cx-A", "the previous live entry is back");
    assert.deepEqual(r.calls.restore, ["cx-A"]);
    const v = (await ch(r, "accounts:list", {})).providers[0];
    assert.equal(v.provider, "codex");
    assert.equal(v.accounts.length, 2, "a Codex login is its own account");
    assert.equal(allViewSeats(v).find((s) => s.id === "seat-1").live, true);
  } finally {
    await r.cleanup();
  }
});

test("add-seat (codex): if the restore FAILS the new login stays live and nothing is lost — the old login stays a seat", async () => {
  const r = await rig({ codex: true, claude: false });
  try {
    r.state.restoreOk = false;
    const { seatId } = await ch(r, "accounts:add-seat", { provider: "codex" });
    await writeFile(r.paths.codexAuthPath, JSON.stringify({ openai: oauth("cx-B", "gpt-B") }));
    await r.mgr.onProviderLoginLanded({ id: "openai", epoch: 7 });
    assert.equal((await ch(r, "accounts:seat-status", { seatId })).state, "ok");
    assert.equal(JSON.parse(await readFile(r.paths.codexAuthPath, "utf-8")).openai.access, "cx-B", "new login is the live one");
    const store = (await r.accounts.getStore()).providers.codex;
    assert.deepEqual(allSeats(store).map((s) => s.accountUuid).sort(), ["gpt-A", "gpt-B"], "both logins are seats");
    const v = (await ch(r, "accounts:list", {})).providers[0];
    assert.equal(allViewSeats(v).find((s) => s.id === seatId).live, true);
  } finally {
    await r.cleanup();
  }
});

test("add-seat (codex): a live login the store never saw is kept as its own seat when the restore fails", async () => {
  const r = await rig({ codex: true, claude: false });
  try {
    // The live slot was swapped to a login the store does not know.
    await writeFile(r.paths.codexAuthPath, JSON.stringify({ openai: oauth("cx-C", "gpt-C") }));
    r.state.restoreOk = false;
    const { seatId } = await ch(r, "accounts:add-seat", { provider: "codex" });
    await writeFile(r.paths.codexAuthPath, JSON.stringify({ openai: oauth("cx-B", "gpt-B") }));
    await r.mgr.onProviderLoginLanded({ id: "openai", epoch: 7 });
    assert.equal((await ch(r, "accounts:seat-status", { seatId })).state, "ok");
    const seats = allSeats((await r.accounts.getStore()).providers.codex);
    assert.deepEqual(seats.map((s) => s.accountUuid).sort(), ["gpt-A", "gpt-B", "gpt-C"]);
    const kept = seats.find((s) => s.accountUuid === "gpt-C");
    assert.equal(JSON.parse(await readFile(join(kept.credentialDir, "auth.json"), "utf-8")).openai.access, "cx-C");
  } finally {
    await r.cleanup();
  }
});

test("add-seat (codex): signing in as an account we already have → failed/duplicate-login, new directory deleted, live login untouched", async () => {
  const r = await rig({ codex: true, claude: false });
  try {
    const { seatId } = await ch(r, "accounts:add-seat", { provider: "codex" });
    await writeFile(r.paths.codexAuthPath, JSON.stringify({ openai: oauth("cx-A2", "gpt-A") })); // same ChatGPT account
    await r.mgr.onProviderLoginLanded({ id: "openai", epoch: 7 });
    assert.deepEqual(await ch(r, "accounts:seat-status", { seatId }), { state: "failed", error: "duplicate-login" });
    assert.equal(await r.exists(join(r.paths.seatsRoot, "codex", seatId)), false);
    assert.equal(allSeats((await r.accounts.getStore()).providers.codex).length, 1);
  } finally {
    await r.cleanup();
  }
});

test("add-seat (codex): cancel → the new directory never exists; a LATE approval is caught by the guard and the live login is put back", async () => {
  const r = await rig({ codex: true, claude: false });
  try {
    const { seatId } = await ch(r, "accounts:add-seat", { provider: "codex" });
    assert.deepEqual(await ch(r, "accounts:cancel-seat", { seatId }), { ok: true });
    assert.equal(await r.exists(join(r.paths.seatsRoot, "codex", seatId)), false);
    // The user approves the device code anyway, minutes later: opencode overwrites its slot.
    await writeFile(r.paths.codexAuthPath, JSON.stringify({ openai: oauth("cx-B", "gpt-B") }));
    await r.mgr.onProviderLoginLanded({ id: "openai", epoch: 7 });
    assert.equal(JSON.parse(await readFile(r.paths.codexAuthPath, "utf-8")).openai.access, "cx-A", "the live login is back");
    assert.equal(allSeats((await r.accounts.getStore()).providers.codex).length, 1, "no seat was created");
  } finally {
    await r.cleanup();
  }
});

test("add-seat (codex): a landing for another provider, or a stale epoch, is ignored", async () => {
  const r = await rig({ codex: true, claude: false });
  try {
    const { seatId } = await ch(r, "accounts:add-seat", { provider: "codex" });
    await writeFile(r.paths.codexAuthPath, JSON.stringify({ openai: oauth("cx-B", "gpt-B") }));
    await r.mgr.onProviderLoginLanded({ id: "anthropic" });
    await r.mgr.onProviderLoginLanded({ id: "openai", epoch: 3 });
    assert.deepEqual(await ch(r, "accounts:seat-status", { seatId }), { state: "pending" });
    await r.mgr.onProviderLoginLanded({ id: "openai", epoch: 7 });
    assert.equal((await ch(r, "accounts:seat-status", { seatId })).state, "ok");
  } finally {
    await r.cleanup();
  }
});

test("add-seat (codex): starting a second add supersedes the first (opencode has one wait per provider)", async () => {
  const r = await rig({ codex: true, claude: false });
  try {
    const a = await ch(r, "accounts:add-seat", { provider: "codex" });
    const b = await ch(r, "accounts:add-seat", { provider: "codex" });
    assert.notEqual(a.seatId, b.seatId);
    assert.deepEqual(await ch(r, "accounts:seat-status", { seatId: a.seatId }), { state: "failed", error: "login-failed" });
    assert.deepEqual(await ch(r, "accounts:seat-status", { seatId: b.seatId }), { state: "pending" });
  } finally {
    await r.cleanup();
  }
});

test("add-seat (codex): when opencode offers no OAuth (api-key shape) the add fails cleanly", async () => {
  const r = await rig({ codex: true, claude: false });
  try {
    r.state.codexShape = "api-key";
    assert.deepEqual(await ch(r, "accounts:add-seat", { provider: "codex" }), { error: "login-failed" });
    assert.equal((await readdirSafe(join(r.paths.seatsRoot, "codex"))).length, 1);
  } finally {
    await r.cleanup();
  }
});
