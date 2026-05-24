import { describe, it, expect } from "vitest";
import { parseProbeOutput, PROBE_SCRIPT, BOOTSTRAP_SCRIPT } from "./setup.js";

describe("parseProbeOutput", () => {
  it("parses all-ok output into a passing result", () => {
    const stdout = [
      "ssh=ok|connected",
      "tmux=ok|tmux 3.4",
      "opencode=ok|/home/dev/.opencode/bin/opencode (0.9.1)",
      "opencodeAuthPlugin=ok|configured",
      "anthropicAuth=ok|credentials present",
    ].join("\n");
    const r = parseProbeOutput(stdout);
    expect(r.allOk).toBe(true);
    expect(r.checks).toHaveLength(5);
    expect(r.checks.map((c) => c.name)).toEqual([
      "ssh",
      "tmux",
      "opencode",
      "opencodeAuthPlugin",
      "anthropicAuth",
    ]);
    for (const c of r.checks) expect(c.ok).toBe(true);
  });

  it("flags a single failing check while preserving ok siblings", () => {
    const stdout = [
      "ssh=ok|connected",
      "tmux=ok|tmux 3.4",
      "opencode=fail|opencode not installed. Click 'Bootstrap remote' to install.",
      "opencodeAuthPlugin=fail|not configured",
      "anthropicAuth=fail|not signed in",
    ].join("\n");
    const r = parseProbeOutput(stdout);
    expect(r.allOk).toBe(false);
    expect(r.checks.find((c) => c.name === "tmux")?.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "opencode")?.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "opencode")?.detail).toContain(
      "Bootstrap remote",
    );
  });

  it("treats missing keys as 'fail|not reported' (never silently dropped)", () => {
    // Only ssh + tmux reported — the script crashed mid-way somehow.
    const stdout = ["ssh=ok|connected", "tmux=ok|tmux 3.4"].join("\n");
    const r = parseProbeOutput(stdout);
    expect(r.allOk).toBe(false);
    expect(r.checks).toHaveLength(5);
    const oc = r.checks.find((c) => c.name === "opencode")!;
    expect(oc.ok).toBe(false);
    expect(oc.detail).toBe("not reported");
  });

  it("ignores junk lines, stray spacing, and unknown keys", () => {
    const stdout = [
      "",
      "  ssh=ok|connected  ",
      "garbage without equals",
      "key_without_pipe=ok",
      "unknownKey=ok|whatever",
      "tmux=ok|tmux 3.4",
      "opencode=ok|/usr/bin/opencode (1.0)",
      "opencodeAuthPlugin=ok|configured",
      "anthropicAuth=ok|present",
    ].join("\n");
    const r = parseProbeOutput(stdout);
    expect(r.allOk).toBe(true);
    expect(r.checks.find((c) => c.name === "ssh")?.detail).toBe("connected");
  });

  it("preserves '|' inside the detail string (path with pipes etc.)", () => {
    const stdout = "tmux=ok|tmux 3.4 | custom build";
    const r = parseProbeOutput(stdout);
    expect(r.checks.find((c) => c.name === "tmux")?.detail).toBe(
      "tmux 3.4 | custom build",
    );
  });

  it("treats unrecognized status (not ok/fail) as missing — defensive", () => {
    const stdout = "ssh=maybe|hello";
    const r = parseProbeOutput(stdout);
    expect(r.checks.find((c) => c.name === "ssh")?.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "ssh")?.detail).toBe("not reported");
  });
});

describe("script shape sanity checks", () => {
  it("PROBE_SCRIPT emits every key the parser expects", () => {
    // The parser fills in 'not reported' for any missing key, so if the
    // script forgets to echo one we'd ship a probe that always fails it.
    for (const key of [
      "ssh=",
      "tmux=",
      "opencode=",
      "opencodeAuthPlugin=",
      "anthropicAuth=",
    ]) {
      expect(PROBE_SCRIPT).toContain(key);
    }
  });

  it("BOOTSTRAP_SCRIPT references the official opencode installer", () => {
    expect(BOOTSTRAP_SCRIPT).toContain("opencode.ai/install");
  });

  it("BOOTSTRAP_SCRIPT writes the claude-auth plugin into opencode.jsonc", () => {
    expect(BOOTSTRAP_SCRIPT).toContain("opencode-claude-auth");
    expect(BOOTSTRAP_SCRIPT).toContain("opencode.jsonc");
  });

  it("BOOTSTRAP_SCRIPT does not actually run the auth login flow (needs browser)", () => {
    // The script SURFACES the `opencode auth login anthropic` command as a
    // copy-pasteable next step (inside a quoted log line), but never invokes
    // it directly — that flow opens a browser/device-code prompt and would
    // hang our non-interactive ssh session forever.
    //
    // Heuristic: an actual invocation would appear at the start of a line
    // (optional whitespace), not inside a `log "..."` string. So look for
    // `^\s*opencode\s+auth\s+login` after normalizing — and confirm the
    // help mention is still present (regression bait if someone deletes it).
    const linesThatExecute = BOOTSTRAP_SCRIPT.split("\n").filter((l) =>
      /^\s*opencode\s+auth\s+login/.test(l),
    );
    expect(linesThatExecute).toHaveLength(0);
    expect(BOOTSTRAP_SCRIPT).toContain("opencode auth login anthropic");
  });
});
