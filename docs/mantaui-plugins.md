# MantaUI plugins — design spec (v2, amended after review)

Status: **SPEC / not yet built.** First plugin: `ios-build`.

This is the FINAL design. Every decision is made. The implementer makes NO
design decisions: if something appears ambiguous, re-read this file — the
answer is here. If it is genuinely absent, stop and ask on the issue.

Changes from v1 (all incorporated below, marked ⟨v2⟩ where they alter v1):
executor catch-up on connect (jobs survive an offline Mac), server-side stale-job
sweep + retention, guarded `start` (no double-run), serialized executor, batched
log streaming, `secret()` removed from v1 (was unimplementable cross-machine),
completion routed back into the originating session (no busy-polling), pinned
derived-data/.app path + simulator-UDID resolution + macOS PATH strategy,
explicit branch semantics in the tool description.

## What this is

A **plugin system** that lets MantaUI gain new capabilities the AI can invoke,
where a plugin can execute EITHER on the box (the Linux server) OR on a
connected device (the user's Mac, via the Electron app). The motivating case:
run iOS compilation + simulator launch on the local Mac so we stop burning
Codemagic build minutes — but shaped so `ios-build` is merely **plugin #1**, not
a bespoke feature.

The critical requirement: **a plugin ships its own AI tool(s)**, exactly like
the existing MantaUI-native tools (`serve_page`, `peers_*`, `schedule_*`,
`notify`, `secret_*`). Installing a plugin makes new tools appear to every
opencode session — the AI discovers and calls them the same way it calls
`serve_page` today. A plugin is therefore a *bundle*, not just an executor:

```
a plugin = manifest  +  AI tool(s)  +  handler
           (what it is) (how the AI   (what actually
                         invokes it)   runs, box or Mac)
```

This mirrors and generalizes the "MantaUI-native tools" pattern documented in
`docs/bui-tools-scheduler.md` (§"The pattern"). Every existing native tool is,
in effect, a hardcoded box-executor plugin. This spec makes that pattern
first-class and adds a **Mac executor host** so a plugin's handler can run on
the desktop.

---

## Terminology

- **Capability** — a named unit of work, e.g. `ios.build`. Dotted namespace is
  the capability id. Referenced everywhere at the transport layer as an opaque
  string + an opaque `input` object.
- **Plugin** — a bundle that provides one or more capabilities: a manifest, the
  AI tool(s) that invoke them, and the handler(s) that execute them.
- **Executor host** — the runtime that runs a capability's handler. Two kinds:
  `box` (the Linux server, in-process) and `mac` (the Electron main process on
  the user's desktop).
- **Job** — one invocation of a capability: `{ id, capability, input, host,
  status, log[], result }`, tracked durably on the server through its lifecycle
  (`queued → running → done | failed`).

---

## Architecture (three layers, one generic spine)

```
  ┌──────────────────────────────────────────────────────────────┐
  │ Layer 1 — CAPABILITY JOB QUEUE  (MantaUI server)              │
  │   src/server/capabilities.mjs                                 │
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
  ┌─────┴───────────────────┐        ┌────────┴────────────────────┐
  │ Layer 2 — AI TOOL(S)     │        │ Layer 3 — EXECUTOR HOSTS    │
  │ docs/opencode-tools/     │        │ box: future (sweep handles   │
  │   <plugin>.ts            │        │      expiry meanwhile)      │
  │ thin registrar → /api/cap│        │ mac: src/main/capExecutor.ts │
  │ (same boxToken/auth      │        │      SSE + catch-up list,    │
  │  helpers as schedule.ts) │        │      serialized handler runs,│
  │                          │        │      batched log/done back   │
  └──────────────────────────┘        └──────────────────────────────┘
```

### The one decision that keeps it extraction-ready

**Everything at the transport layer speaks `{ capability, input }` — never
`iosBuild`-specific fields.** The store row, the SSE event, the REST body, and
the executor dispatch are all generic. v1 has exactly one capability
(`ios.build`) and one Mac handler, but the queue, the event `kind`, and the
lifecycle are already generic. Adding capability #2 later touches only:

1. a new tool file in `docs/opencode-tools/`,
2. a new entry in the Mac executor's handler map (or a box handler),

— NOT the queue, the REST surface, the SSE wiring, or the auth. That is the
whole point of building it this way even while "hardcoding" ios-build.

### Constants (single source of truth — declare each ONCE, in the module noted)

| Constant | Value | Module | Meaning |
| --- | --- | --- | --- |
| `LOG_CAP_BYTES` | `256 * 1024` | `capabilities.mjs` | ring-buffer cap on a job's stored log |
| `LOG_TAIL_BYTES` | `16 * 1024` | `capabilities.mjs` | max log bytes returned by `getJob` |
| `SWEEP_INTERVAL_MS` | `60_000` | `capabilities.mjs` | stale-job sweep cadence |
| `RUNNING_TIMEOUT_MS` | `30 * 60_000` | `capabilities.mjs` | `running` older than this → `failed` |
| `QUEUED_EXPIRY_MS` | `24 * 60 * 60_000` | `capabilities.mjs` | `queued` older than this → `failed` |
| `TERMINAL_RETENTION_MS` | `7 * 24 * 60 * 60_000` | `capabilities.mjs` | terminal jobs older than this → pruned |
| `MAX_TERMINAL_JOBS` | `50` | `capabilities.mjs` | keep at most this many terminal jobs (drop oldest) |
| `EXECUTOR_JOB_TIMEOUT_MS` | `25 * 60_000` | `capExecutor.ts` | Mac-side per-job abort (< server's 30 min so the Mac fails first and reports properly) |
| `LOG_FLUSH_MS` | `1_000` | `capExecutor.ts` | executor log-batch flush cadence |
| `EXEC_STDOUT_CAP_BYTES` | `2 * 1024 * 1024` | `capExecutor.ts` | cap on captured stdout returned by `ctx.exec` |
| `KILL_GRACE_MS` | `5_000` | `capExecutor.ts` | SIGTERM → SIGKILL grace on abort |

---

## Layer 1 — server: job queue (`src/server/capabilities.mjs`)

Cloned in shape from `src/server/schedule.mjs`: dependency-injected,
pure-logic-with-injected-I/O, unit-testable without live tmux/opencode/Electron.
Reuse `schedule.mjs`'s exact store pattern: `loadJobs`/`saveJobs` with
`existsSync` guard + corrupt-file-tolerant parse + `atomicWrite` (temp-rename)
+ `mkdir recursive`, `genId()` = `randomBytes(4).toString("hex")`. The
`atomicWrite` helper is currently module-private in `schedule.mjs`;
**consolidate**: move it (and only it) to a tiny shared
`src/server/storeUtils.mjs` exporting `atomicWrite(path, data)`, import it from
BOTH `schedule.mjs` and `capabilities.mjs`, and delete the private copy in
`schedule.mjs`. Do not move `loadJobs`/`saveJobs` (their defaults differ);
mirror their ~10 lines.

### Store

`~/.manta/cap-jobs.json` (build the path exactly like `schedule.mjs` does:
`join(homedir(), STATE_DIRNAME, "cap-jobs.json")` with `STATE_DIRNAME` from
`../shared/paths.mjs`). File shape `{ "jobs": [...] }`. Job shape:

```jsonc
{
  "id": "a1b2c3d4",             // 8-char hex, genId()
  "capability": "ios.build",    // opaque capability id
  "input": { /* opaque */ },    // capability-specific args (validated by tool, not queue)
  "host": "mac",                // "mac" | "box" — which executor should pick it up
  "sessionID": "ses_…",         // originating chat session (completion routed here)
  "directory": "/…",            // originating cwd (context only)
  "status": "queued",           // queued | running | done | failed
  "createdAt": 1234567890,      // Date.now() ms
  "startedAt": null,
  "finishedAt": null,
  "log": [],                    // appended stdout/stderr chunks (ring-buffered)
  "result": null,               // capability-defined result object on done
  "error": null                 // string on failed
}
```

### Functions (all injected-I/O `{load, save, publish, notifySession}`, all unit-tested)

Every function that can fail returns `{ok:false, error}` — never throws for
expected conditions. Follow `schedule.mjs`'s return conventions.

- `createCapJob({capability, input, host, sessionID, directory}, {load, save, publish})`
  — validate: `capability` is a non-empty string; `host` is `"mac"` or `"box"`;
  `sessionID` is a non-empty string. Do NOT validate `input` (the tool owns
  input shape; keeps the queue capability-agnostic). `input` defaults to `{}`,
  `directory` to `""`. Push, save, then
  `publish({kind:"capJob", payload:{id, capability, input, host}})`.
  Returns `{ok:true, job}`.
- `getJob(id, {load})` — returns the job or `null`. ⟨v2⟩ Before returning,
  replace `log` with its TAIL: join the chunks, keep only the last
  `LOG_TAIL_BYTES` characters, return as `log: [tailString]`. Also add
  `logBytes` (total joined length before tailing) so callers can tell it was
  truncated. Never mutate the stored job — copy.
- `listJobs({sessionID, host, status} = {}, {load})` — ⟨v2⟩ all three filters
  optional, AND-combined. Returns jobs **without** the `log` field (replace
  with `logBytes`). This one signature serves the AI, the executor catch-up,
  and a future UI card — one code path.
- `appendLog(id, chunk, {load, save})` — append `String(chunk)` to `log[]`,
  then ring-buffer: while total joined length > `LOG_CAP_BYTES`, drop the
  OLDEST chunk (`log.shift()`). ⟨v2⟩ Returns `{ok:false, error:"job not
  running"}` without saving when the job is missing or not `running` (a late
  flush from a timed-out job must not resurrect it).
- `startJob(id, {load, save})` — ⟨v2⟩ GUARDED claim: only a `queued` job
  transitions to `running` (stamp `startedAt`). Missing job →
  `{ok:false, error:"not found"}`. Wrong status →
  `{ok:false, error:"not queued", status}`. This is the executor's dedup: a
  job delivered twice (SSE + catch-up list) is claimed once.
- `completeJob(id, {status, result, error}, {load, save, publish, notifySession})`
  — `status` must be `"done"` or `"failed"` (else `{ok:false,error}`). ⟨v2⟩
  Idempotent: if the job is already terminal, return
  `{ok:true, alreadyTerminal:true}` WITHOUT saving, publishing, or notifying.
  Otherwise stamp `finishedAt`, set `result`/`error`, save,
  `publish({kind:"cap.updated", payload:{id, status, sessionID}})`, and ⟨v2⟩
  if `job.sessionID` is set call
  `notifySession?.({sessionID: job.sessionID, text: completionText(job)})`
  (await it, swallow+log failures like the scheduler's fire path — a dead
  session must not fail the REST call).
- `completionText(job)` — pure, exported, tested. Returns:
  `[MantaUI capability job] ${job.capability} job ${job.id} finished with status "${job.status}".`
  plus, when failed, ` Error: ${job.error}.` plus always
  ` Check the job's status tool (e.g. ios_build_status("${job.id}")) for the log tail, then report the outcome to the user.`
- `sweepCapJobs({load, save, publish, notifySession, now = Date.now})` — ⟨v2⟩
  one pass, one save. For each job:
  - `running` and `now() - startedAt > RUNNING_TIMEOUT_MS` → terminal
    `failed`, error `"timed out after 30 minutes (Mac executor lost?)"` —
    apply the SAME terminal transition as `completeJob` (factor a private
    `markTerminal(job, {status, error, result}, nowMs)` used by both, so
    there is exactly one place that stamps `finishedAt`; publish + notify per
    transitioned job, same as `completeJob`).
  - `queued` and `now() - createdAt > QUEUED_EXPIRY_MS` → terminal `failed`,
    error `"expired: no executor picked this job up within 24h (is the Mac
    app running with the capability executor enabled?)"` — publish + notify.
  - Retention: after transitions, drop terminal jobs with
    `finishedAt < now() - TERMINAL_RETENTION_MS`; then, if more than
    `MAX_TERMINAL_JOBS` terminal jobs remain, drop the oldest (by
    `finishedAt`) down to the cap. Dropped jobs are silent (no publish).
  Save only if anything changed.
- `startCapSweeper({publish, notifySession}, {intervalMs = SWEEP_INTERVAL_MS, storePath})`
  — clone `startSchedulePoller`'s shape EXACTLY: build the deps with
  path-bound `load`/`save`, run once immediately, `setInterval` +
  `timer.unref()`, inFlight re-entrancy guard (put the guard inside
  `sweepCapJobs`'s wrapper the same way `createScheduler().tick` does),
  return `{stop}`.

### REST endpoints (wired in `src/server/index.mjs`, behind the auth gate)

All under the existing `Authorization: Bearer <box_token>` gate
(`src/server/auth.mjs`) — `/api/*` is already gated wholesale; add NO
exemption. Follow the exact routing style of the `/api/schedule` block in
`index.mjs` (path check → method check → `readJsonBody` → `respondJson`; 400
on `{ok:false}`, 500 in catch, 405 fallthrough). Route matching: exact
`path === "/api/cap"` for create/list, and one regex
`^\/api\/cap\/([0-9a-f]{8})(?:\/(start|log|done))?$` for the rest.

| Method | Path                  | Body                            | Response | Who calls it |
| ------ | --------------------- | ------------------------------- | -------- | ------------ |
| POST   | `/api/cap`            | `{capability,input,host,sessionID,directory}` | `{id}` | AI tool |
| GET    | `/api/cap/:id`        | —                               | job (log tailed) or 404 `{error:"not found"}` | AI status tool |
| GET    | `/api/cap?sessionID=&host=&status=` | —                 | `{jobs:[…]}` (no logs) | executor catch-up, future UI |
| POST   | `/api/cap/:id/start`  | —                               | `{ok:true}` or 409 `{error,status}` | Mac executor |
| POST   | `/api/cap/:id/log`    | `{chunk}`                       | `{ok:true}` or 409 `{error}` | Mac executor (batched) |
| POST   | `/api/cap/:id/done`   | `{status,result?,error?}`       | `{ok:true}` | Mac executor + AI-visible failures |

Wiring in `index.mjs`:
- Import next to the schedule imports; reuse `BUS_PUBLISH_DEPS` where only
  `publish` is needed.
- `notifySession` dep = `({sessionID, text}) => oc.sendPrompt({sessionId:
  sessionID, text})` — the EXACT mechanism `startSchedulePoller` already uses
  (see its wiring ~line 132). Note the injected turn streams into the user's
  open ChatPanel as a fresh turn; if the session happens to be mid-turn,
  opencode's implicit-abort behavior applies — identical to a firing schedule,
  accepted.
- Start `startCapSweeper({publish, notifySession})` right next to
  `startSchedulePoller(...)`; capture and call its `stop` where the schedule
  poller's `stop` is called.
- Add `"capJob"` and `"cap.updated"` to the envelope-kind comment at the top
  of `src/server/events.mjs` (comment only — the bus is generic; no code
  change there).

### Box executor (future, not v1)

No box-executor plugins in v1 and NO stub code for them — the sweep's
queued-expiry covers a `host:"box"` job someone creates by accident. When the
first box plugin lands, a `startCapPoller` mirroring `startSchedulePoller`
will claim `host:"box"` jobs via the same `startJob`/`appendLog`/`completeJob`
— which is why those are host-agnostic.

### Tests — `src/server/capabilities.test.mjs`

node:test, in-memory `load`/`save` (an array in a closure), recorded
`publish`/`notifySession` calls. Follow `src/server/schedule.test.mjs`'s
assertion style. MUST cover:
- create → start → appendLog×N → done lifecycle; timestamps stamped; bus
  events `capJob` then `cap.updated` recorded; `notifySession` called once
  with `completionText` output.
- create validation: empty capability, bad host, missing sessionID all
  `{ok:false}`.
- `getJob` log tail: log > `LOG_TAIL_BYTES` returns only the tail +
  `logBytes` = full size; stored job unchanged.
- `appendLog` ring-buffer: total stays ≤ `LOG_CAP_BYTES`, oldest chunks
  dropped first; append to a `queued` or terminal job → `{ok:false}`.
- `startJob` guard: second start → `{ok:false, status:"running"}`; start on
  terminal → `{ok:false}`.
- `completeJob` idempotency: second call → `{ok:true, alreadyTerminal:true}`,
  NO second publish/notify.
- `listJobs` filters: by host, by status, by sessionID, combined; no `log`
  field in results.
- `sweepCapJobs`: stale `running` → failed + notify; ancient `queued` →
  failed + notify; retention prunes old terminal jobs and enforces
  `MAX_TERMINAL_JOBS`; a fresh `running` job is untouched; no-change pass
  does not save.
- `completionText` formatting (done + failed variants).

---

## Layer 2 — AI tools (`docs/opencode-tools/`)

**This is the "plugins register their own tools" requirement.** Each plugin
contributes a tool file, installed exactly like the existing native tools:
COPIED (never symlinked — the `@opencode-ai/plugin` import-resolution gotcha in
`docs/bui-tools-scheduler.md` §"DO NOT symlink") into
`~/.config/opencode/tools/`, then `systemctl --user restart opencode-serve`.

### v1 — `docs/opencode-tools/ios-build.ts`

Clone `docs/opencode-tools/schedule.ts`. Copy the `MANTA_SERVER` const and the
`boxToken()` / `authHeaders()` / `call()` helpers **VERBATIM** — the
auth-header plumbing is mandatory; a native tool without it 401s against the M1
gate. Two named exports → tools `ios_build` and `ios_build_status`.

```ts
export const ios_build = tool({
  description: [
    "Compile the MantaUI iOS app on the connected Mac and boot it in the iOS",
    "Simulator. Use when the user asks to build/run/test the iOS app locally",
    "instead of on Codemagic. IMPORTANT — what gets built: the Mac's own git",
    "clone (tracking origin/main), NOT this session's working tree or branch.",
    "If the user wants their current changes built, they must be merged/pushed",
    "to origin/main first, then call with pull:true. The Mac must be awake",
    "with the MantaUI app running and the capability executor enabled in",
    "Settings. Returns a job id immediately. Do NOT poll in a loop: when the",
    "job finishes (or fails/times out), a completion message is injected into",
    "this session automatically as a new turn. Use ios_build_status only if",
    "the user asks for progress mid-build.",
  ].join(" "),
  args: {
    action: z.enum(["build-and-launch", "test", "compile-only"]).optional()
      .describe("build-and-launch (default): compile + boot simulator + launch app; test: run xcodebuild test; compile-only: just compile, no simulator."),
    pull: z.boolean().optional()
      .describe("Run `git pull --ff-only origin main` in the Mac clone before building (default false)."),
  },
  async execute(args, context) {
    const r = await call("POST", "/api/cap", {
      capability: "ios.build",
      host: "mac",
      input: { action: args.action ?? "build-and-launch", pull: !!args.pull },
      sessionID: context.sessionID,
      directory: context.directory,
    });
    return `iOS build queued on the Mac (job ${r.id}). You will be notified in this session when it finishes — do not poll.`;
  },
});

export const ios_build_status = tool({
  description:
    "Check an iOS build job: status (queued/running/done/failed) + the tail of " +
    "the build log. Use the job id returned by ios_build. Prefer waiting for " +
    "the automatic completion message; use this only for mid-build progress " +
    "or after completion to inspect the log.",
  args: { id: z.string().describe("The job id from ios_build.") },
  async execute(args) {
    const j = await call("GET", `/api/cap/${encodeURIComponent(args.id)}`);
    const tail = (j.log?.join("") ?? "").split("\n").slice(-50).join("\n");
    const head = `Job ${j.id} (${j.capability}) — ${j.status}` +
      (j.error ? ` — ${j.error}` : "");
    return tail ? `${head}\n\n--- log tail ---\n${tail}` : head;
  },
});
```

Note: the tool is **capability-agnostic underneath** — it POSTs the generic
`{capability, input, host}` envelope. The `ios.build` string and `host:"mac"`
are the only ios-specific bits, which is exactly what a future generic
`cap_invoke(capability, input)` tool would take as arguments.

### Guidance blurb

Append a `## MantaUI iOS build` section to `docs/opencode-tools/AGENTS.md`
(mirror the tone/length of the existing sections). It must state:
- reach for `ios_build` when the user asks to build/run/test the iOS app
  locally or to avoid Codemagic minutes;
- it builds the **Mac clone tracking origin/main** — push/merge first if the
  user wants their current changes, then `pull:true`;
- requires the Mac awake with MantaUI running and the executor enabled;
- do NOT poll in a loop — completion arrives automatically as a new turn;
  `ios_build_status(id)` is for user-requested progress checks only.

Install step (same as every tool): copy the `.ts` to
`~/.config/opencode/tools/`, append the blurb to `~/.config/opencode/AGENTS.md`,
`systemctl --user restart opencode-serve`.

### How this generalizes to "plugins ship tools"

The registry-driven end state (post-v1): a plugin directory carries its tool
file, and installing the plugin copies that `.ts` into
`~/.config/opencode/tools/` + appends its AGENTS.md fragment + registers its
manifest. A generic `cap_list` tool then reports live-available capabilities so
the model always sees what is installed AND online. v1 skips `cap_list` (only
one capability) but the tool→`/api/cap`→queue path is already the generic
spine that `cap_list`/`cap_invoke` will reuse unchanged.

---

## Layer 3 — Mac executor

### Shared SSE consumer — consolidation FIRST ⟨v2⟩

`src/main/desktopNotify.ts` already contains the exact SSE plumbing the
executor needs (Bearer-authed long-lived `GET /events`, 3s auto-reconnect,
`\n\n` frame splitting, `data:` line parse). Do NOT copy it a second time —
**extract it**:

1. NEW `src/main/busConsumer.ts` exporting:
   ```ts
   export function createBusConsumer(
     configGetter: () => AppConfig,
     onEnvelope: (env: { kind?: string; payload?: unknown }) => void,
   ): { stop(): void }
   ```
   Move the `connect`/`scheduleReconnect`/frame-buffer/`handleFrame` logic
   from `desktopNotify.ts` verbatim, minus the `kind === "desktopNotify"`
   filter — `handleFrame` parses the envelope and calls `onEnvelope` with
   EVERY well-formed envelope. Instance state (no module-level singletons):
   the returned `stop()` destroys the current response + cancels the timer.
2. REWRITE `desktopNotify.ts` as a thin consumer: `startDesktopNotifications`
   calls `createBusConsumer(configGetter, (env) => { if (env.kind ===
   "desktopNotify" && env.payload) deliver(env.payload) })`. Its public API
   (`startDesktopNotifications`/`stopDesktopNotifications`) is unchanged —
   callers in `src/main/index.ts` untouched. Net: `desktopNotify.ts` shrinks
   from ~150 to ~40 lines.
3. `capExecutor.ts` uses the same `createBusConsumer`. One SSE code path,
   two one-kind filters.

### `src/main/capExecutor.ts`

```ts
export function startCapExecutor(configGetter: () => AppConfig): { stop(): void }
```

- **Gate**: if `configGetter().capExecutorEnabled` is not `true` at start,
  return a no-op `{stop(){}}` immediately. Toggling the setting takes effect
  on next app launch (the Settings UI says so) — no live start/stop plumbing.
- **Subscribe**: `createBusConsumer(configGetter, onEnvelope)`. In
  `onEnvelope`, act ONLY on `kind === "capJob"` with `payload.host === "mac"`;
  ignore everything else. Enqueue `{id, capability}` from the payload.
- **Catch-up ⟨v2⟩ — jobs must survive an offline Mac.** SSE has no replay, so
  on start AND after every reconnect, fetch
  `GET /api/cap?host=mac&status=queued` (Bearer-authed, same
  serverUrl/boxToken as the consumer) and enqueue every returned job.
  Detecting reconnect: `createBusConsumer` gains an optional third argument
  `onConnect?: () => void`, invoked whenever a stream reaches status 200
  (desktopNotify simply doesn't pass one). Run catch-up from `onConnect`.
- **Serial queue + dedup ⟨v2⟩.** In-memory FIFO of job ids; a `Set<string>`
  of every id ever enqueued (skip duplicates — the same job WILL arrive via
  both SSE and catch-up). Process strictly one job at a time (a single
  promise chain; never two handlers concurrently — two parallel xcodebuilds
  corrupt shared derived data).
- **Per job:**
  1. `POST /api/cap/:id/start`. On non-2xx (409 = already claimed/stale):
     log one line, skip the job. This is the cross-delivery dedup.
  2. Look up `HANDLERS[capability]`. Unknown →
     `POST /api/cap/:id/done {status:"failed", error:`unknown capability "${capability}"`}`
     and continue. **Never** shell out for an unlisted capability.
  3. Build the `CapCtx` (below) with an `AbortController`; arm a
     `setTimeout(EXECUTOR_JOB_TIMEOUT_MS)` (unref'd) that calls `abort()`.
  4. `await handler(ctx)` → `POST done {status:"done", result}`. Throw (or
     abort) → `POST done {status:"failed", error: String(e?.message ?? e)}`.
  5. Always: clear the timeout, final log flush BEFORE the done POST.
- **Batched log streaming ⟨v2⟩.** `ctx.log(line)` appends to an in-memory
  string buffer. A `setInterval(LOG_FLUSH_MS)` (unref'd, per job) flushes the
  buffer as ONE `POST /api/cap/:id/log {chunk}` when non-empty. Final flush
  before done. Never one POST per line — xcodebuild emits thousands.
- All HTTP uses `fetch` with `Authorization: Bearer <boxToken>` from config,
  mirroring `desktopNotify`'s header construction. Failed log POSTs are
  logged and dropped (never crash a running build over a lost log chunk);
  a failed `done` POST is retried once after 5s, then logged and dropped
  (the server sweep will time the job out).

```ts
// THE PLUGIN SEAM. v1 = one entry. Later = built from a plugin registry.
const HANDLERS: Record<string, CapHandler> = {
  "ios.build": iosBuildHandler,
};
```

### The handler context ⟨v2 — `secret()` removed⟩

```ts
interface CapCtx {
  input: unknown;                         // the job's opaque input
  config: AppConfig;                      // snapshot at job start (repo path, sim name)
  log(line: string): void;                // buffered → POST /api/cap/:id/log
  exec(cmd: string, args: string[],
       opts?: { cwd?: string; quiet?: boolean }): Promise<{ code: number; stdout: string }>;
  signal: AbortSignal;                    // job timeout (armed by the executor)
}
type CapHandler = (ctx: CapCtx) => Promise<{ result?: unknown }>; // throw → failed
```

- `exec` spawns via `child_process.spawn(cmd, args, {cwd, env})` — argv
  array, NEVER a shell string. It:
  - streams every stdout+stderr line to `ctx.log` (skipped when
    `opts.quiet === true` — used for machine-readable output like
    `simctl list --json` that would pollute the job log);
  - accumulates stdout into a string capped at `EXEC_STDOUT_CAP_BYTES`
    (keep the most recent bytes) and returns it as `stdout`;
  - resolves `{code, stdout}` on close — it does NOT throw on non-zero exit
    (handlers decide); it rejects only on spawn failure (`error` event, e.g.
    ENOENT) with a message that includes the command name and the PATH hint
    below;
  - on `ctx.signal` abort: `child.kill("SIGTERM")`, then `SIGKILL` after
    `KILL_GRACE_MS` if still alive, and rejects with `"job timed out"`.
- **macOS PATH ⟨v2⟩ — a GUI-launched Electron app does NOT inherit the user's
  shell PATH**, so `npm`/`npx`/`pod` from Homebrew/nvm are invisible and
  `spawn` fails ENOENT even though the same command works in Terminal. `exec`
  builds its env as
  `{...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:" + (process.env.PATH ?? "")}`
  (covers Homebrew on Apple Silicon + Intel). The ENOENT rejection message
  must say: `"<cmd> not found on PATH — install it via Homebrew (nvm-only
  node installs are not visible to GUI apps)"`.
- **`secret()` is NOT in v1.** The v1 spec's `secret(key)` was unimplementable
  as written: the secrets store materializes values to files ON THE BOX, and a
  box file path is useless to a handler running on the Mac. No v1 capability
  needs a secret (simulator builds are unsigned). Do not add a stub method.
  Future design (v2, when a capability needs it): an authed
  `POST /api/secrets/provide-value` endpoint returns the VALUE over HTTPS and
  the Mac writes its own 0600 tmpfile, returning that local path — value
  transits TLS once, never the transcript. Out of scope now.

Wire `startCapExecutor(getConfig)` in `src/main/index.ts` right next to
`startDesktopNotifications(...)`, mirroring its start/stop lifecycle exactly.

### `ios.build` handler (`src/main/handlers/iosBuild.ts`) — the ONLY ios-specific file

Every step streams to `ctx.log` and throws `new Error("<step>: exit <code>")`
on a non-zero exit (except where noted). Steps:

0. **Precheck.** `exec("xcodebuild", ["-version"])` and
   `exec("npm", ["--version"])`. Failure/ENOENT → the error propagates with
   the PATH hint; this fails fast before any long work.
1. **Repo path.** `repo = ctx.config.iosBuildRepoPath?.trim() ||
   "~/projects/better-ui"`, then expand a leading `~` against `os.homedir()`
   (one local `expandTilde`; do not import server code into main).
2. **Pull (optional).** If `ctx.input.pull` is truthy:
   `exec("git", ["-C", repo, "pull", "--ff-only", "origin", "main"])`.
3. **Web bundle.** `exec("npm", ["run", "build:mobile"], {cwd: repo})`, then
   `exec("npx", ["cap", "sync", "ios"], {cwd: repo})` — the web bundle must
   exist before the Capacitor build (AGENTS.md §"MOBILE CHANGES REACH
   DEVICES…"). `cap sync` runs `pod install`; CocoaPods must be installed on
   the Mac (its failure output streams to the log — no special handling).
4. **Simulator resolution ⟨v2⟩.**
   `exec("xcrun", ["simctl", "list", "devices", "available", "--json"], {quiet:true})`,
   `JSON.parse(stdout)`, then `pickSimulator(parsed, ctx.config.iosSimulatorName)`:
   - **`pickSimulator(devicesJson, preferredName)` is a pure exported
     function in this file, unit-tested** (`src/main/handlers/iosBuild.test.ts`,
     vitest — `src/main/**` is collected; only `src/server/**` is excluded).
   - Flatten `devicesJson.devices` entries whose runtime key contains
     `"SimRuntime.iOS"`; keep devices with `isAvailable !== false`.
   - If `preferredName` is set: candidates = exact `name` matches; empty →
     return `{error}` listing all available names (the handler throws it —
     the user sees actionable output).
   - Else candidates = all flattened devices.
   - Pick: first with `state === "Booted"`; else sort by iOS runtime version
     descending (parse `iOS-17-5` → `[17,5]` from the runtime key) and take
     the first whose `name` starts with `"iPhone"`; else the first candidate;
     none at all → `{error:"no iOS simulators available — install one in
     Xcode"}`.
   - Returns `{udid, name}` on success.
5. **Build.** Compute
   `derivedData = join(os.homedir(), "Library", "Caches", "MantaUI", "DerivedData")`.
   `exec("xcodebuild", ["-workspace", join(repo, "mobile/ios/App/App.xcworkspace"),
   "-scheme", "App", "-sdk", "iphonesimulator", "-configuration", "Debug",
   "-destination", `platform=iOS Simulator,id=${udid}`,
   "-derivedDataPath", derivedData, "build"], {cwd: repo})`.
   Simulator SDK = **no signing** (the distribution-cert saga is Codemagic's
   problem, not ours). The `.app` lands at the PINNED path
   `appPath = join(derivedData, "Build", "Products", "Debug-iphonesimulator", "App.app")`
   — verify with `fs.existsSync(appPath)` after the build; missing → throw
   `"build succeeded but App.app not found at <path>"`.
   - `action === "test"`: replace `"build"` with `"test"` in the argv, skip
     steps 6, return `{result: {tested: true, simUdid: udid}}`.
   - `action === "compile-only"`: same argv as build, skip step 6, return
     `{result: {appPath, launched: false}}`.
6. **Boot + launch** (default `build-and-launch` only).
   - `exec("xcrun", ["simctl", "boot", udid])` — IGNORE the exit code
     ("already booted" exits non-zero; that is fine).
   - `exec("open", ["-a", "Simulator"])` — non-zero → throw (needs a GUI
     session; error surfaces that).
   - `exec("xcrun", ["simctl", "install", udid, appPath])` — non-zero → throw.
   - `exec("xcrun", ["simctl", "launch", udid, "com.antoinedc.mantaui"])`
     (bundle id per AGENTS.md §"App Store Connect facts") — non-zero → throw.
   - Return `{result: {appPath, simUdid: udid, launched: true}}`.

Keep the `action` branches inside this one file — do NOT leak action handling
into `capExecutor.ts`. Use only node builtins (`child_process`, `fs`, `os`,
`path`). No new dependencies.

Out of scope, deliberately (do not build): building arbitrary refs/branches
(`pull` is main-only; the tool description carries the warning), cancel from
the UI/AI, device (non-simulator) builds, `secret()`.

---

## New config fields

`AppConfig` (`src/shared/types.ts`) additions, persisted via the EXISTING
`configGet`/`configUpdate` channels (NO new IPC/RPC channel), defaults handled
where existing optional fields are defaulted in `src/main/config.ts`:

- `iosBuildRepoPath?: string` — absolute path to the Mac's MantaUI clone
  (default `~/projects/better-ui`).
- `iosSimulatorName?: string` — exact simulator device name (e.g.
  `"iPhone 15"`); empty/absent = auto-pick per `pickSimulator`.
- `capExecutorEnabled?: boolean` — master switch for the Mac executor.
  Default `false` (OFF).

Device-local (NOT in `sharedConfig.mjs` `SHARED_CONFIG_KEYS`) — these describe
THIS Mac and must not sync to other devices.

Settings UI (`Settings.tsx`, desktop only — NOT `MobileSettings.tsx`): one
toggle + two text fields in the existing card/row style. The toggle's helper
text MUST include: a trust warning ("Allows the AI to run build commands on
this Mac" — same spirit as `allowAgentPush`) and "takes effect after
restarting MantaUI".

---

## Trust & security

- **`capExecutorEnabled` gate.** The Mac executor runs commands the AI queued —
  a bigger trust boundary than `allowAgentPush`'s "write to Downloads".
  Default OFF; explicit opt-in in Settings with the warning above.
- **Handler allowlist.** The Mac only runs capabilities in its static
  `HANDLERS` map — an unknown `capability` string is reported `failed`, never
  shelled out. There is no "run arbitrary command" capability; each capability
  is a vetted handler in the repo. `exec` takes argv arrays only — no shell
  strings anywhere.
- **No secret values.** v1 has no `secret()` (see above). Nothing in the
  executor or handlers reads or logs credential values.
- **Auth.** Every `/api/cap*` route is behind the M1 Bearer gate. The AI tool
  and the Mac executor both authenticate with the box token they already hold.
- **Log capping.** `appendLog` ring-buffers to `LOG_CAP_BYTES`; `getJob`
  returns at most `LOG_TAIL_BYTES` — a runaway build can neither fill the
  disk nor blow the AI's context.
- **No zombie jobs.** Server sweep fails out stale `running` (30 min) and
  never-claimed `queued` (24h) jobs and notifies the originating session, so
  a crashed Mac can't leave the AI waiting forever.

---

## Staging (delivery)

- **Stage 1 (box-only, fully testable now):** `capabilities.mjs` + tests +
  `storeUtils.mjs` extraction + `/api/cap*` REST + sweeper wiring +
  `ios-build.ts` tool + AGENTS.md blurb + tool INSTALLED on the box and
  verified registered. No Mac needed — a created job sits `queued` (and the
  24h sweep would eventually expire it).
- **Stage 2 (needs the Mac):** `busConsumer.ts` extraction +
  `capExecutor.ts` + `handlers/iosBuild.ts` (+ its vitest) + config fields +
  Settings toggle + repo `AGENTS.md` section. Verified live on the Mac.

Each stage is independently reviewable. Stage 1 lands the generic spine;
Stage 2 proves the Mac executor + the first real plugin.

---

## Why this is a plugin system, not a one-off

| Concern                     | v1 (ios-build)                    | Generic end state (mechanical delta) |
| --------------------------- | -------------------------------- | ------------------------------------ |
| Job transport               | `{capability,input,host}` generic| unchanged                            |
| AI tool                     | `ios_build` (hardcodes `ios.build`)| `cap_invoke(capability,input)` + `cap_list` |
| Tool discovery              | static (1 tool file)             | plugin dir copies its tool + AGENTS fragment |
| Mac dispatch                | static `HANDLERS` map (1 entry)  | map built from installed plugin manifests |
| Availability to the model   | implicit                         | `cap_list` reflects announced+online capabilities |
| Executor location           | `host:"mac"` field               | unchanged (box/mac already both modeled) |
| Result routing              | completion turn into session     | unchanged                            |

Adding capability #2 = drop a tool file + add a handler entry. No core changes.
That is the decoupling the plugin system buys, delivered while shipping a
working iOS build bridge as plugin #1.
