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

test("parseSessions extracts opencodeSessionId from the 6th column (chat windows)", () => {
  const sess = "Capo\t1";
  // 6 columns now: session, index, name, active, pane, @bui-session-id
  const wins =
    "Capo\t1\tmain\t0\t/home/dev/projects/capo\t\n" +              // plain window: empty sid -> null
    "Capo\t2\tchat\t1\t/home/dev/projects/capo\tses_1c9c9e6a2ffe"; // chat window: sid present
  const out = parseSessions(sess, wins);
  const cap = out.find((p) => p.tmuxSession === "Capo");
  assert.ok(cap, "Capo session present");
  const w1 = cap.windows.find((w) => w.index === 1);
  const w2 = cap.windows.find((w) => w.index === 2);
  assert.equal(w1.opencodeSessionId, null, "plain window -> null (not undefined, not empty string)");
  assert.equal(w2.opencodeSessionId, "ses_1c9c9e6a2ffe", "chat window -> the session id");
});
