# P4 — OpenCode V1 Dependency Inventory

Complete inventory of everything in Manta that depends on OpenCode V1, plus the
update/compatibility machinery, to size a V2 migration master plan.

Method: `grep -rn` / `sed -n` / `wc` over the checkout at
`/home/dev/projects/manta-v2-plan` (read-only). Effort scale per item: **S**
≈ ≤½ day, **M** ≈ 1–2 days, **L** ≈ 3+ days / cross-cutting.

**Headline finding on blast radius:** the V1 wire contract is almost entirely
funnelled through two server modules — `src/server/opencode.mjs` (every HTTP
call) and `src/server/streamInterp.mjs` (the single event normaliser). The
**native iOS app consumes ONLY the interpreted stream** `streamInterp` emits
(`kind:"stream"` frames), so iOS is insulated from the raw-event rename; the
**desktop renderer consumes BOTH** raw opencode events (`onOpencodeEvent`) and
the interpreted stream. That asymmetry sets the migration shape: fix
`opencode.mjs` + `streamInterp.mjs` + the renderer's raw-event handler, and iOS
largely follows for free.

---

## 1. Server — files that call opencode over HTTP

All HTTP traffic goes to `http://127.0.0.1:4096` via `apiUrl()` + `ocFetch`/
`pooledOcRequest` in `opencode.mjs`. Other modules reach opencode **only** by
importing `opencode.mjs` (the `oc.*` namespace) — the single exception is
`providers.mjs`, which opens its own `fetch` to `/global/config`.

| File | Representative functions | V1 endpoints used | V2 replacement | Effort |
|---|---|---|---|---|
| `src/server/opencode.mjs` | `createSession`, `sendPrompt`, `listMessages`, `getMessage`, `abortSession`, `forkSession`, `compactSession`, `listSessions`, `getSessionStatus`/`listSessionStatuses`, `listPermissions`/`replyPermission`, `listQuestions`/`replyQuestion`/`rejectQuestion`, `getProviders`/`listModels`/`getDefaultModel`, `findFiles`, `listCommands`/`listAgents`/`listReferences`, `runCommand`, `getVcsBranch`, `subscribeEvents`/`openEventStream`, provider-auth (`startProviderOauth`/`setProviderApiKey`/…) | `/session`, `/session/{id}`, `/session?directory=`, `/session/{id}/prompt_async`, `/session/{id}/abort`, `/session/{id}/fork`, `/session/{id}/command`, `/session/{id}/message`, `/session/{id}/compact`, `/session/status`, `/event?directory=`, `/permission`, `/question`, `/provider`, `/provider/auth`, `/auth/{id}`, `/command`, `/agent`, `/find/file`, `/api/reference`, `/vcs` (noted dead) | Rebase onto `/api/*` + HTTP Basic auth. prompt_async → native steer/queue delivery; `/question` → `form.created`/forms; `/session/status` partly replaced by `/api/session/active`; event stream → renamed `session.text.delta`/`session.tool.*`/`session.execution.*`/`session.inbox.*`/`permission.*`/`form.created`/`shell.*`; typed `content[]` blocks replace parts | **L** |
| `src/server/providers.mjs` | `patchGlobalConfig`, `setProviders`, `setSubagents`, `removeConfigKeys`, `syncCacheTtl`/`readCacheTtl`, `setReferences` | `PATCH /global/config` (`http://127.0.0.1:4096/global/config`) | **No PATCH in V2** — config = file edit + `POST /api/location/reload`. Full rewrite of the write path (see §5) | **L** |
| `src/server/rpc.mjs` | handler map (`opencode:*` channels) delegating to `oc.*`; also `node:sqlite` fallbacks | via `oc.*` | Follows `opencode.mjs`; channel names stay, impls change | **M** |
| `src/server/index.mjs` | opencode event pump / bus republish; readiness gate; `installation.update-available` mapping | `/event` stream (via `subscribeEvents`) | Follows event-stream rename; pump rewires to V2 event names | **M** |
| `src/server/delegate.mjs` | background-job lifecycle: `newWindow` + `sendPrompt`; completion via `observeEvent` | via `oc.sendPrompt` + event stream (`message.part.updated`/`session.idle`/`session.status`/`session.error`) | Native steer/queue + renamed events | **M** |
| `src/server/appControl.mjs` | `compactSession`, `switchModel` (via `listModels`), list/rename | via `oc.*` | Follows `opencode.mjs` | **S** |
| `src/server/peers.mjs` | `listMessages`, `listPermissions`/`listQuestions`, `getVcsBranch`, `sendPrompt` | via `oc.*` | Follows; questions→forms | **S** |
| `src/server/messageSearch.mjs` | SQLite query over opencode store (`part`⋈`message`) | **direct DB** (see §4) + `oc` | New V2 DB schema | **M** |
| `src/server/modelLedger.mjs` | ledger read over `message`/`session`/`part` | **direct DB** + `oc.getProviders` | New V2 DB schema | **M** |
| `src/server/capNotifier.mjs`, `accounts.mjs`/`accountReaders.mjs`, `ctoMantaTools.mjs`, `ctoSessions.mjs`, `ctoContext.mjs`, `ctoSearchIndex.mjs`, `usageAdapters/{kimi,codex}.mjs`, `forge/index.mjs` | import `opencode.mjs` helpers (`listMessages`, `listSessions`, model lists) | via `oc.*` | Follows `opencode.mjs` | **S each** |

