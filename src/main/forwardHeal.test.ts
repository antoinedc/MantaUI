import { describe, it, expect } from "vitest";
import {
  decideEviction,
  isPortForwardingFailure,
  parseLsofListeners,
} from "./forwardHeal.js";

describe("isPortForwardingFailure", () => {
  it("matches the observed mux forwarding-request failure", () => {
    const stderr =
      "mux_client_forward: forwarding request failed: Port forwarding failed\n" +
      "muxclient: master forward request failed";
    expect(isPortForwardingFailure(stderr)).toBe(true);
  });

  it("matches bind: address already in use", () => {
    expect(
      isPortForwardingFailure("bind: Address already in use"),
    ).toBe(true);
  });

  it("matches cannot listen to port", () => {
    expect(
      isPortForwardingFailure("Could not request local forwarding.\ncannot listen to port: 14096"),
    ).toBe(true);
  });

  it("does not match unrelated ssh errors", () => {
    expect(
      isPortForwardingFailure("Host key verification failed."),
    ).toBe(false);
    expect(isPortForwardingFailure("")).toBe(false);
  });
});

describe("parseLsofListeners", () => {
  it("parses -F pcn output and dedups a dual-stack ssh master", () => {
    // One ssh master listening on both IPv6 and IPv4 -> two fd records,
    // same pid. Must collapse to a single holder.
    const out = [
      "p74831",
      "cssh",
      "n[::1]:14096",
      "p74831",
      "cssh",
      "n127.0.0.1:14096",
      "",
    ].join("\n");
    expect(parseLsofListeners(out)).toEqual([
      { pid: 74831, command: "ssh" },
    ]);
  });

  it("returns multiple distinct holders", () => {
    const out = ["p100", "cssh", "p200", "cnode", ""].join("\n");
    expect(parseLsofListeners(out)).toEqual([
      { pid: 100, command: "ssh" },
      { pid: 200, command: "node" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseLsofListeners("")).toEqual([]);
    expect(parseLsofListeners("\n\n")).toEqual([]);
  });
});

describe("decideEviction", () => {
  const LIVE = "/tmp/bui-cm-a05dbf069911a874a31c6aebb2cb909368aeda9b";
  const ORPHAN = "/tmp/bui-cm-4c302caf575dde6532669ebda5654c7476707880";

  it("evicts a stale bui master that is not the live socket", () => {
    const holders = [{ pid: 74831, command: "ssh" }];
    const ps = new Map([
      [
        74831,
        `ssh -o ControlMaster=auto -o ControlPath=${ORPHAN} -o ControlPersist=10m dev@157.90.224.92`,
      ],
    ]);
    expect(decideEviction(holders, ps, LIVE)).toEqual({
      action: "evict",
      socketPath: ORPHAN,
      pid: 74831,
    });
  });

  it("does nothing when the live master itself holds the port", () => {
    const holders = [{ pid: 64126, command: "ssh" }];
    const ps = new Map([
      [64126, `ssh -o ControlPath=${LIVE} dev@157.90.224.92`],
    ]);
    expect(decideEviction(holders, ps, LIVE)).toEqual({ action: "none" });
  });

  it("treats a non-ssh holder as foreign (never kills it)", () => {
    const holders = [{ pid: 500, command: "node" }];
    const ps = new Map([[500, "node server.js"]]);
    expect(decideEviction(holders, ps, LIVE)).toEqual({
      action: "foreign",
      pid: 500,
      command: "node",
    });
  });

  it("treats an ssh tunnel on a non-bui socket as foreign", () => {
    // User's own `ssh -L 14096:...` with no bui control socket.
    const holders = [{ pid: 999, command: "ssh" }];
    const ps = new Map([[999, "ssh -L 14096:localhost:4096 somehost"]]);
    expect(decideEviction(holders, ps, LIVE)).toEqual({
      action: "foreign",
      pid: 999,
      command: "ssh",
    });
  });

  it("returns none when nothing holds the port", () => {
    expect(decideEviction([], new Map(), LIVE)).toEqual({ action: "none" });
  });

  it("falls back to lsof command when ps line is missing", () => {
    // ps lookup raced and returned nothing; the bare command from lsof
    // ("ssh") is not enough to find the socket -> foreign, not evict.
    const holders = [{ pid: 74831, command: "ssh" }];
    expect(decideEviction(holders, new Map(), LIVE)).toEqual({
      action: "foreign",
      pid: 74831,
      command: "ssh",
    });
  });
});
