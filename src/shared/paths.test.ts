// Tests for src/shared/paths.mjs — the on-disk state directory constants
// and the `~` → `$HOME` expander.
//
// Pure-function coverage. The expander's POSIX-vs-Windows correctness comes
// from `path.join`, so the byte-level assertions here pin the observable
// shape: bare `~` returns the homedir verbatim, leading-`~/` forms join
// through the platform separator, the backslash form the function already
// accepted still works, and non-tilde / non-string inputs pass through.

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { expandTilde } from "./paths.mjs";

describe("paths — expandTilde", () => {
  it("expands a bare `~` to the user's homedir", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  it("expands `~/foo/bar` against the user's homedir", () => {
    expect(expandTilde("~/foo/bar")).toBe(`${homedir()}/foo/bar`);
  });

  it("expands `~\\foo` (backslash form) against the user's homedir", () => {
    // The function accepts the backslash form for parity with Windows
    // callers; on POSIX platforms path.join converts the forward slashes
    // back to `/`, so the result is still a POSIX-style absolute path.
    expect(expandTilde("~\\foo")).toBe(`${homedir()}/foo`);
  });

  it("passes a non-tilde path through unchanged", () => {
    // A bare relative path with no leading `~` must NOT be touched — only
    // the leading-tilde expansion is this function's job. Do NOT reach into
    // it for resolve()/absolute() behaviour.
    expect(expandTilde("relative/path")).toBe("relative/path");
    expect(expandTilde("/already/absolute")).toBe("/already/absolute");
  });

  it("passes a non-string input through unchanged", () => {
    // The function is called from user-input paths that may be `undefined`,
    // `null`, numbers, etc. when the field was missing. The contract is
    // "pass through whatever you got" — not "throw" — so the caller can
    // detect the missing-field case at its own layer.
    expect(expandTilde(undefined)).toBeUndefined();
    expect(expandTilde(null)).toBeNull();
    expect(expandTilde(42)).toBe(42);
    expect(expandTilde("")).toBe("");
  });
});
