# iOS polish — six changes (2026-10-29)

Native app only (`mobile/native/`). No box-server or desktop change.

## 1. No work Inbox on the phone

Remove the tray button on the session list and the sheet it opens. Delete what that
leaves dead: `InboxWorkScreen`, `InboxWorkStore`, `InboxWorkModels`, the
`forge:inbox` / `delegate:start` client methods, `GitDelegateStartResult`, and their
tests. The chat "pending messages" inbox (`InboxModels`, `ChatInboxStore*`) is a
different thing and stays, as does the `forge-inbox-view-1` capability constant.
Files: `SessionListView`, `MantaAPIClient+Git`, `GitForgeModels`, the three Inbox*
sources, `InboxWork*Tests`, `Package.swift`.

## 2. No seat-move banner in a chat

Remove the one-line "Moved to Work · Seat 2 (…)" notice from the chat, with its
plumbing: `SeatMoveNotice`, `SeatMoveTracker`, `SeatMoveCandidate`, `SeatMoveEvent`
(and the `detail` on `AccountsBusEvent.moved`), `AccountsStore.moveNotice` + its
persistence, and their tests. The Accounts screen's own toasts, the box's
`lastMove` line and the "Switch seat?" confirmation are untouched.
Files: `ChatScreen`, `AccountsModels`, `AccountsStore`, `AccountsTests`,
`AccountsFlowTests`, `AccountsRPCWireTests`.

## 3. "Previous sessions" in the chat "…" sheet after a handoff

The list is read from the box's `handoff:list` → `chain.predecessors` (newest first:
nearest predecessor … oldest, then the session the chain was branched from; each
`{id, title?, deleted?, branchedFrom?}`), one request, rebuilt on every refresh. A
box without `chain` keeps the old one-request-per-hop walk of `links`. Rows: the
session's title, "Untitled session" when it has none, "Branched from <title>" for a
branch origin, a "Deleted" caption for a session the box no longer has. Tapping opens
the existing read-only `PreviousSessionScreen`.
Robustness: a read that never succeeded is retried (2s/4s/8s); the actions sheet
re-reads on open; a failed hop is no longer remembered as walked.
Files: `HandoffModels`, `HandoffStore`, `HandoffViews`, `ChatScreen`,
`HandoffModelsTests`.

## 4. Links in the transcript

Link detection **matches the desktop** (`src/renderer/linkify.ts`, spec
`2026-10-29-transcript-autolink.md`): the same matcher and the same rules, so a URL is
tappable on iOS exactly when it is a link on the desktop. `TranscriptLinkifyEngine`
ports linkify-it's matcher to `NSRegularExpression` (same regular expressions, same
candidate-picking loop, TLD list = the desktop allowlist); `TranscriptLinkify` layers
linkify.ts's rules on top: `http(s)://` URLs and `www.` hosts (href `https://` + text);
schemeless hosts only for the allowlist TLDs (`app`/`ai` only with a `/` path), never
after `/ \ . @ ~ - _ $ :` or a word character; `<`/`{`/`$` right after (or `:` then one
of them) makes it a placeholder, not a link; backticks and `= * ^ + | ~` before a
scheme/`www.` do not hide a URL; trailing `` ` * | ^ `` trimmed; no e-mail, no IPs, no
`mailto:`/`ftp:`. Only `http(s)` hrefs are opened. The desktop's `schemeless` modes
(`true` / `false` / `"whole"`) are `LinkifySchemeless` (`.yes` / `.no` / `.whole`).
- Prose (mode `.yes`): the markdown renderer has no GFM autolink, so
  `TranscriptMarkdownLinks` rewrites the source first — a link becomes `<url>` (or
  `[text](<href>)` for `www.`/schemeless). Inline code uses `.whole` like the desktop:
  a URL inside the span becomes a link (a code chip) and the rest stays code; a span
  that is one schemeless host (`` `mantaui.com` ``) links as a whole. Fenced code,
  existing links, `<autolinks>`/HTML and reference definitions are left alone.
- Plain text, mode `.yes` as on the desktop's matching surfaces: user prompt, live
  streaming tail, reasoning, tool output (activity sheet, step output), expanded
  `/command` text — `AttributedString` link runs.
Files: `TranscriptLinkify` + `TranscriptLinkifyEngine` (Foundation-only,
Linux-testable), `TranscriptLinkifyView`, `TranscriptComponents`,
`TranscriptReasoning`, `TranscriptCommand`, `ActivitySheet`, `TranscriptLinkifyTests`
(mirrors `linkify.test.ts` case for case).

## 5. Show more / Show less on user prompts

A user prompt longer than four lines shows its first four with a "Show more"
toggle; expanded shows "Show less"; short prompts show no toggle. The hidden part is
detected by measuring the whole text against the clamped text. Expansion lives in a
shared store keyed by the row's `stableScrollID` (a user block carries no message
id; that id is what the list itself recycles and refetches by), not in the cell's
`@State`, so a recycled cell keeps it. Row identity is unchanged.
Files: `UserPromptClamp`, `TranscriptExpansionStore`, `TranscriptComponents`
(`UserBand`), `TranscriptRow`, `UserPromptClampTests`.

## 6. Switch-session sheet from a chat lists that project only

Opened from a chat, the switcher lists only that chat's project (tmux session), most
recent activity first. Signal: `SessionListStore.lastActivity(for:)` — opencode's
`time.updated` for the session joined with the running/idle transitions seen live,
the same value the Latest-activity ordering uses. Chat windows with no activity known
yet follow the dated ones, terminal windows last. Background-job windows stay out.
The terminal screen's switcher, and a project the box no longer lists, still search
every project (most recently opened first).
Files: `MantaNavigation`, `SessionSwitcherLogic`, `SessionListStore`,
`SessionSwitcherSheet`, `SessionListView`, `ChatScreen`, `SessionActivityOrderTests`,
`MantaNavigationTests`.
