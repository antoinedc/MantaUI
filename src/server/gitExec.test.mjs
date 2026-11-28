// The box's own git runner: no shell, its own timeout (not tmux's 10 s helper), and errors that name git.
import test from "node:test";
import assert from "node:assert/strict";
import { createGitRunner, DEFAULT_GIT_TIMEOUT_MS } from "./gitExec.mjs";

test("the default timeout is far above tmux's 10 s helper", () => {
  assert.ok(DEFAULT_GIT_TIMEOUT_MS >= 60_000);
});

test("runs git with the argv as given (no shell) and returns stdout", async () => {
  const calls = [];
  const git = createGitRunner({
    execFileImpl: (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); cb(null, "out", ""); return { kill() {} }; },
  });
  const r = await git(["-C", "/a b; rm -rf /", "status"]);
  assert.equal(r.stdout, "out");
  assert.equal(calls[0].cmd, "git");
  assert.deepEqual(calls[0].args, ["-C", "/a b; rm -rf /", "status"]);
  assert.equal(calls[0].opts.timeout, DEFAULT_GIT_TIMEOUT_MS);
  assert.ok(!calls[0].opts.shell);
});

test("a per-call timeout wins over the default", async () => {
  let seen;
  const git = createGitRunner({ execFileImpl: (c, a, opts, cb) => { seen = opts.timeout; cb(null, "", ""); return { kill() {} }; } });
  await git(["clone", "a", "b"], { timeoutMs: 300_000 });
  assert.equal(seen, 300_000);
});

test("a failing git names git and carries its stderr, never 'tmux'", async () => {
  const git = createGitRunner({
    execFileImpl: (c, a, o, cb) => { const e = new Error("Command failed"); e.code = 128; cb(e, "", "fatal: not a git repository\n"); return { kill() {} }; },
  });
  await assert.rejects(git(["status"]), (e) => /git exited 128: fatal: not a git repository/.test(e.message) && !/tmux/.test(e.message));
});

test("a timed-out git says which command timed out and after how long", async () => {
  const git = createGitRunner({
    execFileImpl: (c, a, o, cb) => { const e = new Error("killed"); e.killed = true; e.signal = "SIGTERM"; cb(e, "", ""); return { kill() {} }; },
  });
  await assert.rejects(git(["clone", "x", "y"], { timeoutMs: 300_000 }), (e) => /git clone timed out after 300s/.test(e.message) && !/tmux/.test(e.message));
});

test("really kills a git that outlives its timeout", async () => {
  const git = createGitRunner();
  const t0 = Date.now();
  // reads stdin forever (the pipe is never written to), so only the timeout can end it
  await assert.rejects(git(["hash-object", "--stdin"], { timeoutMs: 300 }), /git hash-object timed out after/);
  assert.ok(Date.now() - t0 < 5000);
});

test("real git works", async () => {
  const git = createGitRunner();
  assert.match((await git(["--version"])).stdout, /^git version/);
});
