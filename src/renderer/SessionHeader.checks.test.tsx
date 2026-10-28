// @vitest-environment jsdom
//
// BET-926: the checks popover lists EVERY check in one flat list (failed →
// running → passed), each name a link to its own log, instead of collapsing
// everything that passed into an unexpandable `+ N passed` row. These mount
// the real <SessionHeader> via the render harness, open the checks chip
// (portalled to <body>), and assert on the flat list, the ordering, the
// per-name links, the forge mark, and the unchanged footer actions.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import {
  installMockApi,
  resetStore,
  mountSessionHeader,
  type Harness,
} from "./testHarness";
import type { ForgeCheckRun, ForgePullRequestView, PullRequest } from "../shared/types";

const PR: PullRequest = {
  number: 412,
  title: "forge seam + github adapter",
  body: "",
  url: "https://github.com/x/y/pull/412",
  state: "open",
  draft: false,
  headRef: "feat/forge-seam",
  baseRef: "main",
  headSha: "abc",
  author: "octocat",
  reviewers: ["octocat"],
  mergeable: true,
  mergeBlockedReason: null,
  unresolvedThreads: 0,
};

// Fixture: 2 failed + 1 running + 7 passed = ten checks, ALREADY in the box's
// order (failed → running → passed) and carrying the box's `tone`. All have a
// log URL except p7 (the "no url" case).
const CHECKS: ForgeCheckRun[] = [
  { name: "f1", conclusion: "failure", url: "https://logs/f1", tone: "error" },
  { name: "f2", conclusion: "cancelled", url: "https://logs/f2", tone: "error" },
  { name: "r1", status: "in_progress", url: "https://logs/r1", tone: "running" },
  { name: "p1", conclusion: "success", url: "https://logs/p1", tone: "ok" },
  { name: "p2", conclusion: "success", url: "https://logs/p2", tone: "ok" },
  { name: "p3", conclusion: "success", url: "https://logs/p3", tone: "ok" },
  { name: "p4", conclusion: "success", url: "https://logs/p4", tone: "ok" },
  { name: "p5", conclusion: "success", url: "https://logs/p5", tone: "ok" },
  { name: "p6", conclusion: "success", url: "https://logs/p6", tone: "ok" },
  { name: "p7", conclusion: "success", tone: "ok" },
];

// The box's view: the chip, the "send failures" text and the log URL are its.
const VIEW: ForgePullRequestView = {
  panel: "pr",
  chipLabel: "feat/forge-seam · #412",
  ship: { state: "has-pr", copy: null },
  merge: { can: false, reason: "checks failing", mergeable: { text: "mergeable", tone: "ok" } },
  checks: {
    counts: { passed: 7, failed: 2, running: 1 },
    chip: { glyph: "✗", label: "✗ 2 failed", tone: "danger" },
    failuresPrompt: "FIXTURE PROMPT: f1, f2",
    logsUrl: "https://logs/f1",
  },
};

const bodyText = () => document.body.textContent ?? "";
const popover = () =>
  document.body.querySelector<HTMLElement>(".manta-checks-popover");

function openChecksChip(h: Harness) {
  const trigger = h.container.querySelector<HTMLButtonElement>(
    "button.manta-checks-chip",
  );
  expect(trigger, "expected checks chip trigger").not.toBeNull();
  act(() => trigger!.click());
}

function mountWithChecks({
  forgeKind = "github",
  onOpenExternal,
  onFillComposer,
}: {
  forgeKind?: string | null;
  onOpenExternal?: (url: string) => void;
  onFillComposer?: (text: string) => void;
} = {}) {
  return mountSessionHeader({
    pr: PR,
    checks: CHECKS,
    view: VIEW,
    forgeConnected: true,
    forgeKind,
    onOpenExternal,
    onFillComposer,
  });
}

