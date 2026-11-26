// The "agents" demo fixture state (docs/screens/agents): the agent pages' own data — the agents on the box, what needs the
// user, the fleet grid, one agent's profile and history — served only in that state so no other baseline moves. Timestamps
// that a page prints as ages are relative to "now"; the ones it prints as dates are fixed, and the recap has no earlier visit,
// so a capture reads the same whenever it is taken.

import type { AgentChange, AgentFleet, AgentInfo, AgentProfile, NeedsYou, TaskQuestion } from "../../shared/types.js";

const HOUR = 3_600_000;
const MIN = 60_000;
const at = (d: number, h = 12): number => Date.UTC(2025, 9, d, h);

const agent = (slug: string, name: string, color: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug,
  name,
  description: `${name}.`,
  isolation: "none",
  model: null,
  color,
  builtIn: false,
  role: "specialist",
  useWhen: null,
  notFor: null,
  notice: null,
  seats: [],
  ...over,
});

export const demoAgentList: AgentInfo[] = [
  agent("manta", "Manta", "oklch(60% 0.15 285)", { role: "lead", builtIn: true, description: "Leads every chat and hands work to the other agents." }),
  agent("dev", "Dev", "oklch(62% 0.14 250)", { builtIn: true, isolation: "worktree", description: "Writes and fixes code on its own branch.", seats: ["manta-0a1b2c3d4e", "ronda-1b2c3d4e5f"] }),
  agent("seo", "SEO", "oklch(62% 0.14 160)", {
    description: "Technical SEO and visibility in AI search (ChatGPT, Perplexity, AI Overviews) for marketing sites: audits, structured data, internal links, content briefs. Measures visibility over many runs, never a single \"rank\".",
    useWhen: "A page's ranking, markup or AI-search visibility is the question",
    notFor: "Rewriting brand copy, buying links, touching app code",
    seats: ["manta-0a1b2c3d4e", "ronda-1b2c3d4e5f"],
  }),
  agent("design", "Design", "oklch(66% 0.14 25)", { seats: ["manta-0a1b2c3d4e"] }),
  agent("sales", "Sales", "oklch(64% 0.13 60)", { seats: ["tenanture-2c3d4e5f6a", "capo-3d4e5f6a7b"] }),
  agent("architect", "Architect", "oklch(58% 0.12 320)", { role: "architect", builtIn: true, description: "Builds and improves agents as tasks Manta hands it." }),
];

const question = (now: number): TaskQuestion => ({
  id: "tq_demo0000000000a1",
  rootJobId: "job-sales",
  jobId: "job-sales",
  parentSessionID: "ses_demo",
  agentSlug: "sales",
  agentName: "Sales",
  project: "tenanture-2c3d4e5f6a",
  taskName: "Lead research",
  questions: [
    {
      question: "Which segment first for outbound: landlords with under 10 units, or property managers?",
      options: [
        { label: "Small landlords (Recommended)", description: "Faster to reach, smaller deals" },
        { label: "Property managers", description: "Slower cycle, bigger accounts" },
      ],
      multiple: false,
    },
  ],
  state: "open",
  askedAt: now - 3 * HOUR,
  answeredAt: null,
  answer: null,
  delivery: null,
  delivering: null,
  error: null,
});

const NEW_AGENT_MD = "---\nname: Pricing CTA Copy\ndescription: Writes and tests the call-to-action text on the pricing page.\nisolation: none\n---\nRewrite the pricing page's call-to-action text. Never change prices or layout.";

const change = (over: Partial<AgentChange>): AgentChange => ({
  id: "chg_demo",
  kind: "update",
  slug: "seo",
  agentName: "SEO",
  sessionID: "ses_demo",
  messageID: "msg_demo",
  callID: "call_demo",
  state: "applied",
  needsClick: false,
  reason: null,
  before: null,
  after: NEW_AGENT_MD,
  createdAt: at(12),
  decidedAt: at(12),
  error: null,
  origin: { kind: "job", jobId: "job-arch", rootJobId: "job-arch", attempt: 1 },
  mode: "build",
  releasedAt: at(12),
  decidedBy: "auto",
  summary: null,
  evidence: [],
  admission: [],
  ...over,
});

