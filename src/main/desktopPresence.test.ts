import { describe, expect, it, vi } from "vitest";

// desktopPresence.ts imports `electron` at module scope; only the pure body
// builder is exercised here.
vi.mock("electron", () => ({ powerMonitor: { on: vi.fn(), getSystemIdleTime: () => 0 } }));

import { buildPresenceBody } from "./desktopPresence";

describe("buildPresenceBody", () => {
  it("includes the timezone when known", () => {
    expect(buildPresenceBody({ idleSeconds: 12, lockedSeconds: null, timeZone: "Europe/Paris" })).toEqual({
      idleSeconds: 12,
      lockedSeconds: null,
      timeZone: "Europe/Paris",
    });
  });

  it("omits the timezone when empty, null or undefined", () => {
    for (const timeZone of ["", null, undefined]) {
      const body = buildPresenceBody({ idleSeconds: 1, lockedSeconds: 30, timeZone });
      expect(body).toEqual({ idleSeconds: 1, lockedSeconds: 30 });
      expect("timeZone" in body).toBe(false);
    }
  });
});
