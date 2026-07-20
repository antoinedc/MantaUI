import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createLogShipper,
  captureConsole,
  formatConsoleArgs,
  resolveAxiomConfig,
} from "./logShip.mjs";

// ----- tiny test fakes -----
// We don't depend on real timers or real network in unit tests. Each
// createLogShipper call below wires its own fetch / clock / setInterval.

type FetchResult = { ok: boolean; status: number };
type FetchFn = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResult>;

function makeFetch(behavior: "ok" | "bad" | "throw"): FetchFn {
  return vi.fn(async () => {
    if (behavior === "ok") return { ok: true, status: 200 };
    if (behavior === "bad") return { ok: false, status: 500 };
    throw new Error("network down");
  }) as unknown as FetchFn;
}

function mockCalls(fn: FetchFn): [string, { method?: string; headers?: Record<string, string>; body?: string }][] {
  return (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, { method?: string; headers?: Record<string, string>; body?: string }][];
}

function bodyOf(call: [string, { body?: string }]): unknown[] {
  return JSON.parse(call[1].body ?? "[]");
}

function makeShipper(opts: { fetchFn?: FetchFn; maxBatch?: number; maxBuffer?: number } = {}) {
  const fetchFn: FetchFn = opts.fetchFn ?? makeFetch("ok");
  const clock = { nowVal: 0 };
  const now = () => clock.nowVal;
  const setIntervalFn = (cb: () => void, ms: number) => {
    return { cb, ms, cleared: false };
  };
  const shipper = createLogShipper({
    endpoint: "https://api.axiom.co/v1/datasets/test/ingest",
    token: "tk_test",
    source: "server",
    device: "host",
    fetchFn,
    now,
    setIntervalFn,
    maxBatch: opts.maxBatch,
    maxBuffer: opts.maxBuffer,
  });
  return { shipper, fetchFn, clock };
}

describe("resolveAxiomConfig", () => {
  it("returns null when no token is configured anywhere", () => {
    expect(resolveAxiomConfig({ env: {}, config: null })).toBeNull();
    expect(resolveAxiomConfig({ env: {}, config: { axiomDataset: "x" } })).toBeNull();
    expect(resolveAxiomConfig({ env: {}, config: {} })).toBeNull();
  });
  it("uses token from config when env is empty", () => {
    const r = resolveAxiomConfig({ env: {}, config: { axiomToken: "abc", axiomDataset: "alt" } });
    expect(r).toEqual({
      endpoint: "https://api.axiom.co/v1/datasets/alt/ingest",
      token: "abc",
    });
  });
  it("env wins over config", () => {
    const r = resolveAxiomConfig({
      env: { MANTA_AXIOM_TOKEN: "envtok", MANTA_AXIOM_DATASET: "envds" },
      config: { axiomToken: "ctok", axiomDataset: "cds" },
    });
    expect(r?.token).toBe("envtok");
    expect(r?.endpoint).toBe("https://api.axiom.co/v1/datasets/envds/ingest");
  });
  it("dataset defaults to 'manta'", () => {
    const r = resolveAxiomConfig({ env: {}, config: { axiomToken: "x" } });
    expect(r?.endpoint).toBe("https://api.axiom.co/v1/datasets/manta/ingest");
  });
});

describe("formatConsoleArgs", () => {
  it("passes strings through as-is and joins with a space", () => {
    expect(formatConsoleArgs(["hello", "world"])).toBe("hello world");
  });
  it("stringifies numbers / booleans / null", () => {
    expect(formatConsoleArgs(["x=", 42, true, null])).toBe("x= 42 true null");
  });
  it("JSON-stringifies plain objects", () => {
    expect(formatConsoleArgs(["a", { b: 1 }])).toBe('a {"b":1}');
  });
  it("uses Error.stack when available", () => {
    const e = new Error("boom");
    expect(formatConsoleArgs([e])).toBe(e.stack);
  });
  it("falls back to String(err) when Error has no stack", () => {
    const e = new Error("no stack");
    e.stack = undefined;
    expect(formatConsoleArgs([e])).toBe("Error: no stack");
  });
  it("falls back to String(x) when JSON.stringify throws (circular)", () => {
    const obj: { toString: () => string; self?: unknown } = { toString: () => "circ-tag" };
    obj.self = obj;
    expect(() => formatConsoleArgs([obj])).not.toThrow();
    expect(formatConsoleArgs([obj])).toContain("circ-tag");
  });
  it("truncates the joined string to 4000 chars", () => {
    const big = "x".repeat(8000);
    expect(formatConsoleArgs([big]).length).toBe(4000);
  });
});

