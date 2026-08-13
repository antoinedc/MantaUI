// @vitest-environment jsdom
//
// Component tests for the shared destructive-action confirm dialog
// (BET-724 Task 3 / D7). Built on Modal, so most dialog mechanics (Escape,
// backdrop, focus trap) are already covered by Modal.test.tsx — this file
// covers ConfirmModal's own contract: title/body render, Cancel/Confirm fire
// the right callback, and Escape/backdrop route to Cancel (never Confirm).

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { ConfirmModal } from "./ConfirmModal";

describe("ConfirmModal", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function buttons(harness: Harness): HTMLButtonElement[] {
    return [...harness.container.querySelectorAll("button")] as HTMLButtonElement[];
  }

  it("renders the title and body when open", () => {
    h = mount(
      <ConfirmModal
        open
        title="Delete this session?"
        body="This can't be undone."
        confirmLabel="Delete session"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(h.text()).toContain("Delete this session?");
    expect(h.text()).toContain("This can't be undone.");
  });

  it("renders nothing when closed", () => {
    h = mount(
      <ConfirmModal
        open={false}
        title="Delete this session?"
        body="This can't be undone."
        confirmLabel="Delete session"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(h.text()).not.toContain("Delete this session?");
  });

  it("Cancel fires onCancel, not onConfirm", () => {
    let cancelled = 0;
    let confirmed = 0;
    h = mount(
      <ConfirmModal
        open
        title="Clear this conversation?"
        body="The session keeps running but its context is gone."
        confirmLabel="Clear"
        onConfirm={() => confirmed++}
        onCancel={() => cancelled++}
      />,
    );
    const cancelBtn = buttons(h).find((b) => b.textContent === "Cancel")!;
    expect(cancelBtn).toBeTruthy();
    cancelBtn.click();
    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
  });

  it("the confirm button fires onConfirm, not onCancel", () => {
    let cancelled = 0;
    let confirmed = 0;
    h = mount(
      <ConfirmModal
        open
        title="Delete this session?"
        body="This can't be undone."
        confirmLabel="Delete session"
        onConfirm={() => confirmed++}
        onCancel={() => cancelled++}
      />,
    );
    const confirmBtn = buttons(h).find((b) => b.textContent === "Delete session")!;
    expect(confirmBtn).toBeTruthy();
    confirmBtn.click();
    expect(confirmed).toBe(1);
    expect(cancelled).toBe(0);
  });

  it("Escape routes to onCancel, never onConfirm (Modal's onDismiss = Cancel)", () => {
    let cancelled = 0;
    let confirmed = 0;
    h = mount(
      <ConfirmModal
        open
        title="Delete this session?"
        body="This can't be undone."
        confirmLabel="Delete session"
        onConfirm={() => confirmed++}
        onCancel={() => cancelled++}
      />,
    );
    const dialog = h.container.querySelector('div[role="dialog"]')!;
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
  });

  it("the confirm button uses the danger tone, Cancel uses the default tone", () => {
    h = mount(
      <ConfirmModal
        open
        title="Delete this session?"
        body="This can't be undone."
        confirmLabel="Delete session"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const cancelBtn = buttons(h).find((b) => b.textContent === "Cancel")!;
    const confirmBtn = buttons(h).find((b) => b.textContent === "Delete session")!;
    expect(confirmBtn.className).toContain("text-danger");
    expect(cancelBtn.className).not.toContain("text-danger");
  });
});
