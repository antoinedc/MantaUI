import { describe, it, expect } from "vitest";
import { EventBatcher, HIGH_PRIORITY_TYPES, type BusEvent } from "./eventBatcher.js";

// A controllable fake timer so batching is deterministic (no real 50ms waits).
// setTimeoutFn stashes the callback; advance() fires the pending one.
function makeFakeTimer() {
  let pending: (() => void) | null = null;
  let nextId = 1;
  return {
    setTimeoutFn: (fn: () => void, _ms: number) => {
      pending = fn;
      return nextId++;
    },
    clearTimeoutFn: (_h: unknown) => {
      pending = null;
    },
    /** Fire the currently-armed flush callback, if any. */
    advance() {
      const fn = pending;
      pending = null;
      if (fn) fn();
    },
    hasPending() {
      return pending !== null;
    },
  };
}

/** Build a bus event `{type, properties:{sessionID, partID}}`. */
function ev(type: string, sessionID?: string, partID?: string): BusEvent {
  const properties: Record<string, unknown> = {};
  if (sessionID !== undefined) properties.sessionID = sessionID;
  if (partID !== undefined) properties.partID = partID;
  return { type, properties };
}

describe("EventBatcher — high-priority pass-through (BET-46 Risk #2)", () => {
  it("exposes the forced high-priority types", () => {
    expect([...HIGH_PRIORITY_TYPES]).toEqual(["permission.asked", "question.asked"]);
  });

  it("emits permission.asked / question.asked immediately, never buffered", () => {
    const t = makeFakeTimer();
    const out: BusEvent[] = [];
    const b = new EventBatcher({
      emit: (e) => out.push(e),
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    b.push(ev("permission.asked", "s1"));
    b.push(ev("question.asked", "s1"));

    // Delivered synchronously — no timer advance needed.
    expect(out.map((e) => e.type)).toEqual(["permission.asked", "question.asked"]);
    expect(t.hasPending()).toBe(false);
  });

  it("flushes buffered events before a high-priority one to preserve order", () => {
    const t = makeFakeTimer();
    const out: BusEvent[] = [];
    const b = new EventBatcher({
      emit: (e) => out.push(e),
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    b.push(ev("message.updated", "s1"));
    b.push(ev("permission.asked", "s1")); // forces a flush of the buffered event first

    expect(out.map((e) => e.type)).toEqual(["message.updated", "permission.asked"]);
  });

  it("NEVER drops permission.asked / question.asked even when the batch floods past the cap", () => {
    const t = makeFakeTimer();
    const out: BusEvent[] = [];
    const b = new EventBatcher({
      emit: (e) => out.push(e),
      maxPerSec: 5,
      dropTypes: ["vcs.branch.updated"],
      // Force permission/question to arrive INSIDE a big batch by not tripping
      // the immediate path: we push them interleaved and rely on the primitive's
      // forced high-priority set. (Here they take the immediate path, so also
      // assert the flooded batch keeps every droppable-cap survivor sane.)
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    // Flood: 50 droppable events, cap 5 → most vcs events get shed.
    for (let i = 0; i < 50; i++) b.push(ev("vcs.branch.updated"));
    // A permission.asked mid-flood: immediate path drains the buffer then emits.
    b.push(ev("permission.asked", "s1"));
    t.advance(); // (buffer already drained by the high-priority push; no-op)

    const perms = out.filter((e) => e.type === "permission.asked");
    expect(perms).toHaveLength(1); // always survives
  });
});

describe("EventBatcher — batching + rate-limit/coalesce", () => {
  it("buffers non-priority events and flushes them on the window timer", () => {
    const t = makeFakeTimer();
    const out: BusEvent[] = [];
    const b = new EventBatcher({
      emit: (e) => out.push(e),
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    b.push(ev("message.updated", "s1"));
    b.push(ev("session.status", "s1"));
    expect(out).toHaveLength(0); // nothing emitted before the window fires
    expect(t.hasPending()).toBe(true);

    t.advance();
    expect(out.map((e) => e.type)).toEqual(["message.updated", "session.status"]);
  });

  it("coalesces consecutive same-part message.part.delta into the last one", () => {
    const t = makeFakeTimer();
    const out: BusEvent[] = [];
    const b = new EventBatcher({
      emit: (e) => out.push(e),
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    // Three deltas for the same (session, part) → collapse to the last.
    const d1 = { ...ev("message.part.delta", "s1", "p1"), seq: 1 } as BusEvent;
    const d2 = { ...ev("message.part.delta", "s1", "p1"), seq: 2 } as BusEvent;
    const d3 = { ...ev("message.part.delta", "s1", "p1"), seq: 3 } as BusEvent;
    b.push(d1);
    b.push(d2);
    b.push(d3);
    t.advance();

    expect(out).toHaveLength(1);
    expect((out[0] as unknown as { seq: number }).seq).toBe(3); // the last event object survives
  });

  it("does NOT coalesce deltas across different parts/sessions", () => {
    const t = makeFakeTimer();
    const out: BusEvent[] = [];
    const b = new EventBatcher({
      emit: (e) => out.push(e),
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    b.push(ev("message.part.delta", "s1", "p1"));
    b.push(ev("message.part.delta", "s1", "p2")); // different part
    b.push(ev("message.part.delta", "s2", "p1")); // different session
    t.advance();

    expect(out).toHaveLength(3); // no cross-key collapse
  });

  it("drops vcs.branch.updated first when a batch exceeds maxPerSec", () => {
    const t = makeFakeTimer();
    const out: BusEvent[] = [];
    const b = new EventBatcher({
      emit: (e) => out.push(e),
      maxPerSec: 3,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    // 2 keep events + 4 droppable = 6, cap 3 → shed 3 vcs events.
    b.push(ev("message.updated", "s1"));
    b.push(ev("vcs.branch.updated"));
    b.push(ev("vcs.branch.updated"));
    b.push(ev("vcs.branch.updated"));
    b.push(ev("vcs.branch.updated"));
    b.push(ev("session.status", "s1"));
    t.advance();

    // The two non-droppable events always survive.
    expect(out.filter((e) => e.type === "message.updated")).toHaveLength(1);
    expect(out.filter((e) => e.type === "session.status")).toHaveLength(1);
    // At most 1 vcs event survives (6 - 3 dropped, minus the 2 keepers = 1).
    expect(out.filter((e) => e.type === "vcs.branch.updated").length).toBeLessThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("emits the ORIGINAL event object (no __orig shim leakage)", () => {
    const t = makeFakeTimer();
    const out: BusEvent[] = [];
    const b = new EventBatcher({
      emit: (e) => out.push(e),
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });
    const original = ev("message.updated", "s1");
    b.push(original);
    t.advance();
    expect(out[0]).toBe(original); // same reference, un-shimmed
    expect((out[0] as Record<string, unknown>).__orig).toBeUndefined();
  });

  it("stop() cancels a pending flush and discards the buffer", () => {
    const t = makeFakeTimer();
    const out: BusEvent[] = [];
    const b = new EventBatcher({
      emit: (e) => out.push(e),
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });
    b.push(ev("message.updated", "s1"));
    b.stop();
    t.advance(); // no pending timer → nothing fires
    expect(out).toHaveLength(0);
    expect(t.hasPending()).toBe(false);
  });

  it("flood integration: rate-limits/coalesces bulk while high-priority always passes", () => {
    const t = makeFakeTimer();
    const out: BusEvent[] = [];
    const b = new EventBatcher({
      emit: (e) => out.push(e),
      maxPerSec: 10,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    // Interleave a permission.asked into a delta storm + vcs churn.
    for (let i = 0; i < 100; i++) b.push(ev("message.part.delta", "s1", "p1"));
    b.push(ev("permission.asked", "s1")); // immediate — flushes the coalesced storm first
    for (let i = 0; i < 100; i++) b.push(ev("vcs.branch.updated"));
    t.advance(); // flush the vcs batch

    // The 100 same-part deltas coalesced to 1; permission survived; vcs got capped.
    expect(out.filter((e) => e.type === "permission.asked")).toHaveLength(1);
    expect(out.filter((e) => e.type === "message.part.delta")).toHaveLength(1);
    expect(out.filter((e) => e.type === "vcs.branch.updated").length).toBeLessThanOrEqual(10);
  });
});