export function demoNeedsYou(now: number): NeedsYou {
  const pending = change({
    id: "chg_pricing",
    kind: "create",
    slug: "pricing-cta-copy",
    agentName: "Pricing CTA Copy",
    state: "pending",
    needsClick: true,
    reason: "plan",
    createdAt: now - 20 * MIN,
    decidedAt: null,
    decidedBy: null,
    summary: "A dedicated agent for the pricing-page CTA text.",
  });
  return {
    questions: [question(now)],
    changes: [pending],
    reviews: [
      {
        jobId: "job-dev",
        agentSlug: "dev",
        project: "manta-0a1b2c3d4e",
        name: "Explorer: 0-byte file crash",
        finishedAt: now - 40 * MIN,
        filesChanged: 3,
        branch: "agent/dev/0-byte",
        resultText: "Fixed the crash when opening a 0-byte file and added a regression test.",
      },
    ],
    count: 3,
  };
}

export function demoFleet(now: number): AgentFleet {
  const cell = (jobId: string, title: string, state: "working" | "needs-you" | "done" | "failed" | "idle", detail: string) => ({ jobId, title, at: now, state, detail });
  return {
    asOf: now,
    projects: [
      { slug: "manta-0a1b2c3d4e", name: "Manta" },
      { slug: "ronda-1b2c3d4e5f", name: "Ronda" },
      { slug: "tenanture-2c3d4e5f6a", name: "Tenanture" },
      { slug: "capo-3d4e5f6a7b", name: "Capo" },
    ],
    rows: [
      { slug: "dev", name: "Dev", color: "oklch(62% 0.14 250)", seats: [], tasksThisWeek: 14, cells: { "manta-0a1b2c3d4e": cell("job-dev1", "Explorer: 0-byte file crash", "working", "6m"), "ronda-1b2c3d4e5f": cell("job-dev2", "Editor undo stack", "done", "ready for review"), "tenanture-2c3d4e5f6a": null, "capo-3d4e5f6a7b": cell("", "Idle", "idle", "last task 3d ago") } },
      { slug: "seo", name: "SEO", color: "oklch(62% 0.14 160)", seats: [], tasksThisWeek: 7, cells: { "manta-0a1b2c3d4e": cell("job-seo1", "Pricing + vs-* audit", "working", "4/7 · 1 question"), "ronda-1b2c3d4e5f": cell("job-seo2", "Weekly audit", "done", "11 issues"), "tenanture-2c3d4e5f6a": cell("", "Idle", "idle", "weekly audit Mon"), "capo-3d4e5f6a7b": null } },
      { slug: "design", name: "Design", color: "oklch(66% 0.14 25)", seats: [], tasksThisWeek: 4, cells: { "manta-0a1b2c3d4e": cell("job-des1", "Hero redesign", "needs-you", ""), "ronda-1b2c3d4e5f": null, "tenanture-2c3d4e5f6a": null, "capo-3d4e5f6a7b": null } },
      { slug: "sales", name: "Sales", color: "oklch(64% 0.13 60)", seats: [], tasksThisWeek: 11, cells: { "manta-0a1b2c3d4e": null, "ronda-1b2c3d4e5f": null, "tenanture-2c3d4e5f6a": cell("job-sal1", "Lead research", "working", "1 question"), "capo-3d4e5f6a7b": cell("job-sal2", "Sequence follow-ups", "failed", "Gmail token") } },
    ],
    week: { tasks: 36 },
    recap: {
      since: null,
      lines: ["Manta handed 9 requests to agents", "Dev finished 2 tasks in Manta", "SEO finished 1 task in Ronda", "Sales failed 1 task", "Architect updated @seo (your setting: Tell me)"],
    },
  };
}

const MEMORY = [
  { label: "SEO know-how", access: "read" as const, note: "changed only through change cards" },
  { label: "Research library", access: "read" as const, note: "shared by all agents" },
  { label: "Manta memory", access: "read-write" as const, note: "shared with other agents in Manta" },
  { label: "Other projects' memory", access: "none" as const, note: "only if they share" },
];

