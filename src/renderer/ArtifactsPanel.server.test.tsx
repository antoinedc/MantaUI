// @vitest-environment jsdom
//
// The Artifacts panel renders what the box's `artifacts:list` sends — it derives
// nothing. These tests drive the panel with box-shaped results through the mock
// api and assert on the DOM: per-tab rows, badges from `counts`, expiry pills,
// the plan row (page URL / failure copy / file action), the transcript-driven
// refetch, and the unsupported / error states. Derivation itself is pinned by
// src/server/artifacts.test.mjs.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { useStore } from "./store";
import { ArtifactsPanel } from "./ArtifactsPanel";
import type { ArtifactItem, ArtifactsListResult } from "../shared/artifactsTypes";
import type { OpencodeMessage } from "../shared/types";

const SID = "ses_test";
const NOW = Date.now();

function item(over: Partial<ArtifactItem> & Pick<ArtifactItem, "id" | "kind" | "label" | "href">): ArtifactItem {
  return {
    origin: "agent",
    mime: null,
    size: null,
    at: NOW,
    messageId: null,
    context: null,
    isHosted: false,
    expiry: null,
    plan: null,
    ...over,
  };
}

function result(items: ArtifactItem[], over: Partial<ArtifactsListResult> = {}): ArtifactsListResult {
  const counts = { link: 0, image: 0, file: 0, plan: 0 };
  for (const i of items) counts[i.kind]++;
  return { sessionId: SID, generatedAt: NOW, items, counts, degraded: [], ...over };
}

const plan = (over: Partial<NonNullable<ArtifactItem["plan"]>> = {}): ArtifactItem =>
  item({
    id: "plan:.opencode/plans/ship-it.md",
    kind: "plan",
    label: "ship it",
    href: "/proj/.opencode/plans/ship-it.md",
    mime: "text/markdown",
    plan: { status: "draft", steps: 3, pageUrl: "https://box/pages/plan-sesa", pageUrlReason: null, fileAvailable: true, ...over },
  });

const SAMPLE = result([
  item({
    id: "page:live", kind: "link", label: "live", href: "https://box/pages/live", isHosted: true,
    context: "here you go", messageId: "msg_1", expiry: { state: "live", expiresAt: NOW + 20 * 3_600_000 + 60_000 },
  }),
  item({
    id: "page:soon", kind: "link", label: "soon", href: "https://box/pages/soon", isHosted: true,
    expiry: { state: "soon", expiresAt: NOW + 2 * 3_600_000 + 60_000 },
  }),
  item({
    id: "page:dead", kind: "link", label: "dead", href: "https://box/pages/dead", isHosted: true,
    expiry: { state: "expired", expiresAt: NOW - 1000 },
  }),
  item({
    id: "page:forever", kind: "link", label: "forever", href: "https://box/pages/forever", isHosted: true,
    expiry: { state: "never", expiresAt: null },
  }),
  item({ id: "f1", kind: "file", label: "report.pdf", href: "/home/dev/report.pdf", mime: "application/pdf", size: 2048 }),
  item({ id: "i1", kind: "image", label: "shot.png", href: "/home/dev/shot.png", mime: "image/png" }),
  item({ id: "i2", kind: "image", label: "two.png", href: "/home/dev/two.png", mime: "image/png" }),
  plan(),
]);

async function openPanel(list: (...a: unknown[]) => unknown, extra: Record<string, unknown> = {}) {
  const { api } = installMockApi({ artifactsList: list, ...extra });
  resetStore();
  const h = mount(<ArtifactsPanel sessionId={SID} cwd="/proj" open={true} />);
  await h.flush();
  return { h, api };
}

