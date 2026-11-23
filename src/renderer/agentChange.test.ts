import { describe, expect, it } from "vitest";
import {
  DIFF_CONTEXT_LINES,
  agentChangeActions,
  agentChangeButtonLabel,
  agentChangeChip,
  agentChangeKeyOf,
  agentChangeOutcome,
  agentChangeReason,
  agentChangeTitle,
  diffRows,
  isAgentChangePart,
  parseAgentMdView,
} from "./agentChange";

describe("isAgentChangePart", () => {
  it("is a tool part named agent_change, in any state", () => {
    for (const status of ["pending", "running", "completed", "error"]) {
      expect(isAgentChangePart({ type: "tool", tool: "agent_change", state: { status } } as never)).toBe(true);
    }
    expect(isAgentChangePart({ type: "tool", tool: "manta_agent_change" })).toBe(true);
  });
  it("is not any other tool, nor a non-tool part", () => {
    expect(isAgentChangePart({ type: "tool", tool: "agent_handoff" })).toBe(false);
    expect(isAgentChangePart({ type: "tool", tool: "bash" })).toBe(false);
    expect(isAgentChangePart({ type: "text", tool: "agent_change" })).toBe(false);
    expect(isAgentChangePart({ type: "tool" })).toBe(false);
  });
});

describe("agentChangeKeyOf", () => {
  it("is the call tuple, or null when any piece is missing", () => {
    expect(agentChangeKeyOf({ sessionID: "s", messageID: "m", callID: "c" })).toEqual({ sessionID: "s", messageID: "m", callID: "c" });
    expect(agentChangeKeyOf({ sessionID: "s", messageID: "m" })).toBeNull();
    expect(agentChangeKeyOf({ sessionID: "", messageID: "m", callID: "c" })).toBeNull();
  });
});

describe("chip, title, reason, buttons", () => {
  it("names every state", () => {
    expect(agentChangeChip({ state: "applied", kind: "create" }).label).toBe("Created");
    expect(agentChangeChip({ state: "applied", kind: "update" }).label).toBe("Updated");
    expect(agentChangeChip({ state: "pending", kind: "create" }).label).toBe("Waiting for you");
    expect(agentChangeChip({ state: "failed", kind: "update" }).label).toBe("Written, not activated");
    expect(agentChangeChip({ state: "conflict", kind: "update" }).label).toBe("Not applied");
    for (const s of ["discarded", "undone", "expired"] as const) expect(agentChangeChip({ state: s, kind: "create" }).tone).toBe("neutral");
  });

  it("titles a create and an update", () => {
    expect(agentChangeTitle({ kind: "create", agentName: "Reviewer" })).toBe("New agent: Reviewer");
    expect(agentChangeTitle({ kind: "update", agentName: "Dev" })).toBe("Change to Dev");
  });

  it("gives a reason line only for a change that raises power", () => {
    expect(agentChangeReason({ needsClick: true, reason: "lead", agentName: "Manta" })).toBe("This changes Manta's own instructions");
    expect(agentChangeReason({ needsClick: true, reason: "isolation", agentName: "Dev" })).toBe("This lets Dev edit code");
    expect(agentChangeReason({ needsClick: true, reason: "ask", agentName: "Dev" })).toBeNull();
    expect(agentChangeReason({ needsClick: false, reason: null, agentName: "Dev" })).toBeNull();
  });

  it("offers buttons by state", () => {
    expect(agentChangeActions("pending")).toEqual(["apply", "discard"]);
    expect(agentChangeActions("applied")).toEqual(["undo"]);
    expect(agentChangeActions("failed")).toEqual(["apply"]);
    for (const s of ["discarded", "undone", "expired", "conflict"] as const) expect(agentChangeActions(s)).toEqual([]);
  });

  it("labels the apply button Create / Apply / Retry, and says what is in flight", () => {
    expect(agentChangeButtonLabel("apply", { kind: "create", state: "pending" }, false)).toBe("Create");
    expect(agentChangeButtonLabel("apply", { kind: "update", state: "pending" }, false)).toBe("Apply");
    expect(agentChangeButtonLabel("apply", { kind: "update", state: "failed" }, false)).toBe("Retry");
    expect(agentChangeButtonLabel("apply", { kind: "create", state: "pending" }, true)).toBe("Creating…");
    expect(agentChangeButtonLabel("discard", { kind: "create", state: "pending" }, true)).toBe("Discarding…");
    expect(agentChangeButtonLabel("undo", { kind: "create", state: "applied" }, false)).toBe("Undo");
  });

  it("knows where a successful press ends", () => {
    expect(agentChangeOutcome("apply", { kind: "create" }).state).toBe("applied");
    expect(agentChangeOutcome("discard", { kind: "update" }).state).toBe("discarded");
    expect(agentChangeOutcome("undo", { kind: "update" }).state).toBe("undone");
  });
});

