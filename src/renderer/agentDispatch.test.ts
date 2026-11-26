import { describe, it, expect } from "vitest";
import type { AgentInfo } from "../shared/types";
import {
  agentMentionQuery,
  leadAgent,
  leadDisplayName,
  routineAgents,
  matchAgents,
  insertAgentMention,
  agentInitial,
  ONE_AGENT_ERROR,
  packageAgentDisplayName,
  pickAgentDispatch,
  usableAgents,
  agentPickerRows,
  agentSlugOf,
  isAgentTask,
  isTaskQuestionId,
  openQuestionCounts,
  resolvePickerProject,
  resolveTaskJob,
  rootJobOf,
  taskBriefOf,
  taskQuestionRequest,
} from "./agentDispatch";

const agent = (slug: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  description: `${slug} agent`,
  isolation: "none",
  model: null,
  color: null,
  builtIn: false,
  role: "specialist",
  useWhen: null,
  notFor: null,
  notice: null,
  ...over,
});
const m = (name: string) => ({ id: `m-${name}`, name });

const AGENTS = [agent("dev", { isolation: "worktree", builtIn: true }), agent("reviewer"), agent("broken", { error: "bad agent.md" })];

const MANTA = agent("manta", { name: "Manta", role: "lead" });

describe("the lead (Agents Phase 2)", () => {
  const withLead = [MANTA, ...AGENTS];
  it("is never offered as a dispatch target, in the typeahead helpers or by a typed @manta", () => {
    expect(usableAgents(withLead).map((a) => a.slug)).toEqual(["dev", "reviewer"]);
    expect(matchAgents(withLead, "ma")).toEqual([]);
    expect(pickAgentDispatch("@manta do it", [], withLead)).toBeNull();
    expect(pickAgentDispatch("@dev do it", [], withLead)).toEqual({ slug: "dev" });
  });
  it("a legacy specialist named manta stays dispatchable", () => {
    const legacy = agent("manta", { notice: "Rename this folder to enable the Manta lead" });
    expect(pickAgentDispatch("@manta hi", [], [legacy])).toEqual({ slug: "manta" });
  });
  it("leadAgent needs role lead and no error; leadDisplayName falls back to Manta", () => {
    expect(leadAgent(withLead)?.slug).toBe("manta");
    expect(leadAgent([agent("manta", { role: "lead", error: "Only the built-in Manta can lead" })])).toBeNull();
    expect(leadAgent(null)).toBeNull();
    expect(leadDisplayName(withLead)).toBe("Manta");
    expect(leadDisplayName([agent("manta", { role: "lead", name: "Boss" })])).toBe("Boss");
    expect(leadDisplayName(null)).toBe("Manta");
    expect(leadDisplayName(AGENTS)).toBe("Manta");
  });
  it("routineAgents are the valid specialists only", () => {
    expect(routineAgents([MANTA, ...AGENTS]).map((a) => a.slug)).toEqual(["dev", "reviewer"]);
    expect(routineAgents(null)).toEqual([]);
  });
});

describe("usableAgents", () => {
  it("drops agents that failed to parse and tolerates no list", () => {
    expect(usableAgents(AGENTS).map((a) => a.slug)).toEqual(["dev", "reviewer"]);
    expect(usableAgents(null)).toEqual([]);
  });
});

