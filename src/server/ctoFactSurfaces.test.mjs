// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

// ctoFactSurfaces.test.mjs — BET-1409: the real §6.7 checkable-verify
// surfaces + §6.6 trace resolver, exercised through fakes only (no live
// tmux/git/multica/gh — every dep is injected).

import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMIT_SHA_RE, MESSAGE_REF_RE, ciConclusionMatches, createFactSurfaces } from "./ctoFactSurfaces.mjs";

function makeSurfaces(over = {}) {
  const calls = { surfaceExists: [], verify: [], resolveRef: [] };
  const surfaces = createFactSurfaces({
    cwdsFor: async (project) => (project == null ? ["/repo/a", "/repo/b"] : project === "p1" ? ["/repo/p1"] : []),
    runGit: async (cwd, args) => {
      if (args[0] === "cat-file" && args[2] === "ghost") throw new Error("not found");
      return "";
    },
    hasBinary: async (name) => ["git", "gh", "multica"].includes(name),
    issueLookup: async (key) => (key === "BET-1" ? { found: true, open: true } : key === "BET-2" ? { found: true, open: false } : null),
    ciLatestConclusion: async (cwd) => (cwd === "/repo/p1" ? "success" : null),
    messageExists: async (id) => (id === "msg_ghost" ? false : id === "msg_ok" ? true : null),
    issueToolConsented: async () => true,
    ...over,
  });
  return { surfaces, calls };
}

// ---------------------------------------------------------------------------
// ciConclusionMatches (pure probe polarity)
// ---------------------------------------------------------------------------

test("ciConclusionMatches: positive probes match success only", () => {
  for (const p of ["green", "passing", "passed"]) {
    assert.equal(ciConclusionMatches(p, "success"), true, p);
    assert.equal(ciConclusionMatches(p, "failure"), false, p);
    assert.equal(ciConclusionMatches(p, "cancelled"), false, p);
  }
});

test("ciConclusionMatches: negative probes match any completed non-success", () => {
  for (const p of ["failed", "failing", "broken"]) {
    assert.equal(ciConclusionMatches(p, "failure"), true, p);
    assert.equal(ciConclusionMatches(p, "timed_out"), true, p);
    assert.equal(ciConclusionMatches(p, "startup_failure"), true, p);
    assert.equal(ciConclusionMatches(p, "success"), false, p);
  }
  assert.equal(ciConclusionMatches("unknown-probe", "success"), false);
  assert.equal(ciConclusionMatches("green", ""), false);
});

// ---------------------------------------------------------------------------
// surfaceExists — the §6.7 opportunism guard
// ---------------------------------------------------------------------------

test("surfaceExists git: requires the binary AND a git-ready cwd for the project", async () => {
  const { surfaces } = makeSurfaces();
  assert.equal(await surfaces.surfaceExists("git", { project: "p1" }), true);
  assert.equal(await surfaces.surfaceExists("git", { project: "gone" }), false);
  const noBin = makeSurfaces({ hasBinary: async () => false });
  assert.equal(await noBin.surfaces.surfaceExists("git", { project: "p1" }), false);
  const noRepo = makeSurfaces({ gitRepoReady: async () => false });
  assert.equal(await noRepo.surfaces.surfaceExists("git", { project: "p1" }), false);
});

test("surfaceExists ci: requires gh AND a git-ready cwd", async () => {
  const { surfaces } = makeSurfaces();
  assert.equal(await surfaces.surfaceExists("ci", { project: "p1" }), true);
  assert.equal(await surfaces.surfaceExists("ci", { project: "gone" }), false);
  const noGh = makeSurfaces({ hasBinary: async (n) => n === "git" });
  assert.equal(await noGh.surfaces.surfaceExists("ci", { project: "p1" }), false);
});

test("surfaceExists issue: requires the multica binary AND consented issue tool", async () => {
  const { surfaces } = makeSurfaces();
  assert.equal(await surfaces.surfaceExists("issue"), true);
  const noConsent = makeSurfaces({ issueToolConsented: async () => false });
  assert.equal(await noConsent.surfaces.surfaceExists("issue"), false);
  const noCli = makeSurfaces({ hasBinary: async (n) => n !== "multica" });
  assert.equal(await noCli.surfaces.surfaceExists("issue"), false);
});

