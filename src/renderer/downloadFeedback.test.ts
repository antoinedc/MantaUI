// @vitest-environment jsdom
//
// Tests for the download-confirmation helper (BET-1198).
//
// The property under test is the one the bug was about: EVERY outcome of a
// download is visible. A silent success is a bug (it reads as "nothing
// happened"), and so is a silent failure.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { saveToDownloads, savedToastMessage } from "./downloadFeedback";
import { useStore } from "./store";

function toasts() {
  return useStore.getState().appToasts;
}

describe("savedToastMessage", () => {
  it("names the file and its FULL folder", () => {
    expect(savedToastMessage("/Users/antoine/Downloads/dog-running.mp4")).toBe(
      "Saved dog-running.mp4 to /Users/antoine/Downloads",
    );
  });

  it("is null when there is no local path (mobile/web browser download)", () => {
    expect(savedToastMessage("")).toBeNull();
  });
});

describe("saveToDownloads", () => {
  const realApi = (globalThis as { window?: { api?: unknown } }).window?.api;

  beforeEach(() => {
    useStore.setState({ appToasts: [] });
  });

  afterEach(() => {
    (window as unknown as { api?: unknown }).api = realApi;
    vi.restoreAllMocks();
  });

  function installApi(api: Record<string, unknown>) {
    (window as unknown as { api: Record<string, unknown> }).api = api;
  }

  it("confirms a desktop save with the full folder and offers Reveal", async () => {
    const revealInFolder = vi.fn(async () => {});
    installApi({
      agentPullFile: vi.fn(async () => "/Users/antoine/Downloads/dog-running.mp4"),
      revealInFolder,
    });

    await saveToDownloads("/home/dev/dog-running.mp4");

    expect(toasts()).toHaveLength(1);
    expect(String(toasts()[0].message)).toBe(
      "Saved dog-running.mp4 to /Users/antoine/Downloads",
    );
    // The confirmation is actionable: Reveal opens the containing folder.
    toasts()[0].actions?.[0].onClick();
    expect(revealInFolder).toHaveBeenCalledWith("/Users/antoine/Downloads/dog-running.mp4");
  });

  it("stays silent on mobile/web, where the browser shows its own download UI", async () => {
    installApi({ agentPullFile: vi.fn(async () => ""), revealInFolder: vi.fn() });
    await saveToDownloads("/home/dev/dog-running.mp4");
    expect(toasts()).toHaveLength(0);
  });

  it("reports a failure instead of throwing an unhandled rejection", async () => {
    installApi({
      agentPullFile: vi.fn(async () => {
        throw new Error("download failed");
      }),
      revealInFolder: vi.fn(),
    });

    // Must not reject — the old fire-and-forget call site surfaced failures
    // only as "Uncaught (in promise)" in devtools.
    await expect(saveToDownloads("/home/dev/dog-running.mp4")).resolves.toBeUndefined();
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].tone).toBe("error");
    expect(String(toasts()[0].message)).toContain("still on the server");
  });

  it("no-ops on an empty path", async () => {
    const agentPullFile = vi.fn(async () => "/x/y");
    installApi({ agentPullFile, revealInFolder: vi.fn() });
    await saveToDownloads("");
    expect(agentPullFile).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(0);
  });
});
