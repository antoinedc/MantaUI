// @vitest-environment jsdom
//
// WS05: the review pane renders the box's structured diff — rows, placed threads
// and placed draft comments — and reconciles draft mutations by comment id. It
// parses nothing and places nothing itself.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import {
  ReviewPane,
  mergeDraftPlacements,
  reviewLoadState,
  REVIEW_PARSE_FAILED,
  REVIEW_UPDATE_BOX_NOTE,
} from "./ReviewPane";
import type { ForgeDiffResult, ForgeDraft, ForgePlacedDraft, ForgePlacement } from "../shared/types";

const FILE = {
  path: "src/a.ts",
  added: 1,
  removed: 1,
  rowCount: 4,
  truncated: false,
  rows: [
    { kind: "hunk", text: "@@ -1,2 +1,3 @@", oldLine: null, newLine: null, anchor: null },
    { kind: "context", text: "ctxline", oldLine: 1, newLine: 3, anchor: { path: "src/a.ts", line: 3, side: "both" } },
    { kind: "removed", text: "goneline", oldLine: 2, newLine: null, anchor: { path: "src/a.ts", line: 2, side: "old" } },
    { kind: "added", text: "newline", oldLine: null, newLine: 4, anchor: { path: "src/a.ts", line: 4, side: "new" } },
  ],
} as const;

function result(over: Partial<ForgeDiffResult> = {}): ForgeDiffResult {
  return {
    diff: "raw",
    threads: [],
    headSha: "h1",
    error: null,
    files: [FILE as unknown as NonNullable<ForgeDiffResult["files"]>[number]],
    draft: null,
    parseFailed: false,
    message: null,
    ...over,
  };
}

const draftOf = (comments: ForgeDraft["comments"], over: Partial<ForgeDraft> = {}): ForgeDraft => ({
  key: "k", repoKey: "h/o/r", number: 1, headSha: "h1", verdict: null, body: "", comments, stale: false, updatedAt: 1, ...over,
});
const dc = (id: string, over: Partial<ForgeDraft["comments"][number]> = {}) => ({
  id, path: "src/a.ts", line: 4, side: "new" as const, body: `body-${id}`, ...over,
});
const placed = (comments: ReturnType<typeof dc>[], placements: ForgePlacement[], over: Partial<ForgeDraft> = {}): ForgePlacedDraft => ({
  ...draftOf([], over),
  comments: comments.map((c, i) => ({ ...c, placement: placements[i] })),
});

