import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseBlockerKeys,
  decideUnblock,
  TERMINAL_STATUSES,
  parseDeliverablePaths,
  decideDeliverable,
  resolveNextOwner,
} from "./multica-unblock.mjs";

describe("parseBlockerKeys", () => {
  test("pulls keys out of a real waiting_on note", () => {
    // Verbatim from BET-297, which stalled the website epic.
    const note =
      "BET-294 (site.css extraction, in_progress) and BET-295 (deploy " +
      "verify-glob, in_progress). Both must merge before this can start.";
    assert.deepEqual(parseBlockerKeys(note), ["BET-294", "BET-295"]);
  });

  test("de-duplicates repeated keys, preserving first-seen order", () => {
    assert.deepEqual(
      parseBlockerKeys("BET-302 blocks this; see BET-297 and BET-302 again"),
      ["BET-302", "BET-297"],
    );
  });

  test("is case-insensitive but normalises to upper case", () => {
    assert.deepEqual(parseBlockerKeys("bet-12 and Bet-13"), ["BET-12", "BET-13"]);
  });

  test("returns empty for prose with no keys", () => {
    assert.deepEqual(parseBlockerKeys("waiting on design review"), []);
  });

  test("returns empty for null/undefined/non-string", () => {
    assert.deepEqual(parseBlockerKeys(null), []);
    assert.deepEqual(parseBlockerKeys(undefined), []);
    assert.deepEqual(parseBlockerKeys(42), []);
  });

  test("does not match bare numbers or PR references", () => {
    assert.deepEqual(parseBlockerKeys("see PR #245 and issue 297"), []);
  });

  test("handles other project prefixes", () => {
    assert.deepEqual(parseBlockerKeys("TEN-640 must ship"), ["TEN-640"]);
  });
});

describe("decideUnblock", () => {
  const blocked = (waiting_on) => ({
    identifier: "BET-999",
    status: "blocked",
    metadata: waiting_on === undefined ? {} : { waiting_on },
  });

  test("unblocks when every named blocker is done", () => {
    const r = decideUnblock(
      blocked("BET-294 and BET-295 must merge"),
      new Map([
        ["BET-294", "done"],
        ["BET-295", "done"],
      ]),
    );
    assert.equal(r.unblock, true);
    assert.deepEqual(r.blockers, ["BET-294", "BET-295"]);
  });

  test("treats cancelled as finished", () => {
    const r = decideUnblock(blocked("BET-1"), new Map([["BET-1", "cancelled"]]));
    assert.equal(r.unblock, true);
  });

  test("stays blocked when any blocker is unfinished", () => {
    const r = decideUnblock(
      blocked("BET-294 and BET-295"),
      new Map([
        ["BET-294", "done"],
        ["BET-295", "in_review"],
      ]),
    );
    assert.equal(r.unblock, false);
    assert.match(r.reason, /BET-295/);
  });

  test("REGRESSION: an unresolvable blocker must never unblock", () => {
    // A transient API error resolves to null. If that counted as "done" a
    // network blip would silently unblock the whole board.
    const r = decideUnblock(blocked("BET-294"), new Map([["BET-294", null]]));
    assert.equal(r.unblock, false);
  });

  test("blocker absent from the map does not unblock", () => {
    const r = decideUnblock(blocked("BET-294"), new Map());
    assert.equal(r.unblock, false);
  });

  test("leaves human-blocked issues alone when no key is named", () => {
    const r = decideUnblock(blocked("waiting on Antoine to review the design"), new Map());
    assert.equal(r.unblock, false);
    assert.match(r.reason, /no blocker keys/);
  });

  test("leaves issues with no waiting_on alone", () => {
    const r = decideUnblock(blocked(undefined), new Map());
    assert.equal(r.unblock, false);
  });

  test("ignores issues that are not blocked", () => {
    const r = decideUnblock(
      { identifier: "BET-1", status: "todo", metadata: { waiting_on: "BET-2" } },
      new Map([["BET-2", "done"]]),
    );
    assert.equal(r.unblock, false);
    assert.equal(r.reason, "not blocked");
  });

  test("REGRESSION: ignores a self-reference in waiting_on", () => {
    // Real note shape from BET-300: it names itself alongside its blockers.
    // Counting itself would mean waiting on its own blocked status forever.
    const issue = {
      identifier: "BET-300",
      status: "blocked",
      metadata: {
        waiting_on: "BET-299 (SEO pages). BET-300 cannot start until that lands.",
      },
    };
    const r = decideUnblock(issue, new Map([["BET-299", "done"]]));
    assert.equal(r.unblock, true, "self-reference must not block");
    assert.deepEqual(r.blockers, ["BET-299"]);
  });

  test("an issue naming only itself is left alone, not unblocked", () => {
    const issue = {
      identifier: "BET-300",
      status: "blocked",
      metadata: { waiting_on: "BET-300 needs a design decision first" },
    };
    const r = decideUnblock(issue, new Map());
    assert.equal(r.unblock, false);
    assert.match(r.reason, /no blocker keys/);
  });

  test("tolerates a malformed issue object", () => {
    assert.equal(decideUnblock({}, new Map()).unblock, false);
    assert.equal(decideUnblock(null, new Map()).unblock, false);
  });
});