---

## 2. Event consumers — opencode event types per file

**V1 event names observed in the codebase** (the set that gets renamed in V2):
`session.idle`, `session.status`, `session.error`, `session.created`,
`session.deleted`, `session.compacted`, `session.compacting`,
`session.next.step.ended`, `session.next.agent.switched`,
`session.next.compaction.*`, `message.part.delta`, `message.part.updated`,
`message.part.removed`, `message.updated`, `message.removed`, `message.trim`,
`permission.asked`/`.replied`/`.rejected`, `question.asked`/`.replied`/
`.rejected`, `todo.updated`, `command.executed`, `vcs.branch.updated`,
`user.message.created`, `installation.update-available`. **No V2-only events
exist today** (`session.inbox.*`, `session.execution.*`, `form.created`,
`shell.*` — grep = 0).

### Server

| File | Event names consumed |
|---|---|
| `src/server/streamInterp.mjs` **(THE normaliser — iOS + desktop depend on its output)** | `message.part.delta`, `message.part.updated`, `message.updated`, `session.created`, `session.status`, `session.idle`, `session.error`, `session.next.step.ended`, `session.next.agent.switched`, `todo.updated`, `question.asked`/`.replied`/`.rejected`, `permission.asked`/`.replied`/`.rejected` |
| `src/server/push.mjs` | `permission.asked`, `question.asked`, `question.replied`/`.rejected`, `permission.replied`/`.rejected`, `session.error`, `session.idle`, `session.status` |
| `src/server/delegate.mjs` | `message.part.updated`, `session.error`, `session.idle`, `session.status` |
| `src/server/index.mjs` (bus) | `session.error`, `message.updated`, `session.deleted`, `permission.asked`, `session.compacting`, `installation.update-available`, `message.trim` |
| `src/server/serverUpdate.mjs` | `installation.update-available` (→ `serverUpdateAvailable`) |
| `src/server/ctoEvidence.mjs` | `message.part.updated`, `message.updated`, `permission.asked`, `session.created`, `session.deleted`, `session.error`, `session.idle`, `user.message.created` |
| `src/server/ctoSegments.mjs` | `session.created`, `session.deleted`, `session.error`, `session.idle`, `session.status` |
| `src/server/ctoAdmission.mjs` | `session.error`, `session.idle`, `session.status` |
| `src/server/ctoBackfill.mjs` | `session.idle`, `session.status`, `user.message.created` |
| (status.mjs / peers.mjs parse tmux panes, **not** opencode events) | — |

### Renderer (desktop)

| File | Event names consumed |
|---|---|
| `src/renderer/hooks/useSseBus.ts` **(primary raw-event handler, `onOpencodeEvent`)** | `message.part.updated`/`.delta`/`.removed`, `message.updated`/`.removed`, `session.idle`/`.status`/`.error`/`.compacted`, `session.next.step.ended`/`.agent.switched`/`.compaction.*`, `vcs.branch.updated`, `command.executed`, `permission.asked`/`.replied`; plus interpreted frames `todos`, `questions`, `optimizer.compacted` |
| `src/renderer/App.tsx` | `session.created`, `session.error`, `session.idle`, `session.status`, `question.asked`/`.replied`/`.rejected`, `permission.asked`/`.replied`/`.rejected` |
| `src/renderer/chatUtils.ts` | pure helpers over event payloads (`shouldDropEventForSessionFilter`, `registerChildSessionFromCreated`, `isToolStepBoundary`, `classifyFinish`) |

### iOS (`mobile/native/MantaUI`)

