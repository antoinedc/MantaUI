import { describe, it, expect } from "vitest";
import { repairCorruptDirectory, isDeadTunnelError } from "./opencode";

// The rpc/side-channel fetch self-heals by restarting the tunnel ONLY when the
// error is classed as a dead tunnel. A network transition (sleep/wake, wifi
// switch, VPN) fells the ssh tunnel and the next connect to 127.0.0.1:<port>
// rejects with EADDRNOTAVAIL — which MUST be treated as dead-tunnel, else
// restart() never fires and every later call keeps hitting the corpse (the
// "connect EADDRNOTAVAIL 127.0.0.1:14098" the user hit on reconcile).
describe("isDeadTunnelError", () => {
  it("classes network-transition connect errors as dead tunnel", () => {
    for (const code of [
      "EADDRNOTAVAIL",
      "ECONNREFUSED",
      "ECONNRESET",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EADDRINUSE",
    ]) {
      expect(isDeadTunnelError({ code })).toBe(true);
    }
  });

  it("classes abort/timeout (wedged/slow link) as dead tunnel", () => {
    expect(isDeadTunnelError({ name: "AbortError" })).toBe(true);
    expect(isDeadTunnelError({ name: "TimeoutError" })).toBe(true);
  });

  it("does not class a plain HTTP/logic error as dead tunnel", () => {
    expect(isDeadTunnelError({ code: "ENOENT" })).toBe(false);
    expect(isDeadTunnelError(new Error("boom"))).toBe(false);
    expect(isDeadTunnelError(undefined)).toBe(false);
    expect(isDeadTunnelError(null)).toBe(false);
  });
});

// Regression: opencode persists `/home/<user>/~/...` when a session is created
// with a tilde directory — it joins its cwd ($HOME) with the literal `~/...`.
// The resulting path does not exist on disk, so every prompt scoped to it
// hangs. repairCorruptDirectory collapses the `/~/` segment back to a real
// absolute path.
describe("repairCorruptDirectory", () => {
  it("repairs the known /home/<user>/~/ corruption", () => {
    expect(repairCorruptDirectory("/home/dev/~/projects/better-ui")).toBe(
      "/home/dev/projects/better-ui",
    );
  });

  it("repairs corruption regardless of username", () => {
    expect(repairCorruptDirectory("/Users/antoine/~/code/x")).toBe(
      "/Users/antoine/code/x",
    );
  });

  it("leaves a clean absolute path untouched", () => {
    expect(repairCorruptDirectory("/home/dev/projects/better-ui")).toBe(
      "/home/dev/projects/better-ui",
    );
  });

  it("leaves a path with a trailing slash untouched", () => {
    expect(repairCorruptDirectory("/home/dev/projects/")).toBe(
      "/home/dev/projects/",
    );
  });

  it("does not touch a tilde that is not a standalone /~/ segment", () => {
    // A component merely containing ~ is not the corruption shape.
    expect(repairCorruptDirectory("/home/dev/proj~ect/x")).toBe(
      "/home/dev/proj~ect/x",
    );
  });

  it("repairs only the first /~/ segment (corruption produces exactly one)", () => {
    expect(repairCorruptDirectory("/home/dev/~/a/~/b")).toBe(
      "/home/dev/a/~/b",
    );
  });

  it("handles an empty string", () => {
    expect(repairCorruptDirectory("")).toBe("");
  });
});
