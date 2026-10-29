// Pure tests for the tool-activity module (WS11 D11): where the box's runs are drawn (layout by run id), layout
// stabilization, and the revision merge that keeps the newest value of a run whatever order answers arrive in. The
// wording and the run rules are the box's (transcriptRuns.test.mjs); fixtures here are stamped by the box's own module.

import { describe, it, expect } from "vitest";
import type { OpencodeMessage, OpencodePart, RunRef, RunView } from "../shared/types";
import {
  applyRunRebuild,
  emptyRunMap,
  hasStaleMembership,
  isRenderableRow,
  layoutTranscript,
  locateVisibleRow,
  mergeRunViews,
  setRunEpoch,
  stabilizeLayout,
  type Block,
  type RunMap,
} from "./toolActivity";
import { viewed } from "./testRunViews";

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
/** What the box would send for this transcript (run ids, summaries, part activity). */
const V = (ms: OpencodeMessage[]) => viewed(ms);

const toolsOf = (blocks: Block[] | undefined) =>
  (blocks ?? []).flatMap((b) => (b.kind === "tools" ? [b.group] : []));
const ids = (g: { items: OpencodePart[] }) => g.items.map((p) => p.id);

describe("layoutTranscript (by the box's run ids)", () => {
  it("groups a run across several assistant messages onto the first", () => {
    const a = tool("read", { filePath: "a" });
    const b = tool("read", { filePath: "b" });
    const c = tool("bash", { command: "ls" });
    const l = layoutTranscript(V([user("u"), asst("m1", [a]), asst("m2", [b]), asst("m3", [c])]), OPTS);
    const owner = toolsOf(l.blocksByMessage.get("m1"));
    expect(owner).toHaveLength(1);
    expect(ids(owner[0])).toEqual([a.id, b.id, c.id]);
    expect(owner[0].id).toBe(a.id); // the run's id is its first part
    expect(owner[0].view.label).toBe("Read 2 files, ran a command");
    expect(l.blocksByMessage.get("m2")).toEqual([]);
    expect(l.blocksByMessage.get("m3")).toEqual([]);
    expect(l.trailing).toBeNull();
  });

  it("text always ends a run and is never folded into a group", () => {
    const l = layoutTranscript(
      V([
        user("u"),
        asst("m1", [tool("read", { filePath: "a" }), text("Found it."), tool("edit", { filePath: "b" })]),
        asst("m2", [tool("bash", { command: "t" })]),
      ]),
      OPTS,
    );
    expect(l.blocksByMessage.get("m1")!.map((b) => b.kind)).toEqual(["tools", "part", "tools"]);
    expect(toolsOf(l.blocksByMessage.get("m1"))[1].items).toHaveLength(2); // edit + the bash from m2
    expect(l.blocksByMessage.get("m2")).toEqual([]);
  });

  it("text in a later message splits the run", () => {
    const l = layoutTranscript(
      V([
        user("u"),
        asst("m1", [tool("read", { filePath: "a" })]),
        asst("m2", [text("hmm")]),
        asst("m3", [tool("read", { filePath: "b" })]),
      ]),
      OPTS,
    );
    expect(toolsOf(l.blocksByMessage.get("m1"))[0].items).toHaveLength(1);
    expect(toolsOf(l.blocksByMessage.get("m3"))).toHaveLength(1);
  });

  it("patch parts join the run", () => {
    const e = tool("edit", { filePath: "a.ts" });
    const p = patch(["a.ts"]);
    const l = layoutTranscript(V([user("u"), asst("m1", [e, p])]), OPTS);
    expect(ids(toolsOf(l.blocksByMessage.get("m1"))[0])).toEqual([e.id, p.id]);
  });

  it("hidden reasoning is transparent (ONE block); shown reasoning draws one block per segment", () => {
    const msgs = V([
      user("u"),
      asst("m1", [tool("read", { filePath: "a" })]),
      asst("m2", [reasoning("thinking…"), tool("read", { filePath: "b" })]),
    ]);
    const hidden = layoutTranscript(msgs, { running: false, showThinking: false });
    expect(toolsOf(hidden.blocksByMessage.get("m1"))[0].items).toHaveLength(2);
    expect(hidden.blocksByMessage.get("m2")).toEqual([]);

    const shown = layoutTranscript(msgs, { running: false, showThinking: true });
    const first = toolsOf(shown.blocksByMessage.get("m1"));
    expect(first[0].items).toHaveLength(1);
    expect(shown.blocksByMessage.get("m2")!.map((b) => b.kind)).toEqual(["part", "tools"]);
    // Toggling reasoning keeps the first row's id (the first segment's id IS the run id).
    expect(first[0].id).toBe(toolsOf(hidden.blocksByMessage.get("m1"))[0].id);
    expect(first[0].view.label).toBe("Read a"); // the segment's own summary
    expect(toolsOf(hidden.blocksByMessage.get("m1"))[0].view.label).toBe("Read 2 files");
  });

  it("empty reasoning never splits a run, even when shown", () => {
    const l = layoutTranscript(
      V([
        user("u"),
        asst("m1", [tool("read", { filePath: "a" })]),
        asst("m2", [reasoning("\n"), tool("read", { filePath: "b" })]),
      ]),
      { running: false, showThinking: true },
    );
    expect(toolsOf(l.blocksByMessage.get("m1"))[0].items).toHaveLength(2);
  });

  it("a user message ends a run", () => {
    const l = layoutTranscript(
      V([
        user("u1"),
        asst("m1", [tool("read", { filePath: "a" })]),
        user("u2", "next"),
        asst("m2", [tool("read", { filePath: "b" })]),
      ]),
      OPTS,
    );
    expect(toolsOf(l.blocksByMessage.get("m1"))).toHaveLength(1);
    expect(toolsOf(l.blocksByMessage.get("m2"))).toHaveLength(1);
  });

  it("filters todowrite out of runs", () => {
    const l = layoutTranscript(V([user("u"), asst("m1", [tool("todowrite"), tool("read", { filePath: "a" })])]), OPTS);
    expect(toolsOf(l.blocksByMessage.get("m1"))[0].items).toHaveLength(1);
    const only = layoutTranscript(V([user("u"), asst("m1", [tool("todowrite")])]), OPTS);
    expect(only.blocksByMessage.get("m1")).toEqual([]);
  });

  it("while running, the run at the very tail is withheld as `trailing`", () => {
    const a = tool("read", { filePath: "a" });
    const b = tool("edit", { filePath: "b" }, "running");
    const l = layoutTranscript(V([user("u"), asst("m1", [text("Starting."), a]), asst("m2", [b])]), {
      running: true,
      showThinking: false,
    });
    expect(ids(l.trailing!)).toEqual([a.id, b.id]);
    expect(l.trailing!.view.live?.label).toBe("Editing b");
    // Owner keeps its text but no longer draws the line.
    expect(l.blocksByMessage.get("m1")!.map((x) => x.kind)).toEqual(["part"]);
    expect(l.blocksByMessage.get("m2")).toEqual([]);
  });

  it("an earlier run stays inline while only the tail run is withheld", () => {
    const l = layoutTranscript(
      V([user("u"), asst("m1", [tool("read", { filePath: "a" }), text("ok"), tool("bash", { command: "x" }, "running")])]),
      { running: true, showThinking: false },
    );
    expect(l.blocksByMessage.get("m1")!.map((b) => b.kind)).toEqual(["tools", "part"]);
    expect(l.trailing?.items).toHaveLength(1);
  });

  it("text after the run, or a finished turn, settles it inline", () => {
    const withText = layoutTranscript(
      V([user("u"), asst("m1", [tool("read", { filePath: "a" })]), asst("m2", [text("done")])]),
      { running: true, showThinking: false },
    );
    expect(withText.trailing).toBeNull();
    expect(toolsOf(withText.blocksByMessage.get("m1"))).toHaveLength(1);

    const finished = layoutTranscript(V([user("u"), asst("m1", [tool("read", { filePath: "a" })])]), {
      running: false,
      showThinking: false,
    });
    expect(finished.trailing).toBeNull();
    expect(toolsOf(finished.blocksByMessage.get("m1"))).toHaveLength(1);
  });

  it("hidden reasoning / empty text after the tail run keeps it trailing", () => {
    const l = layoutTranscript(
      V([user("u"), asst("m1", [tool("read", { filePath: "a" })]), asst("m2", [reasoning("hmm"), text("")])]),
      { running: true, showThinking: false },
    );
    expect(l.trailing?.items).toHaveLength(1);
  });

  it("no trailing run when a user message is last", () => {
    const l = layoutTranscript(V([user("u"), asst("m1", [tool("read", { filePath: "a" })]), user("u2", "more")]), {
      running: true,
      showThinking: false,
    });
    expect(l.trailing).toBeNull();
  });

  it("a run whose owner is OUTSIDE the window draws at the first in-window message that has a part of it", () => {
    const all = V([
      user("u"),
      asst("m1", [tool("read", { filePath: "a" })]),
      asst("m2", [tool("read", { filePath: "b" })]),
      asst("m3", [tool("read", { filePath: "c" })]),
    ]);
    const owner = all[1].parts[0].id;
    // The window starts at m2 (m1 is "earlier"); the box still says the run is the one that began at m1's part.
    const window = viewed(all.slice(2).map((m) => ({ ...m, view: undefined })), {
      runContext: all.slice(1) as OpencodeMessage[],
    });
    const l = layoutTranscript(window, OPTS);
    const g = toolsOf(l.blocksByMessage.get("m2"));
    expect(g).toHaveLength(1);
    expect(g[0].id).toBe(owner); // the TRUE id (its first part), not the window's first part
    expect(l.blocksByMessage.get("m3")).toEqual([]);
    // "Load earlier" brings the owner in: the same row id moves to the owner.
    const widened = layoutTranscript(all, OPTS);
    expect(toolsOf(widened.blocksByMessage.get("m1"))[0].id).toBe(owner);
  });

  it("a tool part with no runId (not stamped) draws as a part", () => {
    const l = layoutTranscript([user("u"), asst("m1", [tool("read", { filePath: "a" })])], OPTS);
    expect(l.blocksByMessage.get("m1")!.map((b) => b.kind)).toEqual(["part"]);
  });

  it("an older box (runsAvailable false) collapses each message's calls into ONE neutral line", () => {
    const l = layoutTranscript(
      [user("u"), asst("m1", [tool("read", { filePath: "a" }), tool("bash", { command: "ls" })])],
      { ...OPTS, runsAvailable: false },
    );
    const g = toolsOf(l.blocksByMessage.get("m1"));
    expect(g).toHaveLength(1);
    expect(g[0].fallback).toBe(true);
    expect(g[0].view.label).toBe("Tool activity");
    expect(g[0].items).toHaveLength(2);
  });

  it("a run id from a retired membership (part gen below minGen) is ignored for layout", () => {
    const msgs = V([user("u"), asst("m1", [tool("read", { filePath: "a" })])]);
    const l = layoutTranscript(msgs, { ...OPTS, minGen: 2 });
    expect(l.blocksByMessage.get("m1")!.map((b) => b.kind)).toEqual(["part"]);
  });

  it("the rev-merged map wins over the (older) view a message carries", () => {
    const msgs = V([user("u"), asst("m1", [tool("read", { filePath: "a" })])]);
    const carried = msgs[1].view!.runs![0] as RunView;
    const newer: RunView = { ...carried, label: "Read 3 files", calls: 3, rev: { ...carried.rev, seq: carried.rev.seq + 5 } };
    const l = layoutTranscript(msgs, { ...OPTS, runs: new Map([[carried.id, newer]]) });
    expect(toolsOf(l.blocksByMessage.get("m1"))[0].view.label).toBe("Read 3 files");
  });
});