describe("parseAgentMdView", () => {
  const md =
    "---\nname: Reviewer\ndescription: Reviews pull requests\nisolation: none\nuse_when: a PR needs a look\nnot_for: writing code\nmodel: anthropic/claude-x\n---\nYou review.\n\nNever edit.\n";

  it("reads the fields the card shows", () => {
    expect(parseAgentMdView(md)).toEqual({
      name: "Reviewer",
      description: "Reviews pull requests",
      useWhen: "a PR needs a look",
      notFor: "writing code",
      editsCode: false,
      model: "anthropic/claude-x",
      body: "You review.\n\nNever edit.",
    });
  });

  it("defaults to editing on its own branch and Auto model", () => {
    const v = parseAgentMdView("---\nname: Dev\ndescription: Builds\nisolation: worktree\n---\nGo.\n");
    expect(v?.editsCode).toBe(true);
    expect(v?.model).toBeNull();
    expect(v?.useWhen).toBeNull();
  });

  it("is null for text it cannot read", () => {
    expect(parseAgentMdView("no frontmatter")).toBeNull();
    expect(parseAgentMdView("---\n: : :\n  - [\n---\nbody")).toBeNull();
    expect(parseAgentMdView("---\nname: A\n---\nbody")).toBeNull();
  });
});

describe("diffRows", () => {
  const numbered = (n: number, edit?: Record<number, string>) =>
    Array.from({ length: n }, (_, i) => edit?.[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

  it("is empty when nothing changed", () => {
    expect(diffRows("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("shows removed and added lines, in order", () => {
    expect(diffRows("a\nb\nc\n", "a\nB\nc\n")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });

  it("folds long unchanged runs, keeping context beside each change", () => {
    const rows = diffRows(numbered(40), numbered(40, { 20: "CHANGED" }));
    expect(rows.filter((r) => r.kind === "gap")).toHaveLength(2);
    const del = rows.findIndex((r) => r.kind === "del");
    expect(rows[del]).toEqual({ kind: "del", text: "line 20" });
    expect(rows[del + 1]).toEqual({ kind: "add", text: "CHANGED" });
    // DIFF_CONTEXT_LINES unchanged lines on each side of the change
    expect(rows.slice(del - DIFF_CONTEXT_LINES, del).every((r) => r.kind === "same")).toBe(true);
    expect(rows[del - DIFF_CONTEXT_LINES - 1].kind).toBe("gap");
    // the folded count + the shown lines account for every unchanged line
    const folded = rows.reduce((n, r) => n + (r.kind === "gap" ? r.count : 0), 0);
    const same = rows.filter((r) => r.kind === "same").length;
    expect(folded + same).toBe(39);
  });

  it("does not fold a single line into a gap", () => {
    const rows = diffRows(numbered(8, {}), numbered(8, { 1: "X", 8: "Y" }));
    // 6 unchanged lines between the changes: 2 + gap(2) + 2
    expect(rows.filter((r) => r.kind === "gap")).toEqual([{ kind: "gap", count: 2 }]);
    const small = diffRows(numbered(7), numbered(7, { 1: "X", 7: "Y" }));
    // 5 unchanged lines: 2 + 2 + 1 → shown whole rather than as a gap of 1
    expect(small.some((r) => r.kind === "gap")).toBe(false);
  });
});
