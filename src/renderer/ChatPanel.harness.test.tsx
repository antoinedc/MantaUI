// @vitest-environment jsdom
//
// Render-harness smoke tests for ChatPanel (BET-63 step 1).
//
// These mount the REAL <ChatPanel> in jsdom with a mocked window.api + SSE
// bus, and assert the component renders its top-level surfaces without
// crashing. This is the safety net that makes the container decomposition
// (Transcript / Composer / hook extraction) verifiable rather than blind —
// if any extraction breaks the mount or the event wiring, a test here fails.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChatPanel } from "./ChatPanel";
import {
  installMockApi,
  resetStore,
  mount,
  emitAndFlush,
  type MockEventBus,
  type Harness,
} from "./testHarness";

const PROPS = {
  sessionId: "ses_test",
  tmuxSession: "proj",
  windowIndex: 1,
  cwd: "/home/dev/projects/x",
  isActive: true,
};

describe("ChatPanel render harness", () => {
  let bus: MockEventBus;
  let h: Harness | null = null;

  beforeEach(() => {
    ({ bus } = installMockApi());
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("mounts without crashing and shows the empty-state welcome", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    // Empty transcript renders the welcome line.
    expect(h.text()).toContain("Welcome");
    // The composer textarea is present.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("subscribes to the opencode event bus on mount", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    expect(bus.listenerCount()).toBeGreaterThan(0);
  });

  it("unsubscribes from the event bus on unmount", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    expect(bus.listenerCount()).toBeGreaterThan(0);
    h.unmount();
    h = null;
    expect(bus.listenerCount()).toBe(0);
  });

  it("renders a permission card when a permission.asked event arrives", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await emitAndFlush(bus, h, {
      type: "permission.asked",
      properties: {
        sessionID: "ses_test",
        id: "perm_1",
        title: "Run command",
        metadata: {},
      },
    });
    // The permission surfaced into the DOM (card copy varies; the id-driven
    // card at minimum renders allow/deny affordances).
    expect(h.text().toLowerCase()).toMatch(/allow|permission|run command/);
  });

  it("ignores events for a different session id", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    const before = h.text();
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: "ses_OTHER", status: "busy" },
    });
    // Still on the welcome screen — a foreign session's event did nothing.
    expect(h.text()).toContain("Welcome");
    expect(h.text()).toBe(before);
  });
});
