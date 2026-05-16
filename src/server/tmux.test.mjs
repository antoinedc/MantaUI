import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessions } from "./tmux.mjs";

test("parseSessions builds project list from tmux -F output", () => {
  const sess = "alpha\t1\nbeta\t0";
  const wins = "alpha\t1\tmain\t1\t/home/u/alpha\nbeta\t1\tmain\t1\t/home/u/beta";
  const out = parseSessions(sess, wins);
  assert.equal(out.length, 2);
  assert.equal(out[0].tmuxSession, "alpha");
  assert.equal(out[0].attached, true);
  assert.equal(out[0].windows[0].paneCurrentPath, "/home/u/alpha");
  assert.equal(out[1].attached, false);
});

test("parseSessions keeps a session that has no windows yet", () => {
  const sess = "alpha\t1\nbeta\t0";
  const wins = "alpha\t1\tmain\t1\t/home/u/alpha"; // beta has no windows
  const out = parseSessions(sess, wins);
  assert.equal(out.length, 2);
  const beta = out.find((p) => p.tmuxSession === "beta");
  assert.ok(beta, "beta session preserved despite no windows");
  assert.deepEqual(beta.windows, []);
  assert.equal(beta.defaultCwd, "~");
  assert.equal(out[0].tmuxSession, "alpha"); // list-sessions order preserved
});
