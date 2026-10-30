// @vitest-environment jsdom
//
// The handoff card (spec §3): every action calls the right rpc with the right
// arguments and reports BOTH outcomes in the card; only a `ready` record is
// actionable; an expired record has no actions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { HandoffEventPayload, HandoffRecord } from "../shared/api";
import type { OpencodePart } from "../shared/types";
import { HandoffCardView, HandoffModeToggle, HandoffToolCard } from "./HandoffParts";
import { resetHandoffStore } from "./handoffStore";
import { useStore } from "./store";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "./testHarness";

const rec = (over: Partial<HandoffRecord> = {}): HandoffRecord => ({
  id: "hof_a",
  fromSessionId: "ses_old",
  kind: "suggest",
  trigger: "user",
  state: "ready",
  text: "## Goal\nship it",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const buttons = (h: Harness) => Array.from(h.container.querySelectorAll("button"));
const byText = (h: Harness, text: string) =>
  buttons(h).find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
const noticeText = (h: Harness) => h.container.querySelector('[data-testid="handoff-notice"]')?.textContent ?? "";

async function press(h: Harness, el: HTMLElement | undefined | null) {
  expect(el, "expected the control to exist").toBeTruthy();
  await act(async () => {
    el!.click();
  });
  await h.flush();
}

describe("HandoffCardView", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const clip = { writeText: vi.fn<(t: string) => Promise<void>>() };

  beforeEach(() => {
    resetHandoffStore();
    clip.writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true });
    // The card switches windows through the store; give it a window for the successor.
    resetStore({
      projects: [
        {
          tmuxSession: "proj",
          defaultCwd: "/x",
          windows: [
            { index: 1, name: "a", opencodeSessionId: "ses_old" },
            { index: 2, name: "b", opencodeSessionId: "ses_new" },
          ],
        },
      ] as never,
      refresh: () => Promise.resolve(),
    } as never);
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function open(record: HandoffRecord, overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi(overrides));
    h = mount(<HandoffCardView record={record} />);
    return h;
  }

  it("shows the title, source, badge and the markdown body", async () => {
    open(rec());
    await h!.flush();
    expect(h!.text()).toContain("Handoff prompt");
    expect(h!.text()).toContain("/handoff");
    expect(h!.container.querySelector('[data-testid="handoff-badge"]')?.textContent).toBe("ready");
    expect(h!.container.querySelector('[data-testid="handoff-body"]')?.textContent).toContain("ship it");
  });

  it("clamps a long body to a few lines with Show more / Show less, and never scrolls", async () => {
    const sh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const ch = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const isBody = (el: HTMLElement) => el.getAttribute?.("data-testid") === "handoff-body";
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return isBody(this) ? 400 : 0; } });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return isBody(this) ? (this.style.maxHeight ? 90 : 400) : 0; } });
    try {
      open(rec({ text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n") }));
      await h!.flush();
      const body = () => h!.container.querySelector('[data-testid="handoff-body"]') as HTMLElement;
      expect(body().style.maxHeight).toBe("9em");
      expect(h!.container.querySelector('[class*="overflow-y"]')).toBeNull();
      const toggle = () => h!.container.querySelector('[data-testid="handoff-body-toggle"]') as HTMLButtonElement;
      expect(toggle().textContent).toBe("Show more");
      await press(h!, toggle());
      expect(body().style.maxHeight).toBe("");
      expect(toggle().textContent).toBe("Show less");
      await press(h!, toggle());
      expect(body().style.maxHeight).toBe("9em");
    } finally {
      if (sh) Object.defineProperty(HTMLElement.prototype, "scrollHeight", sh); else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      if (ch) Object.defineProperty(HTMLElement.prototype, "clientHeight", ch); else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });

  it("a short body has no Show more toggle, and the actions stay visible", async () => {
    open(rec());
    await h!.flush();
    expect(h!.container.querySelector('[data-testid="handoff-body-toggle"]')).toBeNull();
    expect(byText(h!, "Clear & start")).toBeTruthy();
  });

  it("Copy writes the RAW markdown, swaps the label for a check (same width, no notice line), then reverts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(rec({ text: "## Goal\n**bold** `x`" }));
      const copyBtn = () => buttons(h!).find((b) => b.getAttribute("aria-label") === "Copied" || (b.textContent ?? "").trim() === "Copy")!;
      await press(h!, byText(h!, "Copy"));
      expect(clip.writeText).toHaveBeenCalledWith("## Goal\n**bold** `x`");
      expect(copyBtn().getAttribute("aria-label")).toBe("Copied");
      expect(h!.container.querySelector('[data-testid="handoff-copied"] svg')).not.toBeNull();
      // the label is still in flow (hidden), so the button keeps its width
      expect(copyBtn().querySelector(".invisible")?.textContent).toBe("Copy");
      expect(noticeText(h!)).toBe("");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect(h!.container.querySelector('[data-testid="handoff-copied"]')).toBeNull();
      expect(byText(h!, "Copy")!.getAttribute("aria-label")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Copy that the clipboard refuses reports the failure", async () => {
    open(rec());
    clip.writeText = vi.fn(() => Promise.reject(new Error("denied")));
    await press(h!, byText(h!, "Copy"));
    expect(noticeText(h!)).toBe("denied");
    expect(h!.container.querySelector('[data-testid="handoff-notice"]')?.getAttribute("role")).toBe("alert");
    expect(h!.container.querySelector('[data-testid="handoff-copied"]')).toBeNull();
  });

  it("Clear & start → handoff:start {how: clear, disposition: send}", async () => {
    open(rec(), {
      handoffStart: () => Promise.resolve({ handoff: rec({ state: "committed", how: "clear", successorId: "ses_new", updatedAt: 2 }) }),
    });
    await press(h!, byText(h!, "Clear & start"));
    expect(api.calls.handoffStart).toEqual([[{ id: "hof_a", how: "clear", disposition: "send" }]]);
    expect(noticeText(h!)).toBe("");
  });

  it("Start in new session → {how: new-session, disposition: send}, then switches to the new window", async () => {
    open(rec(), {
      handoffStart: () => Promise.resolve({ handoff: rec({ state: "committed", how: "new-session", successorId: "ses_new", updatedAt: 2 }) }),
      tmuxSelectWindow: () => Promise.resolve(),
    });
    await press(h!, byText(h!, "Start in new session"));
    expect(api.calls.handoffStart).toEqual([[{ id: "hof_a", how: "new-session", disposition: "send" }]]);
    expect(api.calls.tmuxSelectWindow).toEqual([[{ sessionName: "proj", windowIndex: 2 }]]);
    expect(useStore.getState().activeWindowByProject.proj).toBe(2);
  });

  it("a start that is refused says why and leaves the card actionable", async () => {
    open(rec(), { handoffStart: () => Promise.reject(new Error("busy")) });
    await press(h!, byText(h!, "Clear & start"));
    expect(noticeText(h!)).toMatch(/busy/);
    expect(byText(h!, "Clear & start")!.disabled).toBe(false);
  });

  it("a branch whose window never shows up reports it instead of doing nothing", async () => {
    resetStore({ projects: [{ tmuxSession: "proj", defaultCwd: "/x", windows: [] }] as never, refresh: () => Promise.resolve() } as never);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(rec(), {
        handoffStart: () => Promise.resolve({ handoff: rec({ state: "committed", how: "new-session", successorId: "ses_gone", updatedAt: 2 }) }),
      });
      await act(async () => {
        byText(h!, "Start in new session")!.click();
        await vi.advanceTimersByTimeAsync(2000);
      });
      await h!.flush();
      expect(noticeText(h!)).toMatch(/isn't listed yet/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Edit first → choose → disposition draft (this window = clear)", async () => {
    open(rec(), {
      handoffStart: () => Promise.resolve({ handoff: rec({ state: "committed", how: "clear", disposition: "draft", successorId: "ses_new", updatedAt: 2 }) }),
    });
    await press(h!, byText(h!, "Edit first"));
    expect(h!.container.querySelector('[data-testid="handoff-edit-choice"]')).not.toBeNull();
    await press(h!, byText(h!, "This window (clear)"));
    expect(api.calls.handoffStart).toEqual([[{ id: "hof_a", how: "clear", disposition: "draft" }]]);
  });

  it("Edit first → New session → {new-session, draft}", async () => {
    open(rec(), {
      handoffStart: () => Promise.resolve({ handoff: rec({ state: "committed", how: "new-session", disposition: "draft", successorId: "ses_new", updatedAt: 2 }) }),
    });
    await press(h!, byText(h!, "Edit first"));
    await press(h!, byText(h!, "New session"));
    expect(api.calls.handoffStart).toEqual([[{ id: "hof_a", how: "new-session", disposition: "draft" }]]);
  });

  it.each(["starting", "committed", "cancelled"] as const)("actions are off in %s", async (state) => {
    open(rec({ state, successorId: "ses_new" }));
    await h!.flush();
    for (const label of ["Copy", "Clear & start", "Start in new session", "Edit first"]) {
      expect(byText(h!, label)!.disabled, label).toBe(true);
    }
  });

  it("started shows an Open session link that switches to the successor", async () => {
    open(rec({ state: "committed", how: "new-session", successorId: "ses_new" }), { tmuxSelectWindow: () => Promise.resolve() });
    expect(h!.container.querySelector('[data-testid="handoff-badge"]')?.textContent).toBe("started");
    await press(h!, byText(h!, "Open session"));
    expect(api.calls.tmuxSelectWindow).toEqual([[{ sessionName: "proj", windowIndex: 2 }]]);
  });

  it("failed shows the reason and Retry → handoff:retry", async () => {
    open(rec({ state: "failed", reason: "generation timed out" }), {
      handoffRetry: () => Promise.resolve({ handoff: rec({ state: "ready", updatedAt: 3 }) }),
    });
    expect(h!.text()).toContain("generation timed out");
    expect(byText(h!, "Clear & start")).toBeUndefined();
    await press(h!, byText(h!, "Retry"));
    expect(api.calls.handoffRetry).toEqual([[{ id: "hof_a" }]]);
  });

  it("a failed retry is reported", async () => {
    open(rec({ state: "failed", reason: "x" }), { handoffRetry: () => Promise.reject(new Error("busy")) });
    await press(h!, byText(h!, "Retry"));
    expect(noticeText(h!)).toMatch(/busy/);
  });

  describe("cold-cache writer line + Rewrite (spec B6)", () => {
    const estimate = { providerID: "anthropic", modelID: "claude-opus-5-5", estTokens: 300_000, estCostUsd: 2.5, subscription: false };
    const rewriteBtn = () => buttons(h!).find((b) => (b.textContent ?? "").startsWith("Rewrite")) as HTMLButtonElement | undefined;
    const writerLine = () => h!.container.querySelector('[data-testid="handoff-writer"]')?.textContent ?? "";

    it("a session-written card shows no writer line and no Rewrite", async () => {
      open(rec({ writer: { path: "session" } }));
      expect(writerLine()).toBe("");
      expect(rewriteBtn()).toBeUndefined();
    });

    it("a condensed ready card says who wrote it and offers a priced Rewrite", async () => {
      open(rec({ writer: { path: "condensed", providerID: "x", modelID: "deepseek-v4-flash" }, canRewrite: true, rewriteEstimate: estimate }));
      expect(writerLine()).toBe("Written by deepseek-v4-flash from a trimmed transcript — the full history wasn't re-read.");
      expect(rewriteBtn()!.textContent).toBe("Rewrite with claude-opus-5-5 (≈ $2.50)");
      expect(rewriteBtn()!.disabled).toBe(false);
    });

    it("Rewrite is shown iff canRewrite === true, even with an estimate present", async () => {
      open(rec({ writer: { path: "condensed" }, canRewrite: false, rewriteEstimate: estimate }));
      expect(rewriteBtn()).toBeUndefined();
    });

    it("a failed card shows Rewrite next to Retry", async () => {
      open(rec({ state: "failed", reason: "x couldn't write the handoff: timeout", canRewrite: true, rewriteEstimate: { ...estimate, estCostUsd: null } }));
      expect(byText(h!, "Retry")).toBeTruthy();
      expect(rewriteBtn()!.textContent).toBe("Rewrite with claude-opus-5-5 (≈ 300k tokens)");
    });

    it("pressing Rewrite calls handoff:rewrite", async () => {
      open(rec({ canRewrite: true, rewriteEstimate: estimate }), {
        handoffRewrite: () => Promise.resolve({ handoff: rec({ state: "generating", updatedAt: 5 }) }),
      });
      await press(h!, rewriteBtn());
      expect(api.calls.handoffRewrite).toEqual([[{ id: "hof_a" }]]);
    });

    it("a refused Rewrite shows the box's message in the card", async () => {
      open(rec({ canRewrite: true, rewriteEstimate: estimate }), {
        handoffRewrite: () => Promise.reject(new Error("This handoff is being written right now.")),
      });
      await press(h!, rewriteBtn());
      expect(noticeText(h!)).toBe("This handoff is being written right now.");
    });

    it("a restored ready card shows its reason", async () => {
      open(rec({ reason: "The rewrite was interrupted by a restart." }));
      expect(h!.container.querySelector('[data-testid="handoff-reason"]')?.textContent).toBe("The rewrite was interrupted by a restart.");
    });
  });

  describe("dismiss", () => {
    const dismissBtn = () => h!.container.querySelector('button[aria-label="Dismiss handoff"]') as HTMLButtonElement | null;

    it("a ready card has an × that calls handoff:dismiss and hides the card", async () => {
      resetHandoffStore();
      open(rec(), { handoffDismiss: () => Promise.resolve({ handoff: rec({ state: "dismissed", updatedAt: 2 }) }) });
      expect(dismissBtn()!.title).toContain("don't suggest a handoff again in this session");
      await press(h!, dismissBtn());
      expect(api.calls.handoffDismiss).toEqual([[{ id: "hof_a" }]]);
      // the session is refetched so its `dismissed` flag follows
      expect(api.calls.handoffList).toEqual([[{ sessionId: "ses_old" }]]);
    });

    it("a failed card can be dismissed too", async () => {
      open(rec({ state: "failed", reason: "x" }));
      expect(dismissBtn()).not.toBeNull();
    });

    it("a refusal keeps the card and says why", async () => {
      open(rec(), { handoffDismiss: () => Promise.reject(new Error("This handoff can no longer be dismissed.")) });
      await press(h!, dismissBtn());
      expect(h!.container.querySelector('[data-testid="handoff-card"]')).not.toBeNull();
      expect(noticeText(h!)).toBe("This handoff can no longer be dismissed.");
      expect(dismissBtn()!.disabled).toBe(false);
    });

    it.each(["generating", "starting", "committed", "cancelled"] as const)("no × while %s", async (state) => {
      open(rec({ state, successorId: "ses_new" }));
      await h!.flush();
      expect(dismissBtn()).toBeNull();
    });

    it("a dismissed record collapses to a single faint line with no actions", async () => {
      open(rec({ state: "dismissed" }));
      await h!.flush();
      expect(h!.container.querySelector('[data-testid="handoff-card"]')).toBeNull();
      expect(h!.container.querySelector('[data-testid="handoff-dismissed"]')?.textContent).toBe("Handoff dismissed");
      expect(h!.container.querySelectorAll("button")).toHaveLength(0);
    });
  });

  it("preparing shows no actions", async () => {
    open(rec({ state: "generating", text: "" }));
    await h!.flush();
    expect(h!.text()).toContain("Writing the handoff");
    expect(byText(h!, "Clear & start")).toBeUndefined();
  });
});

describe("HandoffToolCard (inline, agent path)", () => {
  let h: Harness | null = null;
  const part = (output?: string, status = "completed") =>
    ({ id: "p1", type: "tool", tool: "handoff", state: { status, output } }) as unknown as OpencodePart;

  beforeEach(() => {
    resetHandoffStore();
    resetStore();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the card for the id in the marker, fetching its live state", async () => {
    const { api } = installMockApi({ handoffGet: () => Promise.resolve({ handoff: rec({ id: "hof_z", trigger: "agent" }) }) });
    h = mount(<HandoffToolCard part={part("Handoff prompt ready below.\n<!-- manta-handoff:hof_z -->")} />);
    await h.flush();
    expect(api.calls.handoffGet).toEqual([[{ id: "hof_z" }]]);
    expect(h.text()).toContain("Handoff prompt");
    expect(h.text()).toContain("from agent");
    // the marker and the model-facing status line are not shown
    expect(h.text()).not.toContain("manta-handoff");
    expect(h.text()).not.toContain("ready below");
  });

  it("an agent-path card whose record was dismissed shows 'Handoff dismissed'", async () => {
    installMockApi({ handoffGet: () => Promise.resolve({ handoff: rec({ id: "hof_d", trigger: "agent", state: "dismissed" }) }) });
    h = mount(<HandoffToolCard part={part("<!-- manta-handoff:hof_d -->")} />);
    await h.flush();
    expect(h.container.querySelector('[data-testid="handoff-dismissed"]')?.textContent).toBe("Handoff dismissed");
    expect(h.container.querySelectorAll("button")).toHaveLength(0);
  });

  it("an expired record says so and offers no actions", async () => {
    installMockApi({ handoffGet: () => Promise.reject(new Error("expired")) });
    h = mount(<HandoffToolCard part={part("<!-- manta-handoff:hof_gone -->")} />);
    await h.flush();
    expect(h.container.querySelector('[data-testid="handoff-expired"]')?.textContent).toBe("This handoff has expired");
    expect(h.container.querySelectorAll("button")).toHaveLength(0);
  });

  it("a load failure that is not expiry is reported, not hidden", async () => {
    installMockApi({ handoffGet: () => Promise.reject(new Error("HTTP 500")) });
    h = mount(<HandoffToolCard part={part("<!-- manta-handoff:hof_e -->")} />);
    await h.flush();
    expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load this handoff");
  });

  it("follows the record as the bus announces changes", async () => {
    let current = rec({ id: "hof_live", trigger: "agent", state: "ready", updatedAt: 1 });
    const subs = new Set<(p: HandoffEventPayload) => void>();
    const { api } = installMockApi({
      handoffGet: () => Promise.resolve({ handoff: current }),
      onHandoff: (cb: (p: HandoffEventPayload) => void) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    });
    h = mount(<HandoffToolCard part={part("<!-- manta-handoff:hof_live -->")} />);
    await h.flush();
    expect(h.container.querySelector('[data-testid="handoff-badge"]')?.textContent).toBe("ready");
    current = rec({ id: "hof_live", trigger: "agent", state: "starting", updatedAt: 2 });
    await act(async () => {
      for (const cb of subs) cb({ id: "hof_live", fromSessionId: "ses_old", state: "starting" });
    });
    await h.flush();
    expect(api.calls.handoffGet).toHaveLength(2);
    expect(h.container.querySelector('[data-testid="handoff-badge"]')?.textContent).toBe("starting");
  });

  it("while the tool is still running there is no card yet", async () => {
    const { api } = installMockApi();
    h = mount(<HandoffToolCard part={part(undefined, "running")} />);
    await h.flush();
    expect(h.text()).toContain("Preparing handoff");
    expect(api.calls.handoffGet).toBeUndefined();
  });
});

describe("HandoffModeToggle (per session)", () => {
  let h: Harness | null = null;
  beforeEach(() => resetHandoffStore());
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  const btn = () => h!.container.querySelector('[data-testid="handoff-mode"]') as HTMLButtonElement;

  it("shows the session's effective mode and cycles via handoff:set-mode for THIS session only", async () => {
    const { api } = installMockApi({
      handoffList: () => Promise.resolve({ records: [], links: null, continuation: null, mode: "auto", modeIsDefault: false }),
      handoffSetMode: ({ mode }: { mode: string }) => Promise.resolve({ mode }),
    });
    h = mount(<HandoffModeToggle sessionId="ses_a" />);
    await h.flush();
    expect(btn().textContent).toContain("Handoff: auto");
    expect(btn().title).toContain("this conversation only");
    await press(h, btn());
    expect(btn().textContent).toContain("Handoff: suggest");
    await press(h, btn());
    expect(btn().textContent).toContain("Handoff: off");
    await press(h, btn());
    expect(btn().textContent).toContain("Handoff: auto");
    expect(api.calls.handoffSetMode).toEqual([
      [{ sessionId: "ses_a", mode: "suggest" }],
      [{ sessionId: "ses_a", mode: "off" }],
      [{ sessionId: "ses_a", mode: "auto" }],
    ]);
    // never the box default
    expect(api.calls.configUpdate).toBeUndefined();
  });

  it("two sessions are independent", async () => {
    installMockApi({
      handoffList: ({ sessionId }: { sessionId: string }) =>
        Promise.resolve({ records: [], links: null, continuation: null, mode: sessionId === "ses_a" ? "off" : "auto", modeIsDefault: true }),
      handoffSetMode: ({ mode }: { mode: string }) => Promise.resolve({ mode }),
    });
    h = mount(
      <>
        <div id="a"><HandoffModeToggle sessionId="ses_a" /></div>
        <div id="b"><HandoffModeToggle sessionId="ses_b" /></div>
      </>,
    );
    await h.flush();
    const a = () => h!.container.querySelector("#a [data-testid=handoff-mode]") as HTMLButtonElement;
    const b = () => h!.container.querySelector("#b [data-testid=handoff-mode]") as HTMLButtonElement;
    expect(a().textContent).toContain("Handoff: off");
    expect(b().textContent).toContain("Handoff: auto");
    await press(h, a());
    expect(a().textContent).toContain("Handoff: auto");
    expect(b().textContent).toContain("Handoff: auto");
    await press(h, b());
    expect(a().textContent).toContain("Handoff: auto");
    expect(b().textContent).toContain("Handoff: suggest");
  });

  it("falls back to suggest when the box reports no mode (older box)", async () => {
    installMockApi();
    h = mount(<HandoffModeToggle sessionId="ses_a" />);
    await h.flush();
    expect(btn().textContent).toContain("Handoff: suggest");
  });

  it("a failed save restores the old mode and says so", async () => {
    installMockApi({
      handoffList: () => Promise.resolve({ records: [], links: null, continuation: null, mode: "auto", modeIsDefault: true }),
      handoffSetMode: () => Promise.reject(new Error("box unreachable")),
    });
    h = mount(<HandoffModeToggle sessionId="ses_a" />);
    await h.flush();
    await press(h, btn());
    expect(btn().textContent).toContain("Handoff: auto");
    expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save handoff mode: box unreachable");
  });
});
