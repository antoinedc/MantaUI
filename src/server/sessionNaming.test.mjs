import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tmuxSafeName, proposeProjectName, proposeScratchName, validateSessionName, proposedRoot, listChildDirNames,
  SCRATCH_EMPTY_HINT,
} from "./sessionNaming.mjs";

test("S1: tmux-safe FIRST, then unique (next.js → next_js → next_js-2)", () => {
  assert.equal(tmuxSafeName("next.js"), "next_js");
  assert.equal(tmuxSafeName("a:b.c"), "a_b_c");
  assert.equal(proposeProjectName({ hint: "/home/u/next.js" }, new Set()), "next_js");
  assert.equal(proposeProjectName({ hint: "/home/u/next.js" }, new Set(["next_js"])), "next_js-2");
  assert.equal(proposeProjectName({ hint: "/home/u/next.js" }, new Set(["next_js", "next_js-2"])), "next_js-3");
  assert.equal(proposeProjectName({ cwd: "~" }, new Set()), "project");
  assert.equal(proposeProjectName({ cwd: "/a/b/" }, new Set(["b"])), "b-2");
  // a hint wins over the folder
  assert.equal(proposeProjectName({ hint: "alpha", cwd: "/x/y" }, new Set()), "alpha");
});

test("S1: scratch hint — both texts, and the slug that will become the folder", () => {
  assert.deepEqual(proposeScratchName("  !!! ", new Set()), { name: "", hint: SCRATCH_EMPTY_HINT });
  assert.deepEqual(proposeScratchName("My App", new Set()), { name: "my-app", hint: null });
  assert.deepEqual(proposeScratchName("My App", new Set(["my-app"])), { name: "my-app-2", hint: "my-app already exists — will create my-app-2" });
  assert.deepEqual(proposeScratchName("日本語", new Set()), { name: "", hint: SCRATCH_EMPTY_HINT });
});

test("S2: rename validation, each branch, with sentences", () => {
  assert.deepEqual(validateSessionName("  ok  "), { ok: true, name: "ok" });
  assert.equal(validateSessionName("").error, "Session names can't be empty.");
  assert.equal(validateSessionName("   ").error, "Session names can't be empty.");
  assert.equal(validateSessionName(undefined).error, "Session names can't be empty.");
  assert.equal(validateSessionName("a".repeat(41)).error, "Session names can be at most 40 characters.");
  assert.equal(validateSessionName("a".repeat(40)).ok, true);
  assert.equal(validateSessionName("a:b").error, "Session names can't contain “:” or control characters.");
  assert.equal(validateSessionName("a\nb").ok, false);
});

test("S3: proposed root — common parent, boundary-aware, home fallback", () => {
  assert.equal(proposedRoot([], "/home/u"), "/home/u/projects");
  assert.equal(proposedRoot([], ""), "");
  assert.equal(proposedRoot(["/home/u/code/a", "/home/u/code/b"], "/home/u"), "/home/u/code");
  assert.equal(proposedRoot(["/home/u/code/a"], "/home/u"), "/home/u/code");
  // code vs codex: the parent is /home/u, NOT /home/u/code
  assert.equal(proposedRoot(["/home/u/code/a", "/home/u/codex/b"], "/home/u"), "/home/u");
  assert.equal(proposedRoot(["/a/x", "/b/y"], "/home/u"), "/home/u/projects");
  assert.equal(proposedRoot(["/a/x", "/a/y/z"], "/home/u"), "/a");
  assert.equal(proposedRoot(["norepo"], "/home/u"), "/home/u/projects");
});

test("S1: child dir names — directories only; an unreadable root is the empty set", async () => {
  const ok = await listChildDirNames("/r", { readdirImpl: async () => [{ name: "a", isDirectory: () => true }, { name: "f", isDirectory: () => false }] });
  assert.deepEqual([...ok], ["a"]);
  assert.equal((await listChildDirNames("/r", { readdirImpl: async () => { throw new Error("ENOENT"); } })).size, 0);
});
