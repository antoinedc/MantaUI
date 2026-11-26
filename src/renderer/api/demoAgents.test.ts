// The "agents" demo state is what the agents-* pixel baselines draw, so its data has to tell one consistent story.

import { describe, expect, it } from "vitest";
import { changeAuthor, changedLineCount, diffRows } from "../agentChange.js";
import { demoFleet, demoHistory, demoNeedsYou } from "./demoAgents.js";

const NOW = Date.UTC(2025, 9, 20, 12);

describe("demoAgents", () => {
  it("the SEO pending change's diff is the one its summary describes: one rule added, two crawler rules dropped", () => {
    const pending = demoHistory(NOW).find((c) => c.state === "pending")!;
    expect(pending.slug).toBe("seo");
    expect(pending.summary).toBe("Adds an llms.txt check and drops 2 crawler rules that no longer hold.");
    const rows = diffRows(pending.before ?? "", pending.after).filter((r) => r.kind === "add" || r.kind === "del");
    expect(rows.filter((r) => r.kind === "add").map((r) => (r as { text: string }).text)).toEqual(["- Check that llms.txt is served at the site root and lists the key pages."]);
    expect(rows.filter((r) => r.kind === "del").map((r) => (r as { text: string }).text)).toEqual(["- Block GPTBot in robots.txt on staging only.", "- Block CCBot in robots.txt on every host."]);
    expect(changedLineCount(pending)).toBe(3);
    expect(changeAuthor(pending)).toBe("Architect");
  });

  it("the pending change says what it rests on, so the folded card has a 'based on' to show", () => {
    expect(demoHistory(NOW).find((c) => c.state === "pending")!.evidence.length).toBeGreaterThan(0);
  });

  it("Needs you holds only what the rules let in: each review item says why, and a decision is marked as one", () => {
    const ny = demoNeedsYou(NOW);
    expect(ny.reviews.length).toBeGreaterThan(0);
    for (const r of ny.reviews) expect(r.reason).toMatch(/^(Needs a decision|Branch ready to merge · \d+ files?)$/);
    expect(ny.count).toBe(ny.questions.length + ny.changes.length + ny.reviews.length);
  });

  it("a needs-you cell in the grid reads like the list's reason", () => {
    const cells = demoFleet(NOW).rows.flatMap((r) => Object.values(r.cells)).filter((c) => c?.state === "needs-you");
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c!.detail).toMatch(/^(Needs a decision|Branch ready to merge · \d+ files?)$/);
  });

  it("the recap tells the new things: Manta-handed work in one line, and its unmerged branches", () => {
    const lines = demoFleet(NOW).recap.lines;
    expect(lines.some((l) => /finished \d+ tasks? Manta handed off$/.test(l))).toBe(true);
    expect(lines.some((l) => /branch(es)? from .*Manta-handed.* still unmerged$/.test(l))).toBe(true);
  });
});
