// Pure tests for the tool-activity module: wording, run summaries, transcript
// layout (cross-message grouping) and layout stabilization.

import { describe, it, expect } from "vitest";
import type { OpencodeMessage, OpencodePart } from "../shared/types";
import {
  describeActivity,
  groupTone,
  isRenderableRow,
  layoutTranscript,
  stabilizeLayout,
  summarizeToolGroup,
  type Block,
} from "./toolActivity";

let n = 0;
function tool(
  name: string,
  input: Record<string, unknown> = {},
  status: string = "completed",
  extra: Record<string, unknown> = {},
): OpencodePart {
  return {
    id: `t${++n}`,
    messageID: "m",
    type: "tool",
    tool: name,
    state: { status, input, ...extra },
  } as OpencodePart;
}
const text = (t: string): OpencodePart =>
  ({ id: `x${++n}`, messageID: "m", type: "text", text: t }) as OpencodePart;
const reasoning = (t: string): OpencodePart =>
  ({ id: `r${++n}`, messageID: "m", type: "reasoning", text: t }) as OpencodePart;
const patch = (files: string[]): OpencodePart =>
  ({ id: `p${++n}`, messageID: "m", type: "patch", files }) as OpencodePart;

function msg(id: string, role: "user" | "assistant", parts: OpencodePart[]): OpencodeMessage {
  return {
    info: { id, sessionID: "s", role, time: { created: 1 } },
    parts,
  } as unknown as OpencodeMessage;
}
const user = (id: string, t = "hi") => msg(id, "user", [text(t)]);
const asst = (id: string, parts: OpencodePart[]) => msg(id, "assistant", parts);

const OPTS = { running: false, showThinking: false };

describe("describeActivity", () => {
  it("labels read / edit / write by basename in each tense", () => {
    const r = describeActivity(tool("read", { filePath: "/a/b/Transcript.tsx" }));
    expect([r.running, r.done, r.failed]).toEqual([
      "Reading Transcript.tsx",
      "Read Transcript.tsx",
      "Failed to read Transcript.tsx",
    ]);
    const e = describeActivity(tool("MultiEdit", { filePath: "x/y.ts" }, "running"));
    expect(e.label).toBe("Editing y.ts");
    expect(describeActivity(tool("apply_patch", { filePath: "q.ts" })).done).toBe("Edited q.ts");
    expect(describeActivity(tool("write", { filePath: "n.md" }, "error")).label).toBe(
      "Failed to write n.md",
    );
    expect(describeActivity(tool("write", { filePath: "n.md" })).done).toBe("Wrote n.md");
  });

  it("bash uses the description, else the first command line, clipped to 60", () => {
    expect(describeActivity(tool("bash", { description: "Run the tests", command: "npm t" })).done).toBe(
      "Run the tests",
    );
    expect(describeActivity(tool("bash", { command: "git status\nls" })).running).toBe("git status");
    const long = describeActivity(tool("bash", { command: "x".repeat(100) })).done;
    expect(long.length).toBe(60);
    expect(long.endsWith("…")).toBe(true);
    expect(describeActivity(tool("bash", { description: "Run it" }, "error")).label).toBe(
      "Failed: Run it",
    );
  });

  it("covers search, list, fetch, web search, agent, skill and question", () => {
    expect(describeActivity(tool("grep", { pattern: "foo" })).done).toBe("Searched foo");
    expect(describeActivity(tool("glob", { pattern: "*.ts" })).running).toBe("Searching *.ts");
    expect(describeActivity(tool("codesearch", { query: "q" })).done).toBe("Searched q");
    expect(describeActivity(tool("list", { path: "/a/src" })).done).toBe("Listed src");
    expect(describeActivity(tool("ls", { path: "/a/src" }, "error")).label).toBe("Failed to list src");
    expect(describeActivity(tool("webfetch", { url: "https://example.com/a?b=1" })).done).toBe(
      "Fetched example.com",
    );
    expect(describeActivity(tool("web_search", { query: "cats" })).running).toBe(
      "Searching the web for cats",
    );
    expect(describeActivity(tool("task", { description: "Find it" }, "error")).label).toBe(
      "Agent failed: Find it",
    );
    expect(describeActivity(tool("task", { description: "Find it" })).done).toBe("Ran agent Find it");
    expect(describeActivity(tool("skill", { name: "gsd" })).running).toBe("Loading skill gsd");
    expect(describeActivity(tool("question")).running).toBe("Asking");
    expect(describeActivity(tool("question")).done).toBe("Asked");
  });

  it("humanizes unknown (MCP) tool names", () => {
    const a = describeActivity(tool("mcp_Axiom_queryApl"));
    expect([a.running, a.done, a.failed]).toEqual([
      "Using Axiom queryApl",
      "Used Axiom queryApl",
      "Failed: Axiom queryApl",
    ]);
  });

  it("falls back to state.title, then to no trailing space, when input is missing", () => {
    expect(describeActivity(tool("read", {}, "pending", { title: "docs/a.md" })).running).toBe(
      "Reading docs/a.md",
    );
    const bare = describeActivity({ ...tool("read", {}, "pending"), state: { status: "pending" } });
    expect(bare.running).toBe("Reading");
    expect(bare.status).toBe("pending");
    // Unknown status is treated as pending.
    expect(describeActivity(tool("read", {}, "weird")).status).toBe("pending");
  });

  it("describes patch parts and marks them uncounted", () => {
    const one = describeActivity(patch(["/a/b/c.ts"]));
    expect(one.done).toBe("Saved changes to c.ts");
    expect(one.running).toBe("Saving c.ts");
    expect(one.counted).toBe(false);
    expect(describeActivity(patch(["a", "b"])).done).toBe("Saved changes to 2 files");
    expect(describeActivity(patch(["a", "b"])).plural(2)).toBe("saved 2 changes");
  });
});

