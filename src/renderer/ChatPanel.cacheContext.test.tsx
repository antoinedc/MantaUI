// @vitest-environment jsdom
//
// WS11 D2: the panel renders the box's `cache` / `context` payloads as given —
// the stale pill flips from the box's `staleAt` instant with no new frame, and the
// context percentage is the box's (selected-model) value, never a client recompute.

import { afterEach, describe, expect, it } from "vitest";
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
  });

  async function open(overrides: Record<string, unknown> = {}) {
    const { bus } = installMockApi({ opencodeMessages: () => Promise.resolve([]), ...overrides });
    resetStore({ projects: [{ tmuxSession: "proj", defaultCwd: "/x", windows: [{ index: 1, name: "chat-1", opencodeSessionId: SID }] }] } as never);
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await h.flush();
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
    const now = Date.now();
    await open({
      opencodeContext: () => Promise.resolve(context(200000, 5)),
      opencodeCache: () => Promise.resolve({ isStale: false, idleMs: 0, staleTokens: 12000, ttlMs: 300000, lastCompleted: now - 100_000, staleAt: now + 400 }),
    });
    expect(h!.container.textContent).not.toContain("cold");
    await new Promise((r) => setTimeout(r, 700));
    await h!.flush();
    expect(h!.container.textContent).toContain("cold");
  });
});
