// installStages.test.ts — currentStageInfo unit tests. Pure: takes a stage
// id, returns the single status line's label + 1-based index + total.
// Lives in src/shared/ because both src/main/installer/stageMapper.ts and
// the renderer (SshInstallStep.tsx) import from here (BET-383).

import { describe, it, expect } from "vitest";
import { currentStageInfo, INSTALL_STAGES } from "./installStages.js";

describe("currentStageInfo — BET-383 single status line", () => {
  it("resolves every stage's label + 1-based index + total from INSTALL_STAGES", () => {
    INSTALL_STAGES.forEach((s, i) => {
      expect(currentStageInfo(s.id)).toEqual({
        label: s.label,
        index: i + 1,
        total: INSTALL_STAGES.length,
      });
    });
  });

  it("uses the renamed labels (preflight → 'Checking the box', terminal 'done')", () => {
    expect(currentStageInfo("preflight").label).toBe("Checking the box");
    expect(currentStageInfo("done")).toEqual({ label: "Done", index: 6, total: 6 });
  });
});
