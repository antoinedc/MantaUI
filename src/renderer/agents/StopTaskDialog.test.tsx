// @vitest-environment jsdom
//
// The Stop confirmation is a native <dialog> opened with showModal(): "Keep running" is the focused (autofocus) choice, Esc and
// Keep running both leave the task alone, and only "Stop task" reports a stop. jsdom has no showModal / close: the polyfill below
// does what the browser does (open attribute, returnValue, a `close` event) so the component's own wiring is what is under test.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "../testHarness";
import { StopTaskDialog } from "./StopTaskDialog";

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
    this.dataset.modal = "true";
  };
  proto.close = function (this: HTMLDialogElement, value?: string) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    if (value !== undefined) this.returnValue = value;
    this.dispatchEvent(new Event("close"));
  };
});

describe("StopTaskDialog", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  const dlg = () => h!.container.querySelector("dialog") as HTMLDialogElement;
  const btn = (name: string) => [...dlg().querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;

  it("is closed until asked; opening it shows the task's title and a native modal, named by its heading", async () => {
    const onClose = vi.fn();
    h = mount(<StopTaskDialog open={false} title="Fix the build" onClose={onClose} />);
    expect(dlg().hasAttribute("open")).toBe(false);
    h.rerender(<StopTaskDialog open title="Fix the build" onClose={onClose} />);
    await h.flush();
    expect(dlg().hasAttribute("open")).toBe(true);
    expect(dlg().dataset.modal).toBe("true");
    expect(dlg().textContent).toContain("Fix the build");
    const heading = dlg().querySelector("h1")!;
    expect(dlg().getAttribute("aria-labelledby")).toBe(heading.id);
    expect(dlg().getAttribute("role")).toBeNull(); // the native modal carries the role itself
  });

  it("Keep running is the autofocus choice and reports no stop", async () => {
    const onClose = vi.fn();
    h = mount(<StopTaskDialog open title="Fix the build" onClose={onClose} />);
    await h.flush();
    expect(btn("Keep running").hasAttribute("autofocus")).toBe(true);
    expect(btn("Stop task").hasAttribute("autofocus")).toBe(false);
    await act(async () => btn("Keep running").click());
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("Stop task reports a stop, once; the next time the dialog opens it has forgotten that answer", async () => {
    const onClose = vi.fn();
    h = mount(<StopTaskDialog open title="Fix the build" onClose={onClose} />);
    await h.flush();
    await act(async () => btn("Stop task").click());
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    expect(dlg().returnValue).toBe("");
    h.rerender(<StopTaskDialog open={false} title="Fix the build" onClose={onClose} />);
    h.rerender(<StopTaskDialog open title="Fix the build" onClose={onClose} />);
    await h.flush();
    await act(async () => dlg().dispatchEvent(new Event("close"))); // Esc: no value
    expect(onClose).toHaveBeenLastCalledWith(false);
  });

  it("closing the page while it is open closes the dialog without reporting anything", async () => {
    const onClose = vi.fn();
    h = mount(<StopTaskDialog open title="Fix the build" onClose={onClose} />);
    await h.flush();
    h.rerender(<StopTaskDialog open={false} title="Fix the build" onClose={onClose} />);
    await h.flush();
    expect(dlg().hasAttribute("open")).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});
