// ===== ChatPanel render harness =====
//
// A test utility that mounts real renderer components (ChatPanel, Transcript,
// Composer, hooks) in a jsdom DOM with a mocked `window.api`, a mocked SSE
// event bus, and the real zustand store reset to a known baseline.
//
// WHY this exists (BET-63 step 1): ChatPanel is a ~4k-LoC container of
// interwoven effects/refs sharing closure state (SSE bus, pin-to-bottom,
// message/queue, voice, typeahead). Decomposing it (extracting Transcript /
// Composer / hooks) is the top regression risk flagged by BET-47. Without a
// way to actually MOUNT the component and drive events, that refactor is
// blind. This harness is the safety net: it lets a test render <ChatPanel>,
// push fake opencode events through the same `onOpencodeEvent` path the main
// process uses, and assert on the resulting DOM — no Electron, no live tmux.
//
// It is deliberately dependency-light: it uses `react-dom/client` against
// jsdom directly rather than @testing-library, so the repo's test tooling
// stays minimal (only `jsdom` is added). Files that use this harness MUST
// declare the jsdom environment with a docblock at the top:
//
//     // @vitest-environment jsdom
//
// so the 700+ pure-logic vitest files keep running in the default (node)
// environment with zero DOM overhead.

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VirtuosoMockContext } from "react-virtuoso";
import type { OpencodeEvent, StreamEnvelope } from "../shared/types";
import { useStore } from "./store";
import { SessionHeader } from "./SessionHeader";

// React 18's `act` warns unless this global is set. jsdom test env only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// framer-motion mounts motion.div components in jsdom and probes browser APIs
// jsdom lacks. Without these shims a framer-motion render throws on mount.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
if (typeof window !== "undefined" && !window.matchMedia) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
}

// Opt-in jsdom stub for HTMLCanvasElement.prototype.getContext (@xterm's WebGL
// addon probes it at import time; jsdom throws). NOT applied at module scope:
// components branch on `if (!ctx) return;`, and a truthy ctx for every jsdom
// test would start an rAF draw loop. Call explicitly BEFORE the import.
export function installCanvasStub(): void {
  if (typeof HTMLCanvasElement === "undefined") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = function (this: any) {
    const noop = () => {};
    return {
      measureText: (text: unknown) => ({ width: String(text ?? "").length }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      canvas: this,
      getImageData: () => ({ data: new Uint8ClampedArray(0) }),
    } as unknown as CanvasRenderingContext2D;
  };
}

// A subscriber registered via the mocked `window.api.onOpencodeEvent`.
type EventListener = (ev: OpencodeEvent) => void;

// A subscriber registered via the mocked `window.api.onStreamEvent`.
type StreamListener = (ev: StreamEnvelope) => void;

// The controllable SSE bus the harness hands back so a test can push events
// exactly as the main process would broadcast them. `emit` drives the raw
// opencode listener; `emitStream` drives the box-interpreted stream listener
// (BET-551 / §17) with a `StreamEnvelope`.
export type MockEventBus = {
  emit: (ev: OpencodeEvent) => void;
  emitStream: (ev: StreamEnvelope) => void;
  listenerCount: () => number;
  streamListenerCount: () => number;
};

// A recording of the window.api calls a test may want to assert on. The mock
// api is a Proxy: any method not explicitly provided returns a resolved
// no-op so ChatPanel's many fire-and-forget calls don't throw.
export type MockApi = {
  calls: Record<string, unknown[][]>;
  // Explicit overrides for methods whose return value the component consumes.
  [k: string]: unknown;
};

// The defaults ChatPanel actually reads the resolved value of. Everything
// else falls through to the Proxy's resolved-undefined default.
function defaultApiImpl(): Record<string, unknown> {
  return {
    onOpencodeEvent: (fn: EventListener) => {
      busListeners.add(fn);
      return () => busListeners.delete(fn);
    },
    onStreamEvent: (fn: StreamListener) => {
      streamListeners.add(fn);
      return () => streamListeners.delete(fn);
    },
    opencodeOpenStream: () => Promise.resolve(),
    opencodeCloseStream: () => Promise.resolve(),
    opencodeMessages: () => Promise.resolve([]),
    opencodeModels: () => Promise.resolve([]),
    opencodeDefaultModel: () => Promise.resolve(null),
    opencodeVcsBranch: () => Promise.resolve(null),
    opencodeCommands: () => Promise.resolve([]),
    opencodeAgents: () => Promise.resolve([]),
    opencodeFindFiles: () => Promise.resolve([]),
    opencodeReferences: () => Promise.resolve([]),
    opencodeSetReferences: () => Promise.resolve({ ok: true }),
    opencodePrompt: () => Promise.resolve({ ok: true }),
    opencodeAbort: () => Promise.resolve(),
    scheduleList: () => Promise.resolve([]),
    scheduleDelete: () => Promise.resolve(),
    pushRegisterApns: () => Promise.resolve({ ok: true, count: 0 }),
    secretsList: () => Promise.resolve([]),
    secretsSet: () => Promise.resolve({ ok: true }),
    secretsDelete: () => Promise.resolve(),
    webhookList: () => Promise.resolve([]),
    webhookDelete: () => Promise.resolve(),
    progressGet: () => Promise.resolve(null),
    // Voice / files — component may probe these on mount.
    getPathForFile: () => "",
    clipboardReadImage: () => Promise.resolve(null),
    voiceListNotes: () => Promise.resolve([]),
    voiceFetchNote: () => Promise.resolve(new Blob()),
  };
}

// Shared listener set — a single bus per harness instance is enough for our
// tests (they mount one ChatPanel). Recreated by installMockApi.
let busListeners = new Set<EventListener>();
let streamListeners = new Set<StreamListener>();

// Install a mock `window.api` onto the jsdom window and return the bus +
// recorder. `overrides` lets a test supply a specific resolved value or a
// spy for any method.
//
// `absent` models the OTHER shape `window.api` really takes: on a fresh,
// unpaired desktop boot it is the preload OS-bridge SUBSET, where every
// httpApi-only method is `undefined`. The Proxy below answers every property
// with a function, so without this a test can never exercise a
// `if (!window.api.x)` guard — and the one time that mattered, an unguarded
// call threw from the commit phase and blanked the app on first launch.
// Listed props read back as `undefined`, exactly as the preload does.
export function installMockApi(
  overrides: Record<string, unknown> = {},
  { absent = [] as string[] }: { absent?: string[] } = {},
): { api: MockApi; bus: MockEventBus } {
  busListeners = new Set<EventListener>();
  streamListeners = new Set<StreamListener>();
  const calls: Record<string, unknown[][]> = {};

  const bus: MockEventBus = {
    emit: (ev) => {
      // Copy so a listener that unsubscribes mid-emit doesn't mutate the set
      // we're iterating.
      for (const fn of Array.from(busListeners)) fn(ev);
    },
    emitStream: (ev) => {
      for (const fn of Array.from(streamListeners)) fn(ev);
    },
    listenerCount: () => busListeners.size,
    streamListenerCount: () => streamListeners.size,
  };

  const impl = { ...defaultApiImpl(), ...overrides };
  const missing = new Set(absent);

  const target: MockApi = { calls };
  const proxy = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "calls") return calls;
      if (missing.has(prop)) return undefined;
      const provided = impl[prop];
      // Record + delegate to the provided impl if any; otherwise a
      // resolved-undefined no-op so unhandled fire-and-forget calls are safe.
      return (...args: unknown[]) => {
        (calls[prop] ??= []).push(args);
        if (typeof provided === "function") {
          return (provided as (...a: unknown[]) => unknown)(...args);
        }
        if (provided !== undefined) return provided;
        // `onX(cb)` subscriptions must synchronously return an unsubscribe fn
        // (components `return` it from a useEffect); covers current + future.
        if (/^on[A-Z]/.test(prop)) return () => {};
        return Promise.resolve(undefined);
      };
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).api = proxy;
  return { api: proxy, bus };
}

