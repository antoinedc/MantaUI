# Code review — WS11 D8–D10 (turn footer + truncation, canonical media, plan question data)

**Reviewer:** Opus (main session). **Brief:** `_code-review-brief.md`.

**Commits reviewed (`git show` only; D11 work in the worktree is out of scope):**

| Step | Commit | What |
|---|---|---|
| D8 | `6a5a6ca3` | turn footer + truncation on the box (`message.view`, truncation `hint`) |
| D9 | `cfd35ccb` | canonical inline media on the box (`view.media`, `part.view.media`), `transcript-view-1` |
| D10 | `58ec5b9c` | plan question data on the box (`question.plan`), `questions-plan-1` |
| D9 fix | `d831f84a` | `toolRendering` tests use the box's `part.view.media` mark |

## Checks

All checks ran in the foreground on a `git archive d831f84a` snapshot.

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run test:server` | 6298 pass, 1 fail |
| `npx vitest run` | 253/253 files, 4831 pass |
| Swift | read, not compiled (no toolchain on this box) |

- **The server failure** is the known `upgradeV2Reclaim.test.mjs` flake under load. It passed 76/76 in isolation, and no reviewed commit touches it.
- **What I checked in the Swift** (reading only):
  - the new `QuestionRequest` / `OpencodeMessage` initialisers against every call site;
  - no remaining references to the deleted `PlanDerivation`, `TranscriptMediaParse`, `TranscriptTurns.info`, `TranscriptTruncation.classify/describe/kind`, `TranscriptMediaMime.forPath` or `planPageURL`;
  - `Package.swift`: `PlanDerivation.swift` is gone and `TranscriptViewModels.swift` is listed. `BoxViewFixture` lives only in the Mac XCTest target, which is correct because the Linux `MantaUITests` source list doesn't include the mapper tests that use it;
  - the capability sink (`ChatSessionStore.swift:463-471`) uses the same `receive(on: .main)` + `[weak self]` shape as the existing `chatCards` sink beside it.

## Focus-area results

### Logic moved, clients switched, old copies deleted

| Logic | Desktop removed | iOS removed |
|---|---|---|
| Turn footer | `computeTurnInfo` | `TranscriptTurns.info` |
| Truncation | `describeTruncation` / `classifyFinish` (renderer imports) | `TranscriptTruncation.classify/describe/kind` |
| Canonical media | `filePartToMediaEntry`, `isMediaMime` | `TranscriptMediaParse`, `TranscriptMediaMime.forPath` |
| Plan question | `isPlanExitQuestion`, `extractPlanData`, the client page URL | `PlanDerivation.swift` |

- **Truncation** is the box's `{kind, label, hint}` on both the canonical view and the live frame. `streamInterp.test.mjs:208` pins the frame against the view.
- **Plan card:** `push.mjs`'s private plan predicate is deleted and it imports the ONE `isPlanExitQuestion`.
- Guard rows were added for each step.

### Older-box gating

| Client | Behaviour | Verdict |
|---|---|---|
| iOS | Sends `view: true` only when `transcript-view-1` is known. A capability list that turns true after the first fetch triggers one refetch (`dropFirst` + `filter`). With the capability unknown the request is byte-identical to before. | Correct |
| Desktop | Always sends `{view:true}`. An older box's `opencode:messages` passes unknown opts to `listMessages`, which ignores them; its `opencode:message` takes two args, so a third is dropped. | Correct |

What an older box loses:
- footers;
- reload-time truncation;
- canonical media;
- the plan card (the question stays an ordinary, answerable card);
- on desktop, inline rendering of image/video **file parts**, which now stay file cards.

The spec lists all of these as fallbacks except the last. That one is a new loss. It is accepted (see Deviations), because the file card is still a working control.

### Additive wire

- `message.view`, `part.view`, `question.plan` and the truncation frame's `hint` are all new optional fields.
- With `view` not set, `listMessages`/`getMessage` output is unchanged (`annotateView` runs only on `view === true`).
- `opencode:messages` overrides `running` with the interpreter's value, so a client can't forge the gate.

### iOS transcript row identity (`mobile/native/AGENTS.md`)

All ids are still derived from the block alone:
- **Footer rows:** stay `tf-<messageID>`.
- **Media rows:** use the box's `id`, which is the unchanged `TranscriptMediaIdentity` rule (`media:h:<handle>` / `media:s:<messageId>:<path>`). `seq` is now the transcript-order index, which is deterministic.
- **The plan card:** keyed by question id.
- **Duplicate ids:** the iOS transcript is replaced wholesale per fetch ("load earlier" widens the tail rather than appending a page). The box de-duplicates media by id within one window, so a duplicate media id can't arise. `uniqueTranscriptRows` still backstops it.
- **Decoding:** lossy (`LossyList`, `try?` on every view field), so a malformed `view` or `plan` never costs its message or question.

### WS01 live-media rule and display options

- **Live-media rule:** `TranscriptMediaReconcile.liveOnly(live:canonical:)`, the live reducer and geometry are untouched. Only the canonical source changed, from parsing tool output to `view.media`.
- **Display options:** `TranscriptDisplayOptions` (incl. `fetchSlim` and its refetch-on-change) is intact. `refetch` passes `slim` and `view` together.
- **Slim:** the box computes `view` before `slimTranscript`, so a slim fetch still gets truncations whose `step-finish` part slim drops.

### `BoxViewFixture`

**It does not mask a mismatch today.** I compared it rule by rule with `transcriptView.mjs` and `streamInterpretation.mjs`:

- **Turn start:** a user message or a background-result message starts a turn.
- **Tokens:** Σ output + reasoning, with zero mapped to nil.
- **Seed and duration:** the seed is the first assistant message, and the duration is first `created` to last `completed`, null when ≤ 0.
- **Footer requirements:** the turn needs `time.completed`, and the running gate applies to the window's last message.
- **Truncation:** the last non-empty `step-finish` reason wins over `info.finish`. `tool-calls` + `max_tokens`/`length` gives `tool-cutoff`.
- **Words:** labels and hints are verbatim copies of `describeTruncation`.

It is, however, a second copy that no test ties to the first; see NIT 5.

### Implementer's deviations

| Deviation | Verdict | Notes |
|---|---|---|
| Footer lingers ~300 ms (iOS) | **Accepted** | The old client gate hid the previous turn's footer while `running` was set and the new user message had not arrived yet. The box gate decides at fetch time, so the finished footer simply stays. That removes a flicker rather than adding one. |
| `data:` images stay file chips | **Accepted** | The old desktop would have asked the box to peek a `data:` URL, which never worked. |
| Plan headings must start their line | **Accepted** | This was the desktop rule; the phone's indented-heading tolerance was an accident. `planMetrics` still trims before matching step headings, as the phone did. |
| "Open page" hidden without a public URL | **Accepted** | No control without an action, on both clients. The desktop previously built the URL from the URL it was connected through (`serverBase()`); the box's `publicBaseUrl()` resolves a tailnet box to its tailnet URL, so the link is the same in practice. |
| Splice keeps the previous `view.turn` | **Accepted as a rule** | Correct, because a lone message can't carry a turn. But today it is the ONLY way a desktop footer survives, which hides BLOCKING 1. |
| `MediaView` also carries `aspectRatio` / `count` | **Accepted** | Additive, and needed for the begin's reserved geometry. |
| Older-box desktop file parts lose inline media (`d831f84a`) | **Accepted** | Decoration only; the file card works. Add it to the spec's D9 capability-fallback line for the record. |

## Findings

### BLOCKING

**1. Desktop: a live turn's footer never appears, because nothing refetches when the turn ends.**
- **Where:** `src/renderer/hooks/useSseBus.ts:586-602` (`turnComplete` settle timer) and `:576-585` (`running`).
- **Problem:** before D8 the desktop computed footers itself from the spliced messages, so a footer appeared as soon as the turn finished. Footers now come only from `view.turn` on a FULL `opencode:messages` fetch, and a splice (`getMessage`) never carries a turn (`annotateSingle` strips it). The spec ("Correctness while streaming") requires a NEW `scheduleRefetch()` in the `turnComplete` settle timer for exactly this reason: "Turn footers need the whole turn, so they arrive with the canonical refetch the desktop now schedules when `running` settles to false". It was not added.
- **What remains:** the main-session refetch triggers are mount, resync, an unmatched flush, `transcriptStale` (compaction), a child going idle, and reactivation.
- **Effect:**
  - an ordinary turn (no subagent, no compaction) ends with no footer;
  - a truncated turn shows its badge only through the live `finishByMessageId` entry, not the canonical view;
  - the footer appears only after a reload, a reconnect or switching away and back.

  This is a visible regression on the main desktop surface. Neither `ChatPanel.harness.test.tsx` nor `useSseBus.test.tsx` drives a turn to its end through splices and asserts a footer, so the suite stays green.
- **Fix:**
  - call `scheduleRefetch()` inside the settle timer, after `setRunning(false)`;
  - also call it in the `running` case when `nowRunning === false` (the authoritative signal cancels the timer, so the timer's refetch would never run);
  - also call it in the `sessionError` branch, which ends a turn too.

  The 300 ms refetch debounce coalesces the duplicates.
- **Test:** a `useSseBus`/harness test that starts a turn, delivers the final assistant message via `messageChanged` (splice, no `view.turn`), ends it with `turnComplete {complete:true, running:false}`, and asserts one `opencodeMessages(sid, {view:true, …})` call and a rendered footer once it resolves. Repeat with a bare `running:false` frame.
- **CtoChat:** check whether it needs the same treatment. It refetches on receipt and on queue changes, so it may already be covered; say so in the reply either way.

### SHOULD

**2. D10: a question decorated before its `plan_exit` part is readable stays a plain card forever.**
- **Where:** `src/server/questionsDecorator.mjs:106,128,176-197`.
- **Problem:** when `question.asked` arrives, the decorator reads the transcript once. If the matching `plan_exit` tool part isn't there yet, it:
  1. caches the negative for 10 s;
  2. publishes the question undecorated;
  3. never looks again.

  Nothing re-publishes the `questions` frame when the part appears. The connect snapshot and `opencode:questions` both decorate from the cache, so after 10 s they would look again, but only on a reconnect or an explicit questions read. Before D10 both clients re-derived the plan card on every transcript change, so a late part still upgraded the card.
- **Impact:** if the race happens, the plan card (Build here / Keep planning / delegate) is replaced by a generic question for the whole ask. It is still answerable, but the plan flow's main controls are missing. Whether V2 always has the running tool part readable before it emits the question is not pinned by any test or comment.
- **Fix:**
  - when a lookup comes back negative for a callID that is still in the session's latest question list, re-check once on that session's next `messageChanged`/`toolBoundary` frame passing through the decorator's `publish`, or once after ~1 s;
  - re-publish the latest list if it now decorates and no newer `questions` frame has overtaken it (the existing `seq`);
  - add a test: first read without the part, second with it, and expect one undecorated publish then one decorated publish.

  Alternatively, show with a test against the V2 event order that the part is always persisted before `question.asked`, and say so in a comment.

### NIT

**3. Desktop: a generated image can be drawn twice after a desktop restart in the middle of a generation.**
- **Where:** `src/renderer/MessageRow.tsx:487`.
- **Problem:** the live map is keyed by the message id each `media` event carries, so `begin` (message A) and `show` (message B) land on different keys. "Live wins" is decided per message.
- **Normal case — no duplicate:** after a refetch, A carries `view.media` but also has its live pending entry, so the canonical card is hidden.
- **Restart case — duplicate:** if the app restarted between `begin` and `show`, A has no live entry and B does. After the next refetch, A draws the canonical card for `media:h:X` and B draws the live card for the same handle.
- **Fix:** skip a canonical entry whose `handle` (or `id`) matches any live entry in the session.

**4. `questionsDecorator`: `latest` is written but never read.**
- **Where:** `questionsDecorator.mjs:120,183`.
- **Problem:** the spec says "The decorated list is stored so `snapshotState()` replays it". Instead the snapshot re-decorates from the cache, so a negative older than 10 s replays plain. That is equivalent while the positive cache holds.
- **Fix:** either have `decorateSnapshot` prefer `latest.get(sid)` when its question ids match the snapshot's, or delete `latest`.

**5. `BoxViewFixture` is a second copy of the box's rules with nothing tying it to the first.**
- **Where:** `MantaUITests/BoxViewFixture.swift`.
- **Problem:** it matches today (see above), but if `transcriptView.mjs` changes a rule, the Mac mapper tests stay green on the old one.
- **Fix:** have `transcriptView.test.mjs` assert `annotateView(fixture)` against a checked-in golden JSON (e.g. `mobile/native/MantaUITests/Fixtures/transcript-view.golden.json`), and have the Swift mapper tests decode that file instead of stamping. Only the box's rules are then exercised, and drift fails the node test.

**6. The spec's D9 capability-fallback line should list the desktop file-part loss.**
- **Where:** `11-server-consolidation.md`, D9 "Capability fallback".
- **Problem:** `d831f84a` made the desktop draw an image/video file part inline only when the box marked it, so on an older box it is a file card. The spec's fallback line doesn't mention this.
- **Fix:** record it so the next reader doesn't take it for a regression.

**7. The `turnComplete` comment in `useSseBus.ts` is outdated.**
- **Where:** `useSseBus.ts:593-597`.
- **Problem:** the comment says `running:false` "fires at every tool-step boundary". The box now emits `turnComplete` only when an execution ends (`streamInterp.mjs` `emitTurnComplete` call sites).
- **Fix:** when fixing BLOCKING 1, correct the comment so the refetch's placement isn't argued from a false premise. The settle can stay as a guard.

## Summary

The box side is solid:
- the rules moved verbatim and are well tested, including cross-message begin/show, paths with spaces and parentheses, the running gate and step-finish precedence;
- the wire is additive;
- the iOS row identity and live-media rule are intact.

One desktop regression blocks: footers never appear for a live turn because the spec's turn-end refetch was not added.

**Counts:** 1 BLOCKING, 1 SHOULD, 5 NIT.

VERDICT: CHANGES REQUIRED
