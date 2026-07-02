import { describe, it, expect } from "vitest";
import { isMissingSessionError, isHealthyControlMaster } from "./pty.js";

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

// When tmuxList's list-sessions returns EMPTY stdout, that's ambiguous: either
// the box genuinely has no sessions, OR a connectivity blip left a stale
// ControlMaster that new commands attach to but get zero bytes back from (the
// "empty sidebar with a healthy box" failure). We disambiguate with
// `ssh -O check`; this classifier decides whether that check says the master
// is alive. False → evict + retry once before trusting the empty result.

describe("isHealthyControlMaster", () => {
  it("reports healthy when -O check exits 0 (master running)", () => {
    // OpenSSH prints "Master running (pid=NNNN)" to stderr on a live master.
    expect(
      isHealthyControlMaster({ code: 0, stderr: "Master running (pid=48268)" }),
    ).toBe(true);
  });

  it("reports unhealthy when the control socket is gone", () => {
    // We deleted the socket (or connectivity dropped it): non-zero exit.
    expect(
      isHealthyControlMaster({
        code: 255,
        stderr:
          "Control socket connect(/tmp/bui-cm-abc): No such file or directory",
      }),
    ).toBe(false);
  });

  it("reports unhealthy when no master exists yet", () => {
    expect(
      isHealthyControlMaster({ code: 255, stderr: "No ControlPath specified" }),
    ).toBe(false);
  });

  it("reports unhealthy when ssh could not be spawned (null exit code)", () => {
    // cpSpawn 'error' path resolves with code null — treat as not-healthy so
    // we fall through to eviction rather than trusting a phantom master.
    expect(isHealthyControlMaster({ code: null, stderr: "" })).toBe(false);
  });
});
