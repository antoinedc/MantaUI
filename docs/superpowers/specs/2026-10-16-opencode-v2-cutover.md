# OpenCode V2 — the cutover (no switch, straight to main)

Decision 2026-10-16 (supersedes the master plan's "dev-only flag" Phase 2): there is NO
backend switch and NO V1/V2 dual mode. Slices land directly on `main`; V1 support is
deleted as each area moves. `main` is allowed to be non-functional between slices (the
dev box runs `main`; the owner tests by fetching + building). Every PR must still pass
`npm run typecheck` and `npm test`.

Already on main: frame vocabulary (#1587), renderer on frames only (#1590), `manta` tool
plugin (#1588), `manta-claude-max` + `manta-optimizer` plugins (#1589), pinned-binary
harness (`scripts/opencode-v2/`, version in `scripts/opencode-v2/version.mjs`, 2.0.30).

## Cross-slice contracts (pinned — code against these, not against each other's code)

**K1 — opencode endpoint.** V2 listens on `127.0.0.1:4096` (same port as today). Every
request carries `Authorization: Basic base64("opencode:" + password)`. The password is
the content of `~/.manta/opencode-password` (single line, 0600), read per process start
and cached; the service passes the same value as `OPENCODE_PASSWORD`. manta-server reads
it through ONE helper `opencodeAuthHeader()` exported from `src/server/opencode.mjs`.
`MANTA_OPENCODE_PASSWORD` env overrides the file (tests). The V2 history DB path is
`$OPENCODE_DB` when set, else opencode's default.

**K2 — what the clients see is unchanged.** manta-server keeps every `/rpc` channel name
and response shape and every `/events` stream frame exactly as today. In particular
`opencode:messages` / `opencode:message` keep returning the current
`{info, parts}[]` message shape (src/shared/types.ts `OpencodeMessage`), built
server-side from V2's timeline. Desktop and iOS need no change for V2 beyond slice C4.

**K3 — upgrade API (C3 serves, C4 consumes).**
`GET /api/upgrade` (auth required, available in every mode) →
```
{ state: "idle"|"running"|"failed"|"completed"|"rolled_back",
  steps: [{ id: "preflight"|"stop"|"copy"|"migrate"|"verify"|"cutover",
            label: string, status: "pending"|"running"|"done"|"failed",
            progress: { label?: string, numerator?: number, denominator?: number } | null,
            error?: string }],
  overall: number,            // 0..1
  etaSeconds: number | null,
  error: { step, message, retryable, needBytes?, haveBytes? } | null }
```
`POST /api/upgrade/retry` and `POST /api/upgrade/rollback` → `{ok:true}` | `{ok:false,error}`.
While `state === "running"` the box is in **upgrade mode**: every route except `/auth/*`,
`/api/version`, `/api/upgrade*`, `/events` and `/push/*` answers
`503 {"error":"box upgrading","upgrade":true}`. Progress is also published on `/events` as
`{kind:"upgrade", payload:<same object>}` on every change.
`GET /api/version` adds `opencode: { major: 2, version: "2.0.30" }`.

**K4 — compatibility.** `DEFAULT_COMPATIBILITY_MATRIX.supportedMajor` becomes `1`
(`src/shared/compatibility.mjs`); the box's wire major in `/api/version` becomes `1`. An
old desktop against a new box, or a new desktop against an old box, is `incompatible`.

---

## Slice C1 — manta-server talks to V2 (owner: one implementer)

**Owns:** `src/server/opencode.mjs` (+ its tests), `src/server/streamInterp.mjs` (+ tests,
goldens, `src/server/fixtures/opencodeV2Events/` new), `src/shared/streamInterpretation.mjs`,
`src/server/rpc.mjs` opencode channels only, the `oc.*` call sites in other server modules
(`peers.mjs`, `appControl.mjs`, `forge/`, `cto*.mjs`, `delegate.mjs`, `promptDelivery.mjs`,
`webhooks.mjs`, `tmux.mjs`, `capNotifier.mjs`, `push.mjs`, `index.mjs` pump) where a
signature or event name changes. **Not:** `providers.mjs`, `opencodeDb.mjs`, DB readers,
`scripts/**`, `src/renderer/**`, `mobile/**`.

1. Every V1 endpoint in `opencode.mjs` re-pointed to its V2 equivalent (`/api/*`, K1 auth).
   Use `docs/opencode-v2/spikes/` (round1-b, p3) and the OpenAPI at
   `https://opencode.ai/v2/openapi.json`. Location: `location[directory]=` query where a
   route needs one; session routes don't.
2. One global event stream (`GET /api/event`); delete the per-directory streams, the
   directory cache listeners, the readiness gate, LRU eviction and deafness logic.
   Reconnect: on (re)connect, refetch the transcripts of sessions the interpreter knows
   (there is no replay).
3. `streamInterp` consumes V2 events and emits the SAME frames as today (vocabulary from
   #1587/#1590). Mapping table from `round1-b.md` B1 + `p3`: `session.text.delta` → `flush`
   (V2 deltas are phrase-level: keep the flush buffer only if needed for frame semantics);
   `session.tool.*` → tool frames + `toolBoundary`; live shell output: on
   `session.tool.progress{metadata.shellID}` poll `GET /api/shell/{id}/output?cursor=` every
   250 ms until `shell.exited`, emitting `toolOutput` (same 20k cap);
   `session.execution.started|succeeded|failed|interrupted` → `running`/`turnComplete`/
   `sessionError`/`aborted`; `session.usage.updated` → `stepEnded` + `context`;
   `session.created{parentID}` → `childSession`; `form.created`/`form.*` → `questions`
   (map V2 form fields to the current question shape: one field → one question, options →
   options, `custom` → free text); `permission.asked/replied` → `permissions`/`attention`;
   `session.compaction.*` → `compaction`/`transcriptStale`; `session.renamed` → (no frame;
   titles flow via session list); `todo_write` tool input → `todos`.
4. Message model: V2 `Session.Message.Info` timeline → current `{info, parts}` shape
   (text, reasoning, tool parts with `state.{status,input,output,metadata,title,time}`,
   `task`-equivalent subagent parts with `state.metadata.sessionId`, step-finish parts with
   tokens/cost so existing token selectors keep working). Pure mapper, unit-tested on
   recorded V2 payloads.
5. Questions reply → `POST /api/session/{id}/form/{formID}/reply` with
   `{answer:{<key>:value}}`; reject → `DELETE`. Permissions reply →
   `POST /api/session/{id}/permission/{id}/reply {decision}` (`always` for trust mode).
6. Prompt: `POST /api/session/{id}/prompt {text, files, id?, delivery?}`. Today's queue
   drain keeps working (abort = `POST /api/session/{id}/interrupt`, surfaced as `aborted`).
   Using `delivery:"steer"|"queue"` natively is Phase 6, not here.
7. Delete `runThrowawayAgent`/`generateSessionTitle` throwaway sessions → V2
   `POST /api/session/{id}/generate`; delete restart-based paths that only V1 needed.
8. Record a V2 corpus with the pinned harness (`scripts/opencode-v2/sandbox.mjs`, API key
   by reference, Haiku) for the same 7 scenarios as the V1 corpus; golden tests assert the
   frames match the V1 goldens' semantics (same subs, same order of edges).

**Done:** typecheck + `npm test` green; V2 goldens; a live smoke against the sandbox: create
session, prompt, stream, tool + live shell output, question, permission, abort, subagent,
all producing the expected frames.

## Slice C2 — config, history and maintenance on V2

**Owns:** `src/server/providers.mjs`, `src/shared/subagentSync.mjs`, `src/server/opencodeAdmin.mjs`,
`src/server/opencodeDb.mjs`, `src/server/messageSearch.mjs`, `src/server/modelLedger.mjs`,
`src/server/optimizer/**`, `src/server/cto{Context,SearchIndex,Backfill,SegmentEvidence}.mjs`,
`index.mjs` `messageExists` only, and their tests + fixtures. **Not:** `opencode.mjs` (use
its exported `ocFetch`/`apiUrl`/`opencodeAuthHeader`; if C1 hasn't landed, code against
K1 directly with a local helper and leave a TODO to switch).

1. Config writes: edit `~/.config/opencode/opencode.jsonc` surgically (jsonc-parser,
   comments preserved) then `POST /api/location/reload`. Delete `patchGlobalConfig` /
   `PATCH /global/config` and every restart-after-config-change path (removals included).
   `restartOpencode` remains only for explicit user action and the upgrade flow.
   V1-format keys stay (V2 accepts them); `provider.openrouter.whitelist` → drop and use
   `enabled_providers`/model `disabled` equivalent per `round1-c` C1.
2. Cache TTL: per-model `cacheControl` written under V2's accepted location (verified in
   `p1` R3: `providers.<p>.models.<id>.settings.cacheControl`; V1 `options.cacheControl` in
   V1-format provider entries is also accepted — pick one and prove it on the harness).
3. Subagent sync: same reconcile; agents written in V1 `agent` map (accepted) — confirm
   with `GET /api/agent` on the harness.
4. History store: every direct reader moves to V2's schema (`session_v2`,
   `session_message` with JSON `data`; inspect `.schema` on a sandbox DB produced by the
   harness). Same outputs as today. New synthetic fixture
   `src/server/fixtures/opencodeV2DbFixture.mjs` (replaces the V1 fixture; keep the
   live-DB canary).

**Done:** typecheck + `npm test` green; harness proof that a config edit + reload applies
mid-turn without killing it and that search/ledger return results on a V2 DB.

## Slice C3 — box install, update and migration

**Owns:** `scripts/install.sh`, `scripts/install-lib.mjs`, `scripts/self-update.sh`,
`scripts/lib/release.sh`, `scripts/systemd/**`, `scripts/launchd/**`,
`scripts/release/pack.mjs`, new `src/server/upgradeV2.mjs` (+ test) and its route wiring in
`index.mjs` (K3 only), `src/server/version.mjs`, `src/shared/compatibility.mjs` (K4), their
tests. **Not:** anything C1/C2/C4 own.

1. Pinned binary: release tarball bundles `@opencode/cli-<platform>@<pin>` (npm registry
   tarball, integrity-verified, version from `scripts/opencode-v2/version.mjs`) at
   `~/.opencode/bin/opencode`. `opencode upgrade` is removed from self-update.
2. Password: install/update create `~/.manta/opencode-password` (32 hex, 0600) if absent;
   all three supervisors (systemd unit, launchd plist, nohup fallback) pass
   `OPENCODE_PASSWORD`, `OPENCODE_DB` (when the migration chose a copy), and the existing
   `ANTHROPIC_CLI_VERSION` + `OPENCODE_EXPERIMENTAL_*` env.
3. Plugins: install `docs/opencode-plugins-v2/{manta,manta-claude-max,manta-optimizer}` into
   `~/.config/opencode/plugins/`; remove `~/.config/opencode/tools/*.ts` that Manta
   installed, the V1 plugins (`manta-accounts.ts`, `manta-optimizer.ts`) and the
   `opencode-claude-auth*` entries from `opencode.jsonc` `plugin`. Global config gets the
   `external_directory: ask` permission rule and project `CLAUDE.md` via `instructions`.
4. Migration (`upgradeV2.mjs`, durable state in `~/.manta/v2-migration.json`, every step
   idempotent, resumes on manta-server start): runs automatically on the first boot of the
   new release when the V1 DB has not been migrated. Steps (K3 ids):
   - `preflight`: free space on the DB's filesystem ≥ 1.0× DB size → copy mode; else ≥
     0.8× → in-place mode; else fail `retryable` with `needBytes/haveBytes`. Nothing
     stopped yet.
   - `stop`: wait ≤ 60 s for running turns, stop opencode, pause scheduler/webhooks/delegate.
   - `copy` (copy mode only): copy DB (+wal/shm via sqlite backup) next to it as
     `opencode-v2.db`; progress = bytes.
   - `migrate`: start V2 with `OPENCODE_DB`; poll `/api/experimental/migration/v1` 1/s;
     progress = its `numerator/denominator`, label = its `label`.
   - `verify`: plugins active (`GET /api/plugin`), session count matches V1, one tiny turn
     with the Claude login if present (skip silently if no Claude login).
   - `cutover`: persist `OPENCODE_DB` into the service env, restart services normally,
     leave upgrade mode, resume scheduler/webhooks/delegate.
   ETA from the measured migrate rate. `rollback`: stop V2, start the V1 binary kept at
   `~/.opencode/bin/opencode-v1` against the untouched V1 DB (copy mode) and re-install the
   previous release (`self-update.sh --to <previous git sha>`); in-place mode keeps V1
   tables, so the same path works.
5. Fresh install (no V1 DB): no migration, straight to V2.

**Done:** typecheck + `npm test` green; `upgradeV2` state machine unit-tested with injected
I/O (preflight fail, resume after crash at each step, retry, rollback); installer tests
updated; one rehearsal on a sandboxed copy of a reduced V1 DB with the pinned binary.

## Slice C4 — clients: blocking upgrade screen

**Owns:** `src/renderer/**` (new `UpgradeGate.tsx`, `Onboarding.tsx`/`App.tsx` wiring,
`useCompatibilityCard.ts`, `api/httpApi.ts` upgrade kind), `src/shared/api.ts` additions,
`mobile/native/**`. **Not:** server files.

1. Desktop: when `/api/version` says the box is older (K4 incompatible, box behind) → the
   gate shows "Upgrade box" which runs the existing box-update flow (confirm dialog that
   warns running turns end), then follows K3. When the box reports `upgrade.state` running
   / failed / completed → gate shows K3 steps with an overall bar + current-step bar + ETA;
   `failed` shows the error (disk numbers when `needBytes`), **Retry** and **Roll back**;
   `completed` → app opens. Not dismissible. 503 `upgrade:true` from any call routes to the
   gate. Survives manta-server restarts (poll `/api/upgrade` 1/s while `/events` is down).
2. iOS: same states read-only ("Your box is upgrading"), no buttons.
3. Tests: pure state reducer for the gate (vitest), Swift decoding of K3.

**Done:** typecheck + `npm test` green; gate exercised in the renderer harness against a
fake K3 sequence (idle → running steps → completed; failed disk → retry; rollback).

---

## After C1–C4: Phase 6 deletions (separate PR)
Native steer/queue, `/api/session/active` running state, deleting the abort-drain machinery,
delta flush buffer, per-device model override, status guessing. Then the dev box upgrade
(disk provided by the owner) and the staging rehearsal before a release is tagged.