test("surfaceExists: unimplemented surfaces (version) stay false — ordinary facts", async () => {
  const { surfaces } = makeSurfaces();
  assert.equal(await surfaces.surfaceExists("version"), false);
  assert.equal(await surfaces.surfaceExists("bogus"), false);
  assert.equal(await surfaces.surfaceExists(undefined), false);
});

test("surfaceExists: a throwing dep degrades to false, never a throw into the engine", async () => {
  const { surfaces } = makeSurfaces({ cwdsFor: async () => { throw new Error("tmux down"); } });
  assert.equal(await surfaces.surfaceExists("git", { project: "p1" }), false);
});

// ---------------------------------------------------------------------------
// verify — the §6.7 probe
// ---------------------------------------------------------------------------

test("verify git: cat-file -e confirms branch/commit probes in the project cwd", async () => {
  const seen = [];
  const { surfaces } = makeSurfaces({
    runGit: async (cwd, args) => {
      seen.push([cwd, args]);
      if (args[2] === "ghost") throw new Error("not found");
      return "";
    },
  });
  assert.deepEqual(await surfaces.verify({ surface: "git", probe: "multica/BET-1/x", project: "p1" }), {
    ok: true,
    result: "exists",
  });
  assert.deepEqual(await surfaces.verify({ surface: "git", probe: "a8df41a9", project: "p1" }), {
    ok: true,
    result: "exists",
  });
  assert.deepEqual(await surfaces.verify({ surface: "git", probe: "ghost", project: "p1" }), {
    ok: false,
    result: "missing",
  });
  assert.equal(seen.length, 3);
  assert.equal(seen[0][0], "/repo/p1");
  assert.deepEqual(seen[0][1], ["cat-file", "-e", "multica/BET-1/x"]);
});

test("verify git: no ready cwd → failed check, not a crash", async () => {
  const { surfaces } = makeSurfaces({ gitRepoReady: async () => false });
  assert.deepEqual(await surfaces.verify({ surface: "git", probe: "main", project: "p1" }), {
    ok: false,
    result: "no surface",
  });
});

test("verify ci: probe polarity against the latest completed conclusion", async () => {
  const { surfaces } = makeSurfaces();
  assert.equal((await surfaces.verify({ surface: "ci", probe: "green", project: "p1" })).ok, true);
  assert.equal((await surfaces.verify({ surface: "ci", probe: "failed", project: "p1" })).ok, false);
  // A ready cwd with no completed run → unavailable (a failed check, not ok).
  const noRuns = makeSurfaces({ ciLatestConclusion: async () => null });
  const r = await noRuns.surfaces.verify({ surface: "ci", probe: "green", project: "p1" });
  assert.equal(r.ok, false);
  assert.equal(r.result, "unavailable");
  // No cwd at all → no surface.
  const gone = await surfaces.verify({ surface: "ci", probe: "green", project: "other" });
  assert.equal(gone.ok, false);
  assert.equal(gone.result, "no surface");
});

test("verify issue: open → ok, closed/not-found/unavailable → not ok", async () => {
  const { surfaces } = makeSurfaces();
  assert.deepEqual(await surfaces.verify({ surface: "issue", probe: "BET-1" }), { ok: true, result: "open" });
  assert.deepEqual(await surfaces.verify({ surface: "issue", probe: "BET-2" }), { ok: false, result: "closed" });
  const unavailable = await surfaces.verify({ surface: "issue", probe: "NOPE-9" });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.result, "unavailable");
});

test("verify: unknown surface → failed", async () => {
  const { surfaces } = makeSurfaces();
  assert.deepEqual(await surfaces.verify({ surface: "version", probe: "1.2.3" }), {
    ok: false,
    result: "no surface",
  });
});

// ---------------------------------------------------------------------------
// resolveRef — the §6.6 trace spot-check (never over-rejects)
// ---------------------------------------------------------------------------

