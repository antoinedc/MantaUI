// @vitest-environment jsdom
//
// Regression tests for the GitHub device-connect poll loop (BET-940).
//
// The defect this pins: CloneFromGitHub's connect phase polled on a FIXED 5s
// `setInterval` armed once, so when GitHub's `slow_down` lengthened the
// required gap the renderer assigned the new interval to a variable that was
// never read again — the loop could never catch up and the screen hung. On
// top of that, an immediate `poll()` on effect setup tripped `slow_down`
// instantly (doubly so under StrictMode's double-invoked effects).
//
// ConnectGithubPanel fixes all of it: one self-rescheduling timeout chain that
// re-reads the interval from every response, no immediate first poll, and a
// three-consecutive-error budget that stops the loop and renders the
// "couldn't sign in" panel.

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectGithubPanel } from "./ConnectGithub";
import { installMockApi } from "./testHarness";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const GRANT = {
  grantId: "grant-1",
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresIn: 900,
  pollInterval: 5,
};

let container: HTMLElement | null = null;
let root: Root | null = null;

function mountPanel(opts: {
  poll: (...args: unknown[]) => unknown;
  onConnected?: () => void;
  onCancel?: () => void;
  start?: () => Promise<unknown>;
}): void {
  installMockApi({
    forgeDeviceStart: opts.start ?? (() => Promise.resolve({ connected: false, grant: GRANT, error: null })),
    forgeDevicePoll: opts.poll,
    clipboardWriteText: () => Promise.resolve(),
    forgeDeviceCancel: () => Promise.resolve({ ok: true }),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <ConnectGithubPanel
        onConnected={opts.onConnected ?? (() => {})}
        onCancel={opts.onCancel ?? (() => {})}
      />,
    );
  });
}

async function flushMicro(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function unmountPanel(): void {
  act(() => {
    root?.unmount();
  });
  root = null;
  if (container) {
    container.remove();
    container = null;
  }
}

function text(): string {
  return container?.textContent ?? "";
}

afterEach(() => {
  unmountPanel();
  vi.useRealTimers();
});

describe("ConnectGithubPanel poll loop", () => {
  it("does not poll before the first interval elapses (regression: immediate poll)", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ status: "pending", pollInterval: 5 });
    mountPanel({ poll });
    await flushMicro();

    expect(poll).not.toHaveBeenCalled();
    // Before the first 5s interval: still nothing.
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(poll).not.toHaveBeenCalled();

    // At the first interval the chain starts.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await flushMicro();
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("re-arms the next poll at the server-returned interval (10s, not 5s)", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ status: "pending", pollInterval: 10 });
    mountPanel({ poll });
    await flushMicro();

    // First poll at the initial 5s.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    await flushMicro();
    expect(poll).toHaveBeenCalledTimes(1);

    // The response said 10s. At t=9s after the first poll it must NOT fire.
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(poll).toHaveBeenCalledTimes(1);

    // It fires at 10s after the first poll.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await flushMicro();
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("stops after three consecutive error responses and renders the error panel", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ status: "error", error: "boom" });
    mountPanel({ poll });
    await flushMicro();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    await flushMicro();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    await flushMicro();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    await flushMicro();

    expect(poll).toHaveBeenCalledTimes(3);
    expect(text()).toContain("Couldn't sign in");
    expect(text()).toContain("boom");

    // Loop is stopped — advancing time fires no further polls.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("calls onConnected exactly once on a done response and stops the loop", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ status: "done" });
    const onConnected = vi.fn();
    mountPanel({ poll, onConnected });
    await flushMicro();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    await flushMicro();
    expect(onConnected).toHaveBeenCalledTimes(1);

    // Loop stopped — no further polls, and onConnected doesn't fire again.
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("calls onConnected immediately when the box already has a credential", async () => {
    const onConnected = vi.fn();
    mountPanel({
      poll: vi.fn(),
      onConnected,
      start: () => Promise.resolve({ connected: true, grant: null }),
    });
    await flushMicro();
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("renders the not-configured panel when the box's client id is a placeholder", async () => {
    mountPanel({
      poll: vi.fn(),
      start: () => Promise.resolve({ connected: false, notConfigured: true, grant: null }),
    });
    await flushMicro();
    expect(text()).toContain("GitHub sign-in isn't configured on this box yet");
  });
});
