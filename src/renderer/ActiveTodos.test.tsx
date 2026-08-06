// @vitest-environment jsdom
//
// Component tests for the ActiveTodos checklist card — specifically the manual
// dismiss affordance: the "×" that lets a user hide a STALE list whose items
// aren't all terminal (the auto-dismiss path only fires once every item is
// completed/cancelled and the user submits again).
//
// jsdom loads no stylesheet, so assertions target the dismiss button (by
// aria-label) and the callback it invokes, not visual chrome.

import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { ActiveTodos } from "./MessageRow";

function todos() {
  return [
    { content: "Still relevant", status: "in_progress" },
    { content: "Done task", status: "completed" },
  ];
}

function dismissButton(h: Harness): HTMLButtonElement | null {
  return h.container.querySelector(
    'button[aria-label="Dismiss todo list"]',
  ) as HTMLButtonElement | null;
}

describe("ActiveTodos", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders no dismiss button when no onDismiss is supplied (existing behavior)", () => {
    h = mount(<ActiveTodos todos={todos()} />);
    expect(dismissButton(h)).toBeNull();
  });

  it("renders a dismiss button when onDismiss is supplied", () => {
    h = mount(<ActiveTodos todos={todos()} onDismiss={() => {}} />);
    expect(dismissButton(h)).toBeTruthy();
  });

  it("calls onDismiss when the dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    h = mount(<ActiveTodos todos={todos()} onDismiss={onDismiss} />);
    dismissButton(h)!.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
