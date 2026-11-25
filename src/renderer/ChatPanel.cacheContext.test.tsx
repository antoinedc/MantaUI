// @vitest-environment jsdom
//
// WS11 D2: the panel renders the box's `cache` / `context` payloads as given —
// the stale pill flips from the box's `staleAt` instant with no new frame, and the
// context percentage is the box's (selected-model) value, never a client recompute.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel";
import { emitStreamAndFlush, installMockApi, mount, resetStore, type Harness } from "./testHarness";

const SID = "ses_cc";
const PROPS = { sessionId: SID, tmuxSession: "proj", windowIndex: 1, cwd: "/x", isActive: true, projectName: "proj", winName: "chat-1", mode: "chat" as const };

const context = (limit: number, pct: number) => ({
  freshInput: 10000, cacheRead: 0, cacheWrite: 0, totalInput: 10000, pct, hasLimit: true,
  segments: [{ kind: "fresh" as const, pct }], limit,
  model: { providerID: "anthropic", modelID: "m" }, basis: "selected" as const,
});

describe("ChatPanel — box-owned cache + context (WS11 D2)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
  });

  // Drain the mount's promise chains on the fake clock (the harness's own flush waits on a real timeout).
  const settle = () => (vi.isFakeTimers() ? act(async () => { await vi.advanceTimersByTimeAsync(0); }) : h!.flush());

  async function open(overrides: Record<string, unknown> = {}) {
    const { bus } = installMockApi({ opencodeMessages: () => Promise.resolve([]), ...overrides });
    resetStore({ projects: [{ tmuxSession: "proj", defaultCwd: "/x", windows: [{ index: 1, name: "chat-1", opencodeSessionId: SID }] }] } as never);
    h = mount(<ChatPanel {...PROPS} />);
    await settle();
    await settle();
    return bus;
  }

  it("shows the box's context percentage and follows a re-emitted frame (model switch)", async () => {
    const bus = await open({ opencodeContext: () => Promise.resolve(context(200000, 5)) });
    const pill = () => h!.container.querySelector(".manta-ctx-pill")?.textContent ?? "";
    expect(pill()).toContain("5%");
    await emitStreamAndFlush(bus, h!, { sub: "context", sessionId: SID, payload: context(1000000, 1) });
    expect(pill()).toContain("1%");
  });

  it("flips the cold-cache state at the box's staleAt, with no new frame", async () => {
    // Fake clock: staleAt is "400 ms from now" on a clock that only moves when the test says so,
    // so a slow machine cannot reach the instant early or late.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const now = Date.now();
    await open({
      opencodeContext: () => Promise.resolve(context(200000, 5)),
      opencodeCache: () => Promise.resolve({ isStale: false, idleMs: 0, staleTokens: 12000, ttlMs: 300000, lastCompleted: now - 100_000, staleAt: now + 400 }),
    });
    expect(h!.container.textContent).not.toContain("cold");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(h!.container.textContent).not.toContain("cold");
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(h!.container.textContent).toContain("cold");
  });
});
