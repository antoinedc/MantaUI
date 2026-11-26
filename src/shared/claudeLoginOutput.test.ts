import { describe, it, expect } from "vitest";
import { CLAUDE_OAUTH_URL_RE, extractClaudeAuthUrl } from "./claudeLoginOutput.mjs";

// Output of `claude auth login` captured under a PTY (tokens replaced by fakes).
const NEW_URL = "https://claude.ai/oauth/authorize?FAKE-token_0123456789abcdefghijklmnopqrstuvwxyz";
const CLI_2_1_332 =
  "Opening browser to sign in…\r\nIf the browser didn't open, visit:\r\n" +
  `\x1b]8;;${NEW_URL}\x07\x1b[94m${NEW_URL}\x1b[39m\x1b]8;;\x07\r\nPaste code here if prompted > `;

const OLD_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-0000-0000-000000000000&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key&code_challenge=FAKEchallenge&code_challenge_method=S256&state=FAKEstate";
const CLI_2_1_308 =
  "Opening browser to sign in…\r\nIf the browser didn't open, visit: " +
  `\x1b]8;;${OLD_URL}\x07\x1b[94m${OLD_URL}\x1b[39m\x1b]8;;\x07\r\nPaste code here if prompted > `;

const TRUST_PROMPT = "Security guide: https://docs.claude.com/en/docs/claude-code-security\r\n";

// Feed `text` the way a PTY would: in chunks of `size`, extracting from the growing buffer each time.
function feed(text: string, size: number): Array<string | null> {
  const seen: Array<string | null> = [];
  let buffer = "";
  for (let i = 0; i < text.length; i += size) {
    buffer += text.slice(i, i + size);
    seen.push(extractClaudeAuthUrl(buffer, { complete: true }));
  }
  return seen;
}

describe("extractClaudeAuthUrl on captured CLI output", () => {
  it("CLI 2.1.332: claude.ai link inside the OSC 8 hyperlink (BEL)", () => {
    expect(extractClaudeAuthUrl(CLI_2_1_332)).toBe(NEW_URL);
    expect(extractClaudeAuthUrl(CLI_2_1_332, { complete: true })).toBe(NEW_URL);
  });

  it("CLI 2.1.308: claude.com/cai link still works", () => {
    expect(extractClaudeAuthUrl(CLI_2_1_308)).toBe(OLD_URL);
    expect(extractClaudeAuthUrl(CLI_2_1_308, { complete: true })).toBe(OLD_URL);
  });

  it("accepts the ST terminator (ESC \\) too", () => {
    const st = CLI_2_1_332.replaceAll("\x07", "\x1b\\");
    expect(extractClaudeAuthUrl(st)).toBe(NEW_URL);
    expect(extractClaudeAuthUrl(st, { complete: true })).toBe(NEW_URL);
  });

  it("never picks the trust prompt's link", () => {
    expect(extractClaudeAuthUrl(TRUST_PROMPT)).toBeNull();
    expect(extractClaudeAuthUrl(TRUST_PROMPT + CLI_2_1_332)).toBe(NEW_URL);
  });

  it.each([1, 3, 7, 16, 50])("incremental feed in %i-byte chunks: null until the link is complete, never truncated", (size) => {
    for (const [out, url] of [
      [CLI_2_1_332, NEW_URL],
      [CLI_2_1_308, OLD_URL],
    ] as const) {
      const seen = feed(out, size);
      for (const s of seen) expect(s === null || s === url).toBe(true);
      expect(seen[seen.length - 1]).toBe(url);
    }
  });

  it("the exported pattern matches both hosts", () => {
    expect(CLAUDE_OAUTH_URL_RE.flags).toContain("g");
    expect(CLI_2_1_332.match(CLAUDE_OAUTH_URL_RE)).toHaveLength(2); // hyperlink payload + visible text
    expect(CLI_2_1_308.match(CLAUDE_OAUTH_URL_RE)).toHaveLength(2);
  });
});
