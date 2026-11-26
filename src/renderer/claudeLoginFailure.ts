// What `claude auth login` said when a seat sign-in did not work (issue #1748).
//
// The card used to turn every failed exit into one fixed "that code didn't work"
// sentence, so an organization that blocks OAuth sign-in, an expired code and a
// rejected request all looked the same. These helpers read the CLI's own output
// (PTY bytes) and produce a faithful sentence. Pure; nothing here ever returns the
// code, a token or the sign-in link.
//
// Verified CLI wording (2.1.332 / 2.1.308):
//   bad code, new CLI : "Couldn't log in: That code wasn't accepted. It may be incomplete, expired, …"  (exit 1)
//   bad code, old CLI : "Login failed: Request failed with status code 400"                              (exit 1)
//   no `#` in the code: "That doesn't look like the full code. Copy all of it, including the # in the
//                        middle." — the CLI re-prompts and keeps running (no exit).

import stripAnsi from "strip-ansi";

export const CLAUDE_ORG_BLOCKED_MESSAGE =
  "Your organization doesn't allow signing in this way — ask your Claude Team admin.";
export const CLAUDE_CODE_REJECTED_MESSAGE =
  "That code didn't work (it may be incomplete, expired, already used, or from an earlier sign-in attempt).";
export const CLAUDE_CODE_REPROMPT_MESSAGE =
  "That doesn't look like the full code — copy all of it, including the # in the middle.";

const MAX_LINE_CHARS = 160;
const REPROMPT_RE = /doesn['’]t look like the full code/i;
const ORG_BLOCKED_RE =
  /oauth_not_allowed_for_organi[sz]ation|not allowed for (?:your |this )?organi[sz]ation|organi[sz]ation (?:does not|doesn['’]t) allow/i;
const CODE_REJECTED_RE = /wasn['’]t accepted|invalid_grant|status code 400|invalid (?:authorization )?code|code (?:has )?expired/i;

// Lines the CLI prints on the way to the failure — never the failure itself.
const NOISE_RES = [/^opening browser/i, /browser didn['’]t open/i, /paste code here/i, /^signing in/i, REPROMPT_RE];

function cleanLines(raw: string): string[] {
  return stripAnsi(raw)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The CLI's own "that doesn't look like the full code" re-prompt is in this output. */
export function isClaudeCodeReprompt(raw: string): boolean {
  return REPROMPT_RE.test(stripAnsi(raw));
}

/** One CLI line made safe to show: links and anything token- or code-like are removed, length is capped. */
export function sanitizeCliLine(line: string): string {
  let s = line
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/[A-Za-z0-9_-]{16,}(?:#[A-Za-z0-9_-]*)?/g, "[redacted]")
    .replace(/\S{6,}#\S+/g, "[redacted]")
    .trim();
  if (s.length > MAX_LINE_CHARS) s = `${s.slice(0, MAX_LINE_CHARS - 1)}…`;
  return s;
}

/**
 * A sentence describing why `claude auth login` failed, from everything it printed
 * (ANSI/OSC are stripped here), or null when it printed nothing usable — the caller
 * then keeps its generic copy.
 */
export function describeClaudeLoginFailure(raw: string): string | null {
  const lines = cleanLines(raw);
  const text = lines.join("\n");
  if (ORG_BLOCKED_RE.test(text)) return CLAUDE_ORG_BLOCKED_MESSAGE;
  if (CODE_REJECTED_RE.test(text)) return CLAUDE_CODE_REJECTED_MESSAGE;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // A line without a space is the sign-in link or an echo of the typed code, not a message.
    if (!/\s/.test(line) || NOISE_RES.some((re) => re.test(line))) continue;
    const safe = sanitizeCliLine(line);
    if (!safe) return null;
    return `Sign-in failed: ${/[.!?…]$/.test(safe) ? safe : `${safe}.`}`;
  }
  return null;
}
