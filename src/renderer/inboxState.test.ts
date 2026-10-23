import { describe, expect, it } from "vitest";
import {
  ATTACHMENTS_NOT_RESTORED,
  SET_DELIVERY_UNCONFIRMED,
  acceptInbox,
  busySendHint,
  describeInboxSetDelivery,
  inboxBadgeLabel,
  inboxRowNote,
  pendingHeaderText,
  showStoppedFooter,
  createInboxTracker,
  describeInboxCancel,
  parseInboxSnapshot,
  planBusySend,
  shouldClearDraft,
} from "./inboxState";
import type { OpencodeInboxItem } from "../shared/types";

const it_ = (id: string, text = id, attachmentCount = 0): OpencodeInboxItem => ({
  id,
  text,
  delivery: "steer",
  createdAt: 1,
  attachmentCount,
});
const snap = (epoch: string, rev: number, ...ids: string[]) => ({ epoch, rev, items: ids.map((i) => it_(i)) });

describe("parseInboxSnapshot", () => {
  it("accepts a well-formed snapshot", () => {
    expect(parseInboxSnapshot(snap("e", 1, "a"))?.items).toHaveLength(1);
  });
  it.each([null, undefined, 5, "x", {}, { epoch: "", rev: 1, items: [] }, { epoch: "e", rev: "1", items: [] }, { epoch: "e", rev: NaN, items: [] }, { epoch: "e", rev: 1 }])(
    "rejects %j",
    (bad) => expect(parseInboxSnapshot(bad)).toBeNull(),
  );
  it("drops malformed items but keeps the rest", () => {
    const p = parseInboxSnapshot({ epoch: "e", rev: 1, items: [it_("a"), null, { text: "no id" }] });
    expect(p?.items.map((i) => i.id)).toEqual(["a"]);
  });
});

describe("acceptInbox (K3)", () => {
  it("shows the first payload", () => {
    const r = acceptInbox(null, snap("e", 1, "a"), new Set());
    expect(r.accepted).toBe(true);
  });
  it("same epoch: only a higher rev replaces", () => {
    const shown = snap("e", 5, "a");
    expect(acceptInbox(shown, snap("e", 5, "b"), new Set()).accepted).toBe(false);
    expect(acceptInbox(shown, snap("e", 4, "b"), new Set()).accepted).toBe(false);
    const r = acceptInbox(shown, snap("e", 6, "b"), new Set());
    expect(r.accepted).toBe(true);
    expect(r.next?.items[0].id).toBe("b");
  });
  it("a new, non-retired epoch replaces even at a lower rev, and retires the previous epoch", () => {
    const retired = new Set<string>();
    const r = acceptInbox(snap("old", 50, "a"), snap("new", 1, "b"), retired);
    expect(r.accepted).toBe(true);
    expect(retired.has("old")).toBe(true);
  });
  it("a payload from a retired epoch is always dropped", () => {
    const retired = new Set(["old"]);
    expect(acceptInbox(snap("new", 1, "b"), snap("old", 999, "z"), retired).accepted).toBe(false);
    expect(acceptInbox(null, snap("old", 1, "z"), retired).accepted).toBe(false);
  });
  it("a malformed payload changes nothing", () => {
    const shown = snap("e", 1, "a");
    const r = acceptInbox(shown, null, new Set());
    expect(r).toEqual({ next: shown, accepted: false });
  });
});

