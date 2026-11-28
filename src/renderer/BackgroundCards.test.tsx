// @vitest-environment jsdom
//
// The parent's background-job card with the box's progress `view` (spec
// 2026-11-14 B6): steps chip, headline, bar, the Details disclosure, the client
// clock, plain-text rendering, and the finished card's "Needs a decision".
// Rendered directly (not through ChatPanel): the cards read the job store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { DelegateJob, DelegateJobProgressView } from "../shared/types";
import { BackgroundResultCard, BackgroundRunCards } from "./BackgroundCards";
import type { BackgroundCard, BackgroundResultPart } from "./backgroundRun";
import { installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { refreshModelCatalog } from "./modelCatalog";
import { resetPackageAgentsForTest } from "./packageAgents";
import { resetExplorerStore, shownRightPanel, useTaskPanelJobId } from "./explorer/explorerStore";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

const view = (over: Partial<DelegateJobProgressView> = {}): DelegateJobProgressView => ({
  rev: { epoch: 1, n: 1 },
  asOf: T0,
  state: "working",
  headline: "Reading the config loader",
  headlineSource: "model",
  steps: {
    done: 3,
    total: 7,
    current: "Wire the route",
    items: [
      { text: "Read the spec", status: "done" },
      { text: "Wire the route", status: "current" },
      { text: "Write tests", status: "pending" },
    ],
    source: "checklist",
    planRevision: 1,
    grewAt: null,
  },
  bar: 3 / 7,
  live: null,
  startedAt: T0 - 12 * MIN,
  endedAt: null,
  lastProgressAt: T0 - MIN,
  ceilingAt: T0 + 4 * 60 * MIN,
  milestones: [],
  files: null,
  usage: null,
  model: null,
  ...over,
});

const job = (over: Record<string, unknown> = {}): DelegateJob =>
  ({
    id: "job1",
    name: "refactor loader",
    prompt: "",
    model: null,
    parentSessionID: "ses_p",
    parentDirectory: "/x",
    childSessionID: "ses_c1",
    tmuxSession: "proj",
    windowIndex: 4,
    worktree: null,
    branch: null,
    baseSha: null,
    status: "running",
    activity: null,
    createdAt: 1,
    ...over,
  }) as unknown as DelegateJob;

const runCard = (over: Partial<Extract<BackgroundCard, { kind: "running" }>> = {}): BackgroundCard => ({
  kind: "running",
  key: "job1",
  jobId: "job1",
  name: "refactor loader",
  createdAt: 1,
  paused: false,
  ...over,
});

let h: Harness | null = null;

function show(j: DelegateJob | null, card: BackgroundCard = runCard(), jobSkew: Record<string, number> = {}) {
  resetStore({ jobs: j ? { ses_c1: j } : {}, jobSkew });
  h = mount(<BackgroundRunCards cards={[card]} />);
  return h.container;
}
const q = <E extends HTMLElement = HTMLElement>(sel: string): E | null => h!.container.querySelector<E>(sel);
const text = (sel: string) => q(sel)?.textContent ?? null;

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.useRealTimers();
  resetStore({ jobs: {}, jobSkew: {} });
});

