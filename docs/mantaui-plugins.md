# MantaUI plugins — design spec (v3, BET-189)

Status: **ACTIVE / shipped.** First plugin: any user-authored YAML manifest
under `~/.manta/plugins/` on the connected Mac (typically `ios-<app>` —
iOS build + Simulator launch). The plugin system is the production surface;
the v1 TypeScript-handler model (BET-183/184/185) and its `ios_build` tool
are deleted.

This is the FINAL design. Every decision is made. The implementer makes NO
design decisions: if something appears ambiguous, re-read this file — the
answer is here. If it is genuinely absent, stop and ask on the issue.

Changes from v2 (all incorporated below, marked ⟨v3⟩ where they alter v2):
the TypeScript handler layer is GONE (no more `HANDLERS` map,
`CapHandler`/`CapCtx`-consumer indirection, or per-capability
`src/main/handlers/*.ts` files); a plugin is now one YAML file at
`~/.manta/plugins/<name>.yaml` on the machine that runs it; the executor
folder-scans + fs.watch-hot-reloads the dir, parses every `*.yaml` through
the shared `src/shared/pluginManifest.mjs` module (single source of truth
for parse + validate + if-eval + input→env + cwd substitution + timeout
parse), and dispatches a matching capability by running its steps
sequentially as `exec("/bin/sh", ["-c", step.run], …)`. The first
hard-coded capability is the `plugin.write` built-in — it lets the AI
author/edit manifests via `plugin_save`. Everything else is a manifest
lookup. Server spine (`src/server/capabilities.mjs` + REST + bus envelopes
+ sweeper) is **byte-identical to v2**. `host` accepts ONLY `"mac"` —
`box` is not implemented in v3.

## What this is

A **plugin system** that lets MantaUI gain new capabilities the AI can invoke
on the machine the user wants to drive (today: the connected Mac —
`host:"mac"`). The motivating case: run iOS compilation + Simulator
launch on the local Mac so we stop burning Codemagic minutes — but shaped so
the iOS plugin is just **plugin #1**, not a bespoke feature.

The critical requirement: **a plugin is data, not code.** Installing a plugin
is dropping one YAML file in `~/.manta/plugins/` on the executor machine —
the executor hot-reloads, no restart. The AI invokes a plugin via one of the
six generic `plugin_*` tools (`plugin_list`, `plugin_get`, `plugin_save`,
`plugin_run`, `plugin_status`, `plugin_docs`). The queue + REST + SSE spine
is byte-identical to v2 — `{capability, input, host}` stays generic; the
plugin-specific bits are the YAML, the validator, and the per-step runner.

```
a plugin = one YAML manifest at ~/.manta/plugins/<name>.yaml on the executor
           (what it is)         (where the AI calls it via plugin_*) (what
                                 runs)
```

This mirrors and generalizes the "MantaUI-native tools" pattern documented in
`docs/bui-tools-scheduler.md` (§"The pattern"). Every existing native tool is,
in effect, a hardcoded MantaUI-server plugin; v3 makes the YAML manifest
first-class so the user (or the AI, on the user's request) can add new
capabilities without touching MantaUI source.

---

## Terminology

- **Plugin** — a YAML manifest file at `~/.manta/plugins/<name>.yaml` on
  the executor machine. One plugin = one manifest = one `capability` string
  (= `name`).
- **Manifest** — the YAML file itself. Schema reference lives in
  `docs/plugins-authoring.md` §2.
- **Executor machine** — the runtime that scans the plugin folder, runs
  matching capabilities, and hot-reloads. v3: only the connected Mac.
- **Capability** — the string a plugin's manifest exposes to the queue.
  Always equal to the plugin's `name:` (which the executor enforces ==
  filename stem). Dotted namespaces are impossible by the manifest name
  regex.
- **Job** — one invocation of a capability: `{ id, capability, input, host,
  status, log[], result }`, tracked durably on the server through its
  lifecycle (`queued → running → done | failed`).
