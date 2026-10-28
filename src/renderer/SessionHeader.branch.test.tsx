// @vitest-environment jsdom
//
// BET-867: the branch chip is the ONE git surface. It opens a popover in BOTH
// the has-PR (merge surface) and the no-PR (Draft PR… / Create PR) states; the
// plain non-interactive Tag survives only for a scratch dir with no forge.
// These mount the real <SessionHeader> via the render harness, open the branch
// popover (portalled to <body>), and assert on the action rows + props.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import {
  installMockApi,
  resetStore,
  mountSessionHeader,
  type Harness,
} from "./testHarness";
import type { ForgePullRequestView, PullRequest } from "../shared/types";

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
  unresolvedThreads: 3,
};

// The box's render-ready view (WS05): the header renders it and derives nothing,
// so every case hands it the view a box would send. Copy / reasons below are
// deliberately distinct from the old client-side strings where useful, to prove
// the text on screen is the fixture's.
function view(over: Partial<ForgePullRequestView> = {}): ForgePullRequestView {
  return {
    panel: "no-pr",
    chipLabel: "feat/forge-seam",
    ship: { state: "ready", copy: null },
    merge: null,
    checks: { counts: { passed: 0, failed: 0, running: 0 }, chip: null, failuresPrompt: null, logsUrl: null },
    ...over,
  };
}
const READY_VIEW = view();
const PR_CAN_MERGE = view({
  panel: "pr",
  chipLabel: "feat/forge-seam · #412",
  ship: { state: "has-pr", copy: null },
  merge: { can: true, reason: null, mergeable: { text: "mergeable", tone: "ok" } },
});
const PR_BLOCKED = view({
  panel: "pr",
  chipLabel: "feat/forge-seam · #412",
  ship: { state: "has-pr", copy: null },
  merge: { can: false, reason: "box says: checks failing", mergeable: { text: "conflicts", tone: "danger" } },
});

// The popover is portalled to <body> by Popover, so assertions on its content
// read the whole body (harness container ⊂ body).
const bodyText = () => document.body.textContent ?? "";

function buttonWithText(text: string): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(btn, `expected a "${text}" button`).not.toBeUndefined();
  return btn!;
}

function openBranchChip(h: Harness) {
  // The trigger is the branch chip button (stable `manta-branch-chip` hook).
  // Interacting by class avoids the jsdom selector quirk around `+` in the
  // PR-derived aria-label attribute value.
  const trigger = h.container.querySelector<HTMLButtonElement>(
    "button.manta-branch-chip",
  );
  expect(trigger, "expected branch chip trigger").not.toBeNull();
  act(() => trigger!.click());
}