// Reset the zustand store to a deterministic baseline so a mount doesn't
// depend on leftover state from a prior test. Only the fields ChatPanel reads
// need sane values; the rest keep their store defaults.
export function resetStore(
  partial: Partial<ReturnType<typeof useStore.getState>> = {},
): void {
  act(() => {
    useStore.setState({
      chatAutoAllow: false,
      autoRenameSessions: false,
      defaultModel: null,
      cacheTtl: "1h",
      groqApiKey: "",
      pendingScreenshots: [],
      agentFileToast: null,
      ...partial,
    } as Partial<ReturnType<typeof useStore.getState>>);
  });
}

// Mount a React element into a fresh detached container and return a handle.
// `flush` runs microtasks + fake/real timers inside act() so effects settle.
export type Harness = {
  container: HTMLElement;
  root: Root;
  rerender: (el: React.ReactElement) => void;
  unmount: () => void;
  // Let queued microtasks (resolved promises from the mock api) and any
  // pending effects run, wrapped in act() to silence React warnings.
  flush: () => Promise<void>;
  html: () => string;
  text: () => string;
  /** Portal-aware query — Modal renders through a portal to document.body, so a
   *  dialog is NOT inside `container`. Use for anything rendered by <Modal>. */
  docQuery: <T extends Element = HTMLElement>(sel: string) => T | null;
  /** Portal-aware text — same reason as docQuery. */
  docText: () => string;
};

export type MountOptions = {
  // Rendering under React 18 StrictMode double-invokes effects (setup →
  // cleanup → setup) on mount. Harness code that depends on an effect
  // surviving that simulated remount opts in here, mirroring the production
  // app's <React.StrictMode> wrapper (main.tsx).
  strictMode?: boolean;
};

