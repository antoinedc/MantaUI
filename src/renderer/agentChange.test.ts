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
  architectSourceBlocks,
  diffRows,
  evidenceLines,
  isAgentChangePart,
  parseAgentMdView,
  verdictLabel,
  changeAuthor,
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
    expect(agentChangeChip({ state: "failed", kind: "update" }).label).toBe("Not activated");
    expect(agentChangeChip({ state: "conflict", kind: "update" }).label).toBe("Not applied");
    for (const s of ["discarded", "undone", "expired"] as const) expect(agentChangeChip({ state: s, kind: "create" }).tone).toBe("neutral");
  });

  it("titles a create and an update", () => {
    expect(agentChangeTitle({ kind: "create", agentName: "Reviewer" })).toBe("New agent: Reviewer");
    expect(agentChangeTitle({ kind: "update", agentName: "Dev" })).toBe("Change to Dev");
    expect(agentChangeTitle({ kind: "update", agentName: "Dev", origin: { kind: "template-update", templateHash: "h" } })).toBe("Built-in update: Dev");
    expect(agentChangeTitle({ kind: "update", agentName: "Dev", origin: { kind: "learned" } })).toBe("Learned by Dev");
    expect(agentChangeTitle({ kind: "update", agentName: "Dev", origin: { kind: "learned" }, learned: { removedId: "lr_00000001" } })).toBe("Dev forgot a preference");
    expect(changeAuthor({ origin: { kind: "learned" } })).toBe("Manta");
  });

  it("gives a reason line only for a change that raises power", () => {
    expect(agentChangeReason({ needsClick: true, reason: "lead", agentName: "Manta" })).toBe("This changes Manta's own instructions");
    expect(agentChangeReason({ needsClick: true, reason: "isolation", agentName: "Dev" })).toBe("This lets Dev edit code");
    expect(agentChangeReason({ needsClick: true, reason: "script-flagged", agentName: "Dev" })).toBe("An independent check flagged a script — read the reasons before applying");
    expect(agentChangeReason({ needsClick: true, reason: "script-unchecked", agentName: "Dev" })).toBe("The independent script check couldn't run — read the scripts before applying");
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

describe("Phase 5A: held and applying, the new reasons", () => {
  it("names held and applying; neither offers a button", () => {
    expect(agentChangeChip({ state: "held", kind: "update" })).toEqual({ label: "Architect still working", tone: "neutral" });
    expect(agentChangeChip({ state: "applying", kind: "create" })).toEqual({ label: "Applying…", tone: "accent" });
    expect(agentChangeActions("held")).toEqual([]);
    expect(agentChangeActions("applying")).toEqual([]);
  });

  it("says why a proposal needs a click: the Architect itself, an unfinished task, a plan or a mention", () => {
    expect(agentChangeReason({ needsClick: true, reason: "core", agentName: "Architect" })).toBe("This changes the Architect itself");
    expect(agentChangeReason({ needsClick: true, reason: "unfinished", agentName: "Dev" })).toBe("The task didn't finish — review before applying");
    expect(agentChangeReason({ needsClick: true, reason: "plan", agentName: "Dev" })).toBe("Proposed while planning or outside a hand-off — review before applying");
    expect(agentChangeReason({ needsClick: true, reason: "ask", agentName: "Dev" })).toBeNull();
  });

  it("labels verdicts for the rules-considered list", () => {
    expect(verdictLabel("general")).toBe("General");
    expect(verdictLabel("scoped")).toBe("Scoped");
    expect(verdictLabel("excluded")).toBe("Excluded");
  });

  it("evidenceLines: a public item keeps its quote and link; a private one says so and shows only the claim", () => {
    expect(
      evidenceLines([
        { claim: "Short rules help", quote: "Short rules beat long ones", url: "https://example.com/a", private: false },
        { claim: "A founder said so", quote: null, url: null, private: true },
      ]),
    ).toEqual([
      { claim: "Short rules help", quote: "Short rules beat long ones", url: "https://example.com/a", isPrivate: false },
      { claim: "A founder said so", quote: null, url: null, isPrivate: true },
    ]);
  });

  it("evidenceLines never trusts a link that is not http(s)", () => {
    const [row] = evidenceLines([{ claim: "c", quote: "q", url: "javascript:alert(1)", private: false }]);
    expect(row.url).toBeNull();
  });
});

describe("architectSourceBlocks (the Architect card's source blocks)", () => {
  const md = (extra = "") => `---\nname: Architect\ndescription: Builds agents.\nrole: architect\nisolation: none\n${extra}---\nBody.\n`;
  const BF = `sources:\n  - id: bookface\n    name: YC Bookface\n    description: Private forum.\n    command: [yc, search, "{query}", --type, posts]\n    env:\n      YC_TOKEN: "{secret:YC_TOKEN}"\n`;
  const URLSRC = `sources:\n  - id: internal\n    name: Internal\n    description: Ours.\n    private: false\n    url: "https://search.example.com/api?q={query}"\n`;

  it("an added command source shows the argv with {query} marked, the secret names and the private sentence", () => {
    const [b] = architectSourceBlocks(md(), md(BF));
    expect(b.change).toBe("added");
    expect(b.runs).toBe("yc search {query} --type posts");
    expect(b.line).toMatch(/^Runs yc search \{query\} --type posts on this box with your account's access\./);
    expect(b.secrets).toEqual(["YC_TOKEN"]);
    expect(b.note).toMatch(/^Private: results go to the AI model and its local transcript/);
    expect(b.warning).toBeNull();
  });

  it("a url source names the host; a public one has no privacy sentence", () => {
    const [b] = architectSourceBlocks(md(), md(URLSRC));
    expect(b.line).toBe("Calls search.example.com");
    expect(b.note).toBeNull();
  });

  it("private → public is a warning on the changed source", () => {
    const privateUrl = URLSRC.replace("    private: false\n", "");
    const [b] = architectSourceBlocks(md(privateUrl), md(URLSRC));
    expect(b.change).toBe("changed");
    expect(b.warning).toBe("Private → Public: future evidence may show quotes and links");
  });

  it("nothing changed, or no sources at all, is an empty list; a removed source is listed", () => {
    expect(architectSourceBlocks(md(BF), md(BF))).toEqual([]);
    expect(architectSourceBlocks(md(), md())).toEqual([]);
    expect(architectSourceBlocks(md(BF), md())[0].change).toBe("removed");
  });

  it("text that can't be read has no blocks", () => {
    expect(architectSourceBlocks(null, "no frontmatter")).toEqual([]);
    expect(architectSourceBlocks("x", null as never)).toEqual([]);
  });
});

describe("changeAuthor", () => {
  it("names who made the change: the Architect, you, a shipped built-in version, else Manta", () => {
    expect(changeAuthor({ origin: { kind: "job", jobId: "j", rootJobId: "j", attempt: 1 } })).toBe("Architect");
    expect(changeAuthor({ origin: { kind: "restore", fromChangeId: "x" } })).toBe("You");
    expect(changeAuthor({ origin: { kind: "template-update", templateHash: "h" } })).toBe("Built-in update");
    expect(changeAuthor({ origin: { kind: "chat" } })).toBe("Manta");
  });
});
