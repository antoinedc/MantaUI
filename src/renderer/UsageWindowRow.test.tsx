// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { UsageWindowRow } from "./UsageDial";
import type { UsageWindow } from "../shared/types";

const render = (w: UsageWindow) =>
  renderToStaticMarkup(createElement(UsageWindowRow, { usageWindow: w, nowMs: 1_800_000_000_000 }));

describe("UsageWindowRow", () => {
  it("an inactive window is greyed and says 'not active' instead of a percentage", () => {
    const html = render({ kind: "weekly_scoped:fable", label: "7d · Fable", pct: 100, scope: "Fable", active: false });
    expect(html).toContain("not active");
    expect(html).toContain("7d · Fable");
    expect(html).toContain('data-inactive="true"');
    expect(html).not.toContain("100%");
    expect(html).toContain("width:0%");
  });

  it("an ordinary window is unchanged", () => {
    const html = render({ kind: "session", label: "5h", pct: 42 });
    expect(html).toContain("42%");
    expect(html).not.toContain("not active");
    expect(html).not.toContain("data-inactive");
  });
});
