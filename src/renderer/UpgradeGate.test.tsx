// @vitest-environment jsdom
//
// OpenCode V2 cutover, slice C4: the blocking upgrade screen, driven through the
// real hook (`useUpgradeGate`) and the real component (`UpgradeGate`) against a
// FAKE box that speaks contract K3 — frames, the poll endpoint, 503s and the
// retry/rollback POSTs. The scenarios are the ones the spec names:
//
//   idle → running (steps with progress) → completed
//   failed (disk) → Check again          failed (migration) → Roll back
//   a 503 during normal use → gate       manta-server restart → poll at 1 Hz
//
// Every button is asserted to DO something visible, per "never stub a control".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { useStore } from "./store";
import { useUpgradeGate } from "./hooks/useUpgradeGate";
import { UpgradeGate } from "./UpgradeGate";
import { DESKTOP_DOWNLOAD_URL } from "./upgradeGate";
import type { UpgradeActionResult, UpgradeStatus, UpgradeStep } from "../shared/api";

const GiB = 2 ** 30;

const step = (id: UpgradeStep["id"], status: UpgradeStep["status"], extra: Partial<UpgradeStep> = {}): UpgradeStep => ({
  id,
  label: ({ preflight: "Check disk space", stop: "Stop agents", copy: "Copy history", migrate: "Migrate", verify: "Verify", cutover: "Switch over" } as const)[id],
  status,
  progress: null,
  ...extra,
});

const ALL = ["preflight", "stop", "copy", "migrate", "verify", "cutover"] as const;

/** A K3 object where steps before `at` are done, `at` has `status`, the rest pending. */
function at(
  id: (typeof ALL)[number],
  status: "running" | "failed",
  extra: Partial<UpgradeStatus> & { progress?: UpgradeStep["progress"] } = {},
): UpgradeStatus {
  const idx = ALL.indexOf(id);
  const { progress, ...rest } = extra;
  return {
    state: status === "failed" ? "failed" : "running",
    steps: ALL.map((s, i) =>
      i < idx ? step(s, "done") : i === idx ? step(s, status, { progress: progress ?? null }) : step(s, "pending"),
    ),
    overall: idx / ALL.length,
    etaSeconds: status === "running" ? 240 : null,
    error: null,
    ...rest,
  };
}

const COMPLETED: UpgradeStatus = { state: "completed", steps: ALL.map((s) => step(s, "done")), overall: 1, etaSeconds: null, error: null };

/** The fake box: what GET /api/upgrade answers, the frames it pushes, the POSTs. */
function fakeBox() {
  const box = {
    current: null as UpgradeStatus | null,
    down: false,
    pollCount: 0,
    retryResult: { ok: true } as UpgradeActionResult,
    rollbackResult: { ok: true } as UpgradeActionResult,
    frameCbs: new Set<(s: UpgradeStatus) => void>(),
    upgradingCbs: new Set<() => void>(),
    retry: vi.fn(),
    rollback: vi.fn(),
    openExternal: vi.fn(async (_url: string) => {}),
    api: {} as Record<string, unknown>,
    /** The box changes state and pushes a frame. */
    emit(s: UpgradeStatus) {
      box.current = s;
      act(() => {
        for (const cb of Array.from(box.frameCbs)) cb(s);
      });
    },
    /** Some unrelated data call came back 503 {upgrade:true}. */
    refuse503() {
      act(() => {
        for (const cb of Array.from(box.upgradingCbs)) cb();
      });
    },
  };
  box.api = {
    upgradeStatus: async () => {
      box.pollCount++;
      if (box.down) throw new Error("fetch failed");
      return box.current;
    },
    upgradeRetry: async () => {
      box.retry();
      return box.retryResult;
    },
    upgradeRollback: async () => {
      box.rollback();
      return box.rollbackResult;
    },
    onUpgrade: (cb: (s: UpgradeStatus) => void) => {
      box.frameCbs.add(cb);
      return () => box.frameCbs.delete(cb);
    },
    onBoxUpgrading: (cb: () => void) => {
      box.upgradingCbs.add(cb);
      return () => box.upgradingCbs.delete(cb);
    },
    openExternal: box.openExternal,
  };
  return box;
}

