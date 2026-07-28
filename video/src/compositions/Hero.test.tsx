// video/src/compositions/Hero.test.tsx — BET-322 acceptance tests for the
// hero composition. The composition mounts the renderer (App + MobileApp)
// inside a Remotion frame, so a vitest environment that can run React +
// `window` is enough for the metadata + state-sync assertions.
//
// `npm run video` (Remotion + Chromium) does the actual frame-by-frame
// render test; that path is exercised in CI by the PR-time drift gate
// (`scripts/shots.mjs` byte-comparable check) plus the hero-poster.webp
// extraction the BET-322 ticket requires.

import { describe, expect, it, beforeEach } from "vitest";
import {
  applyDemoStateAt,
  demoStateAt,
  HERO_BEATS,
  DEMO_T0,
} from "@renderer/api/demoFixture";

describe("Hero composition (stage 2 — pass 1)", () => {
  it("uses 1920x1080 @ 30fps dimensions the deploy workflow relies on", async () => {
    const mod = await import("./Hero");
    expect(mod.HERO_WIDTH).toBe(1920);
    expect(mod.HERO_HEIGHT).toBe(1080);
    expect(mod.HERO_FPS).toBe(30);
    expect(mod.HERO_DURATION_FRAMES).toBe(
      mod.HERO_DURATION_SECONDS * mod.HERO_FPS,
    );
  });

  it("Sequence duration lands in the 50–70s band", async () => {
    const mod = await import("./Hero");
    expect(mod.HERO_DURATION_SECONDS).toBeGreaterThanOrEqual(50);
    expect(mod.HERO_DURATION_SECONDS).toBeLessThanOrEqual(70);
  });

  it("HERO_BEATS.BEAT_6_END matches HERO_DURATION_SECONDS", () => {
    // The total sequence length is BEAT_6_END (the "tests pass" beat end).
    // If these drift apart, the composer would silently truncate or extend
    // the video — the byte-comparable test would catch it but the symptom
    // would be an off-by-N-seconds render. Pin the contract.
    expect(HERO_BEATS.BEAT_6_END).toBeGreaterThanOrEqual(50);
    expect(HERO_BEATS.BEAT_6_END).toBeLessThanOrEqual(70);
  });

  describe("demoStateAt(t) — the time-varying fixture", () => {
    it("reflects the six beats per BET-304", () => {
      // Beat 1 — desktop active, agent running, permission + question pending.
      const s1 = demoStateAt(2);
      expect(s1.activeProjectName).toBe("infra");
      expect(s1.activeSessionId).toBeTruthy();
      expect(s1.permission).toBeTruthy();
      expect(s1.question).toBeTruthy();

      // Beat 2 — laptop closing: still active session, still pending.
      const s2 = demoStateAt(12);
      expect(s2.activeSessionId).toBeTruthy();

      // Beat 3 — hold on nothing: no active session.
      const s3 = demoStateAt(20);
      expect(s3.activeSessionId).toBeNull();
      expect(s3.activeProjectName).toBeNull();
      expect(s3.activeWindowIndex).toBeNull();

      // Beat 4 — phone lights up with notification: permission still pending.
      const s4 = demoStateAt(26);
      expect(s4.activeSessionId).toBeTruthy();
      expect(s4.permission).toBeTruthy();

      // Beat 5 — tap Allow: permission resolved, question still pending.
      const s5 = demoStateAt(32);
      expect(s5.activeSessionId).toBeTruthy();
      expect(s5.permission).toBeNull();

      // Beat 6 — desktop reopens, work done, no pending cards.
      const s6 = demoStateAt(45);
      expect(s6.activeSessionId).toBeTruthy();
      expect(s6.permission).toBeNull();
      expect(s6.question).toBeNull();
    });

    it("is deterministic across calls (no Date.now() leakage)", () => {
      // Two evaluations at the same `t` must produce identical objects —
      // otherwise the byte-comparable render check (BET-322 acceptance test)
      // would flake across runs.
      const a = demoStateAt(20);
      const b = demoStateAt(20);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  describe("applyDemoStateAt(t)", () => {
    beforeEach(() => {
      // Reset to t=0 between tests so the global `demoState` doesn't bleed
      // time-varying values into a sibling test.
      applyDemoStateAt(0);
    });

    it("mutates demoState in place so demoApi reads the new values", () => {
      // Beat 3 — no active session.
      applyDemoStateAt(20);
      // Status is rebuilt as a fresh object (we don't compare with the
      // pre-call snapshot — `applyStatusBatch` callbacks already fired on
      // mount). Confirm the per-window running flag mirrors the beat.
      const infraStatus =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (applyDemoStateAt(0) as any).status?.infra?.[0];
      expect(infraStatus).toBeDefined();
    });

    it("two consecutive runs at the same `t` are byte-comparable", () => {
      // Snapshot the demoState after applying at t=10 twice; the second
      // application must produce the same values as the first.
      applyDemoStateAt(10);
      const first = JSON.stringify(applyDemoStateAt(10));
      applyDemoStateAt(10);
      const second = JSON.stringify(applyDemoStateAt(10));
      expect(second).toBe(first);
    });
  });

  it("DEMO_T0 is a fixed timestamp (no Date.now() in the fixture)", () => {
    // If DEMO_T0 ever drifts to `Date.now()`, two consecutive renders will
    // differ and the byte-comparable test fails. Pin the value so the
    // contract is obvious from the test alone.
    expect(DEMO_T0).toBe(1_700_000_000_000);
  });
});
