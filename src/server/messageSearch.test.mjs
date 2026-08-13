// Tests for messageSearch.mjs pure logic — no database, no live opencode,
// no node:sqlite. Run via `npm run test:server` (node:test).
//
// searchMessages itself touches node:sqlite + the filesystem and is NOT
// covered here (as the issue specifies: "pure only"). Everything testable
// is in likePattern + buildHits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { likePattern, buildHits } from "./messageSearch.mjs";

// ---------------------------------------------------------------------------
// likePattern
// ---------------------------------------------------------------------------

test("likePattern escapes \\, % and _ and wraps in %…%", () => {
  assert.equal(likePattern("foo"), "%foo%");
  assert.equal(likePattern("100%"), "%100\\%%");
  assert.equal(likePattern("a_b"), "%a\\_b%");
  assert.equal(likePattern("a\\b"), "%a\\\\b%");
  assert.equal(likePattern("x%y_z\\q"), "%x\\%y\\_z\\\\q%");
});

test("likePattern escapes all special chars and keeps matches literal", () => {
  // A query containing % must not act as a SQLite wildcard after escaping.
  const pattern = likePattern("50%");
  assert.ok(pattern.includes("\\%"));
  assert.ok(!pattern.slice(1, -1).replace(/\\[%_]/, "").includes("%"));
});

// ---------------------------------------------------------------------------
// buildHits — row shape
// ---------------------------------------------------------------------------

function part(d, override = {}) {
  return JSON.stringify({ type: "text", text: d, ...override });
}
function msg(role = "user") {
  return JSON.stringify({ role });
}
// row is what buildHits receives: session_id, message_id, part_data (JSON
// string), msg_data (JSON string), time_created.
function row(sid, mid, partData, msgData, timeCreated) {
  return {
    session_id: sid,
    message_id: mid,
    part_data: partData,
    msg_data: msgData,
    time_created: timeCreated,
  };
}

const OPS = { sessionIds: ["a", "b"] };

// ---------------------------------------------------------------------------
// text-part filtering
// ---------------------------------------------------------------------------

test("buildHits skips non-text parts", () => {
  const rows = [
    row("a", "m1", JSON.stringify({ type: "tool", text: "hello world" }), msg(), 1),
  ];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips synthetic parts", () => {
  const rows = [
    row("a", "m1", part("hello world", { synthetic: true }), msg(), 1),
  ];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips ignored parts", () => {
  const rows = [
    row("a", "m1", part("hello world", { ignored: true }), msg(), 1),
  ];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips parts with non-string text", () => {
  const rows = [
    row("a", "m1", JSON.stringify({ type: "text", text: 42 }), msg(), 1),
  ];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips rows whose part_data is unparseable JSON", () => {
  const rows = [row("a", "m1", "{not json", msg(), 1)];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips rows whose msg_data is unparseable JSON without throwing", () => {
  const rows = [row("a", "m1", part("hello world"), "{bad", 1)];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips rows with empty query", () => {
  assert.deepEqual(buildHits([row("a", "m1", part("hello"), msg(), 1)], "", OPS), []);
});

// ---------------------------------------------------------------------------
// one-hit-per-message + case-insensitive matching
// ---------------------------------------------------------------------------

test("buildHits produces one hit per message, first match wins", () => {
  const rows = [
    row("a", "m1", part("first hello one"), msg(), 3),
    row("a", "m1", part("helloooo second"), msg(), 2),
    row("a", "m2", part("single hello"), msg(), 1),
  ];
  const hits = buildHits(rows, "hello", OPS);
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((h) => h.messageId),
    ["m1", "m2"],
  );
});

test("buildHits matches case-insensitively but reports original casing", () => {
  const rows = [row("a", "m1", part("Say HELLO there"), msg(), 1)];
  const hits = buildHits(rows, "hello", OPS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, "HELLO");
});

