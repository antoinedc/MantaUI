// @vitest-environment jsdom
//
// Regression test for the diff highlight truncating on horizontal scroll.
//
// The diff renders inside an OutputWell, which is the `overflow-x-auto`
// scroller. The rows are block-level children of an inner wrapper, so the
// wrapper's width is what decides how far a +/− row's colored background
// reaches. When the wrapper was `max-w-full`, that width was the well's
// VISIBLE width: scrolling right ran off the end of the green/red block and
// the rest of the line sat on the bare well background.
//
// The wrapper must therefore size to the widest line (`w-max`) while still
// filling the well for short diffs (`min-w-full`). jsdom does no layout, so
// this asserts the contract at the class level — which is exactly where the
// bug lived.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { UnifiedDiff, diffLineNumbers } from "./ToolBodies";

const DIFF = [
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1,3 +1,3 @@",
  " const short = 1;",
  "-const removed = 2;",
  "+const added = 'a very long replacement line that overflows the well horizontally';",
].join("\n");

describe("UnifiedDiff", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // The wrapper the rows live in — the well is the scroller, its only child
  // is the rows wrapper.
  function rowsWrapper(): HTMLElement {
    const well = h!.container.firstElementChild as HTMLElement;
    return well.firstElementChild as HTMLElement;
  }

  function rows(): HTMLElement[] {
    return Array.from(rowsWrapper().children) as HTMLElement[];
  }

  it("sizes the rows wrapper to the widest line so backgrounds span the full scroll width", () => {
    h = mount(<UnifiedDiff text={DIFF} />);
    const cls = rowsWrapper().className;
    expect(cls).toContain("w-max");
    expect(cls).toContain("min-w-full");
    // The regression: clamping to the viewport is what cut the highlight off.
    expect(cls).not.toContain("max-w-full");
  });

  it("puts the background on the row itself, so it fills the wrapper's width", () => {
    h = mount(<UnifiedDiff text={DIFF} />);
    const [context, removed, added] = rows();
    expect(added.className).toContain("bg-[var(--diff-add)]");
    expect(removed.className).toContain("bg-[var(--diff-del)]");
    expect(context.className).not.toContain("bg-[var(--diff-");
    // Every row is a full-width block flex row — none of them is inline or
    // shrink-to-fit, which would re-introduce a short background.
    for (const r of rows()) {
      expect(r.className).toContain("flex");
      expect(r.className).not.toContain("inline");
      expect(r.className).not.toContain("w-max");
    }
  });

  it("still drops file markers and hunk headers", () => {
    h = mount(<UnifiedDiff text={DIFF} />);
    expect(rows()).toHaveLength(3);
    expect(h.text()).not.toContain("@@");
    expect(h.text()).not.toContain("a/file.ts");
  });
});

// WS05: line numbers come from the same parser the box uses (`parsePatch`).
describe("diffLineNumbers", () => {
  const TWO_HUNKS = [
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old1",
    "+new1",
    "@@ -20,3 +30,4 @@",
    " ctx",
    "-gone",
    "+added",
    "+++ heading",
    " tail",
  ].join("\n");

  it("numbers removals by old line and additions / context by new line across hunks", () => {
    const nums = diffLineNumbers(TWO_HUNKS);
    // [---, +++, @@, keep, -old1, +new1, @@, ctx, -gone, +added, +++ heading, tail]
    expect(nums).toEqual([null, null, null, 1, 2, 2, null, 30, 21, 31, 32, 33]);
  });

  it("renders the added `+++ heading` line as content with the right number", () => {
    const hh = mount(<UnifiedDiff text={TWO_HUNKS} />);
    const text = hh.text();
    expect(text).toContain("++ heading");
    const rows = Array.from((hh.container.firstElementChild!.firstElementChild as HTMLElement).children) as HTMLElement[];
    const heading = rows.find((r) => r.textContent?.includes("++ heading"))!;
    expect(heading.textContent).toContain("32");
    expect(heading.className).toContain("bg-[var(--diff-add)]");
    hh.unmount();
  });

  it("numbers bare hunks that have no file headers", () => {
    expect(diffLineNumbers("@@ -5,2 +5,2 @@\n a\n-b\n+c")).toEqual([null, 5, 6, 6]);
  });

  it("returns no numbers (and never throws) for text the parser rejects or with no hunks", () => {
    expect(diffLineNumbers("@@ -1,2 +1,3 @@\n only\n+x")).toEqual([null, null, null]);
    expect(diffLineNumbers("just some --- text\nwith no hunks")).toEqual([null, null]);
    const orphan = mount(<UnifiedDiff text={"--- a\n+++ b\n+orphan line"} />);
    expect(orphan.text()).toContain("orphan line");
    orphan.unmount();
  });
});
