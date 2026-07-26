import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseBlockerKeys,
  decideUnblock,
  TERMINAL_STATUSES,
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
