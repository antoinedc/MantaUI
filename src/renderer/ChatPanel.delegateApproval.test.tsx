// @vitest-environment jsdom
//
// Two concerns for the background-job approval card inside ChatPanel:
//
// 1. A pending approval is NEVER approved automatically. A pending permission
//    ask's `always` list is what the asking tool WOULD save if the user picked
//    "Always" — it is not a grant — so it must not auto-start a job (security:
//    desktop-approval-pending-always). Only the user's click may.
//
// 2. The card reports the outcome of Start / Not now (previously: hide first,
//    fire-and-forget, swallow the rejection, ignore `{ok:false}`), the 3 s poll
//    cannot re-show an approval whose decision is in flight or resurrect it from
//    a stale response, and a failed Start keeps the user's edited rules. These
//    drive the REAL card; in the second describe only setInterval is faked so
//    `h.flush()` (setTimeout) keeps working.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { useStore } from "./store";
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

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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

const EDIT_TOOLS = [
  { permission: "bash", pattern: "ls" },
  { permission: "edit", pattern: "**" },
];
const AP = { id: "ap1", parentSessionID: SID, name: "job", prompt: "do it", tools: EDIT_TOOLS, createdAt: 1 };
const AP_B = { ...AP, id: "ap2", tools: [{ permission: "read", pattern: "**" }] };

// Copy mirrored from the spec (kept literal here so a copy change is a visible test edit).
const COPY = {
  declineUnavailable: "This approval is no longer available. Check background jobs to see whether it was already started.",
  approveUnavailable: "This approval is no longer available. Check background jobs before trying to start it again.",
  declineUnconfirmed: "Couldn’t confirm that the background job was declined. Check background jobs before trying again.",
  approveUnconfirmed: "Couldn’t confirm that the background job was started. Check background jobs before trying again.",
};


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