Consumes the **interpreted** `/events` stream only (`MantaEventStore.swift`,
`MantaStreamModels.swift`). Decodes manta frame payloads — `StreamFlushPayload`,
`StreamRunningPayload`, `StreamTurnCompletePayload`, `StreamTodosPayload`,
`StreamQuestionsPayload`, `StreamPermissionsPayload`, `StreamToolStarted/Output/
Ended`, `StreamSubagentPayload`, etc. Raw opencode event names appear only in
test fixtures (`capture-fixture/`, `MantaUITests`). **Net: iOS migrates when
`streamInterp.mjs` output is held stable; no iOS source rename needed if frame
shapes are preserved.** Effort **S** if frames unchanged, **M** if V2 forces
frame-shape changes (shell output, forms).

---

## 3. Message / part-shape consumers (V1 `parts` → V2 typed `content[]`)

V1 part shapes read across the renderer: `type === "tool"|"text"|"reasoning"|
"step-*"|"file"`, `state.status`, `state.metadata.output` (live bash tail),
`state.output`, and task-tool `state.metadata.sessionId`/`parentSessionId`.

| File | Approx V1-shape references |
|---|---|
| `src/renderer/chatUtils.ts` | ~25 (the bulk: `resolveToolOutput`, `extractSubagentInfo`, `collectChildSessionIds`, `computeContextBreakdown`, finish/truncation, flush-boundary helpers) |
| `src/renderer/ToolCall.tsx` | ~11 |
| `src/renderer/artifacts.ts` | 6 |
| `src/renderer/toolActivity.ts` | 6 |
| `src/renderer/ChatPanel.tsx` | 5 |
| `src/renderer/ToolBodies.tsx`, `TaskCard.tsx`, `CtoChat.tsx` | 2 each |
| `src/renderer/MessageRow.tsx`, `chatShared.tsx`, `ToolGroup.tsx`, `ArtifactPreview.tsx` | 1 each |
| `src/renderer/api/demoFixture.ts` / `demoApi.ts` | fixtures encoding V1 parts |

iOS part/content decoding lives in `MantaStreamModels.swift` + `ToolActivity.
swift`/`TranscriptComponents.swift`/`ArtifactDerivation.swift`, but keyed to
manta frame payloads, not raw opencode parts. **Effort: renderer part-shape
remap = L** (chatUtils is the long pole); iOS **S–M**.

---

## 4. Direct DB readers (`opencode.db` / `node:sqlite`)

`src/server/opencodeDb.mjs` is the shared handle (read-only). Direct readers:

| File | Tables / columns read |
|---|---|
| `src/server/opencodeDb.mjs` | `project_directory(project_id, directory)`, `session(project_id)` |
| `src/server/messageSearch.mjs` | `part` ⋈ `message` (FTS over message text) |
| `src/server/modelLedger.mjs` | `message`, `session`, `part` (tokens/cost ledger) |
| `src/server/optimizer/summary.mjs`, `optimizer/series.mjs` | opencode message ledger (via opencodeDb) |
| `src/server/ctoSearchIndex.mjs` | reads opencode `part`, `session`; writes its OWN `indexed_*`/`index_meta` tables (manta-owned, not opencode) |
| `src/server/ctoToolScan.mjs`, `ctoToolRegistry.mjs`, `ctoBackfill.mjs`, `ctoEngine.mjs`, `ctoContext.mjs`, `cto.mjs` | via opencodeDb helpers |

**Risk: V2 ships a new DB schema → every direct read breaks.** Preferred V2
posture: replace direct SQLite reads with V2 API reads where possible; otherwise
re-map table/column names. **Effort L** (schema-coupled, many CTO consumers).

---

## 5. Config writers

| Writer | Keys written | V1 mechanism | V2 shape |
|---|---|---|---|
| `providers.mjs` `setProviders` | `provider.<id>` blocks (endpoints, apiKey refs) | `PATCH /global/config` (upsert) / `removeConfigKeys` (delete + restart) | file edit + `POST /api/location/reload` |
| `providers.mjs` `setSubagents` / `subagentSync` (`src/shared/subagentSync.mjs`) | `agent.<name>` blocks | `PATCH /global/config` + delete path | file edit + reload |
| `providers.mjs` `syncCacheTtl` | `provider.<id>.models.<m>.options.cacheControl` (`ttl:"1h"` or key-absent=5m) | `PATCH /global/config`; removal via `removeConfigKeys` | file edit + reload |
| `providers.mjs` `setReferences` | `references` key | `PATCH` + `removeConfigKeys` | file edit + reload |
| `providers.mjs` `removeConfigKeys` | surgical jsonc-parser delete of any key | jsonc edit + **mandatory `restartOpencode()`** | V2: file edit + reload (no restart needed if reload re-reads) |
| `opencodeAdmin.mjs` `restartOpencode` | — | `systemctl --user restart opencode-serve` | may become unnecessary (reload endpoint); keep for binary swap |

