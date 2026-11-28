// Pure logic of the sidebar's Team section (docs/superpowers/specs/2026-11-28-agent-profile-redesign.md §7).

import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../shared/types";
import { agentOfSession, teamAgents, teamWindowsKey, windowOfAgent } from "./teamView";

const agent = (slug: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  description: "d",
  isolation: "worktree",
  model: null,
  color: null,
  builtIn: false,
  role: "specialist",
  useWhen: null,
  notFor: null,
  notice: null,
  ...over,
});

describe("teamAgents", () => {
  it("one row per valid agent except the Architect, the lead first, the box's order otherwise", () => {
    const list = [agent("dev"), agent("architect", { role: "architect" }), agent("broken", { error: "no description" }), agent("manta", { role: "lead" }), agent("designer")];
    expect(teamAgents(list).map((a) => a.slug)).toEqual(["manta", "dev", "designer"]);
  });
  it("nothing before the list arrives, on an older box, or with no agents", () => {
    expect(teamAgents(null)).toEqual([]);
    expect(teamAgents(undefined)).toEqual([]);
    expect(teamAgents([])).toEqual([]);
  });
});

describe("which window is whose", () => {
  const windows = [
    { index: 0, opencodeSessionId: "ses_a" },
    { index: 4, opencodeSessionId: "ses_b" },
    { index: 5, opencodeSessionId: null },
  ];
  it("an agent's window is the one carrying its stored conversation — never matched by name", () => {
    expect(windowOfAgent(windows, "ses_b")?.index).toBe(4);
    expect(windowOfAgent(windows, "ses_zzz")).toBeNull();
    expect(windowOfAgent(windows, null)).toBeNull();
    expect(windowOfAgent(windows, undefined)).toBeNull();
    expect(windowOfAgent(undefined, "ses_a")).toBeNull();
  });
  it("the key changes when a conversation's window appears, goes or is re-stamped (a Clear)", () => {
    expect(teamWindowsKey(windows)).not.toBe(teamWindowsKey([...windows, { index: 6, opencodeSessionId: "ses_c" }]));
    expect(teamWindowsKey(windows)).not.toBe(teamWindowsKey([{ index: 0, opencodeSessionId: "ses_new" }, windows[1], windows[2]]));
    expect(teamWindowsKey(windows)).toBe(teamWindowsKey(windows.map((w) => ({ ...w }))));
    expect(teamWindowsKey(undefined)).toBe("");
  });
  it("a conversation's agent, from the stored chats", () => {
    const agents = [agent("dev"), agent("manta", { role: "lead", name: "Manta" })];
    expect(agentOfSession("ses_dev", { dev: "ses_dev" }, agents)).toEqual({ slug: "dev", name: "Dev" });
    expect(agentOfSession("ses_x", { dev: "ses_dev" }, agents)).toBeNull();
    expect(agentOfSession(null, { dev: "ses_dev" }, agents)).toBeNull();
    expect(agentOfSession("ses_dev", {}, agents)).toBeNull();
    expect(agentOfSession("ses_dev", { dev: "ses_dev" }, null)).toBeNull();
    expect(agentOfSession("ses_dev", null, agents)).toBeNull();
  });
});
