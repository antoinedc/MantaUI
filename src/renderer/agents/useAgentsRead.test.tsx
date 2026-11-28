// @vitest-environment jsdom
//
// The kept-fresh read behind the agent pages: subscribe to the box's hints before the first read, refetch (debounced) on a
// hint or a resync, never let an older answer roll a newer one back, keep what is shown when a refetch fails, and tell an
// older box (no such channel) from a failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { installMockApi, mount, type Harness, type MockApi, type MockEventBus } from "../testHarness";
import { useAgentsRead } from "./useAgentsRead";

function Probe({ read, k = 0 }: { read: (() => Promise<string | null>) | null; k?: number }) {
  const r = useAgentsRead<string>(read, k);
  return (
    <div
      data-testid="p"
      data-loading={String(r.loading)}
      data-unsupported={String(r.unsupported)}
      data-error={r.error ?? ""}
      data-refresh-error={r.refreshError ?? ""}
      data-updated-at={String(r.updatedAt ?? "")}
    >
      {r.data ?? ""}
    </div>
  );
}

describe("useAgentsRead", () => {
  let h: Harness | null = null;
  let api: MockApi;
  let bus: MockEventBus;
  let order: string[] = [];
  let hints: { fleet?: () => void; question?: () => void; change?: () => void };

  beforeEach(() => {
    order = [];
    hints = {};
    ({ api, bus } = installMockApi({
      onAgentFleet: (cb: () => void) => {
        order.push("subscribe");
        hints.fleet = cb;
        return () => {};
      },
      onTaskQuestion: (cb: () => void) => {
        hints.question = cb;
        return () => {};
      },
      onAgentChange: (cb: () => void) => {
        hints.change = cb;
        return () => {};
      },
    }));
    void api;
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
  });

  const p = () => h!.container.querySelector<HTMLElement>('[data-testid="p"]')!;

  it("subscribes before the first read, which fills the data", async () => {
    h = mount(
      <Probe
        read={() => {
          order.push("read");
          return Promise.resolve("one");
        }}
      />,
    );
    await h.flush();
    expect(order).toEqual(["subscribe", "read"]);
    expect(p().textContent).toBe("one");
    expect(p().dataset.loading).toBe("false");
  });

  it("a null answer or an unknown channel is unsupported, not an error", async () => {
    h = mount(<Probe read={() => Promise.resolve(null)} />);
    await h.flush();
    expect(p().dataset.unsupported).toBe("true");
    h.unmount();
    h = mount(<Probe read={() => Promise.reject(new Error("unknown rpc channel: agents:fleet"))} />);
    await h.flush();
    expect(p().dataset.unsupported).toBe("true");
    expect(p().dataset.error).toBe("");
  });

  it("a first read that fails is an error; a refetch that fails keeps what is shown", async () => {
    let n = 0;
    h = mount(<Probe read={() => (++n === 1 ? Promise.resolve("one") : Promise.reject(new Error("busy")))} />);
    await h.flush();
    expect(p().textContent).toBe("one");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => hints.fleet?.());
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(p().textContent).toBe("one");
    expect(p().dataset.error).toBe("");
    vi.useRealTimers();
    h.unmount();
    h = mount(<Probe read={() => Promise.reject(new Error("busy"))} />);
    await h.flush();
    expect(p().dataset.error).toBe("busy");
  });

  it("a refetch that fails keeps the data and says so (refreshError); the next good one clears it; updatedAt is when data last arrived", async () => {
    let n = 0;
    h = mount(<Probe read={() => (++n === 2 ? Promise.reject(new Error("busy")) : Promise.resolve(`v${n}`))} />);
    await h.flush();
    expect(p().dataset.refreshError).toBe("");
    const first = Number(p().dataset.updatedAt);
    expect(first).toBeGreaterThan(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => hints.fleet?.());
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(p().textContent).toBe("v1");
    expect(p().dataset.refreshError).toBe("busy");
    expect(Number(p().dataset.updatedAt)).toBe(first);
    act(() => hints.fleet?.());
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(p().textContent).toBe("v3");
    expect(p().dataset.refreshError).toBe("");
  });

  it("reload() reports a failure the same way (the Try again button)", async () => {
    let n = 0;
    let reload: (() => Promise<void>) | null = null;
    function Grab() {
      const r = useAgentsRead<string>(() => (++n === 1 ? Promise.resolve("one") : Promise.reject(new Error("still busy"))), 0);
      reload = r.reload;
      return <div data-testid="p" data-refresh-error={r.refreshError ?? ""} />;
    }
    h = mount(<Grab />);
    await h.flush();
    await act(async () => {
      await reload?.();
    });
    expect(p().dataset.refreshError).toBe("still busy");
  });

  it("every kind of hint and the resync frame refetch, one read per burst", async () => {
    let n = 0;
    h = mount(<Probe read={() => Promise.resolve(`v${++n}`)} />);
    await h.flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => {
      hints.fleet?.();
      hints.question?.();
      hints.change?.();
      bus.emit({ type: "server.connected", properties: {} } as never);
    });
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(n).toBe(2);
  });

  it("an older answer never rolls a newer one back", async () => {
    const waiting: Array<(v: string) => void> = [];
    h = mount(<Probe read={() => new Promise<string>((r) => waiting.push(r))} />);
    await h.flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => hints.fleet?.());
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(waiting).toHaveLength(2);
    await act(async () => {
      waiting[1]("new");
    });
    await act(async () => {
      waiting[0]("old");
    });
    expect(p().textContent).toBe("new");
  });

  it("another key starts over, dropping the old data", async () => {
    h = mount(<Probe read={() => Promise.resolve("a")} k={1} />);
    await h.flush();
    expect(p().textContent).toBe("a");
    h.rerender(<Probe read={() => new Promise(() => {})} k={2} />);
    await h.flush();
    expect(p().textContent).toBe("");
    expect(p().dataset.loading).toBe("true");
  });

  it("with nothing to ask (a null read) it neither loads nor errors", async () => {
    h = mount(<Probe read={null} />);
    await h.flush();
    expect(p().dataset.loading).toBe("false");
    expect(p().dataset.unsupported).toBe("false");
  });
});
