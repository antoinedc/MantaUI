// stageMapper.ts — fold raw install output lines into a small ordered
// checklist of stages for the UI, keep the raw log under a disclosure.
//
// WHY A STATEFUL FOLD (vs. classifying each line independently): the
// install.sh log/ok/warn calls happen in order, but they don't all carry
// their own stage label. The "installing systemd unit" line happens after
// "opencode-serve is healthy" — we advance the current stage when a landmark
// line is seen and STAY there until the next landmark. This way the UI
// shows a single spinning stage at any time, with the others in their prior
// state (done / pending).
//
// LANDMARKS come from the actual log() / ok() / warn() lines in
// scripts/install.sh. Every entry has a regex + a target stage index; the
// fold walks the lines in order, advancing when a regex matches. Ties are
// broken by the order the landmarks appear in this file (first match wins).
//
// STAGES — the ordered checklist the UI renders. Adding a stage requires
// editing install.sh's log lines too (so they remain greppable), AND adding
// the matching landmark here. The stage index is just its position in the
// array.
//
// Pure: takes a string (one chunk of stdout), returns the new "current
// stage" + a sanitised copy of the line (ANSI stripped, no secrets). The
// caller keeps the fold state between chunks so a landmark that happens to
// straddle a chunk boundary still resolves on the next chunk.

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

/** Ordered list of stages — UI walks this to render the checklist. */
export const INSTALL_STAGES: ReadonlyArray<InstallStage> = [
  { id: "preflight", label: "Preflight" },
  { id: "download", label: "Download release" },
  { id: "extract", label: "Extract + atomic swap" },
  { id: "service", label: "Install + start service" },
  { id: "pairing", label: "Pair with the desktop" },
  { id: "done", label: "Done" },
];

const STAGE_INDEX: Record<InstallStageId, number> = {
  preflight: 0,
  download: 1,
  extract: 2,
  service: 3,
  pairing: 4,
  done: 5,
};

type Landmark = { re: RegExp; target: InstallStageId };

// Ordered: first match wins. Each regex matches a unique log/ok/warn line
// from scripts/install.sh — the same set of greppable strings the install
// script already prints, NOT new instrumentation added to the shell.
const LANDMARKS: ReadonlyArray<Landmark> = [
  // preflight — "Checking prerequisites" is the first log line install.sh
  // prints (line 463). The fold starts in "preflight" anyway, but explicit
  // anchor keeps the fold deterministic when the caller seeds it with a
  // different starting stage.
  { re: /^▸\s*Checking prerequisites/, target: "preflight" },

  // download — "Fetching manifest" (496) or "Release tarball:" (507).
  { re: /^▸\s*Fetching manifest/, target: "download" },
  { re: /^▸\s*Downloading release/, target: "download" },
  { re: /^▸\s*Verifying tarball sha256/, target: "download" },

  // extract — "Extracting to" (524), "Release tarball looks self-contained"
  // (540). The atomic swap happens between these.
  { re: /^▸\s*Extracting to/, target: "extract" },
  { re: /^▸\s*Initialising git checkout/, target: "extract" },

  // service — "opencode-serve is healthy" (978) OR "Installing systemd
  // --user unit" (1051) — whichever fires first is good enough. Also
  // matches the launchd equivalent. The two install paths can race, so we
  // anchor on both.
  { re: /^▸\s*Installing systemd/, target: "service" },
  { re: /^▸\s*Installing.*LaunchAgent/, target: "service" },
  { re: /^▸\s*Waiting for opencode-serve/, target: "service" },
  { re: /^✓\s*opencode-serve is healthy/, target: "service" },

  // pairing — the trailing pairing block emits "Pairing code:" (one of the
  // last log lines). Once we see it, the install is functionally complete
  // and only the loopback mint+claim remains.
  { re: /^▸\s*Pairing code:/, target: "pairing" },
  { re: /^▸\s*Pair link:/, target: "pairing" },

  // done — "Your box serves its own public hostname" or "Tailscale detected"
  // closing summary (the script's tail block). Anchored on the most stable
  // substring.
  { re: /^Your box serves its own public hostname/, target: "done" },
  { re: /^Tailscale detected/, target: "done" },
];

/** Strip ANSI CSI sequences (color codes) so the regexes above can match. */
export function stripAnsi(s: string): string {
  // CSI: ESC [ … letter. Covers the colors install.sh uses (log=36 ok=32
  // warn=33 die=31) plus the [dry-run] prefix (no color, but the same
  // structure).
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export type FoldResult = {
  /** The stage after this chunk is consumed (may equal the input on no match). */
  currentStage: InstallStageId;
  /** Index into INSTALL_STAGES, derived — useful for the checklist UI. */
  currentStageIndex: number;
  /** Per-line parsed records. The UI shows the line text + marks the stage. */
  lines: Array<{ text: string; stage: InstallStageId }>;
};

/**
 * Fold a chunk of stdout/stderr into the staged log + return the new
 * current stage. The caller keeps `currentStage` between calls — pass the
 * initial value "preflight" and reuse the returned value on subsequent
 * chunks. The fold advances strictly (never goes backward).
 */
export function foldChunk(
  rawText: string,
  currentStage: InstallStageId,
): FoldResult {
  const lines: Array<{ text: string; stage: InstallStageId }> = [];
  if (typeof rawText !== "string" || rawText === "") {
    return {
      currentStage,
      currentStageIndex: STAGE_INDEX[currentStage],
      lines,
    };
  }
  let stage: InstallStageId = currentStage;
  for (const rawLine of rawText.split(/\r?\n/)) {
    const text = stripAnsi(rawLine);
    if (text === "") continue;
    for (const lm of LANDMARKS) {
      if (lm.re.test(text)) {
        // Strict advance — never rewind.
        if (STAGE_INDEX[lm.target] > STAGE_INDEX[stage]) {
          stage = lm.target;
        }
        break;
      }
    }
    lines.push({ text, stage });
  }
  return {
    currentStage: stage,
    currentStageIndex: STAGE_INDEX[stage],
    lines,
  };
}

/**
 * Build a "stage status" snapshot the UI renders as a checklist. A stage is
 * "done" when the current stage has advanced past it, "active" when the
 * current stage equals it, "pending" otherwise. The terminal "done" stage
 * collapses to "done" when currentStage IS done — by definition the install
 * is finished, so nothing is "active" anymore.
 */
export function buildStageSnapshot(currentStage: InstallStageId): Array<{
  id: InstallStageId;
  label: string;
  state: "done" | "active" | "pending";
}> {
  const cur = STAGE_INDEX[currentStage];
  return INSTALL_STAGES.map((s) => {
    const idx = STAGE_INDEX[s.id];
    let state: "done" | "active" | "pending";
    if (idx < cur) state = "done";
    else if (idx === cur) {
      // The terminal stage collapses to "done" when currentStage === done —
      // the install is complete, nothing is spinning anymore.
      state = currentStage === "done" ? "done" : "active";
    } else {
      state = "pending";
    }
    return { id: s.id, label: s.label, state };
  });
}
