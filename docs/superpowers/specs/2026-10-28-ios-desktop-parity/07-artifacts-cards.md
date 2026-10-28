# WS07 — Artifacts, agent-sent files, webhooks, shared secrets

Status: draft · Wave B · Owner files: `SessionResourceCards.swift`,
`ArtifactDerivation.swift`, `ChatOverflowSheet.swift`, new `Artifact*` /
`Webhook*` files. Binding rules: `00-master.md` (C1–C7, ownership, waves).

**No new server routes.** Every feature reuses a channel, route or bus event the
desktop already uses. No server file is edited.

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
- `ArtifactDerivation` (`MantaUI/ArtifactDerivation.swift`): a port of the
  desktop `deriveArtifacts`, **but** it lacks: the `plan` kind, `messageId`,
  link `context`, `isHosted`, the plan-page exclusion from Links, the outbox
  row's `messageID`, and the video extensions. Expiry is only shown when
  ≤ 48 h (`ArtifactFormat.ageOrExpiry`, `:282-293`) — the desktop always shows
  a pill on hosted pages and outbox files.
- `PlanDerivation` (`MantaUI/PlanDerivation.swift`, not owned by anyone; read
  only here): already ports `planRefsFromPart` (`:82`), `planSubdomain`
  (`:182`) and `planPageURL(sessionID:baseURL:)` (`:193`). **Reuse them.**
  Its `planMetrics` (`:162`) is the plan *card's* rule, NOT the desktop
  Plans-tab step rule — do not reuse it for F1.
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
Unchanged from today's card: `opencode:messages` (`api.messages`),
`serve-page:list` → `ServedPageMeta[]` (`src/server/rpc.mjs:2529`), and
`GET /api/peek?path=<abs>` (bearer) for "Open plan file". No new channel.

### iOS design
- `ArtifactKind` gains `.plan`. Segments become
  **Files · Images · Links · Plans** (keep the existing iOS order + default
  `.file`; append Plans). Label `"Plans \(count)"`.
- `Artifact` gains: `messageID: String?`, `context: String?`,
  `isHosted: Bool`, `dedupeKey: String`, `planStepCount: Int?`,
  `planStatus: ArtifactPlanStatus?` (`draft|approved|building|done`),
  `pageURL: String?`.
- `ArtifactDerivation.derive(messages:pages:sessionId:outbox:cwd:)` — `cwd:
  String? = nil` added; plan pass ported line-for-line from
  `artifacts.ts:365-380` using `PlanDerivation.planRefsFromPart` and
  `PlanDerivation.planSubdomain`. Dedupe switches from `href.lowercased()` to
  `dedupeKey` (desktop `key`) so a plan's key is its rel path, not the
  cwd-joined href.
- New `ArtifactDerivation.planTitle(fromPath:)` and
  `ArtifactDerivation.planStepCount(_ text: String?) -> Int` (desktop rule
  exactly; `0` when nil/empty).
- Plan row (in `ArtifactsCard`): `list.clipboard` glyph, title (middle-truncated),
  trailing status capsule (`draft` = `tokens.tx3` on fill; `approved` = warn;
  `building` = accent; `done` = ok), subline `"3 steps"` / `"1 step"` / `"plan"`.
  - Tap → open the published page: `ArtifactPlanLink.pageURL(artifact:sessionId:serverURL:)`
    (artifact `pageURL`, else `PlanDerivation.planPageURL(sessionID:baseURL: api.serverURL)`),
    `UIApplication.shared.open(url) { ok in … }`; `ok == false` or no URL →
    the card's inline error banner: **"Couldn't open the plan page."**
  - Context menu: **Open published page** · **Open plan file** (only when
    `cwd` is non-nil; stages via `/api/peek` then QuickLook, same path as files)
    · **Copy path**. No "implementing session" action (desktop renders none).
- Staging fix: `ArtifactsCard.tempURL(for:)` must take the extension from the
  **href's** last path segment when the label has none (a plan's label is a
  title, so `.md` would be lost and QuickLook would not recognise the file).
