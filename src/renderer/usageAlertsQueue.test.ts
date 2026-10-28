import { describe, it, expect } from "vitest";
import { createAlertQueue, ALERT_BUFFER_CAP } from "./usageAlertsQueue";
import type { UsageAlert, UsageAlertFrame, UsageAlertsList } from "../shared/types";

const alert = (id: string, over: Partial<UsageAlert> = {}): UsageAlert => ({
  id,
  key: "claude:weekly",
  level: "limit",
  provider: "claude",
  windowKind: "weekly",
  windowLabel: "Weekly",
  pct: 100,
  resetsAt: 2_000_000_000_000,
  text: `text ${id}`,
  raisedAt: 1,
  expiresAt: 2_000_000_000_000,
  sticky: true,
  canRemind: true,
  canKeepGoing: true,
  ...over,
});
const list = (revision: number, alerts: UsageAlert[], bootId = "B1"): UsageAlertsList => ({ supported: true, bootId, revision, alerts });
const raise = (revision: number, a: UsageAlert, bootId = "B1"): UsageAlertFrame => ({ bootId, revision, alert: a });
const retire = (revision: number, ids: string[], bootId = "B1"): UsageAlertFrame => ({ bootId, revision, retired: ids });
const ids = (q: ReturnType<typeof createAlertQueue>) => q.visible().map((a) => a.id);

function hydrated(alerts: UsageAlert[] = [], revision = 0) {
  const q = createAlertQueue();
  const epoch = q.startHydration();
  q.applySnapshot(list(revision, alerts), epoch);
  return q;
}

describe("createAlertQueue", () => {
  it("unseen ids enqueue in order; a seen id never re-enqueues; a dismissed id stays seen", () => {
    const q = hydrated([alert("a"), alert("b")], 2);
    expect(ids(q)).toEqual(["a", "b"]);
    q.dismiss("a");
    expect(ids(q)).toEqual(["b"]);
    const e = q.startHydration();
    expect(q.applySnapshot(list(2, [alert("a"), alert("b")]), e)).toBe("none");
    expect(ids(q)).toEqual(["b"]);
  });

  it("disconnect → retirement missed → reconnect: the snapshot prunes the id", () => {
    const q = hydrated([alert("x")], 1);
    expect(ids(q)).toEqual(["x"]);
    const e = q.startHydration(); // reconnect
    q.applySnapshot(list(2, []), e);
    expect(ids(q)).toEqual([]);
  });

  it("raise during hydration (A/B): both A and B end up visible and revision is 5", () => {
    const q = createAlertQueue();
    const e = q.startHydration();
    q.applyFrame(raise(5, alert("B")));
    q.applySnapshot(list(4, [alert("A")]), e);
    expect(ids(q)).toEqual(["A", "B"]);
    // revision 5 is now applied: the next frame must be 6
    expect(q.applyFrame(raise(6, alert("C")))).toBe("none");
    expect(ids(q)).toEqual(["A", "B", "C"]);
  });

  it("retirement racing hydration stays retired", () => {
    const q = createAlertQueue();
    const e = q.startHydration();
    q.applyFrame(retire(5, ["X"]));
    q.applySnapshot(list(4, [alert("X")]), e);
    expect(ids(q)).toEqual([]);
  });

  it("an older-epoch snapshot is ignored", () => {
    const q = createAlertQueue();
    const old = q.startHydration();
    const current = q.startHydration();
    expect(q.applySnapshot(list(9, [alert("late")]), old)).toBe("none");
    expect(ids(q)).toEqual([]);
    q.applySnapshot(list(1, [alert("ok")]), current);
    expect(ids(q)).toEqual(["ok"]);
  });

  it("restart during a request re-hydrates and never reverts bootId", () => {
    const q = createAlertQueue();
    const e = q.startHydration();
    q.applyFrame(raise(1, alert("n"), "B2")); // frame from the NEW process
    expect(q.applySnapshot(list(7, [alert("old")], "B1"), e)).toBe("hydrate"); // snapshot from the OLD one
    const e2 = q.startHydration(); // the carried/buffered frame is re-buffered? no: buffer was cleared by the snapshot attempt
    expect(q.applySnapshot(list(1, [alert("n")], "B2"), e2)).toBe("none");
    expect(ids(q)).toEqual(["n"]);
    // a late B1 frame is a restart signal now, never a revert
    expect(q.applyFrame(raise(8, alert("zzz"), "B1"))).toBe("hydrate");
    expect(ids(q)).toEqual(["n"]);
  });

  it("a revision gap while live re-hydrates and keeps the frame for the next snapshot", () => {
    const q = hydrated([alert("a")], 4);
    expect(q.applyFrame(raise(5, alert("b")))).toBe("none");
    expect(q.applyFrame(raise(7, alert("d")))).toBe("hydrate");
    const e = q.startHydration();
    q.applySnapshot(list(6, [alert("a"), alert("b"), alert("c")]), e);
    expect(ids(q)).toEqual(["a", "b", "c", "d"]);
  });

  it("frames with revision <= lastRevision are ignored", () => {
    const q = hydrated([alert("a")], 4);
    expect(q.applyFrame(raise(4, alert("dup")))).toBe("none");
    expect(q.applyFrame(retire(3, ["a"]))).toBe("none");
    expect(ids(q)).toEqual(["a"]);
  });

  it("a frame from a different boot while live re-hydrates", () => {
    const q = hydrated([alert("a")], 4);
    expect(q.applyFrame(raise(1, alert("n"), "B2"))).toBe("hydrate");
  });

  it("buffer overflow re-hydrates", () => {
    const q = createAlertQueue();
    q.startHydration();
    let action = "none";
    for (let i = 1; i <= ALERT_BUFFER_CAP + 1; i++) action = q.applyFrame(raise(i, alert(`f${i}`)));
    expect(action).toBe("hydrate");
  });

  it("a retirement frame removes the alert; a seen id never re-shows after being retired and raised again", () => {
    const q = hydrated([alert("a")], 1);
    q.applyFrame(retire(2, ["a"]));
    expect(ids(q)).toEqual([]);
    q.applyFrame(raise(3, alert("a")));
    expect(ids(q)).toEqual([]);
  });
});