describe("summarizeToolGroup", () => {
  it("one call uses its own done / failed label", () => {
    expect(summarizeToolGroup([tool("edit", { filePath: "Transcript.tsx" })]).label).toBe(
      "Edited Transcript.tsx",
    );
    const failed = summarizeToolGroup([tool("read", { filePath: "x.md" }, "error")]);
    expect(failed.label).toBe("Failed to read x.md");
    expect(failed.failed).toBe(1);
  });

  it("several calls: per-category counts in first-appearance order", () => {
    const s = summarizeToolGroup([
      tool("read", { filePath: "a" }),
      tool("bash", { command: "ls" }),
      tool("read", { filePath: "b" }),
      tool("read", { filePath: "c" }),
      tool("edit", { filePath: "d" }),
    ]);
    expect(s.label).toBe("Read 3 files, ran a command, edited a file");
    expect(s.calls).toBe(5);
  });

  it("grep / glob / codesearch share one category", () => {
    const s = summarizeToolGroup([
      tool("grep", { pattern: "a" }),
      tool("glob", { pattern: "b" }),
      tool("codesearch", { query: "c" }),
    ]);
    expect(s.label).toBe("Ran 3 searches");
  });

  it("singular / plural phrases", () => {
    expect(
      summarizeToolGroup([tool("webfetch", { url: "https://a.b" }), tool("websearch", { query: "q" })]).label,
    ).toBe("Fetched a page, searched the web");
    expect(
      summarizeToolGroup([tool("websearch", { query: "q" }), tool("websearch", { query: "r" })]).label,
    ).toBe("Searched the web 2 times");
    expect(summarizeToolGroup([tool("task", {}), tool("task", {})]).label).toBe("Ran 2 agents");
  });

  it("more than 3 categories collapses to 'Used N tools'", () => {
    const s = summarizeToolGroup([
      tool("read", { filePath: "a" }),
      tool("bash", { command: "x" }),
      tool("edit", { filePath: "b" }),
      tool("websearch", { query: "q" }),
      tool("read", { filePath: "c" }),
    ]);
    expect(s.label).toBe("Used 5 tools");
  });

  it("counts failures and reports running state", () => {
    const s = summarizeToolGroup([
      tool("bash", { command: "a" }, "error"),
      tool("bash", { command: "b" }, "error"),
      tool("read", { filePath: "c" }),
    ]);
    expect(s.failed).toBe(2);
    expect(s.running).toBe(false);
    expect(s.live).toBeNull();
    expect(groupTone(s)).toBe("warn");

    const live = summarizeToolGroup([
      tool("read", { filePath: "a" }),
      tool("edit", { filePath: "b.ts" }, "running"),
    ]);
    expect(live.running).toBe(true);
    expect(live.live?.running).toBe("Editing b.ts");
    expect(groupTone(live)).toBe("running");

    const pending = summarizeToolGroup([tool("read", { filePath: "a" }, "pending")]);
    expect(pending.live?.running).toBe("Reading a");

    expect(groupTone(summarizeToolGroup([tool("read", { filePath: "a" })]))).toBe("ok");
  });

  it("patch parts join the summary but not the tool total", () => {
    const s = summarizeToolGroup([tool("edit", { filePath: "a.ts" }), patch(["a.ts"])]);
    expect(s.calls).toBe(1);
    expect(s.label).toBe("Edited a file, saved a change");
    expect(summarizeToolGroup([patch(["a.ts"])]).label).toBe("Saved changes to a.ts");
  });
});