**Effort L** — the whole write path inverts from PATCH-over-HTTP to
edit-file-then-reload; `removeConfigKeys`'s restart rationale disappears.

---

## 6. OpenCode tools + installed plugins

**Tools: 21 files in `docs/opencode-tools/*.ts`** (20 tools + shared
`manta-auth.ts`). **All 20 import `./manta-auth` and register via
`import { tool } from "@opencode-ai/plugin"`** — the V1 tool API. Context usage:

- `context.sessionID` — 18 tools (all but `resource-snapshot`, `manta-auth`)
- `context.directory` — 8 (`delegate`, `peers`, `plugins`, `resource-snapshot`, `schedule`, `secrets`, `webhook`, `manta-app`, `forge-rules`)
- `context.messageID` — 3 (`media`, `send-file`, `widget`)

**V2 breaks this entirely:** V1 plugins and `~/.config/opencode/tools/*.ts` do
NOT load — every tool must be rewritten as a V2 plugin. **Effort L** (20 tools ×
re-port + new `context` shape + new auth plumbing).

**Installed plugins:** `docs/opencode-plugins/*.ts` = `manta-accounts.ts`,
`manta-optimizer.ts` (+ tests). Installed by install.sh step **C2**
(`sync_opencode_plugins` → `~/.config/opencode/plugins/`) and refreshed by
self-update. **Also seeded:** `opencode-claude-auth@latest` into
`opencode.jsonc` `plugin[]` (install.sh step C). Both are V1-plugin-model →
re-port for V2.

---

## 7. Install / self-update / service definitions

**Install** (`scripts/install.sh`): downloads the opencode installer to
`$HOME/.opencode/bin/opencode` (step A), **version UNPINNED** (follows upstream);
seeds `opencode-claude-auth` plugin (C); copies `docs/opencode-tools/*.ts` →
`~/.config/opencode/tools/` (C); copies `docs/opencode-plugins/*.ts` →
`plugins/` (C2); appends `AGENTS.md` guidance; writes the two services (E).

**Self-update** (`scripts/self-update.sh`): runs **`opencode upgrade`**
(non-fatal), `refresh_opencode_tools()`, `sync_opencode_plugins`,
`sync_opencode_guidance`; conditional restarts of opencode-serve /
manta-server (`should_skip_self_update` in `scripts/lib/release.sh`).

**Services** (`scripts/systemd/opencode-serve.service` + launchd plist
templates): `ExecStart=opencode serve --port 4096 --hostname 127.0.0.1`;
`Environment=OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`;
`Environment=ANTHROPIC_CLI_VERSION=@@…@@` (resolved from box `claude --version`
via `resolve_anthropic_cli_version`, floor `manta_claude_cli_version_floor`;
patched in place by `ensure_opencode_cli_version`). Three supervisors must agree
(systemd unit, launchd plist, install.sh nohup fallback).

**What must change for V2:** the serve invocation / port / **HTTP Basic auth
password env** (new); `ANTHROPIC_CLI_VERSION`/claude-auth plugin fate under V2
auth; tool-copy step retargets to V2 plugin install; `/global/config`→reload
means `removeConfigKeys`' restart may drop. **Effort M–L.**

---

## 8. Update + compatibility flow (end-to-end)

- **Desktop auto-update** — `src/main/autoUpdate.ts` (electron-updater; feed
  `latest-mac.yml`); surfaced via `UpdateBar.tsx` / `TopBanners.tsx`.
- **Box update detect/apply** — `src/server/serverUpdate.mjs`
  (`createUpdateCheck`, `startServerUpdatePoller`, `createOpencodeUpdateForwarder`);
  apply runs `scripts/self-update.sh`; `release_is_current` /
  `should_skip_self_update` (`scripts/lib/release.sh`) decide by **git_sha**.
- **How desktop learns the box version:** `GET /api/version`
  (`src/server/version.mjs`) / `server:version` RPC. Desktop reads its own from
  `package.json`.
- **Compatibility matrix:** `src/shared/compatibility.mjs`
  (`DEFAULT_COMPATIBILITY_MATRIX`, single `supportedMajor`) → verdict
  `match`/`behind`/`incompatible`/`unknown`. Consumed by
  `src/renderer/hooks/useCompatibilityCard.ts`, surfaced in `App.tsx`
  (`compatibilityVariant`), prioritised by `src/renderer/bannerPriority.ts`
  (`pickBanner`).