test("buildHits skips rows without a case-insensitive match", () => {
  const rows = [row("a", "m1", part("nothing here"), msg(), 1)];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

// ---------------------------------------------------------------------------
// role normalization
// ---------------------------------------------------------------------------

test("buildHits normalizes role: user stays user, everything else is assistant", () => {
  const rows = [
    row("a", "m1", part("hello user"), msg("user"), 2),
    row("a", "m2", part("hello asst"), msg("assistant"), 1),
  ];
  const hits = buildHits(rows, "hello", OPS);
  assert.equal(hits.find((h) => h.messageId === "m1").role, "user");
  assert.equal(hits.find((h) => h.messageId === "m2").role, "assistant");
});

// ---------------------------------------------------------------------------
// snippets
// ---------------------------------------------------------------------------

test("snippet pre is prefixed with … and truncated to 60 chars when the match sits deep", () => {
  const before = "x".repeat(120);
  const rows = [row("a", "m1", part(before + "hello"), msg(), 1)];
  const [h] = buildHits(rows, "hello", OPS);
  assert.ok(h.pre.startsWith("…"));
  assert.equal(h.pre.length, 1 + 60); // … + 60 chars before the match
  assert.equal(h.match, "hello");
  assert.equal(h.post, "");
});

test("snippet pre has no … when the match is within the first 60 chars", () => {
  const before = "y".repeat(20);
  const rows = [row("a", "m1", part(before + "hello"), msg(), 1)];
  const [h] = buildHits(rows, "hello", OPS);
  assert.ok(!h.pre.startsWith("…"));
  assert.equal(h.pre, before);
});

test("snippet post is truncated to 200 chars", () => {
  const after = "z".repeat(300);
  const rows = [row("a", "m1", part("hello" + after), msg(), 1)];
  const [h] = buildHits(rows, "hello", OPS);
  assert.equal(h.post.length, 200);
});

test("snippet pre/match/post collapse whitespace runs to a single space", () => {
  const rows = [row("a", "m1", part("a   b\n\n xhello\t world"), msg(), 1)];
  const [h] = buildHits(rows, "hello", OPS);
  assert.equal(h.pre, "a b x");
  assert.equal(h.match, "hello");
  assert.equal(h.post, " world");
});

// ---------------------------------------------------------------------------
// caps
// ---------------------------------------------------------------------------

test("maxPrimary caps the primary session independently of maxPerSession", () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push(row("a", `u${i}`, part(`hello slot${i}`), msg(), i));
  }
  const hits = buildHits(rows, "hello", {
    sessionIds: ["a", "b"],
    primarySessionId: "a",
    maxPrimary: 2,
    maxPerSession: 3,
  });
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.sessionId === "a"));
});

test("maxPerSession caps every non-primary session", () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push(row("b", `v${i}`, part(`hello slot${i}`), msg(), i));
  }
  const hits = buildHits(rows, "hello", {
    sessionIds: ["a", "b"],
    primarySessionId: "a",
    maxPerSession: 3,
  });
  assert.equal(hits.length, 3);
  assert.ok(hits.every((h) => h.sessionId === "b"));
});

test("maxTotal caps hits overall", () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push(row("a", `u${i}`, part(`hello slot${i}`), msg(), i));
  }
  const hits = buildHits(rows, "hello", {
    sessionIds: ["a"],
    primarySessionId: "a",
    maxPrimary: 100,
    maxTotal: 4,
  });
  assert.equal(hits.length, 4);
});

// ---------------------------------------------------------------------------
// session ordering + time-descending within a session
// ---------------------------------------------------------------------------

test("buildHits orders by session index, then time_created descending within a session", () => {
  // Input order is time-descending globally, interleaved across sessions:
  // row a(5), row b(50), row b(40), row a(4), row b(30)
  const rows = [
    row("a", "a5", part("hello five"), msg(), 5),
    row("b", "b5", part("hello fifty"), msg(), 50),
    row("b", "b4", part("hello fourty"), msg(), 40),
    row("a", "a4", part("hello four"), msg(), 4),
    row("b", "b3", part("hello thirty"), msg(), 30),
  ];
  const hits = buildHits(rows, "hello", { sessionIds: ["b", "a"], primarySessionId: "b" });
  // sessionIds = ["b","a"] → all b hits first, then a; within each, newest first.
  assert.deepEqual(
    hits.map((h) => h.messageId),
    ["b5", "b4", "b3", "a5", "a4"],
  );
});

test("buildHits primary (sessionIds[0]) sorts first", () => {
  const rows = [
    row("b", "b1", part("hello bee"), msg(), 2),
    row("a", "a1", part("hello ay"), msg(), 2),
    row("a", "a2", part("hello ay2"), msg(), 1),
  ];
  const hits = buildHits(rows, "hello", { sessionIds: ["a", "b"], primarySessionId: "a" });
  assert.deepEqual(
    hits.map((h) => h.sessionId),
    ["a", "a", "b"],
  );
});

test("timeCreated is carried through (null-safe)", () => {
  const rows = [
    row("a", "m1", part("hello world"), msg(), 1234),
    row("a", "m2", part("hello again"), msg(), null),
  ];
  const hits = buildHits(rows, "hello", OPS);
  assert.equal(hits.find((h) => h.messageId === "m1").timeCreated, 1234);
  assert.equal(hits.find((h) => h.messageId === "m2").timeCreated, null);
});
