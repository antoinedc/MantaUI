// @vitest-environment jsdom
//
// Component tests for the conversation-wide voice playback engine (BET-881).
// The provider owns ONE <audio> for the whole conversation; each VoicePlayer
// is a pure consumer that binds a stored note to it. These tests mount the
// real provider + real VoicePlayers and drive the disc/speed controls, which
// is exactly where the "one at a time", "idle rows stay idle", "fetched once"
// and "hidden panel pauses" behaviours live.
//
// jsdom does not implement HTMLMediaElement play/pause, so play/pause are
// stubbed to dispatch the matching media event (bubbling, as the real browser
// does) — that is what drives the provider's onPlay/onPause state.
// window.api.voiceFetchNote and URL.createObjectURL/revokeObjectURL are also
// stubbed (jsdom lacks the URL ones).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { mount, installMockApi, type Harness } from "../testHarness";
import { VoicePlaybackProvider } from "./useVoicePlayback";
import { VoicePlayer } from "../VoiceNote";
import type { VoiceNoteRecord } from "../../shared/types";

const peaks = new Uint8Array(40).fill(200);

function makeNote(id: string): VoiceNoteRecord {
  return {
    id,
    sessionId: "s1",
    transcript: "hi",
    mime: "audio/webm",
    durationMs: 5000,
    peaks,
    createdAt: 0,
    expiresAt: null,
    audioAvailable: true,
  };
}

// The play/pause disc is the frame's interactive affordance (aria-label
// "Play|Pause voice note, …"); the speed badge is a separate control. With two
// VoicePlayers mounted, discs[0] is A and discs[1] is B (DOM order).
function discs(container: Element): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /^(Play|Pause) voice note/.test(b.getAttribute("aria-label") ?? ""),
  );
}

function speedButton(container: Element): HTMLButtonElement {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    /^Playback speed /.test(b.getAttribute("aria-label") ?? ""),
  )!;
}

function audioEl(container: Element): HTMLAudioElement {
  return container.querySelector("audio")!;
}

describe("VoicePlaybackProvider + VoicePlayer", () => {
  let h: Harness | null = null;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let playSpy: ReturnType<typeof vi.spyOn>;
  let pauseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.resolve(new Blob()));
    installMockApi({ voiceFetchNote: fetchSpy });
    // jsdom implements neither play/pause nor object URLs.
    playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event("play", { bubbles: true }));
        return Promise.resolve();
      });
    pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event("pause", { bubbles: true }));
      });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => "blob:mock",
      revokeObjectURL: () => {},
    });
  });

  afterEach(() => {
    h?.unmount();
    h = null;
    playSpy.mockRestore();
    pauseSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  const mountTwo = (): Harness =>
    mount(
      <VoicePlaybackProvider active>
        <VoicePlayer note={makeNote("A")} />
        <VoicePlayer note={makeNote("B")} />
      </VoicePlaybackProvider>,
    );

  it("one at a time: toggling B stops A and B reports playing", async () => {
    h = mountTwo();
    const container = h.container;
    await h.flush();
    expect(discs(container)[0].getAttribute("aria-label") ?? "").toMatch(/^Play/);
    expect(discs(container)[1].getAttribute("aria-label") ?? "").toMatch(/^Play/);

    act(() => discs(container)[0].click()); // play A
    await h.flush();
    expect(discs(container)[0].getAttribute("aria-label") ?? "").toMatch(/^Pause/);
    expect(discs(container)[1].getAttribute("aria-label") ?? "").toMatch(/^Play/);

    act(() => discs(container)[1].click()); // play B → A stops
    await h.flush();
    expect(discs(container)[0].getAttribute("aria-label") ?? "").toMatch(/^Play/); // A stopped
    expect(discs(container)[1].getAttribute("aria-label") ?? "").toMatch(/^Pause/); // B playing
  });

  it("idle rows are idle: while A plays, B shows total duration and a Play glyph", async () => {
    h = mountTwo();
    const container = h.container;
    await h.flush();
    act(() => discs(container)[0].click()); // play A only
    await h.flush();

    const frames = Array.from(container.children) as HTMLElement[]; // [frameA, frameB, audio]
    expect((frames[1].textContent ?? "").includes("0:05")).toBe(true); // B idle → total
    expect(discs(container)[1].getAttribute("aria-label") ?? "").toMatch(/^Play voice note/);
  });

  it("fetched once: toggling the same note off and on fetches exactly once", async () => {
    h = mountTwo();
    const container = h.container;
    await h.flush();
    act(() => discs(container)[0].click()); // play A → fetch #1
    await h.flush();
    act(() => discs(container)[0].click()); // pause A (active & playing) → no fetch
    await h.flush();
    act(() => discs(container)[0].click()); // play A again → cache hit → no fetch
    await h.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("deactivation pauses: active=false pauses the engine", async () => {
    h = mountTwo();
    const container = h.container;
    await h.flush();
    act(() => discs(container)[0].click()); // play A
    await h.flush();
    pauseSpy.mockClear();
    h.rerender(
      <VoicePlaybackProvider active={false}>
        <VoicePlayer note={makeNote("A")} />
        <VoicePlayer note={makeNote("B")} />
      </VoicePlaybackProvider>,
    );
    await h.flush();
    expect(pauseSpy).toHaveBeenCalled();
  });

  it("speed is global and applies to the engine's audio element: 1 → 1.5 → 2", async () => {
    h = mountTwo();
    const container = h.container;
    await h.flush();
    act(() => discs(container)[0].click()); // play A so the engine has an element
    await h.flush();

    expect(speedButton(container).textContent).toBe("1×");
    expect(audioEl(container).playbackRate).toBe(1);

    act(() => speedButton(container).click());
    expect(speedButton(container).textContent).toBe("1.5×");
    expect(audioEl(container).playbackRate).toBe(1.5);

    act(() => speedButton(container).click());
    expect(speedButton(container).textContent).toBe("2×");
    expect(audioEl(container).playbackRate).toBe(2);
  });
});