describe("request line (Agents Phase 2)", () => {
  const lead = {
    slug: "manta",
    name: "Boss",
    description: "Leads",
    isolation: "none" as const,
    model: null,
    color: null,
    builtIn: true,
    role: "lead" as const,
    useWhen: null,
    notFor: null,
    notice: null,
  };

  it("a lead handoff reads '<Lead> asked: <request>', with the lead's name from the agent list", async () => {
    installMockApi({ agentsList: () => Promise.resolve([lead]) });
    resetPackageAgentsForTest();
    show(job(), runCard({ agentName: "Dev", request: "Fix the login bug", requestedBy: "manta" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text('[data-testid="background-request"]')).toBe("Boss asked: Fix the login bug");
  });

  it("falls back to 'Manta' before the agent list loads or when the box has no lead", () => {
    installMockApi({ agentsList: () => new Promise(() => {}) });
    resetPackageAgentsForTest();
    show(job(), runCard({ agentName: "Dev", request: "Fix the login bug", requestedBy: "manta" }));
    expect(text('[data-testid="background-request"]')).toBe("Manta asked: Fix the login bug");
  });

  it("a user's own @mention keeps the quoted request", () => {
    installMockApi({ agentsList: () => Promise.resolve([lead]) });
    resetPackageAgentsForTest();
    show(job(), runCard({ agentName: "Dev", request: "@dev fix it" }));
    expect(text('[data-testid="background-request"]')).toBe("“@dev fix it”");
  });
});

describe("the model a task ran on (agent tasks)", () => {
  const models = [{ id: "gpt-6-sol", providerID: "openai", name: "GPT-6 Sol" }];
  const settle = async () => {
    refreshModelCatalog();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("the running card names it in the catalog's words; a task with none recorded shows no line", async () => {
    installMockApi({ opencodeModels: () => Promise.resolve(models), agentsList: () => Promise.resolve([]) });
    resetPackageAgentsForTest();
    show(job({ agent: "agent-dev", agentName: "Dev", modelUsed: "openai/gpt-6-sol" }), runCard({ agentName: "Dev", request: "Review the spec", requestedBy: "manta" }));
    await settle();
    expect(text('[data-testid="background-model"]')).toBe("Model · GPT-6 Sol");
    h?.unmount();
    show(job({ agent: "agent-dev", agentName: "Dev", modelUsed: null }), runCard({ agentName: "Dev", request: "Review the spec", requestedBy: "manta" }));
    await settle();
    expect(q('[data-testid="background-model"]')).toBeNull();
  });

  it("the finished card names it too", async () => {
    installMockApi({ opencodeModels: () => Promise.resolve(models), agentsList: () => Promise.resolve([]) });
    resetPackageAgentsForTest();
    resetStore({ jobs: { ses_c1: job({ id: "job1", agent: "agent-dev", modelUsed: "openai/gpt-6-sol", status: "done" }) }, jobSkew: {} });
    h = mount(<BackgroundResultCard part={{ type: "background-result", jobId: "job1", childSessionId: "ses_c1", agent: "agent-dev", state: "completed", text: "Reviewed." } as unknown as BackgroundResultPart} />);
    await settle();
    expect(text('[data-testid="background-result-model"]')).toBe("Model · GPT-6 Sol");
  });
});

describe("RunCard with a progress view", () => {
  it("shows the steps chip, elapsed, headline and the bar", () => {
    show(job({ view: view() }));
    expect(text('[data-testid="background-steps"]')).toBe("3/7");
    expect(text('[data-testid="background-elapsed"]')).toBe("12m");
    expect(text('[data-testid="background-headline"]')).toBe("Reading the config loader");
    const bar = q('[data-testid="background-bar"]')!;
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("43");
    expect(bar.className).not.toContain("invisible");
  });

  it("without steps the chip is absent and the bar row is reserved, not removed", () => {
    show(job({ view: view({ steps: null, bar: null }) }));
    expect(q('[data-testid="background-steps"]')).toBeNull();
    const bar = q('[data-testid="background-bar"]')!;
    expect(bar.className).toContain("invisible");
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    expect(bar.getAttribute("role")).toBeNull();
  });

  it("an empty headline keeps its row (hidden) so the card height does not change", () => {
    show(job({ view: view({ headline: "", headlineSource: "none" }) }));
    const row = q('[data-testid="background-headline"]')!;
    expect(row.className).toContain("invisible");
  });

  it("needs-decision prefixes the headline and turns it amber", () => {
    show(job({ view: view({ state: "needs-decision", headline: "Which branch do I target?" }) }));
    const row = q('[data-testid="background-headline"]')!;
    expect(row.textContent).toBe("Needs a decision: Which branch do I target?");
    expect(row.className).toContain("text-warn");
    expect(row.getAttribute("title")).toBe("Needs a decision: Which branch do I target?");
  });

  it("model text is rendered literally: no markup, no links", () => {
    show(
      job({
        view: view({
          headline: "<b>bold</b> **x** [click](http://evil.example)",
          milestones: [{ at: T0 - 5_000, text: "<img src=x onerror=alert(1)> done" }],
          steps: { ...view().steps!, items: [{ text: "<i>step</i>", status: "current" }] },
        }),
      }),
    );
    act(() => q<HTMLButtonElement>('[data-testid="background-details-toggle"]')!.click());
    const root = h!.container;
    expect(text('[data-testid="background-headline"]')).toBe("<b>bold</b> **x** [click](http://evil.example)");
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("i")).toBeNull();
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)> done");
  });

  it("no view (an older box): the card is exactly the old one", () => {
    show(job());
    const card = q('[data-testid="background-card"]')!;
    expect(card.textContent).toBe("Running in background:refactor loader·Open session");
    for (const id of ["background-details-toggle", "background-headline", "background-bar", "background-steps", "background-elapsed"]) {
      expect(q(`[data-testid="${id}"]`)).toBeNull();
    }
  });

  it("the card kind keeps deciding the first-row text; an uncertain card carries no view content", () => {
    show(job({ view: view(), launchState: "uncertain" }), { kind: "uncertain", key: "job1", jobId: "job1", name: "n", createdAt: 1 });
    expect(text('[data-testid="background-card"]')).toContain("Couldn't confirm this started");
    expect(q('[data-testid="background-headline"]')).toBeNull();
    expect(q('[data-testid="background-details-toggle"]')).toBeNull();
    h!.unmount();
    show(job({ view: view({ state: "paused", endedAt: T0 - 2 * MIN }), status: "paused" }), runCard({ paused: true }));
    expect(text('[data-testid="background-card"]')).toContain("Paused in background:");
    expect(text('[data-testid="background-elapsed"]')).toBe("10m"); // frozen at endedAt
  });

  it("a settling card (job ended, result on its way) keeps its first-row text and shows the content", () => {
    show(job({ status: "done", view: view({ state: "done", endedAt: T0 - MIN }) }), {
      kind: "settling",
      key: "job1",
      jobId: "job1",
      name: "refactor loader",
      createdAt: 1,
    });
    expect(text('[data-testid="background-card"]')).toContain("Finished in background:");
    expect(text('[data-testid="background-elapsed"]')).toBe("11m");
    expect(q('[data-testid="background-headline"]')).not.toBeNull();
  });
});

describe("Details disclosure", () => {
  const full = () =>
    view({
      steps: { ...view().steps!, grewAt: T0 - 30_000 },
      milestones: [
        { at: T0 - 20_000, text: "found the bug" },
        { at: T0 - 8 * MIN, text: "opened the file" },
      ],
      live: { tool: "bash", target: "npm test", startedAt: T0 - 90_000 },
      lastProgressAt: T0 - 6 * MIN,
      ceilingAt: T0 + 12 * MIN,
      files: { changed: 3 },
      usage: { tokens: 12_345, costUsd: 0.42, costPartial: false },
    });

  it("is its own button, a sibling of Open session, closed by default, and toggles", () => {
    show(job({ view: full() }));
    const toggle = q<HTMLButtonElement>('[data-testid="background-details-toggle"]')!;
    const open = q<HTMLButtonElement>('[data-testid="background-open-session"]')!;
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.type).toBe("button");
    expect(toggle.contains(open)).toBe(false);
    expect(open.contains(toggle)).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(q('[data-testid="background-details"]')).toBeNull();
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(q('[data-testid="background-details"]')).not.toBeNull();
    expect(toggle.getAttribute("aria-controls")).toBe(q('[data-testid="background-details"]')!.id);
    act(() => toggle.click());
    expect(q('[data-testid="background-details"]')).toBeNull();
  });

  it("lists the checklist, milestones, live tool, quiet, files, usage, time left and 'plan grew'", () => {
    show(job({ view: full() }));
    act(() => q<HTMLButtonElement>('[data-testid="background-details-toggle"]')!.click());
    const marks = [...h!.container.querySelectorAll('[data-testid="background-checklist"] li')].map((li) => li.getAttribute("data-status"));
    expect(marks).toEqual(["done", "current", "pending"]);
    expect(text('[data-testid="background-checklist"]')).toContain("✓");
    expect(text('[data-testid="background-checklist"]')).toContain("▸");
    expect(text('[data-testid="background-checklist"]')).toContain("○");
    const ms = [...h!.container.querySelectorAll('[data-testid="background-milestones"] li')].map((li) => li.textContent);
    expect(ms).toEqual(["found the bug20s ago", "opened the file8m ago"]);
    expect(text('[data-testid="background-stat-tool"]')).toBe("bash: npm test · running 1m");
    expect(text('[data-testid="background-stat-quiet"]')).toBe("Quiet for 6 min");
    expect(text('[data-testid="background-stat-files"]')).toBe("3 files changed");
    expect(text('[data-testid="background-stat-usage"]')).toBe("12.3k tokens · $0.42");
    expect(text('[data-testid="background-stat-time-left"]')).toBe("time left 12m");
    expect(text('[data-testid="background-plan-grew"]')).toBe("Plan grew");
  });

  it("'Quiet for' is absent while progress is recent", () => {
    show(job({ view: view({ lastProgressAt: T0 - 30_000 }) }));
    act(() => q<HTMLButtonElement>('[data-testid="background-details-toggle"]')!.click());
    expect(q('[data-testid="background-stat-quiet"]')).toBeNull();
    expect(q('[data-testid="background-plan-grew"]')).toBeNull();
  });
});

