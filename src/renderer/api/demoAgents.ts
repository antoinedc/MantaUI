// The "agents" demo fixture state (docs/screens/agents, docs/screens/fleet): the agent pages' own data — the agents on the box, what needs the
// user, the Fleet page's tasks (and the older fleet grid the profile still reads), one agent's profile and history — served only in that state so no other baseline moves. Timestamps
// that a page prints as ages are relative to "now"; the ones it prints as dates are fixed, and the recap has no earlier visit,
// so a capture reads the same whenever it is taken.

import { nowMs } from "../clock.js";
import type { AgentChange, AgentFleet, AgentInfo, AgentProfile, FleetEnded, FleetTask, FleetTasks, NeedsYou, TaskQuestion } from "../../shared/types.js";

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

const SEO_HEAD = "---\nname: SEO\ndescription: Technical SEO and visibility in AI search for marketing sites.\nisolation: none\n---\n";
const seoMd = (...rules: string[]): string => `${SEO_HEAD}${rules.map((r) => `- ${r}`).join("\n")}\n`;
const SEO_RULES = {
  audit: "Audit one page type at a time and list every finding with its URL.",
  hreflang: "Check hreflang pairs on every localised page.",
  redirects: "Ask before changing redirects.",
  crawl: "Read how each AI crawler fetches pages before changing robots.txt.",
  gptbot: "Block GPTBot in robots.txt on staging only.",
  ccbot: "Block CCBot in robots.txt on every host.",
  llms: "Check that llms.txt is served at the site root and lists the key pages.",
};
/** The instructions the demo profile's Overview draws: three sections, so the Sections index shows. */
const SEO_INSTRUCTIONS = [
  "You are SEO. You audit marketing sites for visibility in AI search and report what you find.",
  "",
  "## How you work",
  "",
  `- ${SEO_RULES.audit}`,
  `- ${SEO_RULES.hreflang}`,
  `- ${SEO_RULES.crawl}`,
  "",
  "## Before you change anything",
  "",
  `- **${SEO_RULES.redirects}**`,
  "- Say what you would change and why, with the page it affects.",
  "",
  "## What you never do",
  "",
  "- Publish, buy links or rewrite brand copy.",
  "- Present a single \"rank\" as a measurement: visibility is measured over many runs.",
  "",
].join("\n");

const SEO_V1 = seoMd(SEO_RULES.audit, SEO_RULES.hreflang);
const SEO_V2 = seoMd(SEO_RULES.audit, SEO_RULES.hreflang, SEO_RULES.redirects);
const SEO_V3 = seoMd(SEO_RULES.audit, SEO_RULES.hreflang, SEO_RULES.redirects, SEO_RULES.crawl, SEO_RULES.gptbot, SEO_RULES.ccbot);
const SEO_V4 = seoMd(SEO_RULES.audit, SEO_RULES.hreflang, SEO_RULES.redirects, SEO_RULES.crawl, SEO_RULES.llms);
const SEO_NO_HREFLANG = seoMd(SEO_RULES.audit); // what the undone change would have made

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
    changeProjects: { chg_pricing: "manta-0a1b2c3d4e" },
    reviews: [
      {
        jobId: "job-dev",
        agentSlug: "dev",
        project: "capo-3d4e5f6a7b",
        name: "Test transcript exports with real audio",
        finishedAt: now - 2 * HOUR,
        filesChanged: 1,
        branch: null,
        resultText: "It ran out of time while transcribing the sample audio.",
        reason: "Needs a decision",
        endedBlocked: true,
      },
    ],
    count: 3,
  };
}

