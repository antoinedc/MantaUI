// Tests for src/server/pty.mjs pure helpers (BET-138 follow-up). Only
// shellQuote is unit-testable without a real PTY spawn; the login-shell launch
// path itself is exercised manually (it requires node-pty + a real binary).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellQuote } from "./pty.mjs";

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
