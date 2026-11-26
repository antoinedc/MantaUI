# Claude seat sign-in against the current Claude CLI (issue #1748)

## Problem

Adding (or re-signing) an Anthropic seat runs `claude auth login` on the box in a PTY. The card extracts the
OAuth link from the PTY output, the user opens it, pastes the code the page shows, and the code is written to the PTY.

1. **The link never appears.** Claude CLI 2.1.332 prints a different link than the one the card looks for.
2. **"That code didn't work"** after pasting the code, whatever really happened.

## Findings (reproduced locally against CLI 2.1.332 and 2.1.308 under a PTY, throwaway `CLAUDE_CONFIG_DIR`, no real login)

### Link (cause confirmed)

| CLI | What it prints |
|---|---|
| 2.1.308 (old) | `If the browser didn't open, visit: ␛]8;;https://claude.com/cai/oauth/authorize?<long query>␇…` |
| 2.1.332 (new) | `If the browser didn't open, visit:⏎ ␛]8;;https://claude.ai/oauth/authorize?<short opaque token>␇…` |

Both wrap the link in an OSC 8 hyperlink (BEL terminated; ST `␛\` must be tolerated too) and repeat it as visible text.
Two extractors (`src/server/claudeAuth.mjs`, `src/renderer/ConnectProvider.tsx`) only knew the host/path
`claude.com/cai/oauth/authorize`. They were two copies of the same regex, so a fix to one would not have reached the other.

A second latent defect in the renderer copy: it matched against its growing buffer and fired on the **first** match, so a
link split across two PTY chunks was accepted truncated. The new extractor only accepts a link that is followed by a
terminator (whitespace, BEL or ESC) — i.e. complete.

### Pasted code (submit path verified; the failure was being hidden)

Drove the CLI exactly as Manta does (code + `"\r"` written to the PTY, 30–80 columns):

- **`"\r"` submits correctly on the new TUI** (also `"\n"` and bracketed paste). No submit-path bug.
- **Code without a `#`** (e.g. the user copied only the first half): the CLI validates client-side, prints
  `That doesn't look like the full code. Copy all of it, including the # in the middle.`, re-prompts
  and **stays alive** — no exit. Manta saw no exit, no credentials: the card spun on "Saving…" until its 15-minute deadline.
- **Well-formed but rejected code** (expired / used / from another attempt): new CLI prints
  `Couldn't log in: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.`
  and exits **1**. Old CLI prints `Login failed: Request failed with status code 400` and exits 1.
- `AddSeatFlow` / `ResignSeatFlow` turned *any* non-zero exit into a fixed "That code didn't work (it may have expired)" and
  discarded what the CLI said (so e.g. an organization that blocks OAuth sign-in looked like a bad code).

## Design

1. `src/shared/claudeLoginOutput.mjs` (+ `.d.mts`) — pure, dependency-free, used by server **and** renderer:
   - `CLAUDE_OAUTH_URL_RE`: `https://claude.(com/cai|ai)/oauth/authorize?…`; stops at whitespace/BEL/ESC (so both the OSC 8
     payload and the visible text match, ST terminator included). A non-OAuth link (the trust prompt's security guide) never matches.
   - `extractClaudeAuthUrl(text, { complete })`: `complete: true` (streaming callers) requires the link to be followed by a terminator.
   - `claudeAuth.mjs` re-exports both, so existing imports keep working; `ConnectProvider.tsx` imports the shared one.
2. `src/renderer/claudeLoginFailure.ts` — pure helpers (uses `strip-ansi`):
   - `describeClaudeLoginFailure(rawOutput)` → a faithful sentence or `null`: maps `oauth_not_allowed_for_organization` →
     "Your organization doesn't allow signing in this way — ask your Claude Team admin."; "wasn't accepted" / HTTP 400 /
     `invalid_grant` → "That code didn't work (it may be incomplete, expired, already used, or from an earlier sign-in attempt)."; anything else →
     `Sign-in failed: <CLI's last meaningful line>` with URLs and token/code-like strings redacted and length capped; nothing captured → `null`.
   - `isClaudeCodeReprompt(rawOutput)` for the "doesn't look like the full code" case.
3. `useClaudeLoginExit` (SeatSignIn.tsx) accumulates the session's PTY output (capped) and hands `describe…()` to the flow on a failed exit;
   Add/Resign flows show it, falling back to today's copy only when nothing was captured.
4. After a submit, a short-lived PTY watcher spots the re-prompt and surfaces it as the card's `inputError`
   ("That doesn't look like the full code — copy all of it, including the # in the middle.") so Submit stops spinning and the user can retry in place.
   Used by the seat sign-in block and by the older Connect-provider Claude block.
5. No change to `"\r"` submission, to server pty code, or to the 15-minute limits.

Never shown in an error: the code, any token, the link.

## Libraries considered

| Need | Chosen | Considered / why not |
|---|---|---|
| Strip ANSI/OSC from PTY output (renderer) | `strip-ansi@^7.2.0` (MIT, 1 dep `ansi-regex`, ~708M downloads/week, 7.2.0 published 2026-02-26) as a devDependency (the renderer is bundled) | Hand-rolled regex: rejected, escape grammar (CSI / OSC with BEL or ST) is exactly what the library encodes. `util.stripVTControlCharacters`: Node only, the renderer is a browser bundle. The root already carried `strip-ansi@6.0.1` transitively (CJS, no ST support) — not declared by us, so not relied on; v7 is added as a direct dep and npm nests 6.0.1 for its existing consumers. `src/main/installer/stageMapper.ts` has a tiny `stripAnsi` for CSI only — main-process module, not importable from the renderer, and does not handle OSC. |
| OAuth link extraction | Own regex in `src/shared` | Nothing to adopt: matching one vendor-specific URL shape inside a byte stream; it must be a single source for server + renderer, which is the point of the module. |
| Failure-line mapping | Own pure helper | Product copy keyed on this CLI's wording; no library exists. |
| PTY handling / terminal rendering | unchanged (`node-pty`, xterm.js) | — |

## Test plan

- `src/server/claudeAuth.test.mjs`: old URL, new OSC 8 URL with BEL and with ST, split-chunk (`complete`) case, security-guide link never picked, existing cases still green.
- `src/shared/claudeLoginOutput.test.ts` (vitest): the real captured bytes of both CLIs through the shared extractor, incremental chunk feed.
- `src/renderer/claudeLoginFailure.test.ts`: real captured CLI lines → messages; org-not-allowed; unknown line sanitised (link/token redaction, no code echo); empty → `null`; re-prompt detection.
- Component tests (existing `SeatsPanel.test.tsx` / `ResignSeatFlow.test.tsx`): exit with captured output shows the faithful message; exit without output keeps today's copy; re-prompt stops the spinner and shows the input error.
- Real check: the shared extractor and failure helper run against bytes captured live from CLI 2.1.332/2.1.308; full `npm run typecheck && npm test` on a Freestyle VM.