- **`plugin.write`** — the one hard-coded capability in v3: a special
  `capability:"plugin.write"` job validates its YAML payload, writes the
  file to `~/.manta/plugins/<name>.yaml`, and rescans. The runner has no
  other built-ins.

---

## Architecture (three layers, one generic spine, v3)

```
  ┌──────────────────────────────────────────────────────────────┐
  │ Layer 1 — CAPABILITY JOB QUEUE  (MantaUI server)              │
  │   src/server/capabilities.mjs          (BYTE-IDENTICAL v3)    │
  │   store: ~/.manta/cap-jobs.json  (atomic write)              │
  │   REST:  POST /api/cap             create a job              │
  │          GET  /api/cap/:id         status + log tail         │
  │          GET  /api/cap?host=&status=&sessionID=  list        │
  │          POST /api/cap/:id/start   executor claims the job   │
  │          POST /api/cap/:id/log     executor streams stdout   │
  │          POST /api/cap/:id/done    executor reports result   │
  │   bus:   publish {kind:"capJob"} on create → SSE to Mac      │
  │   sweep: startCapSweeper — timeouts, expiry, retention       │
  │   done:  inject completion turn into originating session     │
  └──────────────────────────────────────────────────────────────┘
        ▲ AI invokes                          ▲ Mac executes / reports
        │                                     │
  ┌─────┴──────────┐                  ┌────────┴─────────────────┐
  │ Layer 2 — AI   │  plugin_* tools  │ Layer 3 — MAC EXECUTOR   │
  │ docs/opencode- │ → POST /api/cap  │ src/main/capExecutor.ts  │
  │ tools/plugins. │                  │   • fs.watch ~/.manta/   │
  │ ts (6 exports) │                  │     plugins/ (500ms deb) │
  │                │                  │   • parse via shared     │
  │                │                  │     pluginManifest.mjs   │
  │                │                  │   • dispatch:            │
  │                │                  │     plugin.write → write │
  │                │                  │     else: run manifest   │
  │                │                  │   • PUT registry on scan │
  └────────────────┘                  └──────────────────────────┘
```

### The one decision that keeps it extraction-ready

**Everything at the transport layer speaks `{ capability, input, host }` —
never a plugin name or a step.** Job shape, REST body, SSE event, and
executor dispatch are all generic. The plugin-specific bits are the YAML,
the validator, and the per-step runner. Adding capability #N is writing
one YAML file, not editing TypeScript — and the queue, REST, SSE, and auth
stay unchanged.

### Constants (single source of truth — declare each ONCE, in the module noted)

