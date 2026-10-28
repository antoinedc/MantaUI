# WS05 — Git, pull requests, review, work inbox (iOS)

Status: draft, revised after review round 2 · Wave: **C** (runs alone) · Owner prefix: `Git*`, `Review*`, `Inbox*`
Depends on (all land before wave C): WS02 (ChatScreen, read-only job state
`ChatSessionStore.isBackgroundJobReadOnly`), WS03 (C3 `ComposerTextController`
adopted in `ChatScreen`, `EnvironmentValues.composerController`), WS04 (C2
`MantaNavigator` + `startNewSession`, D14 `GitHubDeviceSignInView`), WS10 (D16/D21 `forgeStatus(validate:) ->
ForgeConnectionStatus`).

This workstream brings the desktop's GitHub surface to the phone: the branch/PR
sheet behind the chat's branch chip, the checks chip, the "Connect GitHub"
offer (sign-in itself is WS04's shared view, D5/D14), the review screen (PR
diff, line comments, threads, verdict, submit) and the work inbox.

**Server-first (D23/D24).** The box owns the rules: PR panel/ship/merge state,
checks view, failure prompt, error copy, the structured review diff with
thread/draft placement, and the inbox row fields are computed by two new
modules (`src/server/forge/view.mjs`, `src/server/forge/diffView.mjs`) and
returned as **additive fields on the existing** `forge:*` channels — see
"Server-first" below. No new channel names. The desktop switches to the same
fields in this workstream. Otherwise every feature uses the existing `forge:*`,
`delegate:start` and `config:*` RPC channels exactly as the desktop does. The
only Electron-local pieces on desktop are `openExternal` (→ iOS `openURL`) and
`clipboardWriteText` (→ `UIPasteboard`). No `/events` frames are involved: the
box publishes `forge-draft.updated` (`src/server/forge/draft.mjs:173…249`) and
`forge.inbox.invalidated` (`src/server/index.mjs:1353`) on its bus, but no
client consumes them — the desktop is poll/refetch-driven and iOS matches.

---

## 0. Naming collision — read first

`mobile/native/MantaUI/InboxModels.swift` already exists (owned by WS02, D1) and
is **the pending messages inbox** (V2 steer/queue), unrelated to this work. It
already declares `InboxItem`, `InboxSnapshot`, `InboxDelivery`. Therefore:

- Work-inbox files are named `InboxWork*.swift` (inside the `Inbox*` prefix);
  **never edit `InboxModels.swift`**.
- Work-inbox types are named `WorkInbox*` (e.g. `WorkInboxItem`), never
  `InboxItem`.
- All forge wire types WS05 declares are prefixed `Git*` (e.g.
  `GitPullRequest`). The forge **status** type is WS10's (D16) and the device
  sign-in types are WS04's (D14); WS05 declares neither.

---

## 1. Shared wire contract (all features)

All calls go through `MantaAPIClient.call/callRequired` (internal per C1). WS05
adds only the methods in "Client members" (§12) to
`MantaUI/MantaAPIClient+Git.swift`, and **consumes** members other specs own:

| Consumed member | Owner (D16) | Channel |
|---|---|---|
| `forgeStatus(validate: Bool) async throws -> ForgeConnectionStatus` (`connected`, `login`, `kind`, `source`, `valid`; type in WS10's `SettingsWireModels.swift`) | WS10, `MantaAPIClient+Settings.swift` (wave A1; D16/D21) | `forge:status` `[{validate}]` — WS05 always passes `validate: false` (desktop `ChatPanel.tsx:1055` calls it with no args; `rpc.mjs:952` → `validate === true` only when asked) |
| `GitHubDeviceSignInView(onConnected:onCancel:)` (+ WS04's `GitHubDeviceSignInStore`, `forgeDeviceStart/Poll/Cancel`) | WS04 (D14) | `forge:device-*` — WS05 never calls the `forgeDevice*` members; it only presents the view |
| `configGet()` / `configUpdate(_:)` | existing (`MantaAPIClient.swift:752,757`) | `config:get` / `config:update` |
| `projects()` | existing (`MantaAPIClient.swift:192`) | `tmux:list` |

WS05's own channels (server handlers `src/server/rpc.mjs:944-1075`,
implementations `src/server/forge/index.mjs`; args shape as
`src/renderer/api/httpApi.ts:850-881`, one JSON object in `args[0]`):

| Channel | args[0] | Result (TS source) |
|---|---|---|
| `forge:pull-request` | `{cwd}` | `ForgePullRequestResult` (types.ts:655) + `view`, toned/ordered `checks` (S.1) |
| `forge:ship-preview` | `{cwd, model?:{providerID,modelID}, sessionId?}` | `ForgeShipPreviewResult` (types.ts:781) |
| `forge:ship` | `{cwd, title, body}` | `ForgeShipResult` (types.ts:759) |
| `forge:merge` | `{cwd, number, method:"merge", sha}` | `ForgeMergeResult` (types.ts:802) |
| `forge:diff` | `GitRef` | `ForgeDiffResult` (types.ts:701) + `files`, `threads[].placement`, `draft`, `message` (S.2) |
| `forge:draft-get` | `GitRef` | `ForgeDraftGetResult` (types.ts:842) |
| `forge:draft-comment` | `GitRef ∪ {op, comment?, verdict?}` | `ForgeDraftCommentResult` (types.ts:866) |
| `forge:draft-submit` | `GitRef ∪ {verdict?}` | `ForgeDraftSubmitResult` (types.ts:878) |
| `forge:thread-reply` | `GitRef ∪ {threadId, body}` | `ForgeThreadReplyResult` (types.ts:890) |
| `forge:inbox` | none (`args: []`) | `ForgeInboxResult` (types.ts:741) + per-item row fields and `localPath` (S.1) |
| `delegate:start` | `{prompt, sessionID, directory}` | `{ok, error?}` (types.ts:2643-2649; rpc.mjs:2448) |

`GitRef` is the forge target (types.ts:691):

```swift
enum GitRef: Hashable, Sendable {
    case cwd(String)                          // → {"cwd": path}
    case pr(repoKey: String, number: Int)     // → {"repoKey": k, "number": n}
    var json: [String: Any] { … }
}
```

WS05 no longer calls `git:add-worktree` or `tmux:new-session` (D12: the inbox
hands a draft to WS04's create sheet, which creates on Create).

**Decoding rules** (WS05 wire types live in `GitForgeModels.swift`,
Foundation-only):

- Every type is `Decodable` with `decodeIfPresent` + defaults for every field
  except identity fields, so a new/missing field never drops the payload.
- `PullRequest.mergeable` is `true | false | null` → `Bool?` (null = still computing).
- `PullRequest.state` → `String` (`"draft"|"open"|"merged"|"closed"`, unknown kept verbatim).
- `ForgeCheckRun` → `GitCheckRun { name: String; status: String?; conclusion: String?; url: String? }`.
- `CheckRollup` → `GitRollup` enum `green|yellow|red|none` with unknown → `.none`.
- `*Result` unions with `ok: Bool` decode into `enum … { case ok(T), failed(error: String, kind: String?) }`.
- `ForgeInboxItem.updatedAt` is epoch **milliseconds**.
- A thrown transport error is caught at the store and turned into a visible
  message (never `try?` silently on a user action — AGENTS.md "no dead controls").

---

## Server-first (D23/D24)

The box computes every MOVE-NOW item the audit assigns to WS05
(`server-first-audit.md` §WS05: **G1–G7, G10, G11, G13**) and returns it ready
to render. Both clients render the result; neither keeps a copy of the rule.
KEEP-CLIENT items stay in the clients: G8 (connect-offer decision with its
device-local dismissed flag), G9 (ship-preview request sequencing), G12
(composer-insert policy), G14 (inbox filter), G15 (delegate parent
candidates), G16 (inbox → `NewSessionDraft`). The pending-comment plural
("1 comment" / "N comments") also stays in the client (audit G11 note).

WS05 is the sole worker of wave C, so it registers its own changes in
`src/server/rpc.mjs` / `index.mjs` (D24). All changes are **additive** fields on
existing channels — no channel is renamed, no field removed or retyped.

### S.1 New module `src/server/forge/view.mjs` (G1, G2, G3, G4, G5, G6, G7, G11, G13)

Pure functions (no I/O except the injectable cache). The logic moves from
`src/renderer/chatUtils.ts`, `SessionHeader.tsx` and `InboxPalette.tsx`
verbatim, then is deleted there:

| Export | Moved from | Items |
|---|---|---|
| `checkTone(check) → "ok"\|"running"\|"error"` | `chatUtils.ts:4010` | G6 |
| `orderChecks(checks)` (failed → running → passed, stable) | `chatUtils.ts:4020` | G6 |
| `countChecks(checks) → {passed, failed, running}` | `chatUtils.ts:4027` | G6 |
| `checksChip(rollup, counts) → {glyph, label, tone} \| null` | `chatUtils.ts:4052` (registry priority stays client — layout) | G6 |
| `failuresPrompt(checks) → string \| null` | `chatUtils.ts:4101` (`""` → `null`) | G7 |
| `logsUrl(checks, prUrl) → string \| null` | `SessionHeader.tsx:1555-1558` | G7 |
| `panelState({error, branch, pr}) → "none"\|"no-pr"\|"pr"` | `chatUtils.ts:4379` + the round-2 rule (recognised forge, i.e. `error == null`, and a forge branch) | G1 |
| `shipState({branch, base, aheadCount, hasPr})` + `NO_SHIP_COPY` + the no-commits sentence | `chatUtils.ts:4414`, `SessionHeader.tsx:1284-1288, 1336` | G1 |
| `canMerge({rollup, unresolvedThreads, mergeable}) → {can, reason}` | `chatUtils.ts:4331` | G2 |
| `mergeableDisplay(pr) → {text, tone: "ok"\|"danger"\|"muted"}` | `SessionHeader.tsx:1390-1395` | G2 |
| `mergeFailureMessage(kind)` | `chatUtils.ts:4358` (`describeMergeFailure`) | G3 |
| `shipErrorMessage(raw)` | new (the desktop showed raw codes) — table below | G4 |
| `reviewErrorMessage(op, error, kind)` | `ReviewPane.tsx:480-488` + new — table below | G11 |
| `pullRequestView(result) → view` | composition of the above | G1, G2, G6, G7 |
| `createLastPrCache({max = 64})` → `{get(cwd, branch), set(cwd, branch, entry), drop(cwd, branch)}` | new — a small wrapper over `lru-cache`'s `new LRUCache({ max })`, key `` `${cwd}\0${branch}` `` | G5 |
| `inboxRowView(item, localPaths) → {label, identifier, secondary, repoName, tone, branchName, localPath}` | `chatUtils.ts:4934` (`inboxReasonLabel`), `InboxPalette.tsx:36-80` | G13 |

**`forge:pull-request` (G1, G2, G5, G6, G7)** — `pullRequestForCwd`
(forge/index.mjs:723-791) keeps its result and adds:

```jsonc
{
  "pr": PullRequest|null,
  "checks": [ { "name", "status"?, "conclusion"?, "url"?,
                "tone": "ok"|"running"|"error" } ],      // NOW pre-ordered failed→running→passed, each with tone
  "rollup", "stale", "error", "branch", "base", "aheadCount",   // unchanged
  "view": {                                                       // NEW
    "panel": "none" | "no-pr" | "pr",
    "chipLabel": "feat/x · #412" | "feat/x" | null,               // null when panel == "none"
    "ship": { "state": "has-pr"|"detached"|"unknown"|"on-base"|"no-commits"|"ready",
              "copy": "On the base branch — nothing to ship." | … | null },   // null for ready / has-pr
    "merge": null | { "can": true|false, "reason": "checks failing"|…|null,
                      "mergeable": { "text": "mergeable"|"computing…"|<mergeBlockedReason>,
                                     "tone": "ok"|"muted"|"danger" } },        // null when no PR
    "checks": { "counts": {"passed","failed","running"},
                "chip": null | { "glyph": "✓"|"✗"|"◐", "label": "✓ 7"|"✗ 2 failed"|"◐ 3 running",
                                 "tone": "ok"|"danger"|"warn" },               // null unless PR + ≥1 check + rollup ≠ none
                "failuresPrompt": string|null, "logsUrl": string|null }
  }
}
```

`panel` = `"none"` when `error != null` (no_forge / not_connected) or there is
no forge branch; `"pr"` when a PR exists; else `"no-pr"`. This is the round-2
interactivity rule (connected + recognised forge + forge branch), computed once.

**Last-PR cache (G5).** `pullRequestForCwd` takes `deps.lastPr` (default: a
module-level `createLastPrCache()`). A rate-limited read (`rateLimited`,
forge/index.mjs:758), or a read whose `getPullRequest` and list both fail,
returns the cached `{pr, checks, rollup}` for `(cwd, branch)` with
`stale: true` instead of `pr: null`. A fresh non-stale read stores the entry,
or drops it when the branch has no PR. Bounded LRU (64 entries), memory only:
storage is `lru-cache` 11.5.3 (`import { LRUCache } from "lru-cache"`,
`new LRUCache({ max })`, key `` `${cwd}\0${branch}` ``; no TTL — a stale entry
is only ever served flagged `stale: true`). `lru-cache` becomes a direct
dependency (added by WS07 in wave B; see "Libraries considered").
**Changes desktop behaviour**: the popover no longer flips to "Create pull
request" on a rate-limited poll.

**`forge:merge` (G2, G3)** — `mergePullRequest` (forge/index.mjs:1218)
re-checks the gate on the box before calling the adapter: it reads the PR
(`adapter.getPullRequest`) and its checks; if the PR head differs from `sha` →
`{ok:false, error, kind:"sha_mismatch", message}` without merging; if
`canMerge` fails → `{ok:false, error:"blocked", kind:"blocked", message:"Can't
merge yet: <reason>"}`. Every failure carries `message`
(`mergeFailureMessage(kind)`: the desktop strings verbatim plus `blocked`).

**`forge:ship` / `forge:ship-preview` (G4)** — every `{ok:false, error}` adds
`message: shipErrorMessage(error)`:

| `error` | `message` |
|---|---|
| `no_forge` | "This folder isn't linked to a GitHub repository." |
| `not_connected` | "GitHub isn't connected on this server." |
| `no_branch` | "Detached HEAD — check out a branch first." |
| `unknown_base` | "Couldn't tell which branch to target." |
| `push failed: <x>` | "Couldn't push the branch: <x>" |
| `create pull request failed: <x>` | "GitHub refused the pull request: <x>" |
| other | the raw error |

**Review messages (G11)** — `forge:diff`, `forge:draft-get`,
`forge:draft-comment`, `forge:draft-submit`, `forge:thread-reply` add
`message` beside every `error` (`null` on success):

| op | `error` / `kind` | `message` |
|---|---|---|
| any | `no_pr` | "No pull request on this session's branch." |
| any | `not_connected` | "No forge connection to this repository." |
| any | `no_forge` | "No linked forge repository." |
| draft-comment | `comment body is required` | "Write a comment first." |
| draft-comment | `invalid comment anchor` | "That line can't take a comment." |
| draft-comment | `comment not found` | "That comment was already removed." |
| thread-reply | `empty reply` | "Write a reply first." |
| thread-reply | `missing threadId` | "That thread is no longer available." |
| thread-reply | other | "GitHub didn't accept the reply: <error>" |
| draft-submit | `nothing to submit` | "Add at least one line comment before submitting." |
| draft-submit | `kind: http_422` | "GitHub rejected the review — a comment may point at a line that's no longer in the pull request. Your comments are kept." |
| draft-submit | other | "Couldn't submit — your comments are kept. (<error>)" |

**`forge:inbox` (G13)** — `defaultForgeInbox` already dedupes with precedence
(`mergeInboxSources`, github.mjs:175) and sorts by `updatedAt` desc
(forge/index.mjs:859-861). It now takes `deps.probeRepos` (the rpc registration
passes `local.forgeProbe`, 60 s cache, local.mjs:1027-1045) and adds to every
item `inboxRowView(item, localPaths)`:

```jsonc
{ …existing ForgeInboxItem…,
  "label": "checks red"|"review requested"|"issue · assigned to you",
  "identifier": "!412" | "#88",
  "secondary": "checks red · manta" | "issue · assigned to you",
  "repoName": "manta",                               // last segment of repoKey
  "tone": "danger"|"warn"|"muted",
  "branchName": "manta/pr-412-fix-the-thing",        // InboxPalette.tsx:73-80 verbatim
  "localPath": "/home/dev/projects/manta" | null }    // repoKey → probed checkout; null when none
```

A probe failure leaves `localPath: null` (never fails the inbox).

### S.2 New module `src/server/forge/diffView.mjs` (G10)

`buildDiffView(diffText, threads, draftComments, {maxRowsPerFile = 2000})`:

- **Parse with `parsePatch` from `diff` (jsdiff 9.0.0, new direct dependency —
  see "Libraries considered" and §7 Files)**, then map. This is deliberately
  NOT a port of `commentableLines` (chatUtils.ts:4454-4492), which tests for
  `--- `/`+++ ` before hunk content and so swallows an added line `++ heading`
  — encoded `+++ heading` — and a removed line `-- heading`, desynchronising
  both counters. `parsePatch` follows the hunk counts, so header-like lines
  inside a hunk come back as content lines (verified for `+++ heading`,
  `--- a/old`, an empty context line, `\ No newline`, and `+++ /dev/null`).
  `diffView.mjs` keeps only a thin mapper:
  - **Call:** `parsePatch(diffText)` inside `try/catch`. A throw (malformed
    input) becomes the additive flag **`parseFailed: true`** plus `message:
    "Couldn't read this diff."` (the parser's text goes to a server
    `console.warn`) with `files: []`; `error` stays `null` (the forge fetch
    itself succeeded) and the raw `diff`, `threads` and `draft` are still
    returned, **every** thread and draft comment placed `{at:"unplaced"}` so no
    comment is lost. Empty input → `files: []`, `parseFailed: false`,
    `message: null`.
  - **Client precedence (both clients, first match wins):** `error != null` →
    the error state (`message` + Try again); `parseFailed == true` → "Couldn't
    read this diff." with **Try again** and **Open on GitHub**, and below it the
    "Other comments" section listing every thread and draft comment (replies,
    Send to agent, Remove and the pending bar still work); `files` empty →
    "No diff."; else the diff. "No diff." is never shown when
    `parseFailed` is true.
  - **Path:** `newFileName` with a leading `b/` stripped; when `newFileName` is
    `/dev/null` (deleted file), `oldFileName` with a leading `a/` stripped. One
    `files[]` entry per structured patch, in input order.
  - **Rows:** each hunk first emits a `hunk` row whose text is the `@@ -A,B
    +C,D @@` header rebuilt from `oldStart/oldLines/newStart/newLines`
    **denormalised for display**: `parsePatch` adds 1 to a start whose count is
    0 (`parseHunk`, diff@9.0.0), so the header uses `A = oldLines == 0 ?
    oldStart - 1 : oldStart` and likewise `C` for the new side (`@@ -0,0 +1
    @@` displays `@@ -0,0 +1,1 @@`, not `-1,0`). `parsePatch` does not keep the
    section heading after the second `@@`, so none is shown. The walk then
    goes through `hunks[].lines` with counters starting at the **normalised**
    `oldLine = oldStart`, `newLine = newStart`. The first
    character alone decides: `+` → `added` (anchor `new:newLine`; `newLine++`),
    `-` → `removed` (anchor `old:oldLine`; `oldLine++`), `' '` or an empty line
    `''` → `context` (anchor `both:newLine`; both advance), `\` (`\ No newline
    at end of file`) → ignored. Whatever follows the prefix is content, even
    `++ x`, `-- x`, `+++ b/x`, `@@ x`.
  - Row `text` is the line without its one-character prefix. `added` /
    `removed` counts per file come from the same walk.
- Places every thread and draft comment by **coordinate**: thread `LEFT` → the
  row whose `oldLine` equals its line (removed or context rows); otherwise
  (`RIGHT`) → `newLine` (added or context rows); draft `new` → added row
  `newLine`; `old` → removed row `oldLine`; `both` → context row `newLine`;
  no line → top of its file; no match → top of its file when the path is in
  the diff, else `unplaced`. (Fixes the desktop losing threads on context
  lines, `ToolBodies.tsx:343-355`.)
- A file with more than `maxRowsPerFile` rows returns `rows: []`,
  `truncated: true`, its counts and `rowCount`; notes in it are placed
  `{at:"file"}`.

**`forge:diff`** adds (raw `diff`, `threads`, `headSha`, `stale`, `error`
unchanged — the raw `diff` stays for compatibility):

```jsonc
{
  "files": [ { "path": "src/a.ts", "added": 3, "removed": 1, "rowCount": 42, "truncated": false,
               "rows": [ { "kind": "hunk"|"added"|"removed"|"context", "text": "…",
                           "oldLine": 10|null, "newLine": 13|null,
                           "anchor": { "path": "src/a.ts", "line": 13, "side": "new"|"old"|"both" } | null } ] } ],
  "threads": [ { …ForgeThread…, "placement": { "at": "row", "file": 0, "row": 7 }
                                            | { "at": "file", "file": 0 } | { "at": "unplaced" } } ],
  "draft": null | { …ForgeDraft…, "comments": [ { …ForgeDraftComment…, "placement": … } ] },
  "parseFailed": false | true,          // true: the forge fetch worked but the diff text couldn't be parsed
  "message": string|null
}
```

`forge:diff` also reads the box-side draft (the same reconcile as
`draftGetForCwd`, forge/index.mjs:1332-1340, including marking it stale when
the head moved), so one call returns diff, threads, draft and their placement.
The audit says "`forge:draft-get` places drafts the same way"; doing it inside
`forge:diff` gives the same result without fetching the diff twice.
`forge:draft-get` keeps its shape (compatibility) and gains only `message`.

**Placement after a draft mutation (one rule, both clients).** `forge:draft-comment`
(add / delete / set-verdict) still returns the raw store draft (no placement —
placing needs the diff). Each client keeps the placed snapshot from its last
`forge:diff` and reconciles **by comment id only** — it never re-derives a
placement from an anchor:
1. ids present before → keep their previous placement;
2. the id created by this `add` (the one id not present before, when exactly
   one appeared) → the placement of the row the user tapped (`{at:"row", file,
   row}` of the gesture);
3. ids no longer present → removed;
4. anything else (more than one unknown id, e.g. another device added a
   comment; or the response's `headSha` / `stale` differs from the snapshot's)
   → keep the raw draft's verdict/body, show the known comments, and refetch
   `forge:diff` once to get server placements.
5. a successful mutation whose `draft` is `null` (the draft was already
   submitted or cleared, e.g. by another client — `deleteComment` returns the
   absent draft as `null`, draft.mjs:177-196, forwarded by
   forge/index.mjs:1363-1366) → the placed draft becomes `nil`/`null`: all
   draft cards and the pending bar disappear, no error, no refetch.
The draft's non-comment fields (`verdict`, `body`, `stale`, `updatedAt`) are
always taken from the response. Pure helper on each client: iOS
`ReviewDraftMerge.merge(previous: GitPlacedDraft?, response: GitDraft?,
tapped: GitPlacement?) -> (draft: GitPlacedDraft?, needsRefetch: Bool)` (in
`GitForgeModels.swift`); desktop `mergeDraftPlacements(previous, response:
ForgeDraft | null, tapped) → { draft: PlacedDraft | null, needsRefetch }`
exported from `src/renderer/ReviewPane.tsx`.

### S.3 Registrations (sole worker, wave C)

| ID | File | Change |
|---|---|---|
| M-05-srv-1 | `src/server/rpc.mjs` (`forge:inbox`, :990) | `"forge:inbox": () => forgeInbox({ probeRepos: () => local.forgeProbe() })`. All other forge handlers keep their registration; the new fields come from `forge/index.mjs` calling `view.mjs` / `diffView.mjs`. No new channel names. |
| M-05-srv-2 | `src/server/boxCapabilities.mjs` (created by WS02 in wave B, master D25) + `boxCapabilities.test.mjs` | Append `forge-pr-view-1`, `forge-diff-view-1`, `forge-inbox-view-1`, `forge-messages-1` to `BOX_CAPABILITIES`; extend the test's expected ids. `GET /api/version` and `server:version` already return the list (WS02 SF-0) — no `index.mjs` / `rpc.mjs` / `version.mjs` edit, and NO second module (`serverCapabilities.mjs` is withdrawn). |
| — | `src/server/streamInterp.mjs` | none (no frame changes). |

### S.4 Node tests

- `src/server/forge/view.test.mjs` (new): every moved function, with the
  desktop's existing vitest cases ported (checkTone, orderChecks stable order,
  counts, chip per rollup and `none` → null, failuresPrompt exact text with and
  without URL and `null` when nothing failed, logsUrl fallbacks, panelState
  incl. connected-but-`no_forge` → `none`, shipState first-match order and
  `aheadCount: null` → ready, no-ship copy, canMerge every blocking reason,
  mergeableDisplay, mergeFailureMessage per kind incl. `blocked`,
  shipErrorMessage table, reviewErrorMessage table, inboxRowView labels /
  identifier / secondary / repoName / tone / branchName slug + 40-char cap /
  localPath join, `createLastPrCache`: holds at most `max` entries and `drop`
  removes one — assert the bound and the drop, NOT the eviction order, which
  belongs to `lru-cache`).
- `src/server/forge/diffView.test.mjs` (new) — every case below exercises the
  combined `parsePatch` + mapper (no mocking of `diff`); also a malformed
  input that makes `parsePatch` throw (`@@ -1,2 +1,3 @@` followed only by
  ` first`, `+new`) → `files: []`, `parseFailed: true`, `message: "Couldn't
  read this diff."`, the raw `diff` returned, and every given thread / draft
  comment placed `unplaced`; **zero-length ranges** — an insertion-only hunk
  `@@ -0,0 +1,2 @@` shows header text `@@ -0,0 +1,2 @@` and rows `new:1`,
  `new:2`; a deletion-only hunk `@@ -3,2 +2,0 @@` shows `@@ -3,2 +2,0 @@` and
  rows `old:3`, `old:4`; two-file parse with counts;
  deleted file uses the `a/` path; hunk resets counters; preamble dropped;
  **header-like content** — `@@ -1,2 +1,3 @@`, ` first`, `+++ heading`,
  ` last` yields rows context/added/context with anchors `both:1`, `new:2`,
  `both:3` (not the old parser's `both:1, both:2`); a removed `-- heading` and
  a removed `--- a/x` line inside a hunk are `removed` rows with correct
  `oldLine` and the following rows' counters still right; an added `@@ x` line
  is content, not a new hunk; a thread on the line after each such row lands
  on the right row; `\ No newline at end of file` produces no row;
  empty diff → `[]`; LEFT thread on a context row with unequal old/new offsets
  lands on the old-line row; RIGHT on context; draft `both` uses the new line;
  unmatched → file top; unknown path → unplaced; truncation over
  `maxRowsPerFile`.
- `src/server/forge/index.test.mjs` (extend): `forgeDiffForCwd` with a
  successful adapter `getDiff` whose text is malformed → `error: null`,
  `parseFailed: true`, `message` set; `pullRequestForCwd` returns
  `view` and ordered toned checks; a rate-limited read returns the cached PR
  with `stale:true` (G5) and a fresh no-PR read drops it; `mergePullRequest`
  refuses `blocked` and `sha_mismatch` without calling `adapter.merge` and
  failures carry `message`; ship/ship-preview failures carry `message`;
  `forgeDiffForCwd` returns `files`, placed threads and the reconciled draft;
  draft-comment / submit / thread-reply failures carry `message`; `forgeInbox`
  items carry the row fields and `localPath` (probe injected; probe throw →
  `null`).
- `src/server/rpc.inbox.test.mjs` (extend): the `forge:inbox` registration
  passes `probeRepos`.

### S.5 Desktop migration (same change, no parallel implementation)

| Desktop file | Change |
|---|---|
| `src/shared/types.ts` | Add `ForgePullRequestView`; `checks[].tone`; optional `view` on `ForgePullRequestResult`; optional `files` / `placement` / `draft` / `parseFailed` / `message` on `ForgeDiffResult`; optional `message` on ship / merge / draft / reply results; optional row fields on `ForgeInboxItem`. All optional (old box). |
| `src/renderer/chatUtils.ts` | **Delete** `checkTone`, `orderChecks`, `countsForChecks`, `checksChipDescriptor`, `branchChipLabel` (unused in production), `failuresToAgentPrompt`, `canMerge`, `describeMergeFailure`, `branchPanelState`, `resolveShipState`, `ShipState`, `commentableLines`, `CommentableLine`, `inboxReasonLabel`, `sortInbox`, `INBOX_REASON_PRIORITY`. Keep `shouldOfferForgeConnect` (G8) and `formatAge` (clock). |
| `src/renderer/chatUtils.test.ts` | Delete the `describe` blocks of the removed functions (`checkTone` :4452 … `describeMergeFailure` :4735, `commentableLines` :4749, `branchPanelState` :5166, `inboxReasonLabel` :5281, `sortInbox` :5289); their cases move to `view.test.mjs` / `diffView.test.mjs`. |
| `src/renderer/SessionHeader.tsx` | Takes `view?: ForgePullRequestView` instead of deriving: the branch chip from `view.panel` / `view.chipLabel`; `BranchPanel` from `view.ship` and `view.merge` (deletes `NO_SHIP_COPY`, the mergeable ternary and the `canMerge` call); `ChecksChip` from `view.checks.chip` (registry priority 90 for `danger`, else 40 — layout); `ChecksPanel` lists `checks` as received (pre-ordered; `tone` drives `StatusDot`), "Send failures" fills `view.checks.failuresPrompt`, "Open logs" uses `view.checks.logsUrl`. |
| `src/renderer/ChatPanel.tsx` | `refreshForge` stores `prResult.view`; `doMerge` shows `res.message` (drops the `describeMergeFailure` import); ship / preview errors show `message ?? error`. A box without `view` keeps the plain tag and the header shows "Update your box to see pull requests and checks here." (only when GitHub is connected). |
| `src/renderer/ReviewPane.tsx` | Renders `files[].rows` with the comment gutter and places notes by `placement` (new local `ReviewDiffRows` component in this file); follows the S.2 state precedence (`error` → `parseFailed` → "Couldn't read this diff." with Try again / Open on GitHub and the "Other comments" list → empty → "No diff."); a `draft: null` mutation result clears the drafts and pending bar; deletes `threadAnchor`, `diffHeader`, the per-anchor note map and the separate `forgeDraftGet` call on load (the draft comes from `forge:diff`). Errors and failed add / reply / submit / remove show `message` (the desktop stops swallowing them). A box without `files` → "Update your box to review pull requests here." |
| `src/renderer/ToolBodies.tsx` | `UnifiedDiff` loses the `gutter` / `notes` props and the `UnifiedDiffGutter` / `UnifiedDiffNote` types and stops importing `commentableLines`. It keeps showing line numbers for tool-output diffs through a local, desktop-only presentational helper `diffLineNumbers(text): (number \| null)[]` in the same file (one entry per input line: old number for a removed line, new number for an added/context line, `null` otherwise), using the S.2 hunk-aware counting so it also stops mis-numbering `+++ …` content. It produces no paths, anchors or placements — it only numbers rows of a tool's raw output text, which iOS renders without numbers (`ActivityDiff`, `ActivitySheet.swift:417-460`), so there is no cross-client rule to centralise; review diffs never use it (they render the box's `files`). **Implementation (libraries review):** `diffLineNumbers` calls the same `parsePatch` from `diff` that `diffView.mjs` uses (one parser for desktop and box) and walks `hunks[].lines` with the S.2 counting, instead of re-implementing it. Tool output that is bare hunks without file headers is accepted by `parsePatch`; if it throws or returns no hunks, the helper returns all-`null` (no numbers shown), never an error. |
| `src/renderer/UnifiedDiff.test.tsx` | Add a regression fixture spanning two hunks (second hunk offset, a removal, an addition, context, and an added `+++ heading` line): assert the rendered numbers — old numbers on removals, new numbers on additions/context — match today's output for the ordinary lines and are correct after the header-like line. Also: bare hunks with no file headers get numbers; text `parsePatch` rejects (or with no hunks) renders with no numbers and no error. |
| `src/renderer/InboxPalette.tsx` | Renders `item.label` / `identifier` / `secondary`; maps the box's semantic `tone` to `StatusDot`'s vocabulary at the row with a local `inboxDotTone(tone)`: `danger → "error"`, `warn → "warn"`, `muted` / unknown `→ "idle"` (presentation only; `StatusDot` accepts `ok\|running\|error\|warn\|idle`, StatusDot.tsx:15-33); uses `item.branchName`, `item.repoName` and `item.localPath`; **deletes** the `forgeProbe` call, `dotTone`, `identifier`, `repoName`, `secondary`, `inboxBranchName` and the `sortInbox` use. Items without `label` → "Update your box to use the inbox here." |
| `src/renderer/SessionHeader.branch.test.tsx`, `SessionHeader.checks.test.tsx` | Pass a `view` fixture instead of raw state; assert the rendered copy comes from the fixture; add an old-box case (no `view`). |
| `src/renderer/ReviewPane.test.tsx` (new) | Renders rows and placed notes from a `forge:diff` fixture (incl. a LEFT context-line thread); shows `message` on a failed add; a fixture with `error: null, parseFailed: true, files: []` and one thread shows "Couldn't read this diff.", lists the thread, and does NOT show "No diff."; `mergeDraftPlacements` with two placed comments followed by add, delete and set-verdict (no surviving comment disappears or moves; new one at the tapped row; unknown ids / changed head → refetch flag); a draft loaded here then cleared elsewhere, followed by a successful Remove returning `draft: null` → no draft cards, no pending bar, no error; the component calls `forgeDiff` again only when the merge asks. |
| `src/renderer/InboxPalette.test.tsx` (new) | Renders the box's row fields; a `tone: "danger"` row renders a `bg-danger` status dot, `warn` → `bg-warn`, `muted` → `bg-text-quiet`; "Start a session" uses `localPath` + `branchName`; asserts `forgeProbe` is never called. |

### S.6 Compatibility (D24)

| Capability id (`capabilities`) | Field the client also checks | Without it (older box) |
|---|---|---|
| `forge-pr-view-1` | `forge:pull-request` → `view` | Branch shown as a plain label; no checks chip; one-line note "Update your box to see pull requests and checks here." (only when the box reports GitHub connected). |
| `forge-diff-view-1` | `forge:diff` → `files` | Review screen shows "Update your box to review pull requests here." with **Open on GitHub**. |
| `forge-inbox-view-1` | `forge:inbox` → `items[].label` | Inbox shows "Update your box to use the inbox here." |
| `forge-messages-1` | `message` on failures | Show the raw `error` string (still the box's own text). |

Clients read the capability list through the single accessors created by WS02
in wave B (master D25): iOS `MantaAPIClient.boxCapabilities()` (once per
store load), desktop `useBoxCapability(id)`. An id missing (incl. an old box
with no list → empty set) selects the fallback column. The field-presence check
in the same response stays as a decode guard that renders the same fallback.
No client re-derives the old logic.

---

## 2. Feature A — Branch / PR sheet (from the chat branch chip)

### A.1 Desktop behaviour today

- **Data**: `ChatPanel.tsx:1043-1077` (`refreshForge`) calls `forgeStatus()` and
  `forgePullRequest({cwd})` together, on the SAME 5 s timer as the branch
  indicator, only while the panel is visible (`ChatPanel.tsx:1181-1191`). On a
  throw it keeps the last-known state. `forgeKind = "github"` unless
  `prResult.error === "no_forge"`.
- **Chip** (`SessionHeader.tsx:276-281, 438-468`, `branchPanelState`
  chatUtils.ts:4379): if there is no branch or the forge is not connected the
  branch stays a plain non-interactive tag. Otherwise it is a button labelled
  `branch` or `branch · #N` that opens a popover (`BranchChip`,
  SessionHeader.tsx:1192-1251).
- **No-PR state = the ship gate** (`BranchPanel` SessionHeader.tsx:1291-1376,
  `resolveShipState` chatUtils.ts:4414-4427, first match wins:
  `has-pr`, `detached` (no branch), `unknown` (no base), `on-base`
  (branch == base), `no-commits` (aheadCount == 0), `ready`; note
  `aheadCount == nil` still yields `ready`).
  - `on-base` / `detached` / `unknown`: branch name + one line —
    "On the base branch — nothing to ship." / "Detached HEAD — nothing to
    ship." / "Base branch unknown — nothing to ship." No action.
  - `no-commits`: "Nothing to ship — no commits ahead of {base}".
  - `ready`: `{branch} → {base}` plus ` · N file(s)` once the preview lands; a
    "Title" box showing the drafted title (skeleton + "Drafting title…" while
    null); primary **Create pull request** button, disabled until the title
    arrives, shows "Creating…" while busy; the popover cannot be dismissed while
    creating (SessionHeader.tsx:1235-1238).
  - The preview (`forge:ship-preview`) is fetched once when the popover opens in
    the no-PR state (`BranchChip` effect, :1207-1209; `ensureShipPreview`
    ChatPanel.tsx:1084-1107), passing the session's model **override** and
    `sessionId` so the box drafts the title/body with that model out of band.
    An empty title falls back to the head branch name. A failure shows the
    error string in red instead of the title.
  - Create (`confirmShip`, ChatPanel.tsx:1115-1139): `forge:ship {cwd, title,
    body}` with the preview's title/body. Success → the popover swaps straight
    to the PR state with an "Opened #N" callout, opens the PR in the browser,
    and refreshes. Failure → error line.
- **PR state** (`BranchPanel` :1378-1437): `#N title`; `state · head → base`;
  rows Reviewers (comma list or "none"), Unresolved threads, Mergeable (the
  `mergeBlockedReason` in red, else "mergeable" green, else "computing…").
  Buttons: **Merge** (gated by `canMerge` chatUtils.ts:4331-4348: mergeable must
  be `true`, rollup `green`, 0 unresolved threads; the disabled button's
  tooltip is the reason: "still computing" / "not mergeable" / "checks still
  running" / "checks failing" / "no checks" / "N unresolved thread(s)");
  **Review changes** (opens the review pane); **Open on GitHub** (icon button).
- **Merge** (`doMerge`, ChatPanel.tsx:1142-1157): `forge:merge {cwd, number,
  method:"merge", sha: pr.headSha}` — always the head SHA the user saw. Failure
  text from `describeMergeFailure` (chatUtils.ts:4358): `sha_mismatch` →
  "Merge failed — the head SHA moved. This PR changed after you reviewed it;
  re-review before merging.", `cannot_merge` → "Cannot merge — the PR is
  blocked (branch protection, draft, or a conflict).", `permission` → "No
  permission to merge this pull request.", other → "Merge failed (kind)." /
  "Merge failed.". Success shows nothing (next poll updates).

Server: `pullRequestForCwd` (forge/index.mjs:723-791) returns `{pr, checks,
rollup, stale, error, branch, base, aheadCount}`; on rate-limit it returns
`pr:null, stale:true` (index.mjs:758). `shipPreview` (:942-990) errors:
`no_forge`, `not_connected`, `no_branch`, `unknown_base`. `shipPullRequest`
(:1178-1204) errors: same plus `push failed: …`, `create pull request failed: …`.
`mergePullRequest` (:1218-1229) → `{ok:false, error, kind}`.

### A.2 iOS today

`ChatScreen.swift` shows the branch as a non-interactive `Label` (`subtitleChip`,
ChatScreen.swift:925-935) inside `sessionHeaderBlock` (:1131-1150). The branch
is polled every 5 s (`pollBranch`/`refreshBranch`, :876-895); the session's cwd
is `sessionWindow?.cwd` (resolved in `resolveWindowAndBranch`, :859-871). No
forge state exists. `BranchLabel.display` (ChatScreen.swift:70-80) truncates
branch names and is reused.

### A.3 iOS design

**`GitForgeStore`** (`MantaUI/GitForgeStore.swift`, `@MainActor final class
GitForgeStore: ObservableObject`), one per chat screen. Its network calls go
through an injected `GitForgeClient` (a struct of `async throws` closures whose
`.live` value wraps `MantaAPIClient`), so the store is unit-testable
(pattern: `UpgradeStoreTests`, `BackgroundJobsStoreTests`).

- `@Published private(set) var state: GitForgeState` (value: `connected`
  (from WS10's `ForgeConnectionStatus`), `kind: String?` (`"github"` unless the
  PR read answered `no_forge`), `pr`, `checks` (server-ordered, each with
  `tone`), `stale`, `branch` (the **forge** branch), `base`, `aheadCount`,
  `view: GitPullRequestView?` (the server's `view`, S.1), `offerDismissed`).
  The store copies the response; it derives nothing (G1/G2/G5/G6/G7 are the
  box's).
- `func run(cwd: String) async` — the poll loop: fetch immediately, then every
  5 s (`BranchFreshnessPolicy.pollInterval`) while not cancelled. Started from
  `.task(id: cwd)` on the mounted header view, so it stops when the chat screen
  disappears and restarts on cwd change. Skips a tick while `scenePhase !=
  .active`.
- Each tick: `async let` `forgeStatus(validate: false)` + `forge:pull-request`;
  build the state with `GitForgeState(status:, result:)` (plain field copy). A
  rate-limited poll already returns the box's cached last PR (G5). On throw: keep
  last-known, no UI noise (desktop `ChatPanel.tsx:1074-1076` — the poll is
  ambient, not a user action).
- `offerDismissed` loaded once from `configGet()["forgeConnectOfferDismissed"]`.
- **Ship preview, keyed to the branch it was drafted for.**
  `@Published private(set) var shipPreview: GitShipPreviewState` (`.idle |
  .loading(GitShipKey) | .ready(GitShipKey, base, fileCount, title, body) |
  .failed(GitShipKey, String)`), where `GitShipKey = {cwd, branch, base}`.
  - `ensureShipPreview(model:, sessionId:)` computes the current key from
    `state` (`cwd` + forge `branch` + `base`); if the preview already holds that
    exact key in `.loading`/`.ready` it does nothing, otherwise it starts a new
    fetch tagged with that key.
  - A response is applied only if its key still equals the current key
    (`GitShipPreviewState.accept(response:for:current:)`, pure). A late
    response for a previous branch is discarded.
  - Every applied poll whose `branch` or `base` differs from the preview's key
    resets the preview to `.idle` (and, if the sheet is open, re-fetches) —
    a terminal-side `git checkout` (ChatScreen polls it, `ChatScreen.swift:874-895`)
    can never leave the old branch's title on screen.
  - `canCreate` (pure, `GitShipPreviewState.canCreate(current:)`) is true only
    for `.ready` whose key equals the current key and whose title is non-empty
    (title falls back to `head` when empty, `ChatPanel.tsx:1097`).
- `createPullRequest()` — guard `canCreate`; calls `forge:ship {cwd, title,
  body}` from the `.ready` payload; on `ok` sets `state.pr = pr` immediately
  (no flicker), `justShipped = pr.number` (cleared after 4 s), clears the
  preview, triggers a refresh. On failure sets `.failed(key, message ??
  error)` — the box's `message` (G4). `shipBusy` true for the duration.
- **Merge, tied to an immutable snapshot.**
  `struct GitMergeTarget: Equatable, Sendable { cwd: String; number: Int; title:
  String; base: String; headSha: String }` (pure, `GitForgeModels.swift`).
  - `func mergeTarget() -> GitMergeTarget?` returns nil unless `state.pr` exists
    and `state.view?.merge?.can == true` (the box's gate, G2; no force unwraps).
    The box re-checks the gate and the head SHA when the merge arrives
    (`forge:merge`, S.1), so a stale client view can never merge.
  - The sheet captures it **when the Merge button is tapped** into
    `@State pendingMerge: GitMergeTarget?`; the confirmation dialog's title and
    the request are rendered/built from that value only.
  - `func merge(_ target: GitMergeTarget) async` sends `forge:merge {cwd:
    target.cwd, number: target.number, method: "merge", sha: target.headSha}`
    and never rereads `state` before sending — a poll that replaces or clears
    the PR while the dialog is open changes nothing about what is merged
    (desktop captures the PR before awaiting, `ChatPanel.tsx:1144-1146`).
  - `mergeBusy`, `mergeMessage: GitBanner?` (`.ok("Merged #N")` or
    `.error(result.message ?? result.error)` — the box's `message`, G3; it
    covers `sha_mismatch`, `cannot_merge`, `permission`, `blocked`).

**Mounted view `GitSessionHeaderRow`** (`MantaUI/GitSessionHeaderRow.swift`),
replaces the `subtitleChip` call in `sessionHeaderBlock` (M-05-1). Inputs:
`branch: String?` (ChatScreen's ordinary git branch), `relPath: String?`,
`cwd: String?`, `sessionId: String`, `shipModel: OpencodeModelID?` (the chat's
model **override** only, as desktop), `readOnly: Bool` (bound by M-05-1 to
WS02's `ChatSessionStore.isBackgroundJobReadOnly`, which WS02 provides to WS05,
02-chat-cards-queue.md:845), `tokens`.
It reads the composer from `@Environment(\.composerController)` (WS03,
injected on `ChatScreenContent` by M-03-3). See A.3a.

Renders, in one `HStack` row (nothing at all if there is no branch AND no
offer):
1. **Branch chip** — the label is always ChatScreen's ordinary branch (same
   look as today's `subtitleChip`: `arrow.triangle.branch`,
   `BranchLabel.display`, `· relPath`), plus ` · #N` when a PR exists.
   - Interactive only when `state.view?.panel` is `"no-pr"` or `"pr"` (the
     box's rule: recognised forge, token, forge branch — S.1). Otherwise a
     plain `Label`, not a button — this covers a connected account in a repo
     whose origin is not GitHub (`panel: "none"`). The ` · #N` suffix is the
     box's `view.chipLabel` when interactive.
   - Box without `view` (capability `forge-pr-view-1` absent) and
     `state.connected == true`: plain label, and a footnote row "Update your
     box to see pull requests and checks here." (D24).
   - Interactive → `Button` presenting `GitBranchSheet` (`.sheet`,
     `.presentationDetents([.medium, .large])`). VoiceOver label
     "Pull request #N: title" or "Current branch: name" + hint "Opens git actions".
2. **Checks chip** (Feature B) to the right of the branch chip.
3. Under the row: the **Connect offer** (Feature C) when
   `GitConnectOffer.shouldShow(connected:, forgeKind:, dismissed:)` (G8,
   KEEP-CLIENT — it reads a device-local dismissed flag).

**A.3a Read-only chats.** A background-job chat is read-only (WS02 F6:
`ChatSessionStore.isBackgroundJobReadOnly == true` when `mutationPolicy ==
.readOnlyJob`); the master excludes typing into such sessions. The **source of
truth is WS02's canonical read-only signal** — `store.isBackgroundJobReadOnly`,
which WS02 also mirrors into `composer.acceptsInput` (M-03-7, WS02 F6
"Composer writability") — never the composer's default (`acceptsInput`
defaults to `true`, WS03 F6). Three layers:
1. **Not rendered.** The decision is pure:
   `GitComposerPolicy.canInsert(readOnly: Bool, hasController: Bool,
   acceptsInput: Bool) -> Bool` (in `GitForgeModels.swift`) = `!readOnly &&
   hasController && acceptsInput`. `GitComposerBridge.make(readOnly:,
   controller:)` (in `GitSessionHeaderRow.swift`) returns nil unless it is
   true. The header builds the bridge when presenting a sheet; with nil,
   `GitBranchSheet` passes `onSendToAgent: nil` to `ReviewScreen` and
   `GitChecksSheet` gets `onSendFailures: nil`, so "Send to agent" (line
   composer AND saved-draft cards) and "Send failures to the agent" are not
   rendered. The sheets are also given `readOnly` and re-evaluate on change: if
   a chat resolves to read-only while a sheet is open, those controls disappear.
2. **Controller kept in sync (WS02, M-03-7).** WS02 sets
   `composer.acceptsInput = !store.isBackgroundJobReadOnly` on appear and on
   every change of `store.isBackgroundJobReadOnly`, both directions. M-05-1
   step (b) verifies this binding exists when WS05 lands and adds exactly that
   line if it is missing — WS05 never introduces a second, differently-keyed
   binding.
3. **Re-checked on use.** The bridge closure re-evaluates `canInsert` (reading
   `readOnly` through a closure over the store, and `controller.acceptsInput`)
   at call time and calls `insert(text:mode: .append)`, which itself returns
   `false` when `acceptsInput` is false (WS03 contract). A chat that became
   read-only while a sheet was open inserts nothing and shows "This chat is
   read-only."; any other `false` shows "Couldn't add it to your message."
   (C3: callers never ignore the Bool).

Tests: `GitForgeTests.testCanInsertPolicyTruthTable` (pure, all 8 rows);
`GitForgeStoreTests.testBridgeNilForReadOnlyJob` and
`testBridgeRefusesAfterTurningReadOnly` (Xcode: a real
`ComposerTextController`, a fake store flipping `isBackgroundJobReadOnly`
true → assert `make` returns nil, a previously built bridge returns false and
the controller's `text` is unchanged; flip back → bridge non-nil and inserts).

**`GitBranchSheet`** (`MantaUI/GitBranchSheet.swift`) — `NavigationStack`
inside the sheet (so Review can push). Title = branch name; toolbar **Done**.
While `store.shipBusy` (or `mergeBusy`) the sheet cannot be closed by any
path: `.interactiveDismissDisabled(busy)` blocks the swipe, and **Done** is
`.disabled(busy)` and its action is guarded (`guard !busy else { return }`)
(desktop blocks the popover's close while creating, `SessionHeader.tsx:1235-1238`).
`.onAppear` and every branch change while open: if no PR, `ensureShipPreview`.

- **Not-shippable states** (`view.ship.state` ∈ `on-base`, `detached`,
  `unknown`, `no-commits`): branch name + `view.ship.copy` (the box's
  sentence). No buttons.
- **`ready`**: a `Form`/list section: row "From → To" `{branch} → {base}`
  (base from preview, else poll's base, else "—"), row "Changes" `N file(s)`
  (hidden until the preview for this branch lands), section "Title" with the
  drafted title in body text (redacted placeholder + footnote "Drafting
  title…" while loading). Primary full-width button **Create pull request**,
  enabled only when `canCreate` and not busy; busy shows `ProgressView` +
  "Creating…". Footnote: "Pushes {branch} and opens a pull request into
  {base}. You can edit the title and description on GitHub." Preview/ship
  failure → red text (the box's `message`, G4) and a "Try again" button that
  re-runs the preview for the current branch.
- **PR state**: header `#N title` (2 lines max), subtitle `state · head →
  base`; optional green banner "Opened #N" when `justShipped`; `LabeledContent`
  rows Reviewers / Unresolved threads / Mergeable (`view.merge.mergeable.text`,
  tinted from its `tone`: `danger` → `tokens.danger`, `ok` → `tokens.ok`,
  `muted` → `tokens.tx4`).
  When `state.stale`: footnote "Showing last known state — GitHub didn't
  answer." Buttons:
  - **Merge** — enabled iff `store.mergeTarget() != nil`; when disabled,
    `view.merge.reason` is shown as a footnote ("Can't merge yet: {reason}") —
    iOS has no hover tooltips. Tap → `pendingMerge = store.mergeTarget()` →
    `confirmationDialog("Merge #\(t.number) into \(t.base)?", presenting:
    pendingMerge)` with **Merge** and **Cancel** → `store.merge(t)`. Busy:
    "Merging…". Result banners as above.
  - **Review changes** — `NavigationLink` pushing `ReviewScreen(target:
    .cwd(cwd), sessionId: sessionId, title: "#N title", prURL: pr.url,
    onSendToAgent: bridge)` where `bridge` is nil for a read-only chat (A.3a).
  - **Open on GitHub** — `openURL(pr.url)`; hidden if `pr.url` is empty.

Deliberate iOS differences (behaviour, not visuals): Merge asks for a
confirmation (a phone tap is easy to misfire); after creating a PR the app does
**not** jump to Safari — it shows "Opened #N" with an **Open on GitHub** button;
blocked-merge reason is visible text. (Plain-word error copy is now the box's
and shared with the desktop.)

### A.4 Client-side logic left — `GitForgeModels.swift` (Foundation-only)

The rules moved to the box (S.1). What stays is decoding plus KEEP-CLIENT
state:

- Decodable wire types for the S.1 fields: `GitPullRequestView { panel,
  chipLabel, ship {state, copy}, merge? {can, reason, mergeable {text, tone}},
  checks {counts, chip? {glyph, label, tone}, failuresPrompt, logsUrl} }`,
  `GitCheckRun.tone`, `message` on every `*Result` failure case. Unknown enum
  strings decode to an `.other(String)` case and render neutrally.
- `GitConnectOffer.shouldShow(connected:, forgeKind:, dismissed:)` (G8,
  KEEP-CLIENT: device-local dismissed flag).
- `struct GitMergeTarget` + `static func target(state:, cwd:) ->
  GitMergeTarget?` (nil without PR or when `view.merge.can` is false) —
  client snapshot of what the user confirmed.
- `GitShipKey`, `GitShipPreviewState` with `accept(response:for:current:)`,
  `invalidated(by newState:)`, `canCreate(current:)` (G9, KEEP-CLIENT request
  sequencing); title falls back to `head` when empty.
- `GitComposerPolicy.canInsert` (G12, KEEP-CLIENT, A.3a).
- `GitForgeState(status:, result:)` — field copy, no rules.

Tests — `MantaUITests/GitForgeTests.swift` (pure, runs under `verify.sh`):
`testDecodePullRequestViewFull` (fixture copied from `view.test.mjs` output),
`testDecodeViewMissingIsNil` (old box), `testDecodeUnknownPanelAndToneKept`,
`testDecodeChecksKeepServerOrderAndTone`, `testDecodeMergeFailureMessage`,
`testDecodeShipFailureMessage`, `testConnectOfferShouldShow`,
`testMergeTargetNilWithoutPRAndWhenBoxSaysCannot`,
`testMergeTargetCapturesHeadSha`,
`testShipPreviewDiscardsLateResponseForOldBranch`,
`testShipPreviewInvalidatedBySameCwdBranchSwitch`,
`testCanCreateFalseUntilPreviewMatchesCurrentBranch`,
`testPreviewTitleFallsBackToHead`, `testCanInsertPolicyTruthTable`.

Store tests — `MantaUITests/GitForgeStoreTests.swift` (Xcode only, uses a fake
`GitForgeClient`):
`testMergeSendsCapturedTargetAfterPollReplacesPR` (capture target for PR #1
sha `a`, apply a poll with PR #2 sha `b`, call `merge(target)` → client got
`{number:1, sha:"a"}`), `testMergeSendsCapturedTargetAfterPollClearsPR`
(no crash, original target sent), `testCreateDisabledWhileBusy`,
`testShipPreviewRefetchedAfterBranchChange`.

### A.5 Acceptance

- [ ] With GitHub connected and a feature branch with commits ahead and no PR,
  tapping the branch chip opens a sheet showing `branch → base`, file count and
  a drafted title; **Create pull request** stays disabled until the title for
  the current branch arrives.
- [ ] Switching branch in a terminal while the sheet is open replaces the
  preview with the new branch's one (old title never shown or submitted).
- [ ] Creating a PR swaps the sheet to the PR view with "Opened #N" in the same
  moment; neither swipe nor Done closes the sheet while creating.
- [ ] On the base branch / detached HEAD / unknown base / no commits ahead, the
  sheet shows the box's `view.ship.copy` sentence and no action — the same text
  the desktop shows.
- [ ] A rate-limited poll keeps showing the last PR (marked last-known) instead
  of flipping to "Create pull request", on both clients (G5).
- [ ] Against a box without `view`, the branch is a plain label and the
  "Update your box…" note shows when GitHub is connected.
- [ ] Not connected, a non-git/scratch folder, or a connected account in a repo
  whose origin isn't GitHub: the branch is a plain label (no tap target).
- [ ] With a PR: reviewers, unresolved threads and mergeability are shown;
  Merge is disabled with a visible reason unless checks are green, threads are
  0 and GitHub reports mergeable; Merge asks to confirm and sends exactly the
  PR number and head SHA shown when the dialog opened, even if a poll changed
  the PR meanwhile; success and each failure kind show a message.
- [ ] In a read-only background-job chat, no "Send to agent" or "Send failures
  to the agent" control appears anywhere reachable from the header (branch
  sheet → review line comment, review saved draft, checks sheet).
- [ ] Review changes pushes the review screen; Open on GitHub opens Safari.
- [ ] Polling runs every 5 s only while the chat is on screen and the app is
  active; a failed poll leaves the last state in place.

---

## 3. Feature B — Checks chip, check list, "Send failures to the agent"

### B.1 Desktop behaviour

- Chip registered only when there is a PR, ≥1 check and a non-`none` rollup
  (SessionHeader.tsx:262-266). `checksChipDescriptor` (chatUtils.ts:4052):
  green `✓ {passed}` (ok tone), red `✗ {failed} failed` (danger), yellow
  `◐ {running} running` (warn). Glyph + colour, never colour alone.
- `checkTone` (chatUtils.ts:4010): no conclusion OR status `queued`/`in_progress`
  → running; `success` → ok; anything else → error. `countsForChecks`
  (:4027), `orderChecks` failed → running → passed, stable (:4020).
- Popover (`ChecksPanel`, SessionHeader.tsx:1543-1595): header "Checks" + count;
  every check as a row with a status dot; a check with a URL is a link to its
  own log; the raw conclusion/status is the tooltip (CheckRow :1512-1541).
  Footer: **↻ Send failures to the agent** (only when ≥1 failed check) and
  **Open logs ↗** (URL = first failing check with a URL, else any check URL,
  else the PR URL).
- Send failures (`failuresToAgentPrompt`, chatUtils.ts:4101) builds:
  ```
  Checks are failing on this pull request:
  - <name> (<url>)
  - <name>

  Please investigate and fix them.
  ```
  and FILLS the composer, never sends (`onFillComposer` →
  `updateInputWithHistoryReset`, ChatPanel.tsx:3416 — replaces the input).

### B.2 iOS design

- `GitChecksChip` (in `GitSessionHeaderRow.swift`): capsule with the box's
  `view.checks.chip.label` (glyph included), tinted from `chip.tone`
  (`ok/warn/danger` → `tokens.ok/warn/danger`); `Button` → `GitChecksSheet`
  (`.presentationDetents([.medium, .large])`). Rendered only when
  `view.checks.chip != nil` (the box returns nil without a PR, without checks
  or with rollup `none`).
- `GitChecksSheet` (`MantaUI/GitChecksSheet.swift`): `List` of `checks` **in
  the order received** (the box orders failed → running → passed, G6); each
  row: status symbol from the check's `tone` (`checkmark.circle.fill` ok,
  `xmark.circle.fill` error, `circle.dotted` running — symbol + colour),
  name, secondary text = raw conclusion/status (the desktop tooltip, made
  visible). Rows with a URL are `Button`s → `openURL(url)` with a trailing
  `arrow.up.right`; rows without a URL are plain. Toolbar title "Checks (N)".
  Bottom bar (`safeAreaInset(edge: .bottom)`):
  - **Send failures to the agent** — only when `view.checks.failuresPrompt`
    is non-nil (the box's text, G7) AND `onSendFailures != nil` (nil for
    read-only chats, A.3a). Calls it with that prompt (C3 `insert(text:mode: .append)` — D6; append = existing draft +
    blank line + text, just the text into an empty draft), dismisses the sheet
    on `true`, and the composer now shows the text (the visible outcome); on
    `false` the sheet stays with "Couldn't add it to your message." **Deliberate
    difference (D6):** desktop replaces the composer text; iOS keeps an
    in-progress draft.
  - **Open logs** — `openURL(view.checks.logsUrl)`; hidden if nil (G7).

### B.3 Client logic + tests

None — tone, order, counts, chip and prompt are the box's (S.1, tested in
`view.test.mjs`). `GitForgeTests` decodes them
(`testDecodeChecksKeepServerOrderAndTone`, `testDecodeChecksChipNilWhenAbsent`,
`testDecodeFailuresPromptAndLogsUrl`).

### B.4 Acceptance

- [ ] A PR with checks shows `✓ 7` / `✗ 2 failed` / `◐ 3 running` beside the branch chip; no PR or no checks → no chip.
- [ ] The checks sheet lists every check failed-first; tapping a check with a log opens it in Safari.
- [ ] "Send failures to the agent" appears only when something failed and the chat is writable, appends the exact desktop text to the composer without sending, and closes the sheet; a rejected insert shows a message.
- [ ] "Open logs" opens the first failing check's log (fallbacks as above).

---

## 4. Feature C — Connect GitHub offer + device-code sign-in

### C.1 Desktop behaviour

- **Offer** (`ConnectOffer`, SessionHeader.tsx:1606-1632): one info line under
  the header — "Connect GitHub to see checks and pull requests for this repo."
  with **Connect** and **×**. Shown only when not connected, the origin is a
  forge, and not permanently dismissed (`shouldOfferForgeConnect`). × writes
  `configUpdate({forgeConnectOfferDismissed: true})` optimistically
  (ChatPanel.tsx:1163-1169). Connect opens the device-code modal
  (ChatPanel.tsx:3570-3590); on connected it closes and refreshes the forge
  state so the chips appear.
- **Device flow** (`ConnectGithubPanel`, ConnectGithub.tsx:77-333), the ONE
  implementation (also used by Clone from GitHub, CloneFromGitHub.tsx:274):
  - On open: `forge:device-start`. `notConfigured` → "GitHub sign-in isn't
    configured on this server yet." + Back. `connected:true` → done
    immediately. Otherwise show the code; the code is auto-copied to the
    clipboard ("copied to clipboard" note). Throw → error panel "Couldn't
    reach the server. Try again."
  - Code screen: title "Connect GitHub · Waiting for sign-in", countdown
    `m:ss remaining`, step 1 "open this link" (verification URI shown without
    scheme, with copy), step 2 "enter the code" (large mono code, copy),
    **Cancel** (`forge:device-cancel` then close).
  - Poll invariants (ConnectGithub.tsx:17-26, 146-230): one self-rescheduling
    timer, **no immediate first poll**, interval = `max(pollInterval, 5)` s,
    re-read from every `pending` response (honours GitHub `slow_down`);
    `done` → connected; `expired` → "The sign-in code expired before it was
    entered." + **Try again** / **Skip for now**; three consecutive
    `error`/transport failures → "Couldn't sign in: <message>" + **Try again**
    / **Cancel**; any `pending` resets the error budget.

Server: `forgeDeviceStart`/`forgeDevicePoll`/`forgeDeviceCancel`
(forge/index.mjs:421-473). `device_code` never leaves the box.

### C.2 Ownership (D5, D14)

The device sign-in is built **once, by WS04 in wave A**:
`CloneFromGitHubSignIn.swift` declares `@MainActor final class
GitHubDeviceSignInStore: ObservableObject` and `struct GitHubDeviceSignInView:
View { init(onConnected: @escaping () -> Void, onCancel: @escaping () -> Void) }`;
the `forgeDeviceStart()` / `forgeDevicePoll(grantId:)` /
`forgeDeviceCancel(grantId:)` client members live in WS04's
`MantaAPIClient+Sessions.swift` (04-sessions.md:1286-1288); its pure logic
(`GitHubDeviceFlow`) and tests are WS04's. WS05
creates **no** device-flow store, view, pure type or client method. §C.3 is the
behavioural contract D5 says WS04 implements; §C.4 is the only part WS05 builds.

### C.3 Behavioural contract for `GitHubDeviceSignInView` (implemented by WS04)

Stages and copy are the desktop's (C.1):
- `.starting`: `ProgressView` "Preparing sign-in…".
- `.code(grant)`: title "Connect GitHub", subtitle "Waiting for sign-in" with
  the live countdown `m:ss remaining`; step 1 "Open this link" → **Open
  github.com/login/device** (`openURL`) + **Copy link**; step 2 "Enter the
  code" → large monospaced code + **Copy code**; note "Code copied to
  clipboard" after the one automatic `UIPasteboard.general.string = userCode`
  (on entering this stage) and after a manual copy. **Cancel**.
- `.notConfigured`: "GitHub sign-in isn't configured on this server yet." + **Back**.
- `.expired`: "The sign-in code expired before it was entered." + **Try again** / **Skip for now**.
- `.error(msg)`: "Couldn't sign in: {msg}" + **Try again** / **Cancel**.
- `.connected` → `onConnected()` exactly once.

Poll invariants (desktop `ConnectGithub.tsx:17-26, 146-230`): no immediate
first poll; interval = `max(pollInterval, 5)` s, re-read from every `pending`
reply (`slow_down`); `pending` resets the error budget; 3 consecutive
`error`/transport failures → `.error` (server message, or "GitHub sign-in
failed." when empty; transport → "Couldn't reach the server. Try again.");
`done` → connected; `expired`, or the local deadline passing → `.expired` and
polling stops.

**Lifecycle (required; round-1 finding 8, round-2 finding 3).** Stated against
WS04's pinned API (04-sessions.md:631-648) so the implementer has one reading:

1. **One loop owner.** `GitHubDeviceSignInStore` owns at most one poll `Task`
   (`pollTask`). `start()` cancels and replaces it; nothing else creates one.
2. **Generation guard, covering the start itself.** The store keeps
   `private var generation = 0`. `start()` increments it **before** awaiting
   `api.start()`, and every await site (start reply, each poll reply, every
   sleep wake) proceeds only if its captured generation still equals
   `generation` (and `!Task.isCancelled`). A grant-id check alone is
   insufficient because a late **start** reply arrives before any grant
   exists; the generation covers it. A stale reply can never call
   `onConnected`, change `flow`, or reschedule.
3. **Cancellation on every exit, with an awaited completion.** WS04's
   `cancel()` must be `func cancel() async` (not fire-and-forget) and do, in
   order: bump `generation`, cancel `pollTask`, then — if a grant exists —
   `await api.cancel(grantId:)`. The view's Cancel / Back / Skip buttons run
   `Task { await store.cancel(); onCancel() }` so `onCancel` follows the
   cancel's completion; `onDisappear` (swipe, parent navigation) calls the
   same `cancel()` without awaiting. **Failure reporting:** the API seam's
   `cancel(grantId:)` stays non-throwing for callers, but the live adapter
   (`ServerGitHubDeviceSignIn`) catches the client error and logs it with
   `os_log(.error, "github device cancel failed: …")` (desktop logs via
   `ship("warn", …)`); dismissal is never blocked (the grant expires
   box-side; an unknown grant is a server no-op, forge/index.mjs:465-473).
   WS04's API (§6) states exactly this ("awaited; failure logged by the live
   adapter").
4. **Foreground wake through the existing loop.** `sceneBecameActive()` never
   polls or reschedules by itself: it calls `flow.tick(now:)` (may expire) and
   then yields to the loop's wake channel (`AsyncStream<Void>` continuation the
   loop's sleep races against). The loop, on wake, polls at once only if
   `GitHubDeviceFlow.shouldPollNow(lastPoll:now:interval:)`, else sleeps the
   remainder. With no running loop (e.g. `.expired`) the wake is a no-op —
   it cannot spawn a second loop.

Lifecycle tests WS04 must include (`GitHubDeviceSignInStoreTests.swift`, fake
API + fake clock), in addition to its current list:
`testDismissDuringStartIgnoresLateStartReply` (no `onConnected`, no grant,
stage untouched), `testRetryDuringOutstandingPollDropsOldReply` (exactly one
loop running afterwards), `testWakeDuringSleepUsesExistingLoop` (no extra loop;
polls only when the interval elapsed), `testCancelAwaitsDeviceCancelBeforeOnCancel`,
`testCancelFailureIsLoggedAndStillDismisses`.

### C.4 What WS05 builds

- **`GitConnectOffer`** (in `GitSessionHeaderRow.swift`): a compact info row
  with the desktop sentence "Connect GitHub to see checks and pull requests for
  this repo.", a **Connect** button and an **×** (`accessibilityLabel("Dismiss")`).
  × hides immediately, then `configUpdate(["forgeConnectOfferDismissed": true])`;
  a failed write keeps it hidden for this run (desktop parity,
  `ChatPanel.tsx:1163-1169`) — no error toast for a dismissal.
- **Connect** presents `.sheet { NavigationStack { GitHubDeviceSignInView(
  onConnected: { dismiss; forgeStore.refreshNow() }, onCancel: { dismiss }) } }`.
  On connected the offer disappears and the chip becomes tappable on the
  immediate refresh.
- The inbox's not-connected state presents the same view (Feature E).

### C.5 Acceptance (WS05 part)

- [ ] In a GitHub-origin chat with no GitHub connection, the offer line appears under the header; × hides it now and it stays hidden after relaunch.
- [ ] Connect opens WS04's sign-in view; after authorising in Safari and returning, it closes by itself and the branch chip becomes tappable without waiting for the next 5 s tick.
- [ ] Cancel or swipe-down leaves the chat unchanged and no sign-in keeps polling (verified via WS04's lifecycle tests).

---

## 5. Feature D — Review screen

### D.1 Desktop behaviour (`ReviewPane.tsx`)

- Target: the session's cwd (box resolves the open PR on the current branch)
  or an inbox `{repoKey, number}` (ReviewPane.tsx:90-110). "Send to agent"
  exists only when there is a session (`canSend`).
- Load (:140-180): `forge:diff(ref)` → `{diff, threads, headSha, stale?, error}`
  and `forge:draft-get(ref)` → `{draft, error}` in parallel; no polling,
  refetch on reopen. Errors: `no_pr` → "No pull request on this session's
  branch.", `not_connected` → "No forge connection to this repository.", else
  → "No linked forge repository."; empty diff → "No diff."; loading → "Loading
  diff…".
- Diff rows via `UnifiedDiff` (ToolBodies.tsx:318-500) with hunk headers shown
  as muted rows; anchors from `commentableLines` (chatUtils.ts:4454-4492): added
  → `{path, line:newLine, side:"new"}`, removed → `{path, line:oldLine,
  side:"old"}`, context → `{path, line:newLine, side:"both"}`; path from
  `+++ b/`, or `--- a/` when the file is deleted to `/dev/null`.
- Threads (:270-345) render under their anchor (`LEFT` → old side, else new;
  no line → top): attribution = first author (+ " · resolved"), every comment
  body, **Reply** → inline reply box (**Reply** / **Cancel**) →
  `forge:thread-reply {…ref, threadId, body}` posts immediately (never
  buffered), then refetches the diff for fresh threads.
- Composing (:346-410): every line has a `+` gutter → inline composer
  "Comment on this line…" with **Send to agent** (primary, session only),
  **Add to review**, **Cancel**. Add → `forge:draft-comment {…ref, op:"add",
  comment:{path,line,side,body}}`. Send to agent → appends the text to the
  chat composer on a new line, does not send (ChatPanel.tsx:1311-1325).
- Your draft comments render as "You · draft" with **Send to agent** and
  **Remove** (`op:"delete"`); once sent: "↳ attached to composer · not yet
  published" (renderer-local flag).
- Pending bar (:418-452), only when ≥1 buffered comment: "N comment(s) not yet
  published", verdict buttons **Approve / Request changes / Comment** (tap →
  `op:"set-verdict"`, selected one highlighted), **Submit** ("Submitting…") →
  `forge:draft-submit {…ref, verdict}`; success clears the draft; failure
  keeps it. If `draft.stale`: warning "The branch moved since you wrote these
  comments — the line anchors may be out of date. Your comments are kept;
  review them before submitting."
- Desktop swallows failures of add/reply/submit silently — iOS must not.

Server: `forgeDiffForCwd` (forge/index.mjs:1248-1272), `draftGetForCwd`
(:1332-1340, marks stale when head moved), `draftCommentForCwd` (:1352-1374;
errors `comment body is required`, `invalid comment anchor`, `comment not
found`, `unknown op`), `replyThreadForCwd` (:1385-1403; `missing threadId`,
`empty reply`, GitHub message), `draftSubmitForCwd` (:1414-1435; **refuses
with "nothing to submit" when the draft has no comments** — so a verdict-only
review is impossible; `kind` e.g. `http_422`). Verdict null submits as a plain
comment review (github.mjs:318-322).

### D.2 iOS design — `ReviewScreen` (`MantaUI/ReviewScreen.swift`)

`ReviewScreen(target: GitRef, sessionId: String?, title: String?, prURL:
String?, onSendToAgent: ((String) -> Bool)?)`, backed by `ReviewStore`
(`MantaUI/ReviewStore.swift`, `@MainActor final class`). Pushed inside the
branch sheet's `NavigationStack` (Feature A) or the inbox sheet's (Feature E).
`onSendToAgent == nil` → no "Send to agent" anywhere (inbox, standalone
`.review` route, and every read-only background-job chat — A.3a). The closure
returns C3's Bool; `false` is surfaced as "Couldn't add it to your message."

- **Toolbar**: title "Review" + subtitle `#N` when known; trailing menu:
  **Open on GitHub** (if `prURL`), **Refresh**.
- **Load**: ONE call, `forge:diff(ref)`, returns rows, placed threads and the
  reconciled draft with placed comments (S.2) — no separate `draft-get` on load.
- **States** (S.2 precedence, first match wins): loading →
  `ProgressView("Loading diff…")`; `error` → the box's `message` + **Try
  again**; `parseFailed` → "Couldn't read this diff." + **Try again** + **Open
  on GitHub**, with the "Other comments" section below (all threads and draft
  comments, still actionable; the pending bar still shows); `files` empty →
  "No diff."; `stale` diff result →
  footnote banner "Showing last known diff — GitHub didn't answer."; response
  without `files` (old box, capability `forge-diff-view-1`) → "Update your box to
  review pull requests here." + **Open on GitHub**. `.refreshable` reloads.
- **Body**: `ScrollView` + `LazyVStack(pinnedViews: .sectionHeaders)`, one
  `Section` per server `files[i]`: header = `path` (middle-truncated,
  monospaced) + `+added −removed`; notes placed `{at:"file", file:i}` first;
  then `rows` with notes placed `{at:"row", file:i, row:j}` under row `j`.
  Notes placed `{at:"unplaced"}` render in a "Other comments" section at the
  top. A file with `truncated: true` shows "Too large to show here ({rowCount}
  lines)" with **Open on GitHub**. Each row
  is monospaced, wraps (no horizontal scroll), with old/new line numbers and a
  coloured background (`tokens.ok`/`tokens.danger` at low opacity) by `kind`,
  `hunk` rows muted. A row is commentable iff its `anchor` is non-nil; the
  comment is sent with exactly that anchor. Row ids are deterministic:
  `"\(fileIndex):\(rowIndex)"`.
  Files over 400 rows start collapsed with "Show N lines" (perf on a phone).
- **Commenting**: tapping a commentable row (or its context menu "Comment on
  this line") opens `ReviewCommentSheet` (`.presentationDetents([.medium])`)
  showing the line being commented on, a `TextEditor` ("Comment on this
  line…"), and buttons **Send to agent** (prominent; only with
  `onSendToAgent`), **Add to review**, **Cancel**. Both actions are disabled on
  empty/whitespace text.
  - Send to agent → `onSendToAgent(text)` (C3 `.append`: existing draft +
    blank line + text — master C3; desktop joins with one newline,
    `ChatPanel.tsx:1321`, a cosmetic difference accepted for one shared
    append rule). On `true` the sheet closes and a transient banner "Added to
    your message — not sent yet" confirms (the composer is not visible from
    here); on `false` the sheet stays open with the error.
  - Add to review → busy spinner; success closes the sheet and the draft is
    reconciled with `ReviewDraftMerge.merge` (S.2 "Placement after a draft
    mutation"): existing comments keep their places, the new one sits under
    the tapped row, and an unexpected change triggers one `forge:diff`
    refetch; failure keeps the sheet open with the text and shows the box's
    `message` in red. Remove and verdict changes go through the same merge.
- **Threads** inline under their row as cards: author (+ " · resolved"),
  comments in order with author and relative time when `createdAt` is present,
  **Reply** → `ReviewReplySheet` (TextEditor "Reply…", **Reply** / **Cancel**);
  success refetches the diff (threads) and closes; failure keeps text + the
  box's `message`.
- **Your draft comments** inline as "You · draft" cards with **Send to agent**
  (when available and not yet sent this screen) and **Remove** (also as a
  swipe/context action); after sending: "↳ added to your message · not yet
  published". Remove failure → inline `message`, card stays.
- **Pending bar** (`safeAreaInset(edge: .bottom)`), only when ≥1 draft comment:
  stale warning (desktop copy) when `draft.stale`; "N comment(s) not yet
  published" (the plural is client formatting); a segmented `Picker` Approve /
  Request changes / Comment bound to
  `draft.verdict` (no selection = none; choosing calls `set-verdict`,
  optimistic, reverted with an error on failure); **Submit review** primary
  ("Submitting…"). Success → banner "Review submitted" then the bar
  disappears and the threads refetch. Failure → the box's `message` (G11 table
  in S.1: `nothing to submit`, `http_422`, other).
- No thread is ever dropped: placement is the box's (S.2), which fixes the
  desktop's loss of threads on context lines for both clients.

### D.3 Client logic + tests

Parsing, anchors and placement are the box's (`diffView.mjs`, S.2) — there is
no `ReviewDiff.swift`. Decode types live in `GitForgeModels.swift`:
`GitDiffFile { path, added, removed, rowCount, truncated, rows }`,
`GitDiffRow { kind (hunk|added|removed|context|other), text, oldLine?, newLine?,
anchor? {path, line, side} }`, `GitPlacement` (`.row(file, row)`,
`.file(file)`, `.unplaced`; unknown `at` → `.unplaced`), `placement` on
`GitThread` and `GitDraftComment`. Client-only: `ReviewCopy.pendingLabel(_:)`
("1 comment" / "N comments").

Tests — `MantaUITests/GitForgeTests.swift` (pure, `verify.sh`):
`testDecodeDiffFilesRowsAnchors` (fixture copied from `diffView.test.mjs`),
`testDecodePlacementVariantsAndUnknownAt`, `testDecodeTruncatedFile`,
`testDecodeDiffWithoutFilesIsOldBox`, `testDecodeDraftWithPlacedComments`,
`testDecodeReviewFailureMessage`, `testPendingLabel`,
`testDraftMergeAddKeepsExistingAndPlacesNewAtTap` (two placed comments + add →
both keep placements, new one at the tapped row),
`testDraftMergeDeleteRemovesOnlyThatId`, `testDraftMergeVerdictKeepsAllPlacements`,
`testDraftMergeUnknownIdsOrHeadChangeRequestsRefetch`,
`testDraftMergeNullResponseClearsDraftWithoutRefetch`,
`testDecodeParseFailedFlag`.
Store tests (`GitForgeStoreTests.swift`, Xcode): `testReviewStoreRefetchesDiffOnlyWhenMergeAsks`,
`testReviewStateParseFailedBeatsEmpty` (`error: nil, parseFailed: true,
files: []` → state `.parseFailed` with the thread in "Other comments", never
`.empty`), `testRemoveAfterRemoteClearReturnsNullClearsPendingBar` (draft
loaded, cleared by another client, Remove succeeds with `draft: null` → no
cards, no bar, no error banner).

### D.4 Acceptance

- [ ] From a chat with a PR, Review changes shows the PR diff grouped by file with line numbers, existing threads under their lines, and your saved draft comments.
- [ ] Tapping a line lets you write a comment and either put it in the chat message (not sent) or add it to the review; both say what happened; a failed add keeps your text.
- [ ] Replying to a thread posts immediately and the reply appears after refresh; failures show a message.
- [ ] With ≥1 draft comment the bottom bar shows the count, a verdict choice and Submit review; submit success clears the draft; failure keeps it with a message.
- [ ] When the branch moved since the comments were written, the desktop warning appears and nothing is discarded.
- [ ] Opened from the inbox (no session) or from a read-only background-job chat, no "Send to agent" control is shown anywhere (line composer or saved drafts).
- [ ] A thread on the old side of an unchanged line appears under the right line even when lines were added above it — on iOS and on the desktop (both render the box's placement).
- [ ] Against a box without `files`, the review screen says "Update your box to review pull requests here." and offers Open on GitHub.
- [ ] A 3,000-line diff scrolls smoothly (large files collapsed by default).

---

## 6. Feature E — Work inbox

### E.1 Desktop behaviour (`InboxPalette.tsx`)

- Opened from the command palette (Sidebar.tsx:1008-1015). One fetch on open,
  never polled (:103-138): `forge:inbox` and, in parallel, `forge:probe`
  (repoKey → local path map; failure ignored). `error:"not_connected"` →
  "GitHub isn't connected on this server."; throw → "Couldn't load the
  inbox."; loading "Loading inbox…"; empty "Nothing needs you right now.";
  filtered empty `No inbox matches "q"`. Header "Inbox" + count. Filter by
  title or number.
- Rows (`sortInbox` chatUtils.ts:4953: dedupe by `repoKey#number`, more urgent
  reason wins — checks failing > review requested > assigned — then
  `updatedAt` desc): dot (checks failing = red, review requested = amber,
  assigned = grey), identifier `!N` for PRs / `#N` for issues, title,
  secondary = `inboxReasonLabel` ("checks red" / "review requested" / "issue ·
  assigned to you") plus ` · repo` for PRs, trailing age (`formatAge`
  chatUtils.ts:542: "now" / "Nm" / "Nh" / "Nd").
- Actions on the selected row:
  - **Start a session** (:157-200): needs a local checkout of the repo (else
    "No local checkout of {repo} on this server to start a session in.");
    `git:add-worktree {cwd: path, name: "manta/{issue|pr}-{N}-{slug≤40}"}`;
    `tmux:new-session {name: uniqueSessionName(deriveProjectName(path)), cwd:
    worktreePath, windowName:"default", chatMode:true, createDir:false,
    forgeIssue:{repoKey, number}}` (`forgeIssue` for **issues only**; the box
    stamps `@manta-forge-issue` so a later PR body gets "Closes #N",
    rpc.mjs:1011-1030, 1252); lands in the session with the box-built seed
    (`"Complete {url}"`, forge/index.mjs:803) in the composer, NOT sent.
  - **Open review** (:245-253): PRs only; opens ReviewPane with `{repoKey,
    number}` over the inbox ("Back to inbox").
  - **Delegate in background** (:206-238): needs a local checkout and an active
    chat session as parent ("Open a chat session first — a background job nests
    under its parent session."); `delegate:start {prompt: seed, sessionID:
    parent, directory: repoPath}`; `ok:false` → its error or "Couldn't start
    the background job.".

### E.2 iOS design

- **Entry point**: a toolbar button on the session list (`tray` symbol,
  accessibility "Inbox") → `sheetRoute = .inbox` (new `SheetRoute` case,
  M-05-2) → `InboxWorkScreen` (large detent).
- **`InboxWorkStore`** (`MantaUI/InboxWorkStore.swift`, `@MainActor final
  class`): `load()` on appear and on pull-to-refresh (no polling) calling
  `forge:inbox` only — items arrive sorted, deduplicated and carrying their row
  fields and `localPath` (G13, S.1); no `forgeProbe()` call. Holds `items`,
  `phase: .loading | .loaded | .notConnected | .failed(String)`,
  `actionError: String?`, `actionNotice: String?`, `busyItem: String?`.
- **`InboxWorkScreen`** (`MantaUI/InboxWorkScreen.swift`): `NavigationStack`,
  title "Inbox" with the count in the subtitle; `.searchable(prompt: "Filter
  inbox…")`; states with the desktop copy; for `.notConnected` also a
  **Connect GitHub** button presenting WS04's `GitHubDeviceSignInView`
  (§C.4; on connected → reload). Items without `label` (old box, capability
  `forge-inbox-view-1`) → "Update your box to use the inbox here." Rows: leading SF
  Symbol + tint from the box's `tone` (`danger` → `xmark.circle.fill` red,
  `warn` → `eye.circle.fill` amber, `muted` → `circle` grey — symbol, not
  colour alone), `identifier` + title (2 lines), `secondary`, trailing age
  (client clock formatting, ticks every 60 s).
- **Row actions**: tapping a row shows a `confirmationDialog` titled with the
  identifier + title (also available as the row's context menu):
  - **Start a session** — always listed. `localPath == nil` → the desktop
    message "No local checkout of {repoName} on this server to start a session
    in." Otherwise (D12) the inbox **creates nothing**: it builds
    `NewSessionDraft(cwd: item.localPath, text: item.seed, attachments: [],
    worktreeBranch: item.branchName, linkedIssueURL: item.url)`
    (seed is the box's "Complete {url}", forge/index.mjs:803, so it contains
    the issue/PR URL), dismisses the inbox (`sheetRoute = nil`) and calls
    `navigator.startNewSession(draft)`. WS04's create sheet then shows the
    repo preselected, "new worktree" pre-ticked with that branch and the link
    as a header line; the worktree and session are created only when the user
    taps **Create**, and the chat opens with the seed unsent. Cancelling the
    create sheet leaves the box untouched. The desktop's `forgeIssue` session
    stamp (rpc.mjs:1252) is **dropped** (D12): a PR later shipped from that
    session gets the plain drafted body, without an automatic "Closes #N".
  - **Open review** — PRs only (not listed for issues — no dead control);
    pushes `ReviewScreen(target: .pr(repoKey:, number:), sessionId: nil, title:
    "!N title", prURL: item.url, onSendToAgent: nil)`.
  - **Delegate in background** — listed when `localPath != nil`. The
    parent session is chosen from a second dialog "Run under which session?"
    (D9) listing chat sessions (windows with `opencodeSessionId` and not job
    windows, from `projects()`), sessions whose cwd is inside the repo path
    first. No chat sessions → the action isn't listed. Calls
    `delegateStart(prompt: item.seed, sessionID: parent, directory: item.localPath)`
    (the delegate engine makes its own worktree, as desktop). Success →
    `actionNotice` "Background job started under {session}" (the sheet stays;
    the banner is the visible confirmation). `ok:false` → its error or
    "Couldn't start the background job."; a throw → its message.
  - **Open on GitHub** — the row's `url` (desktop shows it as the row
    tooltip; on a phone it must be an action to be reachable).

### E.3 Client logic — `InboxWorkModels.swift` (Foundation-only) + tests

`WorkInboxItem` (Decodable: `kind`, `repoKey`, `number`, `title`, `url`,
`state`, `rollup`, `updatedAt` ms, `reason`, `seed`, and the box's `label`,
`identifier`, `secondary`, `repoName`, `tone`, `branchName`, `localPath?`).
Sorting, dedupe, labels, identifier, branch name and the checkout join are the
box's (G13). KEEP-CLIENT helpers only: `WorkInbox.filter(_:query:)` (G14;
title contains, case-insensitive, or number contains), `formatAge(ms:now:)`
(clock), `parentCandidates(sessions:, repoPath:)` (G15; plain
`(sessionID, name, cwd)` tuples), `draftFields(for:) ->
WorkInboxDraftFields? { cwd, text, worktreeBranch, linkedIssueURL }` (G16;
nil when `localPath` is nil; the store maps it 1:1 onto WS04's
`NewSessionDraft`, which is not in the Linux package).

Tests — `MantaUITests/InboxWorkTests.swift` (pure, `verify.sh`):
`testDecodeRowFieldsFromBox` (fixture copied from `view.test.mjs`
`inboxRowView` output), `testDecodeOldBoxItemWithoutLabel`,
`testFilterByTitleAndNumber`, `testFormatAgeBuckets`,
`testDraftFieldsCarryPathBranchSeedAndURL`, `testDraftFieldsNilWithoutCheckout`,
`testParentCandidatesRepoFirst`, `testDecodeNotConnected`.
Xcode-only — `MantaUITests/InboxWorkStoreTests.swift`:
`testStartSessionCallsNavigatorAndCreatesNothing` (fake client records zero
`git:add-worktree`/`tmux:new-session` calls; navigator's `pendingDraft` equals
the expected draft), `testLoadCallsInboxOnlyNotProbe`.

### E.4 Acceptance

- [ ] The session list has an Inbox button; the inbox shows assigned issues, PRs awaiting my review and my PRs with red checks, most recent first, no duplicates, filterable.
- [ ] Not connected → the desktop message plus a Connect GitHub button that, once signed in, loads the inbox.
- [ ] Start a session closes the inbox and opens the create sheet pointed at the repo, with "new worktree" ticked and the branch named `manta/{issue|pr}-N-…`, and the link shown; nothing exists on the box until Create; after Create the chat opens with "Complete <url>" in the composer, unsent.
- [ ] Cancelling that create sheet leaves no worktree, branch or session behind.
- [ ] Open review is offered only for PRs and opens the review screen without "Send to agent".
- [ ] Delegate in background asks which session to run under and confirms the job started; with no chat sessions it isn't offered.
- [ ] Every failure (no checkout, delegate refused, load error) shows a message.

---

## Libraries considered (user rule: research before building)

Source: `libraries.md` §05 (npm figures for the week 2026-10-20…26).

**Adopted**

| Library | Version · license | Adoption | Plugs in at |
|---|---|---|---|
| `diff` (jsdiff) — `parsePatch` | 9.0.0 · BSD-3-Clause | ~123M/wk, released 2026-04 | `src/server/forge/diffView.mjs` (S.2 parse; `diffView.mjs` keeps only the row/anchor/placement/truncation mapper) and `src/renderer/ToolBodies.tsx` `diffLineNumbers` (S.5 — same parser on desktop and box). Wrapped in `try/catch`; a throw becomes `message`. |
| `lru-cache` — `LRUCache` | 11.5.3 · BlueOak-1.0.0 (permissive, OSI-approved) | ~519M/wk, 2026-09; already transitive | `createLastPrCache` in `src/server/forge/view.mjs` (S.1 / G5): `new LRUCache({ max: 64 })`, key `` `${cwd}\0${branch}` ``. Same dependency as WS07's artifacts memo. |

Rejected parsers: `parse-diff` 0.12.0 (MIT, ~1.3M/wk) — fine but far less
adopted than jsdiff; `gitdiff-parser` 0.3.1 (MIT, last release 2023-03) — stale.

**Kept hand-written / native**

| Item | Candidate | Why kept |
|---|---|---|
| GitHub REST client (`forge/github.mjs`, `gitlab.mjs`, `selfhost.mjs`) | `@octokit/rest` 22.0.1 (MIT, ~16.8M/wk) | The forge layer covers GitHub, GitLab and self-hosted behind one interface; Octokit is GitHub-only and would split it, churning tested code for no parity gain. Revisit only if throttling/retry becomes a problem (`@octokit/plugin-throttling`). |
| Desktop review-row rendering (`ReviewDiffRows`) | `react-diff-view` (MIT) | The box ships rendered rows + placements; a library would re-parse the diff and fight box-owned placement. |
| iOS diff rendering | no maintained SwiftUI diff view | Native `LazyVStack` rows from `files[].rows`. |
| iOS code highlighting in review rows | HighlightSwift 1.1.0 (MIT, last release 2024-06), Highlightr (stale) | Not highlighting at all: small/stale packages, and desktop review rows are not highlighted either. |

## 7. Files

**iOS** — all new, within WS05's prefixes. WS05 edits existing iOS files only
through the mounts in §8 (wave C runs alone, D18).

| File | Kind | In Linux `Package.swift` (D19)? |
|---|---|---|
| `MantaUI/MantaAPIClient+Git.swift` | API extension (C1), members in §12 | no |
| `MantaUI/GitForgeModels.swift` | decode types for the box's views (`GitPullRequestView`, checks with `tone`, `GitDiffFile`/`GitDiffRow`/`GitPlacement`, `message`s) + KEEP-CLIENT `GitConnectOffer`, `GitMergeTarget`, `GitShipPreviewState`, `GitComposerPolicy`, `ReviewCopy.pendingLabel`, `GitForgeState` (Foundation-only) | **yes** |
| `MantaUI/GitForgeStore.swift` | `@MainActor` store (poll, ship, merge) + `GitForgeClient` + `GitSessionLookup` | no |
| `MantaUI/GitSessionHeaderRow.swift` | branch chip + checks chip + connect offer + `GitComposerBridge` (mounted view) | no |
| `MantaUI/GitBranchSheet.swift` | branch/PR sheet | no |
| `MantaUI/GitChecksSheet.swift` | checks list sheet | no |
| `MantaUI/ReviewStore.swift` | `@MainActor` review store | no |
| `MantaUI/ReviewScreen.swift` | review screen + `ReviewCommentSheet` + `ReviewReplySheet` + `ReviewScreen.forSession(_:)` | no |
| `MantaUI/InboxWorkModels.swift` | work-inbox decode types + KEEP-CLIENT filter / age / parent candidates / draft fields (Foundation-only) | **yes** |
| `MantaUI/InboxWorkStore.swift` | `@MainActor` inbox store (+ `NewSessionDraft` mapping) | no |
| `MantaUI/InboxWorkScreen.swift` | inbox sheet | no |
| `MantaUITests/GitForgeTests.swift` | XCTest, decode + client logic | **yes** |
| `MantaUITests/InboxWorkTests.swift` | XCTest, decode + client logic | **yes** |
| `MantaUITests/GitForgeStoreTests.swift` | XCTest, store (fake client) | no |
| `MantaUITests/InboxWorkStoreTests.swift` | XCTest, store | no |

There is no `ReviewDiff.swift` / `ReviewDiffTests.swift` any more (G10 is the
box's). No device-flow files (D14 — WS04's `CloneFromGitHubSignIn.swift`).
Never touch `InboxModels.swift`. `project.yml` sources the `MantaUI/`
directory, so no project edit is needed; `project.pbxproj` is regenerated once
by the orchestrator (D18) — WS05 never edits it.

**Server** (WS05 owns the new modules; S.1–S.4):

| File | Change |
|---|---|
| `src/server/forge/view.mjs` | new (S.1) |
| `src/server/forge/view.test.mjs` | new |
| `src/server/forge/diffView.mjs` | new (S.2) |
| `src/server/forge/diffView.test.mjs` | new |
| `src/server/forge/index.mjs` | `pullRequestForCwd` adds `view` + last-PR cache; `mergePullRequest` re-check + `message`; `shipPreview` / `shipPullRequest` `message`; `forgeDiffForCwd` adds `files` / placement / `draft`; draft / reply ops add `message`; `defaultForgeInbox` adds row fields via `probeRepos` |
| `src/server/forge/index.test.mjs` | extended (S.4) |
| `src/server/rpc.mjs`, `src/server/rpc.inbox.test.mjs` | M-05-srv-1 |
| `src/server/boxCapabilities.mjs` + `boxCapabilities.test.mjs` (WS02's module, append only) | M-05-srv-2 |

**Desktop** (same change, S.5): `src/shared/types.ts`,
`src/renderer/chatUtils.ts`, `src/renderer/chatUtils.test.ts`,
`src/renderer/SessionHeader.tsx`, `src/renderer/ChatPanel.tsx`,
`src/renderer/ReviewPane.tsx`, `src/renderer/ToolBodies.tsx`,
`src/renderer/InboxPalette.tsx`, `src/renderer/SessionHeader.branch.test.tsx`,
`src/renderer/SessionHeader.checks.test.tsx`, new
`src/renderer/ReviewPane.test.tsx`, new `src/renderer/InboxPalette.test.tsx`.

**Root dependencies** (`package.json` / `package-lock.json` — WS05 is the sole
worker of wave C, so it edits them itself; no ledger row needed):
- `npm install diff@9.0.0` — jsdiff, BSD-3-Clause, ships its own TypeScript
  types (no `@types/diff`). Used by `src/server/forge/diffView.mjs` and
  `src/renderer/ToolBodies.tsx`.
- `lru-cache@11.5.3` is already a direct dependency once wave B lands (WS07
  adds it, master ledger row M-07-pkg-1). WS05 only checks it is listed under
  `dependencies`; if wave B did not land it, run `npm install lru-cache@11.5.3`
  here instead.
- A new dependency reaches boxes only through the next server release tarball
  (root AGENTS.md "A clean install runs the RELEASE's source") — ships with
  this workstream's server code in one release.

Verification for the server/desktop half: `npm run typecheck`, `npm test`
(vitest + `node --test src/server/**`), all green; any test that fails must be
shown to fail identically on `main` before it is dismissed.

## 8. Mount requests

Wave C runs WS05 alone, so per D18 WS05 applies all of its own mounts in any
file; `Package.swift` goes through the wave-C integration step (D18/D1).

| ID | Receiving file | Applier (D18) | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-05-1 | `ChatScreen.swift` (`ChatScreenContent.sessionHeaderBlock`, today :1131-1150) | WS05, wave C | `GitSessionHeaderRow(branch:relPath:cwd:sessionId:shipModel:readOnly:tokens:)`; consumes `ChatSessionStore.isBackgroundJobReadOnly` (WS02), `EnvironmentValues.composerController` + `ComposerTextController.acceptsInput` (WS03) | (a) Replace the `subtitleChip` call with `GitSessionHeaderRow(branch: branch, relPath: branchRelPath, cwd: sessionWindow?.cwd, sessionId: store.sessionId, shipModel: modelStore.override, readOnly: store.isBackgroundJobReadOnly, tokens: tokens)`; delete the now-unused `subtitleChip` / `branchCapsuleInfo` (the row renders the identical plain label when the forge isn't in play). (b) Verify WS02's M-03-7 binding (`.onAppear` + `.onChange(of: store.isBackgroundJobReadOnly)` setting `composer.acceptsInput = !store.isBackgroundJobReadOnly`) is present (A.3a layer 2); add exactly that binding only if missing. ChatScreen's own branch poll is untouched. | WS02 wave B landed (`isBackgroundJobReadOnly`, M-03-7); WS03 M-03-3 (`composerController` env on `ChatScreenContent`) |
| M-05-2 | `SessionListView.swift` | WS05, wave C | `InboxWorkScreen(onClose:)` (WS05); `MantaNavigator.startNewSession(_:)` (WS04) | (a) `SheetRoute` gains `case inbox` (`id: "inbox"`); (b) new `ToolbarItem(placement: .topBarTrailing)` before the `+` button: `Image(systemName: "tray")`, `.accessibilityLabel("Inbox")`, action `sheetRoute = .inbox` (with the existing selection haptic); (c) `sheetContent` case `.inbox` → `InboxWorkScreen(onClose: { sheetRoute = nil })`. The inbox's Start-a-session sets `sheetRoute = nil` then `navigator.startNewSession(draft)`, which WS04's `pendingDraft` consumer turns into `.create`. | WS04 wave A2 (`MantaNavigator.startNewSession`, `pendingDraft` consumer) |
| M-05-3 | `SessionListView.swift` (WS04's `navigator.pending` consumer) | WS05, wave C | `ReviewScreen.forSession(_:)` | WS04's consumer ignores `.review` (04-sessions §11). Add: `case .review(let sid)`: dismiss the settings cover, `sheetRoute = .review(sessionID: sid)` (new `SheetRoute` case, `id: "review:\(sid)"`), clear `pending`; `sheetContent` → `NavigationStack { ReviewScreen.forSession(sid) }` (resolves cwd via `GitSessionLookup.cwd(for:in: store.projects)`; unknown session → "That session is no longer open"; `onSendToAgent: nil`). | WS04 wave A2 navigator consumer |
| M-05-4 | `mobile/native/Package.swift` | Integration agent C (IC), after C (D18/D20; owner WS07 per D1) | — | Append `GitForgeModels.swift`, `InboxWorkModels.swift` to the `MantaUI` target `sources`, and `GitForgeTests.swift`, `InboxWorkTests.swift` to `MantaUITests` `sources`; then `./verify.sh` must pass (D19). (`ReviewDiff*` removed by the server-first revision.) | WS05 files exist (end of wave C) |
| M-05-srv-1 | `src/server/rpc.mjs` (`forge:inbox`, :990) | WS05, wave C (sole worker, D24) | `forgeInbox(deps)` with `deps.probeRepos` (WS05, `forge/index.mjs`) | `"forge:inbox": () => forgeInbox({ probeRepos: () => local.forgeProbe() })` | `view.mjs` landed |
| M-05-srv-2 | `src/server/boxCapabilities.mjs` (WS02, wave B) | WS05, wave C (sole worker, D24) | `BOX_CAPABILITIES` (WS02) | Append `forge-pr-view-1`, `forge-diff-view-1`, `forge-inbox-view-1`, `forge-messages-1` (S.3/S.6) | WS02 SF-0 landed (B) |
| — | `src/server/streamInterp.mjs` | — | — | no change | — |

## 9. Mounts applied by this workstream

| ID | Requested by | Receiving file | Status |
|---|---|---|---|
| M-05-1 … M-05-3 | WS05 | as above | applied by WS05 in wave C |
| M-05-srv-1 | WS05 | `src/server/rpc.mjs` (`"forge:inbox"`) | applied by WS05 in wave C (sole worker, D24; master row C1) |
| M-05-srv-2 | WS05 | `src/server/boxCapabilities.mjs` + `boxCapabilities.test.mjs` (append four ids) | applied by WS05 in wave C (D25; master row C2) |

Matches the master's canonical mount ledger (`00-master.md`, rows M-05-1 …
M-05-4: same files, appliers WS05/C and IC after C) and the receiving tables of
WS02 ("Not received / superseded": `sessionHeaderBlock` applied by WS05) and
WS04 (§15: inbox button + `.review` handler applied by WS05). M-03-7 is applied
by WS02 in wave B (WS02 F6); M-05-1(b) only verifies it. No other
workstream requests a mount in a `Git*`, `Review*` or `Inbox*` file, and none is
assigned to WS05 as applier. (WS10's GitHub settings row does not add a Connect
button — `10-settings-box.md:368-369`.)

## 10. Contracts provided / consumed

**Consumed**
- **C1/D16/D21**: internal `call`/`callRequired`/`jsonObject`; WS10's
  `forgeStatus(validate:) -> ForgeConnectionStatus`; existing
  `configGet`/`configUpdate`/`projects()`. (No iOS client probe call: the box
  joins `localPath` itself, injecting `local.forgeProbe` through M-05-srv-1.)
- **C2**: `MantaNavigator.startNewSession(_:)` (inbox) and `.review(sessionID:)`
  handling (M-05-3, WS05 implements it per C2).
- **C3/D6**: `EnvironmentValues.composerController`,
  `insert(text:mode: .append)` → Bool (every `false` surfaced),
  `acceptsInput`. `.append` = existing draft + one blank line + text.
- **D2/D11/D12**: `NewSessionDraft(cwd:, text:, attachments: [],
  worktreeBranch:, linkedIssueURL:)`; one Create tap; no worktree/session
  created by WS05; `forgeIssue` dropped.
- **D5/D14**: `GitHubDeviceSignInView(onConnected:onCancel:)`.
- **C4**: M-05-1 (branch chip → `GitBranchSheet`, checks chip beside it).
- **C5/C6**: none. `forgeConnectOfferDismissed` uses `config:*`, not the schema.
- **C7/D19**: pure tests under `verify.sh`; store tests on the Mac; node tests
  for `view.mjs`, `diffView.mjs` and the extended `forge/index.mjs` (S.4);
  vitest updates for the desktop switch (S.5).
- **D23/D24/D25**: server-first section above; capability ids
  `forge-pr-view-1`, `forge-diff-view-1`, `forge-inbox-view-1`,
  `forge-messages-1` in WS02's `boxCapabilities.mjs`; read via WS02's
  `MantaAPIClient.boxCapabilities()` (iOS) and `useBoxCapability(id)`
  (desktop) — WS05 declares no capability accessor of its own.

**Provided**
- `ReviewScreen` + `ReviewScreen.forSession(_:)` (C2 `.review`).
- Box fields (S.1/S.2) consumed by the desktop in this change and available to
  WS11: `forge:pull-request.view`, `forge:diff.files/placement/draft`,
  `forge:inbox` row fields, `message` on forge failures.
- The §C.3 behavioural contract that WS04's sign-in view implements (D5).

## 11. Deferred

- **Approve without any line comment** — the box refuses to submit a draft with
  zero comments (`draftSubmitForCwd`, forge/index.mjs:1418), and the desktop
  hides the bar at zero. Supporting it is a server change outside parity.
- **Automatic "Closes #N" for inbox-started sessions** — dropped by D12 (the
  create sheet has no `forgeIssue` pass-through).
- **Editing a buffered draft comment** (`op:"edit"`) — no desktop UI.
- **Multi-line comment ranges** (`startLine`) — desktop never sends one.
- **Live refresh from `forge-draft.updated` / `forge.inbox.invalidated`** — no
  client consumes them; iOS stays refetch-driven.
- **Choosing the merge method** — desktop always sends `"merge"`.

## 12. Client members

New `MantaAPIClient` members, all in `MantaUI/MantaAPIClient+Git.swift`
(grepped every other spec: no other workstream declares these names):

```swift
func forgePullRequest(cwd: String) async throws -> GitPullRequestResult            // forge:pull-request
func forgeShipPreview(cwd: String, model: OpencodeModelID?, sessionId: String?) async throws -> GitShipPreviewResult  // forge:ship-preview
func forgeShip(cwd: String, title: String, body: String) async throws -> GitShipResult   // forge:ship
func forgeMerge(cwd: String, number: Int, sha: String) async throws -> GitMergeResult    // forge:merge (method "merge")
func forgeDiff(_ ref: GitRef) async throws -> GitDiffResult                               // forge:diff
func forgeDraftComment(_ ref: GitRef, op: GitDraftOp) async throws -> GitDraftCommentResult  // forge:draft-comment
     // GitDraftOp: .add(path:line:side:body:) | .delete(id:) | .setVerdict(GitVerdict?)
func forgeDraftSubmit(_ ref: GitRef, verdict: GitVerdict?) async throws -> GitDraftSubmitResult  // forge:draft-submit
func forgeThreadReply(_ ref: GitRef, threadId: String, body: String) async throws -> GitThreadReplyResult  // forge:thread-reply
func forgeInbox() async throws -> WorkInboxResult                                         // forge:inbox
func delegateStart(prompt: String, sessionID: String, directory: String) async throws -> GitDelegateStartResult  // delegate:start
```

(`forgeDraftGet` is not declared: the draft now arrives with `forge:diff`.)

**Not declared by WS05** (consumed, D16/D21/D25): `boxCapabilities() -> Set<String>`
(WS02, `MantaAPIClient+ChatCards.swift`); `forgeStatus(validate:)` +
`ForgeConnectionStatus` (WS10); `forgeDeviceStart/Poll/Cancel` (WS04; WS05
never calls them, it presents the view). WS05 no longer calls WS04's
`forgeProbe()` either — the inbox's `localPath` comes from the box (G13);
`configGet`/`configUpdate`/`projects` (existing). WS05 must not declare any of
these, nor `gitAddWorktree`, a zero-argument `forgeStatus()`, or any alias such
as `repoProbe()`.

## 13. Open questions

None blocking. (Round-1 questions 1–4 are settled by D12, D5/D14, D6 and D9.)

## Review responses (round 1)

Per-workstream review (`reviews/round1/05-git-pr-review.md`):

1. **BLOCKING — inbox creation vs D2.** Fixed (§E.2, §E.4, §10, §11): the inbox
   builds `NewSessionDraft(cwd: repoPath, text: seed, worktreeBranch:,
   linkedIssueURL: url)` and calls `navigator.startNewSession`; no
   `git:add-worktree`/`tmux:new-session` call from WS05; Create is the only
   mutation; `forgeIssue` dropped per D12 (deferred item). New acceptance
   "cancelling the create sheet leaves nothing behind" + store test asserting
   zero mutating calls.
2. **BLOCKING — device-flow ownership.** Fixed (§4 C.2–C.4, §7, §12): WS04 owns
   `GitHubDeviceSignInView`/`GitHubDeviceSignInStore` + `forgeDevice*` (D14; name corrected in round 2);
   WS05 deleted `GitConnectGitHubSheet`, `GitDeviceFlow*`, their tests and its
   device client methods, and only presents WS04's view. §C.3 is the behavioural
   contract D5 points at.
3. **BLOCKING — read-only chats.** Fixed (A.3a, B.2, D.2, acceptance A.5/D.4):
   bridge is nil when `composerController` is nil or `acceptsInput` is false →
   `onSendToAgent: nil` / `onSendFailures: nil`; second guard re-checks at call
   time and `insert` itself returns false (WS03 contract, kept current by M-03-7).
4. **BLOCKING — merge snapshot.** Fixed (A.3): `GitMergeTarget` captured on tap,
   dialog rendered from it, `merge(_ target:)` never rereads state; no force
   unwraps; store tests for a poll replacing and clearing the PR.
5. **SHOULD — ship preview cache.** Fixed (A.3/A.4): preview keyed by
   `{cwd, branch, base}`, late responses discarded, invalidated on branch/base
   change, Create enabled only for a matching ready preview; same-cwd
   branch-switch tests.
6. **SHOULD — LEFT threads on context rows.** Fixed (D.3): matching by
   `oldLine` for LEFT and `newLine` for RIGHT; draft `.both` uses the new line;
   unequal-offset fixture test.
7. **SHOULD — non-forge chip gating.** Fixed (A.3/A.4): interactivity needs
   connected + recognised forge kind + non-nil forge branch; the label stays
   ChatScreen's ordinary branch; test for a connected account in a non-forge repo.
8. **SHOULD — device-flow lifecycle.** Fixed in the contract WS04 implements
   (§C.3 "Lifecycle"): one loop owner, generation guard, cancellation on every
   exit with awaited cancel + logged failure, foreground wake that cannot spawn
   a loop, and four required lifecycle tests.
9. **SHOULD — Done while busy.** Fixed (A.3): Done disabled and guarded while
   creating/merging, plus `interactiveDismissDisabled`; acceptance covers both.
10. **NIT — Package ownership.** Fixed (§8 M-05-4): applier is the wave-C
    integration step on WS07's file (D1/D18).

Cross-cutting review (`reviews/round1/00-cross-cutting.md`), findings naming WS05:

- **#2 producers bypass create flow** — same fix as finding 1.
- **#4 sign-in provider names** — same fix as finding 2; D14 names used verbatim.
- **#6 duplicate `forgeStatus()`** — WS05 no longer declares it; consumes WS10's
  `forgeStatus(validate:)` with `validate: false` (§1, §12).
- **#8 mount ledger** — §8/§9 tables with IDs, appliers, providers and
  prerequisites; all WS05 mounts are applied by WS05 in wave C.
- **#10 package scheduling** — M-05-4 scheduled after WS05's files exist, via
  the wave-C integration step; pbxproj left to the orchestrator.
- **#12 append semantics** — `.append` is one blank line everywhere (C3), Send
  failures appends (D6); the desktop's single-newline review bridge noted as an
  accepted cosmetic difference (D.2).

## Review responses (round 2)

Per-workstream review (`reviews/round2/05-git-pr-review.md`):

1. **BLOCKING — nonexistent `repoProbe()`.** Fixed (header, §1 consumed table,
   §E.2, §10, §12): the inbox calls WS04's `forgeProbe() async throws ->
   ForgeProbeResult` and reads `RepoHit.path`/`repoKey` (04-sessions.md:1285,
   1236); device members are named `forgeDeviceStart/Poll/Cancel`
   (04-sessions.md:1286-1288) and documented as not called by WS05. No alias
   added; §12 forbids one. WS05 calls only `forgeProbe()` of that list (WS04's
   reuse note now agrees).
2. **BLOCKING — read-only guard source.** Fixed (A.3a, M-05-1): the header now
   takes `readOnly:` bound to `ChatSessionStore.isBackgroundJobReadOnly` (the
   member WS02 provides, 02:845) AND relies on WS02's M-03-7 binding
   `composer.acceptsInput = !store.isBackgroundJobReadOnly` (canonical form
   after reconciliation), which WS02 applies and acknowledges (WS02 F6). Pure `GitComposerPolicy.canInsert`
   truth-table test plus Xcode bridge tests against a real
   `ComposerTextController` through read-only → writable transitions.
   M-05-1(b) verifies the binding instead of adding a second one.
3. **SHOULD — device lifecycle in WS04's API.** Tightened §C.3 against WS04's
   pinned API: `cancel()` must be `async` and awaited before `onCancel`;
   failure logged by the live adapter `ServerGitHubDeviceSignIn` (`os_log`);
   generation token bumped before `api.start()` so late start replies are
   dropped; `sceneBecameActive()` only wakes the existing loop. Five named
   store tests. Reconciliation: WS04 §6 now specifies all of it (API,
   comment, the five tests); WS05 calls `forgeProbe()` only.

Cross-cutting review (`reviews/round2/00-cross-cutting.md`), findings naming WS05:

- **#5 writability never propagated** — WS02 now applies M-03-7 (02:444-449);
  WS05 consumes it and additionally gates on `isBackgroundJobReadOnly`
  (A.3a); transition tests specified.
- **#9 missing probe method** — same fix as finding 1.
- **Ledger rows M-05-1 … M-05-4** — §8/§9 match the consolidated ledger;
  M-05-1's prerequisite now cites WS02's M-03-7 instead of leaving it missing.

## Review responses (server-first)

Per `_serverfirst-revise-brief.md`, D23/D24 and `server-first-audit.md` §WS05:

- **Folded (MOVE-NOW):** G1 (panel/ship state + copy, chip label,
  interactivity), G2 (merge gate + mergeable display, re-checked by
  `forge:merge`), G3 (merge failure `message`), G4 (ship / ship-preview
  `message`), G5 (box-side last-PR cache — fixes the desktop flip), G6 (checks
  pre-ordered with `tone`, counts, chip), G7 (`failuresPrompt`, `logsUrl`), G10
  (structured diff + coordinate placement of threads and drafts in
  `forge:diff`), G11 (review `message`s), G13 (inbox row fields + `localPath`).
  New modules `src/server/forge/view.mjs` and `src/server/forge/diffView.mjs`
  with node tests; additive fields only, no new channel names.
- **iOS rewritten to render** (A.3, A.4, B.2, B.3, D.2, D.3, E.2, E.3): the
  planned `GitPanel`, `GitChecks`, `GitCopy`, `ReviewDiff` and `WorkInbox`
  derivations are deleted from the plan; their XCTests became decode tests of
  the box's shapes; `forgeProbe()` and `forgeDraftGet` are no longer called by
  iOS.
- **Desktop migrated in the same change** (S.5): the matching `chatUtils.ts`
  functions and their vitest blocks are deleted; `SessionHeader`, `ChatPanel`,
  `ReviewPane`, `InboxPalette` render the box's fields; `UnifiedDiff` loses the
  review gutter; the desktop stops swallowing review errors and no longer drops
  context-line threads.
- **Compatibility (D24):** capability ids (renamed to the master id format in
  reconciliation) `forge-pr-view-1`, `forge-diff-view-1`,
  `forge-inbox-view-1`, `forge-messages-1`; on an older box each dependent
  surface shows "Update your box to …" (S.6). No fallback logic.
- **Reconciliation (server-first):** the ids are appended to WS02's
  `src/server/boxCapabilities.mjs` (D25) — the conditional
  `serverCapabilities.mjs` is withdrawn, and M-05-srv-2 no longer touches
  `index.mjs` / `rpc.mjs`. Clients use WS02's accessors. `forgeDraftGet` and the
  client `forgeProbe()` call are removed from the master registry row.
- **KEEP-CLIENT (unchanged in the clients):** G8, G9, G12, G14, G15, G16, and
  the comment-count plural.
- **One deviation from the audit wording:** drafts are placed by `forge:diff`
  (which now also returns the reconciled draft) rather than by
  `forge:draft-get`, because placement needs the diff and `forge:diff` already
  has it; `forge:draft-get` gains only `message`.
- No audit item rejected.

## Review responses (server-first review)

Review `reviews/server-first/05-git-pr-review.md`:

1. **BLOCKING — parser copies the `+++`/`---` bug.** Fixed (S.2): the parse is
   hunk-aware — headers are recognised only outside a hunk, the `@@` counts
   bound the hunk, and inside it only the first character decides the row
   kind. Verified the bug against `chatUtils.ts:4462-4474` (header tests run
   before content handling). New node fixtures: added `+++ heading`, removed
   `-- heading` / `--- a/x`, added `@@ x`, `\ No newline`, with rows,
   counters, anchors and following-thread placement asserted.
2. **SHOULD — placement after mutations.** Fixed (S.2, D.2, D.3, S.5): one
   id-based reconciliation rule for both clients (keep known ids, tapped row
   for the single new id, drop deleted ids, refetch `forge:diff` on unknown ids
   or a head/stale change); pure helpers `ReviewDraftMerge.merge` (iOS) and
   `mergeDraftPlacements` (desktop) with add/delete/set-verdict tests on both.
   No client derives a placement from an anchor.
3. **SHOULD — tool-output line numbers.** Fixed (S.5): `UnifiedDiff` keeps its
   numbers through a local presentational `diffLineNumbers` (numbers only, no
   anchors, desktop-only because iOS tool output has no numbers), using the
   same hunk-aware counting; multi-hunk regression fixture in
   `UnifiedDiff.test.tsx`.
4. **SHOULD — inbox tone vocabulary.** Fixed (S.5): `inboxDotTone` maps
   `danger → error`, `warn → warn`, `muted/unknown → idle` at the row; the
   vitest asserts the red/amber/grey dot classes.
5. **NIT — stale §9/§10.** Fixed: §9 lists M-05-srv-1 (`rpc.mjs`) and
   M-05-srv-2 (`boxCapabilities.mjs` + test) as in master rows C1/C2; §10 no
   longer lists `forgeProbe()` as consumed.

No master-table change was needed.

## Review responses (server-first-2)

Review `reviews/server-first-2/05-git-pr-review.md` (no
`00-cross-cutting.md` in that round):

1. **BLOCKING — parser failure looked like an empty diff.** Fixed (S.2, D.2,
   S.5): additive `parseFailed: true` with `message`, `error` left `null`;
   every thread/draft comment placed `unplaced` so nothing is lost; a pinned
   state precedence for both clients (`error` → `parseFailed` → empty → diff)
   so "No diff." can never show for a parse failure; Try again + Open on
   GitHub. Node fixtures (diffView + `forgeDiffForCwd` with a successful fetch
   and malformed text), vitest and iOS store tests assert the message is shown
   and "No diff." is absent.
2. **SHOULD — zero-length range headers.** Fixed (S.2): the hunk header text
   subtracts 1 from a start whose count is 0 (undoing `parseHunk`'s
   normalisation); row counters keep the normalised starts. Insertion-only and
   deletion-only fixtures assert header text and row numbers.
3. **SHOULD — `draft: null` after a mutation.** Fixed (S.2 rule 5, D.3, S.5):
   both helpers accept a nullable response and return a nullable draft; null
   clears draft cards and the pending bar without error or refetch. Tests on
   iOS and desktop for "loaded here, cleared elsewhere, Remove returns null".

No master-table change was needed; no new library (the `diff@9.0.0` choice in
"Libraries considered" is unchanged).