describe("ChatPanel background-job approval card", () => {
  let api: MockApi;
  let h: Harness | null = null;
  let pollImpl: () => Promise<unknown>;
  let decideImpl: Record<"delegateApprove" | "delegateDecline", (...a: unknown[]) => unknown>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    useStore.setState({ appToasts: [] });
    pollImpl = () => Promise.resolve([AP]);
    decideImpl = {
      delegateApprove: () => Promise.resolve({ ok: true }),
      delegateDecline: () => Promise.resolve({ ok: true }),
    };
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
    useStore.setState({ appToasts: [] });
  });

  async function open() {
    ({ api } = installMockApi({
      delegatePendingApprovals: () => pollImpl(),
      delegateApprove: (...a: unknown[]) => decideImpl.delegateApprove(...a),
      delegateDecline: (...a: unknown[]) => decideImpl.delegateDecline(...a),
    }));
    resetStore({ jobs: {} } as never);
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
  }
  const tick = async () => {
    await act(async () => { vi.advanceTimersByTime(3000); });
    await h!.flush();
  };
  const cardShown = () => (h!.container.textContent ?? "").includes("Background job approval");
  const button = (text: string) =>
    Array.from(h!.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
  const click = async (el: Element) => {
    await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await h!.flush();
  };
  // Visible rule text whether the card is in view mode (badges) or edit mode (inputs).
  const rulesText = () =>
    (h!.container.textContent ?? "") +
    Array.from(h!.container.querySelectorAll("input")).map((i) => ` ${(i as HTMLInputElement).value}`).join("");
  const toasts = () => useStore.getState().appToasts;
  const calls = (m: string) => api.calls[m] ?? [];

  const KINDS = [
    { kind: "decline", btn: "Not now", method: "delegateDecline", unavailable: COPY.declineUnavailable, unconfirmed: COPY.declineUnconfirmed, unavailableTone: undefined },
    { kind: "approve", btn: "Start job", method: "delegateApprove", unavailable: COPY.approveUnavailable, unconfirmed: COPY.approveUnconfirmed, unavailableTone: "error" },
  ] as const;

  describe.each(KINDS)("$kind", ({ btn, method, unavailable, unconfirmed, unavailableTone }) => {
    it("rejection → 'couldn’t confirm' error toast and the card is back", async () => {
      decideImpl[method] = () => Promise.reject(new Error("net"));
      await open();
      expect(cardShown()).toBe(true);
      await click(button(btn));
      expect(calls(method)).toHaveLength(1);
      expect(toasts().map((t) => [t.message, t.tone])).toEqual([[unconfirmed, "error"]]);
      expect(cardShown()).toBe(true);
    });

    it("malformed reply → treated as unconfirmed", async () => {
      decideImpl[method] = () => Promise.resolve(undefined);
      await open();
      await click(button(btn));
      expect(toasts().map((t) => t.message)).toEqual([unconfirmed]);
      expect(cardShown()).toBe(true);
    });

    it("{ok:false} → 'no longer available' toast, card stays gone", async () => {
      decideImpl[method] = () => Promise.resolve({ ok: false });
      await open();
      await click(button(btn));
      expect(toasts().map((t) => [t.message, t.tone])).toEqual([[unavailable, unavailableTone]]);
      expect(cardShown()).toBe(false);
    });

    it("{ok:true} → silent, card gone, RPC got the approval id", async () => {
      await open();
      await click(button(btn));
      expect(toasts()).toEqual([]);
      expect(cardShown()).toBe(false);
      expect(calls(method)).toHaveLength(1);
      expect(calls(method)[0][0]).toBe("ap1");
    });

    it("while the decision is in flight a poll cannot re-show the card or send it twice", async () => {
      const d = deferred();
      decideImpl[method] = () => d.promise;
      await open();
      await click(button(btn));
      await tick();
      expect(cardShown()).toBe(false);
      expect(calls(method)).toHaveLength(1);
      await act(async () => { d.resolve({ ok: true }); });
      await h!.flush();
      expect(toasts()).toEqual([]);
      expect(cardShown()).toBe(false);
    });

    it("a poll issued before the decision finished cannot resurrect it afterwards", async () => {
      await open();
      const late = deferred();
      pollImpl = () => late.promise;
      await tick(); // poll #2 now pending
      await click(button(btn)); // decision completes ok
      await act(async () => { late.resolve([AP]); });
      await h!.flush();
      expect(cardShown()).toBe(false);
    });
  });

  it("an authoritative empty poll clears a displayed (restored) approval", async () => {
    decideImpl.delegateDecline = () => Promise.reject(new Error("net"));
    await open();
    await click(button("Not now"));
    expect(cardShown()).toBe(true);
    pollImpl = () => Promise.resolve([]);
    await tick();
    expect(cardShown()).toBe(false);
  });

  it("a failed Start keeps the edited rules; the retry submits exactly them, polls cannot widen them", async () => {
    decideImpl.delegateApprove = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue({ ok: true });
    await open();
    await click(button("Edit access"));
    const remove = h!.container.querySelector('button[title="Remove"]') as HTMLButtonElement;
    await click(remove); // drop bash:ls
    await click(button("Start job"));
    expect(calls("delegateApprove")[0][1]).toEqual([{ permission: "edit", pattern: "**" }]);
    expect(cardShown()).toBe(true);
    expect(rulesText()).toMatch(/edit[: ]+\*\*/);
    expect(rulesText()).not.toMatch(/bash[: ]+ls/);

    await tick(); // the box still lists the ORIGINAL (broader) request
    expect(rulesText()).not.toMatch(/bash[: ]+ls/);

    await click(button("Start job"));
    expect(calls("delegateApprove")).toHaveLength(2);
    expect(calls("delegateApprove")[1]).toEqual(["ap1", [{ permission: "edit", pattern: "**" }]]);
  });

  it("navigating away (isActive=false) mid-decision: toast shown, card not restored into the hidden panel; reactivation re-shows it", async () => {
    const d = deferred();
    decideImpl.delegateDecline = () => d.promise;
    await open();
    await click(button("Not now"));
    h!.rerender(<ChatPanel {...PROPS} isActive={false} />);
    await h!.flush();
    await act(async () => { d.reject(new Error("net")); });
    await h!.flush();
    expect(toasts().map((t) => t.message)).toEqual([COPY.declineUnconfirmed]);
    expect(cardShown()).toBe(false);
    h!.rerender(<ChatPanel {...PROPS} isActive={true} />);
    await h!.flush();
    expect(cardShown()).toBe(true);
  });

  it("an older decision's failure never replaces a newer approval", async () => {
    const d = deferred();
    decideImpl.delegateDecline = () => d.promise;
    await open();
    await click(button("Not now")); // A in flight
    pollImpl = () => Promise.resolve([AP, AP_B]);
    await tick();
    expect(h!.container.textContent).toContain("read: **"); // B displayed
    await act(async () => { d.reject(new Error("net")); });
    await h!.flush();
    expect(h!.container.textContent).toContain("read: **");
    expect(h!.container.textContent).not.toContain("bash: ls");
  });

  it("unmount during an in-flight decision: the toast still lands and nothing throws", async () => {
    const d = deferred();
    decideImpl.delegateDecline = () => d.promise;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await open();
    await click(button("Not now"));
    h!.unmount();
    h = null;
    await act(async () => { d.reject(new Error("net")); });
    expect(toasts().map((t) => t.message)).toEqual([COPY.declineUnconfirmed]);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
