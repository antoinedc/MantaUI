// stageMapper.test.ts — foldChunk / buildStageSnapshot / stripAnsi unit tests.
// Pure: takes a text chunk + current stage, returns the new state.

import { describe, it, expect } from "vitest";
import {
  foldChunk,
  buildStageSnapshot,
  stripAnsi,
  INSTALL_STAGES,
  type InstallStageId,
} from "./stageMapper.js";

describe("stripAnsi", () => {
  it("strips the four CSI colors install.sh uses (36/32/33/31)", () => {
    expect(stripAnsi("\x1b[36m▸\x1b[0m hi")).toBe("▸ hi");
    expect(stripAnsi("\x1b[32m✓\x1b[0m ok")).toBe("✓ ok");
    expect(stripAnsi("\x1b[33m!\x1b[0m warn")).toBe("! warn");
    expect(stripAnsi("\x1b[31m✗\x1b[0m die")).toBe("✗ die");
  });

  it("passes through plain text untouched", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
    expect(stripAnsi("")).toBe("");
  });

  it("strips multi-parameter CSI sequences", () => {
    expect(stripAnsi("\x1b[1;36mbold-cyan\x1b[0m")).toBe("bold-cyan");
  });
});

describe("foldChunk — landmark advancement", () => {
  it("empty / non-string chunk leaves the stage alone and yields no lines", () => {
    expect(foldChunk("", "preflight")).toEqual({
      currentStage: "preflight",
      currentStageIndex: 0,
      lines: [],
    });
    // @ts-expect-error – deliberate: defensive runtime check
    expect(foldChunk(null, "service").currentStage).toBe("service");
  });

  it("a chunk of plain lines (no landmarks) keeps the stage and returns the lines", () => {
    const r = foldChunk("random log line\nanother one\n", "download");
    expect(r.currentStage).toBe("download");
    expect(r.currentStageIndex).toBe(1);
    expect(r.lines).toEqual([
      { text: "random log line", stage: "download" },
      { text: "another one", stage: "download" },
    ]);
  });

  it("advances on the matching landmark but never rewinds", () => {
    // Feed "extract" → "service" → "download" landmarks in order; the
    // service landmark should not send us backward to download.
    const r = foldChunk(
      [
        "▸ Initialising git checkout at /home/dev/manta",
        "▸ Installing systemd --user unit…",
        "▸ Downloading release", // out-of-order — ignored
      ].join("\n"),
      "extract",
    );
    expect(r.currentStage).toBe("service");
    expect(r.lines[2].stage).toBe("service"); // download line marked service
  });

  it("matches the canonical install.sh milestone lines", () => {
    const lines = [
      "▸ Checking prerequisites (curl, tar, sha256sum|shasum, tmux, git)…",
      "▸ Fetching manifest from https://mantaui.com/releases/manta-latest.txt…",
      "▸ Downloading release…",
      "▸ Verifying tar256…",
      "▸ Extracting to /tmp/…/pkg…",
      "▸ Initialising git checkout at /home/dev/manta",
      "▸ Installing systemd --user unit…",
      "✓ opencode-serve is healthy.",
      "▸ Pairing code: 123456",
      "Your box serves its own public hostname — https://…boxes.mantaui.com",
    ];
    let stage: InstallStageId = "preflight";
    for (const l of lines) {
      stage = foldChunk(l + "\n", stage).currentStage;
    }
    expect(stage).toBe("done");
  });

  it("tolerates the [dry-run] / colored prefix on landmarks", () => {
    const r = foldChunk(
      "\x1b[36m▸\x1b[0m Checking prerequisites (curl, tar, …)\n",
      "preflight",
    );
    expect(r.currentStage).toBe("preflight");
    expect(r.lines[0].text).toBe("▸ Checking prerequisites (curl, tar, …)");
  });

  it("ignores lines that look like landmarks but don't match the regex", () => {
    // "Checking prerequisites" is the landmark; "Checking prereqs" is not.
    const r = foldChunk("Checking prereqs (almost the same)…\n", "preflight");
    expect(r.currentStage).toBe("preflight");
  });
});

describe("buildStageSnapshot", () => {
  it("renders pre-‘download’ state — first stage active, rest pending", () => {
    expect(buildStageSnapshot("preflight").map((s) => s.state)).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("renders mid-install state — earlier stages done, current active", () => {
    const snap = buildStageSnapshot("service");
    expect(snap.map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
      "active",
      "pending",
      "pending",
    ]);
  });

  it("renders a fully-finished state — every stage done", () => {
    expect(buildStageSnapshot("done").map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  it("labels match INSTALL_STAGES so the checklist UI doesn't drift", () => {
    const snap = buildStageSnapshot("pairing");
    expect(snap.map((s) => s.label)).toEqual(INSTALL_STAGES.map((s) => s.label));
  });
});
