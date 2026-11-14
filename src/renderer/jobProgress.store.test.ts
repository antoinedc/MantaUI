// The store half of the progress `view` patching (spec 2026-11-14 B4): the
// `delegate.updated` action and the list merge, against the real zustand store.

import { beforeEach, describe, expect, it } from "vitest";
import type { DelegateJob, DelegateJobProgressView } from "../shared/types";
import { useStore } from "./store";

const T0 = 1_800_000_000_000;

const view = (over: Partial<DelegateJobProgressView> = {}): DelegateJobProgressView =>
  ({
    rev: { epoch: 1, n: 1 },
    asOf: T0,
    state: "working",
    headline: "h",
    headlineSource: "model",
    steps: null,
    bar: null,
    live: null,
    startedAt: T0,
    endedAt: null,
    lastProgressAt: T0,
    ceilingAt: null,
    milestones: [],
    files: null,
    usage: null,
    model: null,
    ...over,
  }) as DelegateJobProgressView;

const job = (over: Partial<DelegateJob> = {}): DelegateJob =>
  ({ id: "job1", name: "n", childSessionID: "ses_c1", parentSessionID: "ses_p", status: "running", activity: null, createdAt: 1, ...over }) as unknown as DelegateJob;

beforeEach(() => {
  useStore.setState({ jobs: {}, jobSkew: {}, videoRenderNow: T0 });
});

describe("store.applyJobUpdate", () => {
  it("patches a known job in place and asks for no refetch", () => {
    useStore.getState().setJobs([job({ view: view() })]);
    const before = useStore.getState().jobs.ses_c1;
    const refetch = useStore.getState().applyJobUpdate({
      id: "job1",
      status: "running",
      view: view({ rev: { epoch: 1, n: 2 }, asOf: T0 + 3_000, headline: "next" }),
    });
    expect(refetch).toBe(false);
    const after = useStore.getState().jobs.ses_c1;
    expect(after).not.toBe(before);
    expect(after.view?.headline).toBe("next");
    expect(useStore.getState().jobSkew.job1).toBe(3_000);
  });

  it("an older rev changes nothing (same store object) and asks for no refetch", () => {
    useStore.getState().setJobs([job({ view: view({ rev: { epoch: 1, n: 5 } }) })]);
    const jobsBefore = useStore.getState().jobs;
    expect(useStore.getState().applyJobUpdate({ id: "job1", status: "running", view: view({ rev: { epoch: 1, n: 4 } }) })).toBe(false);
    expect(useStore.getState().jobs).toBe(jobsBefore);
  });

  it("asks for a refetch on an unknown id, a status change, and an event with no view", () => {
    useStore.getState().setJobs([job({ view: view() })]);
    const { applyJobUpdate } = useStore.getState();
    expect(applyJobUpdate({ id: "other", status: "running", view: view() })).toBe(true);
    expect(applyJobUpdate({ id: "job1", status: "done", view: view({ rev: { epoch: 1, n: 9 } }) })).toBe(true);
    expect(applyJobUpdate({ id: "job1", status: "running" })).toBe(true);
  });
});

describe("store.setJobs", () => {
  it("a late list answer does not roll a newer view back", () => {
    useStore.getState().setJobs([job({ view: view({ rev: { epoch: 1, n: 8 }, headline: "event" }) })]);
    useStore.getState().setJobs([job({ view: view({ rev: { epoch: 1, n: 2 }, headline: "late list" }) })]);
    expect(useStore.getState().jobs.ses_c1.view?.headline).toBe("event");
    useStore.getState().setJobs([job({ view: view({ rev: { epoch: 2, n: 0 }, headline: "restarted box" }) })]);
    expect(useStore.getState().jobs.ses_c1.view?.headline).toBe("restarted box");
  });

  it("still keys by child session and drops superseded jobs", () => {
    useStore.getState().setJobs([job(), job({ id: "j2", childSessionID: "ses_c2", supersededBy: "j3" }), job({ id: "j4", childSessionID: null })]);
    expect(Object.keys(useStore.getState().jobs)).toEqual(["ses_c1"]);
  });
});
