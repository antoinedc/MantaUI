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
1. **Todos: V2 deliberately removed TodoWrite** and ships no replacement. The docs only say the Plan agent "may write OpenCode plan files when asked"; in practice models fall back to writing a markdown checklist (`.task_plan.md` / `TODO.md`). There is no todo state or event. → Decision D1 (decided: Manta ships its own todo tool).
2. **No event replay.** `/log` only emits `seq` watermarks. Reconnect = cheap "changed since seq N?" check + refetch. Fine, but the renderer's gap-handling must be built on refetch.
3. **`CLAUDE.md` ignored**, **no LSP**. Only matters for users relying on either.
4. **Disk:** migration needs ≈0.8× the history size of extra space in place, ≈1.8× on a copy. The dev box cannot migrate today (32 GB history, ~3 GB free). → Decision D3 (decided: the box owner frees the space; Manta checks and blocks until it is there).
5. **Security defaults:** `external_directory` is allowed by default (V1 asked) — we ship an `ask` rule; `GET /api/credential` returns secrets in plain text — never proxied.

---

## 3. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Todos: V2 has no replacement → Manta ships its own `todowrite` tool in the plugin pack + a todo frame, so the pinned checklist card keeps working | **Decided** |
| D2 | Pin the opencode V2 version exactly; bump only after the contract suite passes; remove `opencode upgrade` from self-update | **Decided** |
| D3 | Disk: the box owner frees space; migration pre-flight checks and refuses to start (nothing stopped, nothing changed) until there is enough | **Decided** |
| D4 | **Hard switch.** One coordinated release: box release **R2** (V2 only), desktop **D2**, iOS **I2**. No dual-backend mode, no opt-in, no gradual rollout to users. Users must update everything | **Decided** |
| D5 | Migrate on a copy when space allows (clean rollback), in place otherwise (V1 tables remain in the file) | Proposed |
| D6 | Project `CLAUDE.md`: installer adds it to config `instructions` so V2 keeps reading it | Proposed |

---

## 4. Migration path — step by step

**Development model.** Work merges to `main` continuously, but users can never reach the
V2 path until the cut-over release: the V2 backend is selectable only on dev boxes
(`~/.manta/opencode-backend=v2`). The cut-over release (Phase 6) deletes the V1 backend
and makes V2 the only path. This avoids a months-long branch without exposing a dual mode
to users.

### Phase 0 — Spikes ✅ (this document)

### Phase 1 — One boundary around opencode (lands on V1, invisible to users)
Goal: every opencode-specific shape is translated in manta-server, so the engine swap does
not ripple into the clients.
1.1 **Backend interface.** `src/server/opencode.mjs` behind an `OpencodeBackend` interface
(sessions, prompt + delivery, interrupt, permissions, questions/forms, providers, models,
files, VCS, config, events). V1 implementation = today's code, moved.
1.2 **Freeze the frame contract.** The `/events` interpreted frames (`streamInterp.mjs`
output) and the `/rpc` message model become Manta-owned types in `src/shared/`, with golden
tests replaying recorded event streams. iOS depends only on these — keeping them stable is
what lets old iOS builds survive the switch.
1.3 **Renderer stops reading raw opencode events** (`useSseBus.ts`, `App.tsx`); add frame
kinds where missing (todos, compaction, retry, truncation, command origin, child sessions,
live tool output).
1.4 **Manta message model** (text / reasoning / tool{status,input,output,liveOutput} /
file / child-session / form) built server-side; renderer + `chatUtils.ts` consume only it.
1.5 `HistoryStore` interface for every direct DB reader (search, model ledger, optimizer,
CTO); `ConfigStore` interface for every config writer.
Gate: suites green; manual regression checklist identical on V1 (streaming, tools, live
bash, permissions, questions, subagents, queued messages, search, compaction, model switch,
schedules, delegate, push).

