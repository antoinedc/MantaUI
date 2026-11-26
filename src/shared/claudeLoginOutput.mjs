// Reading the output of `claude auth login` — shared by the box and the renderer so
// the two can never drift apart again (issue #1748: a CLI release changed the link
// and one hand-copied regex per side kept looking for the old one).
//
// Verified shapes of the sign-in link (CLI 2.1.308 / 2.1.332), always an OSC 8
// hyperlink (`ESC ] 8 ; ; <url> BEL`, ST `ESC \` is tolerated too) followed by the
// same link as visible text:
//   2.1.308  https://claude.com/cai/oauth/authorize?code=true&client_id=…&state=…
//   2.1.332  https://claude.ai/oauth/authorize?<short opaque token>
// The match stops at whitespace, BEL or ESC, so the payload of the hyperlink, its
// visible text and a plain link all match. Filtering on the authorize path (not on
// "the first https://") is load-bearing: the trust prompt's "Security guide" link is
// also an https link and must never be picked.

export const CLAUDE_OAUTH_URL_RE =
  /https:\/\/claude\.(?:com\/cai|ai)\/oauth\/authorize\?[^\s\x07\x1b]+/g;

// The same match, but only when something that ends a link follows it. A PTY delivers
// output in arbitrary chunks, so a growing buffer can end in the middle of the link.
const CLAUDE_OAUTH_URL_COMPLETE_RE =
  /https:\/\/claude\.(?:com\/cai|ai)\/oauth\/authorize\?[^\s\x07\x1b]+(?=[\s\x07\x1b])/;

/**
 * Pull the Claude OAuth authorize URL out of the (accumulated) output of
 * `claude auth login`. Returns the FIRST match — the link stays on screen until the
 * sign-in ends, so the first match is the live one — or null.
 *
 * `complete: true` is for streaming callers: a link that reaches the end of the text
 * without a terminator may still be arriving, so it is not returned yet.
 *
 * Trailing punctuation that can ride in from a parenthesised wrap (`)].,;`) is stripped.
 *
 * @param {unknown} text
 * @param {{ complete?: boolean }} [opts]
 * @returns {string|null}
 */
export function extractClaudeAuthUrl(text, { complete = false } = {}) {
  if (typeof text !== "string" || text.length === 0) return null;
  const m = complete ? text.match(CLAUDE_OAUTH_URL_COMPLETE_RE) : text.match(CLAUDE_OAUTH_URL_RE);
  if (!m) return null;
  return (Array.isArray(m) ? m[0] : m).replace(/[\]).,;]+$/, "");
}
