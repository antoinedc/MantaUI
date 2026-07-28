// Tests for src/server/pty.mjs pure helpers (BET-138 + BET-346 + BET-348).
// Only shellQuote + resolvePtyCommand are unit-testable without a real PTY
// spawn; the login-shell launch path itself is exercised manually (it
// requires node-pty + a real binary). BET-348 added a test-only
// `_setSpawnShellPty()` hook so we can verify the `spawn()` wiring forwards
// `tmuxTarget` all the way to the spawner.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shellQuote,
  resolvePtyCommand,
  spawn,
  _setSpawnShellPty,
} from "./pty.mjs";

describe("shellQuote", () => {
  it("leaves safe tokens unquoted", () => {
    for (const safe of [
      "claude",
      "--dangerously-skip-permissions",
      "/home/dev/.local/bin/claude",
      "a.b-c_d",
      "KEY=value",
      "127.0.0.1:8787",
    ]) {
      assert.equal(shellQuote(safe), safe, `expected ${safe} unquoted`);
    }
  });

  it("single-quotes tokens containing spaces or metacharacters", () => {
    assert.equal(shellQuote("hello world"), "'hello world'");
    assert.equal(shellQuote("a;b"), "'a;b'");
    assert.equal(shellQuote("$(whoami)"), "'$(whoami)'");
    assert.equal(shellQuote("a|b"), "'a|b'");
  });

  it("escapes embedded single quotes so the re-parse is injection-safe", () => {
    // The classic '\'' trick: close quote, escaped quote, reopen quote.
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
  });
});

describe("resolvePtyCommand", () => {
  const SHELL = "bash";

  it("returns the tmux attach-session argv when tmuxTarget is set", () => {
    // Case 1: plain tmuxTarget → tmux attach-session -t <target>.
    assert.deepEqual(
      resolvePtyCommand({ tmuxTarget: "main:0", shell: SHELL }),
      { file: "tmux", args: ["attach-session", "-t", "main:0"] },
    );
  });

  it("wins over launcher when both tmuxTarget and launcher are set", () => {
    // Case 2: tmuxTarget is set AND launcher is set → tmux still wins.
    // The renderer/CLI never supply both today, but the priority is locked.
    assert.deepEqual(
      resolvePtyCommand({
        tmuxTarget: "main:1",
        launcher: { id: "claude", flags: {} },
        shell: SHELL,
      }),
      { file: "tmux", args: ["attach-session", "-t", "main:1"] },
    );
  });

  it("returns the login-shell-with-command shape for a registered launcher", () => {
    // Case 3: launcher set, tmuxTarget absent → unchanged `-l -c <cmd>`
    // login-shell-with-command behaviour (the existing Claude/Codex path).
    const out = resolvePtyCommand({
      launcher: { id: "claude", flags: {} },
      shell: SHELL,
    });
    assert.equal(out.file, SHELL);
    assert.equal(out.args[0], "-l");
    assert.equal(out.args[1], "-c");
    // The actual command string includes the bin; assert it's a string and
    // mentions the bin (don't pin every argv — the registry may grow).
    assert.equal(typeof out.args[2], "string");
    assert.match(out.args[2], /\bclaude\b/);
  });

  it("returns the plain login shell when neither launcher nor tmuxTarget is set", () => {
    // Case 4: unchanged plain login shell (the base "terminal" mode).
    assert.deepEqual(
      resolvePtyCommand({ shell: SHELL }),
      { file: SHELL, args: ["-l"] },
    );
    // Also: explicit empty launcher (no id) falls through to plain shell.
    assert.deepEqual(
      resolvePtyCommand({ launcher: { id: "", flags: {} }, shell: SHELL }),
      { file: SHELL, args: ["-l"] },
    );
  });

  it("falls through to the plain shell for an unknown launcher id", () => {
    // Case 5: unknown launcher id (stale localStorage mode, deleted registry
    // entry, typo) → falls through to plain shell — pin the defensive
    // behaviour that was already there before BET-346.
    assert.deepEqual(
      resolvePtyCommand({
        launcher: { id: "nonexistent-launcher", flags: {} },
        shell: SHELL,
      }),
      { file: SHELL, args: ["-l"] },
    );
  });
});

// ---- BET-348: spawn() forwards tmuxTarget to spawnShellPty ----------------
//
// The resolvePtyCommand tests above pin the ARGV shape when `tmuxTarget` is
// set, but they don't prove the higher-level `spawn(opts, onEvent)` (the
// function the `pty:spawn` rpc handler calls) actually threads the field
// through. node-pty itself isn't mockable without surgery, so the test uses
// the `_setSpawnShellPty` test hook to swap in a recorder. The recorder
// returns a stub object with the `onData` / `onExit` methods the production
// code expects — those callbacks never fire in this test (the test calls
// spawn() once and exits), so they can be no-ops.

describe("spawn() forwards tmuxTarget to spawnShellPty", () => {
  it("passes a non-empty tmuxTarget through verbatim", () => {
    const calls = [];
    _setSpawnShellPty((opts) => {
      calls.push(opts);
      // Minimal stub matching the IPty surface `spawn()` touches. The
      // returned object sits in the module-level `ptys` Map; `spawn()`
      // attaches onData/onExit to it. We never reach the cleanup path
      // in this test, so the callbacks can be empty.
      return {
        onData: () => {},
        onExit: () => {},
      };
    });
    try {
      spawn(
        {
          sessionKey: "tmux:myproject:0",
          cwd: "/home/dev/projects/myproject",
          cols: 80,
          rows: 24,
          tmuxTarget: "myproject:0",
        },
        () => {},
      );
    } finally {
      _setSpawnShellPty(null);
    }
    assert.equal(calls.length, 1, "spawnShellPty called exactly once");
    assert.equal(calls[0].tmuxTarget, "myproject:0", "tmuxTarget forwarded verbatim");
    assert.equal(calls[0].cwd, "/home/dev/projects/myproject");
    assert.equal(calls[0].launcher, undefined, "no launcher set");
  });

  it("forwards undefined tmuxTarget as undefined (no implicit default)", () => {
    // The "Manta-owned" branch — the renderer omits `tmuxTarget` entirely
    // when opening a window Manta created. Pin that the spawner receives
    // undefined so resolvePtyCommand takes the launcher/shell branch.
    const calls = [];
    _setSpawnShellPty((opts) => {
      calls.push(opts);
      return { onData: () => {}, onExit: () => {} };
    });
    try {
      spawn(
        {
          sessionKey: "ses_x:terminal",
          cwd: "/home/dev/projects/manta",
          cols: 80,
          rows: 24,
        },
        () => {},
      );
    } finally {
      _setSpawnShellPty(null);
    }
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].tmuxTarget,
      undefined,
      "omitted tmuxTarget arrives as undefined, not as '' or null",
    );
  });
});

