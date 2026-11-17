// The production git runner is simple-git; this exercises it against real git when the package is
// installed (it is a dependency — skipped only in a checkout whose node_modules predates it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitRunner } from "./gitRunner.mjs";
import { createKnowledgeStore } from "./store.mjs";
import { tmpDir } from "./testHelpers.mjs";

async function available() {
  try {
    await import("simple-git");
    return true;
  } catch {
    return false;
  }
}

// The box user's own editor / ssh command are ambient; the runner must not pass them on explicitly.
function ambientGuardedEnv(t) {
  const before = { EDITOR: process.env.EDITOR, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND };
  process.env.EDITOR = "vim";
  process.env.GIT_SSH_COMMAND = "ssh -v";
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("a fake simple-git is driven with the baseDir, merged env and raw args", async (t) => {
  ambientGuardedEnv(t);
  const seen = [];
  const optsSeen = [];
  const factory = (opts) => (optsSeen.push(opts), {
    env(e) {
      seen.push(["env", e]);
      return this;
    },
    async raw(args) {
      seen.push(["raw", args, opts.baseDir]);
      if (args[0] === "boom") throw new Error("fatal: nope");
      return "out";
    },
  });
  const g = createGitRunner({ simpleGitFactory: factory, defaultCwd: "/x" });
  assert.equal(await g.run(["status"], { env: { GIT_AUTHOR_NAME: "A" } }), "out");
  assert.equal(seen[0][1].GIT_AUTHOR_NAME, "A");
  assert.equal(seen[0][1].GIT_TERMINAL_PROMPT, "0");
  assert.ok(!("EDITOR" in seen[0][1]) && !("GIT_SSH_COMMAND" in seen[0][1])); // the box user's editor/ssh command never reach git
  assert.deepEqual(seen[1], ["raw", ["status"], "/x"]);
  assert.deepEqual(optsSeen[0].allowEnvironment, ["GIT_TERMINAL_PROMPT", "GIT_AUTHOR_NAME"]);
  await assert.rejects(g.run(["boom"], { cwd: "/y" }), (e) => /nope/.test(e.stderr));
});

test("the store works end to end over the real simple-git runner", async (t) => {
  ambientGuardedEnv(t);
  if (!(await available())) return t.skip("simple-git is not installed in this checkout");
  const dir = await tmpDir("knowledge-sg-");
  const store = createKnowledgeStore({ dir, git: createGitRunner({ defaultCwd: dir }) });
  await store.init();
  const a = await store.commit({ path: "user/preferences.md", content: "- a\n", message: "add a", trailers: { "Manta-Decision": "d_1" } });
  assert.equal(a.changed, true);
  assert.equal((await store.log({ limit: 1 }))[0].trailers["Manta-Decision"], "d_1");
  assert.equal((await store.commit({ path: "user/preferences.md", content: "- a\n", message: "again" })).changed, false);
  const b = await store.commit({ path: "user/preferences.md", content: "- a\n- b\n", message: "add b" });
  const rev = await store.revert(b.sha);
  assert.equal(rev.ok, true);
  assert.equal(await store.read("user/preferences.md"), "- a\n");
  assert.deepEqual(await store.dirty(), []);
  assert.equal((await store.revert("0000000")).reason, "unknown-commit");
});
