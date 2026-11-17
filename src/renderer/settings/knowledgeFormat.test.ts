import { describe, expect, it } from "vitest";
import type { KnowledgeProjectRow, KnowledgeSettings } from "../../shared/api";
import {
  changeWhere,
  describeSaveError,
  describeUndoFailure,
  formatChangeTime,
  isOverride,
  kindLabel,
  outwardLost,
  statusLines,
} from "./knowledgeFormat";

const row = (over: Partial<KnowledgeProjectRow> = {}): KnowledgeProjectRow => ({
  slug: "manta-0123456789",
  displayName: "manta",
  canonicalId: "github.com/acme/manta",
  repoRules: "box-only",
  sharing: "share-and-read",
  outwardAllowed: true,
  ...over,
});

const settings = (over: Partial<KnowledgeSettings> = {}): KnowledgeSettings => ({
  enabled: true,
  repoRules: "box-only",
  sharing: "share-and-read",
  projects: [],
  ...over,
});

describe("isOverride / outwardLost", () => {
  const defaults = { repoRules: "box-only", sharing: "share-and-read" } as const;
  it("prefers the box's flag", () => {
    expect(isOverride(row({ repoRulesOverride: true }), "repoRules", defaults)).toBe(true);
    expect(isOverride(row({ sharing: "private", sharingOverride: false }), "sharing", defaults)).toBe(false);
  });
  it("infers from the defaults when the box sends no flag", () => {
    expect(isOverride(row(), "repoRules", defaults)).toBe(false);
    expect(isOverride(row({ sharing: "private" }), "sharing", defaults)).toBe(true);
  });
  it("outward is lost only when an outward mode can't be used", () => {
    expect(outwardLost(row({ repoRules: "direct", outwardAllowed: false }))).toBe(true);
    expect(outwardLost(row({ repoRules: "box-only", outwardAllowed: false }))).toBe(false);
    expect(outwardLost(row({ repoRules: "direct", outwardAllowed: true }))).toBe(false);
  });
});

describe("statusLines", () => {
  it("renders nothing for fields the payload doesn't carry", () => {
    expect(statusLines(settings())).toEqual([]);
  });
  it("carries no spend line: the budget is the one-line background-work status", () => {
    expect(statusLines(settings({ spentTodayUsd: 0.31 }))).toEqual([]);
    expect(statusLines(settings({ spentTodayUsd: 9, dailyCapUsd: 1 }))).toEqual([]);
  });
  it("waiting for a capable model, briefing misses and the unavailable reason", () => {
    const lines = statusLines(
      settings({ waitingForCapableModel: true, sessionsWithoutBriefingThisWeek: 3, unavailableReason: "Node 24 is required (node:sqlite)." }),
    );
    expect(lines.map((l) => l.id)).toEqual(["unavailable", "waiting", "briefing"]);
    expect(lines[0].text).toContain("Node 24");
    expect(lines[2].text).toBe("3 sessions started without a briefing this week.");
    expect(statusLines(settings({ sessionsWithoutBriefingThisWeek: 1 }))[0].text).toBe("1 session started without a briefing this week.");
    expect(statusLines(settings({ sessionsWithoutBriefingThisWeek: 0 }))[0].text).toContain("Every session");
    expect(statusLines(settings({ waitingForCapableModel: false }))).toEqual([]);
  });
});

describe("formatChangeTime", () => {
  const now = Date.UTC(2026, 10, 17, 12, 0, 0);
  it("is relative inside a week", () => {
    expect(formatChangeTime(now - 10_000, now)).toBe("just now");
    expect(formatChangeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatChangeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatChangeTime(now - 2 * 86_400_000, now)).toBe("2 d ago");
  });
  it("accepts ISO strings and falls back to a date after a week", () => {
    expect(formatChangeTime(new Date(now - 60_000).toISOString(), now)).toBe("1 min ago");
    expect(formatChangeTime(now - 30 * 86_400_000, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
  it("is empty for an unreadable time", () => {
    expect(formatChangeTime("nope", now)).toBe("");
    expect(formatChangeTime(undefined, now)).toBe("");
  });
});

describe("change labels", () => {
  it("kindLabel prettifies separators", () => {
    expect(kindLabel("skipped-cap_reached")).toBe("skipped cap reached");
  });
  it("changeWhere names the project, or falls back to the slug", () => {
    const projects = [row()];
    expect(changeWhere({ area: "project", slug: "manta-0123456789" }, projects)).toBe("Project: manta");
    expect(changeWhere({ area: "project", slug: "gone-aaaaaaaaaa" }, projects)).toBe("Project: gone-aaaaaaaaaa");
    expect(changeWhere({ area: "user" }, projects)).toBe("Your preferences");
    expect(changeWhere({ area: "repo-block", slug: "manta-0123456789" }, projects)).toBe("Repo rules · manta");
    expect(changeWhere({ area: "weird" }, projects)).toBe("weird");
  });
});

describe("error sentences", () => {
  it("names the conflicting later change", () => {
    expect(describeUndoFailure({ ok: false, reason: "a later commit changed it", conflictWith: "d_01ABC" })).toBe(
      "Couldn't undo: a later commit changed it. A later change depends on it (d_01ABC); undo that one first.",
    );
    expect(describeUndoFailure({ ok: false, reason: " " })).toBe("Couldn't undo: the box refused.");
  });
  it("maps invalid-setting and passes other messages through", () => {
    expect(describeSaveError(new Error("invalid-setting"))).toBe("The box rejected that value.");
    expect(describeSaveError(new Error("HTTP 500"))).toBe("HTTP 500");
    expect(describeSaveError(undefined)).toBe("Something went wrong.");
  });
});