test("resolveRef: message ids resolve via the db handle; null db is no-opinion", async () => {
  const { surfaces } = makeSurfaces();
  assert.equal(await surfaces.resolveRef("msg_ok"), true);
  assert.equal(await surfaces.resolveRef("msg_ghost"), false);
  assert.equal(await surfaces.resolveRef("ses_fa184ccccffey4AFyFsPG9w1T2"), true);
  const noDb = makeSurfaces({ messageExists: async () => null });
  assert.equal(await noDb.surfaces.resolveRef("msg_ghost"), true);
});

test("resolveRef: commit shas resolve against ANY candidate cwd", async () => {
  const tried = [];
  const { surfaces } = makeSurfaces({
    // Only /repo/b knows ONE specific sha — the null-project candidate list
    // must all be tried before the spot-check gives up.
    runGit: async (cwd, args) => {
      tried.push([cwd, args[2]]);
      if (cwd !== "/repo/b" || args[2] !== "a8df41a9") throw new Error("not found");
      return "";
    },
  });
  assert.equal(await surfaces.resolveRef("a8df41a9"), true);
  assert.deepEqual(tried, [["/repo/a", "a8df41a9"], ["/repo/b", "a8df41a9"]]);
  tried.length = 0;
  assert.equal(await surfaces.resolveRef("deadbee"), false);
  assert.deepEqual(tried, [["/repo/a", "deadbee"], ["/repo/b", "deadbee"]]);
});

test("resolveRef: a 32-hex box_id is NOT a commit — no opinion, never a rejection", async () => {
  const tried = [];
  const { surfaces } = makeSurfaces({
    runGit: async (cwd, args) => {
      tried.push(args[2]);
      return "";
    },
  });
  assert.equal(await surfaces.resolveRef("ab49c3e2023943cb81cf32d3ee9102f2"), true);
  assert.deepEqual(tried, [], "box ids must not be cat-file'd");
});

test("resolveRef: git-less box, unknown shapes, empty → no-opinion pass / empty fails", async () => {
  const noGit = makeSurfaces({ hasBinary: async () => false, gitRepoReady: async () => false });
  assert.equal(await noGit.surfaces.resolveRef("a8df41a9"), true);
  const { surfaces } = makeSurfaces();
  assert.equal(await surfaces.resolveRef("src/server/ctoFacts.mjs"), true);
  assert.equal(await surfaces.resolveRef("BET-1409"), true);
  assert.equal(await surfaces.resolveRef("https://github.com/x/y/pull/1"), true);
  assert.equal(await surfaces.resolveRef(""), false);
  assert.equal(await surfaces.resolveRef(null), false);
});

test("resolveRef: throwing deps degrade to no-opinion, never a throw", async () => {
  const { surfaces } = makeSurfaces({ messageExists: async () => { throw new Error("db boom"); } });
  assert.equal(await surfaces.resolveRef("msg_ok"), true);
});

// ---------------------------------------------------------------------------
// regex shapes
// ---------------------------------------------------------------------------

test("ref regexes: commit shapes (7-12 hex, full sha1) and opencode ids", () => {
  assert.ok(COMMIT_SHA_RE.test("a8df41a"));
  assert.ok(COMMIT_SHA_RE.test("a8df41a9"));
  assert.ok(COMMIT_SHA_RE.test("a8df41a999b"));
  assert.ok(COMMIT_SHA_RE.test("a8df41a999bbbbccccddddeeeeffff0000111122"));
  assert.ok(!COMMIT_SHA_RE.test("a8df41")); // 6 — too short
  assert.ok(!COMMIT_SHA_RE.test("ab49c3e2023943cb81cf32d3ee9102f2")); // 32-hex box_id
  assert.ok(!COMMIT_SHA_RE.test("msg_00e7066d0001cUkaSdjol8L1SO"));
  assert.ok(!COMMIT_SHA_RE.test("BET-1409"));
  assert.ok(MESSAGE_REF_RE.test("msg_00e7066d0001cUkaSdjol8L1SO"));
  assert.ok(MESSAGE_REF_RE.test("ses_fa184ccccffey4AFyFsPG9w1T2"));
  assert.ok(MESSAGE_REF_RE.test("part_abc123"));
  assert.ok(!MESSAGE_REF_RE.test("a8df41a"));
  assert.ok(!MESSAGE_REF_RE.test("msg-00e7066d"));
});
