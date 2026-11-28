// @vitest-environment jsdom
//
// The refused "Clear conversation" dialog is a NATIVE <dialog> opened with showModal() (design chat-tasks-decisions §5, guide `dialog`):
// named by its heading, no role / aria-modal of its own, Close is the focused (autofocus) choice, Escape and Close both just close it,
// Open Fleet closes it and asks for Fleet. jsdom has no showModal / close: the polyfill below does what the browser does (the open
// attribute, focus on the autofocus control, returnValue, a `close` event) so the component's own wiring is what is under test.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { ClearBlockedModal, type ClearBlock } from "./ClearBlockedModal";

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
    this.dataset.modal = "true";
    (this.querySelector("[autofocus]") as HTMLElement | null)?.focus();
  };
  proto.close = function (this: HTMLDialogElement, value?: string) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    if (value !== undefined) this.returnValue = value;
    this.dispatchEvent(new Event("close"));
  };
});

const block = (over: Partial<ClearBlock> = {}): ClearBlock => ({
  tasks: [{ key: "j1", title: "Fix the flaky upload test", project: "Ronda", status: "In progress" }],
  refusal: null,
  onOpenFleet: vi.fn(),
  onDismiss: vi.fn(),
  ...over,
});

describe("ClearBlockedModal — a native modal dialog", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    document.body.innerHTML = "";
  });
  const dlg = () => document.body.querySelector("dialog") as HTMLDialogElement | null;
  const btn = (name: string) => [...dlg()!.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;

  it("is not in the page until opened; opening calls showModal() and names the dialog by its heading, with no role or aria-modal of its own", async () => {
    h = mount(<ClearBlockedModal open={false} agentName="Dev" block={block()} onClose={() => {}} />);
    expect(dlg()).toBeNull();
    h.rerender(<ClearBlockedModal open agentName="Dev" block={block()} onClose={() => {}} />);
    await h.flush();
    expect(dlg()!.hasAttribute("open")).toBe(true);
    expect(dlg()!.dataset.modal).toBe("true");
    const heading = dlg()!.querySelector("h1")!;
    expect(heading.textContent).toBe("Clear your conversation with Dev?");
    expect(dlg()!.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(dlg()!.getAttribute("role")).toBeNull();
    expect(dlg()!.getAttribute("aria-modal")).toBeNull();
  });

  it("says what is running: the warning (role=alert), the tasks, the reason; Open Fleet and Close; no Clear button", async () => {
    h = mount(<ClearBlockedModal open agentName="Dev" block={block()} onClose={() => {}} />);
    await h.flush();
    expect(dlg()!.querySelector('[role="alert"]')!.textContent).toBe("Dev has 1 task running from this conversation; wait for it or stop it first.");
    expect(dlg()!.textContent).toContain("Fix the flaky upload test · Ronda · In progress");
    expect(dlg()!.textContent).toContain("Its result comes back to this conversation, so clearing now would lose it. Stop a task from Fleet.");
    expect([...dlg()!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Open Fleet", "Close"]);
  });

  it("Close is the focused choice: it carries autofocus and holds focus once the dialog is shown", async () => {
    h = mount(<ClearBlockedModal open agentName="Dev" block={block()} onClose={() => {}} />);
    await h.flush();
    expect(btn("Close").hasAttribute("autofocus")).toBe(true);
    expect(btn("Open Fleet").hasAttribute("autofocus")).toBe(false);
    expect(document.activeElement).toBe(btn("Close"));
  });

  it("Close closes it and leaves Fleet alone", async () => {
    const onClose = vi.fn();
    const b = block();
    h = mount(<ClearBlockedModal open agentName="Dev" block={b} onClose={onClose} />);
    await h.flush();
    await act(async () => btn("Close").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(b.onOpenFleet).not.toHaveBeenCalled();
  });

  it("Escape (the browser's close with no value) closes it too, once, and Fleet is not opened", async () => {
    const onClose = vi.fn();
    const b = block();
    h = mount(<ClearBlockedModal open agentName="Dev" block={b} onClose={onClose} />);
    await h.flush();
    await act(async () => {
      dlg()!.dispatchEvent(new Event("cancel", { cancelable: true }));
      dlg()!.close(); // what the browser does after a cancel that wasn't prevented
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(b.onOpenFleet).not.toHaveBeenCalled();
  });

  it("Open Fleet closes the dialog and asks for Fleet, once", async () => {
    const onClose = vi.fn();
    const b = block();
    h = mount(<ClearBlockedModal open agentName="Dev" block={b} onClose={onClose} />);
    await h.flush();
    await act(async () => btn("Open Fleet").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(b.onOpenFleet).toHaveBeenCalledTimes(1);
  });

  it("closing because the page said so (open → false) is not a user choice: no onClose, no Fleet", async () => {
    const onClose = vi.fn();
    const b = block();
    h = mount(<ClearBlockedModal open agentName="Dev" block={b} onClose={onClose} />);
    await h.flush();
    h.rerender(<ClearBlockedModal open={false} agentName="Dev" block={b} onClose={onClose} />);
    await h.flush();
    expect(dlg()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(b.onOpenFleet).not.toHaveBeenCalled();
  });

  it("the box's own refusal sentence is shown with a full stop, in place of the counted one", async () => {
    h = mount(<ClearBlockedModal open agentName="Dev" block={block({ tasks: [], refusal: "Dev has 2 tasks running from this conversation; wait for them or stop them first" })} onClose={() => {}} />);
    await h.flush();
    expect(dlg()!.querySelector('[role="alert"]')!.textContent).toBe("Dev has 2 tasks running from this conversation; wait for them or stop them first.");
    expect(dlg()!.querySelector("ul")).toBeNull();
  });
});
