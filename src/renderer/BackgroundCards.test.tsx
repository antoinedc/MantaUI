// @vitest-environment jsdom
//
// The parent's background-job card with the box's progress `view` (spec
// 2026-11-14 B6): steps chip, headline, bar, the Details disclosure, the client
// clock, plain-text rendering, and the finished card's "Needs a decision".
// Rendered directly (not through ChatPanel): the cards read the job store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { DelegateJob, DelegateJobProgressView } from "../shared/types";
import { BackgroundResultCard, BackgroundRunCards } from "./BackgroundCards";
import type { BackgroundCard, BackgroundResultPart } from "./backgroundRun";
import { useStore } from "./store";
import { mount, resetStore, type Harness } from "./testHarness";

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
