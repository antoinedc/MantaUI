// events.test.ts — pure /events helpers: envelope parse, opencode narrowing,
// viewed-session filter, and reconnect-backoff decision.

import { describe, expect, it } from "vitest";

import {
  backoffDelay,
  DEFAULT_BACKOFF,
  eventMatchesSession,
  parseEnvelope,
  reconnectDecision,
  toOpencodeEvent,
} from "../events";

describe("parseEnvelope", () => {
  it("parses a well-formed {kind,payload} frame", () => {
    expect(parseEnvelope('{"kind":"opencode","payload":{"type":"x"}}')).toEqual({
      kind: "opencode",
      payload: { type: "x" },
    });
  });

  it("returns null for non-string, non-JSON, or non-object frames", () => {
    expect(parseEnvelope(42)).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope("null")).toBeNull();
    expect(parseEnvelope("[1,2]")).toBeNull(); // array has no `kind`
    expect(parseEnvelope('{"payload":1}')).toBeNull(); // missing kind
    expect(parseEnvelope('{"kind":5}')).toBeNull(); // non-string kind
  });
});

describe("toOpencodeEvent", () => {
  it("narrows an opencode envelope to an event", () => {
    const ev = toOpencodeEvent({
      kind: "opencode",
      payload: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    expect(ev).toEqual({ type: "session.idle", properties: { sessionID: "s1" } });
  });

  it("defaults missing/invalid properties to {}", () => {
    const ev = toOpencodeEvent({ kind: "opencode", payload: { type: "x" } });
    expect(ev).toEqual({ type: "x", properties: {} });
  });

  it("returns null for non-opencode kinds or bad payloads", () => {
    expect(toOpencodeEvent(null)).toBeNull();
    expect(toOpencodeEvent({ kind: "pty", payload: { type: "x" } })).toBeNull();
    expect(toOpencodeEvent({ kind: "opencode", payload: null })).toBeNull();
    expect(toOpencodeEvent({ kind: "opencode", payload: { notype: 1 } })).toBeNull();
  });
});

describe("eventMatchesSession", () => {
  it("keeps events for the viewed session", () => {
    expect(
      eventMatchesSession({ type: "x", properties: { sessionID: "s1" } }, "s1"),
    ).toBe(true);
  });

  it("drops events for a different session", () => {
    expect(
      eventMatchesSession({ type: "x", properties: { sessionID: "s2" } }, "s1"),
    ).toBe(false);
  });

  it("keeps events with no sessionID (global / synthetic)", () => {
    expect(eventMatchesSession({ type: "x", properties: {} }, "s1")).toBe(true);
    expect(eventMatchesSession({ type: "x" }, "s1")).toBe(true);
  });
});

describe("backoffDelay", () => {
  it("returns baseMs on the first attempt", () => {
    expect(backoffDelay(1)).toBe(DEFAULT_BACKOFF.baseMs);
    expect(backoffDelay(0)).toBe(DEFAULT_BACKOFF.baseMs);
  });

  it("grows exponentially and caps at maxMs", () => {
    // base 500, factor 2: attempt2=1000, attempt3=2000, attempt4=4000...
    expect(backoffDelay(2)).toBe(1000);
    expect(backoffDelay(3)).toBe(2000);
    expect(backoffDelay(4)).toBe(4000);
    // eventually hits the 15000 cap
    expect(backoffDelay(20)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it("respects a custom config", () => {
    const cfg = { baseMs: 100, maxMs: 300, factor: 2 };
    expect(backoffDelay(1, cfg)).toBe(100);
    expect(backoffDelay(2, cfg)).toBe(200);
    expect(backoffDelay(3, cfg)).toBe(300); // 400 capped to 300
  });
});

describe("reconnectDecision", () => {
  it("does not reconnect on an intentional close", () => {
    expect(reconnectDecision(1, true)).toEqual({ reconnect: false, delayMs: 0 });
  });

  it("reconnects with a backoff delay on an unexpected close", () => {
    expect(reconnectDecision(1, false)).toEqual({ reconnect: true, delayMs: 500 });
    expect(reconnectDecision(3, false)).toEqual({ reconnect: true, delayMs: 2000 });
  });
});
