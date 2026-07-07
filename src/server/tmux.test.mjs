import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSessions,
  isMissingSessionError,
  newWindow,
  newSession,
  _setRun,
  CHAT_HOLDER_CMD,
} from "./tmux.mjs";

// Install a fake tmux transport that records every command and returns a
// window index of 0 for creation commands (matching `-P -F '#{window_index}'`).
// Returns the recorder so a test can assert on the commands issued.
function installFakeTmux() {
  const cmds = [];
  _setRun(async (cmd, args) => {
    cmds.push({ cmd, args });
    // new-session / new-window with -P -F print the window index on stdout.
    if (args.includes("new-window") || args.includes("new-session")) {
      return { stdout: "0\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return cmds;
}

// A fake opencode client that records createSession calls.
function fakeOc(sessionId = "ses_chat123") {
  const created = [];
  return {
    created,
    createSession: async (i) => { created.push(i); return { id: sessionId }; },
  };
}

function findSetSid(cmds) {
  return cmds.find(
    (c) => c.args.includes("set-window-option") && c.args.includes("@bui-session-id"),
  );
}

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

// `newWindow` auto-heals when the project's tmux session has been destroyed
// between calls (server restart, manual kill, destroy-unattached racing the
// next click). This classifier gates that branch — false negatives leak
// `tmux exited 1: can't find session: X` to the mobile client.

test("isMissingSessionError matches tmux's 'can't find session' stderr", () => {
  assert.equal(
    isMissingSessionError(new Error("tmux exited 1: can't find session: asdfg"), "asdfg"),
    true,
  );
});

test("isMissingSessionError matches case-insensitively", () => {
  assert.equal(
    isMissingSessionError(new Error("Can't Find Session: foo"), "foo"),
    true,
  );
});

test("isMissingSessionError matches the 'session not found' phrasing", () => {
  assert.equal(
    isMissingSessionError(new Error("tmux exited 1: session not found: nw"), "nw"),
    true,
  );
});

test("isMissingSessionError returns false for unrelated tmux failures", () => {
  assert.equal(
    isMissingSessionError(new Error("tmux exited 1: duplicate session: x"), "x"),
    false,
  );
  assert.equal(
    isMissingSessionError(new Error("tmux exited 1: no server running"), "x"),
    false,
  );
});

test("isMissingSessionError returns false for non-Error inputs", () => {
  assert.equal(isMissingSessionError(null, "x"), false);
  assert.equal(isMissingSessionError(undefined, "x"), false);
  assert.equal(isMissingSessionError("can't find session: x", "x"), false);
});

// ---- chat-mode (BET-113 regression) --------------------------------------
//
// The "chat mode (opencode)" toggle in the new-session / new-window dialog
// must (1) create an opencode session, (2) launch the holder pane instead of
// a shell, and (3) stamp @bui-session-id on the new window. Without the stamp
// the renderer sees opencodeSessionId === null and renders Terminal, not
// ChatPanel — the exact regression from commit 81f5779.

test("newWindow chatMode:true creates an opencode session AND stamps @bui-session-id", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc("ses_abc");
  try {
    await newWindow({
      sessionName: "better-ui",
      windowName: "chat",
      cwd: "/home/dev/projects/better-ui",
      chatMode: true,
      oc,
    });
  } finally {
    _setRun(null);
  }
  // (1) opencode session created in the window's cwd.
  assert.equal(oc.created.length, 1, "one opencode session created");
  assert.equal(oc.created[0].directory, "/home/dev/projects/better-ui");
  // (2) holder pane launched (sleep infinity) rather than the default shell.
  const newWin = cmds.find((c) => c.args.includes("new-window"));
  assert.ok(newWin, "new-window issued");
  assert.ok(newWin.args.includes(CHAT_HOLDER_CMD), "holder cmd passed to new-window");
  // (3) @bui-session-id stamped with the created session id.
  const stamp = findSetSid(cmds);
  assert.ok(stamp, "set-window-option @bui-session-id issued");
  assert.ok(stamp.args.includes("ses_abc"), "stamp carries the opencode session id");
});

test("newWindow chatMode:false stays a plain window — no session, no stamp, no holder", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc();
  try {
    await newWindow({
      sessionName: "better-ui",
      windowName: "term",
      cwd: "/home/dev/projects/better-ui",
      chatMode: false,
      oc,
    });
  } finally {
    _setRun(null);
  }
  assert.equal(oc.created.length, 0, "no opencode session created for a plain window");
  assert.equal(findSetSid(cmds), undefined, "no @bui-session-id stamp for a plain window");
  const newWin = cmds.find((c) => c.args.includes("new-window"));
  assert.ok(newWin, "new-window issued");
  assert.ok(!newWin.args.includes(CHAT_HOLDER_CMD), "no holder cmd for a plain window");
});

test("newSession chatMode:true creates an opencode session AND stamps @bui-session-id", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc("ses_sess1");
  try {
    await newSession({
      name: "newproj",
      cwd: "/home/dev/projects/newproj",
      windowName: "chat",
      chatMode: true,
      oc,
    });
  } finally {
    _setRun(null);
  }
  assert.equal(oc.created.length, 1, "one opencode session created");
  assert.equal(oc.created[0].directory, "/home/dev/projects/newproj");
  const newSess = cmds.find((c) => c.args.includes("new-session"));
  assert.ok(newSess, "new-session issued");
  assert.ok(newSess.args.includes(CHAT_HOLDER_CMD), "holder cmd passed to new-session");
  const stamp = findSetSid(cmds);
  assert.ok(stamp, "set-window-option @bui-session-id issued");
  assert.ok(stamp.args.includes("ses_sess1"), "stamp carries the opencode session id");
});

test("newSession chatMode:false stays a plain session — no session create, no stamp", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc();
  try {
    await newSession({
      name: "newproj",
      cwd: "/home/dev/projects/newproj",
      windowName: "main",
      chatMode: false,
      oc,
    });
  } finally {
    _setRun(null);
  }
  assert.equal(oc.created.length, 0, "no opencode session for a plain session");
  assert.equal(findSetSid(cmds), undefined, "no @bui-session-id stamp for a plain session");
});

test("newWindow chatMode:true throws when no opencode client is injected", async () => {
  installFakeTmux();
  try {
    await assert.rejects(
      () => newWindow({ sessionName: "s", windowName: "chat", cwd: "/tmp", chatMode: true }),
      /chat mode requires an opencode client/,
    );
  } finally {
    _setRun(null);
  }
});
