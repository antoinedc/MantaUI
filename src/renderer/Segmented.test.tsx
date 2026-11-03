// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { Segmented } from "./Segmented";

const OPTIONS = [
  { id: "rendered", label: "Rendered" },
  { id: "source", label: "Source" },
] as const;

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
});

const button = (name: string) =>
  Array.from(h!.container.querySelectorAll("button")).find((b) => b.textContent === name)!;
const pills = () => h!.container.querySelectorAll("[data-segmented-pill]");

describe("Segmented", () => {
  it("renders exactly one pill, inside the active button", () => {
    h = mount(<Segmented label="View" options={OPTIONS} value="rendered" onChange={() => {}} />);
    expect(pills()).toHaveLength(1);
    expect(pills()[0].closest("button")).toBe(button("Rendered"));
    expect(pills()[0].className).toContain("bg-raised");
  });

  it("moves the pill to the newly active button and keeps one pill", () => {
    h = mount(<Segmented label="View" options={OPTIONS} value="rendered" onChange={() => {}} />);
    h.rerender(<Segmented label="View" options={OPTIONS} value="source" onChange={() => {}} />);
    expect(pills()).toHaveLength(1);
    expect(pills()[0].closest("button")).toBe(button("Source"));
  });

  it("keeps aria-pressed and onChange behaviour", () => {
    const onChange = vi.fn();
    h = mount(<Segmented label="View" options={OPTIONS} value="rendered" onChange={onChange} />);
    expect(button("Rendered").getAttribute("aria-pressed")).toBe("true");
    expect(button("Source").getAttribute("aria-pressed")).toBe("false");
    act(() => button("Source").click());
    expect(onChange).toHaveBeenCalledWith("source");
  });
});
