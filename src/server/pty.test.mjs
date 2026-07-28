// Tests for src/server/pty.mjs pure helpers (BET-138 + BET-346). Only
// shellQuote + resolvePtyCommand are unit-testable without a real PTY spawn;
// the login-shell launch path itself is exercised manually (it requires
// node-pty + a real binary).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellQuote, resolvePtyCommand } from "./pty.mjs";

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

