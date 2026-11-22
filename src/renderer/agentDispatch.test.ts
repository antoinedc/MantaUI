import { describe, it, expect } from "vitest";
import type { AgentInfo } from "../shared/types";
import {
  agentInitial,
  ONE_AGENT_ERROR,
  packageAgentDisplayName,
  pickAgentDispatch,
  usableAgents,
} from "./agentDispatch";

const agent = (slug: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  description: `${slug} agent`,
  isolation: "none",
  model: null,
  color: null,
  builtIn: false,
  ...over,
});
const m = (name: string) => ({ id: `m-${name}`, name });

const AGENTS = [agent("dev", { isolation: "worktree", builtIn: true }), agent("reviewer"), agent("broken", { error: "bad agent.md" })];

describe("usableAgents", () => {
  it("drops agents that failed to parse and tolerates no list", () => {
    expect(usableAgents(AGENTS).map((a) => a.slug)).toEqual(["dev", "reviewer"]);
    expect(usableAgents(null)).toEqual([]);
  });
});

describe("pickAgentDispatch", () => {
  it("is null without a package-agent mention (the normal send path)", () => {
    expect(pickAgentDispatch("just a question", [], AGENTS)).toBeNull();
    expect(pickAgentDispatch("ask @dev", [], AGENTS)).toBeNull(); // typed, never picked
    expect(pickAgentDispatch("ask @dev", [m("dev")], null)).toBeNull(); // agents not loaded
  });

  it("is null for an opencode agent mention (build/plan keep their own path)", () => {
    expect(pickAgentDispatch("@build fix it", [m("build")], AGENTS)).toBeNull();
  });

  it("returns the slug of the one mentioned package agent", () => {
    expect(pickAgentDispatch("@dev fix the login bug", [m("dev")], AGENTS)).toEqual({ slug: "dev" });
    expect(pickAgentDispatch("please @reviewer look", [m("reviewer"), m("build")], AGENTS)).toEqual({ slug: "reviewer" });
  });

  it("ignores a mention whose token was deleted or only prefixes another word", () => {
    expect(pickAgentDispatch("fix the login bug", [m("dev")], AGENTS)).toBeNull();
    expect(pickAgentDispatch("@developer fix", [m("dev")], AGENTS)).toBeNull();
  });

  it("refuses an invalid agent (not usable) by treating it as no agent", () => {
    expect(pickAgentDispatch("@broken do it", [m("broken")], AGENTS)).toBeNull();
  });

  it("refuses more than one distinct package agent", () => {
    expect(pickAgentDispatch("@dev and @reviewer", [m("dev"), m("reviewer")], AGENTS)).toEqual({ error: ONE_AGENT_ERROR });
  });

  it("the same agent mentioned twice is still one agent", () => {
    expect(pickAgentDispatch("@dev then @dev", [m("dev"), m("dev")], AGENTS)).toEqual({ slug: "dev" });
  });
});

describe("packageAgentDisplayName", () => {
  it("maps agent-<slug> to the agent's name, else the slug, else null", () => {
    expect(packageAgentDisplayName("agent-dev", AGENTS)).toBe("Dev");
    expect(packageAgentDisplayName("agent-gone", AGENTS)).toBe("gone");
    expect(packageAgentDisplayName("agent-dev", null)).toBe("dev");
    expect(packageAgentDisplayName("build", AGENTS)).toBeNull();
    expect(packageAgentDisplayName(undefined, AGENTS)).toBeNull();
  });
});

describe("agentInitial", () => {
  it("is the first letter of the name, upper-cased", () => {
    expect(agentInitial({ name: "reviewer", slug: "reviewer" })).toBe("R");
    expect(agentInitial({ name: "", slug: "dev" })).toBe("D");
  });
});
