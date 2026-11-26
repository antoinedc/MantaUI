import { describe, it, expect } from "vitest";
import { extractClaudeAuthUrl } from "../shared/claudeLoginOutput.mjs";
import {
  CLAUDE_CODE_REJECTED_MESSAGE,
  CLAUDE_ORG_BLOCKED_MESSAGE,
  describeClaudeLoginFailure,
  isClaudeCodeReprompt,
  sanitizeCliLine,
} from "./claudeLoginFailure";

// Bytes captured from `claude auth login` (2.1.332 / 2.1.308) under a PTY, token replaced.
const TOKEN = "FAKE-token_0123456789abcdefghijklmnopqrstuvwxyz";
const URL_NEW = `https://claude.ai/oauth/authorize?${TOKEN}`;
const BANNER_NEW =
  "Opening browser to sign in…\r\nIf the browser didn't open, visit:\r\n" +
  `\x1b]8;;${URL_NEW}\x07\x1b[94m${URL_NEW}\x1b[39m\x1b]8;;\x07\r\nPaste code here if prompted > `;
const CODE = "abcdEFGH1234#wxyzSTATE5678";
const REJECTED_NEW =
  `${CODE}\r\r\nSigning in…\r\nCouldn't log in: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\r\n\x1b[?25h`;
const REJECTED_OLD = `${CODE}\r\r\nLogin failed: Request failed with status code 400\r\n\x1b[?25h`;
const REPROMPT =
  "x\r\r\nThat doesn't look like the full code. Copy all of it, including the # in the middle.\r\nPaste code here if prompted > ";

describe("sign-in link (shared extractor, renderer's streaming mode)", () => {
  it("reads the current CLI's claude.ai link once the whole link has arrived", () => {
    expect(extractClaudeAuthUrl(BANNER_NEW, { complete: true })).toBe(URL_NEW);
  });

  it("never returns a link cut off by a chunk boundary", () => {
    const cut = BANNER_NEW.indexOf(TOKEN) + 12;
    expect(extractClaudeAuthUrl(BANNER_NEW.slice(0, cut), { complete: true })).toBeNull();
    expect(extractClaudeAuthUrl(BANNER_NEW.slice(0, cut + 3), { complete: true })).toBeNull();
    expect(extractClaudeAuthUrl(BANNER_NEW, { complete: true })).toBe(URL_NEW);
  });

  it("still reads the old CLI's claude.com/cai link", () => {
    const old = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=BCqk";
    expect(extractClaudeAuthUrl(`visit: \x1b]8;;${old}\x07\x1b[94m${old}\x1b[39m\x1b]8;;\x07\r\n`, { complete: true })).toBe(old);
  });
});

describe("describeClaudeLoginFailure", () => {
  it("maps the new CLI's rejected-code message", () => {
    expect(describeClaudeLoginFailure(BANNER_NEW + REJECTED_NEW)).toBe(CLAUDE_CODE_REJECTED_MESSAGE);
  });

  it("maps the old CLI's HTTP 400", () => {
    expect(describeClaudeLoginFailure(BANNER_NEW + REJECTED_OLD)).toBe(CLAUDE_CODE_REJECTED_MESSAGE);
  });

  it("maps an organization that blocks OAuth sign-in", () => {
    const out = `${BANNER_NEW}${CODE}\r\nSigning in…\r\nLogin failed: oauth_not_allowed_for_organization\r\n`;
    expect(describeClaudeLoginFailure(out)).toBe(CLAUDE_ORG_BLOCKED_MESSAGE);
  });

  it("shows an unknown CLI line, sanitised, never the code, a token or the link", () => {
    const out = `${BANNER_NEW}${CODE}\r\nSigning in…\r\nCouldn't log in: Network is unreachable (${URL_NEW}) for ${CODE} token ${TOKEN}\r\n`;
    const msg = describeClaudeLoginFailure(out)!;
    expect(msg).toMatch(/^Sign-in failed: Couldn't log in: Network is unreachable/);
    expect(msg).not.toContain(CODE);
    expect(msg).not.toContain("wxyzSTATE");
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain("claude.ai");
  });

  it("caps a very long line", () => {
    const msg = describeClaudeLoginFailure(`Boom ${"word ".repeat(200)}\r\n`)!;
    expect(msg.length).toBeLessThan(200);
    expect(msg.endsWith("…")).toBe(true);
  });

  it("returns null when the CLI printed nothing usable (the caller keeps its generic copy)", () => {
    expect(describeClaudeLoginFailure("")).toBeNull();
    expect(describeClaudeLoginFailure(BANNER_NEW)).toBeNull();
    expect(describeClaudeLoginFailure(`${BANNER_NEW}${CODE}\r\nSigning in…\r\n`)).toBeNull();
    expect(describeClaudeLoginFailure(BANNER_NEW + REPROMPT)).toBeNull();
  });
});

describe("isClaudeCodeReprompt", () => {
  it("recognises the CLI asking again for a code with no #", () => {
    expect(isClaudeCodeReprompt(REPROMPT)).toBe(true);
    // terminal styling inside the sentence does not hide it
    expect(isClaudeCodeReprompt("That doesn't look like the \x1b[1mfull\x1b[22m code")).toBe(true);
  });

  it("is false for the banner and for a rejected code", () => {
    expect(isClaudeCodeReprompt(BANNER_NEW)).toBe(false);
    expect(isClaudeCodeReprompt(REJECTED_NEW)).toBe(false);
  });
});

describe("sanitizeCliLine", () => {
  it("replaces links and code/token-like strings", () => {
    expect(sanitizeCliLine(`see https://claude.ai/x?y=1 and ${CODE}`)).toBe("see [link] and [redacted]");
  });
});
