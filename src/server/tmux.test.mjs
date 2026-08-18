import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSessions,
  run,
  tmuxSpawnEnv,
  isMissingSessionError,
  isNoTmuxServerError,
  newWindow,
  newSession,
  newWindowGetIndex,
  resolveCwdOrThrow,
  _setRun,
  CHAT_HOLDER_CMD,
  loadOwnedSessions,
  loadOwnedSessionsSync,
  addOwnedSession,
  removeOwnedSession,
  listProjects,
  setWindowOption,
  getWindowOption,
  findWindowForCwd,
  killSession,
  renameSession,
  _resetOwnedSessionsCache,
  _setOwnedSessionsPath,
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
  // (0) Empty title so opencode auto-titles from the first user message —
  // a seeded "workspace / window" title is what the auto-rename first-name
  // path would read back and stamp as "manta / im" (BET-1100).
  assert.equal(oc.created[0].title, "", "chat session created with an empty title (no workspace-prefixed compound)");
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
  assert.equal(oc.created[0].title, "", "chat session created with an empty title so opencode auto-titles (BET-1100)");
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

// ---- optimistic draft flow: reuse an existing opencode session id ----------
// When the draft's submit creates the opencode session first (so the chat view
// appears immediately) and then asks for a tmux window, the window must reuse
// that session id rather than create a second one.

