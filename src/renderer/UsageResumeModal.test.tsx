// @vitest-environment jsdom
//
// The resume-after-limit screen, server-first (WS09 SF-M14/M15): the box builds
// the whole view (`usage-stopped:view`) and plans the writes
// (`usage-stopped:apply`, dry run first). The row/arithmetic rules are pinned by
// src/server/usageResumeView.test.mjs; here we assert the modal renders the box's
// fields, drives the dry run + apply, reconciles the selection when the box's list
// changes under it, and reports both outcomes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, mount, resetStore, clickCheckbox, type Harness, type MockEventBus } from "./testHarness";
import { UsageResumeModal } from "./UsageResumeModal";
import type { UsageResumeRowView, UsageResumeView } from "../shared/types";

const row = (conversation: string, over: Partial<UsageResumeRowView> = {}): UsageResumeRowView => ({
  conversation,
  name: conversation,
  armed: false,
  isNew: false,
  snippet: null,
  provider: "claude",
  model: "claude-sonnet-4-6",
  window: { label: "Weekly", resetsAt: null },
  cost: { warm: true, reReadTokens: 0, label: "cache still warm · no extra cost" },
  ...over,
});

const view = (rows: UsageResumeRowView[], over: Partial<UsageResumeView> = {}): UsageResumeView => ({
  supported: true,
  title: "Resume after limit reset",
  header: `${rows.length} conversations were stopped by a provider limit. Pick which ones should carry on by themselves when quota returns.`,
  hasArmed: rows.some((r) => r.armed),
  unarmedCount: rows.filter((r) => !r.armed).length,
  totalCount: rows.length,
  emptyText: "No conversations are stopped by a provider limit right now.",
  groups: rows.length ? [{ workspace: "manta", rows }] : [],
  coldNote: { one: "One of these resets well past your prompt-cache window.", many: "{n} of these reset well past your prompt-cache window." },
  ...over,
});

const plan = (over: Record<string, unknown> = {}) => ({ ok: true, canApply: true, title: "Update", arm: [], disarm: [], ...over });

function primary(harness: Harness): HTMLButtonElement | null {
  const btns = [...harness.docQuery('div[role="dialog"]')!.querySelectorAll("button")];
  return btns.find((b) => /Resume \d|Update/.test(b.textContent ?? "")) ?? null;
}
const toggle = (h: Harness, name: string) => clickCheckbox(h, `Resume ${name}`);
const settle = async (h: Harness) => {
  await h.flush();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  await h.flush();
};