function Host(props: { boxNeedsUpgrade?: boolean; onUpgradeBox?: () => void; onCleared?: () => void }) {
  const g = useUpgradeGate({
    boxNeedsUpgrade: props.boxNeedsUpgrade ?? false,
    boxUpdating: false,
    boxUpdateError: null,
    boxUpdateProgress: null,
    apiGeneration: 0,
    onCleared: props.onCleared,
  });
  return <UpgradeGate view={g.view} onUpgradeBox={props.onUpgradeBox ?? (() => {})} onRetry={g.retry} onRollback={g.rollback} />;
}

const setConnected = (connected: boolean) =>
  act(() => {
    useStore.setState({ connectionState: connected ? { state: "connected" } : { state: "idle" } });
  });

const gate = () => document.querySelector<HTMLElement>('[data-testid="upgrade-gate"]');
const button = (text: string): HTMLButtonElement | null =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) ?? null;
const bar = (label: string) => document.querySelector<HTMLElement>(`[role="progressbar"][aria-label="${label}"]`);
const press = (b: HTMLButtonElement | null) => {
  expect(b, "button to press").not.toBeNull();
  act(() => b!.click());
};

describe("UpgradeGate — driven by a fake K3 box", () => {
  let h: Harness | null = null;
  let box: ReturnType<typeof fakeBox>;

  beforeEach(() => {
    box = fakeBox();
    installMockApi(box.api);
    resetStore();
    setConnected(true);
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
  });

  const start = async (props: Parameters<typeof Host>[0] = {}) => {
    h = mount(<Host {...props} />);
    await h.flush();
  };

  it("renders nothing for an idle box, and nothing for an old box with no upgrade API", async () => {
    box.current = null; // 404 → null
    await start();
    expect(gate()).toBeNull();
    box.emit({ ...COMPLETED, state: "idle" });
    await h!.flush();
    expect(gate()).toBeNull();
  });

  it("idle → running steps with progress → completed → the app opens", async () => {
    const onCleared = vi.fn();
    await start({ onCleared });
    expect(gate()).toBeNull();

    // preflight/stop done, copying 25%.
    box.emit(at("copy", "running", { progress: { label: "1 GB of 4 GB", numerator: 25, denominator: 100 }, overall: 0.2 }));
    await h!.flush();
    expect(gate()).not.toBeNull();
    expect(document.body.textContent).toContain("Upgrading your box");
    expect(document.body.textContent).toContain("about 4 min left");
    expect(document.body.textContent).toContain("20% complete");
    expect(bar("Overall upgrade progress")?.getAttribute("aria-valuenow")).toBe("20");
    // The current step has its OWN bar, fed by numerator/denominator, plus its caption.
    expect(bar("Copy history progress")?.getAttribute("aria-valuenow")).toBe("25");
    expect(document.body.textContent).toContain("1 GB of 4 GB");
    // Per-step status icons: two done, one running, three pending.
    const statuses = Array.from(document.querySelectorAll("[data-step]")).map((n) => n.getAttribute("data-status"));
    expect(statuses).toEqual(["done", "done", "running", "pending", "pending", "pending"]);
    // Not dismissible: no close control, no buttons at all while running.
    expect(document.querySelectorAll("button")).toHaveLength(0);

    // Next step has no measurable progress → indeterminate bar (no aria-valuenow).
    box.emit(at("migrate", "running", { overall: 0.5 }));
    await h!.flush();
    expect(bar("Migrate progress")).not.toBeNull();
    expect(bar("Migrate progress")?.hasAttribute("aria-valuenow")).toBe(false);

    expect(onCleared).not.toHaveBeenCalled();
    box.emit(COMPLETED);
    await h!.flush();
    expect(gate()).toBeNull();
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it("failed on disk: shows 'needs X GB free, has Y GB', offers Check again (not Roll back), and the press shows its outcome", async () => {
    await start();
    box.emit(
      at("preflight", "failed", {
        error: { step: "preflight", message: "There isn't enough free disk space.", retryable: true, needBytes: 31 * GiB, haveBytes: 3 * GiB },
      }),
    );
    await h!.flush();

    expect(document.body.textContent).toContain("The upgrade couldn't finish");
    expect(document.body.textContent).toContain("needs 31 GB free, has 3 GB");
    expect(document.body.textContent).toContain("Nothing was changed");
    expect(button("Roll back")).toBeNull();

    // Pressing Check again calls POST retry and reports success.
    press(button("Check again"));
    await h!.flush();
    expect(box.retry).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Checking again…");

    // The box accepted it and went back to running → the stale outcome is gone.
    box.emit(at("preflight", "running"));
    await h!.flush();
    expect(document.body.textContent).toContain("Upgrading your box");
    expect(document.body.textContent).not.toContain("Checking again…");
  });

  it("a refused Retry shows the box's reason next to the button (not a silent no-op)", async () => {
    box.retryResult = { ok: false, error: "still only 3 GB free" };
    await start();
    box.emit(at("migrate", "failed", { error: { step: "migrate", message: "Migration crashed", retryable: true } }));
    await h!.flush();
    press(button("Retry"));
    await h!.flush();
    expect(box.retry).toHaveBeenCalledTimes(1);
    const alert = Array.from(document.querySelectorAll('[role="alert"]')).map((n) => n.textContent);
    expect(alert).toContain("still only 3 GB free");
    // The button is usable again after a refusal.
    expect(button("Retry")?.disabled).toBe(false);
  });

  it("shows a spinner while Retry is in flight", async () => {
    let release!: (r: UpgradeActionResult) => void;
    // installMockApi copies its overrides, so re-install with the held-open retry.
    installMockApi({
      ...box.api,
      upgradeRetry: () =>
        new Promise<UpgradeActionResult>((resolve) => {
          release = resolve;
        }),
    });
    await start();
    box.emit(at("migrate", "failed", { error: { step: "migrate", message: "m", retryable: true } }));
    await h!.flush();
    press(button("Retry"));
    await h!.flush();
    expect(button("Retrying…")?.disabled).toBe(true);
    expect(button("Roll back")?.disabled).toBe(true); // can't race the two actions
    await act(async () => release({ ok: true }));
    expect(document.body.textContent).toContain("Retry requested");
  });

  it("a non-retryable failure disables Retry with its reason", async () => {
    await start();
    box.emit(at("migrate", "failed", { error: { step: "migrate", message: "corrupt", retryable: false } }));
    await h!.flush();
    expect(button("Retry")?.disabled).toBe(true);
    expect(button("Retry")?.title).toMatch(/roll back/i);
    expect(button("Roll back")?.disabled).toBe(false);
  });

  it("failed migration → Roll back asks first, then calls POST rollback; rolled_back explains and links the previous desktop", async () => {
    await start();
    box.emit(at("migrate", "failed", { error: { step: "migrate", message: "Migration crashed", retryable: true } }));
    await h!.flush();

    press(button("Roll back"));
    await h!.flush();
    // Confirm dialog first: nothing has been sent yet.
    expect(document.body.textContent).toContain("Roll the box back?");
    expect(box.rollback).not.toHaveBeenCalled();

    // The dialog's own confirm button (the second "Roll back" button).
    const confirm = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "Roll back").pop() ?? null;
    press(confirm);
    await h!.flush();
    expect(box.rollback).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Roll-back requested");

    box.emit({ ...at("migrate", "failed"), state: "rolled_back" });
    await h!.flush();
    expect(document.body.textContent).toContain("Your box was rolled back");
    expect(document.body.textContent).toContain("reinstall the previous desktop version");

    press(button("Download previous version"));
    await h!.flush();
    expect(box.openExternal).toHaveBeenCalledWith(DESKTOP_DOWNLOAD_URL);
    expect(document.body.textContent).toContain("Opened the download page");
  });

  it("cancelling the roll-back confirm sends nothing", async () => {
    await start();
    box.emit(at("migrate", "failed", { error: { step: "migrate", message: "m", retryable: true } }));
    await h!.flush();
    press(button("Roll back"));
    await h!.flush();
    press(button("Cancel"));
    await h!.flush();
    expect(box.rollback).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Roll the box back?");
  });

  it("if the download link can't be opened, it says so and prints the address", async () => {
    box.openExternal.mockRejectedValueOnce(new Error("no handler"));
    await start();
    box.emit({ ...at("migrate", "failed"), state: "rolled_back" });
    await h!.flush();
    press(button("Download previous version"));
    await h!.flush();
    expect(document.body.textContent).toContain("Couldn't open the download page: no handler");
    expect(document.body.textContent).toContain(DESKTOP_DOWNLOAD_URL);
  });

  it("a 503 {upgrade:true} during normal use routes to the gate, which then follows the box's status", async () => {
    await start();
    expect(gate()).toBeNull();

    // A data call was refused while /api/upgrade can't answer yet (the box is
    // still coming up): no K3 object, but the user must not see a broken app.
    box.down = true;
    box.refuse503();
    await h!.flush();
    expect(document.body.textContent).toContain("Your box is upgrading");

    // The box answers: the gate follows its status.
    box.down = false;
    box.emit(at("stop", "running"));
    await h!.flush();
    expect(document.body.textContent).toContain("Upgrading your box");

    // Box finishes: a completed answer clears the 503 flag too.
    box.emit(COMPLETED);
    await h!.flush();
    expect(gate()).toBeNull();
  });

  it("a 503 that turns out to be a box with nothing upgrading (idle answer) does not strand the user on the gate", async () => {
    box.current = { ...COMPLETED, state: "idle" };
    await start();
    box.refuse503();
    await h!.flush();
    expect(gate()).toBeNull();
  });

  it("K4: a box on the old major shows Upgrade box, whose button raises the existing flow", async () => {
    const onUpgradeBox = vi.fn();
    await start({ boxNeedsUpgrade: true, onUpgradeBox });
    expect(document.body.textContent).toContain("Your box needs to be upgraded");
    press(button("Upgrade box"));
    expect(onUpgradeBox).toHaveBeenCalledTimes(1);
    // …and once the box reports its migration, the gate follows K3 instead.
    box.emit(at("copy", "running", { progress: { numerator: 1, denominator: 4 } }));
    await h!.flush();
    expect(document.body.textContent).toContain("Upgrading your box");
    expect(button("Upgrade box")).toBeNull();
  });

  it("Copy details copies the failure and says so", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mantaPreload = null;
    await start();
    box.emit(at("migrate", "failed", { error: { step: "migrate", message: "Migration crashed", retryable: true } }));
    await h!.flush();
    press(button("Copy details"));
    await h!.flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("error (migrate): Migration crashed");
    expect(document.body.textContent).toContain("Copied to the clipboard");
  });

  describe("survives a manta-server restart (poll while /events is down)", () => {
    it("polls once a second while the stream is down, keeps the last status through failed polls, and picks the box up when it returns", async () => {
      vi.useFakeTimers();
      setConnected(false);
      box.current = at("migrate", "running", { progress: { numerator: 10, denominator: 100 } });
      h = mount(<Host />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(document.body.textContent).toContain("Upgrading your box");
      const afterMount = box.pollCount;

      // manta-server is restarting: every poll fails. The screen must stay up.
      box.down = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(box.pollCount - afterMount).toBeGreaterThanOrEqual(3);
      expect(box.pollCount - afterMount).toBeLessThanOrEqual(4);
      expect(gate()).not.toBeNull();
      expect(document.body.textContent).toContain("Upgrading your box");

      // It comes back reporting a failure (the poll is the only channel — no frame).
      box.down = false;
      box.current = at("migrate", "failed", { error: { step: "migrate", message: "Migration crashed", retryable: true } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(document.body.textContent).toContain("The upgrade couldn't finish");

      // Stream reconnects: polling stops (frames take over)…
      setConnected(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const settled = box.pollCount;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(box.pollCount).toBe(settled);
    });

    it("an old/idle answer after a restart closes the gate (polling is authoritative)", async () => {
      vi.useFakeTimers();
      setConnected(false);
      box.current = at("verify", "running");
      h = mount(<Host />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(gate()).not.toBeNull();
      box.current = COMPLETED;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(gate()).toBeNull();
    });
  });

  it("re-reads the status on every reconnect (frames sent while down are never replayed)", async () => {
    await start();
    const before = box.pollCount;
    setConnected(false);
    box.current = at("stop", "running");
    setConnected(true);
    await h!.flush();
    expect(box.pollCount).toBeGreaterThan(before);
    expect(document.body.textContent).toContain("Upgrading your box");
  });

  it("unsubscribes on unmount", async () => {
    await start();
    expect(box.frameCbs.size).toBe(1);
    expect(box.upgradingCbs.size).toBe(1);
    h!.unmount();
    h = null;
    expect(box.frameCbs.size).toBe(0);
    expect(box.upgradingCbs.size).toBe(0);
  });
});
