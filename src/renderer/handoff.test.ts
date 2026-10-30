import { describe, it, expect } from "vitest";
import type { HandoffRecord } from "../shared/api";
import type { OpencodePart } from "../shared/types";
import type { Attachment } from "./chatShared";
import {
  appendBelow,
  buildPreviousEntries,
  carriableAttachments,
  creatingRecord,
  describeHandoffError,
  describeRewriteError,
  describeHandoffSource,
  draftRecordFor,
  eventOfRecord,
  handoffActionsEnabled,
  handoffBadge,
  handoffCanDismiss,
  handoffIdOfPart,
  isEmptyCarry,
  isHandoffToolPart,
  nextHandoffMode,
  normalizeHandoffMode,
  parseHandoffMarker,
  placeDraft,
  previousEntryLabel,
  selectPinnedHandoffs,
  shouldLoadDraft,
  shouldSwitchPane,
} from "./handoff";

function rec(over: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    id: "hof_a",
    fromSessionId: "ses_old",
    kind: "suggest",
    trigger: "user",
    state: "ready",
    text: "## Goal\nship it",
    createdAt: 100,
    updatedAt: 100,
    ...over,
  };
}

describe("tool marker", () => {
  it("parses the id and strips the marker line, keeping the status line", () => {
    const out = "Handoff prompt ready below.\n<!-- manta-handoff:hof_0abc123 -->";
    expect(parseHandoffMarker(out)).toEqual({ id: "hof_0abc123", text: "Handoff prompt ready below." });
  });
  it("accepts ids with - and _ and ignores surrounding whitespace", () => {
    expect(parseHandoffMarker("  \n<!-- manta-handoff:a-b_C9 -->\n").id).toBe("a-b_C9");
  });
  it("returns a null id when there is no marker", () => {
    expect(parseHandoffMarker("Handoff queued")).toEqual({ id: null, text: "Handoff queued" });
    expect(parseHandoffMarker(undefined)).toEqual({ id: null, text: "" });
  });
  it("recognises the tool part by name and reads the id from its output", () => {
    const part = {
      id: "p1",
      type: "tool",
      tool: "handoff",
      state: { status: "completed", output: "ok\n<!-- manta-handoff:hof_z -->" },
    } as unknown as OpencodePart;
    expect(isHandoffToolPart(part)).toBe(true);
    expect(handoffIdOfPart(part)).toBe("hof_z");
    expect(isHandoffToolPart({ ...part, tool: "bash" } as OpencodePart)).toBe(false);
    expect(isHandoffToolPart({ ...part, type: "text" } as OpencodePart)).toBe(false);
  });
  it("has no id while the tool is still running", () => {
    const part = { id: "p", type: "tool", tool: "handoff", state: { status: "running" } } as unknown as OpencodePart;
    expect(handoffIdOfPart(part)).toBeNull();
  });
});

describe("state → badge / actions", () => {
  it("maps every state", () => {
    expect(handoffBadge("requested").label).toBe("preparing");
    expect(handoffBadge("generating").label).toBe("preparing");
    expect(handoffBadge("ready").label).toBe("ready");
    expect(handoffBadge("starting").label).toBe("starting");
    expect(handoffBadge("committed").label).toBe("started");
    expect(handoffBadge("failed")).toEqual({ label: "failed", tone: "danger" });
    expect(handoffBadge("cancelled").label).toBe("cancelled");
  });
  it("enables actions only in ready", () => {
    expect(handoffActionsEnabled({ state: "ready" })).toBe(true);
    for (const state of ["requested", "generating", "starting", "committed", "failed", "cancelled"] as const) {
      expect(handoffActionsEnabled({ state })).toBe(false);
    }
  });
  it("names the source", () => {
    expect(describeHandoffSource(rec({ trigger: "agent" }))).toBe("agent");
    expect(describeHandoffSource(rec({ trigger: "user" }))).toBe("/handoff");
    expect(describeHandoffSource(rec({ trigger: "button" }))).toBe("Hand off button");
    expect(describeHandoffSource(rec({ trigger: "auto", kind: "auto" }))).toBe("automatic");
  });
  it("badges a dismissed record and offers dismiss only for ready/failed", () => {
    expect(handoffBadge("dismissed")).toEqual({ label: "dismissed", tone: "neutral" });
    expect(handoffCanDismiss({ state: "ready" })).toBe(true);
    expect(handoffCanDismiss({ state: "failed" })).toBe(true);
    for (const state of ["requested", "generating", "starting", "committed", "cancelled", "dismissed"] as const) {
      expect(handoffCanDismiss({ state }), state).toBe(false);
    }
  });
});

