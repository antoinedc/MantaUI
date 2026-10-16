# OpenCode V2 migration — master plan

Status: **draft for review** · Owner: CTO · Target opencode: **v2.0.30** (pin; re-validate on bump)
Evidence: `docs/opencode-v2/spikes/` — round 1 (`round1-a/b/c.md`) and proof spikes
`p1` (Claude Max), `p2` (history migration), `p3` (behaviour gaps), `p4-inventory.md`
(every Manta touchpoint). Every claim below marked *proven* was observed live on V2 2.0.30
in an isolated sandbox; nothing was run against the live box.

---

## 1. Why, and the shape of the change

V2 replaces several of Manta's most fragile workarounds with native features (all *proven*):

| Manta workaround today | V2 native replacement |
|---|---|
| Fake "steer": abort the turn at a tool boundary, hide the abort error, resubmit | `delivery: "steer" \| "queue"` on prompt + durable server-side inbox (list / reorder / cancel) |
| One event stream per project directory + readiness gate | One global stream; every event carries `sessionID` |
| Guessing "is it running" (no running flag) | `GET /api/session/active`; typed `session.execution.{started,succeeded,failed,interrupted}` |
| `MessageAbortedError` suppression on interrupt | Interrupt is its own event, not an error |
| Restarting opencode (killing every turn) on config removals / cache TTL 1h→5m | Edit config file + `POST /api/location/reload` — running turns survive |
| Char-level text deltas + client flush buffer | Phrase-level `session.text.delta` |
| Throwaway sessions for titles | Auto-titles (`session.renamed`) + `session/generate` |
| Per-device model override in localStorage | Server-side `switchModel` / `switchAgent` |
| Retry can double-send | Client-supplied prompt `id` is idempotent |

Cost of the move: a new HTTP API with auth, a new event vocabulary, a new message shape
(typed timeline with `content[]` blocks instead of parts), a new DB schema, a new plugin
API (V1 tools/plugins do not load), and an in-place history migration.

**Architectural principle — manta-server is the firewall.** Clients (desktop renderer,
iOS) must never see opencode's native API. manta-server translates V2 into Manta's own
`/rpc` + `/events` contract. iOS already consumes only interpreted frames
(`streamInterp.mjs`) — keeping that frame contract stable carries iOS through with
little/no change. The desktop renderer still reads some raw opencode events; Phase 1
removes that so the backend swap is invisible to every client.

---

## 2. What was proven (spike results)

