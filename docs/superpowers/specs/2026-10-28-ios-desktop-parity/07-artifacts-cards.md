# WS07 — Artifacts, agent-sent files, webhooks, shared secrets

Status: draft (revised, server-first round) · Wave B · Owner files:
`SessionResourceCards.swift`, `ArtifactDerivation.swift` (deleted, server-first),
`ChatOverflowSheet.swift`, `mobile/native/Package.swift` + `project.yml` (D1;
edits routed through the wave-B integration step per D18), new `Artifact*` /
`Webhook*` files, plus the server module `src/server/artifacts.mjs` and the
desktop files listed under "Desktop migration". Binding rules: `00-master.md`
(C1–C7, D1–D30).

**One new server channel, `artifacts:list`** (module `src/server/artifacts.mjs`,
see "Server-first (D23/D24)"), capability id `artifacts-list-1`. Every other
feature (attach, agent-file notice, webhooks, secrets) reuses a channel, route
or bus event the desktop already uses. WS07 never edits `rpc.mjs`, `index.mjs`
or `streamInterp.mjs`; its registrations are IB ledger rows (M-07-S1/S2).

Features in scope (7):

| # | Feature |
|---|---|
| F1 | Artifacts **Plans** tab |
| F2 | Artifacts **search** |
| F3 | Artifacts **Jump to message** (C2 `.message`) |
| F4 | Artifacts **Attach to message** (C3 `attach`) |
| F5 | Artifacts **expiry display** (hosted pages + agent-sent files) |
| F6 | **Agent-sent file notice** (`send_file` with `notify:true` → `agentFile` bus event) with Save / Share |
| F7 | **Webhooks card** in the chat overflow; **secrets "shared" scope** (F7b) |

---

## 0. What iOS has today (do not duplicate)

- `ArtifactsCard` (`MantaUI/SessionResourceCards.swift:370-641`): sheet with a
  Files · Images · Links segmented control (`:443-453`), day-grouped list
  (`:455-466`), 3 s poll while open (`:425-430`), tap → QuickLook via
  `/api/peek` staging (`:484-534`), long-press → Share / Copy path (`:536-557`).
  Loads `api.messages`, `api.servePageList()`, `api.listOutbox` (`:468-482`).
- `ArtifactDerivation` (`MantaUI/ArtifactDerivation.swift`) — **deleted by
  this spec (D23, "Server-first")**: a port of the desktop `deriveArtifacts`
  that lacks: the `plan` kind, `messageId`,
  link `context`, `isHosted`, the plan-page exclusion from Links, the outbox
  row's `messageID`, and the video extensions. Expiry is only shown when
  ≤ 48 h (`ArtifactFormat.ageOrExpiry`, `:282-293`) — the desktop always shows
  a pill on hosted pages and outbox files.
- `PlanDerivation` (`MantaUI/PlanDerivation.swift`, not owned by anyone; read
  only here): ports `planRefsFromPart` (`:82`), `planSubdomain` (`:182`) and
  `planPageURL(sessionID:baseURL:)` (`:193`) for the plan CARD. Since the
  server-first revision WS07 does **not** use any of them — the box returns
  plan titles, steps and page URLs (`artifacts:list`).
- `SecretsCard` + `SecretAddForm` (`SessionResourceCards.swift:134-346`):
  scope picker offers only `session` / `project` (`:295-298`), default
  `session` (`:269`), always sends `sessionID` (`:339`). Row shows raw scope.
- `ChatOverflowSheet` (`MantaUI/ChatOverflowSheet.swift:389-590`): rows
  Scheduled tasks / Secrets / Artifacts / Background jobs. No webhooks row.
- `MantaAPIClient`: `listOutbox` (`:442`) decodes `OutboxFile`
  (`MantaModels.swift:444`, **no `messageID`**), `servePageList` (`:450`),
  `peekFile(path:)` (`:559`), `downloadOutboxFile(path:)` (`:596`),
  `upload(project:filename:data:)` (`:378`), `setSecret` (`:430`). No
  `webhook:*` methods.
- `MantaEventStore.addRawFrameHandler(_:)` (`MantaEventStore.swift:464`) —
  every non-`stream`, non-`runningSet` frame (e.g. `kind:"agentFile"`) reaches
  registered handlers (`:576`). Used by `UpgradeStore`, `WidgetLiveStore`,
  `SessionListStore`, `ChatModelPrefs`. **F6 uses this; it does not edit
  `MantaEventStore.swift`.**

## Server-first (D23/D24)

Authority: `server-first-audit.md` §WS07. Folded MOVE-NOW items: **A1, A2,
A3, A5**. Everything else in the WS07 audit table is KEEP-CLIENT (A4 day
grouping, A6 search, A7 action eligibility, A8 byte routing, A9 notice
machine — the announce decision is already server-side, A10 webhook display,
A11a scope encoding, A12 key pre-check) and stays as specified below. A11b is
MOVE-LATER (WS11 follow-ups), not built here.

### SF-A1/A2/A3/A5 → new `src/server/artifacts.mjs`, channel `artifacts:list`

The box already holds all four inputs: the transcript (`oc.listMessages`,
`src/server/opencode.mjs:511`), the serve-page registry
(`listPages({baseUrl})`, `src/server/servePage.mjs:212`), the outbox
(`listOutbox()`, `src/server/outbox.mjs`, rows carry `messageID`) and the
session directory (`oc.getSessionDirectory`, `opencode.mjs:905`). The module
ports the desktop's `deriveArtifacts` (`src/renderer/artifacts.ts:329-399`)
and its helpers line-for-line and becomes the ONLY implementation; the iOS
port (`ArtifactDerivation.swift`) is deleted and the desktop switches in the
same change.

**Module (`src/server/artifacts.mjs`, owned by WS07):**

```js
// pure — no I/O
export function deriveArtifacts({ messages, pages, outbox, sessionId, directory, baseUrl }) // → ArtifactCore[] (no expiry state)
export function planRefsFromPart(part)            // moved from src/renderer/chatUtils.ts:2638-2678 (PLAN_REF_RE, PLAN_AUTHORING_TOOLS)
export function planStepCount(text)               // /^#{2,3}\s+.+$/gm count (artifacts.ts:190-193)
export function planTitleFromPath(file)           // artifacts.ts:180-185
export function expiryState(expiresAt, now)       // "live" | "soon" (≤ 6 h) | "expired" | null — artifacts.ts:444-452
export function countByKind(items)                // { link, image, file, plan }
export function view(core, now)                   // core items + expiry + counts → response body
// service — injected I/O, memoized
export function createArtifactsService({ listMessages, listPages, listOutbox, sessionDirectory, baseUrl /* () => string */, now = Date.now, ttlMs = 30_000, maxSessions = 32 })
  // → { list(sessionId): Promise<ArtifactsListResult> }
```

