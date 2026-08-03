// @vitest-environment jsdom
//
// Component tests for the OutputWell chrome primitive (BET-636).
//
// Asserts the recessed mono surface in both variants plus the maxHeight cap.
// The two adopters (ToolBodies.tsx for the tool output/diff, Cards.tsx for the
// permission ask command) render through the real exported component.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { OutputWell } from "./OutputWell";

const SHARED =
  "bg-inset text-[12.5px] leading-[1.55] font-mono overflow-x-auto whitespace-pre";
const ATTACHED = "border-t border-border-subtle px-3 py-2";
const STANDALONE = "border border-border-subtle rounded-md px-3 py-[9px] text-text";
const MAX = "max-h-64 overflow-y-auto";

describe("OutputWell", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function root(): HTMLElement {
    const el = h!.container.firstElementChild as HTMLElement;
    expect(el).toBeTruthy();
    return el;
  }

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — OutputWell must NOT accept className (M527 decision 3)
    void <OutputWell variant="attached" className="bg-red-500">x</OutputWell>;
    expect(true).toBe(true);
  });

  it("renders the attached variant (top border only, no radius) and children", () => {
    h = mount(<OutputWell variant="attached">cmd</OutputWell>);
    expect(root().className).toBe(`${SHARED} ${ATTACHED}`);
    expect(root().textContent).toBe("cmd");
  });

  it("renders the standalone variant (full border + radius + text foreground)", () => {
    h = mount(<OutputWell variant="standalone">cmd</OutputWell>);
    expect(root().className).toBe(`${SHARED} ${STANDALONE}`);
  });

  it("adds the max-height scroll cap when maxHeight is set", () => {
    h = mount(<OutputWell variant="attached" maxHeight>body</OutputWell>);
    expect(root().className).toBe(`${SHARED} ${ATTACHED} ${MAX}`);
  });

  it("omits the max-height cap by default", () => {
    h = mount(<OutputWell variant="standalone">body</OutputWell>);
    expect(root().className).not.toContain(MAX);
  });
});
