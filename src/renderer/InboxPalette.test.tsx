// @vitest-environment jsdom
//
// WS05: the inbox renders the box's row fields (label, identifier, secondary,
// tone, branch name, local checkout) and never probes repos itself.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { InboxPalette } from "./InboxPalette";
import type { ForgeInboxItem } from "../shared/types";

const item = (over: Partial<ForgeInboxItem>): ForgeInboxItem => ({
  kind: "pr",
  repoKey: "github.com/acme/manta",
  number: 412,
  title: "Fix the Thing",
  url: "https://gh/pr/412",
  state: "open",
  rollup: "red",
  updatedAt: Date.now() - 5 * 60_000,
  reason: "checks failing",
  seed: "Complete https://gh/pr/412",
  label: "checks red",
  identifier: "!412",
  secondary: "checks red · manta",
  repoName: "manta",
  tone: "danger",
  branchName: "manta/pr-412-fix-the-thing",
  localPath: "/home/dev/projects/manta",
  ...over,
});

const ITEMS: ForgeInboxItem[] = [
  item({}),
  item({ kind: "pr", number: 7, title: "Review me", reason: "review requested", label: "review requested", identifier: "!7", secondary: "review requested · manta", tone: "warn" }),
  item({ kind: "issue", number: 88, title: "Broken link", reason: "assigned", label: "issue · assigned to you", identifier: "#88", secondary: "issue · assigned to you", tone: "muted", branchName: "manta/issue-88-broken-link", localPath: null }),
];

describe("InboxPalette", () => {
  let h: Harness | null = null;
  beforeEach(() => resetStore());
  afterEach(() => {
    h?.unmount();
    h = null;
    document.body.innerHTML = "";
  });

  async function open(items: ForgeInboxItem[], extra: Record<string, unknown> = {}) {
    const mock = installMockApi({
      forgeInbox: () => Promise.resolve({ items, stale: false, error: null }),
      forgeProbe: vi.fn(() => Promise.resolve({ repos: [] })),
      ...extra,
    });
    h = mount(<InboxPalette onClose={() => {}} />);
    await h.flush();
    await h.flush();
    return mock;
  }

  it("renders the box's identifier, title and secondary line; never calls forgeProbe", async () => {
    const mock = await open(ITEMS);
    const text = document.body.textContent ?? "";
    expect(text).toContain("!412");
    expect(text).toContain("Fix the Thing");
    expect(text).toContain("checks red · manta");
    expect(text).toContain("#88");
    expect(text).toContain("issue · assigned to you");
    expect(mock.api.calls.forgeProbe).toBeUndefined();
  });

  it("maps the box's tone onto the dot: danger → red, warn → amber, muted → grey", async () => {
    await open(ITEMS);
    const dots = [...document.body.querySelectorAll<HTMLElement>("span.rounded-full")].map((d) => d.className);
    expect(dots.some((c) => c.includes("bg-danger"))).toBe(true);
    expect(dots.some((c) => c.includes("bg-warn"))).toBe(true);
    expect(dots.some((c) => c.includes("bg-text-quiet"))).toBe(true);
  });

  it("Start a session uses the box's localPath and branchName", async () => {
    const gitAddWorktree = vi.fn(() => Promise.resolve({ path: "/wt" }));
    const tmuxNewSession = vi.fn(() => Promise.resolve({ projects: [], sessionId: "s1" }));
    await open(ITEMS, { gitAddWorktree, tmuxNewSession });
    const start = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("Start a session"))!;
    await act(async () => { start.click(); });
    await h!.flush();
    expect(gitAddWorktree).toHaveBeenCalledWith({ cwd: "/home/dev/projects/manta", name: "manta/pr-412-fix-the-thing" });
  });

  it("an item without a checkout says so and creates nothing", async () => {
    const gitAddWorktree = vi.fn();
    await open([ITEMS[2]], { gitAddWorktree });
    const start = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("Start a session"))!;
    await act(async () => { start.click(); });
    await h!.flush();
    expect(document.body.textContent).toContain("No local checkout of manta on this server to start a session in.");
    expect(gitAddWorktree).not.toHaveBeenCalled();
  });

  it("rows without the box's fields (an older box) show the update note", async () => {
    const old = { ...ITEMS[0] } as Partial<ForgeInboxItem>;
    delete old.label;
    await open([old as ForgeInboxItem]);
    expect(document.body.textContent).toContain("Update your box to use the inbox here.");
  });
});
