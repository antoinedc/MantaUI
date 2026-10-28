// @vitest-environment jsdom
//
// App-level subscription for the box's `models.updated` hint (WS09): another
// device's models write (or this one's, with the Models card closed) must refresh
// the composer's shared model catalogue. Config mirrors (store.defaultModel)
// arrive through the existing `sync` path — covered by the sync tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { installCanvasStub, installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { useStore } from "./store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__MANTA_CHANNEL__ = "prod";
installCanvasStub();
const { App } = await import("./App");

const VALID_BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2";

describe("App — models.updated refreshes the shared model catalogue", () => {
  let h: Harness | null = null;
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mantaPreload = null;
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("a models.updated hint re-reads opencode:models", async () => {
    let hint: () => void = () => {};
    const { api } = installMockApi({
      onModelsUpdated: (cb: () => void) => {
        hint = cb;
        return () => {};
      },
      opencodeModels: () => Promise.resolve([]),
      opencodeDefaultModel: () => Promise.resolve(null),
    });
    resetStore();
    act(() => {
      useStore.setState({
        loaded: true,
        onboardingForced: false,
        serverUrl: `https://${VALID_BOX}.boxes.mantaui.com`,
        boxId: VALID_BOX,
        boxToken: VALID_BOX,
        projects: [],
        activeProjectName: null,
        activeWindowByProject: {},
      });
    });
    h = mount(<App />);
    await h.flush();
    const before = (api.calls.opencodeModels ?? []).length;
    await act(async () => {
      hint();
    });
    await h.flush();
    expect((api.calls.opencodeModels ?? []).length).toBeGreaterThan(before);
  });
});