describe("createLogShipper", () => {
  it("log() pushes an event with correct _time, source, device, level, truncated msg + spread fields", async () => {
    const { shipper, clock, fetchFn } = makeShipper({ fetchFn: makeFetch("bad") });
    clock.nowVal = 1700000000000;
    shipper.log("info", "hello world", { state: "open", n: 7 });
    await shipper.flush();
    const calls = mockCalls(fetchFn);
    expect(calls).toHaveLength(1);
    const body = bodyOf(calls[0]!);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      _time: "2023-11-14T22:13:20.000Z",
      source: "server",
      device: "host",
      level: "info",
      msg: "hello world",
      state: "open",
      n: 7,
    });
    shipper.stop();
  });

  it("truncates msg to 4000 chars", async () => {
    const { shipper, fetchFn } = makeShipper();
    shipper.log("info", "x".repeat(8000));
    await shipper.flush();
    const body = bodyOf(mockCalls(fetchFn)[0]!);
    expect((body[0] as { msg: string }).msg.length).toBe(4000);
    shipper.stop();
  });

  it("reaching maxBatch triggers an immediate flush", async () => {
    const { shipper, fetchFn } = makeShipper({ maxBatch: 3, maxBuffer: 10 });
    shipper.log("info", "1");
    shipper.log("info", "2");
    shipper.log("info", "3"); // hits maxBatch → flush
    await new Promise((r) => setTimeout(r, 0));
    const calls = mockCalls(fetchFn);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]!)).toHaveLength(3);
    shipper.stop();
  });

  it("sends Authorization Bearer header + correct endpoint", async () => {
    const { shipper, fetchFn } = makeShipper({ fetchFn: makeFetch("bad") });
    shipper.log("info", "x");
    await shipper.flush();
    const [url, init] = mockCalls(fetchFn)[0]!;
    expect(url).toBe("https://api.axiom.co/v1/datasets/test/ingest");
    expect(init.method).toBe("POST");
    expect(init.headers?.authorization).toBe("Bearer tk_test");
    expect(init.headers?.["content-type"]).toBe("application/json");
    shipper.stop();
  });

  it("flush() with empty buffer does NOT call fetchFn", async () => {
    const { shipper, fetchFn } = makeShipper();
    await shipper.flush();
    expect(mockCalls(fetchFn)).toHaveLength(0);
    shipper.stop();
  });

  it("second flush() while first's promise is unresolved → only one fetchFn call", async () => {
    let resolveFetch!: () => void;
    const slowFetch: FetchFn = vi.fn(
      () => new Promise<FetchResult>((r) => { resolveFetch = () => r({ ok: true, status: 200 }); }),
    ) as unknown as FetchFn;
    const { shipper } = makeShipper({ fetchFn: slowFetch });
    shipper.log("info", "x");
    const p1 = shipper.flush();
    const p2 = shipper.flush();
    expect(mockCalls(slowFetch)).toHaveLength(1);
    resolveFetch();
    await p1;
    await p2;
    shipper.stop();
  });

  it("failed flush retains events in the buffer and does not throw", async () => {
    const { shipper } = makeShipper({ fetchFn: makeFetch("throw"), maxBuffer: 50 });
    shipper.log("info", "kept");
    await shipper.flush();
    expect(shipper.pending()).toBe(1);
    shipper.stop();
  });

  it("non-2xx response also re-prepends events", async () => {
    const { shipper } = makeShipper({ fetchFn: makeFetch("bad"), maxBuffer: 50 });
    shipper.log("info", "kept");
    await shipper.flush();
    expect(shipper.pending()).toBe(1);
    shipper.stop();
  });

  it("failed flush with buffer over maxBuffer drops oldest; next successful flush emits a 'logship dropped events' warn with the right count", async () => {
    // vi.fn() returns a Mock that chains mockImplementationOnce /
    // mockImplementation. We need the cast to remain a Mock so we can
    // attach both. fetchFn in the shipper is typed as a plain FetchFn
    // (no mock surface), so we widen with `unknown`.
    const fetchWithSwitch = vi.fn();
    fetchWithSwitch.mockImplementationOnce(async () => { throw new Error("net"); });
    fetchWithSwitch.mockImplementation(async () => ({ ok: true, status: 200 }));
    const fetchFn = fetchWithSwitch as unknown as FetchFn;
    const { shipper } = makeShipper({ fetchFn, maxBuffer: 3, maxBatch: 100 });
    shipper.log("info", "a");
    shipper.log("info", "b");
    shipper.log("info", "c");
    shipper.log("info", "d");
    shipper.log("info", "e");
    // Flush #1 fails — re-prepends 5 events, maxBuffer=3 drops 2 oldest.
    await shipper.flush();
    expect(shipper.pending()).toBe(3);
    // Flush #2 succeeds, drops the droppedCount into a synthetic warn
    // event which lands in the buffer (NOT in this flush's body).
    await shipper.flush();
    expect(shipper.pending()).toBe(1);
    // Flush #3 ships the synthetic warn event.
    await shipper.flush();
    expect(shipper.pending()).toBe(0);
    const body = bodyOf(mockCalls(fetchFn)[2]!);
    const dropped = (body as Array<{ msg: string; level?: string; dropped?: number }>)
      .find((e) => e.msg === "logship dropped events");
    expect(dropped).toBeTruthy();
    expect(dropped!.level).toBe("warn");
    expect(dropped!.dropped).toBe(2);
    shipper.stop();
  });

  it("first-flush failure emits exactly one warning via the ORIGINAL console.warn (not the wrapped one)", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
    try {
      const { shipper } = makeShipper({ fetchFn: makeFetch("throw"), maxBuffer: 10 });
      shipper.log("info", "x");
      await shipper.flush();
      shipper.log("info", "y");
      await shipper.flush();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("logship");
      shipper.stop();
    } finally {
      console.warn = orig;
    }
  });

  it("stop() fires one last flush (the queued event reaches the network) without throwing", async () => {
    const { shipper, fetchFn } = makeShipper();
    shipper.log("info", "before-stop");
    shipper.stop();
    await new Promise((r) => setTimeout(r, 0));
    const calls = mockCalls(fetchFn);
    expect(calls).toHaveLength(1);
    const body = bodyOf(calls[0]!) as Array<{ msg: string }>;
    expect(body.map((e) => e.msg)).toContain("before-stop");
    shipper.log("info", "after-stop");
    await new Promise((r) => setTimeout(r, 0));
    expect(mockCalls(fetchFn)).toHaveLength(1);
  });
});

