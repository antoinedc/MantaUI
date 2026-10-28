// @vitest-environment jsdom
//
// WS06 (server-first, D23/D24): the palette is a dumb renderer of the box's
// grouped, labelled reply. These tests pin the request shape, that titles are
// the box's label verbatim, the failed / box-too-old states, and the closed-
// conversation jump veto (mouse and Enter).

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { SearchPalette, classifySearchReply } from "./SearchPalette";
import type { Project, TranscriptHit, TranscriptHitGroup } from "../shared/types";

const hit = (sessionId: string, messageId: string): TranscriptHit => ({
  sessionId,
  messageId,
  role: "user",
  pre: "see ",
  match: "needle",
  post: " here",
  timeCreated: Date.now() - 5_000,
});
const group = (over: Partial<TranscriptHitGroup> & { sessionId: string }): TranscriptHitGroup => ({
  isCurrent: false,
  workspace: null,
  name: null,
  label: over.sessionId,
  hits: [hit(over.sessionId, `${over.sessionId}-m1`)],
  ...over,
});

const project = (tmuxSession: string, sid: string, index = 1): Project =>
  ({
    tmuxSession,
    defaultCwd: "/x",
    windows: [{ index, name: "w", opencodeSessionId: sid, paneCurrentPath: "/x" }],
  }) as unknown as Project;

type Reply = Awaited<ReturnType<Window["api"]["opencodeSearchMessages"]>>;

