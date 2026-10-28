# Libraries review — iOS ↔ desktop parity (user rule: research before building)

Date: 2026-10-28. Scope: unbuilt specs 02, 05, 06, 07, 11; verification of 09's
"Libraries considered"; scan of built wave-A code (WS01/03/04/08/10).

Adoption figures: npm weekly downloads for the week 2026-10-20…26
(`api.npmjs.org`), latest version/registry-modified date from `npm view`;
GitHub stars/last release from the GitHub API.

Legend: **ADOPT** (real win, low risk) · **KEEP** (hand-written, reason given)
· **ALREADY-USED** (a library/system framework already does it).

## 02 — chat cards, queue

| Functionality | Spec plans | Candidates | Recommendation | Where |
|---|---|---|---|---|
| Inline markdown in card bodies (retry `detail`, approval copy) | `AttributedString(markdown:)` | MarkdownView 3.0.0 (already in `project.yml`); Foundation | **ALREADY-USED** (Foundation for inline, MarkdownView for blocks) | F1/F3 views |
| Compaction "Compacted" hold timer / generation latch | small pure latch + `Task.sleep` | swift-async-algorithms 1.1.7 (Apache-2.0, 3.7k★, 2026-09) | **KEEP** — a 3 s one-shot keyed by generation is domain logic; a library timer adds nothing | F2 latch |
| Queue drain / steer | box `delivery: steer|queue` | — | **KEEP** (already at parity) | F7 |

Nothing to adopt.

## 05 — git, PR, review

| Functionality | Spec plans | Candidates | Recommendation | Where |
|---|---|---|---|---|
| Unified-diff parsing into rows with old/new line numbers (G10) | Hand-written two-state hunk-aware parser in `forge/diffView.mjs` | **`diff` (jsdiff) 9.0.0**, BSD-3-Clause, ~123M/wk, released 2026-04; `parse-diff` 0.12.0, MIT, ~1.3M/wk, 2026-04; `gitdiff-parser` 0.3.1, MIT, ~0.3M/wk, last release 2023-03 | **ADOPT `diff`'s `parsePatch`** for the parsing; keep a thin mapper in `diffView.mjs` that walks `hunks[].lines` to emit rows/anchors/counters and do placement + truncation. Checked against the spec's tricky cases: an added `+++ heading` and a removed `--- a/old` inside a hunk come back as content lines (parsing follows the hunk counts); an empty line inside a hunk becomes context; `\ No newline` comes through as its own line; `+++ /dev/null` gives `newFileName "/dev/null"` with `oldFileName "a/y"`. Wrap the call in try/catch: malformed input throws, and the error becomes the existing `message` | 05 §S.2 |
| Desktop tool-output line numbers (`diffLineNumbers`) | Local helper reusing S.2 counting | `diff` `parsePatch` | **ADOPT (optional)** — call the same `parsePatch` so desktop and box share one parser. Tool output may be hunks with no file headers, which `parsePatch` accepts; if not, fall back to no numbers | 05 Files table, `ToolBodies.tsx` |
| Last-PR cache (G5), bounded LRU of 64 | Hand-written `createLastPrCache` | **`lru-cache` 11.5.3**, BlueOak-1.0.0 (permissive, OSI-approved), ~519M/wk, 2026-09; already in `node_modules` as a transitive dependency | **ADOPT** as a direct dependency. `createLastPrCache` becomes a small wrapper (`new LRUCache({max})`, key `cwd\0branch`). Same dependency as 07 | 05 §S.1 table + G5 paragraph |
| GitHub REST client | Existing hand-written `fetch` in `forge/github.mjs`, `gitlab.mjs`, `selfhost.mjs` (~9.8k LoC with tests) | `@octokit/rest` 22.0.1, MIT, ~16.8M/wk, 2026-07 | **KEEP** — the forge layer covers GitHub, GitLab and self-hosted instances behind one interface. Octokit is GitHub-only, so it would split the abstraction, and the tested code would churn for no parity gain. Reconsider only if GitHub throttling/retry becomes a problem (`@octokit/plugin-throttling`) | — |
| Desktop diff rendering of box rows | Local `ReviewDiffRows` | `react-diff-view` (MIT) | **KEEP** — the box now ships rendered rows + placements; a library would re-parse the diff and fight the box-owned placement | 05 Files table |
| iOS diff rendering | Native rows (`LazyVStack`) from `files[].rows` | No maintained SwiftUI diff view of note | **KEEP** (native) | 05 iOS |
| iOS code highlighting in review rows | not planned | HighlightSwift 1.1.0 (MIT, 211★, last release 2024-06); Highlightr (stale) | **KEEP not highlighting** — small and stale packages, and the desktop review rows are not highlighted either | — |