| Constant | Value | Module | Meaning |
| --- | --- | --- | --- |
| `NAME_RE` | `^[a-z0-9][a-z0-9-]{0,62}$` | `pluginManifest.mjs` | plugin name regex (also the filename stem) |
| `INPUT_ID_RE` | `^[a-z][a-zA-Z0-9_]*$` | `pluginManifest.mjs` | input id regex (JS-identifier safe) |
| `INPUT_TYPES` | `["string","number","boolean","enum"]` | `pluginManifest.mjs` | allowed `inputs.<id>.type` values |
| `MAX_TIMEOUT_MS` | `30 * 60_000` | `pluginManifest.mjs` | hard cap on a plugin's `timeout:` (sweep alignment — see §Layer 1) |
| `LOG_CAP_BYTES` | `256 * 1024` | `capabilities.mjs` | ring-buffer cap on a job's stored log |
| `LOG_TAIL_BYTES` | `16 * 1024` | `capabilities.mjs` | max log bytes returned by `getJob` |
| `SWEEP_INTERVAL_MS` | `60_000` | `capabilities.mjs` | stale-job sweep cadence |
| `RUNNING_TIMEOUT_MS` | `30 * 60_000` | `capabilities.mjs` | `running` older than this → `failed` (matches `MAX_TIMEOUT_MS` so manifest can't outrun the sweep) |
| `QUEUED_EXPIRY_MS` | `24 * 60 * 60_000` | `capabilities.mjs` | `queued` older than this → `failed` |
| `TERMINAL_RETENTION_MS` | `7 * 24 * 60 * 60_000` | `capabilities.mjs` | terminal jobs older than this → pruned |
| `MAX_TERMINAL_JOBS` | `50` | `capabilities.mjs` | keep at most this many terminal jobs (drop oldest) |
| `EXECUTOR_JOB_TIMEOUT_MS` | `25 * 60_000` | `capExecutor.ts` | Mac-side per-job abort (< server's 30 min so the Mac fails first and reports properly) |
| `LOG_FLUSH_MS` | `1_000` | `capExecutor.ts` | executor log-batch flush cadence |
| `EXEC_STDOUT_CAP_BYTES` | `2 * 1024 * 1024` | `capExecutor.ts` | cap on captured stdout returned by `exec` |
| `KILL_GRACE_MS` | `5_000` | `capExecutor.ts` | SIGTERM → SIGKILL grace on abort |
| `PLUGIN_HOST` | `"mac"` | `pluginManifest.mjs` | only accepted `host:` value in v3 |
| `PLUGIN_WRITE` | `"plugin.write"` | `capExecutor.ts` | the one built-in capability name |

---

## Layer 1 — server: job queue (`src/server/capabilities.mjs`)

**Byte-identical to v2.** v3 touched only what runs inside the executor (a
single `if (capability === "plugin.write")` branch + a manifest runner).
The store, REST endpoints, SSE envelopes, sweeper, completion-routing, and
auth are unchanged — `git diff src/server/capabilities.mjs` between v2 and
v3 must show zero lines except comments.

See the v2 spec for the full design of this layer; the constants table
above is the only surface that matters for v3. The shared `markTerminal`
helper is still the single terminal-transition code path — used by both
`completeJob` and the sweep, so notify + publish + `finishedAt` stamping
lives in exactly one place.

---

## Layer 2 — AI tools (`docs/opencode-tools/plugins.ts`)

The "plugins register their own tools" requirement is satisfied by
**shipping the six generic `plugin_*` tools**: a single `.ts` file at
`docs/opencode-tools/plugins.ts` (COPIED, never symlinked — the
`@opencode-ai/plugin` import-resolution gotcha — into
`~/.config/opencode/tools/plugins.ts`, then `systemctl --user restart
opencode-serve`). One file, six exports → six global opencode tools,
auto-loaded for every project/session/model.

### Tool list (copy these descriptions verbatim)

| Tool | Args | Behavior |
| --- | --- | --- |
| `plugin_list()` | — | `GET /api/plugins/registry`. Returns a bullet list: name, description, input summary, `valid` / `INVALID: <error>`. Empty registry → explain the machine may be offline or have no plugins, point to `plugin_docs`. |
| `plugin_get(name)` | `name: string` | Lookup in the cached (or freshly-fetched) registry → the manifest's current YAML source. Unknown name → error listing known names. |
| `plugin_save(name, yaml)` | `name: string, yaml: string` | `POST /api/cap {capability:"plugin.write", host:"mac", input:{name, yaml}, sessionID, directory}` then poll `GET /api/cap/<id>` every 500ms for ≤15s. Done → "saved and valid". Failed → the validation errors verbatim. Still queued after 15s → "queued; the machine appears offline — it will apply when it reconnects". |
| `plugin_run(name, inputs?)` | `name: string, inputs?: Record<string,unknown>` | First `GET /api/plugins/registry`: unknown name → error listing known names (fast client-side fail — the queue stays generic and is NOT taught about plugins); invalid manifest → error with its validation message. Else `POST /api/cap {capability:<name>, host:"mac", input:<inputs>, sessionID, directory}` → return job id + "completion turn will arrive automatically, do not poll". |
| `plugin_status(id)` | `id: string` | Identical to today's `ios_build_status` semantics (rename + generic copy). |
| `plugin_docs()` | — | `GET /api/plugins/docs` → the full authoring guide (`docs/plugins-authoring.md` served verbatim). |

Tool descriptions are cost-aware, generic, and use **"machine"** wording
(never "Mac" — MantaUI branding). Each one keeps the "do NOT poll in a
loop — completion arrives automatically" framing. If you regenerate
descriptions, keep those warnings.

### Install

`docs/opencode-tools/AGENTS.md` contains a `## MantaUI plugins` section
(replacing the v2 `## MantaUI iOS build`) covering the six tools and when
to reach for each; users author plugins by just asking. Copy the file:

```bash
mkdir -p ~/.config/opencode/tools
cp <repo>/docs/opencode-tools/plugins.ts ~/.config/opencode/tools/
rm ~/.config/opencode/tools/ios-build.ts   # v1/v2 deletion (idempotent)
# Append the new "MantaUI plugins" section to ~/.config/opencode/AGENTS.md
# (replacing the v2 "MantaUI iOS build" section).
systemctl --user restart opencode-serve
```

---

## Layer 3 — Mac executor (`src/main/capExecutor.ts`)

The runner is replaced with a manifest runner. There is NO `HANDLERS` map,
NO `CapHandler`/`CapCtx`-consumer indirection, and NO per-plugin
`src/main/handlers/*.ts` files (the v1 `iosBuild.ts` + the empty
`handlers/` dir are deleted). The executor's job, per arrived `capJob`:

1. **Folder scan + hot reload.** The executor `mkdir -p`s
   `~/.manta/plugins/` at start, then synchronously scans it at boot,
   parses every `*.yaml` (skip `*.yaml.bak`, dotfiles) through
   `src/shared/pluginManifest.mjs`, and stores the result in an
   in-memory `Map<string, RegistryRow>`. `fs.watch` (debounced 500ms)
   rescans on change. On every SSE (re)connect the executor also
   rescans + republishes (see §Hot reload + registry publish).
2. **Claim** the job. `POST /api/cap/:id/start`. On non-2xx (409 =
   already claimed/stale) log one line, skip. Cross-delivery dedup.
3. **Dispatch.**
   - `capability === "plugin.write"` → built-in handler. Validate the
     YAML payload via the shared module, write
     `~/.manta/plugins/<name>.yaml`, rescan, return `{name, valid: true}`
     (or the validator errors verbatim — the executor surfaces them as
     the job's `error`).
   - Anything else → look up the capability name in the in-memory
     `manifests` map; not found OR `valid:false` →
     `POST done {status:"failed", error:'unknown plugin "<name>"; installed: …'}`
     and continue. **Never** shell out for an unlisted capability.
   - Found + valid → build the per-step env via the shared module's
     `buildEnv(manifest, suppliedInputs, {jobId})` (the executor patches
     in PATH via `exec`'s existing helper), arm an
     `AbortController` with `EXECUTOR_JOB_TIMEOUT_MS`, run each step
     sequentially as `exec("/bin/sh", ["-c", step.run], {cwd, quiet})`
     (with `cwd` resolved via `resolveCwd(step.cwd, env)`), honoring
     `continue_on_error` and `if:` via `evalIf`, and streaming each
     step's stdout/stderr to `ctx.log`. Step exit ≠ 0 → job fails at
     that step.
4. **Pre-step input validation.** Before step 1, the executor calls
   `validateSuppliedInputs(manifest, suppliedInputs)` from the shared
   module and aborts with a clear error if it fails. No steps run.
5. **Done.** Success → `POST done {status:"done", result: {steps:[…]}}`.
   Throw or abort → `POST done {status:"failed", error: ...}`. Always
   clear the timeout + do the final log flush BEFORE the done POST.
6. **Batched logs.** `ctx.log` appends to a per-job string buffer; a
   `setInterval(LOG_FLUSH_MS)` (unref'd) flushes as ONE
   `POST /api/cap/:id/log {chunk}` when non-empty. Failed log POSTs are
   dropped; failed `done` POSTs retry once after 5s, then drop (the
   server sweep times the job out anyway).

### Shared SSE consumer (still true)

`src/main/busConsumer.ts` is the ONLY SSE consumer in `src/main/`. Both
`desktopNotify` (filter `kind === "desktopNotify"`) and `capExecutor`
(filter `kind === "capJob"` + catch-up via `onConnect`) build on it. No
module-level singletons — each `createBusConsumer` call owns its own
state.

### The shared manifest module (`src/shared/pluginManifest.mjs`)

Single source of truth for what a valid manifest looks like. Imported by
BOTH the executor (TS) and the server (mjs). Pure functions everywhere,
no `electron`/`node:fs` deps beyond YAML parsing + `resolveCwd`'s
existence check. Adding a new validation rule here is reflected in every
consumer and every test. Exports:

- `parseManifest(yamlText): { manifest, errors[] }` — returns a manifest
  OR keyed errors (`steps[2].run: required` style). Unknown keys →
  `unknown key "<key>"`.
- `validateManifest(parsed): { errors[] }` — all schema rules from
  BET-189 §"Validation rules" plus the v3 grammar limits.
- `evalIf(expr, inputs): boolean | { error }` — exactly three forms,
  nothing else.
- `buildEnv(manifest, suppliedInputs, opts: { jobId }): Record<string,string>`
  — produces `process.env` keys (minus PATH — `exec` owns that), the
  manifest `env:` map (leading `~` expanded), `MANTA_INPUT_<ID>` per
  supplied input, `MANTA_PLUGIN`, `MANTA_JOB_ID`.
- `resolveCwd(cwd, env): string | { error }` — `$KEY`/`${KEY}` from
  `env:` only, then leading `~` expansion; non-existent dir → error.
- `validateSuppliedInputs(manifest, supplied): { errors[] }` — unknown
  id, type mismatch, enum value not in `values`, missing required input
  with no default.
- `parseTimeout(s): number | { error }` — `^\d+(s|m)$`; cap
  `MAX_TIMEOUT_MS`.

Tests: `src/shared/pluginManifest.test.ts` (vitest) covers every
validator path, evalIf truthy/falsey, buildEnv ordering + bool
stringification + tilde expansion, resolveCwd `$VAR`/`~`/missing-dir,
validateSuppliedInputs each error mode, parseTimeout each unit + cap.

### macOS PATH gotcha (Electron GUI)

GUI-launched Electron apps do NOT inherit the user's shell PATH.
`Homebrew`/`nvm`-installed `npm`/`npx`/`pod` are invisible to a spawned
child and `exec` fails ENOENT even though the same command works in
Terminal. `capExecutor`'s `exec` builds its env as
`{...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:" + (process.env.PATH ?? "")}`
(Apple Silicon + Intel Homebrew). The ENOENT rejection message tells the
user to install via Homebrew — never silently swallow it.

### Hot reload + registry publish

- The executor `fs.watch`es `~/.manta/plugins/` (debounced 500ms) and
  rescans on change, at startup, and on every SSE (re)connect.
- After every scan, the executor PUTs `/api/plugins/registry` to
  manta-server (Bearer auth, same header helper) with
  `[{name, description, inputs, valid, error?, yaml, stepCount,
  timeoutMs}]` — including INVALID manifests with their error so
  Settings and `plugin_list` can show parse failures.
- Server keeps the registry in-memory only (`src/server/plugins.mjs`);
  the executor republishes on every reconnect, covering server
  restarts. No durable store.
- Adding/editing a YAML does NOT require restarting MantaUI or the
  executor.

### Settings toggle (v3)

Desktop-only. Settings → Plugins → "Run plugins on this machine" toggle
+ Installed plugins list (read from `plugins:registry` window.api
channel) + "Open plugins folder" button (reuses `revealInFolder`).
Default OFF. The helper text carries the trust warning: "Lets the AI
trigger the plugins below — each is a YAML file on this machine; the AI
can also create and edit them when this is on. Takes effect after
restarting MantaUI." `MobileSettings.tsx` is intentionally untouched.

Config: `pluginsEnabled?: boolean` (replaces v2's `capExecutorEnabled`,
`iosBuildRepoPath`, `iosSimulatorName` — all three legacy keys are
dropped on load, NO auto-generation of a manifest from the legacy repo
fields; the user re-authors once via the AI). Migration is a pure
function in `src/shared/configMigration.mjs` (electron-free,
unit-tested).

---

## Trust & security

- **`pluginsEnabled` gate.** The Mac executor runs whatever the manifests
  under `~/.manta/plugins/` say — bigger trust boundary than
  `allowAgentPush`'s "write to Downloads". Default OFF; explicit opt-in
  in Settings with the warning above.
- **Manifest allowlist by folder membership.** The Mac only runs
  capabilities whose manifests parse cleanly AND are physically under
  `~/.manta/plugins/` (the executor is the source of truth — a job
  with an unknown capability name is reported `failed`, never shelled
  out). There is no "run arbitrary command" capability; each plugin is
  the user's YAML.
- **Grammar limits are deliberate.** `if:` is exactly three forms (see
  shared manifest module §) — no `${{ }}`, no operators, no
  functions. Unknown top-level or per-step keys fail validation with
  `unknown key "<key>"`. Refuses expression creep on principle.
- **Inputs flow through env vars, never shell.** Manifest commands
  MUST reference input values via `$MANTA_INPUT_<ID>` (uppercased id),
  not via string-interpolated `run:`. The validator does not block
  interpolation in `run:`, but the runner guarantees no user input
  crosses a shell boundary except via the env-var route (the user's
  manifest is user-controlled, not job-input-controlled).
- **Auth.** Every `/api/cap*` route and `/api/plugins/*` is behind the
  M1 Bearer gate. The AI tools and the Mac executor both authenticate
  with the box token they already hold.
- **Log capping.** `appendLog` ring-buffers to `LOG_CAP_BYTES`; `getJob`
  returns at most `LOG_TAIL_BYTES` — a runaway build can neither fill
  the disk nor blow the AI's context.
- **No zombie jobs.** Server sweep fails out stale `running` (30 min)
  and never-claimed `queued` (24h) jobs and notifies the originating
  session, so a crashed Mac can't leave the AI waiting forever.

---

## Deletion list (a deliverable — verify all gone at the end)

- `src/main/handlers/iosBuild.ts` (309 lines) and
  `src/main/handlers/iosBuild.test.ts`; the empty `handlers/` dir if
  empty after.
- The `HANDLERS` map + `CapHandler` type consumers in `capExecutor.ts`
  (replaced by `plugin.write` built-in + manifest lookup).
- `docs/opencode-tools/ios-build.ts` (and its installed copy on the
  box).
- Config keys `capExecutorEnabled`, `iosBuildRepoPath`,
  `iosSimulatorName` across types/store/Settings/config.
- The Settings Files-tab "Capability executor" block (replaced by
  Settings → Plugins tab from Phase 1).
- Stale `AGENTS.md` / `mantaui-plugins.md` content describing the v1/v2
  TS-handler model.

Verify with `grep -ri
"capExecutorEnabled\|iosBuildRepoPath\|iosSimulatorName\|ios_build\|handlers/iosBuild"
src/ docs/opencode-tools/ docs/mantaui-plugins.md AGENTS.md` returns
nothing.

---

## Why this is a plugin system, not a one-off

| Concern                     | v2 (ios-build)                    | v3 (YAML plugins) |
| --------------------------- | --------------------------------- | ----------------- |
| Plugin shape                | TypeScript handler (one file)     | YAML manifest (one file) |
| Plugin add path             | `cp *.ts` + `HANDLERS[cap]=…`      | write YAML to `~/.manta/plugins/` |
| AI tool surface             | one `ios_build` tool              | six generic `plugin_*` tools |
| Hot reload                  | restart required                  | `fs.watch` + no restart |
| Trust gate                  | `capExecutorEnabled` toggle       | `pluginsEnabled` toggle (same intent) |
| Executor location           | `host:"mac"` field                | `host:"mac"` field (only accepted value in v3) |
| Result routing              | completion turn into session      | unchanged            |
| Spine (`capabilities.mjs`)  | generic                          | byte-identical       |

Adding capability #N is writing one YAML file. The spine, REST, SSE,
auth, queue, sweep, and the runner stay unchanged. That is the
decoupling the plugin system buys, delivered while shipping a working
iOS build bridge as plugin #1.
