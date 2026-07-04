import { describe, it, expect } from "vitest";
import {
  parseProbeOutput,
  mergeOpencodeJsonc,
  stripLineComments,
} from "./setup.js";

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

describe("stripLineComments", () => {
  it("strips a real // line comment", () => {
    expect(stripLineComments(`{ // hi\n "a": 1 }`)).toBe(`{ \n "a": 1 }`);
  });

  it("does NOT strip // inside a string literal (the naive-regex bug)", () => {
    const s = `{"$schema":"https://opencode.ai/config.json"}`;
    expect(stripLineComments(s)).toBe(s);
  });

  it("respects escaped quotes inside strings", () => {
    const s = `{"q":"a \\" // not a comment", "x": 1}`;
    expect(stripLineComments(s)).toBe(s);
  });

  it("handles a URL inside an array entry", () => {
    const s = `{"plugin":["foo@1.0","https://example.com/p"]}`;
    expect(stripLineComments(s)).toBe(s);
  });

  it("preserves newlines so the rest of the file parses", () => {
    const input = `{\n// comment\n"a":1\n}`;
    // Newline after the stripped comment is preserved.
    expect(stripLineComments(input)).toBe(`{\n\n"a":1\n}`);
  });

  it("strips a // at end of file (no trailing newline)", () => {
    expect(stripLineComments(`{"a":1} // trailing`)).toBe(`{"a":1} `);
  });
});

describe("mergeOpencodeJsonc", () => {
  // Pretty-printed bytes are sensitive to whitespace; parse-and-compare
  // for shape, then assert on the literal where text shape matters.
  const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

  it("writes a minimal config when existing is empty", () => {
    const r = mergeOpencodeJsonc("");
    expect(r.changed).toBe(true);
    const cfg = parse(r.content);
    expect(cfg.plugin).toEqual(["opencode-claude-auth-bui@1.5.4-bui.1"]);
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
  });

  it("writes a minimal config when existing is only whitespace", () => {
    const r = mergeOpencodeJsonc("   \n  \n");
    expect(r.changed).toBe(true);
    expect(parse(r.content).plugin).toEqual(["opencode-claude-auth-bui@1.5.4-bui.1"]);
  });

  it("appends auth plugin to an existing plugin array, preserving order", () => {
    const existing = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: ["other-plugin@1.0"],
      model: "anthropic/claude-opus-4-7",
    });
    const r = mergeOpencodeJsonc(existing);
    expect(r.changed).toBe(true);
    const cfg = parse(r.content);
    expect(cfg.plugin).toEqual([
      "other-plugin@1.0",
      "opencode-claude-auth-bui@1.5.4-bui.1",
    ]);
    // Other top-level keys must be preserved verbatim.
    expect(cfg.model).toBe("anthropic/claude-opus-4-7");
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
  });

  it("creates plugin array when config has none, preserving other keys", () => {
    const existing = JSON.stringify({
      model: "anthropic/claude-opus-4-7",
      keymap: { quit: "ctrl+q" },
    });
    const r = mergeOpencodeJsonc(existing);
    expect(r.changed).toBe(true);
    const cfg = parse(r.content);
    expect(cfg.plugin).toEqual(["opencode-claude-auth-bui@1.5.4-bui.1"]);
    expect(cfg.model).toBe("anthropic/claude-opus-4-7");
    expect(cfg.keymap).toEqual({ quit: "ctrl+q" });
  });

  it("is a no-op when the fork is already present (pinned version)", () => {
    const existing = JSON.stringify({
      plugin: ["opencode-claude-auth-bui@1.5.4-bui.1"],
    });
    const r = mergeOpencodeJsonc(existing);
    expect(r.changed).toBe(false);
    expect(parse(r.content).plugin).toEqual(["opencode-claude-auth-bui@1.5.4-bui.1"]);
  });

  it("is a no-op when the UPSTREAM plugin is already present — fork is NOT appended", () => {
    // A user who already runs the upstream `opencode-claude-auth` must NOT
    // get the fork appended on re-bootstrap. Both names are accepted as
    // "auth is wired up"; the user's existing choice is respected.
    const existing = JSON.stringify({
      plugin: ["opencode-claude-auth@latest"],
    });
    const r = mergeOpencodeJsonc(existing);
    expect(r.changed).toBe(false);
    expect(parse(r.content).plugin).toEqual(["opencode-claude-auth@latest"]);
  });

  it("respects a user's custom pinned version of the upstream plugin (no overwrite)", () => {
    const existing = JSON.stringify({
      plugin: ["opencode-claude-auth@0.3.1"],
    });
    const r = mergeOpencodeJsonc(existing);
    expect(r.changed).toBe(false);
    expect(parse(r.content).plugin).toEqual(["opencode-claude-auth@0.3.1"]);
  });

  it("respects a user's custom pinned version of the fork (no overwrite)", () => {
    const existing = JSON.stringify({
      plugin: ["opencode-claude-auth-bui@2.0.0"],
    });
    const r = mergeOpencodeJsonc(existing);
    expect(r.changed).toBe(false);
    expect(parse(r.content).plugin).toEqual(["opencode-claude-auth-bui@2.0.0"]);
  });

  it("recognizes the upstream plugin by bare package name (no @version suffix)", () => {
    const existing = JSON.stringify({
      plugin: ["opencode-claude-auth"],
    });
    const r = mergeOpencodeJsonc(existing);
    expect(r.changed).toBe(false);
  });

  it("recognizes the fork by bare package name (no @version suffix)", () => {
    const existing = JSON.stringify({
      plugin: ["opencode-claude-auth-bui"],
    });
    const r = mergeOpencodeJsonc(existing);
    expect(r.changed).toBe(false);
  });

  it("strips // line comments before parsing (real-world JSONC)", () => {
    const existing = `{
      // user note: pinned for OAuth fix
      "plugin": ["opencode-claude-auth@1.2.0"]
    }`;
    const r = mergeOpencodeJsonc(existing);
    expect(r.changed).toBe(false);
  });

  it("replaces unparseable input with a minimal config (caller backs up)", () => {
    const r = mergeOpencodeJsonc("{ this is not valid jsonc");
    expect(r.changed).toBe(true);
    expect(r.detail).toContain("unparseable");
    expect(parse(r.content).plugin).toEqual(["opencode-claude-auth-bui@1.5.4-bui.1"]);
  });

  it("treats a non-array `plugin` field as no array and creates a new one", () => {
    const existing = JSON.stringify({
      plugin: "string-not-array",
      other: 42,
    });
    const r = mergeOpencodeJsonc(existing);
    expect(r.changed).toBe(true);
    const cfg = parse(r.content);
    // We REPLACE the malformed value with a fresh array — the alternative
    // (preserving the string) would yield an invalid config opencode would
    // reject. Other keys still preserved.
    expect(cfg.plugin).toEqual(["opencode-claude-auth-bui@1.5.4-bui.1"]);
    expect(cfg.other).toBe(42);
  });

  it("treats top-level JSON arrays as unparseable (not a config object)", () => {
    // opencode.jsonc must be an object at the top level.
    const r = mergeOpencodeJsonc("[1, 2, 3]");
    expect(r.changed).toBe(true);
    expect(r.detail).toContain("unparseable");
  });
});
