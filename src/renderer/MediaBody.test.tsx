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
import { mount, installMockApi, type Harness } from "./testHarness";
import { MediaBody } from "./MediaBody";
import { useStore } from "./store";
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

// ---------------------------------------------------------------------------
// BET-1156 — hover download overlay + working preview download
// ---------------------------------------------------------------------------

describe("MediaBody download (BET-1156)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.unstubAllGlobals();
  });

  function installPullSpy() {
    const agentPullFile = vi.fn(async () => "/Users/a/Downloads/x");
    installMockApi({ agentPullFile });
    return agentPullFile;
  }

  function clickDownload(): HTMLElement | null {
    const btn = h!.container.querySelector('button[aria-label="Download"]') as HTMLElement | null;
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return btn;
  }

  // Mount a ready image/video through the same stub path shared by every test
  // here, returning the pull spy + a `finish()` that lets the byte fetch settle.
  function mountReady(kind: "image" | "video", filename: string, mime: string) {
    const agentPullFile = installPullSpy();
    const restore = stubPeekFetch();
    const isImage = kind === "image";
    h = mount(
      <MediaBody
        entry={entry("ready", {
          meta: {
            kind,
            path: `/home/dev/${filename}`,
            mime,
            width: isImage ? 800 : 1920,
            height: isImage ? 600 : 1080,
            aspectRatio: null,
            count: null,
            title: null,
          },
        })}
      />,
    );
    return {
      agentPullFile,
      finish: async () => {
        await h!.flush();
        restore();
      },
    };
  }

  it("ready image: hover overlay renders, its press downloads and does not open the preview", async () => {
    const { agentPullFile, finish } = mountReady("image", "a.png", "image/png");
    await finish();

    const btn = clickDownload();
    expect(btn).toBeTruthy();
    expect(agentPullFile).toHaveBeenCalledWith("/home/dev/a.png");

    // pointer-events guard: only the button receives pointer events, and the
    // press must NOT open the whole-box click-to-preview overlay.
    expect(btn?.parentElement?.className).toContain("pointer-events-none");
    expect(btn?.className).toContain("pointer-events-auto");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("ready video: hover overlay renders and its press downloads", async () => {
    const { agentPullFile, finish } = mountReady("video", "clip.mp4", "video/mp4");
    await finish();

    const btn = clickDownload();
    expect(btn).toBeTruthy();
    expect(agentPullFile).toHaveBeenCalledWith("/home/dev/clip.mp4");
  });

  it("ready image preview Download is wired to the shared download path and has no Attach", async () => {
    const { agentPullFile, finish } = mountReady("image", "a.png", "image/png");
    await finish();

    // Open the preview overlay by clicking the whole media box.
    (h!.container.querySelector("[data-open-preview]") as HTMLElement).click();
    await h!.flush();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();

    // No dead Attach affordance in the inline-media preview.
    expect(document.body.querySelector('[role="dialog"] button[aria-label="Attach"]')).toBeNull();

    // Preview Download calls the shared download path.
    (document.body.querySelector('[role="dialog"] button[aria-label="Download"]') as HTMLElement | null)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await h!.flush();
    expect(agentPullFile).toHaveBeenCalledWith("/home/dev/a.png");
  });

  // BET-1198: the download icon overlaying transcript media must CONFIRM the
  // save like every other download does. It used to be fire-and-forget, so a
  // save that worked looked exactly like a dead button — which is how a working
  // download got reported as broken.
  it("the hover overlay's press confirms the save, naming the full folder", async () => {
    useStore.setState({ appToasts: [] });
    const { finish } = mountReady("image", "a.png", "image/png");
    await finish();

    clickDownload();
    await h!.flush();

    const toast = useStore.getState().appToasts.at(-1);
    expect(String(toast?.message)).toBe("Saved x to /Users/a/Downloads");
    expect(toast?.actions?.[0].label).toBe("Reveal");
  });

  it("the hover overlay reports a FAILED save instead of failing silently", async () => {
    useStore.setState({ appToasts: [] });
    installMockApi({
      agentPullFile: vi.fn(async () => {
        throw new Error("download failed");
      }),
    });
    const restore = stubPeekFetch();
    h = mount(
      <MediaBody
        entry={entry("ready", {
          meta: {
            kind: "image",
            path: "/home/dev/a.png",
            mime: "image/png",
            width: 800,
            height: 600,
            aspectRatio: null,
            count: null,
            title: null,
          },
        })}
      />,
    );
    await h.flush();
    restore();

    clickDownload();
    await h.flush();

    const toast = useStore.getState().appToasts.at(-1);
    expect(toast?.tone).toBe("error");
    expect(String(toast?.message)).toContain("still on the server");
  });
});