describe("client clock", () => {
  it("elapsed and time left tick locally once a second, with no new view", () => {
    show(job({ view: view({ ceilingAt: T0 + 2 * MIN }) }));
    act(() => q<HTMLButtonElement>('[data-testid="background-details-toggle"]')!.click());
    expect(text('[data-testid="background-elapsed"]')).toBe("12m");
    expect(text('[data-testid="background-stat-time-left"]')).toBe("time left 2m");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(text('[data-testid="background-elapsed"]')).toBe("13m");
    expect(text('[data-testid="background-stat-time-left"]')).toBe("time left 1m");
    act(() => {
      vi.advanceTimersByTime(10 * MIN);
    });
    expect(text('[data-testid="background-stat-time-left"]')).toBe("time left 0s");
    expect(text('[data-testid="background-elapsed"]')).toBe("23m");
  });

  it("applies the box/machine skew: a box 5 minutes ahead reads 5 minutes more elapsed", () => {
    show(job({ view: view() }), runCard(), { job1: 5 * MIN });
    expect(text('[data-testid="background-elapsed"]')).toBe("17m");
  });
});

describe("finished result card", () => {
  const part = (over: Partial<BackgroundResultPart> = {}): BackgroundResultPart =>
    ({
      id: "p1",
      messageID: "m1",
      sessionID: "ses_p",
      type: "background-result",
      childSessionId: "ses_c1",
      jobId: "job1",
      state: "completed",
      name: "refactor loader",
      text: "Which branch should I target?",
      ...over,
    }) as BackgroundResultPart;

  it("endedBlocked shows 'Needs a decision' in amber instead of green 'done'", () => {
    resetStore({});
    h = mount(<BackgroundResultCard part={part({ endedBlocked: true })} />);
    const label = q('[data-testid="background-result-state"]')!;
    expect(label.textContent).toContain("Needs a decision");
    expect(label.className).toContain("text-warn");
    expect(h.container.textContent).not.toContain("done");
    expect(q('[data-testid="background-result-card"]')!.getAttribute("data-blocked")).toBe("true");
    expect(q('[data-testid="background-result-card"]')!.getAttribute("data-state")).toBe("completed");
    expect(q(".bg-warn")).not.toBeNull();
    expect(q(".bg-ok")).toBeNull();
  });

  it("lists what the task did on the user's say-so and what the autonomy settings blocked, from the part's own fields", () => {
    resetStore({});
    h = mount(
      <BackgroundResultCard
        part={part({
          toldActions: [
            { kind: "deploy", summary: "fly deploy" },
            { kind: "publish", summary: "serve_page" },
          ],
          blockedActions: [
            { kind: "merge", level: "ask", summary: "gh pr merge" },
            { kind: "protected", level: "never", summary: "Manta settings or credentials" },
          ],
        })}
      />,
    );
    expect(text('[data-testid="background-result-told"]')).toBe("Told you: fly deploy, serve_page");
    expect(text('[data-testid="background-result-blocked"]')).toBe(
      "Blocked: gh pr merge (needs your go-ahead), Manta settings or credentials (not allowed)",
    );
  });

  it("shows no such lines when the part carries none (or an empty list)", () => {
    resetStore({});
    h = mount(<BackgroundResultCard part={part({ toldActions: [], blockedActions: undefined, exceededActions: [] })} />);
    expect(q('[data-testid="background-result-told"]')).toBeNull();
    expect(q('[data-testid="background-result-blocked"]')).toBeNull();
    expect(q('[data-testid="background-result-exceeded"]')).toBeNull();
    h.unmount();
    h = mount(<BackgroundResultCard part={part()} />);
    expect(q('[data-testid="background-result-exceeded"]')).toBeNull();
  });

  it("shows 'Despite your settings' first, in the warning tone, with a marker per source", () => {
    resetStore({});
    h = mount(
      <BackgroundResultCard
        part={part({
          toldActions: [{ kind: "deploy", summary: "fly deploy" }],
          blockedActions: [{ kind: "merge", level: "ask", summary: "gh pr merge" }],
          exceededActions: [
            { kind: "deploy", level: "ask", summary: "scripts/deploy-web.sh", source: "agent" },
            { kind: "delete_data", level: "never", summary: "aws s3 rm" },
          ],
        })}
      />,
    );
    const el = q('[data-testid="background-result-exceeded"]')!;
    expect(el.textContent).toBe(
      "Despite your settings: scripts/deploy-web.sh (needs your go-ahead; agent says it did this), " +
        "aws s3 rm (not allowed; matched in a completed command, outcome not checked)",
    );
    expect(el.className).toContain("text-warn");
    const order = Array.from(
      h.container.querySelectorAll(
        '[data-testid="background-result-exceeded"], [data-testid="background-result-told"], [data-testid="background-result-blocked"]',
      ),
    ).map((n) => n.getAttribute("data-testid"));
    expect(order).toEqual(["background-result-exceeded", "background-result-told", "background-result-blocked"]);
  });

  it("marks agent-reported entries in the told and blocked lines", () => {
    resetStore({});
    h = mount(
      <BackgroundResultCard
        part={part({
          toldActions: [
            { kind: "deploy", summary: "fly deploy", source: "agent" },
            { kind: "publish", summary: "serve_page" },
          ],
          blockedActions: [{ kind: "merge", level: "never", summary: "gh pr merge", source: "agent" }],
        })}
      />,
    );
    expect(text('[data-testid="background-result-told"]')).toBe("Told you: fly deploy (agent's report), serve_page");
    expect(text('[data-testid="background-result-blocked"]')).toBe("Blocked: gh pr merge (not allowed) (agent's report)");
  });

  it("an ordinary completed result still reads 'done' (green); failures show their reason text", () => {
    resetStore({});
    h = mount(<BackgroundResultCard part={part()} />);
    expect(text('[data-testid="background-result-state"]')).toContain("done");
    expect(q(".bg-ok")).not.toBeNull();
    h.unmount();
    h = mount(<BackgroundResultCard part={part({ state: "failed", text: "stalled — no progress for 15 minutes (last: running tests)" })} />);
    expect(text('[data-testid="background-result-state"]')).toContain("failed");
    expect(h.container.textContent).toContain("stalled — no progress for 15 minutes");
    expect(q(".bg-danger")).not.toBeNull();
  });
});

