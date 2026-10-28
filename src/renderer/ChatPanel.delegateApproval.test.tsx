// @vitest-environment jsdom
//
// A pending background-job approval is NEVER approved automatically. A pending
// permission ask's `always` list is what the asking tool WOULD save if the user
// picked "Always" — it is not a grant — so it must not auto-start a job
// (security: desktop-approval-pending-always). Only the user's click may.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import {
  installMockApi,
  resetStore,
  mount,
  buttonByText,
  emitStreamAndFlush,
  type MockApi,
  type MockEventBus,
  type Harness,
} from "./testHarness";

const SID = "ses_test";
const PROPS = { sessionId: SID, tmuxSession: "proj", windowIndex: 1, cwd: "/x", isActive: true };

const TOOLS = [{ permission: "bash", pattern: "git push *" }];
const APPROVAL = {
  id: "ap1",
  parentSessionID: SID,
  name: "job",
  prompt: "do the thing",
  tools: TOOLS,
  createdAt: 1,
};
const BROAD_ASK = {
  id: "per1",
  sessionID: SID,
  permission: "bash",
  patterns: ["x"],
  always: ["*"],
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("ChatPanel pre-flight job approval (never auto-approved)", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // The first poll is held on a deferred promise so the order is deterministic:
  // hydrate, deliver the malicious ask, THEN let the approval list arrive.
  async function open(overrides: Record<string, unknown> = {}, store: Record<string, unknown> = {}) {
    const held = deferred<unknown[]>();
    ({ api, bus } = installMockApi({
      delegatePendingApprovals: () => held.promise,
      delegateApprove: () => Promise.resolve({ ok: true }),
      ...overrides,
    }));
    resetStore(store as never);
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    return held;
  }

  const emitPermissions = (permissions: unknown[]) =>
    emitStreamAndFlush(bus, h!, { sub: "permissions", sessionId: SID, payload: { permissions } });

  async function resolveApprovals(held: ReturnType<typeof deferred<unknown[]>>) {
    await act(async () => { held.resolve([APPROVAL]); });
    await h!.flush();
  }

  it("does not approve when a pending ask offers always:[\"*\"]; shows the card", async () => {
    const held = await open();
    await emitPermissions([BROAD_ASK]);
    await resolveApprovals(held);

    expect(api.calls.delegateApprove ?? []).toEqual([]);
    expect(buttonByText(h!, "Start job")).not.toBeNull();
  });

  it("still shows the card, and approves nothing, after that ask is rejected", async () => {
    const held = await open();
    await emitPermissions([BROAD_ASK]);
    await resolveApprovals(held);
    await emitPermissions([]);

    expect(api.calls.delegateApprove ?? []).toEqual([]);
    expect(buttonByText(h!, "Start job")).not.toBeNull();
  });

  it("Start job approves exactly once with the card's tools and dismisses the card", async () => {
    const held = await open();
    await resolveApprovals(held);
    await act(async () => { buttonByText(h!, "Start job")!.click(); });
    await h!.flush();

    expect(api.calls.delegateApprove).toEqual([["ap1", TOOLS]]);
    expect(buttonByText(h!, "Start job")).toBeNull();
  });

  it("trust mode never polls for approvals", async () => {
    await open({}, { chatAutoAllow: true });
    await h!.flush();

    expect(api.calls.delegatePendingApprovals ?? []).toEqual([]);
  });
});
