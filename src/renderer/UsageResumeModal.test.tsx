// @vitest-environment jsdom
//
// The wiring seam the issue demands an end-to-end test for: indicator →
// modal → armed record (BET-1049). The renderer's equivalent path before this
// feature had no such test, which is exactly how the "resume the wrong
// conversation" bug survived. So this pins the seam at the component level:
//
//   store.usageStopped (the box record) → modal rows (selection) →
//     Confirming arms EXACTLY the checked rows (usageStoppedArm) and disarms
//     previously-armed-but-unchecked rows (usageStoppedDisarm); closing stamps
//     last-looked (usageStoppedStampLastLooked) so "new" badges clear.
//
// The sidebar pill count is derived from the same store slice
// (unarmedStoppedCount), covered by the pure-helper tests in usageResume.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installMockApi, mount, resetStore, clickCheckbox, type Harness } from "./testHarness";
import { UsageResumeModal } from "./UsageResumeModal";
import type { StoppedRecord } from "../shared/types";

const rec = (p: Partial<StoppedRecord> = {}): StoppedRecord => ({
  workspace: "manta",
  conversation: "ses_a",
  provider: "claude",
  model: "claude-sonnet-4-6",
  window: "weekly",
  stoppedAt: 5000,
  cachedTokens: 10000,
  armed: false,
  attempts: 1,
  ...p,
});

function toggle(harness: Harness, conversation: string): void {
  // Drive the checkbox the way a user does — on the visible box, not the
  // sr-only input. React wires checkbox onChange to the browser's
  // label-activation click, which is exactly the path this exercises.
  clickCheckbox(harness, `Resume ${conversation}`);
}

function primary(harness: Harness): HTMLButtonElement | null {
  const btns = [...harness.docQuery('div[role="dialog"]')!.querySelectorAll("button")];
  return btns.find((b) => /Resume|Update/.test(b.textContent ?? "")) ?? null;
}

describe("UsageResumeModal — indicator → modal → armed record", () => {
  let h: Harness | null = null;
  const arm = vi.fn(async () => undefined);
  const disarm = vi.fn(async () => undefined);
  const stamp = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    installMockApi({
      usageStoppedArm: arm,
      usageStoppedDisarm: disarm,
      usageStoppedStampLastLooked: stamp,
      opencodeMessages: async () => [],
    });
    resetStore({ cacheTtl: "1h" });
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("lists the stopped conversations grouped and starts with armed rows selected", async () => {
    resetStore({
      usageStopped: [rec({ conversation: "ses_a", armed: true }), rec({ conversation: "ses_b" })],
      lastLookedStopped: null,
    });
    h = mount(<UsageResumeModal open nameFor={(c) => c} onClose={() => {}} />);
    await h.flush();
    expect(h.docText()).toContain("Resume after limit reset");
    expect(h.docText()).toContain("ses_a");
    expect(h.docText()).toContain("ses_b");
    // armed row is pre-selected → 1 of 2 selected
    expect(h.docText()).toContain("1 of 2 selected");
  });

  it("arming writes the record back: arms checked + disarms previously-armed unchecked, stamps last-looked", async () => {
    resetStore({
      usageStopped: [
        rec({ conversation: "ses_a", armed: true }),
        rec({ conversation: "ses_b" }),
        rec({ conversation: "ses_c" }),
      ],
      lastLookedStopped: null,
    });
    h = mount(<UsageResumeModal open nameFor={(c) => c} onClose={() => {}} />);
    await h.flush();

    // Default selection = the armed row (ses_a). Uncheck ses_a, check ses_c.
    toggle(h, "ses_a");
    toggle(h, "ses_c");
    await h.flush();
    expect(h.docText()).toContain("1 of 3 selected");

    const confirm = primary(h)!;
    confirm.click();
    await h.flush();

    expect(arm).toHaveBeenCalledWith("ses_c"); // checked now, was not armed
    expect(arm).not.toHaveBeenCalledWith("ses_a"); // was armed, still armed-ish? no — unselected so disarmed
    expect(disarm).toHaveBeenCalledWith("ses_a"); // was armed, now unchecked → explicit "no"
    expect(disarm).not.toHaveBeenCalledWith("ses_b"); // never armed, not selected → untouched
    expect(stamp).toHaveBeenCalledTimes(1); // stamped on close
  });

  it("leaves already-armed rows armed (no spurious disarm) when kept selected", async () => {
    resetStore({
      usageStopped: [rec({ conversation: "ses_a", armed: true })],
      lastLookedStopped: null,
    });
    h = mount(<UsageResumeModal open nameFor={(c) => c} onClose={() => {}} />);
    await h.flush();
    // Keep ses_a selected (default), confirm.
    primary(h)!.click();
    await h.flush();
    expect(arm).not.toHaveBeenCalled();
    expect(disarm).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenCalledTimes(1);
  });
});