## 06 — search

| Functionality | Spec plans | Candidates | Recommendation | Where |
|---|---|---|---|---|
| Full-history search + snippet (`pre`/`match`/`post`) | Existing server SQLite query over opencode's read-only DB | SQLite FTS5 (would need an index), Fuse.js 7.5.0, fuzzysort 4.0.2 | **KEEP** — the DB is opened read-only and belongs to opencode, so an FTS index can't be created. Substring + snippet is the agreed behaviour, and fuzzy ranking would change results | §server |
| Query debounce (120 ms) | desktop `setTimeout`; iOS ticket state machine + `Task.sleep` | swift-async-algorithms `debounce` | **KEEP** — one debounce point that is already tested through the ticket model. Pulling in a package for it is not a clear win | iOS store |

## 07 — artifacts, cards

| Functionality | Spec plans | Candidates | Recommendation | Where |
|---|---|---|---|---|
| Per-session memo: LRU 32, TTL 30 s measured from derivation, concurrent calls share one in-flight derivation | Hand-written | **`lru-cache` 11.5.3** (see 05) | **ADOPT** for storage: `new LRUCache({max: 32, ttl: 30_000})` (age is not refreshed by a hit by default, which matches "never refreshed by a hit"). Value `{key, core}`; compare the derivation key on read. Keep the small `Map<sid, Promise>` for in-flight sharing — `fetchMethod` dedupes but keys on `sid` only, so it would be clumsier | 07 "Memoization" |
| Extension → MIME (`EXT_MIME`, moving to the box) | 4th copy of a small allowlist (already `index.mjs:3547`, `media.mjs:46`, `chatShared.tsx:267`) | `mime-types` 3.0.2, MIT, ~254M/wk; `mime` 4.1.2, MIT, ~141M/wk | **KEEP an allowlist, but ONE shared table** — the list is deliberately small ("unknown types land on the download path"). A full database would label `.ts` as `video/mp2t` and widen what gets previewed. Reuse/extend `media.mjs`'s `guessMime` (add the text/csv/md/json/pdf/html rows) instead of a new table | 07 server module |
| Hashing the last message's parts | `SHA-1` | `node:crypto` | **ALREADY-USED** (built-in) | 07 key |
| iOS file/image preview | QuickLook via `/api/peek` staging | `QLPreviewController` (system) | **ALREADY-USED** | 07 iOS |
| Byte sizes | `ArtifactFormat.byteCount` | `ByteCountFormatter` | **ALREADY-USED** (`ArtifactDerivation.swift:265`) | — |
| Relative age / expiry label ("4m ago", "5h") | Hand-written, client-side | `Date.RelativeFormatStyle` / `RelativeDateTimeFormatter`; `Intl.RelativeTimeFormat` | **KEEP** — exact copy parity with the desktop ("4m ago") and deterministic tests. The system formatters output "4 min. ago" and vary by locale | 07 iOS/desktop |

## 09 — models & usage (verification of its existing section)

The existing "Libraries considered" section is sound: Swift Charts (system,
iOS 16+) over DGCharts; the hand-built desktop SVG stays; config writes go
through a single promise chain rather than `p-queue`/`async-mutex`; native
SwiftUI lists. Two items it doesn't mention:

| Functionality | Spec plans | Candidates | Recommendation |
|---|---|---|---|
| M4 model fuzzy match (KEEP-CLIENT) | `fuzzyMatchModel` (`src/shared/modelGuide.mjs`) + iOS port | Fuse.js 7.5.0 (Apache-2.0, ~12M/wk), fuzzysort 4.0.2 (MIT, ~12M/wk) | **KEEP** — the iOS app needs a byte-identical port of the scoring, and neither library has a Swift twin, so adopting one on desktop would make the two clients rank differently |
| M5 context label ("1M"/"200k"), M19 reset-time text | Hand-written | `Intl.NumberFormat({notation:"compact"})` / `.formatted(.number.notation(.compactName))`; `Intl.DurationFormat` | **KEEP** — compact notation prints "200K" (house style is "200k"), and `DurationFormat` isn't available in every runtime the app ships on |

## 11 — server consolidation

