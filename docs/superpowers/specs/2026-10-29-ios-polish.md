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

`http://`, `https://` and `mailto:` URLs are tappable wherever the transcript shows
text. Only those schemes — no schemeless hosts (`install.sh`), no `www.`, no bare
e-mail addresses. Foundation's `NSDataDetector` was not used: it links schemeless
names (every file extension that is also a TLD), and its handling of placeholders and
trailing punctuation cannot be pinned down without running it. A small scanner
(`TranscriptLinkify`) carries the desktop's rules (`src/renderer/linkify.ts`):
trailing `. , ; : ! ? ' * ^ |` and an unbalanced `)` are dropped, balanced parentheses
stay, `http://localhost:<port>` / `{host}` / `$PORT` are placeholders, not links, a
URL glued to a word or path is not one.
- Prose: the markdown renderer has no GFM autolink, so `TranscriptMarkdownLinks`
  rewrites the source first — a bare URL becomes `<url>`; inside an inline-code span
  only the URL becomes a link (a code chip), the rest of the span stays code. Fenced
  code, existing links, `<autolinks>`/HTML and reference definitions are left alone.
- Plain text: user prompt, live streaming tail, reasoning, tool output (activity
  sheet, step output), expanded `/command` text — `AttributedString` link runs.
Files: `TranscriptLinkify` (Foundation-only, Linux-testable), `TranscriptLinkifyView`,
`TranscriptComponents`, `TranscriptReasoning`, `TranscriptCommand`, `ActivitySheet`,
`TranscriptLinkifyTests`.

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