### Phase 2 — V2 backend (dev boxes only)
2.1 `/api/*` client with Basic auth from `~/.manta/opencode-password` (0600).
2.2 Event mapper V2 → Manta frames; live-shell poller on `/api/shell/{id}/output`.
2.3 Message mapper V2 timeline → Manta message model.
2.4 Natives: queued messages → `delivery: queue|steer` + inbox; interrupt → `/interrupt`;
running → `/session/active`; titles → `session.renamed`; model/agent → server-side switch.
2.5 Questions → forms; permissions → V2 requests; trust mode → session allow-all ruleset.
2.6 `ConfigStore` V2: edit `opencode.jsonc` + `POST /api/location/reload` (no restart).
2.7 `HistoryStore` V2 on the new schema.
2.8 **Contract suite** against the pinned V2 binary (CI, sandboxed, API-key model, tiny
budget) — replays the spike scenarios and asserts frames.
Gate: the dev box runs V2 daily for a week; contract suite green.

### Phase 3 — Manta V2 plugin pack (parallel with Phase 1–2)
3.1 One `manta` plugin: all 20 tools (shared helper replaces `manta-auth.ts`) + the todo
tool (D1).
3.2 `manta-claude-max` from `p1`: auth, identity, version gating, billing header, tool-name
prefix with response un-prefix, body clone, SSE un-prefix buffered to event boundaries.
3.3 Seats: per-session account in `http.request`; refresh via manta-server.
3.4 Optimizer → `session` `context` / `compaction` hooks.
Gate: every tool exercised by a live turn; Max + two seats + Opus verified on the dev box.

### Phase 4 — Box release R2 (install + update + migration)
4.1 Bundle the pinned V2 binary; the V2 curl installer is never used.
4.2 Generate `OPENCODE_PASSWORD` into `~/.manta/opencode-password`; all three supervisors
(systemd, launchd, nohup fallback) pass it + `OPENCODE_DB` + `ANTHROPIC_CLI_VERSION`.
4.3 Global config: `external_directory: ask` rule; D6 `CLAUDE.md` instructions; drop
`provider.openrouter.whitelist` (unsupported) after recording it.
4.4 Plugin pack installed to `~/.config/opencode/plugins/`; `tools/*.ts` and V1 plugins
removed; `opencode upgrade` removed.
4.5 **Migration runs as part of the box update itself** (§5). Both fresh installs and
upgrades from R1 land on V2. `supportedMajor` bumps, so R1-era desktops see "incompatible".
Gate: on the staging box — fresh install; upgrade from R1 with a realistic copied history
(≥ 2 GB); kill manta-server, kill opencode, reboot, and quit the desktop mid-migration;
too-little-disk path; rollback path.

### Phase 5 — Desktop D2 + iOS I2
5.1 D2 requires box ≥ R2. On launch it runs the **blocking upgrade screen** (§5) when the
box is older or still migrating; otherwise opens normally.
5.2 I2: V2-era features (forms, todos frame) + a read-only "Your box is upgrading" screen.
Old iOS builds keep working against R2 as long as the frame contract (1.2) held — verified
in the Phase 4 rehearsal with the previous TestFlight build.

### Phase 6 — Cut-over release
6.1 Delete the V1 backend, V1 tool/plugin install paths, V1 tests, and the workarounds V2
replaces: abort-based queue drain, per-directory streams + readiness gate, delta flush
buffer, throwaway title sessions, restart-on-config-remove, localStorage model override,
status guessing in peers/push.
6.2 Migrate the dev box first (disk provided per D3), then the staging box.
6.3 Publish **R2, D2 and I2 together** (server tarballs → desktop feed → TestFlight).
Gate: dev + staging boxes on V2 for 2+ days with no regressions.

### Phase 7 — After the switch
7.1 Watch: migration success rate, durations, rollbacks, Claude Max errors.
7.2 Two weeks after release, offer "Reclaim disk space" in Settings (drop V1 tables +
VACUUM, needs temp space; explicit user click).

---

## 5. Hard switch: update order and the blocking upgrade screen

### The box upgrade (R1 → R2) is atomic from the user's point of view
`self-update.sh` for R2 runs these steps; each is idempotent and recorded in
`~/.manta/v2-migration.json`, so a crash, reboot or manta-server restart resumes:
1. **Pre-flight** — disk (free ≥ 1.0× history size, D3), CPU arch, current version.
   Failure → abort before anything is stopped; box stays fully on R1; the reason is
   recorded and shown to the user.
2. **Swap code** to R2; manta-server restarts in *upgrade mode* (serves only auth,
   version and migration status; every other route answers `503 box upgrading`).
3. **Stop V1 opencode** after waiting up to 60 s for running turns (scheduler, webhooks
   and delegate paused).
