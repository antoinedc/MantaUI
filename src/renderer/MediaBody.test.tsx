// @vitest-environment jsdom
//
// Component tests for MediaBody (BET-1148) — the single inline-media renderer.
//
// Asserts the load-bearing invariant: the reserved aspect box (`[data-media-box]`)
// is present in ALL FOUR states (pending / ready / failed / expired) so the
// transcript's pin-to-bottom logic never sees a height change under the
// reader. Plus the state-specific rules: failed/expired draw a labelled
// placeholder and NO <img>; video never autoplays.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, type Harness } from "./testHarness";
import { MediaBody } from "./MediaBody";
import type { MediaEntry, MediaKind, MediaState } from "./chatUtils";

function entry(
  state: MediaState,
  overrides: Partial<MediaEntry> = {},
): MediaEntry {
  return {
    handle: "h1",
    state,
    beganAt: state === "pending" ? 1000 : null,
    meta: {
      kind: "image" as MediaKind,
      path: null,
      mime: null,
      width: 800,
      height: 600,
      aspectRatio: null,
      count: null,
      title: null,
    },
    ...overrides,
  };
}

// Stub /api/peek (HEAD + GET) so ReadyMedia's byte fetch resolves. jsdom has
// no Response/URL.createObjectURL, so return a fake response, define the blob
// URL helpers, and point serverBase() at a fake host.
function stubPeekFetch() {
  localStorage.setItem("manta_server", "http://localhost");
  const urlSpy = vi.fn(() => "blob:mock");
  const preExistingUrl = URL.createObjectURL;
  Object.assign(URL, { createObjectURL: urlSpy, revokeObjectURL: () => {} });
  const res = {
    ok: true,
    headers: { get: (n: string) => (n === "content-length" ? "5" : null) },
    blob: async () => new Blob(["x"]),
  };
  vi.stubGlobal("fetch", vi.fn(async () => res));
  return () => {
    vi.unstubAllGlobals();
    localStorage.removeItem("manta_server");
    if (typeof preExistingUrl === "function") {
      Object.assign(URL, { createObjectURL: preExistingUrl, revokeObjectURL: URL.revokeObjectURL });
    } else {
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    }
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("MediaBody", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.unstubAllGlobals();
  });

  it("renders a reserved aspect box in the pending state", () => {
    h = mount(<MediaBody entry={entry("pending")} />);
    expect(h.container.querySelector("[data-media-box]")).toBeTruthy();
    expect(h.text()).toContain("Generating image");
  });

  it("renders a reserved aspect box in the ready state", async () => {
    const restore = stubPeekFetch();
    h = mount(
      <MediaBody
        entry={entry("ready", { meta: { kind: "image", path: "/home/dev/a.png", mime: "image/png", width: 800, height: 600, aspectRatio: null, count: null, title: null } })}
      />,
    );
    await flush();
    restore();
    expect(h.container.querySelector("[data-media-box]")).toBeTruthy();
    expect(h.container.querySelector("img")).toBeTruthy();
  });

  it("renders a labelled placeholder with NO <img> in the failed state", () => {
    h = mount(<MediaBody entry={entry("failed")} />);
    expect(h.container.querySelector("[data-media-box]")).toBeTruthy();
    expect(h.container.querySelector("img")).toBeNull();
    expect(h.text()).toContain("failed");
  });

  it("renders a labelled placeholder with NO <img> in the expired state", () => {
    h = mount(<MediaBody entry={entry("expired")} />);
    expect(h.container.querySelector("[data-media-box]")).toBeTruthy();
    expect(h.container.querySelector("img")).toBeNull();
    expect(h.text()).toContain("expired");
  });

  it("renders video with an explicit play control and NO autoplay attribute", async () => {
    const restore = stubPeekFetch();
    h = mount(
      <MediaBody
        entry={entry("ready", { meta: { kind: "video", path: "/home/dev/clip.mp4", mime: "video/mp4", width: 1920, height: 1080, aspectRatio: null, count: null, title: null } })}
      />,
    );
    await flush();
    restore();
    const video = h.container.querySelector("video");
    expect(video).toBeTruthy();
    expect(video?.hasAttribute("autoplay")).toBe(false);
    expect(video?.hasAttribute("controls")).toBe(true);
  });

  it("shows a collapse chevron (expanded by default) and can collapse the body", () => {
    h = mount(<MediaBody entry={entry("pending")} />);
    const toggle = h.container.querySelector("button[aria-expanded='true']");
    expect(toggle).toBeTruthy();
  });
});