describe("stabilizeLayout", () => {
  it("returns the previous layout object when nothing changed", () => {
    const msgs = V([user("u"), asst("m1", [tool("read", { filePath: "a" }), text("hi")])]);
    const prev = layoutTranscript(msgs, OPTS);
    const next = layoutTranscript(msgs, OPTS);
    expect(next.blocksByMessage.get("m1")).not.toBe(prev.blocksByMessage.get("m1"));
    expect(stabilizeLayout(prev, next)).toBe(prev);
  });

  it("reuses unchanged messages' block arrays when another message changes", () => {
    const a = V([user("u"), asst("m1", [tool("read", { filePath: "a" }), text("hi")]), asst("m2", [text("a")])]);
    const b = [a[0], a[1], { ...a[2], parts: [text("a b")] }];
    const prev = layoutTranscript(a, OPTS);
    const out = stabilizeLayout(prev, layoutTranscript(b, OPTS));
    expect(out).not.toBe(prev);
    expect(out.blocksByMessage.get("m1")).toBe(prev.blocksByMessage.get("m1"));
    expect(out.blocksByMessage.get("m2")).not.toBe(prev.blocksByMessage.get("m2"));
  });

  it("keeps a group's identity while its text sibling streams", () => {
    const a = V([user("u"), asst("m1", [tool("read", { filePath: "a" }), text("x")])]);
    const b = [a[0], { ...a[1], parts: [a[1].parts[0], { ...a[1].parts[1], text: "xy" } as OpencodePart] }];
    const prev = layoutTranscript(a, OPTS);
    const out = stabilizeLayout(prev, layoutTranscript(b, OPTS));
    expect(toolsOf(out.blocksByMessage.get("m1"))[0]).toBe(toolsOf(prev.blocksByMessage.get("m1"))[0]);
  });

  it("a growing run is a new group; an unchanged trailing run is reused", () => {
    const m1 = tool("read", { filePath: "a" });
    const running = { running: true, showThinking: false };
    const one = V([user("u"), asst("m1", [m1])]);
    const prev = layoutTranscript(one, running);
    expect(stabilizeLayout(prev, layoutTranscript(one, running))).toBe(prev);
    const two = V([user("u"), asst("m1", [m1]), asst("m2", [tool("read", { filePath: "b" })])]);
    const grown = stabilizeLayout(prev, layoutTranscript(two, running));
    expect(grown.trailing).not.toBe(prev.trailing);
    expect(grown.trailing?.items).toHaveLength(2);
  });

  it("run views compare by CONTENT: an equal summary at a newer rev keeps identity, a changed one does not", () => {
    const msgs = V([user("u"), asst("m1", [tool("read", { filePath: "a" })])]);
    const carried = msgs[1].view!.runs![0] as RunView;
    const prev = layoutTranscript(msgs, { ...OPTS, runs: new Map([[carried.id, carried]]) });
    const sameBumped: RunView = { ...carried, rev: { ...carried.rev, seq: carried.rev.seq + 1 } };
    expect(stabilizeLayout(prev, layoutTranscript(msgs, { ...OPTS, runs: new Map([[carried.id, sameBumped]]) }))).toBe(prev);
    const changed: RunView = { ...carried, label: "Read 2 files", calls: 2 };
    const out = stabilizeLayout(prev, layoutTranscript(msgs, { ...OPTS, runs: new Map([[carried.id, changed]]) }));
    expect(out).not.toBe(prev);
  });

  it("a changed tool part (state update) yields a fresh group", () => {
    const running = tool("bash", { command: "x" }, "running");
    const done = { ...running, state: { ...(running.state as object), status: "completed" } } as OpencodePart;
    const prev = layoutTranscript(V([user("u"), asst("m1", [running])]), OPTS);
    const after = V([user("u"), asst("m1", [done])]);
    const out = stabilizeLayout(prev, layoutTranscript(after, OPTS));
    expect(out).not.toBe(prev);
    expect(toolsOf(out.blocksByMessage.get("m1"))[0].items[0]).toBe(after[1].parts[0]);
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

describe("locateVisibleRow", () => {
  // Visible = what Transcript hands Virtuoso (no media / widgets / footers here).
  const locate = (messages: OpencodeMessage[], id: string, running = false) => {
    const stamped = V(messages);
    const layout = layoutTranscript(stamped, { running, showThinking: false });
    const visible = stamped.filter((m) =>
      isRenderableRow(m, {
        blocks: layout.blocksByMessage.get(m.info.id),
        hasMedia: false,
        hasWidget: false,
        hasFooter: false,
      }),
    );
    return { loc: locateVisibleRow(id, stamped, visible, layout), visible };
  };

  // a1 starts the run and keeps its text; a2 / a3 are absorbed into it.
  const RUN = [
    user("u1"),
    asst("a1", [text("Looking."), tool("read", { filePath: "a" })]),
    asst("a2", [tool("read", { filePath: "b" })]),
    asst("a3", [tool("bash", { command: "ls" })]),
    asst("a4", [text("Done.")]),
  ];

  it("a visible message resolves to itself, at its index in the visible list", () => {
    expect(locate(RUN, "a4").loc).toEqual({ index: 2, rowId: "a4" });
    expect(locate(RUN, "u1").loc).toEqual({ index: 0, rowId: "u1" });
  });

  it("an absorbed message resolves to the row owning its run", () => {
    // Visible rows are u1, a1, a4 — a2 / a3 have no row of their own.
    expect(locate(RUN, "a2").loc).toEqual({ index: 1, rowId: "a1" });
    expect(locate(RUN, "a3").loc).toEqual({ index: 1, rowId: "a1" });
  });

  it("a message in the trailing run of a running turn resolves to the last visible row", () => {
    const running = [
      user("u1"),
      asst("a1", [text("Looking.")]),
      asst("a2", [tool("read", { filePath: "a" }, "running")]),
      asst("a3", [tool("read", { filePath: "b" }, "running")]),
    ];
    expect(locate(running, "a2", true).loc).toEqual({ index: 1, rowId: "a1" });
    expect(locate(running, "a3", true).loc).toEqual({ index: 1, rowId: "a1" });
    // Once the turn settles, the run is drawn inline by its owner, a2.
    expect(locate(running, "a3", false).loc).toEqual({ index: 2, rowId: "a2" });
  });

  it("a message hidden for another reason falls back to the nearest preceding visible row", () => {
    const msgs = [user("u1"), asst("a1", [text("Hi.")]), asst("a2", [reasoning("")]), asst("a3", [text("Bye.")])];
    expect(locate(msgs, "a2").loc).toEqual({ index: 1, rowId: "a1" });
  });

  it("falls back to the first visible row when nothing visible precedes the message", () => {
    const msgs = [asst("a0", [reasoning("")]), user("u1"), asst("a1", [text("Hi.")])];
    expect(locate(msgs, "a0").loc).toEqual({ index: 0, rowId: "u1" });
  });

  it("unknown ids give null", () => {
    expect(locate(RUN, "nope").loc).toBeNull();
    expect(locateVisibleRow("a1", RUN, [], layoutTranscript(RUN, OPTS))).toBeNull();
  });
});

// ===== mergeRunViews: the revision rules =====

const run = (id: string, label: string, rev: Partial<RunView["rev"]> = {}, extra: Partial<RunView> = {}): RunView => ({
  id,
  ownerMessageId: "m1",
  label,
  calls: 1,
  failed: 0,
  tone: "ok",
  live: null,
  rev: { epoch: "E1", gen: 1, seq: 1, ...rev },
  ...extra,
});
const ref = (id: string, seq = 1): RunRef => ({ id, ref: true, rev: { epoch: "E1", gen: 1, seq } });
const CTX = { currentEpoch: "E1", connGen: 1 };
const labelOf = (m: RunMap, id: string) => m.runs.get(id)?.label;
const known = (): RunMap => setRunEpoch(emptyRunMap(), "E1", 1);

describe("mergeRunViews", () => {
  it("a higher seq wins, an equal seq wins (idempotent), a lower seq is ignored", () => {
    let m = mergeRunViews(known(), [run("A", "one", { seq: 2 })], CTX);
    m = mergeRunViews(m, [run("A", "newer", { seq: 3 })], CTX);
    expect(labelOf(m, "A")).toBe("newer");
    const again = mergeRunViews(m, [run("A", "newer", { seq: 3 })], CTX);
    expect(labelOf(again, "A")).toBe("newer");
    const older = mergeRunViews(m, [run("A", "stale", { seq: 1 })], CTX);
    expect(older).toBe(m);
  });

  it("a value from a non-current epoch is rejected", () => {
    const m = mergeRunViews(known(), [run("A", "old process", { epoch: "E0", seq: 99 })], CTX);
    expect(m.runs.size).toBe(0);
  });

  it("a response issued under an older connection is discarded for the run map", () => {
    const m = mergeRunViews(known(), [run("A", "late")], { currentEpoch: "E2", connGen: 2, issuedConnGen: 1 });
    expect(m.runs.size).toBe(0);
  });

  it("a change of currentEpoch drops other-epoch runs", () => {
    let m = mergeRunViews(known(), [run("A", "e1")], CTX);
    m = setRunEpoch(m, "E2", 2);
    expect(m.runs.size).toBe(0);
    m = mergeRunViews(m, [run("A", "e2", { epoch: "E2" })], { currentEpoch: "E2", connGen: 2 });
    expect(labelOf(m, "A")).toBe("e2");
  });

  it("writes before the first runningSet are queued and applied through the same rules once the epoch arrives", () => {
    let m = emptyRunMap();
    m = mergeRunViews(m, [run("A", "early")], { currentEpoch: null, connGen: 1, issuedConnGen: 1 });
    m = mergeRunViews(m, [run("B", "other epoch", { epoch: "E0" })], { currentEpoch: null, connGen: 1 });
    expect(m.runs.size).toBe(0);
    m = setRunEpoch(m, "E1", 1);
    expect(labelOf(m, "A")).toBe("early");
    expect(m.runs.has("B")).toBe(false);
  });

  it("a RunRef never overwrites a stored value and never creates one", () => {
    let m = mergeRunViews(known(), [run("A", "stored", { seq: 2 })], CTX);
    m = mergeRunViews(m, [ref("A", 9), ref("Z")], CTX);
    expect(labelOf(m, "A")).toBe("stored");
    expect(m.runs.has("Z")).toBe(false);
  });

  it("E1 fetch issued → E2 reconnect → the E1 answer resolves: E2 stays", () => {
    // E2's snapshot arrived first.
    let m = setRunEpoch(emptyRunMap(), "E2", 2);
    m = mergeRunViews(m, [run("A", "from E2", { epoch: "E2", seq: 5 })], { currentEpoch: "E2", connGen: 2 });
    // The E1 answer (issued under connGen 1) resolves afterwards.
    const after = mergeRunViews(m, [run("A", "from E1", { epoch: "E1", seq: 50 })], { currentEpoch: "E2", connGen: 2, issuedConnGen: 1 });
    expect(after).toBe(m);
    expect(labelOf(after, "A")).toBe("from E2");
  });

  it("a newer gen wins over a higher seq of an older gen", () => {
    let m = mergeRunViews(known(), [run("A", "gen1", { gen: 1, seq: 40 })], CTX);
    m = mergeRunViews(m, [run("A", "gen2", { gen: 2, seq: 1 })], CTX);
    expect(labelOf(m, "A")).toBe("gen2");
  });
});

describe("a canonical rebuild", () => {
  it("deletes the retired id and raises minGen; a gen-1 value arriving afterwards is rejected", () => {
    let m = mergeRunViews(known(), [run("A", "a"), run("B", "b")], CTX);
    m = applyRunRebuild(m, ["B"], 2);
    expect(m.runs.has("B")).toBe(false);
    expect(m.minGen).toBe(2);
    m = mergeRunViews(m, [run("B", "resurrected", { gen: 1, seq: 99 })], CTX);
    expect(m.runs.has("B")).toBe(false);
    m = mergeRunViews(m, [run("A", "merged", { gen: 2, seq: 3 })], CTX);
    expect(labelOf(m, "A")).toBe("merged");
  });

  it("a gen-1 spliced message is rendered but its run membership is ignored, and a refetch is wanted", () => {
    const stamped = V([user("u"), asst("m1", [tool("read", { filePath: "a" })])]);
    expect(hasStaleMembership(stamped, 0)).toBe(false);
    expect(hasStaleMembership(stamped, 2)).toBe(true);
    // The layout ignores the retired id: the call draws as a plain part, the message still renders.
    const l = layoutTranscript(stamped, { ...OPTS, minGen: 2 });
    expect(l.blocksByMessage.get("m1")!.map((b) => b.kind)).toEqual(["part"]);
  });

  it("an out-of-order RPC answer (older rev) after a newer toolRuns frame leaves the newer summary", () => {
    let m = mergeRunViews(known(), [run("A", "frame", { seq: 9 })], CTX);
    m = mergeRunViews(m, [run("A", "late splice", { seq: 4 })], { ...CTX, issuedConnGen: 1 });
    expect(labelOf(m, "A")).toBe("frame");
  });
});