function tab(h: Harness, name: string): HTMLButtonElement {
  const btn = Array.from(h.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((b) =>
    b.textContent?.startsWith(name),
  );
  expect(btn, `tab ${name}`).toBeDefined();
  return btn!;
}

async function click(h: Harness, el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await h.flush();
}

function buttonByLabel(h: Harness, label: string): HTMLButtonElement | null {
  return h.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

describe("ArtifactsPanel — renders the box's artifacts:list", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the box for this session's list and shows the Links tab rows + badges from counts", async () => {
    const list = vi.fn().mockResolvedValue(SAMPLE);
    const { h, api } = await openPanel(list);
    expect(api.calls.artifactsList[0]).toEqual([{ sessionId: SID }]);
    expect(tab(h, "Links").textContent).toContain("4");
    expect(tab(h, "Images").textContent).toContain("2");
    expect(tab(h, "Files").textContent).toContain("1");
    expect(tab(h, "Plans").textContent).toContain("1");
    const text = h.text();
    for (const l of ["live", "soon", "dead", "forever"]) expect(text).toContain(l);
    // the panel does not call the old per-source reads any more
    expect(api.calls.servePageList).toBeUndefined();
    expect(api.calls.outboxList).toBeUndefined();
    h.unmount();
  });

  it("renders an expiry pill per box state: live/soon/expired tones, 'no expiry' for never", async () => {
    const { h } = await openPanel(vi.fn().mockResolvedValue(SAMPLE));
    const pills = Array.from(h.container.querySelectorAll("span")).filter((s) => /rounded-full/.test(s.className));
    const byText = (t: string) => pills.find((p) => p.textContent === t);
    expect(byText("20h")?.className).toContain("text-ok");
    expect(byText("2h")?.className).toContain("text-warn");
    expect(byText("expired")?.className).toContain("text-danger");
    expect(byText("no expiry")?.className).toContain("text-ok");
    h.unmount();
  });

  it("Files / Images tabs show the box's rows", async () => {
    const { h } = await openPanel(vi.fn().mockResolvedValue(SAMPLE));
    await click(h, tab(h, "Files"));
    expect(h.text()).toContain("report.pdf");
    await click(h, tab(h, "Images"));
    expect(buttonByLabel(h, "Open shot.png")).not.toBeNull();
    expect(buttonByLabel(h, "Open two.png")).not.toBeNull();
    h.unmount();
  });

  it("empty tab uses the box's counts for the other tabs", async () => {
    const { h } = await openPanel(vi.fn().mockResolvedValue(result([item({ id: "f1", kind: "file", label: "a.txt", href: "/a.txt" })])));
    expect(h.text()).toContain("No links yet");
    expect(h.text()).toContain("0 images, 1 files, 0 plans");
    h.unmount();
  });

  it("plan row opens plan.pageUrl; shows status and step count", async () => {
    const { h, api } = await openPanel(vi.fn().mockResolvedValue(SAMPLE));
    await click(h, tab(h, "Plans"));
    expect(h.text()).toContain("ship it");
    expect(h.text()).toContain("draft");
    expect(h.text()).toContain("3 steps");
    await click(h, buttonByLabel(h, "Open published page")!);
    expect(api.calls.openExternal.at(-1)).toEqual(["https://box/pages/plan-sesa"]);
    expect(h.container.querySelector(".manta-artifacts-plan-error")).toBeNull();
    h.unmount();
  });

  it("plan with no page url shows 'Couldn't open the plan page.' and navigates nowhere", async () => {
    const list = vi.fn().mockResolvedValue(result([plan({ pageUrl: null, pageUrlReason: "no-public-address" })]));
    const { h, api } = await openPanel(list);
    await click(h, tab(h, "Plans"));
    await click(h, buttonByLabel(h, "Open published page")!);
    expect(h.container.querySelector(".manta-artifacts-plan-error")?.textContent).toContain("Couldn't open the plan page.");
    expect(api.calls.openExternal).toBeUndefined();
    h.unmount();
  });

  it("plan page collision names the other conversation", async () => {
    const list = vi.fn().mockResolvedValue(result([plan({ pageUrl: null, pageUrlReason: "other-session" })]));
    const { h, api } = await openPanel(list);
    await click(h, tab(h, "Plans"));
    await click(h, buttonByLabel(h, "Open published page")!);
    const err = h.container.querySelector(".manta-artifacts-plan-error")?.textContent ?? "";
    expect(err).toContain("Couldn't open the plan page.");
    expect(err).toContain("Another conversation's page uses this address.");
    expect(api.calls.openExternal).toBeUndefined();
    h.unmount();
  });

  it("'Open plan file' is hidden when the box doesn't know the session folder", async () => {
    const list = vi.fn().mockResolvedValue(result([plan({ fileAvailable: false })]));
    const { h } = await openPanel(list);
    await click(h, tab(h, "Plans"));
    expect(buttonByLabel(h, "Open plan file")).toBeNull();
    expect(buttonByLabel(h, "Open published page")).not.toBeNull();
    h.unmount();
  });

  it("'Open plan file' is offered when the folder is known", async () => {
    const { h } = await openPanel(vi.fn().mockResolvedValue(result([plan()])));
    await click(h, tab(h, "Plans"));
    expect(buttonByLabel(h, "Open plan file")).not.toBeNull();
    h.unmount();
  });

  it("degraded ['public-address'] shows the hidden-pages footnote; other entries the generic one", async () => {
    const { h } = await openPanel(vi.fn().mockResolvedValue(result([], { degraded: ["public-address"] })));
    expect(h.text()).toContain("Published pages are hidden — this box has no public address.");
    expect(h.text()).not.toContain("Some items couldn't be loaded.");
    h.unmount();
    const second = await openPanel(vi.fn().mockResolvedValue(result([], { degraded: ["outbox"] })));
    expect(second.h.text()).toContain("Some items couldn't be loaded.");
    second.h.unmount();
  });

  it("searching filters the current tab client-side and badges follow", async () => {
    const { h } = await openPanel(vi.fn().mockResolvedValue(SAMPLE));
    await click(h, buttonByLabel(h, "Search artifacts")!);
    const input = h.container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "soon");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(tab(h, "Links").textContent).toContain("1");
    expect(tab(h, "Images").textContent).toContain("0");
    h.unmount();
  });

  it("a change to the transcript tail triggers one debounced refetch", async () => {
    const list = vi.fn().mockResolvedValue(SAMPLE);
    const { h, api } = await openPanel(list);
    expect(api.calls.artifactsList).toHaveLength(1);
    const msg = (parts: number) =>
      ({ info: { id: "m1", sessionID: SID, role: "user" }, parts: Array.from({ length: parts }, (_, i) => ({ id: `p${i}`, type: "text", text: "x" })) }) as unknown as OpencodeMessage;
    act(() => useStore.getState().setChatMessages(SID, [msg(1)]));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(api.calls.artifactsList).toHaveLength(1); // not before the debounce
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(api.calls.artifactsList).toHaveLength(2);
    h.unmount();
  });
});