describe("mergeDraftPlacements", () => {
  const rowA: ForgePlacement = { at: "row", file: 0, row: 3 };
  const fileB: ForgePlacement = { at: "file", file: 0 };

  it("add keeps existing placements and puts the new comment at the tapped row", () => {
    const previous = placed([dc("c1"), dc("c2")], [rowA, fileB]);
    const tapped: ForgePlacement = { at: "row", file: 0, row: 1 };
    const r = mergeDraftPlacements(previous, draftOf([dc("c1"), dc("c2"), dc("c3")]), tapped);
    expect(r.needsRefetch).toBe(false);
    expect(r.draft?.comments.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(r.draft?.comments.map((c) => c.placement)).toEqual([rowA, fileB, tapped]);
  });

  it("delete removes only that id; verdict change keeps every placement", () => {
    const previous = placed([dc("c1"), dc("c2")], [rowA, fileB]);
    const del = mergeDraftPlacements(previous, draftOf([dc("c2")]), null);
    expect(del.draft?.comments.map((c) => [c.id, c.placement])).toEqual([["c2", fileB]]);
    const verdict = mergeDraftPlacements(previous, draftOf([dc("c1"), dc("c2")], { verdict: "approved" }), null);
    expect(verdict.draft?.verdict).toBe("approved");
    expect(verdict.draft?.comments.map((c) => c.placement)).toEqual([rowA, fileB]);
    expect(verdict.needsRefetch).toBe(false);
  });

  it("unknown ids, a moved head or a flipped stale flag ask for a refetch and keep EVERY comment (unknown ones unplaced)", () => {
    const previous = placed([dc("c1")], [rowA]);
    const two = mergeDraftPlacements(previous, draftOf([dc("c1"), dc("x"), dc("y")], { body: "kept" }), fileB);
    expect(two.needsRefetch).toBe(true);
    expect(two.draft?.comments.map((c) => [c.id, c.placement])).toEqual([
      ["c1", rowA], ["x", { at: "unplaced" }], ["y", { at: "unplaced" }],
    ]);
    expect(two.draft?.body).toBe("kept");
    // One unknown id and nothing tapped (another device's comment): kept, unplaced, refetch.
    const stranger = mergeDraftPlacements(previous, draftOf([dc("c1"), dc("x")]), null);
    expect(stranger.draft?.comments.map((c) => c.placement)).toEqual([rowA, { at: "unplaced" }]);
    expect(mergeDraftPlacements(previous, draftOf([dc("c1"), dc("x")]), null).needsRefetch).toBe(true);
    expect(mergeDraftPlacements(previous, draftOf([dc("c1")], { headSha: "h2" }), null).needsRefetch).toBe(true);
    expect(mergeDraftPlacements(previous, draftOf([dc("c1")], { stale: true }), null).needsRefetch).toBe(true);
  });

  it("the very first comment (no previous draft) lands at the tapped row without a refetch, like iOS", () => {
    const tapped: ForgePlacement = { at: "row", file: 0, row: 2 };
    const r = mergeDraftPlacements(null, draftOf([dc("c1")]), tapped);
    expect(r.needsRefetch).toBe(false);
    expect(r.draft?.comments[0].placement).toEqual(tapped);
    const noTap = mergeDraftPlacements(null, draftOf([dc("c1")]), null);
    expect(noTap.needsRefetch).toBe(true);
    expect(noTap.draft?.comments[0].placement).toEqual({ at: "unplaced" });
  });

  it("a null response clears the draft without a refetch", () => {
    const r = mergeDraftPlacements(placed([dc("c1")], [rowA]), null, null);
    expect(r).toEqual({ draft: null, needsRefetch: false });
  });
});

describe("reviewLoadState precedence", () => {
  it("error → old box → parse failure → empty → diff; a parse failure is never 'No diff.'", () => {
    expect(reviewLoadState(result({ error: "no_pr", message: "No pull request on this session's branch." }))).toEqual({
      kind: "error", message: "No pull request on this session's branch.",
    });
    expect(reviewLoadState(result({ error: "no_pr", message: null }))).toEqual({ kind: "error", message: "no_pr" });
    expect(reviewLoadState({ ...result(), files: undefined })).toEqual({ kind: "old-box" });
    expect(reviewLoadState(result(), false)).toEqual({ kind: "old-box" });
    expect(reviewLoadState(result({ files: [], parseFailed: true, message: REVIEW_PARSE_FAILED }))).toEqual({
      kind: "parse-failed", message: "Couldn't read this diff.",
    });
    expect(reviewLoadState(result({ files: [] }))).toEqual({ kind: "empty" });
    expect(reviewLoadState(result())).toEqual({ kind: "diff" });
  });
});

describe("ReviewPane", () => {
  let h: Harness | null = null;
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    document.body.innerHTML = "";
  });

  async function open(res: ForgeDiffResult, extra: Record<string, unknown> = {}, props: Partial<React.ComponentProps<typeof ReviewPane>> = {}) {
    const mock = installMockApi({ forgeDiff: () => Promise.resolve(res), ...extra });
    h = mount(<ReviewPane sessionId="ses" cwd="/repo" {...props} />);
    await h.flush();
    await h.flush();
    return mock;
  }

  const button = (text: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

  it("renders the box's rows and notes at their placement (incl. a LEFT thread on a context row)", async () => {
    await open(result({
      threads: [{
        id: "t1", path: "src/a.ts", line: 1, side: "LEFT", resolved: false,
        comments: [{ author: "ann", body: "left-note", createdAt: null }],
        placement: { at: "row", file: 0, row: 1 },
      }],
      draft: placed([dc("c1")], [{ at: "row", file: 0, row: 3 }]),
    }));
    const text = h!.text();
    expect(text).toContain("src/a.ts");
    expect(text).toContain("@@ -1,2 +1,3 @@");
    const order = ["ctxline", "left-note", "goneline", "newline", "body-c1"].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("You · draft");
    expect(text).toContain("1 comment");
  });

  it("an unplaced thread renders under 'Other comments' and is not lost", async () => {
    await open(result({
      threads: [{ id: "t", path: "elsewhere.ts", line: 1, side: "RIGHT", resolved: false, comments: [{ author: "bo", body: "stray", createdAt: null }], placement: { at: "unplaced" } }],
    }));
    expect(h!.text()).toContain("Other comments");
    expect(h!.text()).toContain("stray");
  });

  it("parseFailed (error null, no files, one thread) shows the message + the thread, never 'No diff.'", async () => {
    await open(result({
      files: [], parseFailed: true, message: "Couldn't read this diff.",
      threads: [{ id: "t", path: "a", line: 1, side: "RIGHT", resolved: false, comments: [{ author: "bo", body: "still here", createdAt: null }], placement: { at: "unplaced" } }],
    }), {}, { prUrl: "https://gh/pr/1", onOpenExternal: vi.fn() });
    const text = h!.text();
    expect(text).toContain("Couldn't read this diff.");
    expect(text).toContain("still here");
    expect(text).not.toContain("No diff.");
    expect(button("Try again")).toBeTruthy();
    expect(button("Open on GitHub")).toBeTruthy();
  });

  it("an older box (no files) says so", async () => {
    await open({ diff: "x", threads: [], headSha: "", error: null } as ForgeDiffResult);
    expect(h!.text()).toContain(REVIEW_UPDATE_BOX_NOTE);
  });

  it("a truncated file shows its size instead of rows", async () => {
    await open(result({ files: [{ ...FILE, truncated: true, rowCount: 5000, rows: [] } as unknown as NonNullable<ForgeDiffResult["files"]>[number]] }));
    expect(h!.text()).toContain("Too large to show here (5000 lines)");
  });

  it("a failed add keeps the composer and shows the box's message", async () => {
    await open(result(), {
      forgeDraftComment: () => Promise.resolve({ ok: false, error: "invalid comment anchor", message: "That line can't take a comment." }),
    });
    const plus = document.body.querySelectorAll<HTMLButtonElement>('button[aria-label="Comment on this line"]')[2];
    act(() => plus.click());
    const ta = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, "hello");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Add to review")!.click(); });
    await h!.flush();
    expect(h!.text()).toContain("That line can't take a comment.");
    expect(document.body.querySelector("textarea")).not.toBeNull();
  });

  it("a successful Remove that returns draft null (cleared elsewhere) clears the cards and the bar, no error, no refetch", async () => {
    const forgeDiff = vi.fn(() => Promise.resolve(result({ draft: placed([dc("c1")], [{ at: "row", file: 0, row: 3 }]) })));
    const mock = installMockApi({
      forgeDiff,
      forgeDraftComment: () => Promise.resolve({ ok: true, draft: null, message: null }),
    });
    void mock;
    h = mount(<ReviewPane sessionId="ses" cwd="/repo" />);
    await h.flush();
    await h.flush();
    expect(h.text()).toContain("not yet published");
    await act(async () => { button("Remove")!.click(); });
    await h.flush();
    expect(h.text()).not.toContain("not yet published");
    expect(h.text()).not.toContain("You · draft");
    expect(forgeDiff).toHaveBeenCalledTimes(1);
  });

  it("refetches the diff only when the merge asks for it", async () => {
    const forgeDiff = vi.fn(() => Promise.resolve(result({ draft: placed([dc("c1")], [{ at: "row", file: 0, row: 3 }]) })));
    installMockApi({
      forgeDiff,
      forgeDraftComment: () => Promise.resolve({ ok: true, draft: draftOf([dc("c1")], { verdict: "approved" }), message: null }),
    });
    h = mount(<ReviewPane sessionId="ses" cwd="/repo" />);
    await h.flush();
    await h.flush();
    await act(async () => { button("Approve")!.click(); });
    await h.flush();
    expect(forgeDiff).toHaveBeenCalledTimes(1);
  });

  it("a rate-limited refetch (stale, no files) keeps the diff and the unpublished comments on screen", async () => {
    const first = result({ draft: placed([dc("c1")], [{ at: "row", file: 0, row: 3 }]) });
    const limited = result({ files: [], stale: true, draft: placed([dc("c1")], [{ at: "unplaced" }], { headSha: "h2" }) });
    const forgeDiff = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(limited);
    installMockApi({
      forgeDiff,
      // A moved head asks for a refetch, which the forge then rate-limits.
      forgeDraftComment: () => Promise.resolve({ ok: true, draft: draftOf([dc("c1")], { headSha: "h2" }), message: null }),
    });
    h = mount(<ReviewPane sessionId="ses" cwd="/repo" />);
    await h.flush();
    await h.flush();
    await act(async () => { button("Approve")!.click(); });
    await h.flush();
    await h.flush();
    expect(forgeDiff).toHaveBeenCalledTimes(2);
    const text = h.text();
    expect(text).toContain("ctxline");
    expect(text).toContain("You · draft");
    expect(text).toContain("1 comment");
    expect(text).toContain("Showing last known diff");
    expect(text).not.toContain("No diff.");
  });

  it("without a session there is no Send to agent on a saved draft", async () => {
    installMockApi({ forgeDiff: () => Promise.resolve(result({ draft: placed([dc("c1")], [{ at: "row", file: 0, row: 3 }]) })) });
    h = mount(<ReviewPane target={{ repoKey: "h/o/r", number: 1 }} />);
    await h.flush();
    await h.flush();
    expect(h.text()).toContain("You · draft");
    expect(button("Send to agent")).toBeUndefined();
  });
});
