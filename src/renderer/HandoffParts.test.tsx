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

  it("collapses a long body after 12 lines and shows all on request", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n");
    open(rec({ text }));
    await h!.flush();
    const collapsed = h!.container.querySelector('[data-testid="handoff-body"]')!.textContent!;
    expect(collapsed).toContain("line 0");
    expect(collapsed).not.toContain("line 29");
    await press(h!, buttons(h!).find((b) => /Show all/.test(b.textContent ?? "")));
    expect(h!.container.querySelector('[data-testid="handoff-body"]')!.textContent).toContain("line 29");
    expect(buttons(h!).some((b) => /Show less/.test(b.textContent ?? ""))).toBe(true);
  });

  it("Copy writes the RAW markdown and says so", async () => {
    open(rec({ text: "## Goal\n**bold** `x`" }));
    await press(h!, byText(h!, "Copy"));
    expect(clip.writeText).toHaveBeenCalledWith("## Goal\n**bold** `x`");
    expect(noticeText(h!)).toBe("Copied to the clipboard");
  });

  it("Copy that the clipboard refuses reports the failure", async () => {
    open(rec());
    clip.writeText = vi.fn(() => Promise.reject(new Error("denied")));
    await press(h!, byText(h!, "Copy"));
    expect(noticeText(h!)).toBe("denied");
    expect(h!.container.querySelector('[data-testid="handoff-notice"]')?.getAttribute("role")).toBe("alert");
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

describe("HandoffModeToggle", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("cycles auto → suggest → off → auto, persisting each step through config:update", async () => {
    const { api } = installMockApi({ configUpdate: (patch: Record<string, unknown>) => Promise.resolve({ ...patch }) });
    resetStore({ handoffMode: "auto" } as never);
    h = mount(<HandoffModeToggle />);
    const btn = () => h!.container.querySelector('[data-testid="handoff-mode"]') as HTMLButtonElement;
    expect(btn().textContent).toContain("Handoff: auto");
    await press(h, btn());
    expect(btn().textContent).toContain("Handoff: suggest");
    await press(h, btn());
    expect(btn().textContent).toContain("Handoff: off");
    await press(h, btn());
    expect(btn().textContent).toContain("Handoff: auto");
    expect(api.calls.configUpdate).toEqual([[{ handoffMode: "suggest" }], [{ handoffMode: "off" }], [{ handoffMode: "auto" }]]);
  });

  it("a failed save restores the label and says so", async () => {
    installMockApi({ configUpdate: () => Promise.reject(new Error("box unreachable")) });
    resetStore({ handoffMode: "auto" } as never);
    h = mount(<HandoffModeToggle />);
    await press(h, h.container.querySelector('[data-testid="handoff-mode"]') as HTMLElement);
    expect(h.container.querySelector('[data-testid="handoff-mode"]')!.textContent).toContain("Handoff: auto");
    expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save handoff mode: box unreachable");
  });
});