Derivation rules are exactly `artifacts.ts` today (file parts, user-text
links with 160-char context and `.N` id suffixes, plan refs from any
non-synthetic part with step count from prose → tool `content` → message
text, hosted pages with newest-announcing-assistant `messageId`/`context`,
plan-subdomain page excluded from links, outbox rows with sidecar
`messageID`, extension → MIME incl. video types, dedupe on `key` keeping the
greatest `at`, sort newest first). Two server-side refinements, both pinned by
tests:
- **Extension → MIME uses ONE shared table — no new `EXT_MIME` copy on the box.**
  `src/server/media.mjs` already has the box's allowlist (`MIME_BY_EXT`,
  `guessMime`). WS07 exports that table and extends it with the rows the
  desktop's `EXT_MIME` has and media lacks — `.csv text/csv`,
  `.tsv text/tab-separated-values`, `.txt text/plain`, `.md text/markdown`,
  `.json application/json`, `.pdf application/pdf`, `.html text/html`,
  `.htm text/html` — and adds `export function mimeForName(name) → string |
  null` (null when the extension is not listed). `artifacts.mjs` uses
  `mimeForName` (an unknown type stays `mime: null` → download path, exactly as
  today); `guessMime` keeps its `application/octet-stream` fallback and now
  reads the same table. The list stays a **deliberate allowlist** (no
  `mime-types` / `mime` database): a full database labels `.ts` as
  `video/mp2t` and would widen what gets previewed; "unknown types land on the
  download path" is the intended behaviour. Side effects, both intended:
  `media_save`/`media_show` now report the real type for those eight
  extensions instead of `application/octet-stream` (neither image nor video, so
  measuring and the media `kind` are unchanged); an outbox `.avif` now reads
  `image/avif` (media's row) and lists as an image.
- **Plan `href`** = `getSessionDirectory(sessionId)` + `/` + rel. (The desktop
  joined the pane cwd, which can differ from the opencode session directory
  where `.opencode/plans/` is actually written.) Unknown directory → `href`
  is the rel path and `plan.fileAvailable = false`.
- **Plan `pageUrl`** — `planPageResolution({ sessionId, pages, baseUrl })`
  (pure, exported), evaluated against the registry rows whose
  `subdomain === planSubdomain(sessionId)` (`src/shared/planMode.mjs:49`; the
  slug truncates the session id to 20 chars, so two sessions can share it —
  the collision `artifacts.ts:240-243` warns about):
  1. **Owned registration** (a row with `sessionID === sessionId`): its `url`
     if it is a usable absolute `http(s)` URL, else `null`
     (`listPages` returns `url: ""` when the box has no public base,
     `servePage.mjs:212-219`) → `plan.pageUrlReason: "no-public-address"`.
  2. **Collision** (a row exists for that subdomain but `sessionID` is another
     session or null): `pageUrl: null`, `pageUrlReason: "other-session"`. The
     deterministic fallback is NEVER used here — it would build the same URL
     and open the other session's page.
  3. **No registration**: `planPageUrl(sessionId, baseUrl)` (`planMode.mjs:65`)
     when `baseUrl` is a usable `http(s)` base, else `null` with
     `pageUrlReason: "no-public-address"`.
  `pageUrlReason` is `null` whenever `pageUrl` is non-null. The desktop's
  client fallback to its own `serverBase()` and iOS's
  `PlanDerivation.planPageURL(…, api.serverURL)` are removed — the box knows
  its public base (`publicBaseUrl()`).
- **Hosted pages without a usable URL** (`url` empty / not `http(s)` — box has
  no public address): the item is **omitted** (never a link with an empty
  href) and `"public-address"` is added to `degraded`. Both clients show the
  footnote **"Published pages are hidden — this box has no public address."**
  for that entry (other `degraded` entries keep "Some items couldn't be
  loaded.").

**Wire — `POST /rpc/artifacts:list`**, `args: [{ "sessionId": "ses_…" }]`
(single object, room for additive options):

```jsonc
{
  "result": {
    "sessionId": "ses_1",
    "generatedAt": 1761650000000,          // box clock, ms
    "items": [
      {
        "id": "prt_9",                     // part id (".0/.1" suffix), "page:<sub>", "outbox:<path>", "plan:<rel>"
        "kind": "file",                    // "link" | "image" | "file" | "plan"
        "origin": "agent",                 // "user" | "agent"
        "label": "report.pdf",
        "href": "/home/dev/.manta-outbox/ses_1/report.pdf",  // box path, data: URI, or URL
        "mime": "application/pdf",         // null for links
        "size": 63488,                     // null when unknown
        "at": 1761649000000,               // ms
        "messageId": "msg_4",              // null when no owning message
        "context": null,                   // links/pages only
        "isHosted": false,                 // true only for serve_page rows
        "expiry": { "state": "live", "expiresAt": 1762253800000 },
                                           // null = no expiry concept (plain files, links, plans);
                                           // hosted page with no TTL → { "state": "never", "expiresAt": null }
        "plan": null                       // kind "plan" only:
                                           // { "status": "draft", "steps": 3, "pageUrl": "https://…/pages/plan-ses1",
                                           //   "pageUrlReason": null, "fileAvailable": true }
                                           // pageUrlReason ∈ null | "other-session" | "no-public-address" (non-null iff pageUrl is null)
      }
    ],
    "counts": { "link": 2, "image": 1, "file": 4, "plan": 1 },
    "degraded": []                         // subset of ["pages","outbox","directory","public-address"]:
                                           // a read failed (source omitted), or hosted pages were omitted for lack of a public URL
  }
}
```

- `expiry.state` ∈ `"live" | "soon" | "expired" | "never"`; computed at
  response time from `now()` (never cached). The **label** ("expires in 5h",
  "no expiry", the desktop's "5h") stays client-side because it is relative to
  the device clock (audit A3).
- `plan.status` is `"draft"` until a plan→job link exists (desktop parity —
  `planStatus({})`).
- **Errors** (thrown → `{error}` with HTTP 500 via `handleRpcRequest`,
  `rpc.mjs:2700-2713`; messages are safe literals — class-1 per BET-1460):
  missing/blank `sessionId` → `"artifacts:list needs a sessionId"`; the
  transcript read fails → `"Couldn't read this conversation's artifacts"`.
  Pages / outbox / directory failures do NOT fail the call: the source is
  omitted and named in `degraded` (the desktop today swallows those per
  source, `ArtifactsPanel.tsx:640-652`).
- **Memoization** (audit risk note — iOS polls every 3 s). Every `list()` call
  reads the CHEAP sources fresh: `listPages()`, `listOutbox()`,
  `sessionDirectory(sid)`, `baseUrl()`, and `listMessages(sid, { limit: 1 })`.
  From those it builds the **derivation key**:
  - `baseUrl()` string;
  - pages: sorted `subdomain|url|createdAt|expiresAt|sessionID` of every row
    with `sessionID === sid` OR `subdomain === planSubdomain(sid)`;
  - outbox: sorted `path|mtime|size|expiresAt|messageID` of this session's rows
    (sidecar `expiresAt`/`messageID` are read separately from `mtime`,
    `outbox.mjs:113-129`, so they are part of the key);
  - directory string (or `"?"`);
  - transcript revision: last message `id` + `parts.length` +
    `time.completed ?? ""` + a SHA-1 of `JSON.stringify(lastMessage.parts)`
    (covers text growing inside the same final part);
  - which optional reads failed (so a failure → recovery transition changes
    the key).
  Same key AND the cached core was **derived** less than `ttlMs` (30 s) ago →
  reuse the core (age is measured from derivation, never refreshed by a hit).
  Otherwise full `listMessages(sid)` + derive. Deliberate maximum staleness:
  an in-place edit to an EARLIER message (not the last one) can be up to 30 s
  late; everything else invalidates immediately. `degraded` is computed from
  THIS request's reads, never taken from the cache; expiry state and counts are
  recomputed on every response. LRU of 32 sessions; concurrent calls for one
  session share one in-flight derivation.
  **Storage (libraries review):** the cores live in `lru-cache` 11.5.3 —
  `import { LRUCache } from "lru-cache"`, `new LRUCache({ max: maxSessions,
  ttl: ttlMs, ttlAutopurge: false })` with **no `updateAgeOnGet`** (the
  default, so a hit never refreshes the age — matching "measured from
  derivation"). Value `{ key, core }`; on read compare the stored derivation
  key with this request's and treat a mismatch as a miss. `ttl`/age use the
  injected `now` via the cache's `perf` option (`perf: { now }`) so the
  fake-clock tests drive expiry. In-flight sharing stays a small separate
  `Map<sessionId, Promise>` (deleted in `finally`) — `fetchMethod` dedupes
  but keys on `sessionId` only, which fits the derivation-key compare worse.

**Capability (D24 wire compat).** Id **`artifacts-list-1`**, appended to WS02's
`src/server/boxCapabilities.mjs` by integration agent B in wave B (M-07-S2,
master D25), so `GET /api/version` / `server:version` advertise it from this
wave on. The clients' detection signal is the channel itself (exact, no extra
round trip): an older box
answers `{error: "unknown rpc channel: artifacts:list"}` (`rpc.mjs:431-434`).
Any capability-list read uses WS02's `boxCapabilities()` / `useBoxCapability`
(never a WS07 copy); WS11 D1 may later gate the card entry through its store.
Both clients classify exactly that error (or a capabilities list lacking the
id) as **unsupported** and render, in place of the artifact
list: **"Update your box to use this."** + secondary "Artifacts need a newer
box version." No fallback derivation exists on either client. The desktop's
Review mode (same panel) is unaffected.

**Node tests — `src/server/artifacts.test.mjs`** (port of every derivation
case in `src/renderer/artifacts.test.ts` and the `planRefsFromPart` cases in
`chatUtils.test.ts` (`describe` at `:5671`), plus):
1. file part → `kind/label/href/mime/size/messageId`; image mime → `image`.
2. user link with context (URL removed, whitespace collapsed, 160 cap); two URLs
   → `id.0`/`id.1`; assistant text links ignored; synthetic/ignored skipped.
3. hosted page: other session excluded; `isHosted`, `messageId`/`context`
   from the newest assistant message containing the URL; plan-subdomain page
   NOT listed as a link.
4. outbox: other session excluded; `messageID` carried; `.mp4` → `video/mp4`.
5. plan: from text, from `write` input `filePath`, from patch `files`; `read`
   ignored; newest wins; title "ship it"; `steps` 2 for `## A\n### B\n#### C`;
   `href` joins the session directory; unknown directory → rel href +
   `fileAvailable:false`; `pageUrl` per `planPageResolution` (case 10).
6. dedupe on key keeps the greatest `at`; output newest first; `counts`.
7. `expiryState` at `now`: null, past → expired, exactly 6 h → soon, 7 h →
   live; hosted no-TTL → `{state:"never"}`; plain file → `expiry:null`.
8. service (fake clock, injected sources): same key within TTL calls
   `listMessages` (full) once across two `list()` calls but recomputes expiry
   with an advanced `now`; a new last message invalidates; **text appended to
   the last part with unchanged id/part count invalidates**; a `baseUrl()`
   change invalidates (plan `pageUrl` and hosted links update); a page
   republished with the same `expiresAt` but new `createdAt`/`url`
   invalidates; an outbox sidecar `expiresAt` / `messageID` change with the
   same `mtime` invalidates; cache age is from derivation (hits at t=10 s and
   t=25 s, re-derive at t=31 s); concurrent calls share one read; failing
   `listPages` → `degraded:["pages"]` and no hosted items, then recovery on
   the next call → `degraded:[]` and the items return (never a cached
   `degraded`); failing transcript read → throws the safe literal; blank
   sessionId throws; with `maxSessions: 2`, three sessions listed then the
   cache holds at most two cores (assert the bound — a re-list of SOME session
   re-derives — not which one `lru-cache` evicted); the fake clock reaches the
   cache through `perf.now` (the t=31 s re-derive above proves it).
12. shared MIME table (`src/server/media.test.mjs`, extended): `mimeForName`
    returns the eight new rows (`a.CSV` → `text/csv`, `.tsv`, `.txt`, `.md`,
    `.json`, `.pdf`, `.html`, `.htm`), keeps the existing image/video rows,
    returns `null` for `main.ts` / `Makefile` / `""`; `guessMime` still falls
    back to `application/octet-stream` for those; `artifacts.mjs` outbox row
    `x.ts` → `mime: null`, `kind: "file"`.
10. `planPageResolution`: owned registration with URL → that URL; owned
    registration with `url:""` → `null` + `"no-public-address"` (not the
    fallback); **collision** (same subdomain, other `sessionID` or null) →
    `null` + `"other-session"` even with a usable `baseUrl`; no registration +
    usable base → deterministic URL; no registration + empty base → `null` +
    `"no-public-address"`.
11. hosted (non-plan) page with `url:""` → omitted from `items`, `counts.link`
    excludes it, `degraded` contains `"public-address"`.
9. rpc wiring test (in `artifacts.test.mjs`, building the handler the way the
   M-07-S1 row does with injected deps): `dispatch(handlers, "artifacts:list",
   [{sessionId:"ses_1"}])` returns the shape above.

### Desktop migration (same change — no parallel implementation)

| File | Change |
|---|---|
| `src/renderer/artifacts.ts` | **Delete** `deriveArtifacts`, `deriveFileArtifact`/`LinkArtifact`/`OutboxArtifact`/`PlanArtifact`/`PageArtifact`, `newestAnnouncingMessage`, `dedupeByKey`, `EXT_MIME`, `planTitleFromPath`, `planStepCount`, `planStatus`, `planSubdomain` (duplicate of `planMode.mjs`), `pageState`, `countByKind`. **Keep** `groupByDay` (A4, device timezone). `Artifact` becomes `export type Artifact = ArtifactItem` re-exported from the new `src/shared/artifactsTypes.ts`; `ArtifactKind`, `PlanStatus` re-exported likewise. |
| `src/shared/artifactsTypes.ts` (new, WS07) | `ArtifactItem`, `ArtifactExpiry`, `ArtifactPlanInfo`, `ArtifactsListResult`, `ArtifactKind`, `ArtifactOrigin`, `PlanStatus` — the wire shape above. |
| `src/renderer/ArtifactsPanel.tsx` | Replace the `servePageList` + `outboxList` effect (`:637-660`) and the `deriveArtifacts`/`countByKind` memos (`:683-687`) with one fetch of `window.api.artifactsList({ sessionId })`: on open, every 30 s while open (`POLL_MS`, unchanged), and 400 ms after the lifted transcript's last message id / part count changes (so a new attachment appears without waiting for the poll). State: `loading` / `ready(result)` / `error(message)` (inline banner + **Retry**) / `unsupported` ("Update your box to use this."). Tab badges use `result.counts` (search keeps its client counts, A6). `LinkCard` / `FileRow` read `artifact.expiry?.state` (pill tone) and `expiryLabel(artifact.expiry.expiresAt, now)` for the text; `state === "never"` → "no expiry". `PlanRow` reads `artifact.plan.status/steps`; `openPlanPage` opens `artifact.plan.pageUrl` and, when null, sets `planError("Couldn't open the plan page.")` (the `planPageUrl(sessionId, serverBase())` fallback and the `planPageUrl` import are removed). "Open plan file" is hidden when `plan.fileAvailable` is false. `cwd` stays a prop only for `ReviewPane`. `degraded` non-empty → a muted footnote: `"public-address"` → "Published pages are hidden — this box has no public address."; any other entry → "Some items couldn't be loaded." `plan.pageUrlReason === "other-session"` adds "Another conversation's page uses this address." to the plan error. |
| `src/renderer/MediaBody.tsx` (`:145-163`) | The inline-media `Artifact` literal adopts the wire shape: drop `key`/`expiresAt`, add `isHosted: false`, `expiry: null`, `plan: null`. |
| `src/renderer/ArtifactPreview.tsx` | Type-only: uses `Artifact` fields that still exist (`id/label/href/mime/kind/origin`); no logic change. Verify compile. |
| `src/renderer/ArtifactPreview.test.tsx` (`:13-26`) | The typed `Artifact` fixture migrates to the wire shape (drop `key`/`expiresAt`; add `isHosted: false`, `expiry: null`, `plan: null`). All existing preview action tests (BET-1156 Attach affordance) are kept unchanged and stay under `npm run typecheck` (`tsconfig.web.json` includes renderer tests). |
| `src/renderer/chatUtils.ts` (`:2638-2678`) | **Delete** `PLAN_REF_RE`, `PLAN_AUTHORING_TOOLS`, `planRefsFromPart` (its only renderer caller was `artifacts.ts:373`; now in `src/server/artifacts.mjs`). Ledgered (M-07-D1) because WS02 also edits this file in wave B. |
| `src/renderer/api/demoArtifacts.ts` (new, WS07) | Static `ArtifactsListResult` fixtures for the demo states (the `artifacts` image tile + the hosted pages with literal `live`/`soon`/`expired` states the visual baselines show). Literal data, no derivation. |
| `src/shared/api.ts`, `src/shared/types.ts` (IPC), `src/renderer/api/httpApi.ts`, `src/renderer/api/demoApi.ts` | One-line registrations — ledgered (M-07-D2…D5). |
| Tests | `src/renderer/artifacts.test.ts`: delete every derivation case; **keep** the `groupByDay` cases and migrate their shared builders `fileArtifact`/`img` (`:49-67`) to the wire shape (no `key`/`expiresAt`; `isHosted: false`, `expiry: null`, `plan: null`); drop the now-unused `page`/`toolPart`/message helpers. The plan desktop test additionally asserts: `plan.pageUrl == null` with `pageUrlReason "other-session"` → "Couldn't open the plan page." and no navigation; `degraded: ["public-address"]` → "Published pages are hidden — this box has no public address.". `chatUtils.test.ts`: delete the `describe("planRefsFromPart")` block (starts `:5671`) and its import (`:169`) (ledgered with M-07-D1). New `src/renderer/ArtifactsPanel.server.test.tsx` (vitest, `installMockApi`): renders server items per tab; badges from `counts`; expiry pill tone per `expiry.state` + "no expiry" for `never`; plan row opens `plan.pageUrl`, shows "Couldn't open the plan page." when null; transcript change triggers a debounced refetch; `unknown rpc channel: artifacts:list` → "Update your box to use this."; other error → banner + Retry refetches. `ArtifactsPanel.review.test.tsx` keeps passing (mock `artifactsList` → empty result). Visual baselines (`tests/visual/screens.visual.ts` artifacts states) must be unchanged — the demo fixture reproduces them. |

`servePageList` / `outboxList` stay on the `Api` (other consumers: the iOS
download path, CTO tooling); only the artifacts panel stops calling them.

### iOS migration

- **Delete** `mobile/native/MantaUI/ArtifactDerivation.swift` and
  `MantaUITests/ArtifactDerivationTests.swift`. The presentational helpers
  the card keeps (KEEP-CLIENT) move to a new pure file
  `ArtifactPresentation.swift`: `ArtifactDayGrouping` (A4),
  `ArtifactFormat.byteCount/relativeAge/secondaryLine`, `ArtifactSearch` (A6),
  `ArtifactActions` (A7), `ArtifactByteSource`, `ArtifactDataURI`,
  `ArtifactStagingError` (A8), `ArtifactAttach`, `ArtifactStaging`,
  `ArtifactEmptyCopy`, `ArtifactExpiryLabel.text(_ expiry:, now:)` (label only).
- **Wire types** in `ArtifactModels.swift` (pure): `ArtifactItem`,
  `ArtifactExpiry { state: ArtifactExpiryState (.live/.soon/.expired/.never), expiresAt: Double? }`,
  `ArtifactPlanInfo { status: ArtifactPlanStatus, steps: Int, pageUrl: String?, pageUrlReason: String?, fileAvailable: Bool }`,
  `ArtifactsListResult { sessionId, generatedAt, items, counts: ArtifactCountsWire, degraded: [String] }`,
  `ArtifactsCapability.isUnsupported(_ error: Error) -> Bool` (true for
  `MantaError.server` whose message starts with `"unknown rpc channel: artifacts:list"`).
  Unknown future `kind` / `state` values decode to `.unknown` and the row is
  skipped (additive-wire tolerance). `ArtifactOutboxRow` is **removed** (the
  server reads the outbox).
- **Client member:** `artifactsList(sessionId:) async throws -> ArtifactsListResult`
  replaces the card's `messages` + `servePageList` + `listOutbox` triple
  (`SessionResourceCards.swift:468-482`). `listOutboxRows` is dropped.
- The card renders the server list as-is: segments + badges from `counts`
  (search counts client-side), rows from `items`, plan status/steps/pageUrl
  from `plan`, expiry tone from `expiry.state`, label from the client
  formatter. States: loading (`ProgressView`), error ("Couldn't load
  artifacts." + **Retry**), unsupported (`ContentUnavailableView("Update your
  box to use this", systemImage: "arrow.down.circle", description: Text("Artifacts
  need a newer box version."))`), `degraded` non-empty → section footer from
  `ArtifactDegradedCopy.footer(_ degraded: [String]) -> String?`
  (`"public-address"` → "Published pages are hidden — this box has no public
  address."; any other entry → "Some items couldn't be loaded."; both when
  both apply; nil for `[]`). A plan with `pageUrl == nil` never opens a URL —
  it shows "Couldn't open the plan page." (and, for `pageUrlReason ==
  "other-session"`, the secondary "Another conversation's page uses this
  address."). The 3 s poll is kept (server-memoized).
- `PlanDerivation.swift` is untouched by WS07 (its plan-card half is WS11 U1);
  WS07 no longer calls `planRefsFromPart` / `planPageURL` from it.

---

## F1 — Plans tab

### Desktop behaviour
- Tab bar is Links · Images · Files · **Plans**, each with a count
  (`src/renderer/ArtifactsPanel.tsx:163-169`, `:909-937`).
- A plan artifact is derived from any `.opencode/plans/*.md` reference in any
  non-synthetic, non-ignored part (text, authoring-tool input
  `filePath|path|planPath`, patch `files`) (`src/renderer/artifacts.ts:365-380`,
  `src/renderer/chatUtils.ts:2638-2678`).
  - id `plan:<rel lowercased>`, key `<rel lowercased>`, `origin: "agent"`,
    `mime: "text/markdown"`, `href = cwd + "/" + rel` (`joinHref`, `:210-213`),
    `at` = owning message created, `messageId` = owning message
    (`artifacts.ts:227-266`).
  - label = filename without `.md`, without a leading `YYYY-MM-DD-`, `-`/`_`
    → spaces, trimmed (`planTitleFromPath`, `:180-185`).
  - step count = number of lines matching `^#{2,3}\s+.+$` (multiline) in the
    part's text, else the authoring tool input's `content`, else the joined text
    of the message (`planStepCount` `:190-193`, `partAnnounceText` `:271-280`).
  - status = `planStatus({})` → always `"draft"` today (`:199-208`, `:257`).
  - `pageUrl` = the `serve-page:list` row whose `subdomain == planSubdomain(sessionId)`
    AND `sessionID == sessionId` (`:240-243`).
  - Same plan referenced several times → newest `at` wins (`:375-377`).
- The plan's auto-published page (`subdomain == planSubdomain(sessionId)`) is
  **not** also listed under Links (`:384-388`).
- Row (`ArtifactsPanel.tsx:516-585`): plan icon, title + status pill
  (`draft`/`approved`/`building`/`done`), subline `N step(s)` or `plan`.
  Actions: **Open published page** (`pageUrl` else deterministic
  `planPageUrl(sessionId, serverBase())`, opened externally; failure → inline
  dismissible error, `:739-748`, `:948-961`), **Open plan file** (preview),
  "Open implementing session" is passed `null` → not rendered (`:999-1001`).
- Row tap = open published page (`openRow`, `:758-761`).
- Empty: "No plans yet" / "N links, N images, N files" (`:196-208`).

### Wire contract
`artifacts:list` (Server-first section): items with `kind: "plan"` carry
`plan { status, steps, pageUrl, fileAvailable }`; `counts.plan`; the plan's own
page is already excluded from links by the box. "Open plan file" still stages
bytes via `GET /api/peek?path=<href>` (bearer).

### iOS design
- `ArtifactKind` gains `.plan`. Segments become
  **Files · Images · Links · Plans** (keep the existing iOS order + default
  `.file`; append Plans). Label `"Plans \(count)"`.
- Rows are the server's `ArtifactItem`s (`ArtifactModels.swift`); no client
  derivation. Plan rows read `item.plan` (`status`, `steps`, `pageUrl`,
  `fileAvailable`).
- Plan row (in `ArtifactsCard`): `list.clipboard` glyph, title (middle-truncated),
  trailing status capsule (`draft` = `tokens.tx3` on fill; `approved` = warn;
  `building` = accent; `done` = ok), subline `"3 steps"` / `"1 step"` / `"plan"`.
  - Tap → open `item.plan.pageUrl` with `UIApplication.shared.open(url) { ok in … }`;
    `pageUrl == nil` or `ok == false` → the card's inline error banner:
    **"Couldn't open the plan page."** (No client-side URL fallback — the box
    already applied it.)
  - Context menu: **Open published page** · **Open plan file** (only when
    `plan.fileAvailable`; stages `href` via `/api/peek` then QuickLook, same
    path as files) · **Copy path**. No "implementing session" action (desktop renders none).
- Staging fix: `ArtifactsCard.tempURL(for:)` must take the extension from the
  **href's** last path segment when the label has none (a plan's label is a
  title, so `.md` would be lost and QuickLook would not recognise the file).
- Empty Plans tab: `ContentUnavailableView("No plans yet", systemImage:
  "list.clipboard", description: Text(ArtifactEmptyCopy.sub(.plan, counts)))`
  → "2 links, 0 images, 3 files". Apply the same per-tab copy to the other three
  tabs ("No links yet" / "No images yet" / "No files yet" + the other counts),
  replacing the single "No artifacts" state (keep its
  `accessibilityIdentifier("artifacts-empty")`).
- Inline error banner (shared by F1/F4 and by EVERY preview): a dismissible red
  row at the top of the list (`Section` with the message + an `xmark` button,
  `accessibilityIdentifier("artifacts-error")`). The card stays open; the
  failed row is untouched, so tapping it again retries.
- **Preview / staging failures are never silent** (applies to file, image and
  plan-file previews, not only to plans). `presentPreview` today returns
  silently when `stage` yields nil (`SessionResourceCards.swift:500-506`,
  `:519-534`); it must instead set the banner from
  `ArtifactStagingError.message(_:name:)`:
  - box file missing / 404 / 403 → **"Couldn't open <name> — it may no longer be on the box."**
  - malformed `data:` URI → **"Couldn't open <name> — the file data is damaged."**
  - remote URL non-2xx / network error → **"Couldn't download <name> from <host>."**
  - writing the temp file failed → **"Couldn't prepare <name> for preview."**
  `stage` therefore returns `Result<URL, ArtifactStagingError>` (cases
  `.missing`, `.badDataURI`, `.remote(host: String)`, `.write`), not `URL?`.
- **Byte source routing** for staging, used by preview, Share and Attach: see
  F4 "Byte resolution" — the same three-branch resolver.

---

## F2 — Search

### Desktop behaviour
- Header search toggle → input `placeholder="Search links & files…"`
  (`ArtifactsPanel.tsx:840-857`).
- Filters the **current tab** by case-insensitive substring of `label` OR
  `href` (`:699-705`). Tab badges show live match counts for links/files/plans
  and a flat 0 for images while a query is active (`:711-722`).
- No match: `No matches for “<query>”` (`:964-965`).
- Query is cleared on session change (`:665-671`).

### Wire contract
None — a client-side filter over `artifacts:list` items (audit A6
KEEP-CLIENT: runs on every keystroke). Unfiltered badges come from the
server's `counts`; filtered badges from `ArtifactSearch.counts`.

### iOS design
- `.searchable(text: $query, placement: .navigationBarDrawer(displayMode:
  .automatic), prompt: "Search links & files")` on the card's
  `NavigationStack` content.
- Pure `ArtifactSearch.filter(_ items: [ArtifactItem], query: String) -> [ArtifactItem]`
  (trimmed query; empty → unchanged) and
  `ArtifactSearch.counts(_ items:, query:) -> ArtifactCountsWire` (per-kind match
  counts). **Deliberate deviation:** the Images badge shows its real match
  count (the desktop's hard 0 is an artefact of images not being labelled, not
  a behaviour); the image list itself is filtered exactly as on desktop.
- Segment labels use `ArtifactSearch.counts` while a query is active.
- No match in the current tab: `ContentUnavailableView.search(text: query)`.
- The 3 s poll keeps running while searching; the filter re-applies.

---

## F3 — Jump to message

### Desktop behaviour
- File rows and image tiles: **Jump to message** action, disabled when
  `messageId` is null (`ArtifactsPanel.tsx:250-270`, `:265-267`). Link cards
  carry it in the context strip (`:354-371`).
- `messageId` sources (`artifacts.ts`): file part → owning message (`:87`);
  link → owning message (`:111`); hosted page → newest **assistant** message
  whose joined text contains the page URL (`:300-314`, `:293`); outbox row →
  `row.messageID` from the file's sidecar, stamped by `send_file`
  (`:165`, `src/server/outbox.mjs:125-126`, `src/server/index.mjs:4179-4196`);
  plan → owning message (`:254`).
- Click dispatches `manta-scroll-to-message {sessionId, messageId}`
  (`:778-785`) — the chat scrolls to and flashes the message.

### Wire contract
- `artifacts:list` items carry `messageId` (null when there is none) and, for
  links / hosted pages, `context` — all four `messageId` sources above are
  resolved by the box (the outbox sidecar `messageID` is read server-side).
- Navigation: C2 `MantaRoute.message(sessionID:messageID:)` (handled by WS02).

### iOS design
- The card reads `item.messageId` / `item.context` as delivered; no client
  derivation (the former `ArtifactOutboxRow` / `listOutboxRows` plan is
  dropped).
- `ArtifactsCard` gains `var onJumpToMessage: ((String) -> Void)? = nil`.
  - Context menu item **Jump to message** (`arrow.turn.down.right`) on every
    row kind, rendered **only** when `onJumpToMessage != nil &&
    item.messageId != nil` (`ArtifactActions.canJump`).
  - Link rows show `context` as a second caption line (2-line limit) when
    present.
  - Action: call `onJumpToMessage(messageID)`; the closure (ChatScreen) closes
    the card and then opens `.message(sessionID: store.sessionId,
    messageID:)` (see Mount requests). The card itself never navigates.

---

## F4 — Attach to message

### Desktop behaviour
- **Attach to message** on image tiles, file rows and the preview overlay
  (`ArtifactsPanel.tsx:265`, `:1017`, `:1042`). Not on links or plans.
- `attachArtifact` (`:131-144`): resolve the bytes (data URI decoded, remote
  URL fetched, box path via `/api/peek`), wrap in a `File`, dispatch
  `manta-attach-files` → the composer's normal upload pipeline (chip
  uploading → ready → FilePart on submit). Failure is swallowed (a known
  desktop defect; iOS must report it).

### Wire contract
- `GET /api/peek?path=<abs>` (bearer) → bytes; `403 path outside home
  directory`, `404` (`src/server/index.mjs:3725-3755`).
- `POST /api/upload?session=<project>` → `{path}` (existing
  `api.upload(project:filename:data:)`).
- C3: `@discardableResult ComposerTextController.attach(remotePath:displayName:mime:) -> Bool`
  (WS03 `ComposerTextController.swift`; returns `false` for a duplicate path,
  a non-absolute path or a composer that cannot take attachments).
- Remote URLs: a plain `GET <href>` with **no** box credentials (desktop
  `artifactToBlob`, `ArtifactsPanel.tsx:69-78`).

### Byte resolution (shared by preview, Share and Attach)
Desktop `artifactToBlob` (`ArtifactsPanel.tsx:58-87`) has three branches; iOS
today has two and sends an `http(s)` href to `/api/peek`
(`SessionResourceCards.swift:519-532`), which can never succeed. Pure
classifier in `ArtifactPresentation.swift` (KEEP-CLIENT, audit A8):

```swift
enum ArtifactByteSource: Equatable, Sendable {
  case dataURI(String)        // href starts with "data:" (case-insensitive)
  case remote(URL)            // scheme http / https, host non-empty
  case boxPath(String)        // absolute path ("/…" or "~/…")
  case unsupported            // anything else (relative path, other scheme, empty)
  static func classify(_ href: String) -> ArtifactByteSource
}
```

Resolver `ArtifactBytes.load(_ source:, api:, remote:) async -> Result<Data, ArtifactStagingError>`
(in `ArtifactsCard`'s file, UIKit-free but needs `MantaAPIClient`):
- `.dataURI` → existing `decodeDataURI` (moved into `ArtifactPresentation.swift`
  as `ArtifactDataURI.decode(_:)` so it is package-testable); nil → `.badDataURI`.
- `.remote(url)` → `remote(url)`: a dedicated `URLSession(configuration:
  .ephemeral)` request built fresh with **no `Authorization` header and no
  cookies** (`httpShouldSetCookies = false`), 30 s timeout. The box token is
  never sent to a non-box origin — the request is NOT built through
  `MantaAPIClient` or its `session`. Only a 2xx `HTTPURLResponse` is success;
  anything else → `.remote(host:)`. Injected as a closure so tests can stub it.
- `.boxPath(p)` → `api.peekFile(path: p)`; throws → `.missing`.
- `.unsupported` → `.missing`.
- The tap-to-open rule is unchanged for `.link` artifacts (they open in the
  browser); the remote branch matters for `.file` / `.image` artifacts whose
  file part `url` is an `http(s)` URL.

### iOS design
- `ArtifactsCard` gains `var projectName: String? = nil` and
  `var composer: ComposerTextController? = nil` (passed explicitly by ChatScreen,
  M-07-1 — not read from the environment, so the sheet does not depend on where
  WS03's `.environment(\.composerController, …)` sits relative to the `.sheet`
  modifier).
- Context menu **Attach to message** (`paperclip`) on `.file`/`.image` rows
  only, rendered only when `composer != nil && composer.acceptsInput &&
  projectName != nil` (`ArtifactActions.canAttach(kind:hasComposer:acceptsInput:hasProject:)`).
  M-07-1 always passes the chat's controller, and WS03 keeps that controller on
  a read-only background-job chat with `acceptsInput == false` (set by WS02,
  M-03-7; `03-composer.md` `ComposerTextController.acceptsInput`) — so presence
  alone is not enough. The menu item lives in a small subview
  `ArtifactAttachMenuItem` that holds `@ObservedObject var composer`, so the
  item appears/disappears live when `acceptsInput` flips while the card is open.
- Flow (row spinner while running; same `staging` set; a second tap on a row
  that is already working is ignored):
  0. Gate check: if `!composer.acceptsInput` → banner **"This chat is
     read-only."**, stop (no download, no upload).
  1. Bytes: reuse `stagedFiles[id]` if present, else `ArtifactBytes.load`
     (three branches above).
  2. Upload a fresh copy: `api.upload(project: projectName, filename:
     ArtifactAttach.filename(for: artifact), data:)` — a fresh copy is used (as
     on desktop) because the original may be an old upload or an outbox file
     the box sweeps before the message is sent, or a remote URL the box cannot
     read at all.
  2b. Gate re-check after the upload (the chat may have become read-only while
     the bytes were in flight): `!composer.acceptsInput` → banner **"This chat
     is read-only."**, stop. (The uploaded copy is left in `~/.manta-uploads`,
     which the box's hourly upload sweep removes.)
  3. `let ok = composer.attach(remotePath:, displayName: artifact.label, mime: artifact.mime)`.
     `ok == true` → `onClose()` — the card closes ONLY after a successful
     attach; the ready chip in the composer is the visible success. `ok ==
     false` → the card stays open and shows `ArtifactAttach.rejectionMessage(
     composer.lastAttachRejection, name:)` using WS03's copy:
     `.duplicate` → **"Already attached"**, `.readOnly` → **"This chat is
     read-only."**, `.notAbsolute`/nil → **"Couldn't attach <name>."** (C3 rule:
     a rejection is always surfaced.) The card is the ONLY place that reports
     attach outcomes; ChatScreen adds no hint (M-07-1).
- Failures → the inline error banner, card stays open:
  - staging error → **"Couldn't attach <name> — " + the F1 staging reason**
    (e.g. "it may no longer be on the box." / "couldn't download it from <host>.")
  - upload throws → **"Couldn't attach <name> — the upload to the box failed."**
- `ArtifactAttach.filename(for:)`: label if it has an extension, else label +
  extension from the href's last path segment (plans never reach here).

---

## F5 — Expiry display

### Desktop behaviour
- Hosted pages (`isHosted`) always show a pill: `expired` (danger), `<N>h`
  (soon = ≤ 6 h → warn, else ok), or `no expiry` when `expiresAt` is null
  (`ArtifactsPanel.tsx:274-288`, `:335-346`). Expired link cards render at 50 %
  opacity (`:308`).
- Outbox files with an `expiresAt` show the same pill; no pill when null
  (`:441-467`).
- `pageState` (`artifacts.ts:444-452`): null → nil; `≤ now` → expired;
  `≤ 6 h` → soon; else live. `expiryLabel` (`chatUtils.ts:451-455`): whole
  hours floored, minimum `1h`.

### Wire contract
`artifacts:list` item `expiry`: `null` (no expiry concept) or
`{ state: "live"|"soon"|"expired"|"never", expiresAt: number|null }`, state
computed by the box at response time (audit A3). The label text stays client.

### iOS design
- Pure `ArtifactExpiryLabel.text(_ expiry: ArtifactExpiry, now: Date) -> String`
  (presentational only — the STATE comes from the box):
  `.never` → `"no expiry"`; `.expired` → `"expired"`; otherwise from
  `expiresAt` relative to the device clock: remaining < 48 h →
  `"expires in \(max(1, floor(h)))h"`, else `"expires in \(floor(d))d"`
  (the day form replaces the desktop's "167h"). A `.live`/`.soon` item whose
  `expiresAt` has passed on the device clock between polls reads `"expired"`
  until the next poll corrects the tone.
- Row: trailing capsule with that label when `item.expiry != nil`; tone from
  `expiry.state` — `.live` ok, `.soon` warn, `.expired` danger, `.never` ok.
  Expired rows: `.opacity(0.5)`, still tappable (desktop does not block).
- `ArtifactFormat.secondaryLine` (now in `ArtifactPresentation.swift`) uses
  plain `relativeAge`; the pill owns expiry. The old `ageOrExpiry` is deleted
  with `ArtifactDerivation.swift`.

---

## F6 — Agent-sent file notice (Save / Share)

### Desktop behaviour
- `send_file` → `POST /api/outbox/push {filePath, sessionID, ttlHours?,
  messageID?, notify?}`; `notify:true` stores `announce:true` in the sidecar
  (`src/server/index.mjs:4172-4196`).
- The box's 3 s outbox scanner publishes ONE `agentFile` bus event per file,
  only when `announce === true`, not `media`, and never announced before; it
  records `announcedAt` first so a restart never re-announces
  (`src/server/outbox.mjs:283-327`). Delivered on `/events` as
  `{"kind":"agentFile","payload":{remotePath,name,size,sessionName,autoPulled:false}}`
  — `sessionName` is actually the **opencode session id** (or null for a
  root-level file) (`outbox.mjs:309-317`, `src/shared/types.ts:2657-2670`).
- Desktop (`src/renderer/App.tsx:1019-1025`, `src/renderer/GlobalToasts.tsx:62-134`):
  one global toast, newest replaces older, no auto-dismiss (it has actions,
  `src/renderer/Toast.tsx:63-68`). Copy: `↓ <name> · <size> — AI sent you a
  file` with **Save** (`Saving…` while busy). Success → `✓ <name> · saved to
  <folder>` + Reveal. Failure keeps the toast and shows "Download failed — tap
  Save to retry". Download is non-destructive (file stays until TTL).

### Wire contract
- Event: `kind:"agentFile"` on `GET /events` (no `sub`; not a C5 stream frame).
  Payload decoded into `AgentFileEvent { remotePath: String, name: String,
  size: Int, sessionID: String? (from "sessionName"), autoPulled: Bool }`.
  Missing/empty `remotePath` → ignored. `name` empty → last path segment.
- Bytes: `GET /api/download?path=<remotePath>` (bearer, home-scoped, existing
  `api.downloadOutboxFile(path:)`).
- No server change. (Known limitation shared with desktop: an event fired
  while the phone is disconnected is not replayed — the file is still in the
  Artifacts card.)

### iOS design

Three layers, split so the race-prone part is a pure, Linux-testable value
type (D19) and the UIKit part stays thin.

**1. Pure model — `ArtifactAgentFileModel.swift` (Foundation only, in `Package.swift`).**

- `AgentFileEvent: Equatable, Sendable` + `static func from(_ frame: MantaStreamFrame) -> AgentFileEvent?`
  (`kind == "agentFile"` + `decodedPayload`; `sessionName` → `sessionID`).
- `AgentFileNoticeCopy`:
  - `title(event)` → `"report.pdf"`;
  - `detail(event, sessionTitle: String?)` → `"62 KB · AI sent you a file"`
    (size omitted when 0), plus `" · in <sessionTitle>"` when resolved;
  - `savedTitle(event)` → `"Saved report.pdf"`;
  - `failure(event)` → `"Couldn't download report.pdf — it's still on the box, try again."`
  - `pendingBadge(count)` → `"+1 more"` / `"+2 more"` (nil for 0).
- `AgentFileNoticeMachine` — a `struct` state machine. Every notice carries an
  immutable `token: UInt64` (monotonic generation, assigned on arrival); every
  asynchronous operation captures the `(token, opID)` it started with and every
  completion is a no-op unless BOTH still match.

  ```swift
  struct AgentFileNotice: Equatable, Sendable {
    let token: UInt64
    let event: AgentFileEvent
    var phase: Phase
    enum Op: Equatable, Sendable { case save, share }
    enum Phase: Equatable, Sendable {
      case idle
      case downloading(Op, opID: UInt64)
      case presenting(Op, opID: UInt64, fileURL: URL)   // exporter / share sheet is up
      case saved(opID: UInt64, fileURL: URL)            // 2 s confirmation; file kept until close
      case failed(String)
    }
  }
  struct AgentFileNoticeMachine: Equatable, Sendable {
    private(set) var current: AgentFileNotice?
    private(set) var queued: [AgentFileEvent]           // arrivals while `current` is busy
    mutating func receive(_ e: AgentFileEvent)
    mutating func begin(_ op: Op) -> (token: UInt64, opID: UInt64)?      // nil = refused
    mutating func downloadFinished(token: UInt64, opID: UInt64, result: Result<URL, AgentFileFailure>) -> AgentFileEffect
    // `fileURL` is the URL the caller presented — captured by the picker /
    // share-sheet delegate at presentation time — so a stale callback can
    // still clean up its own file without the machine remembering it.
    mutating func presentationFinished(token: UInt64, opID: UInt64, fileURL: URL, completed: Bool) -> AgentFileEffect
    mutating func savedTimerFired(token: UInt64, opID: UInt64) -> AgentFileEffect
    mutating func dismiss() -> AgentFileEffect
  }
  enum AgentFileEffect: Equatable, Sendable {
    case none
    case deleteTemp(URL)
    case scheduleSavedTimer(token: UInt64, opID: UInt64)
  }
  ```

  Rules (all pinned by tests):
  - **Arrival.** `current == nil`, `.idle` or `.failed` → the new event becomes
    `current` (newest wins, desktop parity) with a fresh token. `current` is
    `.downloading`, `.presenting` or `.saved` → the event is appended to
    `queued` and the visible notice gains the `"+N more"` badge; it never
    replaces a notice whose operation is in flight. Duplicate `remotePath`
    already current or queued → ignored.
  - **Re-entrancy.** `begin` is refused (returns nil, no state change) unless
    `current` is `.idle` or `.failed`. The UI disables both buttons for every
    other phase, so a double tap or Save-then-Share cannot start two downloads.
  - **Temp-file ownership (single rule).** A staged file belongs to exactly
    one place at a time: the download result (until handed to the machine),
    then the phase (`.presenting` / `.saved` carry `fileURL`), then an effect.
    Every path that drops a file from the phase returns `.deleteTemp(thatURL)`;
    the store executes it (`try? FileManager.default.removeItem` on the
    file's `<UUID>` directory — failure is logged with `os_log`, never
    swallowed silently). No other code deletes these files.
  - **Download finished.** Token/opID mismatch (the notice was dismissed or
    replaced) → success: `.deleteTemp(url)`; failure: `.none`. Match +
    failure → `.failed(copy)`, `.none`. Match + success →
    `.presenting(op, opID, url)`, `.none` (the store presents `url`).
  - **Presentation finished** (exporter picked / cancelled, share completed /
    cancelled), called with the `fileURL` the delegate captured. "Match"
    means `current.token == token` AND `current.phase` is `.presenting` with
    the same `opID`; anything else is a mismatch:
    - mismatch → `.deleteTemp(fileURL)` (stale callback cleans its own file);
    - match, save, completed → `.saved(opID, fileURL)` +
      `.scheduleSavedTimer(token, opID)` (file kept; the system already made
      its copy, it is deleted when the notice closes);
    - match, share, completed → notice closes, queued promoted,
      `.deleteTemp(fileURL)`;
    - match, cancelled (either op) → `.idle`, `.deleteTemp(fileURL)` (a retry
      downloads again — no stale bytes reused).
  - **Saved timer.** Fires 2 s later. If `current` has that token and is
    `.saved(opID, url)` with the same opID → notice closes, queued promoted,
    `.deleteTemp(url)`. Otherwise `.none` (a later notice is never closed by
    an older timer; the old file was already deleted by whatever closed it).
  - **Dismiss** (×). Allowed in `.idle`, `.failed`, `.downloading`, `.saved`;
    refused (`.none`, no change) in `.presenting` — the picker / share sheet is
    on top, and its delegate completion owns the file. Clears `current`,
    promotes the first `queued` event (fresh token, `.idle`), and returns
    `.deleteTemp(url)` when the dismissed phase was `.saved(_, url)`, else
    `.none`. Dismiss during `.downloading` leaves the file to the late
    completion, which mismatches and returns `.deleteTemp`.
  - **Promotion.** Whenever `current` closes, the oldest queued event becomes
    current; the queue is capped at 5 (oldest dropped — every file is still
    listed in the Artifacts card).

**2. Store — `ArtifactAgentFile.swift` (UIKit app target only).**
`@MainActor final class ArtifactAgentFileStore: ObservableObject` (no
singleton): `@Published private(set) var machine: AgentFileNoticeMachine`;
`init(download: @escaping @Sendable (String) async throws -> Data =
<api.downloadOutboxFile>, tempRoot: URL = FileManager.default.temporaryDirectory,
sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) })`.
- `bind(eventStore:)` — idempotent (`bound` flag); registers
  `addRawFrameHandler { [weak self] f in if let e = AgentFileEvent.from(f) { self?.receive(e) } }`.
- `save()` / `share()` → `machine.begin`; `Task { data = await download(path) }`;
  writes `tempRoot/manta-agentfile/<UUID>/<name>` (real filename for Files /
  share sheet); hands the result to `machine.downloadFinished(token:opID:…)`
  and executes the returned `Effect`.
- `presentationFinished(token:opID:fileURL:completed:)`, `dismiss()` — forward
  to the machine and execute the returned `AgentFileEffect`
  (`.scheduleSavedTimer` → `Task { await sleep(.seconds(2)); execute(machine.savedTimerFired(token:opID:)) }`;
  `.deleteTemp` → remove the file's directory). On `deinit`-free teardown
  nothing is needed: the temp root is the app's `tmp/`, which iOS purges.
- Haptic on save success: `SessionHaptics.fire(.success, enabled: hapticsEnabled)`
  (existing helper, `SessionListView.swift:1009-1023`) where `hapticsEnabled`
  is read from the `SessionListStore` passed in by the view
  (`SessionListStore.hapticsEnabled`, `:71`). No haptic when the setting is off.

**3. View — `ArtifactAgentFileNotice` (same file).**
- Bottom floating card (system material, `Metrics` spacing, `Theme` tokens),
  `arrow.down.doc` glyph, title + detail (+ `"+N more"`), buttons **Save** and
  **Share** (each shows a `ProgressView` + "Saving…" / "Preparing…" while its
  op is downloading; both disabled unless `.idle`/`.failed`), × **Dismiss**
  (disabled while `.presenting`). `.failed` shows the failure copy in the
  danger tone with buttons enabled (retry is safe — download is
  non-destructive). `.saved` shows **"Saved report.pdf"**.
- Owns `@StateObject` store; `@EnvironmentObject MantaEventStore` +
  `SessionListStore` (session title = window name whose `opencodeSessionId ==
  event.sessionID`; haptics flag). `.task { store.bind(eventStore:) }`.
- **Presentation** of the exporter / share sheet is done in UIKit from the
  top-most presented view controller of the window that hosts the notice
  (`ArtifactPresenter.topMost(from: view.window)` — walks
  `rootViewController.presentedViewController`), NOT via a SwiftUI `.sheet` on
  the root overlay — a second SwiftUI presentation on `MantaAppRoot` would
  collide with the session list's own `.sheet` / `.fullScreenCover`
  (`SessionListView.swift:146-158`). `UIDocumentPickerViewController(forExporting:
  [url], asCopy: true)` delegate → `presentationFinished(…, completed: !urls.isEmpty)`
  / `documentPickerWasCancelled` → `completed: false`;
  `UIActivityViewController.completionWithItemsHandler` → `completed`. Each
  delegate object is created per presentation and stores the `(token, opID,
  fileURL)` it was presented with; its completion passes all three.
- No auto-dismiss while idle (desktop parity: the toast has actions).
- `accessibilityIdentifier("agent-file-notice")`; VoiceOver announcement on
  arrival (`AccessibilityNotification.Announcement("AI sent you a file: <name>")`).

**Modal behaviour (where the notice is visible).**
The notice is an overlay on the paired root (M-07-3). It is visible over the
session list and over any pushed chat (both live inside that root's
navigation stack). It is NOT drawn over a modal presented above the root —
Settings (`fullScreenCover`, `SessionListView.swift:157-158`), the create /
rename sheets, or a chat's overflow / resource sheets. In those cases the
event is **not lost**: the store keeps it (`current` / `queued`), and the
notice becomes visible the moment the modal closes, still `.idle`, still
actionable. The VoiceOver announcement still fires on arrival. A global
window-level host was considered and rejected: it would need a second
`UIWindow` owned outside every workstream's files, for a banner the user sees
seconds later anyway.

- Mounted once, globally (M-07-3) — the notice appears on the session list and
  inside any chat, like the desktop's global toast, and after any modal closes.

---

## F7 — Webhooks card

### Desktop behaviour (`src/renderer/PanelCards.tsx:113-213`)
- Opened from the composer toolbar 🪝 button ("View / revoke inbound webhooks
  (external events that wake this session)", `ComposerParts.tsx:223-228`).
- Header "Webhooks · N". Empty: "No webhooks in this session. Ask the agent to
  create one (e.g. “have Multica ping this session when the task finishes”)."
- Row: label; red `unsigned` badge (title "No signature required — anyone with
  the URL can trigger this hook"); delivery URL without scheme, click =
  copy, shows `copied!` for 1.5 s; `· <localized datetime> · N×` or
  `· never fired`; **Revoke** button (title "Revoke this webhook (further
  POSTs will 404)"), no confirm.
- Revoke: optimistic remove → `webhook:delete` → refetch; error → message in
  the card + refetch (`src/renderer/ChatPanel.tsx:3267-3281`).
- Data: refetch on open (`src/renderer/hooks/useSessionResources.ts:186-191`).
  Creation is the AI's job only — no create UI.

### Wire contract
- `webhook:list` — `args: [sessionId]` → `WebhookMeta[]`
  (`src/server/rpc.mjs:2516`, `src/server/webhooks.mjs:458-462`, `toMeta`
  `:275-288`): `{id, provider, label, url: string|null, unsigned: bool,
  sessionID: string|null, instructions: string, createdAt: number|null,
  lastDeliveredAt: number|null, deliveries: number}`. Never contains the
  signing secret or token.
- `webhook:delete` — `args: [id]` → `{ok:true, deleted:boolean}`
  (`rpc.mjs:2518`, `webhooks.mjs:446-454`); `deleted:false` = already gone
  (treat as success). Publishes `webhook.updated` (not consumed here —
  desktop is refetch-driven too).
- C1: `MantaAPIClient+Artifacts.swift` adds
  `listWebhooks(sessionId:) -> [WebhookMeta]` and `deleteWebhook(id:)`.

### iOS design
- `WebhookModels.swift` (pure): `struct WebhookMeta: Decodable, Equatable,
  Sendable, Identifiable` (all fields above; `provider`/`instructions`
  optional for older boxes) and `WebhookFormat`:
  - `lastDelivery(_ hook:) -> String` → `"never fired"` or
    `"<date, abbreviated date + short time> · 3×"`;
  - `displayURL(_ url: String?) -> String?` → scheme stripped.
- `WebhooksCard` (new file `WebhooksCard.swift`), stock
  `NavigationStack` + `List(.insetGrouped)`, same shape as `SchedulesCard`:
  - title "Webhooks", **Done** button; loading `ProgressView`; failure
    "Couldn't load webhooks." + **Retry** button.
  - Empty: `ContentUnavailableView("No webhooks", systemImage:
    "point.3.connected.trianglepath.dotted", description: Text("Ask the agent to
    create one — for example, “have Multica ping this session when the task
    finishes”."))`.
  - Row: label (or "Untitled webhook"); trailing red capsule **Unsigned**
    when `unsigned` (`accessibilityHint("No signature required — anyone with
    the URL can trigger this hook")`); monospaced caption of the display URL;
    caption `Last delivery: …`.
  - Tap row (when `url != nil`) → `UIPasteboard.general.string = url`; the
    URL caption reads **"Copied"** for 1.5 s (that text is the confirmation,
    so it is shown whether or not haptics are on); haptic via
    `SessionHaptics.fire(.selection, enabled: sessionStore.hapticsEnabled)`
    (`@EnvironmentObject SessionListStore`, inherited by the sheet — the same
    gate every existing caller uses, `SessionListView.swift:106-108`). With
    haptics off the copy is silent. No URL → caption
    "No delivery URL" and the row is not tappable.
  - Context menu: **Copy delivery URL** (when url), **Revoke** (destructive).
  - Swipe trailing **Revoke** (destructive, `trash`) — swipe is the
    confirmation gesture, matching `SchedulesCard` and the desktop's
    no-confirm Revoke.
  - Revoke: optimistic removal → `deleteWebhook` → reload. Error → reload and
    show an inline red row "Couldn't revoke <label> — <message>".
- Overflow row **Webhooks** (`point.3.connected.trianglepath.dotted`) in the
  first section after Secrets; no count badge (desktop has none). Shown only
  when the new `var onWebhooks: (() -> Void)? = nil` is non-nil (wired by
  M-07-2).
- `MantaAPIClient` is created inside the card as the other cards do
  (`MantaAPIClient.live()`); `WebhooksCard` takes `api` as an init parameter
  defaulted to `.live()` so previews/tests can pass a stub.

## F7b — Secrets "shared" scope

### Desktop behaviour (`PanelCards.tsx:240-330`, `SecretEditor.tsx:23-25`)
- Scope select: **shared** (default) / **this project** / **this session**,
  title "shared = every session · project = every chat in this workspace ·
  session = only this chat".
- `sessionID` sent for session AND project scope (server resolves the project
  name from it), `null` for shared (`PanelCards.tsx:300-301`).
- Row badge: `shared` / `project:<name>` / `session`.

### Wire contract
`secrets:set {key, value, scope:"shared"|"project"|"session", sessionID?,
project?, hint?}` (`rpc.mjs:2495-2500`, `src/server/secrets.mjs:203-231`:
shared ignores sessionID; session requires it; project requires a resolvable
project). `secrets:list(sessionId)` returns session + project + shared
visible secrets (`rpc.mjs:2490-2493`, `secrets.mjs:81-108`).

### iOS design
- Pure `SecretScopeOption` (in `WebhookModels.swift` under a
  `// MARK: - Secrets scope` section, to stay inside WS07's `Webhook*` new-file
  prefix; Foundation-only): `.shared/.project/.session`, `title` ("Shared — every session" /
  "This project" / "This session"), `wireScope`, and
  `static func input(key:value:scope:sessionId:hint:) -> SecretInput`
  (sessionID nil for shared). `static func badge(_ meta: SecretMeta) ->
  String` → `shared` / `project:<name or ?>` / `session`.
- `SecretAddForm`: picker gains **Shared — every session** first; default
  `.shared` (desktop parity); footer under the picker: "Shared secrets are
  available to every session on this box. Project: every chat in this
  workspace. Session: only this chat."
- `SecretsCard.detail` uses `SecretScopeOption.badge`.
- While here: `SecretsCard.delete` currently swallows a failure
  (`SessionResourceCards.swift:206-210`) — surface "Couldn't delete <key>." as an
  inline red row (no-dead-controls rule).

---

## Pure logic + tests (C7, D19)

Tests are split by what they compile against (finding 3). `Package.swift`
compiles an explicit list of Foundation-only sources and does NOT contain
`MantaAPIClient` (it depends on the Keychain store, `MantaAPIClient.swift:8-21`)
or any SwiftUI/UIKit/Combine file. So:

**Package-safe (Linux `verify.sh` + Mac `test-unit`)** — pure files only:

`MantaUITests/ArtifactWireTests.swift` (new; replaces the deleted
`ArtifactDerivationTests.swift` — derivation is now pinned by the node tests in
`src/server/artifacts.test.mjs`):
1. Decodes the exact `artifacts:list` example from the Server-first section:
   every field, `expiry: null`, `expiry.state "never"` with `expiresAt: null`,
   `plan` present only on a plan item, `counts`, `degraded`.
2. Unknown `kind` / `expiry.state` → `.unknown`, and `ArtifactsListResult.renderable`
   (computed) drops those items without failing the decode.
3. Missing optional fields (older/newer box) decode with defaults:
   `context`, `messageId`, `size`, `mime` → nil; `degraded` → `[]`.
4. `ArtifactsCapability.isUnsupported`: `MantaError.server("unknown rpc channel: artifacts:list")`
   → true; any other server/transport error → false.
5. Plan `pageUrl: null` + `pageUrlReason: "other-session"` and
   `"no-public-address"` decode; an unknown reason decodes as a non-nil
   string (treated as generic). `degraded: ["public-address"]` decodes.
   `ArtifactDegradedCopy.footer` for `[]`, `["public-address"]`,
   `["outbox"]`, `["public-address","outbox"]`.

`MantaUITests/ArtifactPresentationTests.swift` (new):
- `ArtifactExpiryLabel.text` (state is server-provided; label only):
  `.never` → "no expiry", `.expired` → "expired", `.live` 30 min ahead →
  "expires in 1h", 5.9 h → "expires in 5h", 3.5 d → "expires in 3d",
  `.soon` whose `expiresAt` already passed on the device clock → "expired".
- `ArtifactSearch.filter` (label match, href match, case-insensitive,
  whitespace-only query = all); `ArtifactSearch.counts`; `ArtifactEmptyCopy.sub`.
- `ArtifactActions.canAttach(kind:hasComposer:acceptsInput:hasProject:)`
  (file/image only; false without composer, with `acceptsInput == false`, or
  without project), `canJump`, `canOpenPlanFile`.
- `ArtifactAttach.rejectionMessage(_:name:)` — `.duplicate` → "Already
  attached", `.readOnly` → "This chat is read-only.", `.notAbsolute` / nil →
  "Couldn't attach <name>." (takes WS03's pure `ComposerInsertion.AttachRejection`,
  which lives in WS03's Foundation-only `ComposerInsertion` file — package-safe).
- `ArtifactAttach.filename`;
  `ArtifactStaging.fileExtension(label:href:)` (plan title + `.md` href → `.md`).
- **Byte source routing (finding 1):** `ArtifactByteSource.classify` —
  `"data:image/png;base64,AAA"` → `.dataURI`; `"DATA:…"` → `.dataURI`;
  `"https://cdn.example.com/a.png"` → `.remote`; `"http://x/y"` → `.remote`;
  `"https://"` (no host) → `.unsupported`; `"/home/dev/.manta-outbox/s/a.pdf"`
  and `"~/a.pdf"` → `.boxPath`; `"relative/a.pdf"`, `"ftp://x/a"`, `""` →
  `.unsupported`. `ArtifactDataURI.decode` (base64, percent-encoded, missing
  comma → nil). `ArtifactStagingError.message` for every case.

`MantaUITests/ArtifactAgentFileTests.swift` (new; pure, against
`ArtifactAgentFileModel.swift`):
- `AgentFileEvent.from` decodes the exact desktop payload
  (`{"kind":"agentFile","payload":{"remotePath":…,"name":…,"size":…,"sessionName":"ses_1","autoPulled":false}}`);
  maps `sessionName` → `sessionID`; ignores `kind != "agentFile"`; nil on
  missing/empty `remotePath`; empty name → basename.
- Copy strings (with/without size, with/without session title, failure, saved,
  `+N more`).
- **Machine interleavings (finding 2)**, each a deterministic sequence of
  mutating calls:
  1. *A starts, B arrives, A finishes:* receive(A); begin(.save) → (tA, op1);
     receive(B) → B queued, current still A `.downloading`;
     downloadFinished(tA, op1, .success(u)) → A `.presenting`; B still queued.
  2. *Old picker completion after replacement:* A `.presenting` (tA, op1, u);
     dismiss() is refused while presenting → state unchanged, effect `.none`;
     then presentationFinished(tA, op1, fileURL: u, completed: true) → A
     `.saved(op1, u)`, effect `.scheduleSavedTimer(tA, op1)` (file kept).
  3. *Old success timer:* A `.saved(op1, u)`; dismiss() → effect
     `.deleteTemp(u)`, B promoted with token tB; savedTimerFired(tA, op1) →
     `.none`, B untouched (still `.idle`, still current).
  3b. *Saved then timer closes:* A `.saved(op1, u)`; savedTimerFired(tA, op1)
     → `.deleteTemp(u)`, current = next queued (or nil).
  3c. *Share completed:* A `.presenting(.share, op1, u)`;
     presentationFinished(tA, op1, fileURL: u, completed: true) →
     `.deleteTemp(u)`, notice closed.
  3d. *Stale presentation callback:* a presenting notice can only go stale
     through a duplicate delegate callback (UIKit may call the activity
     completion more than once) — A `.presenting(.share, op1, u)`;
     presentationFinished(tA, op1, u, completed: false) → `.idle`,
     `.deleteTemp(u)`; the same call again → `.deleteTemp(u)` (idempotent
     removal), state unchanged; and with a foreign `(token, opID)` while B is
     current → `.deleteTemp(<its own fileURL>)`, B unchanged.
  4. *Dismiss during download:* receive(A); begin(.share) → (tA, op1);
     dismiss() → current nil; downloadFinished(tA, op1, .success(u)) →
     effect `.deleteTemp(u)`, state unchanged.
  5. *Stale download for a re-arrived token:* begin twice → second `begin`
     returns nil (re-entrancy); a completion with a wrong opID is ignored.
  6. *Failure then retry:* downloadFinished(…, .failure) → `.failed(copy)`;
     begin(.save) allowed again with a new opID.
  7. *Idle replacement:* receive(A) (idle); receive(B) → B current, A dropped,
     token increases. Duplicate `remotePath` ignored. Queue cap 5.
  8. *Cancelled exporter:* presentationFinished(tA, op1, fileURL: u,
     completed: false) → `.idle`, effect `.deleteTemp(u)`.

`MantaUITests/WebhookTests.swift` (new; pure): decode `WebhookMeta` full +
nulls + missing `provider`/`instructions`; `WebhookFormat.lastDelivery`
(`deliveries == 0 && lastDeliveredAt == nil` → "never fired"; otherwise ends
with `· 3×`); `displayURL` strips `https://`/`http://`, nil passthrough.

`MantaUITests/SecretScopeTests.swift` (new; pure): shared input omits
`sessionID` (encode and inspect JSON); project/session include it; badges
(`shared`, `project:manta`, `project:?`, `session`).

**Xcode-only (Mac `test-unit`; NOT added to `Package.swift`):**

`MantaUITests/ArtifactAPITests.swift` (new): `MantaAPIClient.makeRequest(…
channel: "webhook:list", args: ["ses_1"])` → path `/rpc/webhook:list`, args
`["ses_1"]`; same for `webhook:delete` `["ab12cd34"]` and `artifacts:list` `[{"sessionId":"ses_1"}]` (the
single-object args `artifactsList` sends). A remote-fetch request built
by `ArtifactBytes.remoteRequest(for:)` carries **no `Authorization` header**
and `httpShouldHandleCookies == false`.

`MantaUITests/ChatOverflowGateTests.swift` (new): the M-04-2 mount gate
(see "Mounts applied").

`MantaUITests/ArtifactAgentFileStoreTests.swift` (new, `@MainActor`): the
real store with an injected `download` closure that suspends on a
continuation the test controls, injected `sleep` that returns immediately on
demand, and a temp dir:
- A starts downloading; B's frame is delivered; A's continuation resumes →
  `machine.current?.event == A`, `.presenting`, B queued, A's temp file exists.
- Dismiss while A is downloading; resume A → temp file deleted, no state change.
- Save completes → saved timer fires → B promoted; a second (stale) timer for A
  fired later does not close B.
- **The actual temp files are removed** (assert `FileManager.fileExists ==
  false` on the staged URL's directory) after: save success + timer close;
  save success + × dismiss; exporter cancel; share completion; share cancel;
  a stale presentation callback; a stale download completion.
- `bind(eventStore:)` called twice registers one handler (a second frame
  produces one arrival).

Server: `src/server/artifacts.test.mjs` (Server-first section, cases 1–11).
Desktop: `ArtifactsPanel.server.test.tsx`, the migrated `artifacts.test.ts` /
`ArtifactPreview.test.tsx`. Both `npm run typecheck` and `npm test` (vitest +
node) must be green with M-07-S1 and M-07-D1…D5 applied.

---

## Acceptance criteria

- [ ] Artifacts card shows four segments with counts; Plans lists every plan
      the transcript references, titled from the filename, with status and
      step count; the plan's own page never appears under Links.
- [ ] Tapping a plan opens its published page in the browser; a failure shows
      "Couldn't open the plan page." in the card. "Open plan file" previews the
      markdown in QuickLook (hidden when the session folder is unknown).
- [ ] A plan file (or any file/image) that no longer exists on the box shows
      "Couldn't open <name> — it may no longer be on the box." in the card; the
      card stays open and tapping again retries. A damaged `data:` image shows
      the damaged-data message. No preview tap ever does nothing.
- [ ] Search filters the current segment by name or path, updates segment
      counts, and shows the system "No results for …" state.
- [ ] "Jump to message" appears only for artifacts with an owning message;
      choosing it closes the card and the chat scrolls to and highlights that
      message (via C2 `.message`).
- [ ] "Attach to message" appears only on files/images and only where a
      composer exists and accepts input; it closes the card only after the
      attach succeeds and a ready chip appears in the composer; a vanished
      file, a failed upload or a composer rejection ("Already attached", …)
      shows the matching inline error and the card stays open.
- [ ] In a read-only background-job chat the artifacts card offers no "Attach
      to message"; if the chat turns read-only while an attach is in flight,
      the card says "This chat is read-only." and attaches nothing.
- [ ] Every temporary copy of an agent-sent file is removed once its notice
      closes, its exporter/share sheet is cancelled or completes, or its
      download finishes after the notice was dismissed.
- [ ] An image whose source is an `https://` URL can be previewed and attached;
      the request to that URL carries no box token; a 404 from it shows
      "Couldn't download <name> from <host>."
- [ ] Hosted pages always show an expiry capsule ("no expiry" when none);
      agent-sent files with a TTL show one; expired rows are dimmed.
- [ ] When the agent calls `send_file` with `notify:true`, a notice appears
      within ~3 s over the session list or the open chat, naming the file, size
      and conversation; Save opens "Save to Files" and confirms "Saved <name>";
      Share opens the share sheet; a download failure says the file is still on
      the box and leaves the notice up; × dismisses. A file sent without
      `notify` produces no notice.
- [ ] If the file arrives while Settings or a chat sheet (overflow, artifacts,
      secrets…) is open, nothing is lost: the notice is waiting, actionable,
      when that screen closes.
- [ ] Two files arriving while the first is being saved: the first notice is
      not replaced mid-save, shows "+1 more", and the second notice appears when
      the first is done or dismissed. A "Saved" confirmation never closes a
      different file's notice.
- [ ] With Haptics turned off in Settings, saving a file and copying a webhook
      URL produce no vibration (the on-screen "Saved…" / "Copied" still show).
- [ ] Overflow shows "Webhooks"; the card lists this session's hooks with
      unsigned badge, delivery URL (tap copies, shows "Copied"), last delivery
      or "never fired"; swipe/menu Revoke removes it and a failure is reported.
- [ ] New secret form defaults to "Shared — every session" (D9); saving a
      shared secret sends no session id and it appears in the list labelled
      `shared`; project secrets read `project:<name>`; a failed delete says so.
- [ ] The overflow sheet carries the received mounts (rename, mode rows,
      display toggle, read-only job guard) — see "Mounts applied by this
      workstream".
- [ ] No control is shown that cannot act (every new action is hidden when its
      closure/input is missing).
- [ ] The artifacts list on desktop AND iOS comes from `artifacts:list`; no
      client contains artifact derivation (`deriveArtifacts`, `ArtifactDerivation`
      are gone; `grep` finds no `planRefsFromPart` in `src/renderer`).
- [ ] Against a box without `artifacts:list`, both clients show "Update your
      box to use this." in place of the list (desktop Review mode still works);
      no control in the list area is dead.
- [ ] A plan whose page URL the box cannot determine shows "Couldn't open the
      plan page."; a plan whose session folder is unknown has no "Open plan
      file" action.
- [ ] Desktop visual baselines for the artifacts states are unchanged;
      `npm run typecheck`, `npm test` (incl. `src/server/artifacts.test.mjs`
      and `ArtifactsPanel.server.test.tsx`) green.
- [ ] `./verify.sh` green with the package-safe tests; `ios-mantaui`
      `test-unit` green (includes the Xcode-only tests).

---

## Libraries considered (user rule: research before building)

Source: `libraries.md` §07 (npm figures for the week 2026-10-20…26).

**Adopted**

| Library | Version · license | Adoption | Plugs in at |
|---|---|---|---|
| `lru-cache` — `LRUCache` | 11.5.3 · BlueOak-1.0.0 (permissive, OSI-approved) | ~519M/wk, 2026-09; already transitive | Core storage of `createArtifactsService` (`src/server/artifacts.mjs`, "Memoization"): `new LRUCache({ max: 32, ttl: 30_000 })`, no `updateAgeOnGet`, `perf: { now }` for the injected clock. In-flight sharing stays a hand-written `Map<sessionId, Promise>` (`fetchMethod` keys on `sessionId` only). New direct dependency, installed by WS07 (§Files). |

**Kept hand-written / already provided**

| Item | Candidates | Decision |
|---|---|---|
| Extension → MIME | `mime-types` 3.0.2 (MIT, ~254M/wk), `mime` 4.1.2 (MIT, ~141M/wk) | **KEEP an allowlist, but ONE table**: extend and export `src/server/media.mjs`'s `MIME_BY_EXT` (+ `mimeForName`) instead of a fourth copy. A full database would label `.ts` as `video/mp2t` and widen what gets previewed. |
| Hash of the last message's parts | `node:crypto` SHA-1 | Built-in — already the plan. |
| iOS file/image preview | `QLPreviewController` | System framework — already the plan. |
| Byte sizes | `ByteCountFormatter` | System — already used (`ArtifactDerivation.swift:265` today; kept in `ArtifactPresentation`). |
| Relative age / expiry label ("4m ago", "5h") | `Date.RelativeFormatStyle`, `RelativeDateTimeFormatter`, `Intl.RelativeTimeFormat` | **KEEP hand-written** on both clients: exact copy parity with the desktop and deterministic tests; system formatters print "4 min. ago" and vary by locale. |

## Files

Edit (owned):
- `mobile/native/MantaUI/ArtifactDerivation.swift` — **deleted** (D23; the
  derivation lives in `src/server/artifacts.mjs`).
- `mobile/native/MantaUI/SessionResourceCards.swift` — `ArtifactsCard`
  (Plans, search, jump, attach via `composer`, expiry, error banner, per-tab
  empty states, `ArtifactBytes` three-branch loader, `Result`-returning
  staging, renders `artifacts:list` via `artifactsList`, unsupported/error
  states), `SecretsCard`/`SecretAddForm` (shared scope,
  badge, delete error).
- `mobile/native/MantaUI/ChatOverflowSheet.swift` — optional `onWebhooks`
  row, plus the received mounts (table below).
- `mobile/native/MantaUITests/ArtifactDerivationTests.swift` — **deleted**.
- `mobile/native/Package.swift`, `mobile/native/project.yml` — owned by WS07
  (D1) but, per D18, written by integration agent B from this manifest (M-07-4).

Create:
- `mobile/native/MantaUI/MantaAPIClient+Artifacts.swift` — client members
  below (app target only).
- `mobile/native/MantaUI/ArtifactModels.swift` — `artifacts:list` wire types
  + `ArtifactsCapability` (pure).
- `mobile/native/MantaUI/ArtifactPresentation.swift` — the KEEP-CLIENT
  helpers listed in "iOS migration" (pure).
- `mobile/native/MantaUI/ArtifactAgentFileModel.swift` — `AgentFileEvent`,
  `AgentFileNoticeCopy`, `AgentFileNotice`, `AgentFileNoticeMachine`,
  `AgentFileFailure` (pure).
- `mobile/native/MantaUI/ArtifactAgentFile.swift` — `ArtifactAgentFileStore`,
  `ArtifactAgentFileNotice`, `ArtifactPresenter`, picker/activity delegates
  (UIKit, app target only).
- `mobile/native/MantaUI/WebhookModels.swift` — `WebhookMeta`,
  `WebhookFormat`, `SecretScopeOption` (pure).
- `mobile/native/MantaUI/WebhooksCard.swift` (SwiftUI, app target only).
- Tests: `ArtifactWireTests.swift`, `ArtifactPresentationTests.swift`,
  `ArtifactAgentFileTests.swift`, `WebhookTests.swift`, `SecretScopeTests.swift`
  (package-safe); `ArtifactAPITests.swift`, `ArtifactAgentFileStoreTests.swift`
  (Xcode-only).

Server (WS07-owned, new):
- `src/server/artifacts.mjs`, `src/server/artifacts.test.mjs`.

Server (WS07-owned edits in wave B — master D27 row):
- `src/server/media.mjs` — export the extended `MIME_BY_EXT` + new
  `mimeForName(name)`; `guessMime` reads the same table (see "Derivation
  rules"). `src/server/media.test.mjs` — case 12.

Root dependencies (`package.json` / `package-lock.json` — WS07 is the ONLY
wave-B worker that adds a dependency, so it edits them directly; master D27
row + ledger row M-07-pkg-1 record the ownership):
- `npm install lru-cache@11.5.3` — BlueOak-1.0.0, already in `node_modules`
  as a transitive dependency (an older major, 5.x, today; npm nests that copy
  under its dependents once 11.x is hoisted as a direct dependency). Used by
  `src/server/artifacts.mjs`; WS05 reuses it in wave C. Run `npm test` after
  the install to confirm the transitive consumers still resolve their own copy.
- A new dependency reaches boxes only through the next server release tarball
  (root AGENTS.md "A clean install runs the RELEASE's source") — it ships with
  this workstream's server code in one release.
- No other wave-B workstream (02, 06, 09) adds a dependency. If one ever needs
  to, it must NOT edit `package.json`: it files an IB ledger row and
  integration agent B runs the install after B.

Desktop (WS07-owned edits — see "Desktop migration"):
- `src/shared/artifactsTypes.ts` (new), `src/renderer/api/demoArtifacts.ts`
  (new), `src/renderer/artifacts.ts`, `src/renderer/artifacts.test.ts`,
  `src/renderer/ArtifactsPanel.tsx`, `src/renderer/ArtifactsPanel.server.test.tsx`
  (new), `src/renderer/MediaBody.tsx`, `src/renderer/ArtifactPreview.tsx`
  (type check only), `src/renderer/ArtifactPreview.test.tsx` (fixture
  migration).

Shared server/desktop files edited only through ledger rows (M-07-S1, M-07-S2,
M-07-D1…D5; the desktop ones are WS02-owned in wave B, master D27):
`src/server/rpc.mjs`, `src/server/boxCapabilities.mjs`, `src/renderer/chatUtils.ts` +
`chatUtils.test.ts`, `src/shared/api.ts`, `src/shared/types.ts`,
`src/renderer/api/httpApi.ts`, `src/renderer/api/demoApi.ts`. WS07 does not
edit `index.mjs` or `streamInterp.mjs`.

## Client members (D16)

All in `MantaUI/MantaAPIClient+Artifacts.swift`; none duplicates a member
another spec declares (checked: no other spec in this folder adds an
`artifacts:*`, `outbox:*` or `webhook:*` member; `listOutboxRows` from round 2
is withdrawn — the box reads the outbox; the existing `listOutbox`,
`downloadOutboxFile`, `peekFile`, `upload`, `servePageList`, `setSecret`,
`deleteSecret`, `listSecrets` in `MantaAPIClient.swift` are reused, not
redeclared).

| Member | Signature | Wire |
|---|---|---|
| `artifactsList` | `func artifactsList(sessionId: String) async throws -> ArtifactsListResult` | `artifacts:list` `[{"sessionId": sessionId}]` → `callRequired(…)`; an `unknown rpc channel` error surfaces as `MantaError.server` and is classified by `ArtifactsCapability.isUnsupported` |
| `listWebhooks` | `func listWebhooks(sessionId: String) async throws -> [WebhookMeta]` | `webhook:list` `[sessionId]` → `call(…) ?? []` |
| `deleteWebhook` | `func deleteWebhook(id: String) async throws` | `webhook:delete` `[id]` → `callVoid` (`deleted:false` = success) |

## Mount requests (D18)

IDs, appliers and symbols match the master's canonical mount ledger
(`00-master.md`, rows M-07-1…M-07-4).

| ID | Receiving file | Applier | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-07-1 | `ChatScreen.swift` | WS02 (wave B) | `ArtifactsCard(sessionId:onClose:projectName:cwd:composer:onJumpToMessage:)` (WS07, `SessionResourceCards.swift`); `ComposerTextController` `@StateObject` named `composer` (WS03 M-03-1, A1); `MantaNavigator.open(_:)` with `MantaRoute.message(sessionID:messageID:)` (WS04, C2) | In `destinationCard(.artifacts)` (`ChatScreen.swift:782-785`) construct `ArtifactsCard(sessionId: store.sessionId, onClose: { overflowDestination = nil }, projectName: projectName, cwd: sessionWindow?.cwd, composer: composer, onJumpToMessage: { mid in pendingArtifactJump = mid; overflowDestination = nil })`. **No `onAttach` parameter exists** and ChatScreen adds **no attach hint**: the card performs the upload + `composer.attach`, reports every rejection itself, and closes only after a successful attach. Add `@State private var pendingArtifactJump: String?`; in `flushPendingPush()` (`:825`, the `onDismiss` of the destination sheet at `:632`), before the existing push handling: `if let mid = pendingArtifactJump { pendingArtifactJump = nil; navigator.open(.message(sessionID: store.sessionId, messageID: mid)) }`. | M-03-1 (A1); WS04 navigator (A2); M-03-7 (WS02 keeps `composer.acceptsInput` current — the card's Attach gate depends on it) |
| M-07-2 | `ChatScreen.swift` | WS02 (wave B) | `WebhooksCard(sessionId:onClose:)` (WS07, `WebhooksCard.swift`); `ChatOverflowSheet.onWebhooks: (() -> Void)?` (WS07) | `OverflowDestination` (`:88`) gains `case webhooks`; `destinationCard` adds `case .webhooks: WebhooksCard(sessionId: store.sessionId, onClose: { overflowDestination = nil })`; `overflowSheet` (`:658`) passes `onWebhooks: { overflowDestination = .webhooks }`. | WS07 `WebhooksCard` (wave B; defaulted param, row hidden until wired) |
| M-07-3 | `MantaAppRoot.swift` | Integration agent B (IB, after B) | `ArtifactAgentFileNotice()` (WS07, `ArtifactAgentFile.swift`) | On the paired branch (`MantaAppRoot.swift:98-109`, the `SessionListView(store:)` view) add `.overlay(alignment: .bottom) { if scene == nil { ArtifactAgentFileNotice() } }`, placed BEFORE (i.e. beneath) the existing `.overlay { UpgradeScreen }` at `:123-128` so the upgrade screen covers it. Needs `MantaEventStore` + `SessionListStore` environment objects (already injected, `MantaUIApp.swift:46-50`). | WS07 merged (B) |
| M-07-4 | `mobile/native/Package.swift` | Integration agent B (IB, after B; D18 — file owned by WS07 per D1) | — | **Remove** `ArtifactDerivation.swift` from target `sources` and `ArtifactDerivationTests.swift` from test `sources` (both files deleted, server-first). Append to target `sources`: `ArtifactModels.swift`, `ArtifactPresentation.swift`, `ArtifactAgentFileModel.swift`, `WebhookModels.swift`. Append to test `sources`: `ArtifactWireTests.swift`, `ArtifactPresentationTests.swift`, `ArtifactAgentFileTests.swift`, `WebhookTests.swift`, `SecretScopeTests.swift`. Do NOT add `MantaAPIClient+Artifacts.swift`, `ArtifactAgentFile.swift`, `WebhooksCard.swift`, `ArtifactAPITests.swift`, `ArtifactAgentFileStoreTests.swift`. Then run `./verify.sh`. | WS07 merged; WS03's `ComposerInsertion.swift` already in the package (M-03-8, IA) — `ArtifactPresentationTests` uses `ComposerInsertion.AttachRejection` |

`project.yml`: no change (the `MantaUI` / `MantaUITests` folder entries pick
up new files and drop deleted ones). `.pbxproj` is regenerated once by the
orchestrator (O-final, D18).

### Server and shared-desktop registrations (D24 — applied by integration agent B, order 02 → 07 → 09 → 06)

| ID | Receiving file | Applier | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-07-S1 | `src/server/rpc.mjs` | IB (after WS02's rows) | `createArtifactsService` (WS07, `src/server/artifacts.mjs`) | `import { createArtifactsService } from "./artifacts.mjs";`. Inside `buildHandlers`, once: `const artifacts = createArtifactsService({ listMessages: (sid, o) => oc.listMessages(sid, o), listPages: () => servePageListStore({ baseUrl: publicBaseUrl() }), listOutbox: () => listOutbox(), sessionDirectory: (sid) => oc.getSessionDirectory(sid), baseUrl: () => publicBaseUrl() });` (`baseUrl` is a function so a gateway host provisioned after boot is picked up, as `serve-page:list` does at `:2529`). Handler next to `"outbox:list"` (`:2537`): `"artifacts:list": (opts) => artifacts.list(opts?.sessionId),`. Run `npm run test:server`. | WS07 merged |
| M-07-S2 | `src/server/boxCapabilities.mjs` (WS02, wave B) + `boxCapabilities.test.mjs` | IB (right after M-07-S1) | `BOX_CAPABILITIES` (WS02) | Append `"artifacts-list-1"`; extend the test's expected ids. No `version.mjs` edit (WS02 already returns the list). | WS02 SF-0 landed; M-07-S1 |
| M-07-D1 | `src/renderer/chatUtils.ts`, `src/renderer/chatUtils.test.ts` | IB (after WS02's chatUtils edits) | `planRefsFromPart` now in `src/server/artifacts.mjs` | Delete `PLAN_REF_RE`, `PLAN_AUTHORING_TOOLS`, `planRefsFromPart` (`chatUtils.ts:2638-2678`, keep the surrounding plan-card helpers); in the test file delete the `planRefsFromPart` import (`:169`) and its `describe` block (`:5671`). | WS07 desktop switch merged (no remaining caller) |
| M-07-D2 | `src/shared/types.ts` | IB | — | In the `IPC` map next to `outboxList` (`:1743`): `artifactsList: "artifacts:list", // ({sessionId}) → ArtifactsListResult`. | — |
| M-07-D3 | `src/shared/api.ts` | IB | `ArtifactsListResult` (`src/shared/artifactsTypes.ts`) | In `Api` next to `outboxList` (`:1530`): `artifactsList(opts: { sessionId: string }): Promise<ArtifactsListResult>;` + type import. | M-07-D2 |
| M-07-D4 | `src/renderer/api/httpApi.ts` | IB | IPC.artifactsList | Next to `outboxList` (`:1291`): `artifactsList: (opts) => rpc(IPC.artifactsList, opts),` — **`rpc`, not `rpcOptional`**: the panel must see the unknown-channel error to show "Update your box to use this". | M-07-D3 |
| M-07-D5 | `src/renderer/api/demoApi.ts` | IB | `demoArtifactsList` (WS07, `src/renderer/api/demoArtifacts.ts`) | Next to `outboxList` (`:482`): `const artifactsList = ({ sessionId }: { sessionId: string }) => Promise.resolve(demoArtifactsList(DEMO_STATE, sessionId, demoState));` and add `artifactsList` to the exported api object. | M-07-D3 |

WS07's own desktop/server files (`artifacts.mjs`, `artifactsTypes.ts`,
`ArtifactsPanel.tsx`, `artifacts.ts`, `MediaBody.tsx`, tests) are edited by the
WS07 worker; until IB applies M-07-D2…D4 the worker verifies with those rows
applied locally in its worktree and lists them in its manifest (it does not
commit them).

WS02's receipt rows M-07-1 / M-07-2 match the text above verbatim (pass
`composer`, no `onAttach`, no external hint; deferred jump kept).

## Mounts applied by this workstream (D18: all `ChatOverflowSheet` mounts → WS07, wave B)

Every new parameter is optional / defaulted so `ChatOverflowCaptureScene.swift:29-43`
(unowned; never edited) and ChatScreen compile before their wiring lands, and a
missing closure hides its row (no dead controls). Line refs are
`ChatOverflowSheet.swift` today: first section `:91-100`, Compact `:102-109`,
Fork `:110`, Open terminal `:111`, Trust/handoff `:116-135`, Clear/Delete `:142-148`.

| ID | Requested by | Provider symbol(s) | Exact change in `ChatOverflowSheet.swift` | Prerequisite |
|---|---|---|---|---|
| M-01-5 | `01-transcript.md` M-01-5 | `TranscriptDisplayOptions.defaultsKey`, `TranscriptDisplayOptions.setShowDetails(_:)` (WS01, A1) | In the Trust-mode `Section`, after the trust toggle: `Toggle` "Show reasoning & full output", subtitle "Thinking steps and complete tool output", bound with `@AppStorage(TranscriptDisplayOptions.defaultsKey) private var showDetails = false` and `Binding(get: { showDetails }, set: { TranscriptDisplayOptions.setShowDetails($0) })`. No new parameter. Shown also when `isReadOnlyJob` (display-only). | WS01 merged (A1) |
| M-02-2 | `02-chat-cards-queue.md` M-02-2 | — (plain param; ChatScreen passes `store.isBackgroundJobReadOnly`) | Add `var isReadOnlyJob: Bool = false`; when true hide Compact, Clear, Fork, Delete and the Trust-mode toggle; also hide Rename (M-04-1) and the Mode rows (M-04-2, falling back to nothing — a read-only job cannot switch mode). Scheduled / Secrets / Artifacts / Webhooks / Background jobs rows and the M-01-5 toggle stay. | none |
| M-04-1 | `04-sessions.md` M-04-1 | — (ChatScreen wires it, M-04-4) | Add `var onRename: (() -> Void)? = nil`; row "Rename session" (`pencil`) in the second section, **before "Compact session"** (WS04's current text), via the existing `row(...)` helper; shown only when `onRename != nil && !isReadOnlyJob`. Optional by agreement with WS04 (its §14 preamble adopts this capture-safe default). | none |
| M-04-2 | `04-sessions.md` M-04-2 / master ledger row M-04-2 | `SessionModeRows(current:launchers:catalog:onSelect:onRetry:)` (WS04, `SessionModeMenu.swift:31-71` — emits TWO top-level Sections, "Mode" and conditionally "AI CLI", whose failed state shows a "Couldn't load AI CLIs — Try again" button calling `onRetry()`), `SessionMode`, `SessionLauncherCatalog` (WS04, A2); `AvailableLauncher` (WS10, D21, A1) | Add `var mode: SessionMode? = nil`, `var launchers: [AvailableLauncher] = []`, `var launcherCatalog: SessionLauncherCatalog = .loading`, `var onSelectMode: ((SessionMode) -> Void)? = nil`, `var onRetryLaunchers: (() -> Void)? = nil`. Placement per master M-04-2 / `reviews/code/04-sessions.md` finding 11 — a **sibling** of the Compact/Fork section and the Trust section, never nested in a `Section {}`; the mode rows are mounted only when ALL THREE of `mode`, `onSelectMode`, `onRetryLaunchers` are present (so the failed-catalog "Try again" is never a dead button). Exact code (rename row from M-04-1, read-only gates from M-02-2 included): `Section { if !isReadOnlyJob, let onRename { row("Rename session", systemImage: "pencil", action: onRename) }; if !isReadOnlyJob { compactButton; row("Fork session", systemImage: "arrow.triangle.branch", action: onFork) }; if !isReadOnlyJob, !modeRowsMounted { row("Open terminal", systemImage: "terminal", action: onOpenTerminal) } }` then `if !isReadOnlyJob, let mode, let onSelectMode, let onRetryLaunchers { SessionModeRows(current: mode, launchers: launchers, catalog: launcherCatalog, onSelect: { m in dismiss(); onSelectMode(m) }, onRetry: onRetryLaunchers) }` then the existing Trust section, with `private var modeRowsMounted: Bool { OverflowModeRowsGate.mount(hasMode: mode != nil, hasSelect: onSelectMode != nil, hasRetry: onRetryLaunchers != nil, readOnly: isReadOnlyJob) }` — `OverflowModeRowsGate` is a file-scope enum next to `CompactConfirmGate` (`ChatOverflowSheet.swift:382-387`), with `showsOpenTerminal(…)` as its complement. Behaviour: legacy callers / the capture scene (no new params) keep "Open terminal" exactly as today; a read-only job shows neither (M-02-2); WS02's M-04-5 passes all three, so the wired chat always gets the mode rows. Verification: Xcode-only `MantaUITests/ChatOverflowGateTests.swift` — `OverflowModeRowsGate.mount` is true only for (mode, select, retry, !readOnly); `showsOpenTerminal` true for every legacy combination (any of the three missing, not read-only) and false when read-only; plus a Mac check that the failed-catalog row's "Try again" invokes the passed closure (counter in a `#Preview` with `launcherCatalog: .failed(message: "x", lastGood: nil)`). | WS04 (A2) + WS10 (A1) merged |
| (own) | WS07 F7 | `WebhooksCard` | Add `var onWebhooks: (() -> Void)? = nil` and the "Webhooks" row (first section, after Secrets) when non-nil. | — |

Cross-check (`grep -n ChatOverflowSheet` over `01`–`10` at round 2): the only
requests into this file are M-01-5, M-02-2, M-04-1, M-04-2 — each matched above
with the provider's current symbols and defaults. WS03/05/06/08/09/10 request
none. Package.swift requests from other workstreams are applied by the
integration agent of THEIR wave (M-01-6, M-03-8, M-04-8, M-08-3, M-10-3 → IA;
M-02-3, M-06-3, M-07-4, M-09-7 → IB; M-05-4 → IC), not by WS07.

**Also applied by WS07 in wave B (master ledger M-07-pkg-1, D27):** root
`package.json` / `package-lock.json` — `npm install lru-cache@11.5.3` (see
Files); and `src/server/media.mjs` + `media.test.mjs` (shared MIME table).

## Contracts provided / consumed

- **Server-first provided (D23/D24):** `artifacts:list` (`src/server/artifacts.mjs`),
  capability id `artifacts-list-1` (appended to `boxCapabilities.mjs` in wave B,
  M-07-S2).
- **Server symbol provided to WS11 (D10):** `planRefsFromPart(part)` exported
  from `src/server/artifacts.mjs` — the ONE implementation once M-07-D1 deletes
  the renderer copy; WS11's plan-question decorator imports it.

- **C1 provided:** `MantaAPIClient+Artifacts.swift` (see Client members). Wire
  types live in `ArtifactModels.swift` / `WebhookModels.swift`.
- **C2 consumed:** `MantaNavigator.open(.message(sessionID:messageID:))`,
  called from ChatScreen's flush (M-07-1); WS02 owns handling.
- **C3 consumed:** `ComposerTextController.attach(remotePath:displayName:mime:) -> Bool`,
  `ComposerTextController.acceptsInput`, `ComposerTextController.lastAttachRejection`
  and `ComposerInsertion.AttachRejection` (WS03), used inside `ArtifactsCard` on
  the instance passed by M-07-1; every `false` result is surfaced by the card.
- **Launcher types consumed (M-04-2 only):** `SessionModeRows`, `SessionMode`,
  `SessionLauncherCatalog` (WS04) and `AvailableLauncher` (WS10, D21).
- **C4:** M-07-1, M-07-2 (ChatScreen, applied by WS02 per D18).
- **C5:** not used — `agentFile` is a bus kind (no `sub`), observed through
  the existing `addRawFrameHandler`; `MantaStreamModels.swift` /
  `MantaEventStore.swift` are not edited.
- **C6:** not used. **C7:** tests above (package-safe vs Xcode-only split).
- **D9:** secrets default scope = shared; agent-file notice always shown.
- **Existing helpers consumed:** `SessionHaptics.fire(_:enabled:)` and
  `SessionListStore.hapticsEnabled` (WS04 files, read-only use). (No
  `PlanDerivation` use since the server-first revision — reconciled.)

## Deferred

- **Desktop "Download"** action on artifacts — iOS keeps Share (long-press);
  Save-to-Files from the card is an easy follow-up reusing the F6 exporter, but
  not in the gap list.
- **Plan status other than "draft"** and **"Open implementing session"** —
  the desktop has no plan→job link either (always draft, action omitted).
- **Review mode** in the artifacts panel — owned by WS05.
- **Secrets inline edit / search / "Manage all in Settings"** — not in this
  workstream's scope.
- **Agent-file notice while the app is backgrounded/disconnected** — the box
  marks a file announced when it publishes, whether or not any client hears
  it; a push or catch-up path needs a server change and is out of scope. The
  file remains in the Artifacts card.
- **Notice drawn above modals** — would need a window-level host outside every
  workstream's files; the notice waits instead (F6 "Modal behaviour").
- **Live webhook list refresh on `webhook.updated`** — desktop is
  refetch-driven; iOS matches.

## Open questions

None remaining: both round-0 questions are decided by D9 (secrets default
scope = shared; agent-file notice always shown).

## Review responses (round 1)

Own review (`reviews/round1/07-artifacts-cards.md`):

1. **BLOCKING F4 byte resolution — resolved.** Added "Byte resolution" in F4:
   pure `ArtifactByteSource.classify` with data URI / remote http(s) / box path
   / unsupported branches; remote fetched through a separate ephemeral
   `URLSession` with no `Authorization` header and no cookies, 2xx required;
   used by preview, Share and Attach. Classifier tests in
   `ArtifactPresentationTests`, header-absence test in `ArtifactAPITests`,
   remote-image acceptance case added.
2. **BLOCKING F6 async lifecycle — resolved.** Replaced the store sketch with a
   pure `AgentFileNoticeMachine`: per-notice token + per-operation opID
   captured by every download, presentation callback and saved timer; arrivals
   during an in-flight operation are queued ("+N more"), not swapped in;
   `begin` refuses re-entry; dismiss during download allowed (late completion
   only deletes its temp file); dismiss disabled while the picker/sheet is up.
   Deterministic sequence tests (A-starts/B-arrives/A-finishes, old picker
   completion, old timer, dismiss-during-download, …) plus Xcode-only store
   tests with an injected suspending downloader.
3. **BLOCKING tests vs Package.swift — resolved.** API request tests moved to
   Xcode-only `ArtifactAPITests.swift`; MainActor store tests in Xcode-only
   `ArtifactAgentFileStoreTests.swift`; the pure machine/decoding lives in
   `ArtifactAgentFileModel.swift` and is package-tested. M-07-4 lists exactly
   which files go into the package and which must not; the ambiguous
   "#if canImport(UIKit)-free" instruction is removed.
4. **SHOULD Open plan file failure — resolved.** Staging now returns
   `Result<URL, ArtifactStagingError>`; every preview/staging failure
   (files, images, plan files, malformed data URIs, remote errors) sets the
   inline banner with a specific message; card stays open; retry by tapping
   again. Acceptance case for a vanished plan file added.
5. **SHOULD haptics — resolved.** Both new haptics go through
   `SessionHaptics.fire(_:enabled: SessionListStore.hapticsEnabled)`; the
   on-screen confirmations remain. Acceptance case with Haptics off added.
6. **SHOULD global visibility — resolved by narrowing.** Specified modal
   behaviour: the overlay is visible over the list and pushed chats (both inside
   `SessionListView`'s `NavigationStack(path:)`, `SessionListView.swift:75,134`);
   under Settings / sheets the event is retained and the notice appears,
   actionable, when the modal closes. Exporter/share sheet presented in UIKit
   from the top-most view controller to avoid colliding with the list's own
   SwiftUI presentations. Acceptance text narrowed; arrival-under-modal case
   added.

Cross-cutting review (`reviews/round1/00-cross-cutting.md`):

- **#7 (wave-B shared-file edits)** — `MantaAppRoot.swift` mount is now M-07-3,
  applied by integration agent B (D18), not by WS07.
- **#8 (bidirectional mount ledger)** — "Mount requests" is a D18 table with
  appliers and prerequisites; "Mounts applied by this workstream" accepts WS01
  M4, WS02 M3 and WS04 §14 (a)/(b) on `ChatOverflowSheet.swift`, cross-checked
  against those specs. The artifacts/webhooks ChatScreen callbacks are M-07-1/2
  for WS02.
- **#10 (Package.swift / pbxproj schedule)** — Package edits go through
  M-07-4 for integration agent B; WS07 does not pre-add other waves' files;
  pbxproj is left to the orchestrator.
- **C3 change** — `attach` now returns `Bool`; the card surfaces `false`.
- **D16** — Client members table added; no duplicates.

## Review responses (round2)

Own review (`reviews/round2/07-artifacts-cards.md`):

1. **BLOCKING M-04-2 superseded launcher API — resolved.** "Mounts applied"
   row M-04-2 now uses WS04's current text: `mode: SessionMode? = nil`,
   `launchers: [AvailableLauncher] = []`, `launcherCatalog:
   SessionLauncherCatalog = .loading`, optional `onSelectMode` /
   `onRetryLaunchers`, and the full `SessionModeRows(current:launchers:catalog:onSelect:onRetry:)`
   call, rendered only when mode + select closure are present (mode unwrapped
   first); otherwise the existing "Open terminal" row stays. WS10 (A1) added to
   prerequisites. Old `SessionLauncher` / 3-argument initializer removed.
2. **BLOCKING M-07-1 vs WS02 receipt — resolved on the provider side.** M-07-1
   now spells the exact initializer, states that no `onAttach` parameter
   exists, that ChatScreen adds no attach hint, and that the card closes only
   after a successful attach; the deferred jump is kept. Added an explicit
   "receiver-side sync" note naming WS02's stale row (`02-chat-cards-queue.md:832`);
   that file is not editable from this spec.
3. **SHOULD temp-file cleanup — resolved.** `.saved` now carries `fileURL`;
   `savedTimerFired` and `dismiss` return `AgentFileEffect`;
   `presentationFinished` takes the `fileURL` captured by its per-presentation
   delegate, so stale/duplicate callbacks clean their own file. One ownership
   rule states which path deletes each file. Machine tests 2/3/3b/3c/3d/8
   assert the exact `.deleteTemp(u)`; the Xcode store test asserts the file is
   actually gone after save+timer, save+dismiss, exporter cancel, share
   complete/cancel, stale presentation and stale download. Acceptance case
   added.
4. **SHOULD Attach in read-only jobs — resolved.** Attach is gated on
   `composer.acceptsInput` (observed live via `ArtifactAttachMenuItem`), checked
   again before the download and again after the upload; a mid-flight change
   reports "This chat is read-only." Rejections use WS03's
   `lastAttachRejection` copy. `canAttach` gains `acceptsInput`; tests and a
   read-only-job acceptance case added. Prerequisite M-03-7 (WS02) listed on
   M-07-1.
5. **NIT IDs / placement — resolved.** Received rows use canonical IDs M-01-5,
   M-02-2, M-04-1, M-04-2. Rename placement is "before Compact session" and
   optional, matching WS04's current M-04-1 text (WS04 adopted the
   capture-safe default). Cross-check paragraph rewritten against the
   round-2 ledger.

Cross-cutting (`reviews/round2/00-cross-cutting.md`):

- **#1 (launcher API)** — WS07's part is the M-04-2 receipt, fixed as above
  with WS10's `AvailableLauncher` (D21).
- **#8 (M-07-1 receipt)** — provider text pinned as above; WS02 must update its
  row.
- **#10 (ledger integrity)** — both tables now use ledger IDs/appliers
  (M-07-1/2 → WS02, M-07-3/4 → IB; received M-01-5, M-02-2, M-04-1, M-04-2).
- **Ledger M-07-4** — prerequisite on WS03's `ComposerInsertion.swift` (M-03-8)
  recorded, since `ArtifactPresentationTests` now uses its `AttachRejection`.

## Review responses (server-first)

Applied `_serverfirst-revise-brief.md` against `server-first-audit.md` §WS07
and master D23/D24.

- **Folded MOVE-NOW items A1, A2, A3, A5** into a new "Server-first (D23/D24)"
  section: new module `src/server/artifacts.mjs` (pure derivation ported from
  `src/renderer/artifacts.ts` + `planRefsFromPart` from `chatUtils.ts`, plus a
  memoized service) and channel `artifacts:list` with the full request /
  response JSON, `expiry.state` computed at response time, `plan {status,
  steps, pageUrl, fileAvailable}`, `counts`, `degraded`, safe-literal errors,
  and node tests `src/server/artifacts.test.mjs`. Two deliberate refinements:
  plan `href` uses the opencode session directory; plan `pageUrl` fallback uses
  the box's `publicBaseUrl()` instead of each client's server URL.
- **iOS rewritten to render**: F1/F3/F5 wire + design now read server fields;
  `ArtifactDerivation.swift` and its tests are deleted (not extended);
  KEEP-CLIENT helpers (day grouping, search, eligibility, byte routing,
  staging, attach copy, expiry LABEL) move to `ArtifactPresentation.swift`;
  `ArtifactOutboxRow` / `listOutboxRows` withdrawn; new client member
  `artifactsList(sessionId:)`; decode tests in `ArtifactWireTests.swift`.
  `PlanDerivation.swift` is no longer used by WS07.
- **Desktop migration in the same change**: `ArtifactsPanel.tsx` consumes
  `artifacts:list` (open / 30 s poll / debounced on transcript change);
  derivation functions deleted from `artifacts.ts` (only `groupByDay` and the
  re-exported wire type remain); `planRefsFromPart` deleted from `chatUtils.ts`;
  `MediaBody.tsx` literal adapted; new `src/shared/artifactsTypes.ts`,
  `src/renderer/api/demoArtifacts.ts`, `ArtifactsPanel.server.test.tsx`;
  derivation vitests removed (now node tests).
- *(Historical — superseded by the Reconciliation bullet below and by D25:
  the id is `artifacts-list-1`, appended in wave B by IB.)* **Wire compat
  (D24)**: additive new channel only; both clients gate on the box's
  `unknown rpc channel: artifacts:list` error and show "Update your box to use
  this." — no fallback derivation.
- **Ledger**: new rows M-07-S1 (`rpc.mjs`, IB, order 02 → 07 → 09 → 06),
  M-07-S2 (*historical text "capability id → WS11 U5" is superseded: M-07-S2
  appends `artifacts-list-1` to `boxCapabilities.mjs`, IB, wave B*), M-07-D1…D5 (`chatUtils.ts`/test,
  `types.ts`, `api.ts`, `httpApi.ts`, `demoApi.ts`, IB). M-07-4 now removes
  the deleted Swift files from `Package.swift` and adds the new ones.
  `index.mjs` and `streamInterp.mjs` are not touched.
- **Reconciliation (master "Reconciliation log (server-first)"):** id renamed
  `artifacts-list-1` and appended in wave B by IB (M-07-S2 now targets
  `boxCapabilities.mjs`, not WS11); stale `PlanDerivation` consumption line
  removed; `planRefsFromPart` in `artifacts.mjs` is the symbol WS11 D10
  imports; the shared desktop files of M-07-D1…D5 are WS02-owned in wave B
  (D27) — IB applies WS07's rows after WS02's commit.
- **Rejected audit items for WS07:** none. KEEP-CLIENT rows A4, A6–A10, A11a,
  A12 stay client as the audit recommends; A11b is MOVE-LATER (WS11).
- Everything else (F4 attach, F6 agent-file notice, F7 webhooks, F7b secrets,
  overflow mounts) is unchanged.

## Review responses (server-first review)

Round: `reviews/server-first/07-artifacts-cards.md`.

1. **BLOCKING published-page resolution — resolved.** New pure
   `planPageResolution` distinguishes owned registration / collision / no
   registration: a collision yields `pageUrl:null` +
   `pageUrlReason:"other-session"` and never the deterministic fallback; an
   owned row with an empty or non-http URL yields `null` +
   `"no-public-address"`; the fallback is used only with no registration and a
   usable base. Hosted pages with no usable URL are omitted and reported via
   `degraded: ["public-address"]` with explicit footnote copy on both clients.
   Node tests 10–11, iOS wire test 5, desktop plan/footnote assertions added.
2. **BLOCKING omitted typed consumer — resolved.** `ArtifactPreview.test.tsx`
   added to the migration table and Files; its fixture and the retained
   `groupByDay` builders in `artifacts.test.ts` migrate to the wire shape; the
   preview action tests and day-grouping tests are kept under typecheck.
3. **BLOCKING M-04-2 receipt — resolved.** Receipt rewritten with the sibling-
   Section placement and exact code from code-review finding 11, and the mode
   rows now mount only when `onRetryLaunchers` is also present (otherwise
   "Open terminal" stays), so the failed-catalog "Try again" can never be dead.
   Read-only and legacy behaviour preserved; gate extracted as
   `OverflowModeRowsGate` with `ChatOverflowGateTests`. **Master edited**
   (minimal): `00-master.md` ledger row M-04-2 — mount condition and
   Open-terminal condition now include `onRetryLaunchers`. WS02's M-04-5 already
   passes it, so no other row changes.
4. **SHOULD memoization key — resolved.** Key now includes `baseUrl()`, full
   page fields (`url`, `createdAt`, `expiresAt`, `sessionID`) for the session's
   and the plan subdomain's rows, outbox `size`/`expiresAt`/`messageID`, a hash
   of the last message's parts, and which optional reads failed. `degraded` is
   computed per request; cache age is since derivation; the only deliberate
   staleness (≤ 30 s) is an edit to a non-final message. Fake-clock tests added
   (case 8).
5. **NIT superseded statements — resolved.** Header now states the one new
   channel and capability id `artifacts-list-1`; the "no node tests" line is
   replaced by the real verification requirements; the earlier server-first
   bullets naming `artifacts.list` / WS11 are marked historical.