describe("pickAgentDispatch", () => {
  it("is null without a package-agent mention (the normal send path)", () => {
    expect(pickAgentDispatch("just a question", [], AGENTS)).toBeNull();
    expect(pickAgentDispatch("mail me at a@dev.io", [], AGENTS)).toBeNull(); // not a mention token
    expect(pickAgentDispatch("ask @dev", [m("dev")], null)).toBeNull(); // agents not loaded
  });

  it("dispatches a hand-typed @slug that was never picked from the popup", () => {
    expect(pickAgentDispatch("ask @dev to fix it", [], AGENTS)).toEqual({ slug: "dev" });
    expect(pickAgentDispatch("@dev and @reviewer", [], AGENTS)).toEqual({ error: ONE_AGENT_ERROR });
    expect(pickAgentDispatch("@broken do it", [], AGENTS)).toBeNull();
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

describe("new-session @agent suggestions", () => {
  it("finds the partial mention before the caret", () => {
    expect(agentMentionQuery("ask @se", 7)).toEqual({ query: "se", start: 4 });
    expect(agentMentionQuery("@", 1)).toEqual({ query: "", start: 0 });
    expect(agentMentionQuery("mail@se", 7)).toBeNull();
    expect(agentMentionQuery("@seo done", 9)).toBeNull();
  });
  it("matches by slug or name, skipping invalid agents", () => {
    expect(matchAgents(AGENTS, "d").map((a) => a.slug)).toEqual(["dev"]);
  });
  it("inserts the mention with a trailing space", () => {
    expect(insertAgentMention("ask @se", 4, 7, "seo")).toEqual({ text: "ask @seo ", caret: 9 });
  });
});

describe("the Architect (Agents Phase 5A)", () => {
  const ARCH = agent("architect", { name: "Architect", role: "architect" });
  const all = [MANTA, ARCH, ...AGENTS];
  it("is a team agent: offered in the @ picker and dispatchable, next to the others; the lead still isn't", () => {
    expect(usableAgents(all).map((a) => a.slug)).toEqual(["architect", "dev", "reviewer"]);
    expect(matchAgents(all, "arch").map((a) => a.slug)).toEqual(["architect"]);
    expect(pickAgentDispatch("@architect make me an agent", [], all)).toEqual({ slug: "architect" });
  });
  it("is never a routine agent (it works through tasks only, for now)", () => {
    expect(routineAgents(all).map((a) => a.slug)).toEqual(["dev", "reviewer"]);
  });
  it("an invalid Architect row is not a team agent", () => {
    expect(usableAgents([agent("architect", { role: "specialist", error: "Only the built-in Architect can have this role" })])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Agent screens: tasks, task questions, the @ picker
// ---------------------------------------------------------------------------

describe("task identity", () => {
  it("rootJobOf reads the root the box stamped, then the Architect stamp, then the job's own id", () => {
    expect(rootJobOf({ id: "j2", rootJobId: "j1" })).toBe("j1");
    expect(rootJobOf({ id: "j2", architect: { rootJobId: "j0" } })).toBe("j0");
    expect(rootJobOf({ id: "j2" })).toBe("j2");
  });

  it("isAgentTask / agentSlugOf follow the agent-<slug> key and nothing else", () => {
    expect(isAgentTask({ agent: "agent-seo" })).toBe(true);
    expect(isAgentTask({ agent: "explore" })).toBe(false);
    expect(isAgentTask({ agent: null })).toBe(false);
    expect(isAgentTask(undefined)).toBe(false);
    expect(agentSlugOf("agent-seo")).toBe("seo");
    expect(agentSlugOf("explore")).toBeNull();
    expect(agentSlugOf(undefined)).toBeNull();
  });

  it("resolveTaskJob finds the newest live round of the same task", () => {
    const jobs = {
      a: { id: "j1", createdAt: 1, supersededBy: "j2" },
      b: { id: "j2", rootJobId: "j1", createdAt: 5, attempt: 2 },
      c: { id: "x", createdAt: 9 },
    };
    expect(resolveTaskJob(jobs, "j1")?.id).toBe("j2");
    expect(resolveTaskJob(jobs, "j2")?.id).toBe("j2");
    expect(resolveTaskJob(jobs, "x")?.id).toBe("x");
  });

  it("resolveTaskJob still finds a later round when the first round's record is gone", () => {
    expect(resolveTaskJob({ b: { id: "j2", rootJobId: "j1", createdAt: 5 } }, "j1")?.id).toBe("j2");
  });

  it("resolveTaskJob is undefined for no id and for an unknown task", () => {
    expect(resolveTaskJob({ a: { id: "j1" } }, null)).toBeUndefined();
    expect(resolveTaskJob({ a: { id: "j1" } }, "nope")).toBeUndefined();
    expect(resolveTaskJob({}, "j1")).toBeUndefined();
  });

  it("taskBriefOf is the request as written, without the seat brief and the chat excerpt the box appends", () => {
    expect(taskBriefOf({ prompt: "Do the thing.\n\n---\nYour brief for this project:\nB\n\n---\nRecent conversation…\nX" })).toBe("Do the thing.");
    expect(taskBriefOf({ prompt: "Just this" })).toBe("Just this");
    expect(taskBriefOf({ prompt: "", request: "@seo check" })).toBe("@seo check");
    expect(taskBriefOf({})).toBe("");
  });
});

describe("task questions in the chat", () => {
  const tq = {
    id: "tq_ab12",
    rootJobId: "j1",
    jobId: "j1",
    parentSessionID: "ses_p",
    agentSlug: "seo",
    agentName: "SEO",
    project: null,
    taskName: "Check",
    questions: [
      { question: "Which pages?", options: [{ label: "Pricing", description: "d" }], multiple: true },
      { question: "How deep?", options: [], multiple: false },
    ],
    state: "open" as const,
    askedAt: 1,
    answeredAt: null,
    answer: null,
    delivery: null,
    delivering: null,
    error: null,
  };

  it("is told apart from the session's own questions by its tq_ prefix", () => {
    expect(isTaskQuestionId("tq_ab12")).toBe(true);
    expect(isTaskQuestionId("que_1")).toBe(false);
    expect(isTaskQuestionId("call_9")).toBe(false);
    expect(isTaskQuestionId(undefined)).toBe(false);
  });

  it("becomes a question request for the owning chat, headed '<Agent> asks you', free text allowed", () => {
    const req = taskQuestionRequest(tq);
    expect(req.id).toBe("tq_ab12");
    expect(req.sessionID).toBe("ses_p");
    expect(req.requestId).toBeUndefined();
    expect(req.questions.map((q) => q.header)).toEqual(["SEO asks you", "SEO asks you"]);
    expect(req.questions[0]).toMatchObject({ question: "Which pages?", multiple: true, custom: true });
    expect(req.questions[0].options).toEqual([{ label: "Pricing", description: "d" }]);
  });

  it("counts open questions per task", () => {
    const counts = openQuestionCounts([
      { rootJobId: "j1", state: "open" },
      { rootJobId: "j1", state: "open" },
      { rootJobId: "j2", state: "open" },
      { rootJobId: "j3", state: "answered" },
    ]);
    expect(counts.get("j1")).toBe(2);
    expect(counts.get("j2")).toBe(1);
    expect(counts.has("j3")).toBe(false);
  });
});

describe("the @ picker (agent screens §2.3)", () => {
  const SITE = { slug: "site-aaaaaaaaaa", name: "Site" };
  const ARCH = agent("architect", { name: "Architect", role: "architect" });
  const seo = agent("seo", { name: "SEO", seats: [SITE.slug] });
  const sales = agent("sales", { name: "Sales", seats: [] });
  const dev = agent("dev", { name: "Dev" }); // an older box: no seats field

  it("seated-here agents come first, then the rest by name", () => {
    const rows = agentPickerRows([sales, dev, ARCH, seo], "", SITE);
    expect(rows.map((r) => r.agent.slug)).toEqual(["seo", "architect", "dev", "sales"]);
  });

  it("a specialist reads 'seated here' or 'adds to <Project>'", () => {
    const rows = agentPickerRows([seo, sales, dev], "", SITE);
    expect(rows.find((r) => r.agent.slug === "seo")?.pill).toBe("seated here");
    expect(rows.find((r) => r.agent.slug === "sales")?.pill).toBe("adds to Site");
    expect(rows.find((r) => r.agent.slug === "dev")?.pill).toBe("adds to Site");
  });

  it("the Architect and the lead have no seats, so no pill", () => {
    const lead = agent("manta", { name: "Manta", role: "lead" });
    const rows = agentPickerRows([ARCH, lead, seo], "", SITE);
    expect(rows.find((r) => r.agent.slug === "architect")?.pill).toBeNull();
    expect(rows.find((r) => r.agent.slug === "architect")).toBeTruthy(); // it stays in the list
    // the lead is never a dispatch target, so it is not offered either (usableAgents)
    expect(rows.find((r) => r.agent.slug === "manta")).toBeUndefined();
  });

  it("no pill at all when the chat's project is unknown", () => {
    const rows = agentPickerRows([seo, sales], "", null);
    expect(rows.map((r) => r.pill)).toEqual([null, null]);
    expect(rows.map((r) => r.agent.slug)).toEqual(["sales", "seo"]);
  });

  it("filters by the typed name or slug, keeping the order", () => {
    expect(agentPickerRows([seo, sales, dev], "se", SITE).map((r) => r.agent.slug)).toEqual(["seo"]);
    expect(agentPickerRows([seo, sales, dev], "", SITE).length).toBe(3);
    expect(agentPickerRows([seo, sales, dev], "zzz", SITE)).toEqual([]);
  });

  it("an invalid agent is not offered", () => {
    expect(agentPickerRows([agent("broken", { error: "bad" }), seo], "", SITE).map((r) => r.agent.slug)).toEqual(["seo"]);
  });
});

describe("resolvePickerProject", () => {
  const projects = [
    { slug: "site-aaaaaaaaaa", name: "Site" },
    { slug: "api-bbbbbbbbbb", name: "API" },
    { slug: "api-cccccccccc", name: "api" },
  ];

  it("matches the folder's name to a registry project's name, case-insensitively", () => {
    expect(resolvePickerProject("/home/dev/projects/site", projects)).toEqual(projects[0]);
    expect(resolvePickerProject("/home/dev/projects/site/", projects)).toEqual(projects[0]);
  });

  it("matches the slug's name part too", () => {
    expect(resolvePickerProject("/w/Site", [{ slug: "site-aaaaaaaaaa", name: "The site" }])).toEqual({ slug: "site-aaaaaaaaaa", name: "The site" });
  });

  it("is null when nothing matches or more than one project does (never a guess)", () => {
    expect(resolvePickerProject("/home/dev/projects/other", projects)).toBeNull();
    expect(resolvePickerProject("/home/dev/projects/api", projects)).toBeNull();
    expect(resolvePickerProject("", projects)).toBeNull();
    expect(resolvePickerProject("/x", null)).toBeNull();
    expect(resolvePickerProject("/x", [])).toBeNull();
  });
});