describe("SearchPalette", () => {
  let h: Harness | null = null;
  let search: ReturnType<typeof vi.fn<(input: unknown) => Promise<Reply>>>;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let onJump: ReturnType<typeof vi.fn<(tmuxSession: string, windowIndex: number) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    search = vi.fn<(input: unknown) => Promise<Reply>>();
    onClose = vi.fn<() => void>();
    onJump = vi.fn<(tmuxSession: string, windowIndex: number) => void>();
    (window as unknown as { api: unknown }).api = { opencodeSearchMessages: search };
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
    delete (window as unknown as { api?: unknown }).api;
  });

  function render(projects: Project[] = []) {
    h = mount(
      <SearchPalette sessionId="cur" projects={projects} onJumpToWindow={onJump} onClose={onClose} />,
    );
  }
  async function type(text: string) {
    const input = h!.container.querySelector("input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
  }
  const text = () => h!.container.textContent ?? "";
  const rows = () => Array.from(h!.container.querySelectorAll("button.w-full")) as HTMLButtonElement[];
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("sends {query, scope:'all', primarySessionId} after the debounce — never sessionIds", async () => {
    search.mockResolvedValue({ supported: true, hits: [], groups: [] });
    render();
    await type("  needle ");
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ query: "needle", scope: "all", primarySessionId: "cur" });
    expect(Object.keys(search.mock.calls[0][0] as object)).not.toContain("sessionIds");
  });

  it("sends nothing below two characters", async () => {
    render();
    await type("a");
    expect(search).not.toHaveBeenCalled();
    expect(text()).toContain("Type at least 2 characters");
  });

  it("titles: 'This conversation' for the current group, the box's label verbatim otherwise", async () => {
    search.mockResolvedValue({
      supported: true,
      hits: [],
      groups: [
        group({ sessionId: "cur", isCurrent: true, label: "ignored" }),
        group({ sessionId: "o1", workspace: "ws", name: "win", label: "box-label" }),
        group({ sessionId: "ses_x", workspace: null, name: "win", label: "ses_x" }),
      ],
    });
    render();
    await type("needle");
    const t = text();
    expect(t).toContain("This conversation");
    expect(t).toContain("1 match");
    expect(t).toContain("box-label");
    expect(t).not.toContain("ws › win");
    expect(t).toContain("ses_x");
    expect(t).toContain("3 results · 3 conversations");
  });

  it("degraded:true shows the failed copy, not 'No matches'", async () => {
    search.mockResolvedValue({ supported: true, hits: [], groups: [], degraded: true });
    render();
    await type("needle");
    expect(text()).toContain("Couldn't search — edit the query to try again.");
    expect(text()).not.toContain("No matches");
  });

  it("a reply without groups shows the box-too-old copy", async () => {
    search.mockResolvedValue({ supported: true, hits: [] });
    render();
    await type("needle");
    expect(text()).toContain("Search needs a newer box — update your box to use this.");
  });

  it("a transport rejection shows the failed copy", async () => {
    search.mockRejectedValue(new Error("offline"));
    render();
    await type("needle");
    expect(text()).toContain("Couldn't search — edit the query to try again.");
    expect(text()).not.toContain("No matches");
  });

  it("an empty answer is 'No matches', a truncated one says so", async () => {
    search.mockResolvedValue({ supported: true, hits: [], groups: [] });
    render();
    await type("needle");
    expect(text()).toContain("No matches for “needle”");
    search.mockResolvedValue({
      supported: true,
      hits: [],
      groups: [group({ sessionId: "o1" })],
      truncated: true,
    });
    await type("needles");
    expect(text()).toContain("Showing the newest matches — this history is very large.");
    // A spent budget with nothing found: both the answer and the caveat.
    search.mockResolvedValue({ supported: true, hits: [], groups: [], truncated: true });
    await type("needlesx");
    expect(text()).toContain("No matches for “needlesx”");
    expect(text()).toContain("Showing the newest matches — this history is very large.");
  });

  it("editing the query after a failure replaces the failure with progress", async () => {
    search.mockResolvedValueOnce({ supported: true, hits: [], groups: [], degraded: true });
    render();
    await type("needle");
    expect(text()).toContain("Couldn't search");
    let release: (r: Reply) => void = () => {};
    search.mockReturnValueOnce(new Promise<Reply>((r) => (release = r)));
    await type("needles");
    expect(text()).not.toContain("Couldn't search");
    expect(text()).toContain("Searching other conversations…");
    await act(async () => release({ supported: true, hits: [], groups: [] }));
    expect(text()).toContain("No matches for “needles”");
  });

  it("classifySearchReply covers every kind and its precedence", () => {
    const g = [group({ sessionId: "a" })];
    expect(classifySearchReply({ supported: false })).toMatchObject({ kind: "unsupported" });
    expect(classifySearchReply({ supported: false, groups: g })).toMatchObject({ kind: "unsupported" });
    expect(classifySearchReply({ supported: true })).toMatchObject({ kind: "boxTooOld" });
    expect(classifySearchReply({ supported: true, groups: [], degraded: true })).toMatchObject({ kind: "failed" });
    expect(classifySearchReply({ supported: true, groups: [] })).toMatchObject({ kind: "empty", groups: [] });
    expect(classifySearchReply({ supported: true, groups: g, truncated: true })).toEqual({
      kind: "results",
      groups: g,
      truncated: true,
    });
    expect(classifySearchReply({ supported: true, groups: g }).truncated).toBe(false);
  });

  describe("jump", () => {
    const reply = (): Reply => ({
      supported: true,
      hits: [],
      groups: [group({ sessionId: "gone", label: "ws › closed" })],
    });

    it("an owner-less hit keeps the palette open with a notice (mouse)", async () => {
      search.mockResolvedValue(reply());
      render([]);
      await type("needle");
      await act(async () => rows()[0].click());
      await advance(200);
      expect(onClose).not.toHaveBeenCalled();
      expect(onJump).not.toHaveBeenCalled();
      expect(text()).toContain("That conversation is no longer open.");
      expect(h!.container.querySelector("input")).not.toBeNull();
    });

    it("an owner-less hit keeps the palette open with a notice (Enter)", async () => {
      search.mockResolvedValue(reply());
      render([]);
      await type("needle");
      await act(async () => {
        h!.container
          .querySelector("input")!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      await advance(200);
      expect(onClose).not.toHaveBeenCalled();
      expect(onJump).not.toHaveBeenCalled();
      expect(text()).toContain("That conversation is no longer open.");
    });

    it("the notice clears on the next query change", async () => {
      search.mockResolvedValue(reply());
      render([]);
      await type("needle");
      await act(async () => rows()[0].click());
      expect(text()).toContain("That conversation is no longer open.");
      await type("needles");
      expect(text()).not.toContain("That conversation is no longer open.");
    });

    it("a hit with an owner jumps, then the palette closes (mouse and Enter)", async () => {
      search.mockResolvedValue({
        supported: true,
        hits: [],
        groups: [group({ sessionId: "other", label: "ws › other" })],
      });
      render([project("ws", "other", 4)]);
      await type("needle");
      await act(async () => rows()[0].click());
      await advance(200);
      expect(onJump).toHaveBeenCalledWith("ws", 4);
      expect(onClose).toHaveBeenCalledTimes(1);

      h!.unmount();
      h = null;
      onJump.mockClear();
      onClose.mockClear();
      render([project("ws", "other", 4)]);
      await type("needle");
      await act(async () => {
        h!.container
          .querySelector("input")!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      await advance(200);
      expect(onJump).toHaveBeenCalledWith("ws", 4);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
