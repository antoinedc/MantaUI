// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Attachment } from "./chatShared";
import { readPlanSaved, writePlanSaved } from "./chatShared";
import { readSessionAuto, writeSessionAuto } from "./modelPrefs";
import {
  clearCarry,
  composeIncoming,
  copySessionPrefs,
  persistDraft,
  readDraftLoaded,
  reconcileSessionPrefs,
  takeCarry,
  writeCarry,
  writeDraftLoaded,
} from "./handoffCarry";
import { installMockApi, type MockApi } from "./testHarness";

const chip = (id: string): Attachment => ({
  id,
  filename: `${id}.png`,
  mime: "image/png",
  status: "ready",
  remotePath: `/up/${id}.png`,
  source: "drop",
});

describe("carry store", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    clearCarry("ses_new");
    localStorage.clear();
  });

  it("stores composer text + chips for the successor and removes them when taken", () => {
    writeCarry("ses_new", { text: "half-typed", attachments: [chip("a")] });
    expect(localStorage.getItem("manta:handoff:carry:ses_new")).toContain("half-typed");
    const got = takeCarry("ses_new");
    expect(got?.text).toBe("half-typed");
    expect(got?.attachments.map((a) => a.id)).toEqual(["a"]);
    expect(takeCarry("ses_new")).toBeNull();
    expect(localStorage.getItem("manta:handoff:carry:ses_new")).toBeNull();
  });

  it("ignores an empty composer", () => {
    writeCarry("ses_new", { text: "  ", attachments: [] });
    expect(takeCarry("ses_new")).toBeNull();
  });

  it("falls back to memory when storage refuses the write", () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      writeCarry("ses_new", { text: "keep me", attachments: [] });
    } finally {
      Storage.prototype.setItem = real;
    }
    expect(takeCarry("ses_new")?.text).toBe("keep me");
  });

  it("puts an Edit-first draft ABOVE the composer and carried text, never over it", () => {
    persistDraft("ses_new", { revision: 3, text: "the edited handoff" });
    writeCarry("ses_new", { text: "my unsent note", attachments: [] });
    const entry = takeCarry("ses_new")!;
    expect(entry.draft).toEqual({ revision: 3, text: "the edited handoff" });
    expect(composeIncoming("", entry)).toBe("the edited handoff\n\nmy unsent note");
    expect(composeIncoming("already here", entry)).toBe("the edited handoff\n\nalready here\n\nmy unsent note");
  });

  it("remembers which draft revision this client already loaded", () => {
    expect(readDraftLoaded("ses_new")).toBeNull();
    writeDraftLoaded("ses_new", 2);
    expect(readDraftLoaded("ses_new")).toBe(2);
  });
});

describe("prefs copy", () => {
  let api: MockApi;
  beforeEach(() => {
    localStorage.clear();
    ({ api } = installMockApi());
  });

  it("copies Auto and the plan toggle", () => {
    writeSessionAuto("ses_old", true);
    writePlanSaved("ses_old", true);
    copySessionPrefs("ses_old", "ses_new", { kind: "auto" });
    expect(readSessionAuto("ses_new")).toBe(true);
    expect(readPlanSaved("ses_new")).toBe(true);
  });

  it("copies a concrete model choice (with its fast variant) to the box record of the successor", () => {
    copySessionPrefs("ses_old", "ses_new", {
      kind: "model",
      model: { providerID: "anthropic", modelID: "claude-opus", variant: "fast" },
    });
    expect(api.calls.modelPrefsSet).toEqual([
      [{ sessionId: "ses_new", selection: { providerID: "anthropic", modelID: "claude-opus", variant: "fast" } }],
    ]);
    expect(readPlanSaved("ses_new")).toBe(false);
  });

  it("writes nothing for a server-default choice", () => {
    copySessionPrefs("ses_old", "ses_new", { kind: "server-default" });
    expect(api.calls.modelPrefsSet).toBeUndefined();
  });

  it("reconcile copies once, and never over a choice the successor already has", () => {
    writeSessionAuto("ses_old", true);
    reconcileSessionPrefs("ses_old", "ses_new");
    expect(readSessionAuto("ses_new")).toBe(true);

    // the user then turns Auto off on the successor — a second reconcile must not undo it
    writeSessionAuto("ses_new", false);
    reconcileSessionPrefs("ses_old", "ses_new");
    expect(readSessionAuto("ses_new")).toBe(false);

    // a successor that already has its own choice is left alone (and marked done)
    writeSessionAuto("ses_mine", true);
    writePlanSaved("ses_old", true);
    reconcileSessionPrefs("ses_old", "ses_mine");
    expect(readPlanSaved("ses_mine")).toBe(false);
    expect(localStorage.getItem("manta:handoff:prefs-copied:ses_mine")).toBe("1");
  });
});
