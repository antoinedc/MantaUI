import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSessions,
  isMissingSessionError,
  newWindow,
  newSession,
  newWindowGetIndex,
  resolveCwdOrThrow,
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
    (c) => c.args.includes("set-window-option") && c.args.includes("@manta-session-id"),
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
  // 6 columns now: session, index, name, active, pane, @manta-session-id
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
// a shell, and (3) stamp @manta-session-id on the new window. Without the stamp
// the renderer sees opencodeSessionId === null and renders Terminal, not
// ChatPanel — the exact regression from commit 81f5779.

test("newWindow chatMode:true creates an opencode session AND stamps @manta-session-id", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc("ses_abc");
  // BET-307: resolveCwdOrThrow rejects a missing dir — use a real tmp dir
  // so the test is hermetic and runs in any cwd.
  const cwd = await mkdtemp(join(tmpdir(), "tmux-nw-chat-"));
  try {
    await newWindow({
      sessionName: "better-ui",
      windowName: "chat",
      cwd,
      chatMode: true,
      oc,
    });
  } finally {
    _setRun(null);
    await rm(cwd, { recursive: true, force: true });
  }
  // (1) opencode session created in the window's cwd.
  assert.equal(oc.created.length, 1, "one opencode session created");
  assert.equal(oc.created[0].directory, cwd);
  // (2) holder pane launched (sleep infinity) rather than the default shell.
  const newWin = cmds.find((c) => c.args.includes("new-window"));
  assert.ok(newWin, "new-window issued");
  assert.ok(newWin.args.includes(CHAT_HOLDER_CMD), "holder cmd passed to new-window");
  // (3) @manta-session-id stamped with the created session id.
  const stamp = findSetSid(cmds);
  assert.ok(stamp, "set-window-option @manta-session-id issued");
  assert.ok(stamp.args.includes("ses_abc"), "stamp carries the opencode session id");
});

test("newWindow chatMode:false stays a plain window — no session, no stamp, no holder", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc();
  const cwd = await mkdtemp(join(tmpdir(), "tmux-nw-plain-"));
  try {
    await newWindow({
      sessionName: "better-ui",
      windowName: "term",
      cwd,
      chatMode: false,
      oc,
    });
  } finally {
    _setRun(null);
    await rm(cwd, { recursive: true, force: true });
  }
  assert.equal(oc.created.length, 0, "no opencode session created for a plain window");
  assert.equal(findSetSid(cmds), undefined, "no @manta-session-id stamp for a plain window");
  const newWin = cmds.find((c) => c.args.includes("new-window"));
  assert.ok(newWin, "new-window issued");
  assert.ok(!newWin.args.includes(CHAT_HOLDER_CMD), "no holder cmd for a plain window");
});

test("newSession chatMode:true creates an opencode session AND stamps @manta-session-id", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc("ses_sess1");
  const cwd = await mkdtemp(join(tmpdir(), "tmux-ns-chat-"));
  try {
    await newSession({
      name: "newproj",
      cwd,
      windowName: "chat",
      chatMode: true,
      oc,
    });
  } finally {
    _setRun(null);
    await rm(cwd, { recursive: true, force: true });
  }
  assert.equal(oc.created.length, 1, "one opencode session created");
  assert.equal(oc.created[0].directory, cwd);
  const newSess = cmds.find((c) => c.args.includes("new-session"));
  assert.ok(newSess, "new-session issued");
  assert.ok(newSess.args.includes(CHAT_HOLDER_CMD), "holder cmd passed to new-session");
  const stamp = findSetSid(cmds);
  assert.ok(stamp, "set-window-option @manta-session-id issued");
  assert.ok(stamp.args.includes("ses_sess1"), "stamp carries the opencode session id");
});

