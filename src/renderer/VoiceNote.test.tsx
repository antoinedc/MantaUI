// @vitest-environment jsdom
//
// Component tests for the voice-note player (BET-880). Following the shape of
// MessageBubble.test.tsx: VoicePlayerFrame is a PURE presentational component
// (every visual is a prop — no api, no fetch), so it is tested directly with
// no mocking. The one integration-style test (the "two players" regression
// guard) mounts the real VoicePlayer, which fetches a blob via window.api, so
// it installs the mock api and stubs URL.createObjectURL for jsdom.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { mount, installMockApi, type Harness } from "./testHarness";
import { VoicePlayerFrame, VoicePlayer } from "./VoiceNote";
import { VoicePlaybackProvider } from "./hooks/useVoicePlayback";
import type { VoiceNoteRecord } from "../shared/types";

// 40 non-zero peaks: with bars=40 and progress=0.5 the bar at index i is
// "played" when i/40 < 0.5, i.e. exactly the first half tints accent.
const peaks = new Uint8Array(40).fill(200);

// The play/pause disc — the frame's interactive affordance. The speed control
// is a SEPARATE button, so filtering by the disc's aria-label is how a test
// counts play/pause controls without catching the speed badge.
function discButton(container: Element): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      /^(Play|Pause) voice note/.test(b.getAttribute("aria-label") ?? ""),
    ) ?? null
  );
}

function speedButton(container: Element): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      /^Playback speed /.test(b.getAttribute("aria-label") ?? ""),
    ) ?? null
  );
}

describe("VoicePlayerFrame", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("ready state: enabled disc + a speed control that both fire on click", () => {
    const onToggle = vi.fn();
    const onCycleSpeed = vi.fn();
    h = mount(
      <VoicePlayerFrame
        peaks={peaks}
        clockMs={5000}
        onToggle={onToggle}
        speed={1}
        onCycleSpeed={onCycleSpeed}
      />,
    );
    const container = h.container;
    const disc = discButton(container);
    expect(disc).not.toBeNull();
    expect(disc!.disabled).toBe(false);
    expect(speedButton(container)?.textContent).toBe("1×");

    act(() => disc!.click());
    expect(onToggle).toHaveBeenCalledTimes(1);

    act(() => speedButton(container)!.click());
    expect(onCycleSpeed).toHaveBeenCalledTimes(1);
  });

  it("expired state: dashed + dimmed, clock suffixed, disc disabled, no speed control", () => {
    h = mount(<VoicePlayerFrame peaks={peaks} clockMs={11000} expired />);
    const frame = h.container.firstElementChild as HTMLElement;
    expect(frame.className).toContain("border-dashed");
    expect(frame.className).toContain("opacity-50");
    expect(frame.textContent ?? "").toMatch(/0:11 · expired$/);
    expect(discButton(h.container)?.disabled).toBe(true);
    expect(speedButton(h.container)).toBeNull();
  });

  it("pending state: muted disc + no speed control + bare clock (no expired suffix)", () => {
    h = mount(<VoicePlayerFrame peaks={peaks} clockMs={7000} />);
    const frame = h.container.firstElementChild as HTMLElement;
    expect(discButton(h.container)?.disabled).toBe(true);
    expect(speedButton(h.container)).toBeNull();
    expect(frame.textContent ?? "").toContain("0:07");
    expect(frame.textContent ?? "").not.toContain("expired");
  });

  it("progress tints roughly half the bars accent, the rest neutral", () => {
    h = mount(
      <VoicePlayerFrame
        peaks={peaks}
        clockMs={5000}
        progress={0.5}
        onToggle={() => {}}
        speed={1}
        onCycleSpeed={() => {}}
      />,
    );
    expect(h.container.querySelectorAll("div.bg-accent").length).toBe(20);
    expect(h.container.querySelectorAll("div.bg-border-strong").length).toBe(20);
  });
});

describe("VoicePlayer — 'two players' regression guard", () => {
  it("renders EXACTLY one play/pause control for an available note", async () => {
    installMockApi(); // window.api.voiceFetchNote — must exist or the fetch throws
    // jsdom has no createObjectURL/revokeObjectURL; stub so the blob fetch
    // resolves quietly instead of rejecting unhandled.
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:mock";
    URL.revokeObjectURL = () => {};
    try {
      const note: VoiceNoteRecord = {
        id: "n1",
        sessionId: "s1",
        transcript: "hi",
        mime: "audio/webm",
        durationMs: 5000,
        peaks,
        createdAt: 0,
        expiresAt: null,
        audioAvailable: true,
      };
      const h = mount(
        <VoicePlaybackProvider active>
          <VoicePlayer note={note} />
        </VoicePlaybackProvider>,
      );
      await h.flush();
      const container = h.container;
      const playControls = Array.from(container.querySelectorAll("button")).filter(
        (b) => /^(Play|Pause) voice note/.test(b.getAttribute("aria-label") ?? ""),
      );
      // The old shape stacked a collapsed chip (its own disc) ABOVE a player
      // disc — two play controls. This must be exactly one. This test fails if
      // a collapsed chip is ever reintroduced.
      expect(playControls.length).toBe(1);
      h.unmount();
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