describe("captureConsole", () => {
  let origLog: typeof console.log;
  let origWarn: typeof console.warn;
  let origError: typeof console.error;

  beforeEach(() => {
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
  });

  afterEach(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    delete (console.log as unknown as { __logshipWrapped?: boolean }).__logshipWrapped;
    delete (console.warn as unknown as { __logshipWrapped?: boolean }).__logshipWrapped;
    delete (console.error as unknown as { __logshipWrapped?: boolean }).__logshipWrapped;
  });

  it("wraps console.log so the original still runs AND shipper.log('info', ...) is called", () => {
    const orig = console.log;
    const seen: { level: string; msg: string }[] = [];
    const shipper = {
      log: (level: string, msg: string) => seen.push({ level, msg }),
    };
    const restore = captureConsole(shipper);
    console.log("a", { b: 1 });
    expect(seen).toEqual([{ level: "info", msg: 'a {"b":1}' }]);
    restore();
    expect(console.log).toBe(orig);
  });

  it("maps console.warn → warn, console.error → error", () => {
    const seen: { level: string; msg: string }[] = [];
    const shipper = {
      log: (level: string, msg: string) => seen.push({ level, msg }),
    };
    const restore = captureConsole(shipper);
    console.warn("be careful");
    console.error("kaboom");
    restore();
    expect(seen).toEqual([
      { level: "warn", msg: "be careful" },
      { level: "error", msg: "kaboom" },
    ]);
  });

  it("double-wrapping is a no-op (returns a no-op restore)", () => {
    const first: string[] = [];
    const second: string[] = [];
    const s1 = { log: (_l: string, m: string) => first.push(m) };
    const s2 = { log: (_l: string, m: string) => second.push(m) };
    const r1 = captureConsole(s1);
    const r2 = captureConsole(s2);
    console.log("ping");
    r1();
    r2();
    expect(first).toEqual(["ping"]);
    expect(second).toEqual([]);
  });

  it("restore() unwraps all three methods", () => {
    const shipper = { log: () => {} };
    const restore = captureConsole(shipper);
    expect((console.log as unknown as { __logshipWrapped?: boolean }).__logshipWrapped).toBe(true);
    expect((console.warn as unknown as { __logshipWrapped?: boolean }).__logshipWrapped).toBe(true);
    expect((console.error as unknown as { __logshipWrapped?: boolean }).__logshipWrapped).toBe(true);
    restore();
    expect((console.log as unknown as { __logshipWrapped?: boolean }).__logshipWrapped).toBeUndefined();
    expect((console.warn as unknown as { __logshipWrapped?: boolean }).__logshipWrapped).toBeUndefined();
    expect((console.error as unknown as { __logshipWrapped?: boolean }).__logshipWrapped).toBeUndefined();
    expect(console.log).toBe(origLog);
  });

  it("wrap-side-effect: a throw inside shipper.log does NOT break the original console call", () => {
    const shipper = {
      log: () => { throw new Error("ship broke"); },
    };
    const restore = captureConsole(shipper);
    let ran = false;
    const realLog = console.log;
    console.log = () => { ran = true; };
    console.log("hi");
    console.log = realLog;
    expect(ran).toBe(true);
    restore();
  });
});
