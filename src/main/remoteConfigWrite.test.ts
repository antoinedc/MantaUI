import { describe, it, expect } from "vitest";
import {
  buildRemoteConfigWriteCmd,
  extractHeredocBody,
  REMOTE_CONFIG_HEREDOC_DELIM,
} from "./remoteConfigWrite";

// Reconstructs the OLD buggy command so we can prove, in the same test file,
// (a) that it corrupted the file and (b) that the new builder does not.
function legacyBuggyCmd(content: string, remotePath: string): string {
  // Verbatim shape of the pre-fix code at index.ts:663.
  return `mkdir -p ~/.config/opencode && printf '%s' ${JSON.stringify(
    content,
  )} > ${remotePath}`;
}

describe("buildRemoteConfigWriteCmd — opencode.jsonc corruption regression", () => {
  const PATH = "~/.config/opencode/opencode.jsonc";

  it("round-trips JSON content byte-for-byte (no double-encoding)", () => {
    // EXACT scenario from the 2026-05-18 incident: index.ts builds this via
    // JSON.stringify(merged, null, 2) and must write it UNCHANGED.
    const merged = { skills: { urls: [] as string[] } };
    const content = JSON.stringify(merged, null, 2);

    const cmd = buildRemoteConfigWriteCmd(content, PATH);
    const written = extractHeredocBody(cmd);

    expect(written).toBe(content);
    // The written bytes must be valid JSON — the property opencode needs.
    expect(() => JSON.parse(written)).not.toThrow();
    expect(JSON.parse(written)).toEqual(merged);
  });

  it("does NOT emit the literal backslash-n corruption the old code did", () => {
    const content = JSON.stringify({ skills: { urls: [] } }, null, 2);

    // Prove the OLD command was broken: the value it interpolated is
    // JSON.stringify(content) — escaped newlines, wrapped in quotes.
    const legacy = legacyBuggyCmd(content, PATH);
    expect(legacy).toContain('\\n'); // literal backslash-n present (the bug)
    expect(legacy).toContain('\\"'); // escaped quotes (the bug)

    // The new command's body has REAL newlines and REAL quotes, no escaping.
    const written = extractHeredocBody(buildRemoteConfigWriteCmd(content, PATH));
    expect(written).not.toContain("\\n");
    expect(written).toContain("\n"); // an actual newline char
    expect(written).toContain('"skills"'); // unescaped JSON
  });

  it("preserves shell-hostile content (quotes, $, backticks, backslashes)", () => {
    // skills.urls can hold arbitrary URLs / future config may hold anything.
    // A single-quoted heredoc must pass all of it through untouched.
    const content = JSON.stringify(
      {
        skills: {
          urls: [
            "https://ex.com/$(whoami)",
            "https://ex.com/`id`",
            'https://ex.com/"quote"',
            "https://ex.com/back\\slash",
          ],
        },
      },
      null,
      2,
    );
    const written = extractHeredocBody(
      buildRemoteConfigWriteCmd(content, PATH),
    );
    expect(written).toBe(content);
    expect(JSON.parse(written)).toEqual(JSON.parse(content));
  });

  it("creates the parent directory and targets the right path", () => {
    const cmd = buildRemoteConfigWriteCmd("{}", PATH);
    expect(cmd).toContain("mkdir -p ~/.config/opencode");
    expect(cmd).toContain(`cat > ${PATH} <<'${REMOTE_CONFIG_HEREDOC_DELIM}'`);
  });

  it("emits a path that still allows ~ expansion (unquoted, trusted path)", () => {
    const cmd = buildRemoteConfigWriteCmd("{}", PATH);
    // Tilde must NOT be single-quoted (that would write to a literal ./~/...)
    expect(cmd).not.toContain(`'${PATH}'`);
    expect(cmd).toContain(`> ${PATH} `);
  });

  it("refuses to emit a corrupt command if content collides with the delimiter", () => {
    const evil = `{\n${REMOTE_CONFIG_HEREDOC_DELIM}\n}`;
    expect(() => buildRemoteConfigWriteCmd(evil, PATH)).toThrow(
      /heredoc delimiter/,
    );
  });

  it("body ends on its own line so the closing delimiter is recognized", () => {
    const content = '{\n  "a": 1\n}';
    const cmd = buildRemoteConfigWriteCmd(content, PATH);
    // Exact tail: <content>\n<delim>, delim at start of its line.
    expect(cmd.endsWith(`\n${content}\n${REMOTE_CONFIG_HEREDOC_DELIM}`)).toBe(
      true,
    );
  });
});
