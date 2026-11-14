import { describe, expect, it } from "vitest";
import type { DelegateJob, DelegateJobProgressView } from "../shared/types";
import {
  barFraction,
  boxNow,
  detailsModel,
  elapsedMs,
  filesLabel,
  isNewerRev,
  jobRowHint,
  mergeJobList,
  patchJobFromEvent,
  plainLine,
  planGrewActive,
  quietMs,
  runCardView,
  stepsChip,
  stepsChipTitle,
  timeLeftMs,
  toolAgeMs,
  usableView,
  usageLabel,
  type JobsState,
} from "./jobProgress";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

const view = (over: Partial<DelegateJobProgressView> = {}): DelegateJobProgressView => ({
  rev: { epoch: 100, n: 1 },
  asOf: T0,
  state: "working",
  headline: "Reading the config loader",
  headlineSource: "model",
  steps: null,
  bar: null,
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

const steps = (over: Partial<NonNullable<DelegateJobProgressView["steps"]>> = {}): NonNullable<DelegateJobProgressView["steps"]> => ({
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
  ...over,
});

const job = (over: Partial<DelegateJob> = {}): DelegateJob =>
  ({
    id: "job1",
    name: "refactor",
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
    activity: "editing",
    createdAt: 1,
    ...over,
  }) as unknown as DelegateJob;

const state = (jobs: DelegateJob[], skews: Record<string, number> = {}): JobsState => ({
  jobs: Object.fromEntries(jobs.map((j) => [j.childSessionID as string, j])),
  skews,
});

describe("rev rule", () => {
  it("a greater epoch wins whatever n; the same epoch needs a greater n", () => {
    expect(isNewerRev({ epoch: 1, n: 50 }, { epoch: 2, n: 0 })).toBe(true);
    expect(isNewerRev({ epoch: 2, n: 5 }, { epoch: 1, n: 99 })).toBe(false);
    expect(isNewerRev({ epoch: 2, n: 5 }, { epoch: 2, n: 6 })).toBe(true);
    expect(isNewerRev({ epoch: 2, n: 5 }, { epoch: 2, n: 5 })).toBe(false);
    expect(isNewerRev({ epoch: 2, n: 5 }, { epoch: 2, n: 4 })).toBe(false);
  });
  it("anything beats nothing; nothing never applies", () => {
    expect(isNewerRev(undefined, { epoch: 1, n: 0 })).toBe(true);
    expect(isNewerRev({ epoch: 1, n: 0 }, undefined)).toBe(false);
  });
  it("usableView rejects a malformed view", () => {
    expect(usableView(undefined)).toBeUndefined();
    expect(usableView("x")).toBeUndefined();
    expect(usableView({ rev: { epoch: "1", n: 1 }, asOf: 1 })).toBeUndefined();
    expect(usableView({ rev: { epoch: 1, n: 1 } })).toBeUndefined();
    expect(usableView(view())).toBeDefined();
  });
});

describe("patchJobFromEvent", () => {
  it("patches the view in place and records the skew", () => {
    const s = state([job({ view: view({ rev: { epoch: 100, n: 1 } }) })]);
    const next = view({ rev: { epoch: 100, n: 2 }, asOf: T0 + 5_000, headline: "Writing tests" });
    const r = patchJobFromEvent(s, { id: "job1", status: "running", activity: "editing", view: next }, T0 + 1_000);
    expect(r.kind).toBe("patched");
    if (r.kind !== "patched") return;
    expect(r.state.jobs.ses_c1.view?.headline).toBe("Writing tests");
    expect(r.state.skews.job1).toBe(4_000); // asOf - localNow
    expect(s.jobs.ses_c1.view?.rev.n).toBe(1); // the input is not mutated
  });

  it("an older or equal rev is ignored", () => {
    const s = state([job({ view: view({ rev: { epoch: 100, n: 5 } }) })]);
    for (const n of [5, 4]) {
      const r = patchJobFromEvent(s, { id: "job1", status: "running", activity: "editing", view: view({ rev: { epoch: 100, n } }) }, T0);
      expect(r.kind).toBe("same");
    }
  });

  it("a new epoch always wins", () => {
    const s = state([job({ view: view({ rev: { epoch: 100, n: 900 } }) })]);
    const r = patchJobFromEvent(s, { id: "job1", status: "running", view: view({ rev: { epoch: 101, n: 0 }, headline: "after restart" }) }, T0);
    expect(r.kind).toBe("patched");
    if (r.kind === "patched") expect(r.state.jobs.ses_c1.view?.headline).toBe("after restart");
  });

  it("still takes a changed activity line when the rev is old", () => {
    const s = state([job({ view: view({ rev: { epoch: 100, n: 5 } }) })]);
    const r = patchJobFromEvent(s, { id: "job1", status: "running", activity: "running tests", view: view({ rev: { epoch: 100, n: 4 } }) }, T0);
    expect(r.kind).toBe("patched");
    if (r.kind === "patched") {
      expect(r.state.jobs.ses_c1.activity).toBe("running tests");
      expect(r.state.jobs.ses_c1.view?.rev.n).toBe(5);
    }
  });

  it("refetches for an unknown id, a status change, and an event without a view", () => {
    const s = state([job({ view: view() })]);
    expect(patchJobFromEvent(s, { id: "nope", status: "running", view: view() }, T0).kind).toBe("refetch");
    expect(patchJobFromEvent(s, { id: "job1", status: "done", view: view({ rev: { epoch: 100, n: 9 } }) }, T0).kind).toBe("refetch");
    expect(patchJobFromEvent(s, { id: "job1", status: "running" }, T0).kind).toBe("refetch");
    expect(patchJobFromEvent(s, { id: "job1", status: "running", view: { garbage: true } }, T0).kind).toBe("refetch");
  });
});

describe("mergeJobList", () => {
  it("a late list answer cannot roll a view back", () => {
    const prev = state([job({ view: view({ rev: { epoch: 100, n: 7 }, headline: "newer" }) })], { job1: 123 });
    const late = job({ view: view({ rev: { epoch: 100, n: 3 }, headline: "older" }), activity: "list activity" });
    const out = mergeJobList(prev, [late], T0);
    expect(out.jobs.ses_c1.view?.headline).toBe("newer");
    expect(out.jobs.ses_c1.activity).toBe("list activity"); // the rest of the record still updates
    expect(out.skews.job1).toBe(123);
  });

  it("a newer list view replaces it and sets the skew", () => {
    const prev = state([job({ view: view({ rev: { epoch: 100, n: 1 } }) })]);
    const out = mergeJobList(prev, [job({ view: view({ rev: { epoch: 100, n: 2 }, asOf: T0 + 10_000 }) })], T0);
    expect(out.jobs.ses_c1.view?.rev.n).toBe(2);
    expect(out.skews.job1).toBe(10_000);
  });

  it("a new epoch in a list answer wins", () => {
    const prev = state([job({ view: view({ rev: { epoch: 100, n: 99 } }) })]);
    const out = mergeJobList(prev, [job({ view: view({ rev: { epoch: 200, n: 0 }, headline: "fresh box" }) })], T0);
    expect(out.jobs.ses_c1.view?.headline).toBe("fresh box");
  });

  it("drops superseded and child-less jobs and prunes skews of jobs that left", () => {
    const prev = state([job()], { job1: 5, gone: 6 });
    const out = mergeJobList(prev, [job({ id: "a", childSessionID: null }), job({ id: "b", childSessionID: "ses_b", supersededBy: "c" })], T0);
    expect(out.jobs).toEqual({});
    expect(out.skews).toEqual({});
  });

  it("a job without a view (older box) or with an invalid-typed one carries none", () => {
    const out = mergeJobList(state([]), [job(), job({ id: "j2", childSessionID: "ses_c2", view: { rev: "x" } as never })], T0);
    expect(out.jobs.ses_c1.view).toBeUndefined();
    expect("view" in out.jobs.ses_c2).toBe(false);
  });
});

describe("client clock", () => {
  it("box now applies the skew; elapsed ticks with it", () => {
    const v = view({ asOf: T0 });
    const skew = v.asOf - (T0 - 7_000); // the box is 7 s ahead of this machine
    expect(boxNow(T0 - 7_000, skew)).toBe(T0);
    expect(elapsedMs(v, boxNow(T0 - 7_000 + 30_000, skew))).toBe(12 * MIN + 30_000);
  });

  it("elapsed is frozen at endedAt and never negative", () => {
    const v = view({ endedAt: T0 - 2 * MIN, state: "done" });
    expect(elapsedMs(v, T0)).toBe(10 * MIN);
    expect(elapsedMs(v, T0 + 99 * MIN)).toBe(10 * MIN);
    expect(elapsedMs(view({ startedAt: T0 + MIN }), T0)).toBe(0);
    expect(elapsedMs(view({ startedAt: null }), T0)).toBeNull();
  });

  it("time left decreases, clamps at 0, and only shows under 30 minutes while running", () => {
    const v = view({ ceilingAt: T0 + 20 * MIN });
    expect(timeLeftMs(v, T0)).toBe(20 * MIN);
    expect(timeLeftMs(v, T0 + 5 * MIN)).toBe(15 * MIN);
    expect(timeLeftMs(v, T0 + 25 * MIN)).toBe(0);
    expect(timeLeftMs(view({ ceilingAt: T0 + 31 * MIN }), T0)).toBeNull();
    expect(timeLeftMs(view({ ceilingAt: null }), T0)).toBeNull();
    expect(timeLeftMs(view({ ceilingAt: T0 + MIN, state: "paused", endedAt: T0 }), T0)).toBeNull();
  });

  it("quiet shows from 3 minutes, only while running", () => {
    expect(quietMs(view({ lastProgressAt: T0 - 2 * MIN - 59_000 }), T0)).toBeNull();
    expect(quietMs(view({ lastProgressAt: T0 - 3 * MIN }), T0)).toBe(3 * MIN);
    expect(quietMs(view({ lastProgressAt: T0 - 9 * MIN, state: "failed", endedAt: T0 }), T0)).toBeNull();
    expect(quietMs(view({ lastProgressAt: null }), T0)).toBeNull();
    expect(quietMs(view({ lastProgressAt: T0 - 9 * MIN, state: "needs-decision" }), T0)).toBe(9 * MIN);
  });

  it("a view whose lastProgressAt advances keeps 'Quiet for' away", () => {
    // quantized to 30 s by the box: at most 30 s stale, far below the 3 min threshold
    for (const lp of [T0, T0 - 29_000, T0 - 30_000]) expect(quietMs(view({ lastProgressAt: lp }), T0)).toBeNull();
  });

  it("tool age counts from the tool's start", () => {
    expect(toolAgeMs(view({ live: { tool: "bash", target: "npm test", startedAt: T0 - 90_000 } }), T0)).toBe(90_000);
    expect(toolAgeMs(view(), T0)).toBeNull();
  });

  it("'plan grew' holds for 120 s after grewAt", () => {
    const v = view({ steps: steps({ grewAt: T0 }) });
    expect(planGrewActive(v, T0)).toBe(true);
    expect(planGrewActive(v, T0 + 119_999)).toBe(true);
    expect(planGrewActive(v, T0 + 120_000)).toBe(false);
    expect(planGrewActive(view({ steps: steps() }), T0)).toBe(false);
    expect(planGrewActive(view(), T0)).toBe(false);
  });
});

describe("plain text", () => {
  it("takes the first non-empty line, collapses whitespace and caps with an ellipsis", () => {
    expect(plainLine("\n  hello   world \nsecond")).toBe("hello world");
    expect(plainLine("x".repeat(200), 120)).toHaveLength(120);
    expect(plainLine("x".repeat(200), 120).endsWith("…")).toBe(true);
    expect(plainLine(null)).toBe("");
  });
  it("leaves markdown and html exactly as written", () => {
    expect(plainLine("<b>bold</b> **x** [l](http://e)")).toBe("<b>bold</b> **x** [l](http://e)");
  });
});

describe("display models", () => {
  it("chip and bar come from the view's steps; the bar prefers the box's value", () => {
    expect(stepsChip(view({ steps: steps() }))).toBe("3/7");
    expect(stepsChip(view())).toBeNull();
    expect(stepsChip(undefined)).toBeNull();
    expect(barFraction(view({ steps: steps(), bar: 0.5 }))).toBe(0.5);
    expect(barFraction(view({ steps: steps(), bar: null }))).toBeCloseTo(3 / 7);
    expect(barFraction(view({ steps: steps({ total: 0 }), bar: null }))).toBe(0);
    expect(barFraction(view())).toBeNull();
    expect(barFraction(view({ steps: steps(), bar: 7 }))).toBe(1);
  });

  it("chip title carries the current step and 'plan grew' while it holds", () => {
    const v = view({ steps: steps({ grewAt: T0 - 10_000 }) });
    expect(stepsChipTitle(v, T0)).toBe("3 of 7 steps done · now: Wire the route · plan grew");
    expect(stepsChipTitle(v, T0 + 200_000)).toBe("3 of 7 steps done · now: Wire the route");
  });

  it("run-card content: headline, needs-decision, elapsed", () => {
    const c = runCardView(view({ steps: steps(), bar: 0.4 }), T0);
    expect(c).toMatchObject({ headline: "Reading the config loader", needsDecision: false, chip: "3/7", bar: 0.4, elapsed: "12m" });
    expect(runCardView(view({ state: "needs-decision" }), T0).needsDecision).toBe(true);
    expect(runCardView(view({ headline: "", startedAt: null }), T0)).toMatchObject({ headline: "", elapsed: null });
  });

  it("details: checklist marks, milestones newest first with age, tool, quiet, files, usage, time left", () => {
    const v = view({
      steps: steps(),
      milestones: [
        { at: T0 - 20_000, text: "found the bug" },
        { at: T0 - 8 * MIN, text: "opened the file" },
      ],
      live: { tool: "bash", target: "npm test", startedAt: T0 - 95_000 },
      lastProgressAt: T0 - 5 * MIN,
      ceilingAt: T0 + 12 * MIN,
      files: { changed: 3 },
      usage: { tokens: 12_345, costUsd: 0.42, costPartial: true },
    });
    const m = detailsModel(v, T0);
    expect(m.items.map((i) => i.mark)).toEqual(["✓", "▸", "○"]);
    expect(m.milestones).toEqual([
      { text: "found the bug", ago: "20s ago" },
      { text: "opened the file", ago: "8m ago" },
    ]);
    expect(m.tool).toEqual({ label: "bash: npm test", age: "1m" });
    expect(m.quiet).toBe("Quiet for 5 min");
    expect(m.timeLeft).toBe("time left 12m");
    expect(m.files).toBe("3 files changed");
    expect(m.usage).toBe("12.3k tokens · $0.42+");
    expect(m.planGrew).toBe(false);
  });

  it("details: reported steps summarize in one line; null files are 'unknown', never 0", () => {
    const v = view({ steps: steps({ source: "reported", items: [], done: 2, total: 5 }), files: { changed: null } });
    const m = detailsModel(v, T0);
    expect(m.items).toEqual([]);
    expect(m.reportedLine).toBe("2 of 5 steps done (reported by the job)");
    expect(m.files).toBe("Files changed: unknown");
    expect(filesLabel({ changed: 1 })).toBe("1 file changed");
    expect(filesLabel(null)).toBeNull();
  });

  it("usage: unpriced shows tokens only; absent shows nothing", () => {
    expect(usageLabel({ tokens: 900, costUsd: null, costPartial: false })).toBe("900 tokens");
    expect(usageLabel(null)).toBeNull();
  });

  it("sidebar hint prefers the headline, falls back to the activity line", () => {
    expect(jobRowHint({ activity: "editing", view: view({ headline: "Reading" }) })).toBe("Reading");
    expect(jobRowHint({ activity: "editing", view: view({ headline: "" }) })).toBe("editing");
    expect(jobRowHint({ activity: "editing" })).toBe("editing");
    expect(jobRowHint({ activity: null })).toBeNull();
  });
});