test("newSession chatMode:false stays a plain session — no session create, no stamp", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc();
  const cwd = await mkdtemp(join(tmpdir(), "tmux-ns-plain-"));
  try {
    await newSession({
      name: "newproj",
      cwd,
      windowName: "main",
      chatMode: false,
      oc,
    });
  } finally {
    _setRun(null);
    await rm(cwd, { recursive: true, force: true });
  }
  assert.equal(oc.created.length, 0, "no opencode session for a plain session");
  assert.equal(findSetSid(cmds), undefined, "no @manta-session-id stamp for a plain session");
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

// ---- BET-307: resolveCwdOrThrow — the tmux-side chokepoint ---------------
//
// tmux's `-c` does NOT expand `~` and silently falls back to $HOME for a
// missing directory (exit code 0), which is how every project created with
// the UI's default `~` cwd ended up in the home directory. resolveCwdOrThrow
// is the single boundary that turns a caller-supplied cwd into a real
// directory handed to tmux or opencode.

test("resolveCwdOrThrow: '~' resolves to os.homedir()", () => {
  const out = resolveCwdOrThrow("~");
  assert.ok(out.length > 0, "expanded to a non-empty path");
  // Resolve ~ via node so we can compare on platforms where homedir() differs
  // from what we typed (e.g. macOS = /Users/dev, Linux = /home/dev).
  assert.ok(out === process.env.HOME || out === join(process.env.HOME ?? "", ""),
    "expands to process env HOME");
});

test("resolveCwdOrThrow: '~/<existing dir>' resolves under os.homedir()", async () => {
  // Create a real subdir under whatever HOME is so the `~/sub` form expands
  // to a path that actually exists. os.homedir() === process.env.HOME on every
  // supported platform — that's the contract the function relies on.
  const home = process.env.HOME;
  assert.ok(home, "HOME is set in the test env");
  const root = await mkdtemp(join(home, ".tmux-rcot-"));
  try {
    const out = resolveCwdOrThrow(join("~", root.slice(home.length + 1)));
    assert.equal(out, root, "expanded `~/...` to the existing dir");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveCwdOrThrow: undefined resolves to '.' (current working dir)", () => {
  const out = resolveCwdOrThrow(undefined);
  assert.equal(out, ".", "returns the literal '.' which existsSync accepts as the current dir");
});

test("resolveCwdOrThrow: a non-existent directory throws with the EXPANDED path", () => {
  assert.throws(
    () => resolveCwdOrThrow("/home/dev/does-not-exist-and-never-was"),
    (err) => {
      assert.ok(err instanceof Error, "throws an Error");
      assert.match(err.message, /working directory does not exist/);
      // The error message must carry the *expanded* path (here it was
      // already absolute so no tilde — but the assertion is the same).
      assert.match(err.message, /\/home\/dev\/does-not-exist-and-never-was/);
      return true;
    },
  );
});

test("resolveCwdOrThrow: a non-existent tilde-form path throws with the EXPANDED path", () => {
  assert.throws(
    () => resolveCwdOrThrow("~/does-not-exist-here"),
    (err) => {
      // Crucial: the message must NOT contain the literal `~/...` (the
      // user-friendly form) — it must carry the real absolute path so
      // the caller can see exactly what was missing.
      assert.match(err.message, /working directory does not exist/);
      assert.doesNotMatch(err.message, /^~|\s~/, "expanded away the tilde");
      return true;
    },
  );
});

test("resolveCwdOrThrow: an absolute existing path passes through unchanged", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "tmux-rcot-abs-"));
  try {
    const out = resolveCwdOrThrow(tmp);
    assert.equal(out, tmp, "absolute existing dir returned as-is");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// BET-307: collapse confirmed — the exported newWindowGetIndex now also
// accepts chatMode (default false). The 3-arg fork-session call from
// src/server/rpc.mjs:363 still receives `chatMode = false`, byte-identical
// to the previous (separate) implementation. The fake here tracks arity so
// a future change that drops the 3-arg call would surface in the test.

test("newWindowGetIndex (4-arg, chatMode:true) issues the holder pane", async () => {
  const cmds = installFakeTmux();
  try {
    const idx = await newWindowGetIndex("s", "chat", "/tmp", true);
    assert.equal(idx, 0, "fake new-window returns 0");
    const newWin = cmds.find((c) => c.args.includes("new-window"));
    assert.ok(newWin, "new-window issued");
    assert.ok(newWin.args.includes(CHAT_HOLDER_CMD), "holder cmd passed when chatMode:true");
    assert.ok(newWin.args.includes("/tmp"), "-c /tmp passed");
  } finally {
    _setRun(null);
  }
});

test("newWindowGetIndex (3-arg, default chatMode) stays a plain window", async () => {
  const cmds = installFakeTmux();
  try {
    const idx = await newWindowGetIndex("s", "term", "/tmp");
    assert.equal(idx, 0);
    const newWin = cmds.find((c) => c.args.includes("new-window"));
    assert.ok(newWin, "new-window issued");
    assert.ok(!newWin.args.includes(CHAT_HOLDER_CMD), "no holder cmd for default chatMode");
    assert.ok(newWin.args.includes("/tmp"), "-c /tmp passed");
  } finally {
    _setRun(null);
  }
});
