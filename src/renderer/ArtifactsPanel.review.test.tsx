// @vitest-environment jsdom
//
// BET-869: the "Review changes" button in the branch popover opens the
// artifacts panel in its Review MODE. App.tsx flips the panel open via
// `manta-open-review`; ArtifactsPanel independently listens for the same event
// and switches to Review. Panels the panel's half of that bridge. Review is a
// mode, not a kind — it lives in a two-segment `Artifacts | Review` switch
// above the kind tab bar, so this asserts the mode button's `aria-pressed`,
// not a `role="tab"`.

import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { installMockApi, resetStore, mount } from "./testHarness";
import { ArtifactsPanel } from "./ArtifactsPanel";

function reviewModeButton(h: { container: Element }) {
  const btn = Array.from(
    h.container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
  ).find((b) => b.textContent?.trim() === "Review");
  expect(btn, 'expected a "Review" mode button').not.toBeUndefined();
  return btn!;
}

describe("ArtifactsPanel Review bridge (BET-869)", () => {
  beforeEach(() => {
    installMockApi();
    resetStore();
  });

  it("defaults to the Artifacts mode", async () => {
    const h = mount(
      <ArtifactsPanel sessionId="ses_test" cwd="/work" open={false} />,
    );
    await h.flush();
    expect(reviewModeButton(h).getAttribute("aria-pressed")).toBe("false");
    h.unmount();
  });

  it("manta-open-review switches to the Review mode", async () => {
    const h = mount(
      <ArtifactsPanel sessionId="ses_test" cwd="/work" open={false} />,
    );
    await h.flush();

    act(() => {
      window.dispatchEvent(new CustomEvent("manta-open-review"));
    });
    await h.flush();

    expect(reviewModeButton(h).getAttribute("aria-pressed")).toBe("true");

    h.unmount();
  });
});
