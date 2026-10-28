import { describe, it, expect } from "vitest";
import { groupByDay, type Artifact } from "./artifacts";

// Derivation lives on the box now (src/server/artifacts.test.mjs). The renderer
// only groups the box's list by day in the device's timezone.

function fileArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "id",
    kind: "file",
    origin: "agent",
    label: "report.txt",
    href: "/home/u/report.txt",
    mime: "text/plain",
    size: null,
    at: 2000,
    messageId: null,
    context: null,
    isHosted: false,
    expiry: null,
    plan: null,
    ...overrides,
  };
}

const img = (href: string, at: number) => fileArtifact({ kind: "image", href, label: href, at });

describe("groupByDay", () => {
  // now = Wed 5 Aug 2026, 12:00 local
  const now = new Date(2026, 7, 5, 12, 0, 0).getTime();
  const today = new Date(2026, 7, 5, 9, 0).getTime();
  const yesterday = new Date(2026, 7, 4, 9, 0).getTime();
  const older = new Date(2026, 7, 3, 9, 0).getTime();

  it("groups Today / Yesterday / older with item order preserved and newest first", () => {
    // The older-group label follows the OS locale (Intl), so derive the
    // expectation rather than hardcoding an en-US string.
    const olderLabel = new Intl.DateTimeFormat(undefined, {
      weekday: "short", day: "numeric", month: "short",
    }).format(older);
    const out = groupByDay(
      [img("/a/today2", today + 1000), img("/a/older", older), img("/a/today1", today), img("/a/yest", yesterday)],
      now,
    );
    expect(out.map((g) => g.label)).toEqual(["Today", "Yesterday", olderLabel]);
    expect(out[0].items.map((a) => a.href)).toEqual(["/a/today2", "/a/today1"]);
    expect(out[1].items.map((a) => a.href)).toEqual(["/a/yest"]);
    expect(out[2].items.map((a) => a.href)).toEqual(["/a/older"]);
    expect(out[2].label).toContain("3");
  });

  it("empty input → empty groups", () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});