const toolsOf = (blocks: Block[] | undefined) =>
  (blocks ?? []).flatMap((b) => (b.kind === "tools" ? [b.group] : []));

describe("layoutTranscript", () => {
  it("groups a run across several assistant messages onto the first", () => {
    const a = tool("read", { filePath: "a" });
    const b = tool("read", { filePath: "b" });
    const c = tool("bash", { command: "ls" });
    const l = layoutTranscript(
      [user("u"), asst("m1", [a]), asst("m2", [b]), asst("m3", [c])],
      OPTS,
    );
    const owner = toolsOf(l.blocksByMessage.get("m1"));
    expect(owner).toHaveLength(1);
    expect(owner[0].items).toEqual([a, b, c]);
    expect(l.blocksByMessage.get("m2")).toEqual([]);
    expect(l.blocksByMessage.get("m3")).toEqual([]);
    expect(l.trailing).toBeNull();
  });

  it("text always ends a run and is never folded into a group", () => {
    const l = layoutTranscript(
      [
        user("u"),
        asst("m1", [tool("read", { filePath: "a" }), text("Found it."), tool("edit", { filePath: "b" })]),
        asst("m2", [tool("bash", { command: "t" })]),
      ],
      OPTS,
    );
    const kinds = l.blocksByMessage.get("m1")!.map((b) => b.kind);
    expect(kinds).toEqual(["tools", "part", "tools"]);
    const second = toolsOf(l.blocksByMessage.get("m1"))[1];
    expect(second.items).toHaveLength(2); // edit + the bash from m2
    expect(l.blocksByMessage.get("m2")).toEqual([]);
  });

  it("text in a later message splits the run", () => {
    const l = layoutTranscript(
      [
        user("u"),
        asst("m1", [tool("read", { filePath: "a" })]),
        asst("m2", [text("hmm")]),
        asst("m3", [tool("read", { filePath: "b" })]),
      ],
      OPTS,
    );
    expect(toolsOf(l.blocksByMessage.get("m1"))).toHaveLength(1);
    expect(toolsOf(l.blocksByMessage.get("m3"))).toHaveLength(1);
    expect(toolsOf(l.blocksByMessage.get("m1"))[0].items).toHaveLength(1);
  });

  it("patch parts join the run", () => {
    const e = tool("edit", { filePath: "a.ts" });
    const p = patch(["a.ts"]);
    const l = layoutTranscript([user("u"), asst("m1", [e, p])], OPTS);
    expect(toolsOf(l.blocksByMessage.get("m1"))[0].items).toEqual([e, p]);
  });

  it("hidden reasoning is transparent; shown reasoning splits the run", () => {
    const msgs = [
      user("u"),
      asst("m1", [tool("read", { filePath: "a" })]),
      asst("m2", [reasoning("thinking…"), tool("read", { filePath: "b" })]),
    ];
    const hidden = layoutTranscript(msgs, { running: false, showThinking: false });
    expect(toolsOf(hidden.blocksByMessage.get("m1"))[0].items).toHaveLength(2);
    expect(hidden.blocksByMessage.get("m2")).toEqual([]);

    const shown = layoutTranscript(msgs, { running: false, showThinking: true });
    expect(toolsOf(shown.blocksByMessage.get("m1"))[0].items).toHaveLength(1);
    expect(shown.blocksByMessage.get("m2")!.map((b) => b.kind)).toEqual(["part", "tools"]);
  });

  it("empty reasoning never splits a run, even when shown", () => {
    const l = layoutTranscript(
      [
        user("u"),
        asst("m1", [tool("read", { filePath: "a" })]),
        asst("m2", [reasoning("\n"), tool("read", { filePath: "b" })]),
      ],
      { running: false, showThinking: true },
    );
    expect(toolsOf(l.blocksByMessage.get("m1"))[0].items).toHaveLength(2);
  });

  it("a user message ends a run", () => {
    const l = layoutTranscript(
      [
        user("u1"),
        asst("m1", [tool("read", { filePath: "a" })]),
        user("u2", "next"),
        asst("m2", [tool("read", { filePath: "b" })]),
      ],
      OPTS,
    );
    expect(toolsOf(l.blocksByMessage.get("m1"))).toHaveLength(1);
    expect(toolsOf(l.blocksByMessage.get("m2"))).toHaveLength(1);
  });

  it("filters todowrite out of runs", () => {
    const l = layoutTranscript(
      [user("u"), asst("m1", [tool("todowrite"), tool("read", { filePath: "a" })])],
      OPTS,
    );
    expect(toolsOf(l.blocksByMessage.get("m1"))[0].items).toHaveLength(1);
    const only = layoutTranscript([user("u"), asst("m1", [tool("todowrite")])], OPTS);
    expect(only.blocksByMessage.get("m1")).toEqual([]);
  });

  it("while running, the run at the very tail is withheld as `trailing`", () => {
    const a = tool("read", { filePath: "a" });
    const b = tool("edit", { filePath: "b" }, "running");
    const l = layoutTranscript(
      [user("u"), asst("m1", [text("Starting."), a]), asst("m2", [b])],
      { running: true, showThinking: false },
    );
    expect(l.trailing?.items).toEqual([a, b]);
    // Owner keeps its text but no longer draws the line.
    expect(l.blocksByMessage.get("m1")!.map((x) => x.kind)).toEqual(["part"]);
    expect(l.blocksByMessage.get("m2")).toEqual([]);
  });

  it("an earlier run stays inline while only the tail run is withheld", () => {
    const l = layoutTranscript(
      [
        user("u"),
        asst("m1", [tool("read", { filePath: "a" }), text("ok"), tool("bash", { command: "x" }, "running")]),
      ],
      { running: true, showThinking: false },
    );
    expect(l.blocksByMessage.get("m1")!.map((b) => b.kind)).toEqual(["tools", "part"]);
    expect(l.trailing?.items).toHaveLength(1);
  });

  it("text after the run, or a finished turn, settles it inline", () => {
    const withText = layoutTranscript(
      [user("u"), asst("m1", [tool("read", { filePath: "a" })]), asst("m2", [text("done")])],
      { running: true, showThinking: false },
    );
    expect(withText.trailing).toBeNull();
    expect(toolsOf(withText.blocksByMessage.get("m1"))).toHaveLength(1);

    const finished = layoutTranscript(
      [user("u"), asst("m1", [tool("read", { filePath: "a" })])],
      { running: false, showThinking: false },
    );
    expect(finished.trailing).toBeNull();
    expect(toolsOf(finished.blocksByMessage.get("m1"))).toHaveLength(1);
  });

  it("hidden reasoning / empty text after the tail run keeps it trailing", () => {
    const l = layoutTranscript(
      [
        user("u"),
        asst("m1", [tool("read", { filePath: "a" })]),
        asst("m2", [reasoning("hmm"), text("")]),
      ],
      { running: true, showThinking: false },
    );
    expect(l.trailing?.items).toHaveLength(1);
  });

  it("no trailing run when a user message is last", () => {
    const l = layoutTranscript(
      [user("u"), asst("m1", [tool("read", { filePath: "a" })]), user("u2", "more")],
      { running: true, showThinking: false },
    );
    expect(l.trailing).toBeNull();
  });
});

