// @vitest-environment jsdom
//
// BET-869: the "Review changes" button in the branch popover opens the
// artifacts panel on its Review tab. App.tsx flips the panel open via
// `manta-open-review`; ArtifactsPanel independently listens for the same event
// and selects the Review tab. This pins the panel's half of that bridge.

import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { installMockApi, resetStore, mount } from "./testHarness";
import { ArtifactsPanel } from "./ArtifactsPanel";

function reviewTab(h: { container: Element }) {
  const btn = Array.from(
    h.container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
  ).find((b) => b.textContent?.trim() === "Review");
  expect(btn, 'expected a "Review" tab').not.toBeUndefined();
  return btn!;
}

describe("ArtifactsPanel Review bridge (BET-869)", () => {
  beforeEach(() => {
    installMockApi();
    resetStore();
  });

  it("manta-open-review selects the Review tab", async () => {
    const h = mount(
      <ArtifactsPanel sessionId="ses_test" cwd="/work" open={false} />,
    );
    await h.flush();

    // Default is the Links tab.
    expect(reviewTab(h).getAttribute("aria-selected")).toBe("false");

    act(() => {
      window.dispatchEvent(new CustomEvent("manta-open-review"));
    });
    await h.flush();

    expect(reviewTab(h).getAttribute("aria-selected")).toBe("true");

    h.unmount();
  });
});
