import { describe, expect, it } from "vitest";
import type { StoppedRecord, UsageSnapshot } from "../shared/types";
import {
  extractLastSnippet,
  groupStoppedByWorkspace,
  isNewStopped,
  resetAtFor,
  resumeCost,
  resumeCosts,
  selectionSummary,
  shouldShowStoppedMarker,
  unarmedStoppedCount,
} from "./usageResume";

const rec = (partial: Partial<StoppedRecord> = {}): StoppedRecord => ({
  workspace: "manta",
  conversation: "ses_a",
  provider: "claude",
  model: "claude-sonnet-4-6",
  window: "weekly",
  stoppedAt: 1000,
  cachedTokens: 50000,
  armed: false,
  attempts: 1,
  ...partial,
});

const snap = (partial: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  provider: "claude",
  providerIDs: ["anthropic"],
  windows: [{ kind: "weekly", label: "Weekly", pct: 100, resetsAt: 2000 }],
  fetchedAt: 100,
  ...partial,
});

describe("unarmedStoppedCount", () => {
  it("counts only conversations not yet armed", () => {
    expect(unarmedStoppedCount([rec(), rec({ conversation: "b", armed: true })])).toBe(1);
    expect(unarmedStoppedCount([rec({ armed: true }), rec({ conversation: "b", armed: true })])).toBe(0);
    expect(unarmedStoppedCount([])).toBe(0);
  });
});

describe("resetAtFor", () => {
  it("finds the matching provider window reset", () => {
    const s = snap();
    expect(resetAtFor(rec(), [s])).toBe(2000);
  });
  it("returns undefined when the provider is not reporting", () => {
    expect(resetAtFor(rec({ provider: "kimi" }), [snap()])).toBeUndefined();
  });
  it("returns undefined when the record named no window", () => {
    expect(resetAtFor(rec({ window: null }), [snap()])).toBeUndefined();
  });
});

describe("resumeCost — warm vs cold either side of the cache window", () => {
  const ttlMs = 60 * 60_000; // 1h
  // reset at now + 30m → inside the window → warm → 0
  it("is zero when the reset falls inside the prompt-cache window", () => {
    expect(resumeCost(rec(), 90_000, 0, ttlMs)).toBe(0);
  });
  it("is at most the cached tokens exactly at the window edge (inclusive)", () => {
    // reset - now === ttlMs → inside the window → warm
    expect(resumeCost(rec(), ttlMs, 0, ttlMs)).toBe(0);
  });
  it("charges the re-read tokens once the reset is past the cache window", () => {
    expect(resumeCost(rec(), ttlMs + 1, 0, ttlMs)).toBe(50000);
  });
  it("treats an unknown reset as cold", () => {
    expect(resumeCost(rec(), undefined, 0, ttlMs)).toBe(50000);
  });
  it("defaults to 0 when the record carries no cached-token count", () => {
    expect(resumeCost(rec({ cachedTokens: undefined }), undefined, 0, ttlMs)).toBe(0);
  });
});

describe("resumeCosts", () => {
  it("maps conversation → cost", () => {
    const costs = resumeCosts([rec(), rec({ conversation: "b", window: null })], [snap()], 0, 60 * 60_000);
    expect(costs.get("ses_a")).toBe(0); // warm (reset inside window)
    expect(costs.get("b")).toBe(50000); // cold (no window → re-read)
  });
});

describe("selectionSummary", () => {
  const records = [rec(), rec({ conversation: "b" }), rec({ conversation: "c" })];
  const costs = new Map([["ses_a", 0], ["b", 100], ["c", 200]]);

  it("counts selection and batch total", () => {
    expect(selectionSummary(records, new Set(["ses_a", "c"]), costs)).toMatchObject({
      totalCount: 3,
      selectedCount: 2,
      batchTotal: 200,
      allSelected: false,
    });
  });
  it("check/uncheck all — allSelected flips", () => {
    expect(selectionSummary(records, new Set(records.map((r) => r.conversation)), costs).allSelected).toBe(true);
    expect(selectionSummary(records, new Set(), costs)).toMatchObject({
      selectedCount: 0,
      batchTotal: 0,
      allSelected: false,
    });
  });
});

describe("isNewStopped — badge boundary against last-looked", () => {
  it("new when stopped after the last-looked stamp", () => {
    expect(isNewStopped(rec({ stoppedAt: 5000 }), 4000)).toBe(true);
  });
  it("not new when stopped at or before the last-looked stamp", () => {
    expect(isNewStopped(rec({ stoppedAt: 3000 }), 3000)).toBe(false);
    expect(isNewStopped(rec({ stoppedAt: 2000 }), 3000)).toBe(false);
  });
  it("everything is new when there is no stamp (never looked)", () => {
    expect(isNewStopped(rec({ stoppedAt: 1 }), null)).toBe(true);
  });
});

describe("shouldShowStoppedMarker — precedence over a pending question/permission", () => {
  it("shows the stopped marker when merely stopped", () => {
    expect(shouldShowStoppedMarker(true, false)).toBe(true);
  });
  it("a pending question/permission outranks the stopped marker", () => {
    expect(shouldShowStoppedMarker(true, true)).toBe(false);
  });
  it("no marker when not stopped", () => {
    expect(shouldShowStoppedMarker(false, false)).toBe(false);
  });
});

describe("extractLastSnippet", () => {
  const msg = (role: "user" | "assistant", text: string) => ({
    info: { id: `m_${role}`, sessionID: "ses_a", role },
    parts: [{ type: "text", id: `p_${role}`, messageID: "x", text }],
  });
  it("returns the last assistant text, truncated", () => {
    expect(extractLastSnippet([msg("user", "hi"), msg("assistant", "short")])).toBe("short");
  });
  it("skips trailing non-text assistant parts and truncates long text", () => {
    const long = "a".repeat(120);
    expect(extractLastSnippet([msg("assistant", long)])).toBe("a".repeat(90) + "…");
  });
  it("returns null when there is no assistant text", () => {
    expect(extractLastSnippet([msg("user", "hi")])).toBeNull();
    expect(extractLastSnippet(null)).toBeNull();
    expect(extractLastSnippet([])).toBeNull();
  });
});

describe("groupStoppedByWorkspace", () => {
  it("groups by workspace with most-recently-stopped first, preserving workspace order", () => {
    const records = [
      rec({ conversation: "a", stoppedAt: 10 }),
      rec({ conversation: "b", workspace: "ethernal", stoppedAt: 99 }),
      rec({ conversation: "c", stoppedAt: 50 }),
    ];
    const groups = groupStoppedByWorkspace(records);
    expect(groups.map((g) => g.workspace)).toEqual(["manta", "ethernal"]);
    expect(groups[0].rows.map((r) => r.conversation)).toEqual(["c", "a"]);
    expect(groups[1].rows.map((r) => r.conversation)).toEqual(["b"]);
  });
});
