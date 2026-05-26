import { describe, it, expect } from "vitest";
import { isMissingSessionError } from "./pty.js";

// `tmuxNewWindow` auto-heals by recreating the project's tmux session when
// the user's previous session was destroyed (server restart, manual kill,
// destroy-unattached racing the next call). The classifier below is what
// gates that branch — false positives just trigger a redundant new-session
// call, false negatives leak `ssh exited 1: ...` to the user's alert().

describe("isMissingSessionError", () => {
  it("matches tmux's canonical 'can't find session: X' stderr", () => {
    const err = new Error("ssh exited 1: can't find session: asdfg");
    expect(isMissingSessionError(err, "asdfg")).toBe(true);
  });

  it("matches with a straight ASCII apostrophe", () => {
    const err = new Error("ssh exited 1: can't find session: my-project");
    expect(isMissingSessionError(err, "my-project")).toBe(true);
  });

  it("matches case-insensitively for resilience against tmux locale changes", () => {
    const err = new Error("Can't Find Session: foo");
    expect(isMissingSessionError(err, "foo")).toBe(true);
  });

  it("matches the alternate 'session not found: X' phrasing", () => {
    const err = new Error("ssh exited 1: session not found: nw");
    expect(isMissingSessionError(err, "nw")).toBe(true);
  });

  it("returns false for unrelated tmux errors", () => {
    expect(
      isMissingSessionError(new Error("ssh exited 1: no server running"), "x"),
    ).toBe(false);
    expect(
      isMissingSessionError(
        new Error("ssh exited 1: duplicate session: x"),
        "x",
      ),
    ).toBe(false);
  });

  it("returns false for ssh-level failures (host unreachable, auth, etc.)", () => {
    expect(
      isMissingSessionError(
        new Error("ssh exited 255: Connection timed out"),
        "x",
      ),
    ).toBe(false);
    expect(
      isMissingSessionError(
        new Error("ssh exited 255: Permission denied (publickey)"),
        "x",
      ),
    ).toBe(false);
  });

  it("returns false for non-Error values (defensive — promise rejected with a string)", () => {
    expect(isMissingSessionError("can't find session: x", "x")).toBe(false);
    expect(isMissingSessionError(null, "x")).toBe(false);
    expect(isMissingSessionError(undefined, "x")).toBe(false);
  });
});