describe("SessionHeader branch popover (BET-867)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    installMockApi();
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("no PR + forge connected (ready) → a single Create pull request, and NOT Merge", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      view: READY_VIEW,
      base: "main",
      aheadCount: 3,
      shipTitle: "some title",
      onCreatePr: vi.fn(),
      onEnsureShipPreview: () => {},
    });
    openBranchChip(h);
    await h.flush();

    const text = bodyText();
    expect(text).toContain("Create pull request");
    expect(text).not.toContain("Merge");
    expect(text).not.toContain("Draft PR…");
    // No PR → no merge surface / no reviewers rows.
    expect(text).not.toContain("Review changes");
  });

  it("on the base branch the popover renders no PR surface (no Create pull request)", async () => {
    h = mountSessionHeader({
      branch: "main",
      forgeConnected: true,
      pr: null,
      view: view({ ship: { state: "on-base", copy: "On the base branch — nothing to ship." } }),
      base: "main",
      aheadCount: 0,
      onCreatePr: vi.fn(),
    });
    openBranchChip(h);
    await h.flush();

    const text = bodyText();
    expect(text).toContain("On the base branch");
    expect(text).not.toContain("Create pull request");
  });

  it("unknown base → no PR surface (no Create pull request)", async () => {
    h = mountSessionHeader({
      branch: "feat/x",
      forgeConnected: true,
      pr: null,
      view: view({ ship: { state: "unknown", copy: "Base branch unknown — nothing to ship." } }),
      base: null,
      aheadCount: 3,
      onCreatePr: vi.fn(),
    });
    openBranchChip(h);
    await h.flush();

    const text = bodyText();
    expect(text).toContain("Base branch unknown");
    expect(text).not.toContain("Create pull request");
  });

  it("no commits ahead of base → Nothing to ship, no button", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      view: view({ ship: { state: "no-commits", copy: "Nothing to ship — no commits ahead of main" } }),
      base: "main",
      aheadCount: 0,
      onCreatePr: vi.fn(),
    });
    openBranchChip(h);
    await h.flush();

    const text = bodyText();
    expect(text).toContain("Nothing to ship");
    expect(text).not.toContain("Create pull request");
  });

  it("PR present → Merge, Review changes and the Open-on-GitHub tooltip button, and NOT Create PR", async () => {
    const onOpenExternal = vi.fn();
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: PR,
      view: PR_CAN_MERGE,
      onMerge: vi.fn(),
      onOpenExternal,
    });
    openBranchChip(h);
    await h.flush();

    const text = bodyText();
    expect(text).toContain("Reviewers");
    expect(text).toContain("Unresolved threads");
    expect(text).toContain("Review changes");
    expect(text).not.toContain("Create pull request");
    expect(buttonWithText("Merge")).toBeTruthy();

    // Icon-only open-on-forge: the label lives in `title`, not button text.
    const openGithub = document.body.querySelector<HTMLButtonElement>(
      `button[title="Open on GitHub"]`,
    );
    expect(openGithub).not.toBeNull();
    act(() => openGithub!.click());
    expect(onOpenExternal).toHaveBeenCalledWith(PR.url);
  });

  it("PR present → clicking Review changes calls onReviewChanges exactly once", async () => {
    const onReviewChanges = vi.fn();
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: PR,
      view: PR_CAN_MERGE,
      onReviewChanges,
    });
    openBranchChip(h);
    await h.flush();

    const reviewBtn = buttonWithText("Review changes");
    act(() => reviewBtn.click());
    expect(onReviewChanges).toHaveBeenCalledTimes(1);
  });

  it("Merge is disabled with the reason as title when canMerge is false", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: PR,
      view: PR_BLOCKED,
      onMerge: vi.fn(),
    });
    openBranchChip(h);
    await h.flush();

    const mergeBtn = buttonWithText("Merge");
    expect(mergeBtn.disabled).toBe(true);
    // The reason and the "Mergeable" row are the box's (view.merge).
    expect(mergeBtn.title).toBe("box says: checks failing");
    expect(bodyText()).toContain("conflicts");
  });

  it("Create pull request click calls the injected create handler exactly once", async () => {
    const onCreatePr = vi.fn();
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      view: READY_VIEW,
      base: "main",
      aheadCount: 3,
      shipBase: "main",
      shipFileCount: 18,
      shipTitle: "some title",
      onCreatePr,
      onEnsureShipPreview: () => {},
    });
    openBranchChip(h);
    await h.flush();

    const createBtn = buttonWithText("Create pull request");
    expect(createBtn.disabled).toBe(false);
    act(() => createBtn.click());
    expect(onCreatePr).toHaveBeenCalledTimes(1);

    // The ship preview drives the head→base→files line + the drafted title,
    // both moved up from the deleted confirm card.
    const text = bodyText();
    expect(text).toContain("→ main · 18 files");
    expect(text).toContain("some title");
  });

  it("while a ship is in flight the Create pull request button disables and labels Creating…", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      view: READY_VIEW,
      base: "main",
      aheadCount: 3,
      shipTitle: "some title",
      shipBusy: true,
      shipError: null,
      onCreatePr: vi.fn(),
      onEnsureShipPreview: () => {},
    });
    openBranchChip(h);
    await h.flush();

    const text = bodyText();
    // Busy → no "Drafting title…" hint; the button owns the loading state.
    expect(text).not.toContain("Drafting title…");
    expect(buttonWithText("Creating…").disabled).toBe(true);
  });

  it("shipTitle null → the Create button is disabled and the body shows Drafting title…", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      view: READY_VIEW,
      base: "main",
      aheadCount: 3,
      shipTitle: null,
      onCreatePr: vi.fn(),
      onEnsureShipPreview: () => {},
    });
    openBranchChip(h);
    await h.flush();

    const text = bodyText();
    expect(text).toContain("Drafting title…");
    expect(buttonWithText("Create pull request").disabled).toBe(true);
  });

  it("the drafted title is rendered in the ready state", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      view: READY_VIEW,
      base: "main",
      aheadCount: 3,
      shipTitle: "Show every check in the checks popover",
      onCreatePr: vi.fn(),
      onEnsureShipPreview: () => {},
    });
    openBranchChip(h);
    await h.flush();

    expect(bodyText()).toContain("Show every check in the checks popover");
  });

  it("justShipped with a PR present → the body shows 'Opened #412'", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: PR,
      view: PR_CAN_MERGE,
      justShipped: true,
      onMerge: vi.fn(),
    });
    openBranchChip(h);
    await h.flush();

    expect(bodyText()).toContain("Opened #412");
  });

  it("with pr null and shipBusy true, clicking outside does not close the popover", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      view: READY_VIEW,
      base: "main",
      aheadCount: 3,
      shipTitle: "some title",
      shipBusy: true,
      onCreatePr: vi.fn(),
      onEnsureShipPreview: () => {},
    });
    openBranchChip(h);
    await h.flush();

    // The drafted title only exists inside the popover panel.
    expect(bodyText()).toContain("some title");
    // A click-away is held open while the PR write is settling (BET-925).
    act(() =>
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    expect(bodyText()).toContain("some title");
  });

  it("an older box (no view): the branch stays a plain tag and the update note shows when connected", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      view: null,
      forgeViewOutdated: true,
    });
    await h.flush();
    expect(h.container.querySelector("button.manta-branch-chip")).toBeNull();
    expect(h.container.textContent).toContain("feat/forge-seam");
    expect(h.container.textContent).toContain("Update your box to see pull requests and checks here.");
  });

  it("an older box with GitHub NOT connected shows no update note", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: false,
      pr: null,
      view: null,
      forgeViewOutdated: true,
    });
    await h.flush();
    expect(h.container.textContent).not.toContain("Update your box");
  });

  it("panel none (no recognised forge) is a plain, non-interactive tag", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      view: view({ panel: "none", chipLabel: null }),
    });
    await h.flush();
    expect(h.container.querySelector("button.manta-branch-chip")).toBeNull();
    expect(h.container.textContent).toContain("feat/forge-seam");
  });
});