describe("an Architect job's result card (Agents Phase 5A)", () => {
  const part = (over: Partial<BackgroundResultPart> = {}): BackgroundResultPart =>
    ({
      id: "p1",
      messageID: "m1",
      sessionID: "ses_p",
      type: "background-result",
      childSessionId: "ses_c1",
      jobId: "job1",
      state: "completed",
      name: "Make an SEO agent",
      agent: "agent-architect",
      text: "Proposed one change.",
      ...over,
    }) as BackgroundResultPart;
  const rec = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "update" as const,
    slug: "dev",
    agentName: "Dev",
    sessionID: "ses_p",
    messageID: "",
    callID: "",
    state: "pending" as const,
    needsClick: true,
    reason: "ask" as const,
    before: "---\nname: Dev\ndescription: d\nisolation: none\n---\nA\n",
    after: "---\nname: Dev\ndescription: d\nisolation: none\n---\nA\nB\n",
    createdAt: 1,
    decidedAt: null,
    error: null,
    origin: { kind: "job" as const, jobId: "job1", rootJobId: "job1", attempt: 1 },
    mode: "build" as const,
    releasedAt: 1,
    decidedBy: null,
    summary: `Summary ${id}`,
    evidence: [],
    admission: [],
    ...over,
  });
  let records: ReturnType<typeof rec>[];
  type Hint = { id: string; sessionID: string; slug: string | null; origin: unknown };
  // every subscriber (the package-agent list listens too), each unsubscribed on unmount
  const listeners = new Set<(p: Hint) => void>();
  const hint = (p: Hint) => listeners.forEach((fn) => fn(p));
  const open = (over: Record<string, unknown> = {}, p = part()) => {
    const { api, bus } = installMockApi({
      agentsChangesForJob: () => Promise.resolve(records),
      onAgentChange: (cb: (p: Hint) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      ...over,
    });
    resetStore({});
    h = mount(<BackgroundResultCard part={p} />);
    return { api, bus };
  };
  beforeEach(() => {
    records = [rec("ach_a"), rec("ach_b", { state: "held", needsClick: false, reason: null })];
    listeners.clear();
  });

  it("lists the job's records under the result, fetched by the delegate job id", async () => {
    const { api } = open();
    await h!.flush();
    expect(api.calls.agentsChangesForJob).toEqual([["job1"]]);
    const cards = h!.container.querySelectorAll('[data-testid="agent-change-card"]');
    expect(cards).toHaveLength(2);
    expect(h!.container.textContent).toContain("Summary ach_a");
    expect(h!.container.textContent).toContain("Summary ach_b");
    expect(q('[data-testid="agent-change-list"]')).toBeTruthy();
  });

  it("refetches on an event whose origin names this job, and on a reconnect; ignores another job's", async () => {
    const { api, bus } = open();
    await h!.flush();
    records = [rec("ach_a", { state: "applied", slug: "dev" }), rec("ach_b")];
    await act(async () => hint({ id: "ach_x", sessionID: "ses_p", slug: null, origin: { kind: "job", jobId: "other", rootJobId: "other", attempt: 1 } }));
    await h!.flush();
    expect(api.calls.agentsChangesForJob).toHaveLength(1);
    await act(async () => hint({ id: "ach_a", sessionID: "ses_p", slug: "dev", origin: { kind: "chat" } }));
    await h!.flush();
    expect(api.calls.agentsChangesForJob).toHaveLength(1);
    await act(async () => hint({ id: "ach_a", sessionID: "ses_p", slug: "dev", origin: { kind: "job", jobId: "job1", rootJobId: "job1", attempt: 1 } }));
    await h!.flush();
    expect(api.calls.agentsChangesForJob).toHaveLength(2);
    expect(Array.from(h!.container.querySelectorAll('[data-testid="agent-change-chip"]')).map((e) => e.textContent)).toEqual(["Updated", "Waiting for you"]);
    records = [rec("ach_a", { state: "undone" })];
    await act(async () => bus.emitStream({ sub: "resync", sessionId: "", payload: {} }));
    await h!.flush();
    expect(api.calls.agentsChangesForJob).toHaveLength(3);
    expect(h!.container.querySelectorAll('[data-testid="agent-change-card"]')).toHaveLength(1);
  });

  it("a press on a listed record updates just that record", async () => {
    open({ agentsChangeApply: () => Promise.resolve(rec("ach_a", { state: "applied", slug: "dev" })) });
    await h!.flush();
    const apply = Array.from(h!.container.querySelectorAll("button")).find((b) => b.textContent === "Apply") as HTMLButtonElement;
    await act(async () => apply.click());
    await h!.flush();
    expect(Array.from(h!.container.querySelectorAll('[data-testid="agent-change-chip"]')).map((e) => e.textContent)).toEqual(["Updated", "Architect still working"]);
  });

  it("says so when the list can't be read, with a way to try again", async () => {
    let fail = true;
    open({ agentsChangesForJob: () => (fail ? Promise.reject(new Error("HTTP 500")) : Promise.resolve(records)) });
    await h!.flush();
    expect(q('[data-testid="agent-change-list-error"]')!.textContent).toContain("Couldn't load the Architect's proposals: HTTP 500");
    fail = false;
    const retry = Array.from(h!.container.querySelectorAll("button")).find((b) => b.textContent === "Try again") as HTMLButtonElement;
    await act(async () => retry.click());
    await h!.flush();
    expect(h!.container.querySelectorAll('[data-testid="agent-change-card"]')).toHaveLength(2);
  });

  it("other jobs' result cards read no records at all; an Architect result with no job id has nothing to ask for", async () => {
    const { api } = open({}, part({ agent: "agent-dev" }));
    await h!.flush();
    expect(api.calls.agentsChangesForJob).toBeUndefined();
    expect(q('[data-testid="agent-change-list"]')).toBeNull();
    h!.unmount();
    const second = open({}, part({ jobId: undefined }));
    await h!.flush();
    expect(second.api.calls.agentsChangesForJob).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Agent screens (spec §2.3, §2.5): the question chip, the seat-added line, Details → the task side panel
// ---------------------------------------------------------------------------

describe("agent task cards (agent screens)", () => {
  const agentJob = (over: Record<string, unknown> = {}) =>
    job({ agent: "agent-seo", agentName: "SEO", request: "@seo check the page", rootJobId: "job1", view: view(), ...over });
  const card = (over: Partial<Extract<BackgroundCard, { kind: "running" }>> = {}) =>
    runCard({ agentName: "SEO", request: "@seo check the page", ...over });
  const panelJob = (sessionId: string): string | null => {
    let seen: string | null = null;
    function Probe() {
      seen = useTaskPanelJobId(sessionId);
      return null;
    }
    const el = document.createElement("div");
    const root = createRoot(el);
    act(() => root.render(createElement(Probe)));
    act(() => root.unmount());
    return seen;
  };
  const showWith = (j: DelegateJob, c: BackgroundCard, counts?: ReadonlyMap<string, number>) => {
    installMockApi({ agentsList: () => Promise.resolve([]) });
    resetPackageAgentsForTest();
    resetStore({ jobs: { ses_c1: j }, jobSkew: {} });
    h = mount(<BackgroundRunCards cards={[c]} openQuestionsByJob={counts} />);
    return h.container;
  };
  beforeEach(() => resetExplorerStore());

  it("shows '· 1 question' when the task's root has one open, and '· 2 questions' for two", () => {
    showWith(agentJob(), card(), new Map([["job1", 1]]));
    expect(text('[data-testid="background-questions"]')).toBe("· 1 question");
    h!.unmount();
    showWith(agentJob(), card(), new Map([["job1", 2]]));
    expect(text('[data-testid="background-questions"]')).toBe("· 2 questions");
  });

  it("keys the count by the task's root, so a follow-up round of the same task still shows it", () => {
    showWith(agentJob({ id: "job2", rootJobId: "job1" }), card({ jobId: "job2", key: "job2" }), new Map([["job1", 1]]));
    expect(text('[data-testid="background-questions"]')).toBe("· 1 question");
  });

  it("shows no chip when this task has none (another task's count is not ours)", () => {
    showWith(agentJob(), card(), new Map([["other", 3]]));
    expect(q('[data-testid="background-questions"]')).toBeNull();
    h!.unmount();
    showWith(agentJob(), card(), new Map());
    expect(q('[data-testid="background-questions"]')).toBeNull();
  });

  it("an older job without rootJobId counts under its own id", () => {
    showWith(agentJob({ rootJobId: undefined }), card(), new Map([["job1", 1]]));
    expect(text('[data-testid="background-questions"]')).toBe("· 1 question");
  });

  it("says where it seated the agent, on its own line outside the quotes, and leaves the request as it was", () => {
    showWith(agentJob({ seatAdded: { project: "site-aaaaaaaaaa", projectName: "Site" } }), card());
    expect(text('[data-testid="background-seat-added"]')).toBe("Added @seo to Site");
    expect(text('[data-testid="background-request"]')).toBe("“@seo check the page”");
  });

  it("has no seat line when no seat was added", () => {
    showWith(agentJob(), card());
    expect(q('[data-testid="background-seat-added"]')).toBeNull();
  });

  it("Details on an agent task opens the task side panel for that chat instead of expanding inline", () => {
    showWith(agentJob(), card());
    act(() => q<HTMLButtonElement>('[data-testid="background-details-toggle"]')!.click());
    expect(shownRightPanel("ses_p")).toBe("task");
    expect(panelJob("ses_p")).toBe("job1");
    expect(q('[data-testid="background-details"]')).toBeNull();
  });

  it("Details on a task before its first progress view still opens the panel", () => {
    showWith(agentJob({ view: undefined }), card());
    act(() => q<HTMLButtonElement>('[data-testid="background-details-toggle"]')!.click());
    expect(shownRightPanel("ses_p")).toBe("task");
  });

  it("Details on any other background job still expands inline", () => {
    showWith(job({ view: view() }), runCard());
    act(() => q<HTMLButtonElement>('[data-testid="background-details-toggle"]')!.click());
    expect(q('[data-testid="background-details"]')).not.toBeNull();
    expect(shownRightPanel("ses_p")).toBe("none");
    expect(q('[data-testid="background-questions"]')).toBeNull();
  });

  describe("on the finished card", () => {
    const part = (over: Partial<BackgroundResultPart> = {}): BackgroundResultPart =>
      ({
        id: "p1",
        messageID: "m1",
        sessionID: "ses_p",
        type: "background-result",
        childSessionId: "ses_c1",
        jobId: "job1",
        state: "completed",
        name: "Check the page",
        agent: "agent-seo",
        text: "Done.",
        ...over,
      }) as BackgroundResultPart;
    const showResult = (p: BackgroundResultPart) => {
      installMockApi({ agentsList: () => Promise.resolve([]), agentsChangesForJob: () => Promise.resolve([]) });
      resetPackageAgentsForTest();
      resetStore({});
      h = mount(<BackgroundResultCard part={p} />);
    };
    const detailsButton = () => q<HTMLButtonElement>('[data-testid="background-result-details"]');

    it("an agent task's result has a Details button that opens the panel for its job", () => {
      showResult(part());
      expect(detailsButton()?.textContent).toBe("Details");
      act(() => detailsButton()!.click());
      expect(shownRightPanel("ses_p")).toBe("task");
      expect(panelJob("ses_p")).toBe("job1");
    });

    it("has none on an ordinary background result, or when no job id is known", () => {
      showResult(part({ agent: "explore" }));
      expect(detailsButton()).toBeNull();
      h!.unmount();
      showResult(part({ jobId: undefined }));
      expect(detailsButton()).toBeNull();
    });
  });
});