describe("resolveNextOwner", () => {
  // The live workspace shape at the time this key was introduced.
  const agents = new Map([
    ["manta-dev", "ab49c3e2"],
    ["manta-pm", "df781c72"],
    ["macos", "e6d7e43d"],
  ]);

  test("resolves the agent named in next_owner", () => {
    const r = resolveNextOwner({ metadata: { next_owner: "macos" } }, agents);
    assert.equal(r.assign, true);
    assert.equal(r.id, "e6d7e43d");
    assert.equal(r.name, "macos");
  });

  test("is case- and whitespace-insensitive on the declared name", () => {
    const r = resolveNextOwner({ metadata: { next_owner: "  Manta-Dev " } }, agents);
    assert.equal(r.assign, true);
    assert.equal(r.id, "ab49c3e2");
  });

  test("no next_owner is not an error — the issue releases unowned, as before", () => {
    const r = resolveNextOwner({ metadata: {} }, agents);
    assert.equal(r.assign, false);
    assert.equal(r.unresolved, undefined);
    assert.match(r.reason, /no next_owner/);
  });

  test("an empty or blank next_owner counts as absent, not as a typo", () => {
    for (const v of ["", "   "]) {
      const r = resolveNextOwner({ metadata: { next_owner: v } }, agents);
      assert.equal(r.assign, false);
      assert.equal(r.unresolved, undefined);
    }
  });

  test("REGRESSION: an unknown agent must NOT release the issue", () => {
    // Releasing on a typo strands the issue as an unassigned `todo` that has
    // left the blocked list for good — the exact silent stall (BET-556..559)
    // this key exists to prevent. It must stay blocked and stay in scope.
    const r = resolveNextOwner({ metadata: { next_owner: "better-ui-dev" } }, agents);
    assert.equal(r.assign, false);
    assert.equal(r.unresolved, "better-ui-dev");
    assert.match(r.reason, /not an agent/);
  });

  test("a human name is not an agent — never assign a person automatically", () => {
    const r = resolveNextOwner({ metadata: { next_owner: "Antoine" } }, agents);
    assert.equal(r.assign, false);
    assert.equal(r.unresolved, "Antoine");
  });

  test("tolerates malformed issues and a missing agent map", () => {
    assert.equal(resolveNextOwner(null, agents).assign, false);
    assert.equal(resolveNextOwner({}, agents).assign, false);
    assert.equal(resolveNextOwner({ metadata: { next_owner: 42 } }, agents).assign, false);
    // An agent list that failed to load must never resolve an owner.
    const r = resolveNextOwner({ metadata: { next_owner: "macos" } }, new Map());
    assert.equal(r.assign, false);
    assert.equal(r.unresolved, "macos");
  });
});

