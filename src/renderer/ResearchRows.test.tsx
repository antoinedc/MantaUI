// @vitest-environment jsdom
//
// The one rendering of library entries (agent screens spec §2.5 / contract): topic, sources · age, fresh / stale / thin.

import { afterEach, describe, expect, it } from "vitest";
import type { AgentResearchEntry } from "../shared/types";
import { ResearchRows } from "./ResearchRows";
import { mount, type Harness } from "./testHarness";

const entry = (over: Partial<AgentResearchEntry> = {}): AgentResearchEntry => ({
  id: "r1",
  topic: "Technical SEO for AI search",
  sourceCount: 5,
  ageDays: 3,
  status: "fresh",
  thin: false,
  ...over,
});

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
});
const rows = () => [...h!.container.querySelectorAll('[data-testid="research-row"]')] as HTMLElement[];

describe("ResearchRows", () => {
  it("shows topic, sources and age, with a fresh pill", () => {
    h = mount(<ResearchRows entries={[entry()]} />);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("Technical SEO for AI search");
    expect(rows()[0].textContent).toContain("5 sources · 3 days old");
    expect(rows()[0].textContent).toContain("fresh");
    expect(rows()[0].textContent).not.toContain("thin");
  });

  it("marks stale and thin entries, and reads today / one day / one source", () => {
    h = mount(
      <ResearchRows
        entries={[
          entry({ id: "a", status: "stale", ageDays: 41, sourceCount: 4 }),
          entry({ id: "b", thin: true, ageDays: 0, sourceCount: 1 }),
          entry({ id: "c", ageDays: 1, sourceCount: 3 }),
        ]}
      />,
    );
    const [a, b, c] = rows();
    expect(a.textContent).toContain("41 days old");
    expect(a.textContent).toContain("stale");
    expect(b.textContent).toContain("1 source · today");
    expect(b.textContent).toContain("fresh");
    expect(b.textContent).toContain("thin");
    // "thin" is a caution, so it wears the warn tone (like stale), not the neutral outline next to green "fresh"
    const thin = [...b.querySelectorAll("span")].find((e) => e.textContent === "thin")!;
    expect(thin.className).toContain("bg-warn-bg");
    expect(thin.className).not.toContain("border");
    expect(c.textContent).toContain("3 sources · 1 day old");
  });

  it("a missing entry says it is no longer in the library, with no freshness claim", () => {
    h = mount(<ResearchRows entries={[entry({ status: "missing", sourceCount: null, ageDays: null })]} />);
    expect(rows()[0].textContent).toContain("no longer in the library");
    expect(rows()[0].textContent).not.toContain("fresh");
    expect(rows()[0].textContent).not.toContain("sources");
  });

  it("an empty list says so; the text can be set", () => {
    h = mount(<ResearchRows entries={[]} />);
    expect(h.text()).toContain("None yet");
    h.rerender(<ResearchRows entries={[]} emptyText="Nothing yet" />);
    expect(h.text()).toContain("Nothing yet");
  });

  it("limits the rows when asked", () => {
    h = mount(<ResearchRows entries={[entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })]} limit={2} />);
    expect(rows()).toHaveLength(2);
  });
});