- Empty Plans tab: `ContentUnavailableView("No plans yet", systemImage:
  "list.clipboard", description: Text(ArtifactEmptyCopy.sub(.plan, counts)))`
  → "2 links, 0 images, 3 files". Apply the same per-tab copy to the other three
  tabs ("No links yet" / "No images yet" / "No files yet" + the other counts),
  replacing the single "No artifacts" state (keep its
  `accessibilityIdentifier("artifacts-empty")`).
- Inline error banner (shared by F1/F4): a dismissible red row at the top of
  the list (`Section` with the message + an `xmark` button,
  `accessibilityIdentifier("artifacts-error")`).

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
None (client-side filter over the derived list).

### iOS design
- `.searchable(text: $query, placement: .navigationBarDrawer(displayMode:
  .automatic), prompt: "Search links & files")` on the card's
  `NavigationStack` content.
- Pure `ArtifactSearch.filter(_ items: [Artifact], query: String) -> [Artifact]`
  (trimmed query; empty → unchanged) and
  `ArtifactSearch.counts(_ items:, query:) -> ArtifactCounts` (per-kind match
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
- `outbox:list` rows carry `messageID: string | null` (`src/shared/types.ts:2200-2210`,
  `src/server/outbox.mjs:113-145`). The iOS `OutboxFile` drops it; WS07 adds
  its own wire type (below) instead of editing `MantaModels.swift`.
- Navigation: C2 `MantaRoute.message(sessionID:messageID:)` (handled by WS02).

### iOS design
- New wire type `ArtifactOutboxRow` (in `ArtifactModels.swift`):
  `path, name, size, sessionID?, mtime?, expiresAt?, messageID?, media?` (all
  optional except `path`/`name`/`size`, matching `statRow`). Convenience
  `init(_ file: OutboxFile)` (messageID nil) so existing tests adapt.
- C1: `MantaAPIClient+Artifacts.swift` adds
  `func listOutboxRows(sessionId: String) async throws -> [ArtifactOutboxRow]`
  → `call("outbox:list", args: [sessionId], …) ?? []`. The card uses it
  instead of `listOutbox`.
- Derivation fills `messageID` for all sources as above, including the
  page's newest-announcing-assistant-message rule and the link/page `context`
  (whitespace collapsed, trimmed, URL's first occurrence removed for links,
  hard-capped at 160 characters — `artifacts.ts:42-50`, `:294`).
- `ArtifactsCard` gains `var onJumpToMessage: ((String) -> Void)? = nil`.
  - Context menu item **Jump to message** (`arrow.turn.down.right`) on every
    row kind, rendered **only** when `onJumpToMessage != nil &&
    artifact.messageID != nil` (`ArtifactActions.canJump`).
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
- C3: `ComposerTextController.attach(remotePath:displayName:mime:)` (WS03).

### iOS design
- `ArtifactsCard` gains `var projectName: String? = nil` and
  `var onAttach: ((ArtifactAttachment) -> Void)? = nil`, where
  `struct ArtifactAttachment: Equatable, Sendable { remotePath, displayName, mime: String? }`.
- Context menu **Attach to message** (`paperclip`) on `.file`/`.image` rows
  only, rendered only when `onAttach != nil && projectName != nil`
  (`ArtifactActions.canAttach`).
- Flow (row spinner while running; same `staging` set):
  1. Bytes: reuse `stagedFiles[id]` if present, else `stage(artifact)` (data
     URI decode or `/api/peek`).
  2. Upload a fresh copy: `api.upload(project: projectName, filename:
     ArtifactAttach.filename(for: artifact), data:)` — a fresh copy is used (as
     on desktop) because the original may be an old upload or an outbox file
     that the box sweeps before the message is sent.
  3. `onAttach(ArtifactAttachment(remotePath:, displayName: label, mime:))`.
     ChatScreen calls C3 `attach(...)` and closes the card — the new chip in the
     composer is the visible success.
- Failure (staging nil, upload throws) → the inline error banner:
  **"Couldn't attach <name> — it may no longer be on the box."** The card stays
  open.
- `ArtifactAttach.filename(for:)`: label if it has an extension, else label +
  extension from href (plans never reach here).

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
`ServedPageMeta.expiresAt` (ms, nullable), outbox `expiresAt` (ms, nullable).
Already decoded.

### iOS design
- Pure `ArtifactExpiry`:
  - `state(expiresAt: Date?, now: Date) -> ArtifactExpiryState?` (`.live`,
    `.soon`, `.expired`; 6 h threshold, desktop rule).
  - `label(_ artifact: Artifact, now: Date) -> String?`:
    hosted + nil expiry → `"no expiry"`; expired → `"expired"`;
    remaining < 48 h → `"expires in \(max(1, floor(h)))h"`;
    else `"expires in \(floor(d))d"`; non-hosted with nil expiry → nil.
    (Behavioural parity with the desktop pill; the day form replaces the
    desktop's unreadable "167h".)
- Row: trailing capsule with that label, tone ok / warn / danger
  (`Theme.swift` tokens), only for hosted pages and outbox files.
  Expired rows: `.opacity(0.5)`, still tappable (desktop does not block).
- `ArtifactFormat.secondaryLine` stops appending expiry
  (`ageOrExpiry` → plain `relativeAge`); the pill owns expiry.
  Update/replace `ageOrExpiry` accordingly (delete it if unused).

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
- `ArtifactModels.swift` (pure): `AgentFileEvent` +
  `static func from(_ frame: MantaStreamFrame) -> AgentFileEvent?` (kind
  check + `decodedPayload`), and `AgentFileNoticeCopy`:
  - `title(event)` → `"report.pdf"`;
  - `detail(event, sessionTitle: String?)` → `"62 KB · AI sent you a file"`
    (size omitted when 0), plus `" · in <sessionTitle>"` when resolved;
  - `savedTitle(event)` → `"Saved report.pdf"`;
  - `failure(event)` → `"Couldn't download report.pdf — it's still on the box, try again."`
- `ArtifactAgentFileStore` (new file `ArtifactAgentFile.swift`, `@MainActor
  final class … : ObservableObject`, no singleton):
  - `@Published private(set) var current: AgentFileEvent?`, `phase:
    .idle | .staging(.save|.share) | .saved | .failed(String)`.
  - `func bind(eventStore: MantaEventStore)` — idempotent (a `bound` flag);
    registers `addRawFrameHandler { [weak self] in self?.receive($0) }`.
  - `receive` → newest replaces current, phase `.idle`.
  - `func stage() async -> URL?` → `downloadOutboxFile`, writes to
    `tmp/manta-agentfile/<UUID>/<name>` (real filename for Files / share
    sheet); failure → `.failed(copy)`.
  - `dismiss()`.
- `ArtifactAgentFileNotice` (new view, same file): a bottom floating card
  (system material, `Metrics` spacing, `Theme` tokens), `arrow.down.doc`
  glyph, title + detail, buttons **Save**, **Share**, and an `xmark`
  dismiss (`accessibilityLabel("Dismiss")`). Owns `@StateObject` store;
  `.task { store.bind(eventStore: eventStore) }` (`@EnvironmentObject
  MantaEventStore`, `@EnvironmentObject SessionListStore` to resolve
  `sessionTitle` = window name whose `opencodeSessionId == sessionID`).
  - **Save** → stage (button shows `ProgressView`, label "Saving…") → present
    `ArtifactDocumentExporter` (a `UIDocumentPickerViewController(forExporting:
    [url], asCopy: true)` representable). `didPickDocumentsAt` → phase
    `.saved`, notice shows **"Saved report.pdf"** for 2 s then dismisses;
    cancel → back to `.idle` (notice stays). Stage failure → `.failed`: the
    detail line becomes the failure copy in the danger tone, buttons stay
    (retry is safe).
  - **Share** → stage → present `ArtifactShareSheet`
    (`UIActivityViewController` representable). Completion with
    `completed == true` → dismiss notice; cancel → stays.
  - No auto-dismiss while idle (desktop parity: it has actions).
  - `accessibilityIdentifier("agent-file-notice")`; announced to VoiceOver on
    arrival (`AccessibilityNotification.Announcement`).
  - Light haptic (`UINotificationFeedbackGenerator .success`) on Save success
    only.
- Mounted once, globally (see Mount requests) — the notice must appear on the
  session list and inside any chat, like the desktop's global toast.

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
    URL caption reads **"Copied"** for 1.5 s; light haptic. No URL → caption
    "No delivery URL" and the row is not tappable.
  - Context menu: **Copy delivery URL** (when url), **Revoke** (destructive).
  - Swipe trailing **Revoke** (destructive, `trash`) — swipe is the
    confirmation gesture, matching `SchedulesCard` and the desktop's
    no-confirm Revoke.
  - Revoke: optimistic removal → `deleteWebhook` → reload. Error → reload and
    show an inline red row "Couldn't revoke <label> — <message>".
- Overflow row **Webhooks** (`point.3.connected.trianglepath.dotted`) in the
  first section after Secrets; no count badge (desktop has none). Shown only
  when the new `var onWebhooks: (() -> Void)? = nil` is non-nil.

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

## Pure logic + tests (C7)

New/extended XCTest files (all pure, Foundation-only; add each to
`Package.swift` — see Mount requests):

`MantaUITests/ArtifactDerivationTests.swift` (extend; adapt existing outbox
tests via `ArtifactOutboxRow(OutboxFile)`):
1. plan from a user text part mentioning `.opencode/plans/2026-10-28-ship-it.md`
   → kind `.plan`, label "ship it", href `"/repo/.opencode/plans/…"` with `cwd:
   "/repo"`, `messageID` set, status `.draft`.
2. plan from a `write` tool part `state.input.filePath`; a `read` tool part
   yields nothing.
3. same plan in two messages → one artifact, newest `at`.
4. `planStepCount`: `"## A\n### B\n#### C\ntext"` → 2; nil/"" → 0.
5. plan `pageURL` set only when the page's `sessionID` matches; plan subdomain
   page is NOT emitted as a link; another page still is.
6. hosted page `messageID`/`context` from the newest assistant message
   containing the URL; user message containing it is ignored.
7. link `context` removes the URL, collapses whitespace, caps at 160.
8. outbox `messageID` carried through; `.mp4` → `video/mp4`, kind `.file`.
9. `ArtifactCounts` counts plans.
10. dedupe uses `dedupeKey` (plan rel path vs cwd-joined href).

`MantaUITests/ArtifactPresentationTests.swift` (new):
`ArtifactExpiry.state` (nil / expired / exactly 6 h → soon / 7 h → live);
`ArtifactExpiry.label` (hosted nil → "no expiry", 30 min → "expires in 1h",
5.9 h → "expires in 5h", 3.5 d → "expires in 3d", expired → "expired",
non-hosted nil → nil); `ArtifactSearch.filter` (label match, href match,
case-insensitive, whitespace-only query = all); `ArtifactSearch.counts`;
`ArtifactEmptyCopy.sub`; `ArtifactActions.canAttach/canJump/canOpenPlanFile`;
`ArtifactPlanLink.pageURL` (artifact URL wins, fallback deterministic, nil
when neither); `ArtifactAttach.filename`; temp-extension-from-href rule
(expose as `ArtifactStaging.fileExtension(label:href:)`).

`MantaUITests/ArtifactAgentFileTests.swift` (new): `AgentFileEvent.from`
decodes the exact desktop payload; maps `sessionName` → `sessionID`; ignores
`kind != "agentFile"`; nil on missing `remotePath`; empty name → basename;
copy strings (with/without size, with/without session title, failure, saved).
Store-level (MainActor, no network): `receive` newest-replaces-current and
resets phase.

`MantaUITests/WebhookTests.swift` (new): decode `WebhookMeta` full + nulls +
missing `provider`; `WebhookFormat.lastDelivery` never/`· 3×`;
`displayURL`; `MantaAPIClient.makeRequest(… channel: "webhook:list", args:
["ses_1"])` path `/rpc/webhook:list` + args; same for `webhook:delete`
`["ab12cd34"]`; `outbox:list` request via `listOutboxRows` channel name.

`MantaUITests/SecretScopeTests.swift` (new): shared input omits
`sessionID` (encode and inspect JSON); project/session include it; badges.

No server changes → no node tests. `npm run typecheck` / `npm test`
unaffected.

---

## Acceptance criteria

- [ ] Artifacts card shows four segments with counts; Plans lists every plan
      the transcript references, titled from the filename, with status and
      step count; the plan's own page never appears under Links.
- [ ] Tapping a plan opens its published page in the browser; a failure shows
      "Couldn't open the plan page." in the card. "Open plan file" previews the
      markdown in QuickLook (hidden when the session folder is unknown).
- [ ] Search filters the current segment by name or path, updates segment
      counts, and shows the system "No results for …" state.
- [ ] "Jump to message" appears only for artifacts with an owning message;
      choosing it closes the card and the chat scrolls to and highlights that
      message (via C2 `.message`).
- [ ] "Attach to message" appears only on files/images; it closes the card and
      a ready chip appears in the composer; a vanished file shows the inline
      error and the card stays open.
- [ ] Hosted pages always show an expiry capsule ("no expiry" when none);
      agent-sent files with a TTL show one; expired rows are dimmed.
- [ ] When the agent calls `send_file` with `notify:true`, a notice appears
      within ~3 s on whichever screen is open, naming the file, size and
      conversation; Save opens "Save to Files" and confirms "Saved <name>";
      Share opens the share sheet; a download failure says the file is still on
      the box and leaves the notice up; × dismisses. A file sent without
      `notify` produces no notice.
- [ ] Overflow shows "Webhooks"; the card lists this session's hooks with
      unsigned badge, delivery URL (tap copies, shows "Copied"), last delivery
      or "never fired"; swipe/menu Revoke removes it and a failure is reported.
- [ ] New secret form defaults to "Shared — every session"; saving a shared
      secret sends no session id and it appears in the list labelled
      `shared`; project secrets read `project:<name>`.
- [ ] No control is shown that cannot act (every new action is hidden when its
      closure/input is missing).
- [ ] `ios-mantaui` `test-unit` green; `Package.swift` view builds with
      `./verify.sh`.

---

## Files

Edit (owned):
- `mobile/native/MantaUI/ArtifactDerivation.swift` — plan kind, new fields,
  `cwd`, `ArtifactOutboxRow` input, dedupe key, video MIME, presentation
  helpers (`ArtifactExpiry`, `ArtifactSearch`, `ArtifactEmptyCopy`,
  `ArtifactActions`, `ArtifactPlanLink`, `ArtifactAttach`, `ArtifactStaging`).
- `mobile/native/MantaUI/SessionResourceCards.swift` — `ArtifactsCard`
  (Plans, search, jump, attach, expiry, error banner, per-tab empty states,
  `listOutboxRows`), `SecretsCard`/`SecretAddForm` (shared scope, badge,
  delete error).
- `mobile/native/MantaUI/ChatOverflowSheet.swift` — optional `onWebhooks` row.
- `mobile/native/MantaUITests/ArtifactDerivationTests.swift` — extend/adapt.

Create:
- `mobile/native/MantaUI/MantaAPIClient+Artifacts.swift` — `listOutboxRows`,
  `listWebhooks`, `deleteWebhook`.
- `mobile/native/MantaUI/ArtifactModels.swift` — `ArtifactOutboxRow`,
  `ArtifactAttachment`, `AgentFileEvent`, `AgentFileNoticeCopy` (pure).
- `mobile/native/MantaUI/ArtifactAgentFile.swift` — `ArtifactAgentFileStore`,
  `ArtifactAgentFileNotice`, `ArtifactDocumentExporter`, `ArtifactShareSheet`.
- `mobile/native/MantaUI/WebhookModels.swift` — `WebhookMeta`,
  `WebhookFormat`, `SecretScopeOption` (pure; the secrets helper lives here
  to stay inside the `Webhook*`/`Artifact*` prefixes).
- `mobile/native/MantaUI/WebhooksCard.swift`.
- `mobile/native/MantaUITests/ArtifactPresentationTests.swift`,
  `ArtifactAgentFileTests.swift`, `WebhookTests.swift`,
  `SecretScopeTests.swift`.

## Mount requests

In `ChatScreen.swift` (WS02, same wave B — WS02 applies; WS07's new params all
default to nil so either landing order compiles):
1. `destinationCard(.artifacts)`: pass
   `projectName: projectName`, `cwd: sessionWindow?.cwd`,
   `onAttach: { att in overflowDestination = nil; <C3 composer>.attach(remotePath: att.remotePath, displayName: att.displayName, mime: att.mime) }`,
   `onJumpToMessage: { mid in pendingArtifactJump = mid; overflowDestination = nil }`,
   and in the existing sheet `onDismiss` (`flushPendingPush`, `:632`) flush
   `pendingArtifactJump` into `navigator.open(.message(sessionID:
   store.sessionId, messageID: mid))`.
2. `OverflowDestination` gains `.webhooks`; `destinationCard(.webhooks)` →
   `WebhooksCard(sessionId: store.sessionId, onClose: { overflowDestination = nil })`;
   `overflowSheet` passes `onWebhooks: { overflowDestination = .webhooks }`.

In `MantaAppRoot.swift` (WS04, wave A — already landed, so WS07 applies it in
wave B, additive only):
3. On the paired destination (`SessionListView(...)` branch, `:98-109`) add
   `.overlay(alignment: .bottom) { ArtifactAgentFileNotice() }` — only when
   `paired && scene == nil`, under the existing `UpgradeScreen` overlay so the
   upgrade screen covers it.

In `mobile/native/Package.swift` (unowned; additive): append
`ArtifactModels.swift`, `WebhookModels.swift` to `sources` and
`ArtifactPresentationTests.swift`, `ArtifactAgentFileTests.swift`,
`WebhookTests.swift`, `SecretScopeTests.swift` to the test `sources` (ArtifactDerivation is already
listed). `ArtifactAgentFileTests` store cases that need `MantaEventStore` must
be `#if canImport(UIKit)`-free — keep them on `AgentFileEvent` only, or omit the
store case from the package view.

`project.yml` needs nothing (folder entry picks up new files); regenerate
`.pbxproj` via the `ios-regen-pbxproj` plugin.

## Contracts provided / consumed

- **C1 provided:** `MantaAPIClient+Artifacts.swift` (`listOutboxRows`,
  `listWebhooks`, `deleteWebhook`). Wire types live in `ArtifactModels.swift`
  / `WebhookModels.swift`.
- **C2 consumed:** `MantaNavigator.open(.message(sessionID:messageID:))`,
  called from ChatScreen's closure only (WS02 owns handling).
- **C3 consumed:** `ComposerTextController.attach(remotePath:displayName:mime:)`
  (WS03), called from ChatScreen's closure.
- **C4:** mounts listed above.
- **C5:** not used — `agentFile` is a bus kind, observed through the existing
  `addRawFrameHandler`; `MantaStreamModels.swift` / `MantaEventStore.swift`
  are not edited.
- **C6:** not used. **C7:** tests above.

## Deferred

- **Desktop "Download"** action on artifacts — iOS keeps Share (long-press);
  Save-to-Files from the card is an easy follow-up reusing
  `ArtifactDocumentExporter`, but not in the gap list.
- **Plan status other than "draft"** and **"Open implementing session"** —
  the desktop has no plan→job link either (always draft, action omitted).
- **Review mode** in the artifacts panel — owned by WS05.
- **Secrets inline edit / search / "Manage all in Settings"** — not in this
  workstream's scope.
- **Agent-file notice while the app is backgrounded/disconnected** — the box
  marks a file announced when it publishes, whether or not any client hears
  it; a push or catch-up path needs a server change and is out of scope. The
  file remains in the Artifacts card.
- **Live webhook list refresh on `webhook.updated`** — desktop is
  refetch-driven; iOS matches.

## Open questions

1. Secret scope default — desktop defaults to **shared**; on a phone a
   session-scoped default is arguably safer. *Default: shared (parity).*
2. Should the agent-file notice be suppressed for files belonging to the chat
   currently on screen? Desktop never suppresses. *Default: always show.*