- **On mismatch today:** `behind` → offer box self-update (`server:update-apply`
  → self-update.sh); `incompatible` (different major) → **blocking** aggregate
  banner (`incompatible` flag in `App.tsx:1582`, non-dismissible via
  `useCompatibilityCard` `showCard`).

**Reusable UI for a blocking "migrating your conversations" screen with a
progress bar:**
- `src/renderer/Onboarding.tsx` + `onboardingUi.tsx` — the existing
  **full-screen blocking modal** (pairing flow). `App.tsx:180` already swaps to
  this full-screen flow based on state; `relaunchOnboarding()` (App.tsx:564)
  forces it. This is the natural host for a one-way V2 migration gate.
- `src/renderer/UpdateBar.tsx`, `ReconnectingBanner.tsx`, `TopBanners.tsx`,
  `bannerPriority.ts` — banner/priority chrome; `ConfirmModal.tsx` / `Modal.tsx`
  for the confirm + progress dialog. A bump of `supportedMajor` turns an V2 box
  into `incompatible` for an old desktop → the existing blocking banner already
  fires; add a progress-bearing migration variant in the Onboarding full-screen
  flow. **Effort M** (reuse) — no new blocking-screen primitive needed.

---

## 9. Tests encoding V1 shapes (rewrite size)

| Suite | Files touching V1 event/part/endpoint/DB shapes |
|---|---|
| Server (`src/server/*.test.mjs`, 164 total) | **31** (incl. `streamInterp.test.mjs` = 58 cases, `opencode.test.mjs`, `push.test.mjs`, `delegate.test.mjs`, `providers.test.mjs`, `messageSearch`, `modelLedger`, optimizer) |
| Renderer (`src/renderer/*.test.ts(x)`, 119 total) | **2** primary (`chatUtils.test.ts` is the dense one — flush/finish/subagent/part helpers; `useSseBus.test.tsx`) |
| iOS (`mobile/native/MantaUITests`, 32 total) | **26** touch stream/frame/session/tool/plan (but frame-shaped; hold frames stable → minimal churn) |

**Effort: server test rewrite L** (streamInterp alone is 58 cases + opencode/
push/delegate); renderer **M**; iOS **S–M** if frames preserved.

---

## Summary table

| Area | Files | Effort | Risk |
|---|---|---|---|
| Server HTTP callers (`opencode.mjs` hub + importers) | `opencode.mjs` + ~15 importers | **L** | **High** — single chokepoint, but every endpoint renamed + re-authed |
| Config writers (PATCH→reload) | `providers.mjs`, `subagentSync.mjs`, `opencodeAdmin.mjs` | **L** | **High** — write model inverts; removeConfigKeys restart rationale gone |
| Event normaliser + raw-event handlers | `streamInterp.mjs`, `useSseBus.ts`, `App.tsx`, `push.mjs`, `delegate.mjs`, `index.mjs`, CTO ×5 | **L** | **High** — every event renamed; streamInterp is the iOS firewall |
| Message/part-shape consumers (renderer) | `chatUtils.ts`(+24 refs), `ToolCall.tsx`, `artifacts.ts`, `toolActivity.ts`, `ChatPanel.tsx` +6 | **L** | **High** — typed `content[]` replaces parts |
| Direct DB readers | `opencodeDb.mjs`, `messageSearch.mjs`, `modelLedger.mjs`, optimizer ×2, CTO ×6 | **L** | **High** — new schema breaks all reads |
| OpenCode tools + plugins | 20 tools + `manta-auth.ts`; 2 plugins; claude-auth seed | **L** | **High** — V1 tools/plugins don't load in V2 |
| Install / self-update / services | `install.sh`, `self-update.sh`, `release.sh`, systemd unit, launchd plists | **M–L** | **Med** — binary, auth password env, serve flags |
| Update + compatibility + migration UI | `compatibility.mjs`, `serverUpdate.mjs`, `autoUpdate.ts`, `useCompatibilityCard.ts`, `Onboarding.tsx`, banners | **M** | **Med** — mostly reuse; migration gate is new but hosted in existing full-screen flow |
| iOS native | `MantaEventStore.swift`, `MantaStreamModels.swift`, transcript/tool/plan derivers | **S–M** | **Low–Med** — insulated by interpreted stream if frames held stable |
| Tests (V1-shape) | server 31, renderer 2, iOS 26 | **L** (server) / **M** (rndr) / **S–M** (iOS) | **Med** |

File written: `/home/dev/projects/manta-v2-plan/docs/opencode-v2/spikes/p4-inventory.md`