/** The Fleet page's read: tasks in progress (one paused by the user) and what ended today, across three projects. */
export function demoFleetTasks(now: number): FleetTasks {
  const run = (over: Partial<FleetTask> & Pick<FleetTask, "jobId" | "title" | "agentSlug" | "project" | "projectName">): FleetTask => ({
    rootJobId: over.jobId,
    startedAt: now - 20 * MIN,
    branch: null,
    askedBy: { by: "you" },
    status: "in-progress",
    pausedAt: null,
    ...over,
  });
  const end = (over: Partial<FleetEnded> & Pick<FleetEnded, "jobId" | "title" | "agentSlug" | "outcome" | "sentence">): FleetEnded => ({
    rootJobId: over.jobId,
    project: "manta-0a1b2c3d4e",
    projectName: "Manta",
    startedAt: now - 3 * HOUR,
    branch: null,
    askedBy: { by: "you" },
    endedAt: now - HOUR,
    facts: "No files changed",
    ...over,
  });
  return {
    asOf: now,
    running: [
      run({ jobId: "job-dev1", title: "Let Manta hand work to agents more than once per request", agentSlug: "dev", project: "manta-0a1b2c3d4e", projectName: "Manta", askedBy: { by: "manta", sessionId: null }, branch: "agent/dev/handoff-limit" }),
      run({ jobId: "job-seo1", title: "Pricing + vs-* audit", agentSlug: "seo", project: "manta-0a1b2c3d4e", projectName: "Manta" }),
      run({ jobId: "job-sal1", title: "Lead research", agentSlug: "sales", project: "tenanture-2c3d4e5f6a", projectName: "Tenanture" }),
      run({ jobId: "job-dev3", title: "Add speaker names to transcript exports", agentSlug: "dev", project: "capo-3d4e5f6a7b", projectName: "Capo", status: "paused-by-you", pausedAt: now - 3 * HOUR }),
    ],
    ended: [
      end({ jobId: "job-end1", title: "Give skill trials more disk space", agentSlug: "dev", outcome: "done", sentence: "Its changes are in the project.", endedAt: now - 40 * MIN, branch: "agent/dev/trial-volume", facts: "6 files changed · branch agent/dev/trial-volume (in the project)" }),
      end({ jobId: "job-end2", title: "Write the release notes for the next update", agentSlug: "dev", outcome: "didnt-finish", sentence: "It ran out of time.", endedAt: now - HOUR, facts: "Hit its time limit · No files changed" }),
      end({ jobId: "job-end3", title: "Refresh the notes on supervising several agents", agentSlug: "architect", outcome: "interrupted", sentence: "It was cut off when the box restarted.", endedAt: now - 2 * HOUR, facts: "Failed: interrupted" }),
      end({ jobId: "job-end4", title: "Review the pricing page wording", agentSlug: "design", outcome: "stopped", sentence: "You stopped it. What it had done so far is kept.", endedAt: now - 3 * HOUR, facts: "Stopped by you" }),
    ],
    cap: 10,
    full: false,
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
      { slug: "dev", name: "Dev", color: "oklch(62% 0.14 250)", seats: [], tasksThisWeek: 14, cells: { "manta-0a1b2c3d4e": cell("job-dev1", "Explorer: 0-byte file crash", "working", "6m"), "ronda-1b2c3d4e5f": cell("job-dev2", "Editor undo stack", "done", "5 files changed"), "tenanture-2c3d4e5f6a": null, "capo-3d4e5f6a7b": cell("", "Idle", "idle", "last task 3d ago") } },
      { slug: "seo", name: "SEO", color: "oklch(62% 0.14 160)", seats: [], tasksThisWeek: 7, cells: { "manta-0a1b2c3d4e": cell("job-seo1", "Pricing + vs-* audit", "working", "4/7 · 1 question"), "ronda-1b2c3d4e5f": cell("job-seo2", "Weekly audit", "done", "11 issues"), "tenanture-2c3d4e5f6a": cell("", "Idle", "idle", "weekly audit Mon"), "capo-3d4e5f6a7b": null } },
      { slug: "design", name: "Design", color: "oklch(66% 0.14 25)", seats: [], tasksThisWeek: 4, cells: { "manta-0a1b2c3d4e": cell("job-des1", "Hero redesign", "needs-you", "Needs a decision"), "ronda-1b2c3d4e5f": null, "tenanture-2c3d4e5f6a": null, "capo-3d4e5f6a7b": null } },
      { slug: "sales", name: "Sales", color: "oklch(64% 0.13 60)", seats: [], tasksThisWeek: 11, cells: { "manta-0a1b2c3d4e": null, "ronda-1b2c3d4e5f": null, "tenanture-2c3d4e5f6a": cell("job-sal1", "Lead research", "working", "1 question"), "capo-3d4e5f6a7b": cell("job-sal2", "Sequence follow-ups", "failed", "Gmail token") } },
    ],
    week: { tasks: 36 },
    recap: {
      since: null,
      lines: ["Manta handed 9 requests to agents", "Dev finished 3 tasks Manta handed off", "SEO finished 1 task in Ronda", "Sales failed 1 task", "2 branches from Manta-handed tasks still unmerged"],
    },
  };
}

const memoryOf = (projectName: string) => [
  { label: "SEO know-how", access: "read" as const, note: "changed only through change cards" },
  { label: "Research library", access: "read" as const, note: "shared by all agents" },
  { label: `${projectName} memory`, access: "read-write" as const, note: `shared with other agents in ${projectName}` },
  { label: "Other projects' memory", access: "none" as const, note: "only if they share" },
];

