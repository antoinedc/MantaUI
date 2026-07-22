// Tests for src/server/launchers.mjs + launcherRegistry.mjs (BET-138
// refinement). Pure logic only — binExists/getProviders are injected so no
// real process spawn or opencode HTTP call happens.

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
// listAvailableLaunchers — filters on BOTH provider-connected AND bin-present
// ---------------------------------------------------------------------------

describe("listAvailableLaunchers", () => {
  it("includes a launcher only when its bin exists AND its provider is connected", async () => {
    const out = await listAvailableLaunchers({
      binExists: async (bin) => bin === "claude",
      getProviders: async () => ({ connected: ["anthropic"] }),
    });
    assert.deepEqual(out.map((l) => l.id), ["claude"]);
    assert.equal(out[0].label, "Claude Code");
  });

  it("excludes a launcher when the bin is missing even if the provider is connected", async () => {
    const out = await listAvailableLaunchers({
      binExists: async () => false,
      getProviders: async () => ({ connected: ["anthropic"] }),
    });
    assert.deepEqual(out, []);
  });

  it("excludes a launcher when the provider isn't connected even if the bin exists", async () => {
    const out = await listAvailableLaunchers({
      binExists: async () => true,
      getProviders: async () => ({ connected: [] }),
    });
    assert.deepEqual(out, []);
  });

  it("tolerates getProviders() rejecting — treats it as no connected providers", async () => {
    const out = await listAvailableLaunchers({
      binExists: async () => true,
      getProviders: async () => { throw new Error("opencode unreachable"); },
    });
    assert.deepEqual(out, []);
  });

  it("returns each launcher's flag schema without the server-only `arg` field", async () => {
    const out = await listAvailableLaunchers({
      binExists: async () => true,
      getProviders: async () => ({ connected: ["anthropic"] }),
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].flags, [
      { key: "skipPermissions", label: "Skip all permission prompts", type: "boolean", default: true },
    ]);
    assert.equal(out[0].flags[0].arg, undefined);
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
});
