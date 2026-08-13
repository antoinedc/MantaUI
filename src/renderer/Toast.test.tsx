// @vitest-environment jsdom
//
// Render tests for the Toast primitive's multiple-action support (BET-739).
// Pure auto-dismiss logic is covered in Toast.test.ts; these cover the DOM:
// two actions render as two buttons, and the action buttons carry their
// onClick/disabled through.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Toast } from "./Toast";

describe("Toast actions", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders two action buttons when two are given", () => {
    let reminded = 0;
    let kept = 0;
    h = mount(
      <Toast
        onDismiss={() => {}}
        toast={{
          id: "t",
          message: "limit",
          tone: "error",
          actions: [
            { label: "Remind me at reset", onClick: () => reminded++ },
            { label: "Keep going at reset", onClick: () => kept++ },
          ],
        }}
      />,
    );
    const buttons = Array.from(h.container.querySelectorAll("button"));
    const labels = buttons.map((b) => b.textContent);
    expect(labels).toContain("Remind me at reset");
    expect(labels).toContain("Keep going at reset");
    // Each action button fires its own handler.
    (buttons.find((b) => b.textContent === "Remind me at reset") as HTMLButtonElement).click();
    (buttons.find((b) => b.textContent === "Keep going at reset") as HTMLButtonElement).click();
    expect(reminded).toBe(1);
    expect(kept).toBe(1);
  });

  it("caps at two actions — the third is never rendered", () => {
    h = mount(
      <Toast
        onDismiss={() => {}}
        toast={{
          id: "t",
          message: "m",
          actions: [
            { label: "A", onClick: () => {} },
            { label: "B", onClick: () => {} },
            { label: "C", onClick: () => {} },
          ],
        }}
      />,
    );
    const labels = Array.from(h.container.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toContain("A");
    expect(labels).toContain("B");
    expect(labels).not.toContain("C");
  });

  it("renders no action buttons when actions is omitted", () => {
    h = mount(<Toast onDismiss={() => {}} toast={{ id: "t", message: "hi" }} />);
    // Only the dismiss (✕) button exists.
    const buttons = Array.from(h.container.querySelectorAll("button"));
    expect(buttons.length).toBe(1);
  });
});