export function demoProfile(slug: string): AgentProfile {
  const info = demoAgentList.find((a) => a.slug === slug) ?? demoAgentList[2];
  return {
    info,
    seats: [
      { project: "manta-0a1b2c3d4e", projectName: "Manta", brief: "Audit the marketing site and the vs-* comparison pages.", addedAt: at(1), addedBy: "user", notes: 23, memory: MEMORY },
      { project: "ronda-1b2c3d4e5f", projectName: "Ronda", brief: "Weekly audit of the public pages.", addedAt: at(8), addedBy: "mention", notes: 41, memory: MEMORY },
    ],
    lastChangedAt: at(12),
    builtBy: "architect",
    refresh: { enabled: true, routineId: "rt_demo" },
    research: [
      { id: "r1", topic: "Technical SEO for AI search", sourceCount: 5, ageDays: 3, status: "fresh", thin: false },
      { id: "r2", topic: "Structured data for product pages", sourceCount: 4, ageDays: 12, status: "fresh", thin: false },
      { id: "r3", topic: "AI crawler access rules", sourceCount: 4, ageDays: 41, status: "stale", thin: false },
      { id: "r4", topic: "llms.txt adoption", sourceCount: 2, ageDays: 6, status: "fresh", thin: true },
    ],
  };
}

export function demoHistory(now: number): AgentChange[] {
  return [
    change({
      id: "chg_pending",
      state: "pending",
      needsClick: true,
      reason: "ask",
      before: "V1",
      after: NEW_AGENT_MD,
      createdAt: now - 12 * MIN,
      decidedAt: null,
      decidedBy: null,
      summary: "Adds an llms.txt check and drops 2 crawler rules that no longer hold.",
    }),
    change({ id: "chg_3", before: "V2", after: NEW_AGENT_MD, createdAt: at(12), decidedAt: at(12), summary: "Added rules for how AI search engines read pages." }),
    change({ id: "chg_2", before: "V1", after: "V2", origin: { kind: "chat" }, decidedBy: "click", createdAt: at(3), decidedAt: at(3), summary: "Asks before changing redirects." }),
    change({ id: "chg_1", kind: "create", before: null, after: "V1", createdAt: at(1), decidedAt: at(1), summary: "Created @seo." }),
  ];
}

const ok = <T>(v: T) => () => Promise.resolve(v);

/** The methods the "agents" state answers; every other agent channel keeps the Proxy fallback (null). */
export const demoAgentsApi = {
  agentsList: ok(demoAgentList),
  agentsNeedsYou: () => Promise.resolve(demoNeedsYou(Date.now())),
  agentsFleet: () => Promise.resolve(demoFleet(Date.now())),
  agentsFleetSeen: ok({ ok: true as const }),
  agentsProfile: (input: { slug: string }) => Promise.resolve(demoProfile(input?.slug ?? "seo")),
  agentsHistory: () => Promise.resolve(demoHistory(Date.now())),
  agentsProjects: ok([
    { slug: "manta-0a1b2c3d4e", name: "Manta" },
    { slug: "ronda-1b2c3d4e5f", name: "Ronda" },
    { slug: "tenanture-2c3d4e5f6a", name: "Tenanture" },
    { slug: "capo-3d4e5f6a7b", name: "Capo" },
  ]),
  agentsQuestions: ok([]),
  agentsTaskResearch: ok([]),
  agentsChangesForJob: ok([]),
  agentsOpenChat: () => Promise.reject(new Error("Not available in the demo.")),
  agentsQuestionAnswer: () => Promise.reject(new Error("Not available in the demo.")),
  agentsQuestionDismiss: () => Promise.reject(new Error("Not available in the demo.")),
  agentsChangeApply: () => Promise.reject(new Error("Not available in the demo.")),
  agentsChangeDiscard: () => Promise.reject(new Error("Not available in the demo.")),
  agentsChangeUndo: () => Promise.reject(new Error("Not available in the demo.")),
  agentsChangeRestore: () => Promise.reject(new Error("Not available in the demo.")),
  agentsReviewDone: () => Promise.reject(new Error("Not available in the demo.")),
  agentsSeatAdd: () => Promise.reject(new Error("Not available in the demo.")),
  agentsSeatSet: () => Promise.reject(new Error("Not available in the demo.")),
  agentsSeatRemove: () => Promise.reject(new Error("Not available in the demo.")),
  agentsRefreshSet: () => Promise.reject(new Error("Not available in the demo.")),
} as const;