describe("selectPinnedHandoffs", () => {
  it("pins the newest server-path record from this session when it is ready/starting/failed/preparing", () => {
    for (const state of ["ready", "starting", "failed", "generating", "requested"] as const) {
      expect(selectPinnedHandoffs([rec({ state })], "ses_old")).toHaveLength(1);
    }
  });
  it("never pins agent-path records (they are the tool part)", () => {
    expect(selectPinnedHandoffs([rec({ trigger: "agent" })], "ses_old")).toEqual([]);
  });
  it("does not pin started/cancelled ones or another session's", () => {
    expect(selectPinnedHandoffs([rec({ state: "committed" })], "ses_old")).toEqual([]);
    expect(selectPinnedHandoffs([rec({ state: "cancelled" })], "ses_old")).toEqual([]);
    expect(selectPinnedHandoffs([rec({ state: "dismissed" })], "ses_old")).toEqual([]);
    expect(selectPinnedHandoffs([rec()], "ses_other")).toEqual([]);
    // a record where this session is the SUCCESSOR is not this session's card
    expect(selectPinnedHandoffs([rec({ fromSessionId: "ses_x", successorId: "ses_old" })], "ses_old")).toEqual([]);
  });
  it("lets a newer handoff supersede an older ready card", () => {
    const old = rec({ id: "hof_old", createdAt: 1, state: "ready" });
    const started = rec({ id: "hof_new", createdAt: 2, state: "committed" });
    expect(selectPinnedHandoffs([old, started], "ses_old")).toEqual([]);
    const newer = rec({ id: "hof_new2", createdAt: 3, state: "ready" });
    expect(selectPinnedHandoffs([old, started, newer], "ses_old").map((r) => r.id)).toEqual(["hof_new2"]);
  });
});

describe("shouldSwitchPane", () => {
  const ev = { fromSessionId: "ses_old", successorId: "ses_new", state: "committed", how: "clear" } as const;
  it("switches a pane showing the predecessor when a replacement commits", () => {
    expect(shouldSwitchPane("ses_old", ev)).toBe(true);
  });
  it("does not switch a pane showing anything else", () => {
    expect(shouldSwitchPane("ses_new", ev)).toBe(false);
    expect(shouldSwitchPane("ses_unrelated", ev)).toBe(false);
  });
  it("never switches from an event for a branch", () => {
    expect(shouldSwitchPane("ses_old", { ...ev, how: "new-session" })).toBe(false);
  });
  it("waits for the commit and for a named successor", () => {
    expect(shouldSwitchPane("ses_old", { ...ev, state: "starting" })).toBe(false);
    expect(shouldSwitchPane("ses_old", { ...ev, state: "ready" })).toBe(false);
    expect(shouldSwitchPane("ses_old", { ...ev, successorId: undefined })).toBe(false);
  });
  it("reads a record as the event the bus would have sent", () => {
    const r = rec({ state: "committed", how: "clear", successorId: "ses_new" });
    expect(shouldSwitchPane("ses_old", eventOfRecord(r))).toBe(true);
  });
});