describe("TERMINAL_STATUSES", () => {
  test("covers both cancelled spellings and excludes in-flight states", () => {
    assert.ok(TERMINAL_STATUSES.has("done"));
    assert.ok(TERMINAL_STATUSES.has("cancelled"));
    assert.ok(TERMINAL_STATUSES.has("canceled"));
    for (const s of ["todo", "in_progress", "in_review", "blocked"]) {
      assert.ok(!TERMINAL_STATUSES.has(s), `${s} must not be terminal`);
    }
  });
});

describe("parseDeliverablePaths", () => {
  test("splits a newline-separated metadata value touching real BET-481 shape", () => {
    assert.deepEqual(
      parseDeliverablePaths("spike/native-visual/SCROLL-FINDING.md\nspike/native-visual/capture.sh"),
      ["spike/native-visual/SCROLL-FINDING.md", "spike/native-visual/capture.sh"],
    );
  });

  test("trims whitespace and drops empty lines", () => {
    assert.deepEqual(
      parseDeliverablePaths("  a/b.md \n\n c/d.sh \n"),
      ["a/b.md", "c/d.sh"],
    );
  });

  test("returns empty for a non-string value", () => {
    assert.deepEqual(parseDeliverablePaths(null), []);
    assert.deepEqual(parseDeliverablePaths(undefined), []);
    assert.deepEqual(parseDeliverablePaths(42), []);
  });

  test("returns empty for a blank string", () => {
    assert.deepEqual(parseDeliverablePaths("   \n  "), []);
  });
});

describe("decideDeliverable", () => {
  const done = (branch, paths) => ({
    identifier: "BET-481",
    status: "done",
    metadata: {
      ...(branch ? { deliverable_branch: branch } : {}),
      ...(paths ? { deliverable_paths: paths } : {}),
    },
  });

  test("REGRESSION: both keys set and every path present → no change", () => {
    const r = decideDeliverable(done("spike/native-visual", "spike/native-visual/SCROLL-FINDING.md"), new Set(["spike/native-visual/SCROLL-FINDING.md"]));
    assert.equal(r.act, false);
    assert.match(r.reason, /present/);
  });

  test("both keys set, one path missing → in_review + deliverable_missing", () => {
    const paths = "a/b.md\nc/d.md";
    const r = decideDeliverable(done("feat/x", paths), new Set(["a/b.md"]));
    assert.equal(r.act, true);
    assert.equal(r.status, "in_review");
    assert.deepEqual(r.missing, ["c/d.md"]);
  });

  test("both keys set, branch missing → in_review + branch not found", () => {
    const r = decideDeliverable(done("spike/native-visual", "a/b.md"), null);
    assert.equal(r.act, true);
    assert.equal(r.status, "in_review");
    assert.deepEqual(r.missing, ["branch not found"]);
  });

  test("REGRESSION: only one of the two keys set → no change", () => {
    const branchOnly = done("spike/native-visual", null);
    assert.equal(decideDeliverable(branchOnly, new Set()).act, false);
    const pathsOnly = done(null, "a/b.md");
    assert.equal(decideDeliverable(pathsOnly, new Set()).act, false);
  });

  test("neither key set → no change", () => {
    assert.equal(decideDeliverable({ identifier: "BET-1", status: "done", metadata: {} }, new Set()).act, false);
    assert.equal(decideDeliverable({ identifier: "BET-1", status: "done", metadata: undefined }, new Set()).act, false);
  });

  test("issue not done → no change, even with keys set", () => {
    const r = decideDeliverable(
      { identifier: "BET-1", status: "in_review", metadata: { deliverable_branch: "x", deliverable_paths: "a/b.md" } },
      null,
    );
    assert.equal(r.act, false);
  });

  test("tolerates a malformed issue object", () => {
    assert.equal(decideDeliverable(null, new Set()).act, false);
    assert.equal(decideDeliverable({}, new Set()).act, false);
  });
});
