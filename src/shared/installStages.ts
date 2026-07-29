// installStages.ts — the ordered install stages + the single status line the
// UI renders. Pure, no I/O. Lives in src/shared/ (not src/main/installer/) so
// BOTH the main-process fold (stageMapper.ts) and the renderer's
// remount-recovery path derive the stage order + labels from the SAME
// source (BET-383) — neither side may invent its own copy.

export type InstallStageId =
  | "preflight"
  | "download"
  | "extract"
  | "service"
  | "pairing"
  | "done";

export type InstallStage = {
  id: InstallStageId;
  label: string;
};

export const INSTALL_STAGES: ReadonlyArray<InstallStage> = [
  { id: "preflight", label: "Checking the box" },
  { id: "download", label: "Download release" },
  { id: "extract", label: "Installing files" },
  { id: "service", label: "Starting the service" },
  { id: "pairing", label: "Pairing with this app" },
  { id: "done", label: "Done" },
];

export const STAGE_INDEX: Record<InstallStageId, number> = {
  preflight: 0,
  download: 1,
  extract: 2,
  service: 3,
  pairing: 4,
  done: 5,
};

/** The single status line the UI renders, e.g. "Checking the box… · 1 of 6". */
export function currentStageInfo(currentStage: InstallStageId): {
  label: string;
  index: number; // 1-based position in INSTALL_STAGES
  total: number;
} {
  const idx = STAGE_INDEX[currentStage];
  return {
    label: INSTALL_STAGES[idx].label,
    index: idx + 1,
    total: INSTALL_STAGES.length,
  };
}