| Unknown | Result | Evidence |
|---|---|---|
| Claude Max on V2 | **Proven.** In-house V2 plugin `manta-claude-max` (~260 LoC) ran real subscription-billed Haiku + Opus turns, no API key. CLI-version gating works both ways (2.1.100 → 400, 2.1.280 → OK). | `p1/FINDINGS.md`, `p1/manta-claude-max.ts` |
| Multi-account seats | **Proven** with two real seats, selected per session in the `http.request` hook (cleaner than V1's global fetch patch). | `p1` G4 |
| Token refresh | Design: stays in manta-server (`claude` CLI path); plugin asks manta-server to refresh on 401, re-reads, retries once. V2's OAuth store cannot mint Max tokens. | `p1` G5 |
| 1h prompt-cache TTL | **Survives** (`providers.<p>.models.<id>.settings.cacheControl`). | `p1` R3, `round1-c` |
| Manta tools | V2 ignores `tools/*.ts`; tools must live in a plugin. Plugin tools receive `sessionID` (+ messageID, agent). One real tool ported and called live. `@opencode/plugin` resolves inside the binary (no npm install). | `round1-a` A2/A3 |
| manta-server → opencode calls | Plugin RPC `POST /api/rpc/{id}/{method}` works. | `round1-a` A5 |
| Config compatibility | Our real `opencode.jsonc` loads (498 named subagents). Only `provider.openrouter.whitelist` dropped. V1 keys normalised in memory. | `round1-c` C1 |
| History migration | **Proven**: auto-runs on `serve` start, determinate progress, exact fidelity, **resumable** after kill -9, **idempotent**, rollback-safe on a copy via `OPENCODE_DB`. ~5.5 sessions/s → 15–90 min for the 32 GB / 4,414-session box. **File grows ≈1.76×.** | `p2/FINDINGS.md` |
| Event vocabulary | ~25 event types catalogued; uniform `sessionID`; subagents via `session.created{parentID}`; completion via parent `tool.success`. | `round1-b` B1, `p3` 7 |
| Live shell output | Not in events: poll `GET /api/shell/{id}/output?cursor=N` (<0.4 s latency), keyed off `session.tool.progress.metadata.shellID`. | `p3` 6 |
| Questions | `question` tool → `form.created`; reply `{answer:{key:val}}`; cancel = DELETE → `form.cancelled`. | `p3` 4 |
| Permissions | Names V1-compatible (`once/always/reject`); trust mode = allow-all session ruleset; saved "always" grants listable + removable. | `p3` 3 |
| Instructions | Global + project `AGENTS.md` reach the model. **`CLAUDE.md` not loaded.** | `p3` 2 |
| Server auth | HTTP Basic `opencode:<password>` on all `/api/*`, incl. SSE. Fixed via `OPENCODE_PASSWORD` env. No way to disable. | `p3` 11 |
| Slash commands / skills / MCP | Work; **no `command.executed` event** (command arrives as a user message); MCP tools exposed via code-mode `tools.<server>.<tool>`. | `p3` 9, 10 |
| Usage / context | `model.limit.context`, Session.Info tokens, `session.usage.updated`. | `p3` 13 |

### Known gaps that need a product decision (not technical unknowns)
1. **Todos: V2 deliberately removed TodoWrite.** Manta's pinned todo card breaks. → Decision D1.
2. **No event replay.** `/log` only emits `seq` watermarks. Reconnect = cheap "changed since seq N?" check + refetch. Fine, but the renderer's gap-handling must be built on refetch.
3. **`CLAUDE.md` ignored**, **no LSP**. Only matters for users relying on either.
4. **Disk:** migration needs ≈0.8× the history size of extra space in place, ≈1.8× on a copy. The dev box cannot migrate today (32 GB history, ~3 GB free). → Decision D3.
5. **Security defaults:** `external_directory` is allowed by default (V1 asked) — we ship an `ask` rule; `GET /api/credential` returns secrets in plain text — never proxied.

---

## 3. Decisions needed before Phase 2 (owner: you)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Todo card: ship a Manta `todowrite` tool in our plugin (same UX), or retire the card | **Ship the tool** — it's a ~50-line plugin tool + a custom event; keeps the UX users know |
| D2 | Pin opencode version (today: unpinned, `opencode upgrade` every self-update) | **Pin** V2 exactly; bump deliberately after re-running the contract test suite (Phase 2) |
| D3 | Disk policy for migration | Pre-flight requires free ≥ 1.0× history size; otherwise the gate offers "free space / archive sessions older than N days" — never auto-deletes |
| D4 | Migrate in place vs on a copy | **Copy when space allows (clean rollback), in place otherwise** (V1 tables remain in the file, so rollback is still possible but less clean) |
| D5 | `CLAUDE.md` users | Box installer symlinks/appends project `CLAUDE.md` into instructions via config `instructions` |
| D6 | Who triggers migration | The **first desktop running the new version** (your requirement); iOS shows a read-only "box is upgrading" state |

---

## 4. Migration path — step by step

Each phase ships to `main` independently and leaves the product working. Phases 1–3 are
invisible to users. Exit criteria are gates: a phase is not done until its gate passes.

### Phase 0 — Spikes ✅ (this document)

### Phase 1 — Insulate Manta from opencode (on V1, no behaviour change)
Goal: every opencode-specific shape lives behind one boundary in manta-server.

1.1 **Backend interface.** Extract `src/server/opencode.mjs` behind an `OpencodeBackend`
interface (sessions, prompt, abort/interrupt, permissions, questions/forms, providers,
models, files, VCS, config write, events). `opencodeV1` = today's code moved, unchanged.
1.2 **Freeze the frame contract.** Document the `/events` interpreted-frame schema
(`streamInterp.mjs` output) and the `/rpc` message model as Manta-owned types
(`src/shared/`); add golden tests that replay recorded V1 event streams → frames.
1.3 **Renderer stops reading raw opencode events.** Move every raw-event consumer in
`useSseBus.ts` / `App.tsx` onto interpreted frames (add frame kinds where missing:
todos, compaction, retry, finish/truncation, command-origin, child sessions).
1.4 **Manta message model.** Renderer + `chatUtils.ts` consume a Manta-owned message model
(text / reasoning / tool{status, input, output, liveOutput} / file / child-session), built
server-side from V1 parts. This absorbs the parts→timeline change in one place.
1.5 **DB readers behind an interface.** `opencodeDb.mjs` gains a `HistoryStore` interface
used by search, model ledger, optimizer, CTO readers; V1 implementation = today's SQL.
1.6 **Config writer interface.** `providers.mjs`/`subagentSync`/cache TTL write through
`ConfigStore` (V1 = PATCH /global/config + `removeConfigKeys`).

Gate: full test suites green; desktop + iOS behave identically on V1 (manual regression
checklist: streaming, tools, live bash, permissions, questions, subagents, queue drain,
search, compaction, model switch, schedules, delegate).

### Phase 2 — V2 backend, behind a flag (dev boxes only)
2.1 `opencodeV2` backend: `/api/*` client, Basic auth from `~/.manta/opencode-password`
(0600), location handling.
2.2 Event mapper V2 → Manta frames (the 25 types in `round1-b` B1); live-shell poller
(`/api/shell/{id}/output`) emitting the same live-output frames as today.
2.3 Message mapper V2 timeline → Manta message model.
2.4 Native queue: Manta's queued messages → `delivery:"queue"`/`"steer"` + inbox APIs;
interrupt → `/interrupt`; running state → `/session/active`.
2.5 Questions → forms (QuestionCard renders V2 form fields; keep current UX for the
simple case). Permissions → V2 request/reply; trust mode → session allow-all ruleset.
2.6 Config writes → edit opencode.jsonc + `POST /api/location/reload` (no restart).
2.7 `HistoryStore` V2 implementation on the new schema (`session_v2`,
`session_message.data` JSON) — search, ledgers, optimizer, CTO.
2.8 **Contract test suite against a real V2 binary** (CI job, sandboxed, API-key model,
tiny budget): replays the spike scenarios and asserts frames. This is what makes
version bumps safe (D2).
2.9 Backend selection: `~/.manta/opencode-backend` = `v1|v2` (dev only).

Gate: a dev box runs V2 end-to-end for a week of real use with zero client changes beyond
Phase 1; contract suite green.

### Phase 3 — The Manta V2 plugin pack
3.1 One plugin package `manta` (`docs/opencode-plugins-v2/`): all 20 tools (shared helper
replaces `manta-auth.ts`), mechanical port (Plugin.define + `ctx.tool.transform`, JSON
Schema inputs, `{content}` results). Plus the todo tool (D1).
3.2 `manta-claude-max` (from `p1`): auth, identity, version gating, billing header,
tool-name prefix **with response un-prefix** (R1), body clone (R2); production SSE
un-prefix buffers to event boundaries.
3.3 Seats: per-session account selection in `http.request`; refresh via manta-server.
3.4 Optimizer → `ctx.session.hook("context" | "compaction")`.
3.5 Plugin RPC endpoints for anything manta-server needs to ask opencode directly.

Gate: every tool exercised by a live turn in the contract suite; Max + two seats verified
on a dev box; Opus with current CLI version.

### Phase 4 — Box install & update for V2
4.1 Releases bundle a **pinned** V2 binary staged at `~/.opencode-v2/bin/opencode`
(never overwrite V1 in place; the V2 installer is never used).
4.2 Generate `OPENCODE_PASSWORD` once into `~/.manta/opencode-password` (0600); service
units (systemd, launchd, nohup fallback — all three) pass it + `OPENCODE_DB` +
`ANTHROPIC_CLI_VERSION`.
4.3 Global config additions: `external_directory: ask` rule; D5 instructions for CLAUDE.md.
4.4 Self-update installs the plugin pack into `~/.config/opencode/plugins/` and stops
copying `tools/*.ts` once on V2. `opencode upgrade` removed (pinned).
4.5 The box release containing all of the above is **dual-backend**: it keeps running V1
until a migration is started (Phase 5). Shipping it changes nothing for users.

Gate: fresh install + upgrade from current release on the staging box, both still on V1,
V2 binary staged, password present, services correct.

### Phase 5 — Migration orchestrator + blocking first-launch screen
See §5 for the full design. Summary:
5.1 Box: `migrationV2.mjs` state machine (durable in `~/.manta/v2-migration.json`).
5.2 Box API: `GET /api/migration/v2` (state + progress), `POST /api/migration/v2/start`,
`POST /api/migration/v2/retry`, `POST /api/migration/v2/rollback`.
5.3 Desktop: full-screen `MigrationGate` in the Onboarding host; compatibility matrix bump.
5.4 iOS: read-only "Your box is upgrading" screen with the same progress.

Gate: rehearsal on the staging box with a realistic copied history (≥2 GB), including:
kill manta-server mid-migration, kill opencode mid-migration, desktop quit and relaunch
mid-migration, disk-too-small path, rollback path.

### Phase 6 — Adopt natives, delete workarounds
Delete: abort-based queue drain + `isDrainAbortError`; per-directory streams + readiness
gate + `rememberSessionDirectory`; delta flush buffer; throwaway title sessions;
restart-on-config-remove; localStorage model override; status guessing in peers/push.
Gate: deleted code has no remaining callers; suites green.

### Phase 7 — Rollout
7.1 Dev box (needs D3 disk first: ~25 GB more on the history volume, or archive).
7.2 Staging box, fresh + upgraded.
7.3 Users: publish box release (Phase 4/5, dual-backend) → publish desktop release that
requires it → migration happens on each user's first launch.
7.4 Two releases later: remove the V1 backend, V1 plugin/tool install paths, V1 tests;
offer "reclaim disk" (drop V1 tables + VACUUM, needs temp space) once the user confirms.

---

## 5. Blocking first-launch migration screen — design

### Trigger
- The new desktop version bumps the compatibility matrix: it requires box ≥ release R
  **and** `backend == v2`.
- On launch the desktop reads `GET /api/version` + `GET /api/migration/v2`:
  - box older than R → gate step 1 runs the existing box update flow (confirm → update →
    reconnect); then continues.
  - box on R, backend v1, state `not_started` → gate shows the pre-flight result and a
    single **"Upgrade now"** button (it stops running agents, so it must be a deliberate
    click; the screen explains that and estimates duration).
  - state `running` (started by another device, or resumed after a crash) → gate attaches
    and shows progress immediately.
  - state `completed` → app opens normally.
- The gate is **blocking**: no sidebar, no sessions, no settings except "Help / logs".
  It reuses the full-screen Onboarding host (`App.tsx` already swaps to it by state).

### Steps shown (one bar per step, overall bar on top)
1. **Checking your box** — version, disk pre-flight (D3), running sessions.
2. **Updating your box** (only if needed) — existing update flow, reconnect-tolerant.
3. **Preparing** — stop new turns, wait up to N s for running turns to finish (show which),
   stop V1 opencode, snapshot config, copy history if D4 = copy (bar = bytes copied).
4. **Migrating your conversations** — V2 started with `OPENCODE_DB`; bar =
   `progress.numerator / denominator`, caption = `progress.label`; the "Clearing old
   events" lead-in shows as indeterminate. ETA from measured rate.
5. **Installing plugins & checking your setup** — plugin pack loaded (`GET /api/plugin`),
   Claude login works (one tiny Haiku turn per account), tools registered.
6. **Done** — "Your conversations are on the new engine" → app opens.

### Who does the work
The **box** does everything; the desktop only displays and starts it. manta-server owns a
durable state machine:
`not_started → preflight → updating → preparing → migrating → verifying → completed`
with `failed{step, error, retryable}` and `rolled_back`. Every step is idempotent so a
restart of manta-server, a box reboot, or the desktop quitting simply resumes (V2
migration itself is proven resumable + idempotent). Progress is published on the existing
`/events` bus and also pollable (the desktop polls 1/s when SSE is down — manta-server
restarts during step 2).

### Failure handling
- Pre-flight fails (disk) → gate shows exact numbers ("needs 31 GB free, you have 3 GB")
  and options: free space and re-check, or archive sessions older than N days (explicit,
  previewed, reversible export to a tarball first). Nothing destructive happens
  automatically.
- Migration error → **Retry** (safe: resumable) and **Roll back** (switch the service back
  to V1 and the untouched V1 history; desktop then shows "the upgrade was rolled back"
  and keeps working on the previous box release until the user retries).
- Verification fails (e.g. Claude login) → do not roll back conversations; show the
  specific fix (sign in again) inside the gate.

### Other clients during migration
- iOS: `GET /api/migration/v2` → full-screen read-only progress ("Your box is upgrading,
  started from your Mac"); cannot start or cancel.
- Old desktops: compatibility verdict `incompatible` → existing blocking banner asks them
  to update.
- Scheduled prompts, webhooks, delegate jobs: paused during `preparing…verifying`, resumed
  after (scheduler skips, no catch-up — existing semantics).

---

## 6. Rollback

| Point of failure | Rollback |
|---|---|
| Phases 1–4 | Normal code revert; users never left V1 |
| During migration | Built-in: service back to V1 binary + untouched V1 history (copy mode) or same file (in-place: V1 tables are kept) |
| After cut-over, within the dual-backend window | `POST /api/migration/v2/rollback`: V1 resumes on the pre-migration history; conversations created on V2 since cut-over are exported to a file (not lost) |
| After Phase 7.4 | No automatic rollback (V1 removed); restore from the pre-migration backup |

---

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Anthropic changes the Claude Code billing signature / version gating | Medium (same as today) | Same exposure as V1; version derived from box CLI; contract test alerts |
| V2 point release breaks the contract | Medium (V2 is young: 2.0.x) | Pin (D2); contract suite gates every bump |
| History migration slow or out of disk on large boxes | Medium | Pre-flight; copy/in-place choice; resumable; ETA shown |
| Users relying on todos / CLAUDE.md / LSP | Low–Med | D1, D5; release notes |
| Credentials endpoint leaking secrets | Low | manta-server never proxies `/api/credential`; test asserts it |
| Renderer regression from message-model change | Medium | Phase 1 lands on V1 first with golden tests, before V2 exists |

---

## 8. Effort (rough, engineer-days)

| Phase | Days |
|---|---|
| 1 Insulation | 10–15 |
| 2 V2 backend + contract suite | 12–18 |
| 3 Plugin pack (tools, Max, seats, optimizer, todos) | 6–9 |
| 4 Install / update | 3–5 |
| 5 Orchestrator + gate + iOS state | 6–9 |
| 6 Delete workarounds | 3–4 |
| 7 Rollout + cleanup | 3–5 |
| **Total** | **~45–65** |

Phases 1 and 3 can run in parallel; 2 depends on 1; 5 depends on 2–4.
