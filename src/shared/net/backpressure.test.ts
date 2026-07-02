import { describe, it, expect } from "vitest";
import { applyBackpressure, type OpencodeEvent } from "./backpressure";

const HIGH = ["permission.asked", "question.asked"];

function delta(sessionID: string, partID: string, seq: number): OpencodeEvent {
  return { type: "message.part.delta", sessionID, partID, seq };
}

describe("applyBackpressure — coalesce", () => {
  it("collapses consecutive same-key deltas to the last one", () => {
    const events = [
      delta("s1", "p1", 1),
      delta("s1", "p1", 2),
      delta("s1", "p1", 3),
    ];
    const out = applyBackpressure(events, { highPriorityTypes: HIGH });
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(3);
  });

  it("does not collapse across different parts or sessions", () => {
    const events = [
      delta("s1", "p1", 1),
      delta("s1", "p2", 2),
      delta("s2", "p1", 3),
    ];
    const out = applyBackpressure(events, { highPriorityTypes: HIGH });
    expect(out).toHaveLength(3);
  });

  it("only coalesces CONSECUTIVE runs of the same key", () => {
    const events = [
      delta("s1", "p1", 1),
      delta("s1", "p1", 2),
      delta("s1", "p2", 3), // breaks the run
      delta("s1", "p1", 4),
      delta("s1", "p1", 5),
    ];
    const out = applyBackpressure(events, { highPriorityTypes: HIGH });
    // [p1:2, p2:3, p1:5]
    expect(out.map((e) => e.seq)).toEqual([2, 3, 5]);
  });

  it("leaves non-coalesce types untouched", () => {
    const events: OpencodeEvent[] = [
      { type: "message.updated", sessionID: "s1" },
      { type: "message.updated", sessionID: "s1" },
    ];
    const out = applyBackpressure(events, { highPriorityTypes: HIGH });
    expect(out).toHaveLength(2);
  });
});

describe("applyBackpressure — drop under load", () => {
  it("drops drop-types first when over maxPerSec", () => {
    const events: OpencodeEvent[] = [];
    // 3 keepers + 5 droppable, cap 4 -> must drop 4 droppable.
    for (let i = 0; i < 3; i++) events.push({ type: "message.updated", i });
    for (let i = 0; i < 5; i++) events.push({ type: "vcs.branch.updated", i });
    const out = applyBackpressure(events, { maxPerSec: 4, highPriorityTypes: HIGH });
    expect(out).toHaveLength(4);
    // All 3 keepers survive; exactly 1 droppable remains.
    expect(out.filter((e) => e.type === "message.updated")).toHaveLength(3);
    expect(out.filter((e) => e.type === "vcs.branch.updated")).toHaveLength(1);
  });

  it("does not drop when at or below the cap", () => {
    const events: OpencodeEvent[] = [
      { type: "vcs.branch.updated" },
      { type: "message.updated" },
    ];
    const out = applyBackpressure(events, { maxPerSec: 100, highPriorityTypes: HIGH });
    expect(out).toHaveLength(2);
  });

  it("keeps non-droppable events even when over the cap and nothing droppable remains", () => {
    const events: OpencodeEvent[] = [];
    for (let i = 0; i < 10; i++) events.push({ type: "message.updated", i });
    const out = applyBackpressure(events, { maxPerSec: 2, highPriorityTypes: HIGH });
    // Nothing is droppable -> all survive despite being over cap.
    expect(out).toHaveLength(10);
  });

  it("preserves relative order of survivors", () => {
    const events: OpencodeEvent[] = [
      { type: "message.updated", tag: "a" },
      { type: "vcs.branch.updated", tag: "b" },
      { type: "message.updated", tag: "c" },
      { type: "vcs.branch.updated", tag: "d" },
      { type: "message.updated", tag: "e" },
    ];
    const out = applyBackpressure(events, { maxPerSec: 3, highPriorityTypes: HIGH });
    // Drops 2 vcs.branch.updated (b, d) -> a, c, e remain in order.
    expect(out.map((e) => e.tag)).toEqual(["a", "c", "e"]);
  });
});

describe("applyBackpressure — high-priority guarantee (BET-46 Risk #2)", () => {
  it("never drops permission.asked / question.asked even under extreme flood", () => {
    const events: OpencodeEvent[] = [];
    // Flood far past maxPerSec with droppable events, sprinkling in the two
    // hard-guaranteed high-priority events.
    for (let i = 0; i < 5000; i++) {
      events.push({ type: "vcs.branch.updated", i });
      if (i === 1000) events.push({ type: "permission.asked", id: "perm" });
      if (i === 4000) events.push({ type: "question.asked", id: "quest" });
    }
    const out = applyBackpressure(events, { maxPerSec: 10, highPriorityTypes: HIGH });
    expect(out.some((e) => e.type === "permission.asked")).toBe(true);
    expect(out.some((e) => e.type === "question.asked")).toBe(true);
  });

  it("forces permission.asked/question.asked high-priority even if caller omits them", () => {
    const events: OpencodeEvent[] = [];
    for (let i = 0; i < 500; i++) events.push({ type: "vcs.branch.updated", i });
    events.push({ type: "permission.asked" });
    events.push({ type: "question.asked" });
    // Caller passes an unrelated high-priority set — the two must still survive.
    const out = applyBackpressure(events, { maxPerSec: 5, highPriorityTypes: ["some.other"] });
    expect(out.some((e) => e.type === "permission.asked")).toBe(true);
    expect(out.some((e) => e.type === "question.asked")).toBe(true);
  });

  it("does not coalesce a high-priority type even if listed in coalesceTypes", () => {
    const events: OpencodeEvent[] = [
      { type: "permission.asked", sessionID: "s1", partID: "p1", n: 1 },
      { type: "permission.asked", sessionID: "s1", partID: "p1", n: 2 },
    ];
    const out = applyBackpressure(events, {
      coalesceTypes: ["permission.asked"],
      highPriorityTypes: HIGH,
    });
    expect(out).toHaveLength(2);
  });
});
