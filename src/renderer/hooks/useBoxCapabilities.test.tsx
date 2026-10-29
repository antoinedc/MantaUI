// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useStore } from "../store";
import { act } from "react";
import { installMockApi, resetStore, mount, type Harness } from "../testHarness";
import { useBoxCapability, resetBoxCapabilities, refreshBoxCapabilities } from "./useBoxCapabilities";

let seen: Array<boolean | null> = [];
function Probe({ id }: { id: string }) {
  const v = useBoxCapability(id);
  seen.push(v);
  return <span data-testid="cap">{String(v)}</span>;
}

describe("useBoxCapability", () => {
  let h: Harness | null = null;
  beforeEach(() => {
    seen = [];
    resetStore();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  const value = () => h!.container.querySelector('[data-testid="cap"]')?.textContent;

  it("is null until the box answers, then true for an advertised id", async () => {
    installMockApi({ apiVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: ["chat-cards-1"] }) });
    h = mount(<Probe id="chat-cards-1" />);
    expect(seen[0]).toBeNull();
    await h.flush();
    expect(value()).toBe("true");
  });

  it("is false for an id the box does not list, and false on an older box that sends no list", async () => {
    installMockApi({ apiVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: ["other-1"] }) });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("false");
    h.unmount();
    installMockApi({ apiVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1" }) });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("false");
  });

  it("stays null when the box cannot be asked (a failure is never an old box)", async () => {
    installMockApi({ apiVersion: () => Promise.reject(new Error("offline")) });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("null");
    expect(useStore.getState().boxCapabilities.state).toBe("failed");
  });

  it("keeps the last loaded ids across a later failed refresh", async () => {
    let fail = false;
    installMockApi({
      apiVersion: () => (fail ? Promise.reject(new Error("blip")) : Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: ["chat-cards-1"] })),
    });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("true");
    fail = true;
    await act(async () => {
      await refreshBoxCapabilities();
    });
    expect(useStore.getState().boxCapabilities.state).toBe("failed");
    expect(value()).toBe("true");
  });

  it("a 503 body from the old RPC never reaches the store: the REST read is the only source", async () => {
    const getServerVersion = vi.fn(() => Promise.reject(new Error("HTTP 503")));
    installMockApi({
      getServerVersion,
      apiVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: ["chat-cards-1"] }),
    });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("true");
    expect(getServerVersion).not.toHaveBeenCalled();
  });

  it("re-asks on a connection edge (a reconnect after a box upgrade carries the new list)", async () => {
    let caps: string[] = [];
    installMockApi({ apiVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: caps }) });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("false");
    caps = ["chat-cards-1"];
    const { useStore } = await import("../store");
    await act(async () => useStore.getState().setConnectionState({ state: "reconnecting", attempt: 1, backoffMs: 10 }));
    await act(async () => useStore.getState().setConnectionState({ state: "connected" }));
    await h.flush();
    expect(value()).toBe("true");
  });

  it("resetBoxCapabilities forgets the answer", async () => {
    installMockApi({ apiVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: ["chat-cards-1"] }) });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("true");
    act(() => resetBoxCapabilities());
    expect(value()).toBe("null");
  });

  // WS11 D1 review #5: a box change forgets the old box's list, so a failed first read of the NEW box answers null.
  it("switching box with the first read failing answers null, not the old box's ids", async () => {
    let newBox = false;
    installMockApi({
      apiVersion: () => (newBox ? Promise.reject(new Error("offline")) : Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: ["chat-cards-1"] })),
    });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("true");
    newBox = true;
    act(() => resetBoxCapabilities()); // what App does on a transport swap
    await act(async () => {
      await refreshBoxCapabilities();
    });
    expect(useStore.getState().boxCapabilities.state).toBe("failed");
    expect(value()).toBe("null");
  });

  // WS11 D1 review #6: a 401 is the sign-in path's — no retry schedule.
  it("an auth error is not retried", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      installMockApi({
        apiVersion: () => {
          calls++;
          return Promise.reject(Object.assign(new Error("401"), { name: "AuthRequiredError" }));
        },
      });
      await act(async () => {
        await refreshBoxCapabilities();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(calls).toBe(1);
      expect(useStore.getState().boxCapabilities.state).toBe("failed");
    } finally {
      vi.useRealTimers();
      resetBoxCapabilities();
    }
  });

  it("an ordinary failure IS retried on the backoff schedule", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      installMockApi({
        apiVersion: () => {
          calls++;
          return Promise.reject(new Error("blip"));
        },
      });
      await act(async () => {
        await refreshBoxCapabilities();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(calls).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
      resetBoxCapabilities();
    }
  });
});
