// @vitest-environment jsdom
//
// WS11 D9: generated media survive a reload because the BOX sends them (`message.view.media`); the live entry (the
// session's `media` frames) still wins while it exists.

import { describe, it, expect, afterEach } from "vitest";
import { mount, installMockApi, type Harness } from "./testHarness";
import { MessageRow } from "./MessageRow";
import type { MediaEntry } from "./chatUtils";
import type { OpencodeMessage, MediaViewEntry } from "../shared/types";

const entry = (id: string, path: string): MediaViewEntry => ({
  id, kind: "image", path, mime: "image/png", width: 600, height: 400, aspectRatio: null, count: null, size: 9, title: null, handle: null,
});

describe("MessageRow canonical media", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const render = (media: MediaEntry | null, view?: OpencodeMessage["view"], role = "assistant", liveMediaHandles?: ReadonlySet<string>) => {
    installMockApi();
    const msg = {
      info: { id: "a1", sessionID: "s", role, time: { created: 1, completed: 2 } },
      parts: [{ id: "p1", messageID: "a1", type: "text", text: "Here" }],
      ...(view ? { view } : {}),
    } as unknown as OpencodeMessage;
    h = mount(
      <MessageRow msg={msg} showThinking={false} turnDurationMs={null} turnTokens={null} verbSeedId={null} truncation={null} commandInfo={null} media={media} liveMediaHandles={liveMediaHandles} />,
    );
  };

  const previews = () => h!.container.querySelectorAll('[aria-label="Open image preview"]').length;

  it("draws one card per canonical entry when there is no live entry", () => {
    render(null, { media: [entry("media:h:a", "/a.png"), entry("media:h:b", "/b.png")] });
    expect(previews()).toBe(2);
  });

  it("the live entry wins: the canonical entries are not drawn on top of it", () => {
    const live: MediaEntry = { handle: "a", state: "ready", beganAt: null, meta: { kind: "image", path: "/a.png", mime: "image/png", width: 1, height: 1, aspectRatio: null, count: null, title: null } };
    render(live, { media: [entry("media:h:a", "/a.png")] });
    expect(previews()).toBe(1);
  });

  it("a canonical entry whose handle a live card elsewhere in the session draws is not drawn again", () => {
    const withHandle = (id: string, path: string, handle: string): MediaViewEntry => ({ ...entry(id, path), handle });
    render(null, { media: [withHandle("media:h:a", "/a.png", "a"), withHandle("media:h:b", "/b.png", "b")] }, "assistant", new Set(["a"]));
    expect(previews()).toBe(1);
  });

  it("a user message never draws media; no view, no media", () => {
    render(null, { media: [entry("media:h:a", "/a.png")] }, "user");
    expect(previews()).toBe(0);
    h!.unmount();
    render(null, undefined);
    expect(previews()).toBe(0);
  });
});
