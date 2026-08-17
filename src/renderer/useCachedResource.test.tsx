// @vitest-environment jsdom
//
// Tests for useCachedResource (BET-1057) — the shared "fetch on mount into a
// nullable state" hook behind Settings' five fetch pairs. The cache is a
// process-lifetime module-level Map, so these tests use unique keys per test
// and never assume cache state carries across cases.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { useCachedResource, invalidateCachedResource } from "./useCachedResource";

function Probe({
  resourceKey,
  fetcher,
}: {
  resourceKey: string;
  fetcher: () => Promise<number>;
}) {
  const { data, loading, error, refresh, mutate } = useCachedResource<number>(resourceKey, fetcher);
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="data">{data === null ? "null" : String(data)}</span>
      <span data-testid="error">{error ?? ""}</span>
      <button data-testid="refresh" onClick={() => void refresh()}>
        refresh
      </button>
      <button data-testid="mutate-fail" onClick={() => void mutate(async () => { throw new Error("nope"); })}>
        mutate fail
      </button>
      <button data-testid="mutate-ok" onClick={() => void mutate(async () => {})}>
        mutate ok
      </button>
    </div>
  );
}

describe("useCachedResource", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const loadState = () => ({
    loading: document.body.querySelector('[data-testid="loading"]')?.textContent,
    data: document.body.querySelector('[data-testid="data"]')?.textContent,
    error: document.body.querySelector('[data-testid="error"]')?.textContent ?? "",
  });

  it("cold start: shows loading, then the data once the fetch resolves", async () => {
    h = mount(<Probe resourceKey="cold-start" fetcher={async () => 42} />);
    // Cold start (no cached value) → loading true, no data yet.
    expect(loadState()).toEqual({ loading: "true", data: "null", error: "" });
    await h.flush();
    expect(loadState()).toEqual({ loading: "false", data: "42", error: "" });
  });

  it("second mount with a warm cache: data immediately, loading false, revalidates in the background", async () => {
    // Prime the cache for this key.
    h = mount(<Probe resourceKey="warm" fetcher={async () => 42} />);
    await h.flush();
    h.unmount();
    h = null;
    // Remount with a fetcher that resolves to a NEW value.
    h = mount(<Probe resourceKey="warm" fetcher={async () => 999} />);
    // Warm cache renders cached data immediately with loading false.
    expect(loadState()).toEqual({ loading: "false", data: "42", error: "" });
    // Background revalidation swaps in the fresh value without flashing
    // loading.
    await h.flush();
    expect(loadState()).toEqual({ loading: "false", data: "999", error: "" });
  });

  it("a rejection sets error and preserves previously-cached data", async () => {
    h = mount(<Probe resourceKey="reject-keep" fetcher={async () => 42} />);
    await h.flush();
    h.unmount();
    h = null;
    // Next mount's fetch rejects — the cached 42 stays on screen.
    h = mount(
      <Probe
        resourceKey="reject-keep"
        fetcher={async () => {
          throw new Error("boom");
        }}
      />,
    );
    await h.flush();
    expect(loadState()).toEqual({ loading: "false", data: "42", error: "boom" });
  });

  it("refresh updates the cache without flipping loading", async () => {
    h = mount(<Probe resourceKey="refresh" fetcher={async () => 42} />);
    await h.flush();
    expect(loadState().loading).toBe("false");
    // Re-point the fetcher (identity change must not refetch) and call
    // refresh() — data updates, loading stays false.
    h.rerender(<Probe resourceKey="refresh" fetcher={async () => 7} />);
    act(() => {
      document.body.querySelector('[data-testid="refresh"]')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await h.flush();
    expect(loadState()).toEqual({ loading: "false", data: "7", error: "" });
  });

  it("invalidateCachedResource forces the next mount back to a cold start", async () => {
    h = mount(<Probe resourceKey="invalidate" fetcher={async () => 42} />);
    await h.flush();
    h.unmount();
    h = null;
    invalidateCachedResource("invalidate");
    h = mount(<Probe resourceKey="invalidate" fetcher={async () => 42} />);
    expect(loadState()).toEqual({ loading: "true", data: "null", error: "" });
    await h.flush();
    expect(loadState()).toEqual({ loading: "false", data: "42", error: "" });
  });

  it("mutate failure sets error and leaves cached data alone", async () => {
    h = mount(<Probe resourceKey="mutate-fail" fetcher={async () => 42} />);
    await h.flush();
    expect(loadState()).toEqual({ loading: "false", data: "42", error: "" });
    act(() => {
      document.body.querySelector('[data-testid="mutate-fail"]')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await h.flush();
    // Error surfaces, cached data untouched, loading never flips.
    expect(loadState()).toEqual({ loading: "false", data: "42", error: "nope" });
  });

  it("mutate success clears a previous error", async () => {
    h = mount(<Probe resourceKey="mutate-ok" fetcher={async () => 42} />);
    await h.flush();
    // Set an error first via a failing mutate.
    act(() => {
      document.body.querySelector('[data-testid="mutate-fail"]')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await h.flush();
    expect(loadState().error).toBe("nope");
    // A succeeding mutate clears it, data unchanged.
    act(() => {
      document.body.querySelector('[data-testid="mutate-ok"]')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await h.flush();
    expect(loadState()).toEqual({ loading: "false", data: "42", error: "" });
  });
});
