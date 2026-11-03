// @vitest-environment jsdom
//
// A message the panel sent shows in exactly ONE place — the transcript or the
// Pending card — and whichever shows it shows its attachments
// (docs/superpowers/specs/2026-11-03-pending-message-single-place.md).
// The stale-idle case: the renderer thinks the agent is idle, so the message
// takes the idle send path, but the box is running and parks it in its inbox.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { refreshModelCatalog } from "./modelCatalog";
import { resetRetiredInboxEpochs } from "./inboxState";
import type { Attachment } from "./chatShared";
import {
  installMockApi,
  resetStore,
  mount,
  type MockApi,
  type MockEventBus,
  type Harness,
} from "./testHarness";

const SID = "ses_test";
const PROPS = { sessionId: SID, tmuxSession: "proj", windowIndex: 1, cwd: "/x", isActive: true };
const TEXT = "see the screenshot";
const IDLE_SEND_HIDE_MS = 5000;

const attachments: Attachment[] = [
  { id: "a1", filename: "shot.png", mime: "image/png", remotePath: "/remote/shot.png", status: "ready", source: "drop", asPathRef: false },
];

const canonical = (id: string) => ({
  info: { id, sessionID: SID, role: "user" as const, time: { created: Date.now() } },
  parts: [
    { id: `${id}:text:0`, messageID: id, sessionID: SID, type: "text", text: TEXT },
    { id: `${id}:file:0`, messageID: id, sessionID: SID, type: "file", mime: "image/png", filename: "shot.png", url: "file:///remote/shot.png" },
  ],
});

describe("a sent message shows in exactly one place", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;
  let rev = 0;
  let deliveredId: string | null = null;

  beforeEach(() => {
    resetRetiredInboxEpochs();
    rev = 0;
    deliveredId = null;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ({ api, bus } = installMockApi({
      opencodeModels: () =>
        Promise.resolve([
          { id: "claude-x", providerID: "anthropic", name: "Claude X", limit: { context: 200000 }, capabilities: { input: ["image", "text"] } },
        ]),
      opencodeDefaultModel: () => Promise.resolve({ providerID: "anthropic", modelID: "claude-x" }),
      opencodeMessage: () => Promise.resolve(deliveredId ? canonical(deliveredId) : null),
    }));
    refreshModelCatalog();
    resetStore();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
  });

  // Fake timers: the harness's own flush() waits on a real setTimeout, so drive time by hand.
  const tick = (ms = 0) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const emit = async (frame: Parameters<MockEventBus["emitStream"]>[0]) => {
    act(() => bus.emitStream(frame));
    await tick();
  };
  const pushInbox = (items: Array<{ id: string; text: string; attachmentCount: number }>) => {
    rev += 1;
    return emit({
      sub: "inbox",
      sessionId: SID,
      payload: { epoch: "e1", rev, items: items.map((i) => ({ ...i, delivery: "steer", createdAt: 1 })) },
    });
  };
  const count = (needle: string) => h!.text().split(needle).length - 1;
  const card = () => h!.container.querySelector('[data-testid="inbox-card"]');
  const sentId = () => (api.calls.opencodePrompt[0][6] as { messageID: string }).messageID;

  async function sendWithAttachment() {
    h = mount(<ChatPanel {...PROPS} autoSubmit={{ text: TEXT, model: { providerID: "anthropic", modelID: "claude-x" }, attachments }} />);
    await tick();
    await tick();
  }

  it("stale-idle send into a running box: one place at a time, attachment always shown", async () => {
    await sendWithAttachment();

    // The idle send minted the id client-side and passed it, with no delivery.
    expect(api.calls.opencodePrompt).toHaveLength(1);
    const opts = api.calls.opencodePrompt[0][6] as { messageID: string; delivery?: string };
    expect(opts.messageID).toMatch(/^msg_/);
    expect(opts.delivery).toBeUndefined();

    // From the first frame: the optimistic row has the text AND the attachment.
    expect(count(TEXT)).toBe(1);
    expect(count("shot.png")).toBe(1);
    expect(card()).toBeNull();

    // The box was running: it parks the message in its inbox (same id). Within the idle window the card stays hidden.
    await pushInbox([{ id: sentId(), text: TEXT, attachmentCount: 1 }]);
    expect(card()).toBeNull();
    expect(count(TEXT)).toBe(1);

    // After the hide window it really is waiting: the card shows it, the transcript no longer does.
    await tick(IDLE_SEND_HIDE_MS);
    expect(card()).not.toBeNull();
    expect(h!.container.querySelectorAll('[data-testid="inbox-row"]')).toHaveLength(1);
    expect(card()!.textContent).toContain("+1 attachment");
    expect(count(TEXT)).toBe(1);
    expect(count("shot.png")).toBe(0);

    // Delivered: it leaves the inbox and the canonical message (same id, file part) takes the transcript.
    deliveredId = sentId();
    await pushInbox([]);
    await emit({ sub: "messageChanged", sessionId: SID, payload: { messageID: deliveredId } });
    await tick(400);
    expect(card()).toBeNull();
    expect(count(TEXT)).toBe(1);
    expect(count("shot.png")).toBe(1);
  });

  it("ordinary idle send: shown at once with its attachment, never a card row, replaced by the canonical message", async () => {
    await sendWithAttachment();
    expect(count(TEXT)).toBe(1);
    expect(count("shot.png")).toBe(1);

    // V2 lists an idle send in the inbox for an instant, then delivers it.
    await pushInbox([{ id: sentId(), text: TEXT, attachmentCount: 1 }]);
    expect(card()).toBeNull();
    await pushInbox([]);
    deliveredId = sentId();
    await emit({ sub: "messageChanged", sessionId: SID, payload: { messageID: deliveredId } });
    await tick(400);

    expect(card()).toBeNull();
    expect(count(TEXT)).toBe(1);
    expect(count("shot.png")).toBe(1);
  });
});
