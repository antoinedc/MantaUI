// Tasks an agent started from its own conversation (docs/superpowers/specs/2026-11-28-agent-chat-tasks.md §7,
// docs/screens/agents/chat-tasks-decisions.md §1): the pure view logic of their cards — which jobs they are, the words of each
// state (Fleet's words, never a second mapping), the model and branch lines, the result text without its server-written header,
// and what the user reads when the agent's call was refused (plain words; the agent's own sentence stays in the tooltip).
import { describe, expect, it } from "vitest";
import {
  chatTaskStatus,
  cleanResultText,
  friendlyRefusal,
  isChatTask,
  isChatTaskStartPart,
  modelLine,
  refusalOf,
  taskBranchLine,
} from "./chatTask";
import { endedBadge } from "./agents/fleetView";

const job = (over: Record<string, unknown> = {}) => ({ id: "j1", status: "running", ...over }) as never;

describe("isChatTask", () => {
  it("is a job started from an agent's conversation", () => {
    expect(isChatTask(job({ startedFrom: "agent-chat" }))).toBe(true);
    expect(isChatTask(job())).toBe(false);
    expect(isChatTask(job({ startedFrom: "mention" }))).toBe(false);
    expect(isChatTask(undefined)).toBe(false);
    expect(isChatTask(null)).toBe(false);
  });
});

describe("chatTaskStatus: Fleet's words", () => {
  it("a live card says In progress / Paused by you / the uncertain sentence / Failed to start / Starting…", () => {
    expect(chatTaskStatus({ kind: "running", paused: false })).toEqual({ label: "In progress", tone: "run" });
    expect(chatTaskStatus({ kind: "running", paused: true })).toEqual({ label: "Paused by you", tone: "" });
    expect(chatTaskStatus({ kind: "uncertain" })).toEqual({ label: "Couldn’t confirm this started — open the session to check", tone: "warn" });
    expect(chatTaskStatus({ kind: "failed" })).toEqual({ label: "Failed to start", tone: "bad" });
    expect(chatTaskStatus({ kind: "starting" })).toEqual({ label: "Starting…", tone: "run" });
    expect(chatTaskStatus({ kind: "settling" }).label).toBe("Wrapping up");
  });

  it("a finished card uses Fleet's endedBadge words for what the record says", () => {
    const words = (j: Record<string, unknown>) => chatTaskStatus({ kind: "ended", job: job(j) }).label;
    expect(words({ status: "done" })).toBe(endedBadge("done").label);
    expect(words({ status: "failed", error: "boom" })).toBe(endedBadge("didnt-finish").label);
    expect(words({ status: "failed", endReason: "stalled" })).toBe(endedBadge("didnt-finish").label);
    expect(words({ status: "failed", error: "interrupted by upgrade" })).toBe(endedBadge("interrupted").label);
    expect(words({ status: "stopped", error: "stopped by user" })).toBe(endedBadge("stopped").label);
    expect(words({ status: "stopped", error: "paused too long" })).toBe(endedBadge("interrupted").label);
    expect(words({ status: "done", endedBlocked: true })).toBe("Needs a decision");
  });

  it("tones follow the outcome: done ok, didn't finish bad, interrupted warn, stopped neutral, needs a decision warn", () => {
    const tone = (j: Record<string, unknown>) => chatTaskStatus({ kind: "ended", job: job(j) }).tone;
    expect(tone({ status: "done" })).toBe("ok");
    expect(tone({ status: "failed", error: "x" })).toBe("bad");
    expect(tone({ status: "failed", error: "interrupted" })).toBe("warn");
    expect(tone({ status: "stopped", error: "stopped by user" })).toBe("");
    expect(tone({ status: "done", endedBlocked: true })).toBe("warn");
  });

  it("a result with no job in the store is read from its own state", () => {
    expect(chatTaskStatus({ kind: "ended", state: "completed" }).label).toBe("Done");
    expect(chatTaskStatus({ kind: "ended", state: "failed" }).label).toBe("Didn’t finish");
    expect(chatTaskStatus({ kind: "ended", state: "stopped" }).label).toBe("Stopped by you");
    expect(chatTaskStatus({ kind: "ended", state: "completed", endedBlocked: true }).label).toBe("Needs a decision");
  });
});

describe("branch and model lines", () => {
  it("the branch, or 'read-only' when the task has none / isolation is none", () => {
    expect(taskBranchLine(job({ branch: "agent/dev/fix", isolation: "worktree" }))).toEqual({ kind: "branch", text: "agent/dev/fix" });
    expect(taskBranchLine(job({ branch: null, isolation: "none" }))).toEqual({ kind: "read-only", text: "read-only" });
    expect(taskBranchLine(job({ branch: "agent/dev/x", isolation: "none" }))).toEqual({ kind: "read-only", text: "read-only" });
    expect(taskBranchLine(job({ branch: null }))).toEqual({ kind: "read-only", text: "read-only" });
  });

  it("the model only once the task carries one (modelUsed, else the model it asked for)", () => {
    expect(modelLine(job())).toBeNull();
    expect(modelLine(job({ model: null }))).toBeNull();
    expect(modelLine(job({ model: "anthropic/claude-sonnet-5-5" }))).toBe("claude-sonnet-5-5");
    expect(modelLine(job({ model: "anthropic/claude-sonnet-5-5", modelUsed: "openai/gpt-6-sol" }))).toBe("gpt-6-sol");
  });
});