describe("composer carry-over + draft", () => {
  it("appends below, never over, and skips empties", () => {
    expect(appendBelow("a", "b")).toBe("a\n\nb");
    expect(appendBelow("a\n", "b")).toBe("a\n\nb");
    expect(appendBelow("", "b")).toBe("b");
    expect(appendBelow("a", "  ")).toBe("a");
  });
  it("puts a draft above what the composer already holds", () => {
    expect(placeDraft("draft", "typed")).toBe("draft\n\ntyped");
    expect(placeDraft("", "typed")).toBe("typed");
  });
  it("carries only uploaded chips", () => {
    const att = (id: string, status: Attachment["status"], remotePath?: string): Attachment => ({
      id,
      filename: id,
      mime: "image/png",
      status,
      source: "drop",
      remotePath,
    });
    const out = carriableAttachments([att("a", "ready", "/x"), att("b", "uploading"), att("c", "error"), att("d", "ready")]);
    expect(out.map((a) => a.id)).toEqual(["a"]);
  });
  it("knows an empty carry", () => {
    expect(isEmptyCarry({ text: "  ", attachments: [] })).toBe(true);
    expect(isEmptyCarry(null)).toBe(true);
    expect(isEmptyCarry({ text: "x", attachments: [] })).toBe(false);
  });
  it("loads only an unconsumed, not-yet-loaded revision", () => {
    const c = { draft: "d", draftRevision: 2 };
    expect(shouldLoadDraft(c, null)).toBe(true);
    expect(shouldLoadDraft(c, 1)).toBe(true);
    expect(shouldLoadDraft(c, 2)).toBe(false);
    expect(shouldLoadDraft({ ...c, draftConsumed: true }, null)).toBe(false);
    expect(shouldLoadDraft({ draft: "d" }, null)).toBe(false);
    expect(shouldLoadDraft({ draft: "  ", draftRevision: 1 }, null)).toBe(false);
    expect(shouldLoadDraft(null, null)).toBe(false);
  });
  it("finds the record a draft belongs to (newest draft-disposition start into the session)", () => {
    const a = rec({ id: "a", successorId: "ses_new", disposition: "draft", createdAt: 1 });
    const b = rec({ id: "b", successorId: "ses_new", disposition: "draft", createdAt: 2 });
    const c = rec({ id: "c", successorId: "ses_new", disposition: "send", createdAt: 3 });
    expect(draftRecordFor([a, b, c], "ses_new")?.id).toBe("b");
    expect(draftRecordFor([c], "ses_new")).toBeNull();
  });
});

describe("mode", () => {
  it("cycles auto → suggest → off → auto", () => {
    expect(nextHandoffMode("auto")).toBe("suggest");
    expect(nextHandoffMode("suggest")).toBe("off");
    expect(nextHandoffMode("off")).toBe("auto");
  });
  it("defaults anything unknown (or absent, on an older box) to suggest", () => {
    expect(normalizeHandoffMode(undefined)).toBe("suggest");
    expect(normalizeHandoffMode("nope")).toBe("suggest");
    expect(normalizeHandoffMode("auto")).toBe("auto");
    expect(normalizeHandoffMode("off")).toBe("off");
    expect(normalizeHandoffMode("suggest")).toBe("suggest");
  });
});

describe("describeRewriteError", () => {
  it("shows the box's sentence as written", () => {
    expect(describeRewriteError(new Error("This handoff is being written right now."))).toBe(
      "This handoff is being written right now.",
    );
  });
  it("maps a bare code through the generic wording", () => {
    expect(describeRewriteError(new Error("busy"))).toMatch(/busy/);
    expect(describeRewriteError(new Error("not_ready"))).toMatch(/isn't ready/);
    expect(describeRewriteError(undefined)).toBe("Something went wrong.");
  });
});

describe("describeHandoffError", () => {
  it("words the box's codes", () => {
    expect(describeHandoffError(new Error("already_started"))).toMatch(/already started/);
    expect(describeHandoffError(new Error("busy"))).toMatch(/busy/);
    expect(describeHandoffError(new Error("not_ready"))).toMatch(/isn't ready/);
    expect(describeHandoffError(new Error("HTTP 404"))).toMatch(/expired/);
    expect(describeHandoffError(new Error("dismissed"))).toMatch(/dismissed/);
    expect(describeHandoffError(new Error("This handoff can no longer be dismissed."))).toBe("This handoff can no longer be dismissed.");
    expect(describeHandoffError(new Error("boom"))).toBe("boom");
    expect(describeHandoffError(undefined)).toBe("Something went wrong.");
  });
});

describe("previous sessions", () => {
  it("lists previous sessions newest first, deduped, titled", () => {
    const entries = buildPreviousEntries(
      [
        { id: "ses_b", kind: "previous", at: 200 },
        { id: "ses_a", kind: "previous", at: 100 },
        { id: "ses_o", kind: "branched-from", at: 150 },
        { id: "ses_b", kind: "previous", at: 200 },
      ],
      { ses_b: "  Second  ", ses_o: "Origin" },
    );
    expect(entries.map((e) => e.id)).toEqual(["ses_b", "ses_o", "ses_a"]);
    expect(entries.map((e) => previousEntryLabel(e))).toEqual(["Second", "Branched from Origin", "Untitled session"]);
  });
  it("finds the committed record that created a session", () => {
    const a = rec({ id: "a", successorId: "ses_new", state: "committed", createdAt: 1 });
    const b = rec({ id: "b", successorId: "ses_new", state: "failed", createdAt: 2 });
    expect(creatingRecord([a, b], "ses_new")?.id).toBe("a");
    expect(creatingRecord([b], "ses_new")).toBeNull();
  });
});