export function mount(el: React.ReactElement, opts: MountOptions = {}): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // jsdom has no real layout, so react-virtuoso would measure a 0-height
  // viewport and render no rows. VirtuosoMockContext (per Virtuoso's official
  // testing docs) lets the transcript render a deterministic subset of items
  // without a real scroll container. Inert for components that render no
  // Virtuoso.
  const wrap = (el: React.ReactElement) => (
    <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 60 }}>
      {opts.strictMode ? <StrictMode>{el}</StrictMode> : el}
    </VirtuosoMockContext.Provider>
  );
  act(() => {
    root.render(wrap(el));
  });
  const flush = async () => {
    await act(async () => {
      // Two macrotask hops drains the promise-chain fetches ChatPanel fires on
      // mount (cached → reconcile → models → branch), each `.then` scheduling
      // the next.
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
    });
  };
  return {
    container,
    root,
    rerender: (next) => act(() => root.render(wrap(next))),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
    flush,
    html: () => container.innerHTML,
    text: () => container.textContent ?? "",
    docQuery: (sel) => document.body.querySelector(sel),
    docText: () => document.body.textContent ?? "",
  };
}

// Click a Checkbox the way a user does: on the visible box, not the sr-only
// input. The M527 Checkbox primitive renders a real `<input type="checkbox">`
// as `sr-only` (1px, clipped, invisible) inside a `<label>` next to a styled
// `span[aria-hidden]` box. A user clicks that box, and the real browser path is
// label-activation → the input's click — exactly where checkbox defects live.
// Driving the hidden input directly exercises a path no user can reach, so it
// reports green on a control nobody could operate (BET-1199).
//
// Locates the input by its accessible name (container first, then
// document.body for controls rendered through a Modal portal), climbs to the
// wrapping `<label>`, and dispatches a bubbling, cancelable click on the
// visible box inside act(). Throws if any step fails so a renamed ariaLabel
// fails loudly instead of silently doing nothing.
export function clickCheckbox(h: Harness, ariaLabel: string): void {
  const sel = `input[aria-label="${ariaLabel}"]`;
  const input =
    h.container.querySelector<HTMLElement>(sel) ?? h.docQuery<HTMLElement>(sel);
  if (!input) {
    throw new Error(
      `clickCheckbox: no checkbox with aria-label "${ariaLabel}" found`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (input.getAttribute("type") !== "checkbox") {
    throw new Error(
      `clickCheckbox: input "${ariaLabel}" is type "${input.getAttribute("type") ?? "?"}", not a checkbox`,
    );
  }
  const label = input.closest("label");
  if (!label) {
    throw new Error(`clickCheckbox: checkbox "${ariaLabel}" is not inside a <label>`);
  }
  const box = label.querySelector<HTMLElement>('span[aria-hidden="true"]');
  if (!box) {
    throw new Error(`clickCheckbox: checkbox "${ariaLabel}" has no visible box`);
  }
  act(() => {
    box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

// Convenience: emit an event through the bus and flush.
export async function emitAndFlush(
  bus: MockEventBus,
  h: Harness,
  ev: OpencodeEvent,
): Promise<void> {
  act(() => bus.emit(ev));
  await h.flush();
}

// Convenience: emit a box-interpreted stream event through the stream bus and
// flush (BET-551 / §17).
export async function emitStreamAndFlush(
  bus: MockEventBus,
  h: Harness,
  ev: StreamEnvelope,
): Promise<void> {
  act(() => bus.emitStream(ev));
  await h.flush();
}

// ===== SessionHeader mount helper =====
//
// SessionHeader takes ~14 props, nearly all of which are inert scaffolding for
// any given assertion — a test that cares about the ⋯ menu's hover fill still
// has to name onFork/onCompact/onClear/onDelete/breadcrumb/mode/... to satisfy
// the type. Two separate suites (IconButton, MenuItem) hand-rolled the same
// `renderHeader()` and differed only in the context numbers, which the
// duplication gate correctly flagged as a clone.
//
// `overrides` is the escape hatch: pass only what the assertion is ABOUT. The
// default is the quiet case — no branch, no context (totalInput 0 hides the
// context pill so its trigger doesn't join a button count), session present so
// the ⋯ menu renders.
export function mountSessionHeader(
  overrides: Partial<React.ComponentProps<typeof SessionHeader>> = {},
): Harness {
  return mount(
    <SessionHeader
      branch={null}
      ctxBreakdown={{
        freshInput: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalInput: 0,
        pct: 0,
        hasLimit: true,
        segments: [],
      }}
      ctxLimit={0}
      staleCache={{ isStale: false, idleMs: 0, staleTokens: 0, ttlMs: 0 }}
      modelName={null}
      hasSession
      onFork={() => {}}
      onCompact={() => {}}
      onClear={() => {}}
      onDelete={() => {}}
      breadcrumb={null}
      mode="chat"
      onModeChange={() => {}}
      {...overrides}
    />,
  );
}
