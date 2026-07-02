import { describe, it, expect } from "vitest";
import {
  canTransition,
  describe as describeState,
  type ConnectionState,
  type ConnectionStateName,
} from "./state";

const ALL: ConnectionStateName[] = [
  "idle",
  "connecting",
  "connected",
  "stalled",
  "reconnecting",
  "closed",
];

// The full legal edge set, mirrored from state.ts. Every (from,to) pair not
// listed here must be illegal.
const LEGAL: Record<ConnectionStateName, ConnectionStateName[]> = {
  idle: ["connecting"],
  connecting: ["connected", "reconnecting", "closed"],
  connected: ["stalled", "closed"],
  stalled: ["reconnecting", "connected", "closed"],
  reconnecting: ["connected", "reconnecting", "closed"],
  closed: ["idle"],
};

describe("canTransition", () => {
  it("accepts every legal edge", () => {
    for (const from of ALL) {
      for (const to of LEGAL[from]) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it("rejects every edge not in the legal set", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const legal = LEGAL[from].includes(to);
        expect(canTransition(from, to)).toBe(legal);
      }
    }
  });

  it("rejects representative illegal edges explicitly", () => {
    expect(canTransition("idle", "connected")).toBe(false);
    expect(canTransition("idle", "idle")).toBe(false);
    expect(canTransition("connected", "connecting")).toBe(false);
    expect(canTransition("connected", "reconnecting")).toBe(false);
    expect(canTransition("closed", "connecting")).toBe(false);
    expect(canTransition("stalled", "connecting")).toBe(false);
  });
});

describe("describe", () => {
  it("renders each variant", () => {
    const since = new Date("2026-01-01T00:00:00.000Z");
    const cases: [ConnectionState, string][] = [
      [{ state: "idle" }, "idle"],
      [{ state: "connecting", attempt: 3 }, "connecting (attempt 3)"],
      [{ state: "connected" }, "connected"],
      [{ state: "stalled", since }, "stalled since 2026-01-01T00:00:00.000Z"],
      [
        { state: "reconnecting", attempt: 2, backoffMs: 4000 },
        "reconnecting (attempt 2, backoff 4000ms)",
      ],
      [{ state: "closed", reason: "eof" }, "closed (eof)"],
    ];
    for (const [state, expected] of cases) {
      expect(describeState(state)).toBe(expected);
    }
  });
});
