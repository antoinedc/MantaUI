// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { installMockApi, resetStore, mount, type Harness } from "../testHarness";
import { useBoxCapability, resetBoxCapabilities } from "./useBoxCapabilities";

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
    installMockApi({ getServerVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: ["chat-cards-1"] }) });
    h = mount(<Probe id="chat-cards-1" />);
    expect(seen[0]).toBeNull();
    await h.flush();
    expect(value()).toBe("true");
  });

  it("is false for an id the box does not list, and false on an older box that sends no list", async () => {
    installMockApi({ getServerVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: ["other-1"] }) });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("false");
    h.unmount();
    installMockApi({ getServerVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1" }) });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("false");
  });

  it("stays null when the box cannot be asked", async () => {
    installMockApi({ getServerVersion: () => Promise.reject(new Error("offline")) });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("null");
  });

  it("re-asks on a connection edge (a reconnect after a box upgrade carries the new list)", async () => {
    let caps: string[] = [];
    installMockApi({ getServerVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: caps }) });
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
    installMockApi({ getServerVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1", capabilities: ["chat-cards-1"] }) });
    h = mount(<Probe id="chat-cards-1" />);
    await h.flush();
    expect(value()).toBe("true");
    act(() => resetBoxCapabilities());
    expect(value()).toBe("null");
  });
});