describe("UsageResumeModal — box view + dry-run + apply", () => {
  let h: Harness | null = null;
  let bus: MockEventBus;
  let current: UsageResumeView;
  const apply = vi.fn();
  const stamp = vi.fn(async () => undefined);

  const install = (extra: Record<string, unknown> = {}) => {
    ({ bus } = installMockApi({
      usageStoppedView: () => Promise.resolve(current),
      usageStoppedApply: apply,
      usageStoppedStampLastLooked: stamp,
      ...extra,
    }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetStore({});
    current = view([row("ses_a", { armed: true }), row("ses_b")]);
    apply.mockImplementation(async (i: { dryRun?: boolean }) => (i.dryRun ? plan() : { ...plan(), applied: { armed: [], disarmed: [] }, failed: [], message: "Updated" }));
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the box's title, header, rows, chips and starts with the armed rows selected", async () => {
    current = view([row("ses_a", { name: "fix login", armed: true, isNew: true, snippet: "I updated the guard…", window: { label: "Weekly", resetsAt: null } }), row("ses_b", { cost: { warm: false, reReadTokens: 340_000, label: "≈ 340k tokens re-read" } })]);
    install();
    h = mount(<UsageResumeModal open onClose={() => {}} />);
    await settle(h);
    const t = h.docText();
    expect(t).toContain("Resume after limit reset");
    expect(t).toContain("2 conversations were stopped by a provider limit");
    expect(t).toContain("fix login");
    expect(t).toContain("armed");
    expect(t).toContain("new");
    expect(t).toContain("I updated the guard…");
    expect(t).toContain("≈ 340k tokens re-read");
    expect(t).toContain("1 of 2 selected");
  });

  it("the primary button's title and enabled state come from the dry run; unchecking the ONLY armed row enables it", async () => {
    current = view([row("ses_a", { armed: true })], { hasArmed: true });
    apply.mockImplementation(async (i: { selected: string[]; dryRun?: boolean }) =>
      i.dryRun ? plan({ canApply: i.selected.length === 0, disarm: i.selected.length === 0 ? ["ses_a"] : [] }) : { ...plan(), failed: [], message: "Removed" },
    );
    install();
    h = mount(<UsageResumeModal open onClose={() => {}} />);
    await settle(h);
    // No change yet → the dry run says nothing to apply → disabled.
    expect(primary(h)!.disabled).toBe(true);
    toggle(h, "ses_a");
    await settle(h);
    expect(apply).toHaveBeenCalledWith({ selected: [], dryRun: true });
    expect(primary(h)!.disabled).toBe(false);
    expect(primary(h)!.textContent).toContain("Update");
  });

  it("Apply awaits usageStoppedApply, then stamps last-looked and closes; the footer sums the box's re-read numbers", async () => {
    current = view([row("ses_a"), row("ses_b", { cost: { warm: false, reReadTokens: 2000, label: "≈ 2k tokens re-read" } })]);
    const onClose = vi.fn();
    install();
    h = mount(<UsageResumeModal open onClose={onClose} />);
    await settle(h);
    toggle(h, "ses_a");
    toggle(h, "ses_b");
    await settle(h);
    expect(h.docText()).toContain("2 selected");
    expect(h.docText()).toContain("≈ 2k tokens re-read");
    expect(h.docText()).toContain("One of these resets well past your prompt-cache window.");
    await act(async () => primary(h!)!.click());
    await h.flush();
    expect(apply).toHaveBeenLastCalledWith({ selected: ["ses_a", "ses_b"] });
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a failed apply keeps the modal open and shows the box's message naming the row", async () => {
    apply.mockImplementation(async (i: { dryRun?: boolean }) =>
      i.dryRun ? plan() : { ...plan(), ok: false, failed: [{ conversation: "ses_b", name: "ses_b", message: "Couldn't update ses_b — boom. The ones after it weren't changed." }], message: "Couldn't update ses_b — boom. The ones after it weren't changed." },
    );
    const onClose = vi.fn();
    install();
    h = mount(<UsageResumeModal open onClose={onClose} />);
    await settle(h);
    toggle(h, "ses_b");
    await settle(h);
    await act(async () => primary(h!)!.click());
    await h.flush();
    expect(h.docText()).toContain("Couldn't update ses_b — boom.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a second device arms B and removes C while open: rows update, C leaves the selection, the user's toggle on A survives, a new dry run is issued", async () => {
    current = view([row("A"), row("C", { armed: false })]);
    install();
    h = mount(<UsageResumeModal open onClose={() => {}} />);
    await settle(h);
    toggle(h, "A");
    toggle(h, "C");
    await settle(h);
    expect(h.docText()).toContain("2 of 2 selected");
    apply.mockClear();
    current = view([row("A"), row("B", { armed: true })]);
    act(() => bus.emitStream({ sub: "resync", sessionId: "", payload: {} }));
    await settle(h);
    const t = h.docText();
    expect(t).toContain("B");
    expect(t).toContain("1 of 2 selected"); // A (user's choice) stays; C vanished; B is NOT auto-selected
    expect(apply).toHaveBeenCalledWith({ selected: ["A"], dryRun: true });
  });

  it("an older (stale) view response arriving after a newer one is ignored", async () => {
    let resolveFirst: (v: UsageResumeView) => void = () => {};
    let calls = 0;
    install({
      usageStoppedView: () => (++calls === 1 ? new Promise<UsageResumeView>((r) => (resolveFirst = r)) : Promise.resolve(view([row("fresh")]))),
    });
    h = mount(<UsageResumeModal open onClose={() => {}} />);
    await h.flush();
    act(() => bus.emitStream({ sub: "resync", sessionId: "", payload: {} })); // second load
    await settle(h);
    expect(h.docText()).toContain("fresh");
    await act(async () => resolveFirst(view([row("stale")])));
    await h.flush();
    expect(h.docText()).toContain("fresh");
    expect(h.docText()).not.toContain("stale");
  });

  it("an older box (unknown channel) shows 'Update your box to use this.'", async () => {
    install({ usageStoppedView: () => Promise.reject(new Error("unknown rpc channel: usage-stopped:view")) });
    h = mount(<UsageResumeModal open onClose={() => {}} />);
    await settle(h);
    expect(h.docText()).toContain("Update your box to use this.");
  });

  it("closing stamps last-looked even without applying", async () => {
    install();
    h = mount(<UsageResumeModal open onClose={() => {}} />);
    await settle(h);
    const cancel = [...h.docQuery('div[role="dialog"]')!.querySelectorAll("button")].find((b) => /^(Cancel|Close)$/.test(b.textContent?.trim() ?? ""))!;
    await act(async () => cancel.click());
    expect(stamp).toHaveBeenCalledTimes(1);
  });
});