describe("cleanResultText: the card hides the server's header lines, the chip already says it", () => {
  it("drops a leading status line and a leading Project: line; the rest is the result", () => {
    expect(cleanResultText('[background job "fix-it" done]\nProject: Ronda\n\nThe test passed.')).toBe("The test passed.");
    expect(cleanResultText("Project: Ronda\n\nThe test passed.")).toBe("The test passed.");
    expect(cleanResultText('[background job "fix-it" needs a decision]\nProject: Ronda\nBranch: a (2 files changed)\n\nBody')).toBe("Branch: a (2 files changed)\n\nBody");
  });
  it("leaves any other text alone, including a Project: line that is not first", () => {
    expect(cleanResultText("The test passed.\nProject: Ronda")).toBe("The test passed.\nProject: Ronda");
    expect(cleanResultText("")).toBe("");
    expect(cleanResultText(undefined)).toBe("");
  });
});

describe("friendlyRefusal: the user reads plain words; the agent's sentence stays in the tooltip", () => {
  const plain = (s: string, project = "billing-service-0a1b2c3d4e") => friendlyRefusal(s, { project });
  it("an unknown project is named, never described with the agent's instruction", () => {
    expect(plain("No project with that id; call agent_projects and use an id from its list")).toBe("No project called “billing service” on this box");
    expect(plain("No project with that id; call agent_projects and use an id from its list", "Billing Service")).toBe("No project called “Billing Service” on this box");
    expect(plain("No project with that id; call agent_projects and use an id from its list", "")).toBe("No project like that on this box");
  });
  it("the ones already in plain words stay as they are", () => {
    for (const s of ["Atlas has no folder on this box", "Handing off is turned off in your autonomy settings", "Code changes are turned off in your autonomy settings", "Couldn't attach Ronda's notes to the task; nothing was sent to it", "Couldn't add Dev to Ronda: its seat folder or file is a link; nothing was started"]) expect(plain(s)).toBe(s);
  });
  it("model wording, declined and busy are said to the user, not to the agent", () => {
    expect(plain("The user declined the task")).toBe("You declined the task");
    expect(plain("deepseek/deepseek-chat can't run tasks; pick another model in this conversation or use Auto")).toBe("deepseek/deepseek-chat can’t run tasks. Pick another model in this conversation, or choose Auto.");
    expect(plain("All background slots on this box are busy right now, so do not do the work yourself: tell the user it is waiting, and hand it off again once a running task finishes.")).toBe("All background slots on this box are busy right now. It can start when one finishes.");
    expect(plain("Only an agent's own conversation can start tasks this way")).toBe("Tasks can only be started from an agent’s own conversation.");
    expect(plain("Couldn't verify this call; try again")).toBe("Couldn’t confirm the request. The agent can try again.");
    expect(plain("Write a brief and a title")).toBe("The agent sent no title or brief.");
    expect(plain("That task can't be continued from here")).toBe("That earlier task can’t be continued from here.");
    expect(plain("That task is in Ronda; continue it there or start a new task")).toBe("That earlier task is in Ronda, not in the project the agent chose.");
  });
  it("anything else that still speaks to the agent is replaced; nothing leaks an agent_ tool name", () => {
    expect(plain("something went wrong; call agent_projects again")).toBe("The request was refused.");
    expect(plain("Couldn't read the task list; try again")).toBe("Couldn't read the task list; try again");
  });
});

describe("the agent_start_task tool part", () => {
  const part = (state: Record<string, unknown>, tool = "agent_start_task") => ({ type: "tool", tool, callID: "c", state }) as never;
  it("is recognised by its tool name", () => {
    expect(isChatTaskStartPart(part({ status: "running" }))).toBe(true);
    expect(isChatTaskStartPart(part({ status: "running" }, "agent_projects"))).toBe(false);
    expect(isChatTaskStartPart({ type: "text", tool: "agent_start_task" } as never)).toBe(false);
  });
  it("refusalOf reads 'Not started: <error>' from a finished call, and nothing from a started one", () => {
    expect(refusalOf(part({ status: "completed", output: "Not started: Ronda has no folder on this box" }))).toBe("Ronda has no folder on this box");
    expect(refusalOf(part({ status: "completed", output: 'Started "Fix it" in Ronda (task j1, branch x). Its result will arrive as a later message; tell the user in one line which project you picked and stop.' }))).toBeNull();
    expect(refusalOf(part({ status: "running" }))).toBeNull();
    expect(refusalOf(part({ status: "error", error: "tool exploded" }))).toBe("tool exploded");
  });
});
