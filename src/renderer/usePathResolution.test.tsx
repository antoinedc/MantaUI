// @vitest-environment jsdom
//
// Path-link resolution: debounce / chunk / concurrency, the (session, cwd, path)
// cache, stale replies, and re-resolution after file-changing tools.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, mount, type Harness } from "./testHarness";
import { usePathResolution, resetPathResolution, RESOLVE_DEBOUNCE_MS } from "./usePathResolution";
import { bumpAllFileGenerations, bumpFileGeneration } from "./explorer/fileChanges";
import type { ExplorerOwner } from "./explorer/types";
import type { FsResolveInput, FsResolved } from "../shared/fsTypes";

const ok = (input: string, abs = `/home/u/${input}`): FsResolved => ({
  input,
  ok: true,
  abs,
  kind: "file",
  size: 1,
  mtimeMs: 1,
});
const missing = (input: string): FsResolved => ({ input, ok: false, reason: "missing" });

type Call = { input: FsResolveInput; resolve: (r: FsResolved[]) => void };

function Probe({ owner, paths }: { owner: ExplorerOwner | null; paths: string[] }) {
  const find = usePathResolution(owner, paths);
  return <span data-testid="out">{paths.map((p) => find(p)?.abs ?? "-").join(",")}</span>;
}

describe("usePathResolution", () => {
  let h: Harness | null = null;
  let calls: Call[];
  let sid = 0;
  let A: ExplorerOwner;
  let B: ExplorerOwner;

  const install = (auto?: (input: FsResolveInput) => FsResolved[]) => {
    calls = [];
    installMockApi({
      fsResolvePaths: (input: FsResolveInput) =>
        new Promise((resolve) => {
          const call: Call = { input, resolve: (results) => resolve({ results }) };
          calls.push(call);
          if (auto) call.resolve(auto(input));
        }),
    });
  };
  const out = () => h!.container.querySelector('[data-testid="out"]')!.textContent;
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const settle = () => advance(0);

  beforeEach(() => {
    vi.useFakeTimers();
    resetPathResolution();
    sid += 1;
    A = { sessionId: `ses_a${sid}`, cwd: "/home/u/proj" };
    B = { sessionId: `ses_b${sid}`, cwd: "/home/u/proj" };
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
  });

  it("waits out the 150 ms debounce, then sends ONE request for everything asked meanwhile", async () => {
    install((i) => i.paths.map((p) => ok(p)));
    h = mount(
      <>
        <Probe owner={A} paths={["src/a.ts"]} />
        <Probe owner={A} paths={["src/b.ts", "src/a.ts"]} />
      </>,
    );
    await advance(RESOLVE_DEBOUNCE_MS - 1);
    expect(calls).toHaveLength(0);
    await advance(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.base).toBe("/home/u/proj");
    expect([...calls[0].input.paths].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("restarts the debounce when more candidates arrive", async () => {
    install((i) => i.paths.map((p) => ok(p)));
    h = mount(<Probe owner={A} paths={["src/a.ts"]} />);
    await advance(100);
    h.rerender(<Probe owner={A} paths={["src/a.ts", "src/b.ts"]} />);
    await advance(100);
    expect(calls).toHaveLength(0);
    await advance(50);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("renders a link target only after the box confirms, and shows nothing for a miss", async () => {
    install((i) => i.paths.map((p) => (p === "src/a.ts" ? ok(p) : missing(p))));
    h = mount(<Probe owner={A} paths={["src/a.ts", "src/nope.ts"]} />);
    expect(out()).toBe("-,-");
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    expect(out()).toBe("/home/u/src/a.ts,-");
  });

  it("chunks at 200 paths and keeps at most 2 requests in flight per session", async () => {
    install();
    const paths = Array.from({ length: 450 }, (_, i) => `d/f${i}.ts`);
    h = mount(<Probe owner={A} paths={paths} />);
    await advance(RESOLVE_DEBOUNCE_MS);
    expect(calls.map((c) => c.input.paths.length)).toEqual([200, 200]);
    // A slot frees up → the remainder goes out without another debounce.
    await act(async () => calls[0].resolve(calls[0].input.paths.map((p) => ok(p))));
    await settle();
    expect(calls.map((c) => c.input.paths.length)).toEqual([200, 200, 50]);
    expect(Math.max(...calls.map((c) => c.input.paths.length))).toBeLessThanOrEqual(200);
  });

  it("serves a repeat from the cache instead of asking again", async () => {
    install((i) => i.paths.map((p) => ok(p)));
    h = mount(<Probe owner={A} paths={["src/a.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    h.rerender(
      <>
        <Probe owner={A} paths={["src/a.ts"]} />
        <Probe owner={A} paths={["src/a.ts"]} />
      </>,
    );
    await advance(RESOLVE_DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(1);
    expect(h.container.textContent).toBe("/home/u/src/a.ts/home/u/src/a.ts");
  });

  it("keys the cache by session: another session asks for itself", async () => {
    install((i) => i.paths.map((p) => ok(p)));
    h = mount(<Probe owner={A} paths={["src/a.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    h.rerender(<Probe owner={B} paths={["src/a.ts"]} />);
    expect(out()).toBe("-");
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    expect(calls).toHaveLength(2);
    expect(out()).toBe("/home/u/src/a.ts");
  });

  it("discards a stale reply after switching to another session", async () => {
    install();
    h = mount(<Probe owner={A} paths={["src/a.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    h.rerender(<Probe owner={B} paths={["src/a.ts"]} />);
    // A's reply lands now: B must not show it.
    await act(async () => calls[0].resolve([ok("src/a.ts", "/home/u/from-a")]));
    await settle();
    expect(out()).toBe("-");
    await advance(RESOLVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
    await act(async () => calls[1].resolve([ok("src/a.ts", "/home/u/from-b")]));
    await settle();
    expect(out()).toBe("/home/u/from-b");
  });

  it("discards a reply that lands after the file generation moved on, then re-asks", async () => {
    install();
    h = mount(<Probe owner={A} paths={["src/a.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    act(() => bumpFileGeneration(A.sessionId));
    await act(async () => calls[0].resolve([ok("src/a.ts", "/home/u/old")]));
    await settle();
    expect(out()).toBe("-");
    await advance(RESOLVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
    await act(async () => calls[1].resolve([ok("src/a.ts", "/home/u/new")]));
    await settle();
    expect(out()).toBe("/home/u/new");
  });

  it("missing → created: an edit tool finishing makes the path a link", async () => {
    let exists = false;
    install((i) => i.paths.map((p) => (exists ? ok(p) : missing(p))));
    h = mount(<Probe owner={A} paths={["src/new.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    expect(out()).toBe("-");
    exists = true;
    act(() => bumpFileGeneration(A.sessionId));
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    expect(calls).toHaveLength(2);
    expect(out()).toBe("/home/u/src/new.ts");
  });

  it("deleted → unlinked: the link stays until the fresh answer, then goes", async () => {
    let exists = true;
    install((i) => i.paths.map((p) => (exists ? ok(p) : missing(p))));
    h = mount(<Probe owner={A} paths={["src/a.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    expect(out()).toBe("/home/u/src/a.ts");
    exists = false;
    act(() => bumpFileGeneration(A.sessionId));
    expect(out()).toBe("/home/u/src/a.ts"); // stale, still shown while re-asking
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    expect(out()).toBe("-");
  });

  it("a resync re-resolves every session", async () => {
    install((i) => i.paths.map((p) => ok(p)));
    h = mount(<Probe owner={B} paths={["src/a.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    act(() => bumpAllFileGenerations());
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("another session's tool activity does not invalidate this one", async () => {
    install((i) => i.paths.map((p) => ok(p)));
    h = mount(<Probe owner={A} paths={["src/a.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    act(() => bumpFileGeneration(B.sessionId));
    await advance(RESOLVE_DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(1);
  });

  it("asks nothing without an owner", async () => {
    install();
    h = mount(<Probe owner={null} paths={["src/a.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(0);
    expect(out()).toBe("-");
  });

  it("a box that cannot resolve (no channel / failure) leaves everything unlinked", async () => {
    installMockApi({}, { absent: ["fsResolvePaths"] });
    h = mount(<Probe owner={A} paths={["src/a.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS * 2);
    expect(out()).toBe("-");
    h.unmount();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installMockApi({ fsResolvePaths: () => Promise.reject(new Error("boom")) });
    h = mount(<Probe owner={B} paths={["src/a.ts"]} />);
    await advance(RESOLVE_DEBOUNCE_MS);
    await settle();
    expect(out()).toBe("-");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
