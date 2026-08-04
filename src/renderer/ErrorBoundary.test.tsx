// @vitest-environment jsdom
//
// Component tests for the ErrorBoundary (FIX 1): a child that throws must
// render the inline fallback (NOT a blank container), and `reset` + a
// re-render with a non-throwing child must recover.
//
// React logs the caught render error to console.error even when a boundary
// handles it; we silence that expected noise so the suite output stays clean.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, useState } from "react";
import { mount, type Harness } from "./testHarness";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom({ blow }: { blow: boolean }): JSX.Element {
  if (blow) throw new Error("kaboom");
  return <div>recovered content</div>;
}

describe("ErrorBoundary", () => {
  let h: Harness | null = null;
  // React re-throws a caught render error to the DOM so its dev overlay can see
  // it; jsdom then reports it as an uncaught "error" event. The boundary IS
  // handling it, so swallow that expected event to keep the suite output clean.
  const swallow = (e: Event) => e.preventDefault();
  beforeEach(() => {
    window.addEventListener("error", swallow);
  });
  afterEach(() => {
    window.removeEventListener("error", swallow);
    h?.unmount();
    h = null;
    vi.restoreAllMocks();
  });

  it("renders the inline fallback (not a blank container) when a child throws", () => {
    // Silence the expected React error log for the caught throw.
    vi.spyOn(console, "error").mockImplementation(() => {});
    h = mount(
      <ErrorBoundary>
        <Boom blow />
      </ErrorBoundary>,
    );
    // The container is NOT blank — the fallback rendered.
    expect(h.text()).not.toBe("");
    expect(h.text()).toContain("kaboom");
    expect(h.text()).toContain("Reload");
  });

  it("logs the real error via console.error('[error-boundary]', …)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h = mount(
      <ErrorBoundary>
        <Boom blow />
      </ErrorBoundary>,
    );
    expect(
      spy.mock.calls.some((c) => c[0] === "[error-boundary]"),
    ).toBe(true);
  });

  it("recovers when reset is clicked and the child no longer throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A controllable child: the boundary reset re-renders children, at which
    // point `blow` has flipped to false via the parent's state.
    function Host(): JSX.Element {
      const [blow, setBlow] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setBlow(false)}>
            fix
          </button>
          <ErrorBoundary>
            <Boom blow={blow} />
          </ErrorBoundary>
        </div>
      );
    }
    h = mount(<Host />);
    // Fallback is up.
    expect(h.text()).toContain("Reload");

    // Flip the child to non-throwing FIRST, then reset the boundary so the
    // re-render mounts the recovered child.
    const fixBtn = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.textContent === "fix",
    ) as HTMLButtonElement;
    act(() => fixBtn.click());
    const reloadBtn = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.textContent === "Reload",
    ) as HTMLButtonElement;
    act(() => reloadBtn.click());

    expect(h.text()).toContain("recovered content");
    expect(h.text()).not.toContain("Reload");
  });

  it("uses a custom fallback when provided", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h = mount(
      <ErrorBoundary fallback={(e) => <div>custom: {e.message}</div>}>
        <Boom blow />
      </ErrorBoundary>,
    );
    expect(h.text()).toBe("custom: kaboom");
  });
});
