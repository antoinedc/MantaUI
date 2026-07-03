// sessionList.test.ts — raw `tmux:list` JSON → FlatList view model (pure):
// title, status, chat/terminal kind; grouping; defensive against bad shapes.

import { describe, expect, it } from "vitest";

import { mapSessionRows, mapSessionSections } from "../sessionList";

const RAW = [
  {
    tmuxSession: "better-ui",
    windows: [
      { index: 0, name: "main", opencodeSessionId: "sess_abc" },
      { index: 1, name: "term", opencodeSessionId: null },
    ],
  },
  {
    tmuxSession: "relay",
    windows: [{ index: 0, name: "server", opencodeSessionId: "sess_def" }],
  },
];

describe("mapSessionRows", () => {
  it("maps title, kind, and stable key", () => {
    const rows = mapSessionRows(RAW);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      key: "better-ui:0",
      project: "better-ui",
      windowIndex: 0,
      title: "main",
      kind: "chat",
      status: "idle",
    });
    expect(rows[1]).toMatchObject({ key: "better-ui:1", title: "term", kind: "terminal" });
    expect(rows[2]).toMatchObject({ key: "relay:0", title: "server", kind: "chat" });
  });

  it("defaults every row to idle when no status map is given", () => {
    for (const r of mapSessionRows(RAW)) expect(r.status).toBe("idle");
  });

  it("applies running status from the status map by session+windowIndex", () => {
    const rows = mapSessionRows(RAW, {
      "better-ui": { 0: true, 1: false },
      relay: { 0: true },
    });
    expect(rows.find((r) => r.key === "better-ui:0")?.status).toBe("running");
    expect(rows.find((r) => r.key === "better-ui:1")?.status).toBe("idle");
    expect(rows.find((r) => r.key === "relay:0")?.status).toBe("running");
  });

  it("is defensive: bad shapes yield an empty list, never throw", () => {
    for (const bad of [null, undefined, 42, "nope", {}, [{}], [{ tmuxSession: "" }]]) {
      expect(() => mapSessionRows(bad)).not.toThrow();
      expect(mapSessionRows(bad)).toEqual([]);
    }
  });

  it("skips malformed windows but keeps valid siblings", () => {
    const rows = mapSessionRows([
      {
        tmuxSession: "p",
        windows: [
          { index: 0, name: "ok" },
          { name: "no-index" },
          null,
          { index: 2, name: 99 },
          { index: 3, name: "ok2", opencodeSessionId: "s" },
        ],
      },
    ]);
    expect(rows.map((r) => r.title)).toEqual(["ok", "ok2"]);
  });

  it("treats a project with no windows array as empty", () => {
    expect(mapSessionRows([{ tmuxSession: "p" }])).toEqual([]);
    expect(mapSessionRows([{ tmuxSession: "p", windows: null }])).toEqual([]);
  });
});

describe("mapSessionSections", () => {
  it("groups rows by project, preserving order", () => {
    const sections = mapSessionSections(RAW);
    expect(sections.map((s) => s.project)).toEqual(["better-ui", "relay"]);
    expect(sections[0].rows).toHaveLength(2);
    expect(sections[1].rows).toHaveLength(1);
  });
});
