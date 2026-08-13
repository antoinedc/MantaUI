// auth.test.mjs — the §3.3 auth ladder (BET-788). No live network, no real gh
// subprocess, no real secrets vault: shell + loadSecretsFn are injected.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveToken, invalidateToken } from "./auth.mjs";

// The module-level auth cache persists across test cases in this file — clear
// it before each so a cached github.com resolution from one test can't leak
// into the next.
beforeEach(() => {
  invalidateToken("github.com");
  invalidateToken("gitlab.com");
  invalidateToken("");
});

// A mutable clock so tests can simulate the TTL elapsing / staying put.
function makeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

// shell that yields a given token (or rejects → "no CLI token").
function shellReturning(token) {
  return async () => ({ stdout: token });
}

function loadWith(secrets) {
  return () => secrets;
}

const STORED = [{ id: "s1", key: "GITHUB_TOKEN", value: "ghp_stored", scope: "shared", sessionID: null, project: null }];

test("resolveToken: CLI wins over stored", async () => {
  const r = await resolveToken("github.com", {
    shell: shellReturning("ghp_cli\n"),
    loadSecretsFn: loadWith(STORED),
  });
  assert.deepEqual(r, { token: "ghp_cli", source: "cli" });
});

test("resolveToken: stored secret used when no CLI token", async () => {
  const r = await resolveToken("github.com", {
    shell: shellReturning(""),
    loadSecretsFn: loadWith(STORED),
  });
  assert.deepEqual(r, { token: "ghp_stored", source: "stored" });
});

test("resolveToken: neither → null", async () => {
  const r = await resolveToken("github.com", {
    shell: shellReturning(""),
    loadSecretsFn: loadWith([]),
  });
  assert.equal(r, null);
});

test("resolveToken: unknown/empty host → null without touching anything", async () => {
  let shellCalls = 0;
  const r = await resolveToken("", {
    shell: async () => (shellCalls++, { stdout: "x" }),
    loadSecretsFn: loadWith([]),
  });
  assert.equal(r, null);
  assert.equal(shellCalls, 0);
});

test("resolveToken: CLI failure (gh missing) falls through to stored", async () => {
  const r = await resolveToken("github.com", {
    shell: async () => {
      throw new Error("gh not found");
    },
    loadSecretsFn: loadWith(STORED),
  });
  assert.deepEqual(r, { token: "ghp_stored", source: "stored" });
});

test("resolveToken: cached hit within TTL does not re-invoke the shell", async () => {
  const clock = makeClock();
  const seen = [];
  const shell = async () => (seen.push(1), { stdout: "ghp_cached" });
  await resolveToken("github.com", { shell, loadSecretsFn: loadWith([]), now: clock.now });
  await resolveToken("github.com", { shell, loadSecretsFn: loadWith([]), now: clock.now });
  assert.equal(seen.length, 1, "second resolve within TTL is served from cache");
});

test("resolveToken: cache expires after TTL and re-reads", async () => {
  const clock = makeClock();
  let token = "ghp_v1";
  const shell = async () => ({ stdout: token });
  const a = await resolveToken("github.com", { shell, loadSecretsFn: loadWith([]), now: clock.now });
  assert.equal(a.token, "ghp_v1");
  token = "ghp_v2"; // rotated out-of-band while the box stayed up
  clock.advance(61_000);
  const b = await resolveToken("github.com", { shell, loadSecretsFn: loadWith([]), now: clock.now });
  assert.equal(b.token, "ghp_v2", "rotation picked up after TTL");
});

test("invalidateToken clears the cache immediately", async () => {
  const clock = makeClock();
  let token = "ghp_a";
  const shell = async () => ({ stdout: token });
  await resolveToken("github.com", { shell, loadSecretsFn: loadWith([]), now: clock.now });
  token = "ghp_b";
  invalidateToken("github.com");
  const r = await resolveToken("github.com", { shell, loadSecretsFn: loadWith([]), now: clock.now });
  assert.equal(r.token, "ghp_b", "invalidate forces a re-read before TTL");
});
