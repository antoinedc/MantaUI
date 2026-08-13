// @vitest-environment jsdom
//
// Component tests for MarkdownBody's table rendering.
//
// GFM's grammar makes a header row MANDATORY: the `|---|---|` delimiter line is
// what promotes the block to a table at all. So the natural markdown for "a
// grid of labelled rows with no column titles" — a blank first row — does not
// yield a header-less table, it yields a table with an EMPTY header, which
// rendered as a blank bordered strip above the data. These pin the drop rule
// and, just as importantly, that a real header still renders.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { MarkdownBody } from "./MarkdownBody";

describe("MarkdownBody tables", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("drops the header when every header cell is blank", () => {
    h = mount(
      <MarkdownBody
        text={["|  |  |", "|---|---|", "| In progress | BET-708 |", "| Queue | BET-700 |"].join("\n")}
      />,
    );
    expect(h.container.querySelector("table")).not.toBeNull();
    expect(h.container.querySelector("thead")).toBeNull();
    // The data rows survive — this drops the empty header, not the table.
    expect(h.container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(h.container.textContent).toContain("BET-708");
  });

  it("keeps a real header", () => {
    h = mount(
      <MarkdownBody text={["| Lane | Work |", "|---|---|", "| Queue | BET-700 |"].join("\n")} />,
    );
    expect(h.container.querySelector("thead")).not.toBeNull();
    expect(h.container.querySelector("thead")?.textContent).toContain("Lane");
  });

  it("keeps a partially-filled header — one labelled column is still a header", () => {
    h = mount(
      <MarkdownBody text={["| Lane |  |", "|---|---|", "| Queue | BET-700 |"].join("\n")} />,
    );
    expect(h.container.querySelector("thead")).not.toBeNull();
  });
});