describe("stabilizeLayout", () => {
  it("returns the previous layout object when nothing changed", () => {
    const msgs = [user("u"), asst("m1", [tool("read", { filePath: "a" }), text("hi")])];
    const prev = layoutTranscript(msgs, OPTS);
    const next = layoutTranscript(msgs, OPTS);
    expect(next.blocksByMessage.get("m1")).not.toBe(prev.blocksByMessage.get("m1"));
    expect(stabilizeLayout(prev, next)).toBe(prev);
  });

  it("reuses unchanged messages' block arrays when another message changes", () => {
    const stable = asst("m1", [tool("read", { filePath: "a" }), text("hi")]);
    const prev = layoutTranscript([user("u"), stable, asst("m2", [text("a")])], OPTS);
    const next = layoutTranscript([user("u"), stable, asst("m2", [text("a b")])], OPTS);
    const out = stabilizeLayout(prev, next);
    expect(out).not.toBe(prev);
    expect(out.blocksByMessage.get("m1")).toBe(prev.blocksByMessage.get("m1"));
    expect(out.blocksByMessage.get("m2")).not.toBe(prev.blocksByMessage.get("m2"));
  });

  it("keeps a group's identity while its text sibling streams", () => {
    const t = tool("read", { filePath: "a" });
    const prev = layoutTranscript([user("u"), asst("m1", [t, text("x")])], OPTS);
    const next = layoutTranscript([user("u"), asst("m1", [t, text("xy")])], OPTS);
    const out = stabilizeLayout(prev, next);
    expect(toolsOf(out.blocksByMessage.get("m1"))[0]).toBe(toolsOf(prev.blocksByMessage.get("m1"))[0]);
  });

  it("a growing run is a new group; a settled trailing run is reused", () => {
    const a = tool("read", { filePath: "a" });
    const b = tool("read", { filePath: "b" });
    const running = { running: true, showThinking: false };
    const prev = layoutTranscript([user("u"), asst("m1", [a])], running);
    const same = stabilizeLayout(prev, layoutTranscript([user("u"), asst("m1", [a])], running));
    expect(same).toBe(prev);
    const grown = stabilizeLayout(prev, layoutTranscript([user("u"), asst("m1", [a]), asst("m2", [b])], running));
    expect(grown.trailing).not.toBe(prev.trailing);
    expect(grown.trailing?.items).toEqual([a, b]);
  });

  it("a changed tool part (state update) yields a fresh group", () => {
    const running = tool("bash", { command: "x" }, "running");
    const done = { ...running, state: { ...(running.state as object), status: "completed" } } as OpencodePart;
    const prev = layoutTranscript([user("u"), asst("m1", [running])], OPTS);
    const out = stabilizeLayout(prev, layoutTranscript([user("u"), asst("m1", [done])], OPTS));
    expect(out).not.toBe(prev);
    expect(toolsOf(out.blocksByMessage.get("m1"))[0].items[0]).toBe(done);
  });

  it("passes the first layout through", () => {
    const l = layoutTranscript([user("u")], OPTS);
    expect(stabilizeLayout(null, l)).toBe(l);
  });
});

describe("isRenderableRow", () => {
  const a = asst("m1", []);
  const none = { blocks: [] as Block[], hasMedia: false, hasWidget: false, hasFooter: false };
  it("an assistant row needs blocks, media, a widget or a footer", () => {
    expect(isRenderableRow(a, none)).toBe(false);
    expect(isRenderableRow(a, { ...none, blocks: undefined })).toBe(false);
    expect(isRenderableRow(a, { ...none, blocks: [{ kind: "part", part: text("x") }] })).toBe(true);
    expect(isRenderableRow(a, { ...none, hasMedia: true })).toBe(true);
    expect(isRenderableRow(a, { ...none, hasWidget: true })).toBe(true);
    expect(isRenderableRow(a, { ...none, hasFooter: true })).toBe(true);
  });
  it("a user row is renderable as before", () => {
    expect(isRenderableRow(user("u", "hello"), none)).toBe(true);
    expect(isRenderableRow(user("u", ""), none)).toBe(false);
  });
});
