// @vitest-environment jsdom
//
// The Explorer toggle in the session header: registered immediately BEFORE the
// Artifacts entry, chat sessions only, and it drives the right slot.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { installMockApi, mountSessionHeader, resetStore, type Harness } from "./testHarness";
import { useStore } from "./store";
import * as store from "./explorer/explorerStore";

let h: Harness | null = null;
beforeEach(() => {
  localStorage.clear();
  store.resetExplorerStore();
  installMockApi();
  resetStore();
  act(() => {
    useStore.setState({
      projects: [
        {
          tmuxSession: "p",
          defaultCwd: "/home/u/proj",
          attached: false,
          windows: [{ index: 0, name: "w", active: true, paneCurrentPath: "/home/u/proj", opencodeSessionId: "ses_a" }],
        },
      ] as never,
    });
  });
});
afterEach(() => {
  h?.unmount();
  h = null;
});

const toggle = () => h!.container.querySelector<HTMLButtonElement>(".manta-explorer-toggle");

describe("SessionHeader — Explorer toggle", () => {
  it("renders before the Artifacts toggle for a chat session", () => {
    h = mountSessionHeader({ sessionId: "ses_a", artifactsOpen: false, onToggleArtifacts: () => {} });
    const labels = [...h.container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    const ex = labels.indexOf("Show file explorer");
    const art = labels.indexOf("Show artifacts");
    expect(ex).toBeGreaterThanOrEqual(0);
    expect(art).toBe(ex + 1);
  });

  it("toggles this session's Explorer and reflects the state in its label", () => {
    h = mountSessionHeader({ sessionId: "ses_a", artifactsOpen: false, onToggleArtifacts: () => {} });
    act(() => toggle()!.click());
    expect(store.shownRightPanel("ses_a")).toBe("explorer");
    expect(toggle()!.getAttribute("aria-label")).toBe("Hide file explorer");
    act(() => toggle()!.click());
    expect(store.shownRightPanel("ses_a")).toBe("none");
    expect(toggle()!.getAttribute("aria-label")).toBe("Show file explorer");
  });

  it("opening it closes Artifacts (one writer)", () => {
    store.setRightPanel("ses_a", "artifacts");
    h = mountSessionHeader({ sessionId: "ses_a", artifactsOpen: true, onToggleArtifacts: () => {} });
    act(() => toggle()!.click());
    expect(store.getAppState().artifactsOpen).toBe(false);
  });

  it("is absent without an owning window (not a chat session), and without the panel plumbing", () => {
    h = mountSessionHeader({ sessionId: "ses_unknown", artifactsOpen: false, onToggleArtifacts: () => {} });
    expect(toggle()).toBeNull();
    h.unmount();
    h = mountSessionHeader({ sessionId: "ses_a" });
    expect(toggle()).toBeNull();
  });
});
