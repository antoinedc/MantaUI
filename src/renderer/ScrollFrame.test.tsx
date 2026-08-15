// @vitest-environment jsdom
//
// ScrollFrame is the shared "capped list" scroll treatment (BET-944
// follow-up): a flex column capped at maxHeight whose body scrolls while
// header and footer stay pinned. This pins the one invariant that was broken
// independently in CloneFromGitHub and NewSessionScreen — the body must live
// in an overflow container that EXCLUDES the header/footer, so a long list
// scrolls and the action button never gets pushed off-screen.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScrollFrame } from "./ScrollFrame";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

function mount(children: React.ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(children);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  if (container) {
    container.remove();
    container = null;
  }
});

describe("ScrollFrame", () => {
  it("renders children in an overflow-y-auto container that excludes header and footer", () => {
    mount(
      <ScrollFrame
        header={<div id="my-header" />}
        footer={<div id="my-footer" />}
      >
        <li id="row-a" />
        <li id="row-b" />
      </ScrollFrame>,
    );

    const scroller = container!.querySelector<HTMLElement>(".overflow-y-auto");
    expect(scroller).toBeTruthy();

    // The rows live inside the scroller…
    expect(scroller!.contains(container!.querySelector("#row-a")!)).toBe(true);
    expect(scroller!.contains(container!.querySelector("#row-b")!)).toBe(true);

    // …but the header and footer are pinned OUTSIDE it.
    expect(scroller!.contains(container!.querySelector("#my-header")!)).toBe(false);
    expect(scroller!.contains(container!.querySelector("#my-footer")!)).toBe(false);

    // The column carries the height cap + the flex rules the body needs to
    // shrink (without it, overflow-y:auto silently does nothing).
    const col = scroller!.parentElement!;
    expect(col.classList.contains("max-h-[70vh]")).toBe(true);
    expect(col.classList.contains("flex")).toBe(true);
    expect(col.classList.contains("flex-col")).toBe(true);
    expect(scroller!.classList.contains("flex-1")).toBe(true);
    expect(scroller!.classList.contains("min-h-0")).toBe(true);
  });

  it("honors a custom maxHeight and forwards className/bodyClassName", () => {
    mount(
      <ScrollFrame
        maxHeight="max-h-[50vh]"
        className="p-4"
        bodyClassName="mt-1"
      >
        <div id="row" />
      </ScrollFrame>,
    );
    const scroller = container!.querySelector<HTMLElement>(".overflow-y-auto")!;
    const col = scroller!.parentElement!;
    expect(col.classList.contains("max-h-[50vh]")).toBe(true);
    expect(col.classList.contains("max-h-[70vh]")).toBe(false);
    expect(col.classList.contains("p-4")).toBe(true);
    expect(scroller.classList.contains("mt-1")).toBe(true);
  });

  it("renders with no header or footer when omitted", () => {
    mount(<ScrollFrame><div id="only" /></ScrollFrame>);
    const scroller = container!.querySelector<HTMLElement>(".overflow-y-auto")!;
    expect(scroller.contains(container!.querySelector("#only")!)).toBe(true);
    // No stray pinned header/footer wrappers.
    expect(container!.querySelectorAll(".shrink-0").length).toBe(0);
  });
});