export function demoProfile(slug: string): AgentProfile {
  const info = demoAgentList.find((a) => a.slug === slug) ?? demoAgentList[2];
  return {
    info,
    seats: [
      { project: "manta-0a1b2c3d4e", projectName: "Manta", brief: "Audit the marketing site and the vs-* comparison pages.", addedAt: at(1), addedBy: "user", notes: 23, memory: memoryOf("Manta") },
      { project: "ronda-1b2c3d4e5f", projectName: "Ronda", brief: "Weekly audit of the public pages.", addedAt: at(8), addedBy: "mention", notes: 41, memory: memoryOf("Ronda") },
    ],
    lastChangedAt: at(12),
    builtBy: "architect",
    refresh: { enabled: true, routineId: "rt_demo", day: 12 },
    instructions: SEO_INSTRUCTIONS,
    research: [
      {
        id: "r1",
        topic: "Technical SEO for AI search",
        sourceCount: 5,
        ageDays: 3,
        status: "fresh",
        thin: false,
        usedBy: ["Conversion"],
        sources: [
          { label: "developers.google.com", url: "https://developers.google.com/search/docs/appearance/ai-features" },
          { label: "openai.com", url: "https://openai.com/index/chatgpt-search-for-publishers" },
          { label: "docs.perplexity.ai", url: "https://docs.perplexity.ai/guides/bots" },
          { label: "ahrefs.com", url: "https://ahrefs.com/blog/ai-overviews" },
          { label: "searchengineland.com", url: "https://searchengineland.com/ranking-in-ai-overviews" },
        ],
      },
      {
        id: "r2",
        topic: "Structured data for product pages",
        sourceCount: 4,
        ageDays: 12,
        status: "fresh",
        thin: false,
        sources: [
          { label: "developers.google.com", url: "https://developers.google.com/search/docs/appearance/structured-data/product" },
          { label: "schema.org", url: "https://schema.org/Product" },
          { label: "web.dev", url: "https://web.dev/articles/structured-data" },
          { label: "moz.com", url: "https://moz.com/learn/seo/schema-structured-data" },
        ],
      },
      {
        id: "r3",
        topic: "AI crawler access rules",
        sourceCount: 4,
        ageDays: 41,
        status: "stale",
        thin: false,
        usedBy: ["Security"],
        sources: [
          { label: "platform.openai.com", url: "https://platform.openai.com/docs/bots" },
          { label: "developers.google.com", url: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers" },
          { label: "darkvisitors.com", url: "https://darkvisitors.com/agents" },
          { label: "cloudflare.com", url: "https://blog.cloudflare.com/ai-crawler-report" },
        ],
      },
      {
        id: "r4",
        topic: "llms.txt adoption",
        sourceCount: 2,
        ageDays: 6,
        status: "fresh",
        thin: true,
        privateSources: 1,
        sources: [
          { label: "llmstxt.org", url: "https://llmstxt.org" },
          { label: "github.com", url: "https://github.com/thedaviddias/llms-txt-hub" },
        ],
      },
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
      before: SEO_V3,
      after: SEO_V4,
      createdAt: now - 12 * MIN,
      decidedAt: null,
      decidedBy: null,
      summary: "Adds an llms.txt check and drops 2 crawler rules that no longer hold.",
      evidence: [
        { claim: "GPTBot and CCBot rules in robots.txt no longer match how the crawlers identify themselves.", quote: null, url: "https://example.com/ai-crawler-access-rules", private: false },
        { claim: "AI search engines look for llms.txt at the site root.", quote: null, url: "https://example.com/llms-txt", private: false },
      ],
    }),
    change({ id: "chg_3", before: SEO_V2, after: SEO_V3, createdAt: at(12), decidedAt: at(12), summary: "Added rules for how AI search engines read pages." }),
    change({ id: "chg_2", before: SEO_V1, after: SEO_V2, origin: { kind: "chat" }, decidedBy: "click", createdAt: at(3), decidedAt: at(3), summary: "Asks before changing redirects." }),
    change({ id: "chg_undone", before: SEO_V1, after: SEO_NO_HREFLANG, state: "undone", decidedBy: "click", createdAt: at(2), decidedAt: at(2), summary: "Dropped the hreflang check." }),
    change({ id: "chg_1", kind: "create", before: null, after: SEO_V1, createdAt: at(1), decidedAt: at(1), summary: "Created @seo." }),
  ];
}

const ok = <T>(v: T) => () => Promise.resolve(v);

/** The methods the "agents" state answers; every other agent channel keeps the Proxy fallback (null). */
export const demoAgentsApi = {
  agentsList: ok(demoAgentList),
  agentsNeedsYou: () => Promise.resolve(demoNeedsYou(nowMs())),
  agentsTasks: () => Promise.resolve(demoFleetTasks(nowMs())),
  delegateStop: () => Promise.reject(new Error("Not available in the demo.")),
  delegateResume: () => Promise.reject(new Error("Not available in the demo.")),
  agentsFleet: () => Promise.resolve(demoFleet(nowMs())),
  agentsFleetSeen: ok({ ok: true as const }),
  agentsProfile: (input: { slug: string }) => Promise.resolve(demoProfile(input?.slug ?? "seo")),
  agentsHistory: () => Promise.resolve(demoHistory(nowMs())),
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
  agentsSettingsSet: () => Promise.reject(new Error("Not available in the demo.")),
  agentsClearChat: () => Promise.reject(new Error("Not available in the demo.")),
  agentsChats: ok({}),
  agentsApprovedModels: ok(["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai/gpt-6-sol"]),
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
