// Credential recovery stays away from seat traffic (seat routing spec §3.5): the live
// login is refreshed only when it can matter (no seats, or the failing session is served
// by it), holds a token, and has not already been found dead for this very content.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  _resetLiveRefreshMemory,
  _resetRecoveryCooldownState,
  createCredentialRefreshSweep,
  liveRefreshWorthTrying,
  maybeRecoverCredentials,
  rememberLiveRefreshOutcome,
} from "./opencode.mjs";

const raw = (access, refresh = `r-${access}`) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: 1 } });
const BLANK = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } });
const credError = (sessionID = "ses_1") => ({
  type: "session.error",
  properties: { sessionID, error: { data: { message: "Claude Code credentials are unavailable or expired. Run `claude` to refresh them." } } },
});

beforeEach(() => {
  _resetLiveRefreshMemory();
  _resetRecoveryCooldownState();
});

function recover(event, { live = raw("tok"), served = () => true, clock = { t: 1_000_000 } } = {}) {
  const refreshes = [];
  const run = () =>
    maybeRecoverCredentials(event, {
      isLiveServed: served,
      readRaw: () => live,
      refresh: async () => void refreshes.push(1),
      now: () => clock.t,
    });
  return { run, refreshes, clock };
}

test("a credential error on a session the live login serves refreshes the live login", async () => {
  const r = recover(credError());
  await r.run();
  assert.equal(r.refreshes.length, 1);
});

test("a box with no seats (isLiveServed → true for everyone) still recovers; so does a caller that passes no gate", async () => {
  const noSeats = recover(credError("whoever"), { served: () => true });
  await noSeats.run();
  assert.equal(noSeats.refreshes.length, 1);
  _resetRecoveryCooldownState();
  const refreshes = [];
  await maybeRecoverCredentials(credError(), { readRaw: () => raw("tok"), refresh: async () => void refreshes.push(1), now: () => 1 });
  assert.equal(refreshes.length, 1);
});

test("skipped when the failing session sits on a directory seat — and the cooldown is not spent on it", async () => {
  const seen = [];
  const r = recover(credError("ses_on_seat"), { served: (sid) => (seen.push(sid), false) });
  await r.run();
  assert.deepEqual(seen, ["ses_on_seat"], "the gate is asked about the session that failed");
  assert.equal(r.refreshes.length, 0);
  // The next failure of a live-served session is not held back by the skipped one.
  const next = recover(credError("ses_live"), { clock: r.clock });
  await next.run();
  assert.equal(next.refreshes.length, 1);
});

test("skipped when the live file holds no token (the blanked login of 11-05), or no file at all", async () => {
  const blank = recover(credError(), { live: BLANK });
  await blank.run();
  assert.equal(blank.refreshes.length, 0);
  const missing = recover(credError(), { live: null });
  await missing.run();
  assert.equal(missing.refreshes.length, 0);
  const garbage = recover(credError(), { live: "not json" });
  await garbage.run();
  assert.equal(garbage.refreshes.length, 0);
});

test("skipped once the live refresh said refresh-token-expired for THIS content; a changed file is tried again", async () => {
  const dead = raw("tok-dead");
  rememberLiveRefreshOutcome({ ok: false, reason: "refresh-token-expired" }, () => dead);
  const same = recover(credError(), { live: dead });
  await same.run();
  assert.equal(same.refreshes.length, 0, "the same bytes are not worth another `claude` run");
  const changed = recover(credError(), { live: raw("tok-resigned"), clock: same.clock });
  await changed.run();
  assert.equal(changed.refreshes.length, 1, "someone signed in again: the new content is tried");
});

test("other failures remember nothing; a success forgets", async () => {
  const content = raw("tok-x");
  rememberLiveRefreshOutcome({ ok: false, reason: "failed" }, () => content);
  rememberLiveRefreshOutcome({ ok: false, reason: "no-credentials" }, () => content);
  assert.equal(liveRefreshWorthTrying({ readRaw: () => content }), true);
  rememberLiveRefreshOutcome({ ok: false, reason: "refresh-token-expired" }, () => content);
  assert.equal(liveRefreshWorthTrying({ readRaw: () => content }), false);
  rememberLiveRefreshOutcome({ ok: true }, () => content);
  assert.equal(liveRefreshWorthTrying({ readRaw: () => content }), true);
});

test("the cooldown still collapses a burst, and other errors never trigger a refresh", async () => {
  const r = recover(credError());
  await r.run();
  r.clock.t += 5_000;
  await r.run();
  assert.equal(r.refreshes.length, 1, "inside the cooldown");
  r.clock.t += 61_000;
  await r.run();
  assert.equal(r.refreshes.length, 2);
  const other = recover({ type: "session.error", properties: { sessionID: "s", error: { data: { message: "something else" } } } });
  await other.run();
  assert.equal(other.refreshes.length, 0);
  const idle = recover({ type: "session.idle", properties: { sessionID: "s" } });
  await idle.run();
  assert.equal(idle.refreshes.length, 0);
});

// ---- the proactive sweep ----------------------------------------------------

function sweepOver({ creds, live }) {
  const calls = { live: 0, seat: [] };
  const { sweep } = createCredentialRefreshSweep({
    readCreds: () => creds,
    refresh: async () => void calls.live++,
    shouldRefresh: () => true,
    liveRefreshWorthIt: (c) => liveRefreshWorthTrying({ creds: c, readRaw: () => live }),
    now: () => 1,
    listSeatTargets: async () => [{ seatId: "seat-2", dir: "/d/2" }],
    readSeatCreds: () => ({ accessToken: "seat-tok", expiresAt: 1 }),
    refreshSeat: async (t) => void calls.seat.push(t.seatId),
  });
  return { sweep, calls };
}

test("sweep: a live file with no token, or one already found dead for this content, is not refreshed — seat refreshes are untouched", async () => {
  const empty = sweepOver({ creds: { accessToken: "", refreshToken: "", expiresAt: 0 }, live: BLANK });
  await empty.sweep();
  assert.equal(empty.calls.live, 0);
  assert.deepEqual(empty.calls.seat, ["seat-2"]);

  const dead = raw("tok-dead");
  rememberLiveRefreshOutcome({ ok: false, reason: "refresh-token-expired" }, () => dead);
  const remembered = sweepOver({ creds: { accessToken: "tok-dead", refreshToken: "r-tok-dead", expiresAt: 1 }, live: dead });
  await remembered.sweep();
  assert.equal(remembered.calls.live, 0);
  assert.deepEqual(remembered.calls.seat, ["seat-2"]);

  const fresh = sweepOver({ creds: { accessToken: "tok-new", refreshToken: "r-tok-new", expiresAt: 1 }, live: raw("tok-new") });
  await fresh.sweep();
  assert.equal(fresh.calls.live, 1, "a live login with a token and no dead mark is refreshed as before");
});