describe("createInboxTracker", () => {
  it("notifies on accepted payloads only", () => {
    const seen: string[][] = [];
    const t = createInboxTracker((items) => seen.push(items.map((i) => i.id)), new Set());
    expect(t.offerFrame(snap("e", 1, "a"))).toBe(true);
    expect(t.offerFrame(snap("e", 1, "b"))).toBe(false);
    expect(t.offerFrame(snap("e", 2))).toBe(true);
    expect(seen).toEqual([["a"], []]);
  });
  it("drops an RPC response requested before the latest resync", () => {
    const seen: string[][] = [];
    const t = createInboxTracker((items) => seen.push(items.map((i) => i.id)), new Set());
    const before = t.beginRequest();
    t.markResync();
    const after = t.beginRequest();
    expect(t.offerResponse(after, snap("new", 1, "fresh"))).toBe(true);
    expect(t.offerResponse(before, snap("dead", 99, "stale"))).toBe(false);
    expect(seen).toEqual([["fresh"]]);
  });
  it("a response issued after the resync is accepted", () => {
    const t = createInboxTracker(() => {}, new Set());
    t.markResync();
    expect(t.offerResponse(t.beginRequest(), snap("e", 1, "a"))).toBe(true);
  });
  it("drops everything once disposed (the panel left the session)", () => {
    const seen: unknown[] = [];
    const t = createInboxTracker((i) => seen.push(i), new Set());
    const stamp = t.beginRequest();
    t.dispose();
    expect(t.offerResponse(stamp, snap("e", 1, "a"))).toBe(false);
    expect(t.offerFrame(snap("e", 2, "a"))).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("planBusySend", () => {
  const local = new Set(["clear", "fork", "compact", "help"]);
  const known = [{ name: "review" }, { name: "init" }];
  it("plain text is a steered prompt", () => {
    expect(planBusySend("keep going", local, known)).toEqual({ kind: "prompt" });
  });
  it.each(["clear", "fork", "compact", "help"])("refuses local /%s with a visible message", (n) => {
    expect(planBusySend(`/${n}`, local, known)).toEqual({
      kind: "refuse",
      message: `Stop the agent or wait for it to finish before /${n}`,
    });
  });
  it("a known opencode command is a steered command with its arguments", () => {
    expect(planBusySend("/review HEAD~1 --deep", local, known)).toEqual({ kind: "command", name: "review", args: "HEAD~1 --deep" });
    expect(planBusySend("/init", local, known)).toEqual({ kind: "command", name: "init", args: "" });
  });
  it("an unknown /thing (a skill, a path) is sent as a prompt, like the idle path", () => {
    expect(planBusySend("/some-skill do it", local, known)).toEqual({ kind: "prompt" });
    expect(planBusySend("/home/dev/x is broken", local, known)).toEqual({ kind: "prompt" });
  });
  it("tolerates commands not loaded yet", () => {
    expect(planBusySend("/review x", local, null)).toEqual({ kind: "prompt" });
  });
});

describe("shouldClearDraft", () => {
  it("clears only when the composer still holds exactly the submitted draft", () => {
    expect(shouldClearDraft("abc", "abc")).toBe(true);
    expect(shouldClearDraft("abc", "abcd")).toBe(false);
    expect(shouldClearDraft("abc", "")).toBe(false);
  });
  it("never clears when there is no composer draft (text came from an override)", () => {
    expect(shouldClearDraft(null, "")).toBe(false);
    expect(shouldClearDraft(null, "anything")).toBe(false);
  });
});

describe("describeInboxCancel", () => {
  const item = it_("m", "the text");
  it("cancelled + restore → restores the text, no message", () => {
    expect(describeInboxCancel({ outcome: "cancelled", item }, item, { restore: true })).toEqual({ restoreText: "the text", error: null, notice: null });
  });
  it("cancelled without restore (the × button) restores nothing", () => {
    expect(describeInboxCancel({ outcome: "cancelled", item }, item, { restore: false }).restoreText).toBeNull();
  });
  it("cancelled with attachments adds the re-attach note (only when restoring)", () => {
    const withFiles = it_("m", "t", 2);
    expect(describeInboxCancel({ outcome: "cancelled", item: withFiles }, withFiles, { restore: true }).notice).toBe(ATTACHMENTS_NOT_RESTORED);
    expect(describeInboxCancel({ outcome: "cancelled", item: withFiles }, withFiles, { restore: false }).notice).toBeNull();
  });
  it("prefers the server's pre-cancel copy of the text", () => {
    expect(describeInboxCancel({ outcome: "cancelled", item: it_("m", "server copy") }, item, { restore: true }).restoreText).toBe("server copy");
  });
  it("delivered → 'Already sent to the agent', nothing restored", () => {
    expect(describeInboxCancel({ outcome: "delivered" }, item, { restore: true })).toEqual({ restoreText: null, error: null, notice: "Already sent to the agent" });
  });
  it("unknown → may still be sent, nothing restored (it could go out twice)", () => {
    expect(describeInboxCancel({ outcome: "unknown" }, item, { restore: true })).toEqual({
      restoreText: null,
      error: "Couldn't confirm it was cancelled — it may still be sent",
      notice: null,
    });
  });
  it("a missing/garbled result is treated as unknown, never as cancelled", () => {
    expect(describeInboxCancel(null, item, { restore: true }).restoreText).toBeNull();
    expect(describeInboxCancel(undefined, item, { restore: true }).error).toContain("may still be sent");
  });
});

describe("pending card helpers", () => {
  it("pendingHeaderText: singular and plural", () => {
    expect(pendingHeaderText(1)).toBe("Pending · 1 message");
    expect(pendingHeaderText(2)).toBe("Pending · 2 messages");
  });
  it("badge: Now for steer, After this turn for queue", () => {
    expect(inboxBadgeLabel({ delivery: "steer" })).toBe("Now");
    expect(inboxBadgeLabel({ delivery: "queue" })).toBe("After this turn");
  });
  it("row note: only Now rows, 'at next step' while running, 'runs next' once stopped", () => {
    expect(inboxRowNote({ delivery: "steer" }, true)).toBe("at next step");
    expect(inboxRowNote({ delivery: "steer" }, false)).toBe("runs next");
    expect(inboxRowNote({ delivery: "queue" }, true)).toBeNull();
    expect(inboxRowNote({ delivery: "queue" }, false)).toBeNull();
  });
  it("stopped footer: not running AND an After item", () => {
    const now = { delivery: "steer" as const };
    const after = { delivery: "queue" as const };
    expect(showStoppedFooter([after], false)).toBe(true);
    expect(showStoppedFooter([now, after], false)).toBe(true);
    expect(showStoppedFooter([after], true)).toBe(false);
    expect(showStoppedFooter([now], false)).toBe(false);
    expect(showStoppedFooter([], false)).toBe(false);
  });
  it("busySendHint: ⌥ on mac, Alt+ elsewhere", () => {
    expect(busySendHint(true)).toBe("⏎ send now · ⌥⏎ after this turn");
    expect(busySendHint(false)).toBe("⏎ send now · Alt+⏎ after this turn");
  });
});

describe("describeInboxSetDelivery (N1)", () => {
  it("changed: nothing to show", () => {
    expect(describeInboxSetDelivery({ outcome: "changed" })).toEqual({ error: null, notice: null });
  });
  it("delivered: a toast", () => {
    expect(describeInboxSetDelivery({ outcome: "delivered" })).toEqual({ error: null, notice: "Already sent to the agent" });
  });
  it.each([{ outcome: "unknown" as const }, null, undefined, {} as never])("%j: an error, never silent", (r) => {
    expect(describeInboxSetDelivery(r)).toEqual({ error: SET_DELIVERY_UNCONFIRMED, notice: null });
  });
});