test("newWindow with existingSessionId reuses the id and creates no new session", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc();
  const cwd = await mkdtemp(join(tmpdir(), "tmux-nw-exist-"));
  try {
    const out = await newWindow({
      sessionName: "better-ui",
      windowName: "chat",
      cwd,
      chatMode: true,
      existingSessionId: "ses_preexisting",
      oc,
    });
    assert.equal(oc.created.length, 0, "no new opencode session created");
    assert.equal(out.sessionId, "ses_preexisting");
    const stamp = findSetSid(cmds);
    assert.ok(stamp, "@manta-session-id stamped");
    assert.ok(stamp.args.includes("ses_preexisting"), "stamp carries the existing id");
  } finally {
    _setRun(null);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("newSession with existingSessionId reuses the id and creates no new session", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc();
  const cwd = await mkdtemp(join(tmpdir(), "tmux-ns-exist-"));
  try {
    const out = await newSession({
      name: "newproj",
      cwd,
      windowName: "default",
      chatMode: true,
      existingSessionId: "ses_preexisting",
      oc,
    });
    assert.equal(oc.created.length, 0, "no new opencode session created");
    assert.equal(out.sessionId, "ses_preexisting");
    const stamp = findSetSid(cmds);
    assert.ok(stamp && stamp.args.includes("ses_preexisting"), "stamp carries the existing id");
  } finally {
    _setRun(null);
    await rm(cwd, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// listProjects must not report a tmux FAULT as "this box has zero sessions".
//
// Both tmux queries used to end in `.catch(() => ({ stdout: "" }))`, so any
// failure — a restarting server, a missing PATH, a mangled locale — came back
// as a successful, EMPTY listing. A client cannot tell that apart from a box
// that genuinely has no sessions, so the phone showed the inviting "No
// sessions yet. Tap + to create one." for a box full of work, and the
// ownership sidecar was reconciled to nothing against the phantom empty list.
// ---------------------------------------------------------------------------

test("isNoTmuxServerError separates 'no tmux server' from a real fault", () => {
  assert.equal(
    isNoTmuxServerError(new Error("tmux exited 1: no server running on /tmp/tmux-1000/default")),
    true,
  );
  // BET-675: "error connecting … (No such file or directory)" / "Connection
  // refused" indicate a restarted server / socket race, NOT a genuinely empty
  // box — so they are no longer treated as "no tmux server".
  assert.equal(
    isNoTmuxServerError(new Error("tmux exited 1: error connecting to /tmp/tmux-1000/default (No such file or directory)")),
    false,
  );
  assert.equal(isNoTmuxServerError(new Error("tmux exited 1: no sessions")), true);
  assert.equal(isNoTmuxServerError(new Error("spawn tmux ENOENT")), false);
  assert.equal(isNoTmuxServerError(new Error("tmux exited 1: lost server")), false);
  assert.equal(isNoTmuxServerError(undefined), false);
  assert.equal(isNoTmuxServerError({}), false);
});

test("listProjects returns [] when tmux genuinely has no server", async () => {
  _resetOwnedSessionsCache();
  _setRun(async () => {
    throw new Error("tmux exited 1: no server running on /tmp/tmux-1000/default");
  });
  try {
    assert.deepEqual(await listProjects(), []);
  } finally {
    _setRun(null);
    _resetOwnedSessionsCache();
  }
});

test("listProjects THROWS on a tmux fault rather than reporting zero sessions", async () => {
  _resetOwnedSessionsCache();
  _setRun(async () => {
    throw new Error("spawn tmux ENOENT");
  });
  try {
    await assert.rejects(() => listProjects(), /ENOENT/);
  } finally {
    _setRun(null);
    _resetOwnedSessionsCache();
  }
});

// BET-675: a socket race ("error connecting … (No such file or directory)")
// is a FAULT, not an empty box — it must throw out of listProjects, never
// quietly return an empty list.
test("listProjects THROWS on a tmux socket-race fault, not empty", async () => {
  _resetOwnedSessionsCache();
  _setRun(async () => {
    throw new Error("tmux exited 1: error connecting to /tmp/tmux-1000/default (No such file or directory)");
  });
  try {
    await assert.rejects(() => listProjects(), /No such file or directory/);
  } finally {
    _setRun(null);
    _resetOwnedSessionsCache();
  }
});

test("listProjects THROWS when only the window query faults", async () => {
  _resetOwnedSessionsCache();
  _setRun(async (cmd, args) => {
    if (args.includes("list-sessions")) return { stdout: "alpha\t1\n", stderr: "" };
    throw new Error("tmux exited 1: lost server");
  });
  try {
    await assert.rejects(() => listProjects(), /lost server/);
  } finally {
    _setRun(null);
    _resetOwnedSessionsCache();
  }
});

// A fault must also leave the ownership sidecar alone — reconciling against an
// empty live-session list is what would silently drop every owned session.
test("a tmux fault does not prune the owned-session sidecar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-fault-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    _resetOwnedSessionsCache();
    await addOwnedSession("alpha", { path });
    _setRun(async () => {
      throw new Error("spawn tmux ENOENT");
    });
    try {
      await assert.rejects(() => listProjects());
    } finally {
      _setRun(null);
    }
    assert.deepEqual(await loadOwnedSessions(path), ["alpha"]);
  } finally {
    _resetOwnedSessionsCache();
    await rm(dir, { recursive: true, force: true });
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

// tmux sanitises unprintable bytes in `-F` output under a non-UTF-8 locale,
// turning the TAB field separator into `_` — which corrupted every session
// name and dropped every window. Services inherit no locale from launchd (and
// only what the unit declares from systemd), so tmux must be given one.
test("tmuxSpawnEnv supplies a UTF-8 locale when the supervisor gave none", () => {
  assert.equal(tmuxSpawnEnv({ PATH: "/usr/bin" }, "linux").LC_ALL, "C.UTF-8");
  // macOS has no C.UTF-8; en_US.UTF-8 always exists there.
  assert.equal(tmuxSpawnEnv({ PATH: "/usr/bin" }, "darwin").LC_ALL, "en_US.UTF-8");
});

test("tmuxSpawnEnv never overrides an explicit locale", () => {
  assert.equal(tmuxSpawnEnv({ LC_ALL: "fr_FR.UTF-8" }, "darwin").LC_ALL, "fr_FR.UTF-8");
  // LANG alone is enough for tmux — don't add LC_ALL on top of it.
  const withLang = tmuxSpawnEnv({ LANG: "de_DE.UTF-8" }, "linux");
  assert.equal(withLang.LANG, "de_DE.UTF-8");
  assert.equal(withLang.LC_ALL, undefined);
});

test("tmuxSpawnEnv preserves the rest of the environment", () => {
  const out = tmuxSpawnEnv({ PATH: "/usr/local/sbin", FOO: "bar" }, "darwin");
  assert.equal(out.PATH, "/usr/local/sbin");
  assert.equal(out.FOO, "bar");
});

// ---- BET-348: Manta-owned-session sidecar ---------------------------------
//
// Sidecar rules (see src/server/tmux.mjs OWNED_SESSIONS_PATH doc):
//  - `addOwnedSession` / `removeOwnedSession` are idempotent and persist
//    to disk via `atomicWrite` so a crash mid-write never corrupts the file.
//  - The cache hydrates lazily; once warm, writes skip the read and only
//    persist the delta.
//  - `loadOwnedSessions` returns [] for a missing or corrupt file — it
//    must NEVER crash the server (regression target).
//  - Reconciliation drops sidecar entries for sessions that no longer
//    exist in `tmux list-sessions`, so a session that's been killed by
//    anyone (Manta, the user, the OS) doesn't linger with phantom
//    ownership.
//
// Tests use `_resetOwnedSessionsCache()` to keep cases hermetic — they
// MUST NOT touch the production default path (`~/.manta/tmux-sessions.json`),
// and the cache must be reset between cases so each one re-hydrates from
// its own tmp file.

test("loadOwnedSessions returns [] for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    assert.deepEqual(await loadOwnedSessions(path), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOwnedSessionsSync returns [] for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-sync-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    assert.deepEqual(loadOwnedSessionsSync(path), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOwnedSessions reads {sessions:[...]} and tolerates a bare array", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-"));
  try {
    const objPath = join(dir, "tmux-sessions.json");
    await writeFile(objPath, JSON.stringify({ sessions: ["alpha", "beta"] }), "utf-8");
    assert.deepEqual(await loadOwnedSessions(objPath), ["alpha", "beta"]);
    const arrPath = join(dir, "tmux-sessions-arr.json");
    await writeFile(arrPath, JSON.stringify(["alpha", "beta"]), "utf-8");
    assert.deepEqual(await loadOwnedSessions(arrPath), ["alpha", "beta"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOwnedSessions returns [] for a corrupt JSON file (no crash)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    await writeFile(path, "not json {", "utf-8");
    assert.deepEqual(await loadOwnedSessions(path), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOwnedSessions filters non-string entries from the array", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    await writeFile(path, JSON.stringify({ sessions: ["alpha", 42, null, "beta"] }), "utf-8");
    assert.deepEqual(await loadOwnedSessions(path), ["alpha", "beta"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addOwnedSession persists, idempotent across calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    _resetOwnedSessionsCache();
    await addOwnedSession("alpha", { path });
    await addOwnedSession("alpha", { path }); // idempotent
    await addOwnedSession("beta", { path });
    assert.deepEqual((await loadOwnedSessions(path)).sort(), ["alpha", "beta"]);
    const raw = JSON.parse(await readFile(path, "utf-8"));
    assert.deepEqual(raw.sessions.sort(), ["alpha", "beta"]);
  } finally {
    _resetOwnedSessionsCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeOwnedSession drops the entry and leaves the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    _resetOwnedSessionsCache();
    await addOwnedSession("alpha", { path });
    await addOwnedSession("beta", { path });
    await removeOwnedSession("alpha", { path });
    assert.deepEqual(await loadOwnedSessions(path), ["beta"]);
  } finally {
    _resetOwnedSessionsCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeOwnedSession is a no-op for an unknown entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    _resetOwnedSessionsCache();
    await addOwnedSession("alpha", { path });
    await removeOwnedSession("never-existed", { path });
    assert.deepEqual(await loadOwnedSessions(path), ["alpha"]);
  } finally {
    _resetOwnedSessionsCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test("addOwnedSession / removeOwnedSession reject empty / non-string names", async () => {
  // No throw, no write — purely defensive against a corrupt caller.
  await addOwnedSession("");
  await addOwnedSession(undefined);
  await addOwnedSession(null);
  await removeOwnedSession("");
  await removeOwnedSession(undefined);
});

test("parseSessions stamps mantaOwned from the provided owned set", () => {
  const sess = "alpha\t1\nbeta\t0\ngamma\t1";
  const wins = "alpha\t1\tmain\t1\t/home/u/a\nbeta\t1\tmain\t1\t/home/u/b\ngamma\t1\tmain\t1\t/home/u/g";
  const out = parseSessions(sess, wins, new Set(["alpha", "gamma"]));
  const byName = Object.fromEntries(out.map((p) => [p.tmuxSession, p.mantaOwned]));
  assert.equal(byName.alpha, true, "alpha is owned");
  assert.equal(byName.beta, false, "beta is not owned");
  assert.equal(byName.gamma, true, "gamma is owned");
});

test("parseSessions defaults mantaOwned to false when no owned set is passed", () => {
  // Existing callers + tests that pass 2 args must keep working — and
  // the new field must default to false so the renderer treats unknown
  // sessions as non-Manta (the safe default; see BET-348 acceptance
  // criteria).
  const sess = "alpha\t1";
  const wins = "alpha\t1\tmain\t1\t/home/u/a";
  const out = parseSessions(sess, wins);
  assert.equal(out[0].mantaOwned, false);
});

test("listProjects stamps mantaOwned + reconciles orphan sidecar entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    _resetOwnedSessionsCache();
    // Seed: alpha + ghost (a session that no longer exists in tmux).
    await addOwnedSession("alpha", { path });
    await addOwnedSession("ghost", { path });
    // installFakeTmux returns "" for `tmux list-sessions` — too thin
    // for a reconciliation test. Replace it with a fake that reports
    // "alpha" as live and nothing else.
    _setRun(async (cmd, args) => {
      if (args.includes("list-sessions")) {
        return { stdout: "alpha\t1\n", stderr: "" };
      }
      if (args.includes("list-windows")) {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    try {
      const projects = await listProjects();
      const alpha = projects.find((p) => p.tmuxSession === "alpha");
      assert.ok(alpha, "alpha is in the listing");
      assert.equal(alpha.mantaOwned, true, "live Manta session is stamped");
      assert.equal(
        projects.find((p) => p.tmuxSession === "ghost"),
        undefined,
        "ghost session is not in the listing (it was killed outside Manta)",
      );
      // Sidecar is now reconciled: ghost dropped, alpha retained.
      assert.deepEqual(
        (await loadOwnedSessions(path)).sort(),
        ["alpha"],
        "listProjects() prunes the orphan 'ghost' entry from the sidecar",
      );
    } finally {
      _setRun(null);
      _resetOwnedSessionsCache();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listProjects hides a session whose defaultCwd is the install home (BET-995)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-installhome-"));
  const installHome = join(dir, ".local", "share", "manta");
  const workDir = join(dir, "work");
  const ownedPath = join(dir, "tmux-sessions.json");
  try {
    _resetOwnedSessionsCache();
    _setOwnedSessionsPath(ownedPath);
    _setRun(async (cmd, args) => {
      if (args.includes("list-sessions")) {
        return { stdout: "install-home\t1\nwork\t1\n", stderr: "" };
      }
      if (args.includes("list-windows")) {
        return {
          stdout: `install-home\t1\tmain\t1\t${installHome}\nwork\t1\tmain\t1\t${workDir}\n`,
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    try {
      // The box's own session (cwd == install home) is dropped; a real
      // project dir still appears.
      const projects = await listProjects(installHome);
      const names = projects.map((p) => p.tmuxSession);
      assert.ok(names.includes("work"), "normal project dir still listed");
      assert.ok(!names.includes("install-home"), "install home session is hidden");
      // Without installHome the filter is not applied (back-compat).
      const unfiltered = await listProjects();
      assert.ok(unfiltered.some((p) => p.tmuxSession === "install-home"));
    } finally {
      _setRun(null);
      _setOwnedSessionsPath(null);
      _resetOwnedSessionsCache();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("killSession prunes the sidecar entry (eager, before listProjects)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    _resetOwnedSessionsCache();
    await addOwnedSession("alpha", { path });
    await addOwnedSession("beta", { path });
    // Fake reports "beta" as alive (alpha already gone — that's what
    // `killSession` just did). Without this, the post-kill
    // `listProjects()` reconciliation would empty the sidecar too,
    // hiding the eager-prune behavior under test.
    _setRun(async (cmd, args) => {
      if (args.includes("list-sessions")) {
        return { stdout: "beta\t1\n", stderr: "" };
      }
      if (args.includes("list-windows")) {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    try {
      await killSession("alpha");
    } finally {
      _setRun(null);
      _resetOwnedSessionsCache();
    }
    assert.deepEqual(
      await loadOwnedSessions(path),
      ["beta"],
      "alpha was pruned by killSession; beta untouched (and survives reconciliation)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renameSession keeps ownership under the new name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-owned-"));
  const path = join(dir, "tmux-sessions.json");
  try {
    _resetOwnedSessionsCache();
    // Redirect the default path the production helpers (renameSession,
    // killSession, newSession) read/write to the tmp path — without
    // this they'd hit `~/.manta/tmux-sessions.json` and pollute the
    // real state.
    _setOwnedSessionsPath(path);
    await addOwnedSession("alpha");
    // Fake reports the renamed session as alive so the post-rename
    // `listProjects()` reconciliation doesn't drop the entry.
    _setRun(async (cmd, args) => {
      if (args.includes("list-sessions")) {
        return { stdout: "alpha-renamed\t1\n", stderr: "" };
      }
      if (args.includes("list-windows")) {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    try {
      await renameSession({ oldName: "alpha", newName: "alpha-renamed" });
    } finally {
      _setRun(null);
    }
    assert.deepEqual(
      await loadOwnedSessions(path),
      ["alpha-renamed"],
      "old name removed, new name added",
    );
  } finally {
    _resetOwnedSessionsCache();
    await rm(dir, { recursive: true, force: true });
  }
});

// spawnRun must resolve on the child's "close" (all stdio drained), not its
// "exit" (process dead, pipe possibly still holding bytes). Resolving on
// "exit" hands the caller a truncated — often EMPTY — stdout at exit code 0,
// which is indistinguishable from "tmux legitimately has nothing to list".
// Under concurrent reads (the opencode event pump, the status/activity
// pollers and push's session-label lookup all query tmux at once) that made
// `listProjects` report an empty box roughly half the time, so a backgrounded
// subagent never got its sidebar row ("could not resolve the owning window")
// and push logged spurious "unresolvable-session" suppressions.
//
// The child here exits IMMEDIATELY while a background descendant still holds
// the inherited stdout and writes to it 200ms later — so "exit" observes ""
// deterministically and "close" observes the full output.
test("run waits for stdout to close, not just for the child to exit", async () => {
  const { stdout } = await run("/bin/sh", [
    "-c",
    "{ sleep 0.2; printf late-bytes; } & exit 0",
  ]);
  assert.equal(stdout, "late-bytes", "stdout must not be lost when the child exits early");
});

// ---- setWindowOption / getWindowOption (BET-871) ---------------------------
// The ONE write path for every manta window-option stamp and its paired read.
// A fake tmux holds options in a map so set-then-get round-trips.

test("setWindowOption issues the single set-window-option command", async () => {
  const cmds = installFakeTmux();
  try {
    await setWindowOption("proj", 2, "@manta-forge-issue", "github.com/acme/widget#412");
  } finally {
    _setRun(null);
  }
  const cmd = cmds.find((c) => c.args.includes("set-window-option"));
  assert.ok(cmd, "set-window-option issued");
  assert.deepEqual(cmd.args, [
    "set-window-option", "-t", "proj:2", "@manta-forge-issue", "github.com/acme/widget#412",
  ]);
});

test("getWindowOption returns the stored value via show-window-options -v", async () => {
  let queried = null;
  _setRun(async (_cmd, args) => {
    if (args.includes("show-window-options")) {
      queried = args;
      return { stdout: "github.com/acme/widget#412", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  try {
    const v = await getWindowOption("proj", 2, "@manta-forge-issue");
    assert.equal(v, "github.com/acme/widget#412", "value is the raw -v output, trimmed");
  } finally {
    _setRun(null);
  }
  assert.ok(queried, "show-window-options issued");
});

test("getWindowOption returns null when the option is unset (tmux errors)", async () => {
  _setRun(async () => { throw new Error("unknown option: @manta-forge-issue"); });
  try {
    assert.equal(await getWindowOption("proj", 2, "@manta-forge-issue"), null);
  } finally {
    _setRun(null);
  }
});

test("getWindowOption returns null for empty output", async () => {
  _setRun(async () => ({ stdout: "", stderr: "" }));
  try {
    assert.equal(await getWindowOption("proj", 2, "@manta-forge-issue"), null);
  } finally {
    _setRun(null);
  }
});

// ---- findWindowForCwd (BET-871) --------------------------------------------
test("findWindowForCwd resolves a window by its pane_current_path", async () => {
  _setRun(async (_cmd, args) => {
    if (args.includes("list-windows")) {
      return {
        stdout:
          "alpha\t1\t/home/u/other\n" +
          "beta\t3\t/home/u/worktree",
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
  try {
    assert.deepEqual(await findWindowForCwd("/home/u/worktree"), { sessionName: "beta", windowIndex: 3 });
    assert.deepEqual(await findWindowForCwd("/home/u/missing"), null);
    assert.deepEqual(await findWindowForCwd(""), null);
  } finally {
    _setRun(null);
  }
});

// ---- newSession + forgeIssueRef (BET-871) ----------------------------------
test("newSession stamps @manta-forge-issue after @manta-session-id when given a ref", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc("ses_sess1");
  const cwd = await mkdtemp(join(tmpdir(), "tmux-ns-forge-"));
  try {
    await newSession({
      name: "newproj",
      cwd,
      windowName: "default",
      chatMode: true,
      oc,
      forgeIssueRef: "github.com/acme/widget#412",
    });
  } finally {
    _setRun(null);
    await rm(cwd, { recursive: true, force: true });
  }
  const stamps = cmds.filter((c) => c.args.includes("set-window-option"));
  assert.equal(stamps.length, 2, "session-id + forge-issue stamps issued");
  const sid = stamps.find((c) => c.args.includes("@manta-session-id"));
  const forge = stamps.find((c) => c.args.includes("@manta-forge-issue"));
  assert.ok(sid, "@manta-session-id stamped");
  assert.ok(sid.args.includes("ses_sess1"), "session-id stamp carries the opencode id");
  assert.ok(forge, "@manta-forge-issue stamped");
  assert.ok(forge.args.includes("github.com/acme/widget#412"), "forge stamp carries the issue ref");
});

test("newSession without forgeIssueRef stamps only @manta-session-id", async () => {
  const cmds = installFakeTmux();
  const oc = fakeOc("ses_sess1");
  const cwd = await mkdtemp(join(tmpdir(), "tmux-ns-noforge-"));
  try {
    await newSession({
      name: "newproj",
      cwd,
      windowName: "default",
      chatMode: true,
      oc,
    });
  } finally {
    _setRun(null);
    await rm(cwd, { recursive: true, force: true });
  }
  const stamps = cmds.filter((c) => c.args.includes("set-window-option"));
  assert.equal(stamps.length, 1, "only the session-id stamp is issued");
  assert.ok(stamps[0].args.includes("@manta-session-id"));
  assert.ok(!stamps.some((c) => c.args.includes("@manta-forge-issue")), "no forge-issue stamp");
});