describe("SessionHeader checks popover (BET-926)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    installMockApi();
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
    document.body.innerHTML = "";
  });

  it("lists EVERY check by name — all ten appear", async () => {
    h = mountWithChecks();
    openChecksChip(h);
    await h.flush();

    const text = bodyText();
    for (const c of CHECKS) expect(text).toContain(c.name);
  });

  it("the `+ N passed` collapse row appears NOWHERE", async () => {
    h = mountWithChecks();
    openChecksChip(h);
    await h.flush();

    expect(bodyText()).not.toContain("passed");
  });

  it("row order in the DOM is failed, failed, running, then the seven passed", async () => {
    h = mountWithChecks();
    openChecksChip(h);
    await h.flush();

    const text = bodyText();
    const pos = (n: string) => {
      const i = text.indexOf(n);
      expect(i, `expected "${n}" in popover`).toBeGreaterThan(-1);
      return i;
    };
    expect(pos("f1")).toBeLessThan(pos("f2"));
    expect(pos("f2")).toBeLessThan(pos("r1"));
    expect(pos("r1")).toBeLessThan(pos("p1"));
    expect(pos("p1")).toBeLessThan(pos("p2"));
    expect(pos("p2")).toBeLessThan(pos("p3"));
    expect(pos("p3")).toBeLessThan(pos("p4"));
    expect(pos("p4")).toBeLessThan(pos("p5"));
    expect(pos("p5")).toBeLessThan(pos("p6"));
    expect(pos("p6")).toBeLessThan(pos("p7"));
  });

  it("clicking a passing check's name calls onOpenExternal with THAT check's url", async () => {
    const onOpenExternal = vi.fn();
    h = mountWithChecks({ onOpenExternal });
    openChecksChip(h);
    await h.flush();

    const p1Btn = [...(popover()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "p1",
    );
    expect(p1Btn, "expected a p1 name button").not.toBeUndefined();
    act(() => p1Btn!.click());

    expect(onOpenExternal).toHaveBeenCalledTimes(1);
    expect(onOpenExternal).toHaveBeenCalledWith("https://logs/p1");
  });

  it("a check with no url renders its name but no button", async () => {
    h = mountWithChecks();
    openChecksChip(h);
    await h.flush();

    const pv = popover()!;
    const p7Btn = [...pv.querySelectorAll("button")].find(
      (b) => b.textContent === "p7",
    );
    expect(p7Btn).toBeUndefined();
    const p7Span = [...pv.querySelectorAll("span")].find(
      (s) => s.textContent === "p7",
    );
    expect(p7Span, "expected p7 to render as non-clickable text").toBeTruthy();
  });

  it("chip and popover header each render an svg for github, and none for a null forge", async () => {
    h = mountWithChecks({ forgeKind: "github" });
    openChecksChip(h);
    await h.flush();
    expect(
      h.container.querySelector("button.manta-checks-chip svg"),
    ).not.toBeNull();
    expect(popover()!.querySelector("svg")).not.toBeNull();

    h?.unmount();
    h = null;
    document.body.innerHTML = "";
    resetStore();

    h = mountWithChecks({ forgeKind: null });
    openChecksChip(h);
    await h.flush();
    expect(
      h.container.querySelector("button.manta-checks-chip svg"),
    ).toBeNull();
    expect(popover()!.querySelector("svg")).toBeNull();
  });

  it("the footer's Send failures and Open logs actions still work", async () => {
    const onFillComposer = vi.fn();
    const onOpenExternal = vi.fn();
    h = mountWithChecks({ onFillComposer, onOpenExternal });
    openChecksChip(h);
    await h.flush();

    const sendBtn = [...(popover()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.includes("Send failures to the agent"),
    );
    expect(sendBtn).toBeTruthy();
    act(() => sendBtn!.click());
    expect(onFillComposer).toHaveBeenCalledTimes(1);
    // The text is the box's, not rebuilt here.
    expect(onFillComposer).toHaveBeenCalledWith("FIXTURE PROMPT: f1, f2");
    // The footer's own Open-logs button opens the first failing check's log.
    const openLogs = [...(popover()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.includes("Open logs"),
    );
    expect(openLogs).toBeTruthy();
    act(() => openLogs!.click());
    expect(onOpenExternal).toHaveBeenCalledWith("https://logs/f1");
  });

  it("the chip label is the box's; no view → no chip at all", async () => {
    h = mountWithChecks();
    await h.flush();
    expect(h.container.querySelector("button.manta-checks-chip")?.textContent).toContain("✗ 2 failed");
    h.unmount();
    h = mountSessionHeader({ pr: PR, checks: CHECKS, view: null, forgeConnected: true, forgeKind: "github" });
    await h.flush();
    expect(h.container.querySelector("button.manta-checks-chip")).toBeNull();
  });

  it("with nothing failed there is no Send failures action", async () => {
    h = mountSessionHeader({
      pr: PR,
      checks: CHECKS.filter((c) => c.tone === "ok"),
      view: { ...VIEW, checks: { ...VIEW.checks, failuresPrompt: null, logsUrl: null, chip: { glyph: "✓", label: "✓ 7", tone: "ok" } } },
      forgeConnected: true,
      forgeKind: "github",
      onFillComposer: vi.fn(),
    });
    openChecksChip(h);
    await h.flush();
    expect(bodyText()).not.toContain("Send failures to the agent");
    expect(bodyText()).not.toContain("Open logs");
  });
});