describe("ArtifactsPanel — states", () => {
  it("a box without the channel → 'Update your box to use this.' and no list", async () => {
    const list = vi.fn().mockRejectedValue(new Error("unknown rpc channel: artifacts:list"));
    const { h } = await openPanel(list);
    expect(h.text()).toContain("Update your box to use this.");
    expect(h.text()).toContain("Artifacts need a newer box version.");
    expect(h.text()).not.toContain("No links yet");
    // Review mode (same panel) is unaffected
    expect(
      Array.from(h.container.querySelectorAll("button[aria-pressed]")).some((b) => b.textContent?.trim() === "Review"),
    ).toBe(true);
    h.unmount();
  });

  it("another error → banner with Retry, and Retry refetches", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("Couldn't read this conversation's artifacts"))
      .mockResolvedValue(SAMPLE);
    const { h, api } = await openPanel(list);
    const banner = h.container.querySelector(".manta-artifacts-load-error");
    // the box's own sentence is shown as is, without a doubled lead-in
    expect(banner?.textContent).toContain("Couldn't read this conversation's artifacts");
    expect(banner?.textContent).not.toContain("Couldn't load artifacts.");
    // a list that never arrived is not presented as an empty one
    expect(h.text()).not.toContain("No links yet");
    expect(h.text()).not.toContain("0 images");
    expect(h.container.querySelector(".manta-artifacts-loading")).toBeNull();
    const retry = Array.from(banner!.querySelectorAll("button")).find((b) => b.textContent === "Retry")!;
    await click(h, retry);
    expect(api.calls.artifactsList).toHaveLength(2);
    expect(h.container.querySelector(".manta-artifacts-load-error")).toBeNull();
    expect(h.text()).toContain("forever");
    h.unmount();
  });

  it("a non-box error gets the 'Couldn't load artifacts.' lead-in", async () => {
    const { h } = await openPanel(vi.fn().mockRejectedValue(new Error("HTTP 503")));
    expect(h.container.querySelector(".manta-artifacts-load-error")?.textContent).toContain("Couldn't load artifacts. HTTP 503");
    h.unmount();
  });

  it("shows a loading state before the first response", async () => {
    const list = vi.fn().mockReturnValue(new Promise(() => {}));
    const { h } = await openPanel(list);
    expect(h.text()).toContain("Loading artifacts…");
    expect(h.text()).not.toContain("No links yet");
    h.unmount();
  });
});