4. **Copy history** (D5) — progress = bytes copied.
5. **Migrate** — start V2 with `OPENCODE_DB`; progress = `numerator/denominator` from
   `/api/experimental/migration/v1`, caption = `label`.
6. **Verify** — plugin pack loaded, tools registered, one tiny Claude turn per account,
   session count matches.
7. **Cut over** — manta-server leaves upgrade mode; scheduler/webhooks resume.
Progress for all steps is published on `/events` and pollable at `GET /api/upgrade`.

### Update order (both orders work)
**Desktop first** (D2 launched against an R1 box):
1. D2 reads `GET /api/version` → box is older than R2 → full-screen gate, nothing else
   reachable.
2. Gate shows the pre-flight result and one button: **"Upgrade box"** (explains running
   agents will be stopped, shows estimated duration).
3. D2 triggers the existing box-update mechanism, then follows `/api/upgrade` through
   steps 1–7. It tolerates the manta-server restart (polls once per second until the
   events stream reconnects).
4. Done → app opens on V2.

**Box first** (box updated from the R1-era desktop banner or `manta update`):
1. The box upgrades itself through steps 1–7 with no client attached.
2. The R1-era desktop sees `incompatible` → existing blocking banner: "Update Manta to
   continue" (desktop auto-update is already wired).
3. When D2 launches: migration done → opens normally; still running → gate attaches and
   shows live progress; failed → gate shows the failure with Retry / Roll back.

**iOS:** I2 shows the same progress read-only ("Your box is upgrading"). If the user has
not updated iOS yet, the old build keeps working once the box is on R2 (frame contract
held), and during the upgrade it sees the box as unreachable/upgrading.

### The gate (desktop)
- Hosted in the full-screen Onboarding flow (`Onboarding.tsx`, which `App.tsx` already
  swaps to by state) — no new blocking primitive.
- Top: overall progress bar. Below: the 7 steps with a check, spinner or error each; the
  current step has its own bar and ETA (measured rate).
- Not dismissible. Only "View logs" and "Get help" are available.
- Failure states:
  - **Not enough disk:** exact numbers ("needs 31 GB free on /mnt/…, has 3 GB") and
    **Check again**. Nothing was stopped.
  - **Migration error:** **Retry** (resumable) or **Roll back** (box returns to R1 + the
    untouched V1 history; the gate then says to reinstall the previous desktop version,
    with a link).
  - **Verification failed** (e.g. Claude login): no rollback; shows the specific fix
    (sign in again) and **Check again**.

---

## 6. Rollback

| When | How |
|---|---|
| Phases 1–5 | Normal revert; no user is on V2 |
| Pre-flight fails | Nothing to roll back; box never left R1 |
| During / after migration | `manta rollback` (also the gate's Roll back button): reinstall the previous box release, start V1 on the untouched V1 history (copy mode) or the same file (in place: V1 tables kept). Conversations created on V2 since cut-over are exported to a file. User reinstalls the previous desktop version. Emergency path, not a mode |

---

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A bug only found after users switch (no gradual rollout) | Medium | Contract suite; dev + staging boxes on V2 before release; rollback command; release on a quiet day with monitoring |
| Anthropic changes the Claude Code billing signature / version gating | Medium (same as today) | Version derived from the box CLI; contract suite alerts |
| V2 point release breaks the contract | Medium (V2 is 2.0.x) | Pinned (D2) |
| Migration slow / out of disk on big boxes | Medium | Pre-flight refuses before touching anything; resumable; ETA shown |
| Old iOS build breaks on R2 | Low–Med | Frame contract (1.2) + rehearsal with the previous TestFlight build |
| Credentials endpoint leaks secrets | Low | Never proxied; test asserts it |

---

## 8. Effort (rough, engineer-days)

| Phase | Days |
|---|---|
| 1 One boundary around opencode | 8–12 |
| 2 V2 backend + contract suite | 12–16 |
| 3 Plugin pack | 6–9 |
| 4 Box release R2 (install, update, migration) | 5–7 |
| 5 Desktop gate + iOS | 4–6 |
| 6 Cut-over + deletions | 3–4 |
| **Total** | **~38–54** |

Phase 3 runs in parallel with 1–2; 4–5 depend on 2.
