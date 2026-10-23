// @vitest-environment jsdom
//
// The "Old conversation history" row in Settings → About (cleanup spec §6): shown only when the box
// says reclaim is available; confirm dialog with the exact copy; success → toast naming the freed
// size and the row disappears; failure → the server's message, row stays.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { mount, installMockApi, type Harness } from "./testHarness";
import { ReclaimRow, reclaimConfirmBody, reclaimDoneMessage } from "./ReclaimRow";
import { Settings } from "./Settings";
import { useStore } from "./store";
import type { ReclaimResult, ReclaimStatus } from "../shared/api";

const GB = 1024 ** 3;
const available = (over: Partial<ReclaimStatus> = {}): ReclaimStatus => ({
  available: true,
  reason: null,
  mode: "copy",
  bytes: 34 * GB,
  state: "none",
  ...over,
});

describe("ReclaimRow", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  beforeEach(() => {
    useStore.setState({ appToasts: [] });
  });

  const rowText = () => h!.container.querySelector('[data-testid="reclaim-row"]')?.textContent ?? null;
  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await h!.flush();
  };

  it("renders nothing when the box says it is not available", async () => {
    installMockApi({ upgradeReclaimStatus: async () => available({ available: false, reason: "Already reclaimed", state: "done", bytes: null }) });
    h = mount(<ReclaimRow />);
    await h.flush();
    expect(rowText()).toBeNull();
  });

  it("renders nothing when the box predates the route (null) or the client has no such method", async () => {
    installMockApi({ upgradeReclaimStatus: async () => null });
    h = mount(<ReclaimRow />);
    await h.flush();
    expect(rowText()).toBeNull();
    h.unmount();
    installMockApi({}, { absent: ["upgradeReclaimStatus"] });
    h = mount(<ReclaimRow />);
    await h.flush();
    expect(rowText()).toBeNull();
  });

  it("renders nothing (and does not crash) when the status read fails", async () => {
    installMockApi({ upgradeReclaimStatus: async () => { throw new Error("HTTP 500"); } });
    h = mount(<ReclaimRow />);
    await h.flush();
    expect(rowText()).toBeNull();
  });

  it("when available: names the old history, shows the size, offers 'Delete to free space'", async () => {
    installMockApi({ upgradeReclaimStatus: async () => available() });
    h = mount(<ReclaimRow />);
    await h.flush();
    const t = rowText()!;
    expect(t).toContain("Old conversation history (from before the OpenCode 2 upgrade)");
    expect(t).toContain("34 GB");
    expect(t).toContain("Delete to free space");
  });

  it("the confirm dialog carries the exact copy; Cancel deletes nothing and closes it", async () => {
    const { api } = installMockApi({ upgradeReclaimStatus: async () => available() });
    h = mount(<ReclaimRow />);
    await h.flush();
    act(() => button("Delete to free space")!.click());
    await h.flush();
    expect(h.docText()).toContain(
      "This frees 34 GB. Your conversations are already in the new format and are not affected. " +
        "You will no longer be able to roll the box back to the old version.",
    );
    act(() => button("Cancel")!.click());
    await settle();
    expect(api.calls.upgradeReclaim ?? []).toHaveLength(0);
    expect(rowText()).not.toBeNull();
  });

  it("success: the freed size is confirmed in a toast and the row disappears", async () => {
    let n = 0;
    const { api } = installMockApi({
      upgradeReclaimStatus: async () => available(),
      upgradeReclaim: async (): Promise<ReclaimResult> => ((n += 1), { ok: true, freedBytes: 34 * GB }),
    });
    h = mount(<ReclaimRow />);
    await h.flush();
    act(() => button("Delete to free space")!.click());
    await h.flush();
    act(() => button("Delete")!.click());
    await settle();
    expect(n).toBe(1);
    expect(api.calls.upgradeReclaim).toHaveLength(1);
    expect(useStore.getState().appToasts.map((t) => String(t.message))).toContain("Freed 34 GB of disk space");
    expect(rowText()).toBeNull();
  });

  it("failure: shows the server's message, keeps the row, re-reads the status", async () => {
    let reads = 0;
    installMockApi({
      upgradeReclaimStatus: async () => ((reads += 1), available({ state: reads > 1 ? "failed" : "none", bytes: reads > 1 ? 4 * GB : 34 * GB })),
      upgradeReclaim: async (): Promise<ReclaimResult> => ({ ok: false, error: "Couldn't delete opencode-v1: permission denied" }),
    });
    h = mount(<ReclaimRow />);
    await h.flush();
    act(() => button("Delete to free space")!.click());
    await h.flush();
    act(() => button("Delete")!.click());
    await settle();
    const alert = h.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't delete opencode-v1: permission denied");
    expect(reads).toBe(2);
    expect(rowText()).toContain("4 GB");
    expect(rowText()).toContain("didn't finish");
    expect(button("Delete to free space")?.disabled).toBe(false);
    expect(useStore.getState().appToasts).toHaveLength(0);
  });

  it("a rejection (e.g. sign-in expired) is shown too, never swallowed", async () => {
    installMockApi({
      upgradeReclaimStatus: async () => available(),
      upgradeReclaim: async () => { throw new Error("auth required"); },
    });
    h = mount(<ReclaimRow />);
    await h.flush();
    act(() => button("Delete to free space")!.click());
    await h.flush();
    act(() => button("Delete")!.click());
    await settle();
    expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("auth required");
  });

  it("copy helpers degrade gracefully with no size", () => {
    expect(reclaimConfirmBody(null)).toMatch(/^This frees disk space\. /);
    expect(reclaimDoneMessage(0)).toBe("Freed disk space");
    expect(reclaimDoneMessage(2 * GB)).toBe("Freed 2 GB of disk space");
  });

  it("is rendered in Settings → About (General) when available", async () => {
    installMockApi({
      configGet: () => Promise.resolve({}),
      getClientVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      getServerVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      upgradeReclaimStatus: async () => available(),
    });
    h = mount(<Settings onClose={() => {}} />);
    await h.flush();
    await h.flush();
    expect(h.container.querySelector('[data-testid="reclaim-row"]')).toBeTruthy();
  });
});