| Functionality | Spec plans | Candidates | Recommendation |
|---|---|---|---|
| Capability probe retry backoff | Pure `BoxCapabilitiesRetry.delay(attempt:)` | swift-async-algorithms, generic retry libs | **KEEP** — one pure function, unit-tested |
| Model-prefs in-memory cache, invalidated on write | Hand-written | `lru-cache` | **KEEP** — a single value with explicit invalidation, not a cache with eviction |
| Stale-cache instant (`staleAt`) | Box computes the instant, client compares | — | **KEEP** (domain rule) |

## Built wave-A code

| Piece | File | Current | Candidates | Recommendation |
|---|---|---|---|---|
| Pairing QR | `BoxPairingQR.swift` | CoreImage `CIFilter.qrCodeGenerator` | — | **ALREADY-USED** (system); the desktop uses the `qrcode` npm package |
| Session switcher fuzzy scoring | `SessionSwitcherLogic.swift` | Port of the desktop `fuzzySessionScore` | fuzzysort / Fuse.js (desktop); no maintained Swift equivalent | **KEEP** — the point is identical ranking on both clients |
| Keychain wrapper | `KeychainCredentialStore.swift` (BET-592, before wave A) | Direct `SecItem*` | KeychainAccess 4.2.2 (MIT, 8.3k★, **last release 2021-03**) | **KEEP** — the library hasn't had a release since 2021, and the wrapper is small and already working |
| Relative times | `BoxDevicesModels.swift:143` ("4 min ago"), `ArtifactDerivation.swift:269` ("4m ago") | Hand-written | `Date.RelativeFormatStyle` | **KEEP** (copy parity). Note: the two files use different styles; align them with their desktop counterparts when touched, not as churn |
| Byte sizes | `TranscriptMediaCard.swift`, `ArtifactDerivation.swift` | `ByteCountFormatter` | — | **ALREADY-USED** |
| Markdown | transcript | MarkdownView 3.0.0 | — | **ALREADY-USED** |
| Transcript list | — | MessagingUI (pinned revision) | — | **ALREADY-USED** |
| Polling / debounce | various `Task.sleep` loops | swift-async-algorithms | **KEEP** — structured-concurrency loops tied to `.task` lifetimes are the house idiom |

**No built code should be replaced.**

## Concrete spec edits

1. **05, §S.2 `diffView.mjs`** — replace "Hunk-aware parse (deliberately NOT a
   port …)" with: parse with `parsePatch` from `diff` (jsdiff, new direct
   dependency in `package.json`). `diffView.mjs` maps `hunks[].lines` to rows:
   `+` → added, `-` → removed, `' '`/`''` → context, `\` → ignored; counters
   start at `oldStart`/`newStart`; the path comes from `newFileName` with `b/`
   stripped, or from `oldFileName` with `a/` stripped when it is `/dev/null`.
   A `parsePatch` throw becomes `message` with `files: []`. Keep all the listed
   regression fixtures (`+++ heading`, `--- a/x` content, empty context line,
   two hunks) as tests of the combined parse.
2. **05, Files table `ToolBodies.tsx`** — `diffLineNumbers` uses `parsePatch`
   (the shared parser) instead of re-implementing the S.2 counting.
3. **05, §S.1 table + G5** — `createLastPrCache({max = 64})` wraps
   `lru-cache`'s `LRUCache` (new direct dependency, already transitive); key
   `` `${cwd}\0${branch}` ``. Tests assert the bound and the drop, not the
   eviction order.
4. **07, "Memoization"** — store the cores in `new LRUCache({max: 32, ttl:
   30_000})` (no `updateAgeOnGet`). Keep a separate in-flight
   `Map<sessionId, Promise>` for sharing concurrent derivations.
5. **07, server derivation (EXT_MIME move)** — don't add a new extension
   table. Extend `src/server/media.mjs` `guessMime` (or export one shared
   table from it) with `.csv .tsv .txt .md .json .pdf .html .htm`, and use it
   for artifacts. Keep the deliberate allowlist (no `mime-types`) and note why.
6. **09, "Libraries considered"** — add one line each for M4 (fuzzy:
   Fuse.js/fuzzysort considered, kept for parity with the iOS port) and M5/M19
   (Intl compact/duration considered, kept for house style and runtime
   support).
7. **02, 06, 11** — add a one-line "Libraries considered: none adopted
   (reason)" note citing the rows above, so every spec records the rule.
