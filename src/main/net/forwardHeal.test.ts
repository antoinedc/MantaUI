import { describe, it, expect } from "vitest";
import {
  decideEviction,
  isPortForwardingFailure,
  parseLsofListeners,
} from "./forwardHeal";

// These pure orphan-eviction helpers moved here from src/main/forwardHeal.ts in
// BET-46.3. src/main/forwardHeal.test.ts still exercises them via the re-export
// shim; this file pins the behavior at their new home so a future shim removal
// can't silently drop coverage.

describe("isPortForwardingFailure", () => {
  it("matches the OpenSSH port-bind phrasings", () => {
    expect(isPortForwardingFailure("Port forwarding failed.")).toBe(true);
    expect(isPortForwardingFailure("forwarding request failed")).toBe(true);
    expect(isPortForwardingFailure("bind: Address already in use")).toBe(true);
    expect(
      isPortForwardingFailure(
        "Could not request local forwarding.\ncannot listen to port: 14096",
      ),
    ).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(isPortForwardingFailure("Host key verification failed.")).toBe(false);
    expect(isPortForwardingFailure("")).toBe(false);
  });
});

describe("parseLsofListeners", () => {
  it("parses -F pcn records and dedups a pid seen on v4+v6", () => {
    const out = "p123\ncssh\nn127.0.0.1:14096\np123\ncssh\nn[::1]:14096\n";
    expect(parseLsofListeners(out)).toEqual([{ pid: 123, command: "ssh" }]);
  });

  it("returns [] on empty / whitespace input", () => {
    expect(parseLsofListeners("")).toEqual([]);
    expect(parseLsofListeners("\n\n")).toEqual([]);
  });
});

describe("decideEviction", () => {
  const LIVE = "/tmp/bui-cm-abc123";

  it("evicts a stale bui master (different socket than live)", () => {
    const holders = [{ pid: 42, command: "ssh" }];
    const ps = new Map([[42, "ssh -o ControlPath=/tmp/bui-cm-abcdef01 -N host"]]);
    expect(decideEviction(holders, ps, LIVE)).toEqual({
      action: "evict",
      socketPath: "/tmp/bui-cm-abcdef01",
      pid: 42,
    });
  });

  it("is a no-op when the live master itself holds the port", () => {
    const holders = [{ pid: 42, command: "ssh" }];
    const ps = new Map([[42, `ssh -o ControlPath=${LIVE} -N host`]]);
    expect(decideEviction(holders, ps, LIVE)).toEqual({ action: "none" });
  });

  it("treats a non-ssh holder as foreign", () => {
    const holders = [{ pid: 7, command: "node" }];
    expect(decideEviction(holders, new Map(), LIVE)).toEqual({
      action: "foreign",
      pid: 7,
      command: "node",
    });
  });

  it("treats an ssh holder on a non-bui socket as foreign", () => {
    const holders = [{ pid: 9, command: "ssh" }];
    const ps = new Map([[9, "ssh -L 14096:localhost:14096 host"]]);
    expect(decideEviction(holders, ps, LIVE)).toEqual({
      action: "foreign",
      pid: 9,
      command: "ssh",
    });
  });

  it("is a no-op when nothing holds the port", () => {
    expect(decideEviction([], new Map(), LIVE)).toEqual({ action: "none" });
  });
});
