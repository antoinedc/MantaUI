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

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OpencodeEvent } from "../shared/types";
import { useStore } from "./store";

// React 18's `act` warns unless this global is set. jsdom test env only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A subscriber registered via the mocked `window.api.onOpencodeEvent`.
type EventListener = (ev: OpencodeEvent) => void;

// The controllable SSE bus the harness hands back so a test can push events
// exactly as the main process would broadcast them.
export type MockEventBus = {
  emit: (ev: OpencodeEvent) => void;
  listenerCount: () => number;
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
    opencodeOpenStream: () => Promise.resolve(),
    opencodeCloseStream: () => Promise.resolve(),
    opencodeMessages: () => Promise.resolve([]),
    opencodeMessagesCached: () => Promise.resolve(null),
    opencodeMessagesReconcile: () => Promise.resolve([]),
    opencodeModels: () => Promise.resolve([]),
    opencodeDefaultModel: () => Promise.resolve(null),
    opencodeVcsBranch: () => Promise.resolve(null),
    opencodeRefreshCredentials: () => Promise.resolve({ ok: false, reason: "failed" }),
    opencodeCommands: () => Promise.resolve([]),
    opencodeAgents: () => Promise.resolve([]),
    opencodeFindFiles: () => Promise.resolve([]),
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
    // Voice / files — component may probe these on mount.
    getPathForFile: () => "",
    clipboardReadImage: () => Promise.resolve(null),
  };
}

// Shared listener set — a single bus per harness instance is enough for our
// tests (they mount one ChatPanel). Recreated by installMockApi.
let busListeners = new Set<EventListener>();

// Install a mock `window.api` onto the jsdom window and return the bus +
// recorder. `overrides` lets a test supply a specific resolved value or a
// spy for any method.
export function installMockApi(
  overrides: Record<string, unknown> = {},
): { api: MockApi; bus: MockEventBus } {
  busListeners = new Set<EventListener>();
  const calls: Record<string, unknown[][]> = {};

  const bus: MockEventBus = {
    emit: (ev) => {
      // Copy so a listener that unsubscribes mid-emit doesn't mutate the set
      // we're iterating.
      for (const fn of Array.from(busListeners)) fn(ev);
    },
    listenerCount: () => busListeners.size,
  };

  const impl = { ...defaultApiImpl(), ...overrides };

  const target: MockApi = { calls };
  const proxy = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "calls") return calls;
      const provided = impl[prop];
      // Record + delegate to the provided impl if any; otherwise a
      // resolved-undefined no-op so unhandled fire-and-forget calls are safe.
      return (...args: unknown[]) => {
        (calls[prop] ??= []).push(args);
        if (typeof provided === "function") {
          return (provided as (...a: unknown[]) => unknown)(...args);
        }
        if (provided !== undefined) return provided;
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
      screenshotToast: null,
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
};

export function mount(el: React.ReactElement): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
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
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
    flush,
    html: () => container.innerHTML,
    text: () => container.textContent ?? "",
  };
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
