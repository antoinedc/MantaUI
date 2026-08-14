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
import type { PullRequest } from "../shared/types";

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
      base: "main",
      aheadCount: 3,
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

  it("no commits ahead of base → Nothing to ship, no button", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
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
      checksRollup: "green",
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
      checksRollup: "green",
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
      checksRollup: "red",
      onMerge: vi.fn(),
    });
    openBranchChip(h);
    await h.flush();

    const mergeBtn = buttonWithText("Merge");
    expect(mergeBtn.disabled).toBe(true);
    expect(mergeBtn.title).toBe("checks failing");
  });

  it("Create pull request click calls the injected create handler exactly once", async () => {
    const onCreatePr = vi.fn();
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      base: "main",
      aheadCount: 3,
      shipBase: "main",
      shipFileCount: 18,
      onCreatePr,
      onEnsureShipPreview: () => {},
    });
    openBranchChip(h);
    await h.flush();

    const createBtn = buttonWithText("Create pull request");
    act(() => createBtn.click());
    expect(onCreatePr).toHaveBeenCalledTimes(1);

    // Preview rows come from the ship preview (Base / Changes).
    const text = bodyText();
    expect(text).toContain("Base");
    expect(text).toContain("18 files");
  });

  it("while a ship is in flight the Create pull request button disables and labels Creating…", async () => {
    h = mountSessionHeader({
      branch: "feat/forge-seam",
      forgeConnected: true,
      pr: null,
      base: "main",
      aheadCount: 3,
      shipBusy: true,
      shipError: null,
      onCreatePr: vi.fn(),
      onEnsureShipPreview: () => {},
    });
    openBranchChip(h);
    await h.flush();

    const text = bodyText();
    expect(text).toContain("Opening pull request…");
    expect(buttonWithText("Creating…").disabled).toBe(true);
  });
});
