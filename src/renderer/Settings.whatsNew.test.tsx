// @vitest-environment jsdom
//
// Settings → About → "What's new": a busy state while fetching; success hands the
// newest entry to App (which closes Settings and opens the window); an empty /
// unavailable / older server answers with a toast; any other failure an error
// toast with a human sentence (never the raw error). Stored acknowledgements
// are never touched.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { Settings } from "./Settings";
import { useStore } from "./store";
import type { ServerChangelog } from "../shared/api";
import { NOTES_ENTRY, OLDER_ENTRY } from "./whatsNewFixtures";

describe("Settings — About → What's new", () => {
  let h: Harness | null = null;

  const stub = (serverChangelog: () => Promise<ServerChangelog>) =>
    installMockApi({
      configGet: () => Promise.resolve({}),
      getClientVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      getServerVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      serverChangelog,
    });
  const link = () =>
    [...h!.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === "What's new");
  const toasts = () => useStore.getState().appToasts;

  beforeEach(() => {
    resetStore();
    window.localStorage.clear();
    useStore.setState({ appToasts: [] });
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.restoreAllMocks();
  });

  const open = async (onShowWhatsNew: ((e: unknown) => void) | undefined) => {
    h = mount(<Settings onClose={() => {}} onShowWhatsNew={onShowWhatsNew as never} />);
    await h.flush();
  };
  const press = async () => {
    expect(link(), "What's new link").toBeTruthy();
    await act(async () => link()!.click());
    await h!.flush();
  };

  it("success hands the newest entry over and leaves the acknowledgements alone", async () => {
    stub(() => Promise.resolve({ serverId: "s1", entries: [NOTES_ENTRY, OLDER_ENTRY] }));
    const onShow = vi.fn();
    await open(onShow);
    await press();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledWith(NOTES_ENTRY);
    expect(toasts()).toEqual([]);
    expect(window.localStorage.length).toBe(0);
  });

  it("shows a busy state while it fetches, and no second request starts", async () => {
    let release!: (a: ServerChangelog) => void;
    let calls = 0;
    stub(() => {
      calls += 1;
      return new Promise<ServerChangelog>((r) => (release = r));
    });
    const onShow = vi.fn();
    await open(onShow);
    await act(async () => link()!.click());
    expect(link()!.disabled).toBe(true);
    expect(link()!.getAttribute("aria-busy")).toBe("true");
    await act(async () => link()!.click());
    expect(calls).toBe(1);

    await act(async () => release({ serverId: "s1", entries: [NOTES_ENTRY] }));
    await h!.flush();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(link()!.disabled).toBe(false);
  });

  it.each([
    ["unavailable", { serverId: "s1", entries: [], unavailable: true } as ServerChangelog],
    ["empty", { serverId: "s1", entries: [] } as ServerChangelog],
    ["nothing at all", undefined as unknown as ServerChangelog],
  ])("%s → 'no release notes yet' toast, nothing opens", async (_name, answer) => {
    stub(() => Promise.resolve(answer));
    const onShow = vi.fn();
    await open(onShow);
    await press();
    expect(onShow).not.toHaveBeenCalled();
    expect(toasts().map((t) => t.message)).toEqual(["This server has no release notes yet."]);
    expect(toasts()[0].tone).not.toBe("error");
  });

  it("an older server without the channel gets the same toast, not an error", async () => {
    stub(() => Promise.reject(new Error("unknown rpc channel: server:changelog")));
    const onShow = vi.fn();
    await open(onShow);
    await press();
    expect(onShow).not.toHaveBeenCalled();
    expect(toasts().map((t) => t.message)).toEqual(["This server has no release notes yet."]);
  });

  it("any other failure is an error toast with a human sentence, never the raw error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stub(() => Promise.reject(new Error("ECONNRESET /home/dev/secret/path")));
    const onShow = vi.fn();
    await open(onShow);
    await press();
    expect(onShow).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].tone).toBe("error");
    expect(toasts()[0].message).toBe("Couldn't load release notes from the server — try again.");
    expect(link()!.disabled).toBe(false); // can try again
  });

  it("is not offered when nothing could open the window", async () => {
    stub(() => Promise.resolve({ serverId: "s1", entries: [NOTES_ENTRY] }));
    await open(undefined);
    expect(link()).toBeUndefined();
  });
});
