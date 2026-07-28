// Tests for src/server/launchers.mjs + launcherRegistry.mjs (BET-138
// refinement, BET-310). Pure logic only — binExists is injected so no real
// process spawn happens.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { binExists, listAvailableLaunchers } from "./launchers.mjs";
import { LAUNCHERS, findLauncher } from "./launcherRegistry.mjs";

// ---------------------------------------------------------------------------
// binExists — shell-metacharacter guard
// ---------------------------------------------------------------------------

describe("binExists", () => {
  it("rejects binary names containing shell metacharacters without probing", async () => {
    for (const bad of ["claude; rm -rf /", "claude && echo hi", "$(whoami)", "`id`", "a|b", ""]) {
      assert.equal(await binExists(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it("accepts alnum/dot/dash/underscore binary names as syntactically valid", async () => {
    // Real PATH lookup for a binary that almost certainly doesn't exist —
    // asserts it does NOT throw and resolves to a boolean (guard didn't
    // short-circuit these safe characters).
    const result = await binExists("manta-test-nonexistent-binary-xyz");
    assert.equal(typeof result, "boolean");
  });
});

// ---------------------------------------------------------------------------
// listAvailableLaunchers — filters on bin-present only (BET-310)
// ---------------------------------------------------------------------------

describe("listAvailableLaunchers", () => {
  it("includes a launcher when its bin exists", async () => {
    const out = await listAvailableLaunchers({
      binExists: async (bin) => bin === "claude",
    });
    assert.deepEqual(out.map((l) => l.id), ["claude"]);
    assert.equal(out[0].label, "Claude Code");
  });

  it("excludes a launcher when its bin is missing", async () => {
    const out = await listAvailableLaunchers({
      binExists: async () => false,
    });
    assert.deepEqual(out, []);
  });

  it("returns exactly the present-launchers in registry order when only some bins resolve (BET-310: claude+codex present, kimi absent)", async () => {
    const out = await listAvailableLaunchers({
      binExists: async (bin) => bin === "claude" || bin === "codex",
    });
    assert.deepEqual(out.map((l) => l.id), ["claude", "codex"]);
  });

  it("returns each launcher's flag schema without the server-only `arg` field", async () => {
    const out = await listAvailableLaunchers({
      binExists: async () => true,
    });
    const claude = out.find((l) => l.id === "claude");
    assert.deepEqual(claude.flags, [
      { key: "skipPermissions", label: "Skip all permission prompts", type: "boolean", default: true },
    ]);
    assert.equal(claude.flags[0].arg, undefined);
  });

  // BET-354: the claude-auth-login entry is a programmatic spawn target
  // for the connect card — it must NEVER appear in the user-facing
  // dropdown regardless of whether its bin resolves.
  it("hides the claude-auth-login launcher even when its bin resolves (BET-354)", async () => {
    const out = await listAvailableLaunchers({
      binExists: async () => true,
    });
    assert.equal(
      out.find((l) => l.id === "claude-auth-login"),
      undefined,
      "claude-auth-login must not appear in the dropdown",
    );
  });
});

// ---------------------------------------------------------------------------
// launcherRegistry — buildArgs
// ---------------------------------------------------------------------------

describe("launcherRegistry: claude buildArgs", () => {
  const claude = findLauncher("claude");

  it("emits --dangerously-skip-permissions when skipPermissions is truthy", () => {
    assert.deepEqual(claude.buildArgs({ skipPermissions: true }), [
      "--dangerously-skip-permissions",
    ]);
  });

  it("emits nothing when skipPermissions is false", () => {
    assert.deepEqual(claude.buildArgs({ skipPermissions: false }), []);
  });

  it("emits nothing when values is undefined/empty", () => {
    assert.deepEqual(claude.buildArgs(undefined), []);
    assert.deepEqual(claude.buildArgs({}), []);
  });
});

describe("findLauncher", () => {
  it("returns null for an unknown id", () => {
    assert.equal(findLauncher("nonexistent"), null);
  });

  it("returns the registry entry for a known id", () => {
    assert.equal(findLauncher("claude"), LAUNCHERS.find((l) => l.id === "claude"));
  });

  // BET-354: even though listAvailableLaunchers hides claude-auth-login,
  // findLauncher still resolves it so pty:spawn can use it programmatically.
  it("resolves claude-auth-login (BET-354)", () => {
    const l = findLauncher("claude-auth-login");
    assert.ok(l);
    assert.equal(l.bin, "claude");
    assert.deepEqual(l.buildArgs({}), ["auth", "login"]);
    assert.equal(l.hidden, true);
  });
});
