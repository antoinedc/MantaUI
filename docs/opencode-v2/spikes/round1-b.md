# Spike B — OpenCode V2 migration feasibility for MantaUI

V2 binary: `opencode v2.0.30` (standalone, `opencode-linux-x64.tar.gz`), run fully
isolated under `/home/dev/v2spike/b/home` with its own XDG dirs. Server launched with
`opencode serve --hostname 127.0.0.1 --port 4197`. Live V1 (`opencode-serve`) untouched.

## B0. Auth (prerequisite — V2 requires auth, V1 did not)

**Answer.** The V2 server mints a random **server password** at startup, printed to its
log: `server listening on http://127.0.0.1:4197` then `server password <token>`. Every
`/api/*` route returns **HTTP 401 `{"_tag":"UnauthorizedError"}`** without it.

The wire format is **HTTP Basic auth** with a FIXED username `opencode` and the password
as the secret:  `Authorization: Basic base64("opencode:<password>")`.
The CLI reads the password from the **`OPENCODE_PASSWORD`** env var (error text when
missing: *"Server … requires a password; set OPENCODE_PASSWORD"*). SSE (`/api/event`)
needs the same Basic header — no `?token=` query fallback was found (unlike V1, which
accepted `?token=` on EventSource).

**Evidence.**
- Sniffed the CLI's own request via a logging proxy:
  `Authorization: Basic b3BlbmNvZGU6a1paeWdK...` → base64-decodes to `opencode:kZZyg...`.
- `curl -u "opencode:$PW" /api/info` → 200; no header → 401.
- OpenAPI declares `security: []` and empty `securitySchemes` — auth is undocumented in
  the spec; discovered live.

**Confidence.** Verified.

**Manta impact.** NEW, load-bearing. Manta's V1 proxy (`src/server/opencode.mjs`) opens
unauthenticated HTTP + SSE to `127.0.0.1:4096`. On V2 it must (a) capture the per-launch
server password (parse stdout, or set `OPENCODE_PASSWORD` itself when it spawns the
service) and (b) send `Authorization: Basic opencode:<pw>` on EVERY request AND on the
SSE stream. Browsers can't set headers on `EventSource`, but Manta's SSE is consumed
server-side (manta-server → opencode), so a Node fetch/undici stream with the header
works. Pairing (`POST /api/pair` → 6-digit code, `/auth/connect/{code}`) is an
alternative device-pairing path but the password env var is simpler for a co-located
spawn.

Model for live calls: `anthropic/claude-haiku-4-5` (anthropic provider present,
activation=auto, keyed by `ANTHROPIC_API_KEY` in the launch env).

## B1. Event catalogue (MANDATORY)

**Answer.** V2's SSE is `GET /api/event`, format `data: {json}\n\n` with `: heartbeat`
keepalives. Each event is `{id, created, type, data, location?}`. **25 distinct types**
observed in one multi-step turn (text stream + slow shell + edit + file-write + subagent).
A per-session log stream exists at `GET /api/experimental/session/{id}/log?follow=true`
(see B4). Model is set per-session via `POST /api/session/{id}/model` (`{model:{providerID,id}}`,
`id` NOT `modelID`); the prompt body has **no model field**. The prompt POST returns
immediately (~200, enqueues to the inbox) — it does NOT block to completion.

### Event table (observed)
| type | carries | notes |
|---|---|---|
| `server.connected` | — | first SSE frame |
| `project.updated` | — | project meta |
| `session.created` | `data.sessionID`, **`data.parentID`**, `agent`, `title`, `model`, `slug` | **subagent child announced here** (parentID set) |
| `session.renamed` | `data.sessionID` | auto-title |
| `session.inbox.enqueued` | `data.sessionID`, `inboxID`, `item` | user/synthetic msg queued |
| `session.inbox.delivered` | `data.sessionID`, `inboxID` | dequeued into the run |
| `session.execution.started` / `.succeeded` | `data.sessionID` | turn boundary (replaces V1 session.status busy/idle) |
| `session.instructions.updated` | `data.sessionID`, `delta` | system-prompt/instruction deltas |
| `session.step.started` | `sessionID`, `assistantMessageID`, `agent`, `model` | per model step; agent="build"/"explore" |
| `session.step.streamed` / `.ended` | `sessionID`, `assistantMessageID` | step lifecycle |
| `session.text.started` / `.delta` / `.ended` | `sessionID`, `assistantMessageID`, `delta` | **assistant text** |
| `session.reasoning.started` / `.delta` | `sessionID`, `assistantMessageID` | thinking tokens (separate stream from text) |
| `session.tool.input.started` | `sessionID`, `assistantMessageID`, `id`(toolu_), `name` | tool name here |
| `session.tool.input.ended` | same | input args complete |
| `session.tool.called` | `sessionID`, `assistantMessageID`, `id`, `input`, `executed` | tool invoked with full input |
| `session.tool.progress` | `sessionID`, `assistantMessageID`, `id`, `metadata` | **pointer only** — `metadata.shellID` (shell) or `metadata.sessionID`+`status` (subagent). NO live stdout inline. |
| `session.tool.success` | `sessionID`, `assistantMessageID`, `id`, **`content[].text`**, `metadata{exit,truncated,status}` | FINAL tool output lands here |
| `session.tool.failed` | same shape | tool error |
| `session.usage.updated` | `data.sessionID` | token/cost snapshot (replaces V1 step.ended tokens) |
| `shell.created` | `data.info{id,command,cwd,shell,file,status}` (sessionID under `info.metadata`) | a shell tool spawns a tracked shell resource |
| `shell.exited` | `data.{id,exit,status}` | shell done |
| `models-dev.refreshed`, `integration/provider/model/agent/command/skill/websearch/reference/plugin.updated` | — | registry-refresh events at startup |

### Key differences vs V1 (Manta's assumptions)
- **Field path is UNIFORM: `data.sessionID` + `data.assistantMessageID`** everywhere.
  V1 had messageID at varying paths (`properties.part.messageID` vs `properties.messageID`),
  which Manta works around with a 3-way fallback — **that whole hack goes away.**
- **Text deltas are phrase/sentence chunks, NOT char-level.** Observed deltas like
  `"Hello! I'm ready to help you with these tasks.\n\nLet"`. Manta's `findFlushBoundary`
  buffering (built to de-jitter V1's char-level deltas) is largely unnecessary — V2
  already coalesces. Reasoning deltas are a SEPARATE event (`session.reasoning.delta`),
  cleanly split from text (V1 mixed them in `message.part.delta`).
- **Live shell stdout moved OUT of the event stream.** V1 streamed live bash output in
  `message.part.updated` → `state.metadata.output` (~30ms cadence). V2's `tool.progress`
  carries only a `shellID` pointer; **live output is fetched via `GET /api/shell/{shellID}/output`**
  → `{output, cursor, size, truncated}` (verified streaming mid-run: 3 lines at t+4s, 7 at t+8s).
  Final output also appears in `tool.success.content`. **This is the single biggest
  Manta rewrite in B1: the live-bash-tailing path (messageID+debounce machinery) must be
  replaced by polling/cursoring `/api/shell/{id}/output` keyed off `tool.progress.metadata.shellID`.**
- **Tool name** is in `tool.input.started.data.name` (not nested in a part's `state`).
- **Subagent announcement is CLEANER:** `session.created` with `data.parentID` +
  `agent` + `title` + `model`, and child events interleave on the same global stream with
  the child's sessionID. Manta's `collectChildSessionIds` / `registerChildSessionFromCreated`
  simplify to "watch `session.created` for a matching parentID". Subagent progress also
  surfaces via parent `tool.progress.metadata.sessionID` + `status`.
- **No `todo.updated` event observed.** Haiku wrote a `TODO.md` file instead of calling a
  todo tool (may be model/agent-dependent; V2 "build" agent may not expose the TodoWrite
  tool by default). Needs confirmation with an agent that has the todo tool — Manta's
  `liveTodos`/`ActiveTodos` card depends on this; **flagged as a gap to verify.**
- **No `session.compacted` / `command.executed` observed in this turn** (compaction tested
  in B7; commands not exercised).
- **Turn boundary events renamed:** V1 `session.status`(busy/idle)+`session.idle` →
  V2 `session.execution.started`/`session.execution.succeeded` (+ `session.active` endpoint).

**Evidence.** `artifacts/b1b_event.ndjson` (1140 lines, 25 types). Live shell poll:
`GET /api/shell/sh_.../output` returned incrementally growing `output` with a `cursor`.
Subagent `session.created`: `parentID=ses_...jlm5zi, agent=explore, title="Find all Python files"`.

**Confidence.** Verified (live multi-step turn on anthropic/claude-haiku-4-5).

**Manta impact.** Moderate-to-large but mostly SIMPLIFYING. Wins: uniform field paths,
coarser text deltas (drop the flush-boundary buffer), clean subagent model. Costs:
(1) **rewrite live-shell-output** from event-embedded to `/api/shell/{id}/output` cursoring;
(2) re-map the turn-boundary + token-usage + error event names; (3) **verify the todo tool/event
exists** for a non-explore agent or the ActiveTodos card breaks; (4) reasoning now a distinct
stream to render separately.

## B2. Steer vs queue (native in-turn messaging)

**Answer.** V2 has first-class in-turn message delivery via the session **inbox**, with
two delivery modes on `POST /api/session/{id}/prompt`:
- **`delivery:"queue"`** — the message waits in the inbox; delivered as a fresh execution
  after the current turn ends.
- **`delivery:"steer"`** — the message is injected INTO the running turn (same execution).
- Default when omitted: **`steer`** (observed on the plain B1 prompt → `"delivery":"steer"`).

The full lifecycle is event-driven and **emits NO abort/interrupt/error at any point**:
`session.inbox.enqueued` → `session.inbox.delivered` (normal). Mutations:
- `PATCH /api/session/{id}/inbox/{inboxID}` `{delivery:"steer"}` → **204**, emits
  `session.inbox.delivery.changed {inboxID, delivery}`. Verified queue→steer, and the
  item then `delivered` within the SAME execution (no new `execution.started`).
- `DELETE /api/session/{id}/inbox/{inboxID}` → **204**, emits `session.inbox.cancelled`.
- `GET /api/session/{id}/inbox` → `{data:[{id,type,payload,delivery,...}]}`; shows
  pending items with their delivery while a turn runs, empties as they deliver.

**Idempotency.** Prompt `id` is idempotent: POSTing the SAME `id` with DIFFERENT text
returned the ORIGINAL payload unchanged (HTTP 200, no duplicate enqueued). So a client
can safely retry a prompt POST without double-sending.

**Evidence** (`artifacts/b2_event.ndjson`):
```
session.inbox.enqueued  inboxID=msg_patchme... item.delivery=queue
session.inbox.delivery.changed  inboxID=msg_patchme... delivery=steer
session.inbox.cancelled  inboxID=msg_deleteme...
session.inbox.delivered  inboxID=msg_patchme...   (same execution, no execution.started)
```
Dup-id POST returned text "QUEUED MESSAGE…" (the original), not "DIFFERENT TEXT".

**Confidence.** Verified.

**Manta impact.** LARGE WIN — **deletes Manta's entire fake-steer machinery.** V1 has no
steer, so Manta simulates it by: queueing the text client-side, aborting the in-flight turn
at the next tool step-boundary (`shouldAbortForQueuedDrain`, `maybeDrainQueuedPrompt`),
swallowing the resulting `MessageAbortedError` (`isDrainAbortError`, `drainAbortRef`), and
resubmitting as a fresh turn — a fragile ~200-line dance across `useSseBus.ts` + `ChatPanel`
documented in AGENTS.md ("Queued message drain"). In V2 this is literally one field:
`POST …/prompt {delivery:"steer"}`. No abort, no error suppression, no step-boundary
detection, no double-send guard. The "queue" path (wait for turn end) is also native. The
inbox GET/PATCH/DELETE gives a real UI for pending messages (promote queue→steer, cancel).

## B3. Running state, interrupt, view, wait

**Answer.**
- **`GET /api/session/active`** is the live running-state source: `{data:{<sessionID>:{type:"running"}}}`
  while a turn runs, `{data:{}}` when idle. (Replaces Manta's V1 derivation from
  `session.status`/`session.idle` SSE flags.)
- **`GET /api/session/{id}` (Session.Info)** carries `outcome` (e.g. `"succeeded"`) and
  `time:{created,updated,idle}`. Caveat: **`outcome` and `time.idle` LAG** — during a new
  run they still show the PREVIOUS turn's outcome/idle timestamp until it ends. So
  Session.Info is NOT a reliable "is it running now" signal; use `/api/session/active`.
- **`POST /api/session/{id}/interrupt`** `{resume:true|false}` → `{interrupted:bool}`, HTTP 200.
  On a genuinely-running turn returns `{"interrupted":true}` and the session leaves the
  active set. `resume:false` vs `resume:true` both stop the turn (resume governs whether a
  partial/continuation is kept — resume:true observed as the clean "stop current step"). If
  the turn already finished, returns `{"interrupted":false}` (no-op). Emits events on the
  stream (no `MessageAbortedError`-style error — interrupt is a normal control, unlike V1
  where abort surfaces as an error Manta must suppress).
- **`POST /api/session/{id}/view`** `{idle:<number>}` → **204**. Marks the session as
  viewed (drives the "am I looking at this" / unread logic server-side).
- **`POST /api/experimental/session/{id}/wait`** `{}` → **204** when idle (blocks until the
  session is idle, then returns). A clean server-side "await turn completion" primitive.

**Evidence.**
```
active DURING: {"data":{"ses_...":{"type":"running"}}}   active IDLE: {"data":{}}
Session.Info: outcome=succeeded time={created,updated,idle}
interrupt {resume:true} on running turn -> {"interrupted":true} HTTP 200, active->{}
view {idle:0} -> 204 ; wait {} -> 204
```

**Confidence.** Verified (interrupt, view, active, Session.Info). `wait` verified returning
204; exact blocking duration not stress-tested.

**Manta impact.** Positive. `/api/session/active` + the `session.execution.started/succeeded`
events give a cleaner running-state model than V1's status-flag scraping. Interrupt is a
proper control returning a boolean — Manta can stop a turn without the V1 abort-error
suppression hack. `view` and `wait` are new primitives Manta can adopt (view → unread/focus
bookkeeping; wait → server-side completion await instead of polling).

## B5. Config hot-reload mid-turn (`POST /api/location/reload`)

**Answer.** `POST /api/location/reload {}` → **204**. Called **mid-turn** (during a running
20s shell loop):
- **The in-flight turn SURVIVES** — session stayed in `/api/session/active` as `running`
  through the reload and finished normally with `session.execution.succeeded` and
  **zero `session.error`**.
- **Config changes apply WITHOUT a server restart.** A new subagent (`spikecustom`) added
  to `~/.config/opencode/opencode.json` appeared in `GET /api/agent` immediately after
  reload (before: 7 built-ins; after: +`spikecustom`).
- Reload emits a **cascade of registry-refresh events** on the SSE stream so clients
  re-sync: `location.shutdown`, then `agent.updated`, `command.updated`, `model.updated`,
  `provider.updated`, `skill.updated`, `integration.updated`, `plugin.updated`,
  `reference.updated`, `websearch.updated`, `project.updated`.

**Evidence** (`artifacts/b5_event.ndjson`):
```
active before reload: {"ses_...":{"type":"running"}}
POST /api/location/reload -> 204
active after reload:  {"ses_...":{"type":"running"}}   (turn survived)
GET /api/agent after: [...,'spikecustom']              (new agent, no restart)
execution.started:1 execution.succeeded:1 session.error:0
```

**Confidence.** Verified.

**Manta impact.** MAJOR WIN — **eliminates the restart-to-apply-config problem.** In V1,
applying config changes (new provider, new subagent, removing a key) requires
`systemctl --user restart opencode-serve`, which **drops every in-flight turn across every
chat window** (documented pain in AGENTS.md: SubagentsCard restart button, cacheTtl 1h→5m
restart, `removeConfigKeys`). In V2, `POST /api/location/reload` hot-applies config with
in-flight turns untouched, and the `*.updated` event cascade tells Manta exactly what to
re-fetch. Manta's "deletion needs a restart" writer path and all its "restart ends running
turns" warnings become unnecessary. (Note: reload re-reads config FILES, so Manta still
writes `opencode.json`, then calls reload instead of restart.)

## B6. Permissions + forms (questions)

**Answer — Permissions.** Session create accepts a `permissions` Ruleset:
`[{action,resource,effect}]`, `effect ∈ {allow,deny,ask}`. With `{action:"shell",resource:"*",effect:"ask"}`
a shell tool triggers a permission request:
- SSE event **`permission.asked`** (NAME-COMPATIBLE with V1) carrying
  `{id, sessionID, action:"shell", resources:["echo hello-permission-test"], save:["echo *"], source:{type:"tool",messageID,id}}`.
- `GET /api/session/{id}/permission` lists pending requests (same payload).
- `POST /api/session/{id}/permission/{requestID}/reply {decision}` →204,
  **`decision ∈ {once,always,reject}`** (V1 used `once|always|reject` too). Emits
  **`permission.replied {sessionID, requestID, reply}`**.
- `decision:"always"` persists a saved rule: `GET /api/permission/saved` →
  `[{id:psv_..., projectID, action:"shell", resource:"echo *", time}]` (the `save` pattern).
  `DELETE /api/permission/saved/{id}` removes it.
- **external_directory is ALLOWED by default**: a plain session (no ruleset) read
  `/etc/hostname` via the read tool with **NO permission prompt** (returned `alphaclaw`,
  the real file). So V2 does not gate reads outside the project dir by default.

**Answer — Questions = Forms.** The V1 "Question tool" is replaced by a richer **Form**
system. A question surfaces as:
- SSE event **`form.created`**, and `GET /api/session/{id}/form` →
  `[{id:frm_..., sessionID, title, metadata:{kind:"question", tool:{messageID,id}}, fields:[...]}]`.
- Field shape: `{key, title, description, type:"string", options:[{value,label,description}], custom:true}`.
  Field types available in the spec: Boolean, Integer, Number, String, Multiselect, External.
  `custom:true` = free-text allowed alongside options (matches Manta's "type your own answer").
- Reply: `POST /api/session/{id}/form/{formID}/reply {answer:{<key>:<value>}}` →204
  (note the key is **`answer`** singular, a map of fieldKey→value; NOT `answers`). The turn
  resumes automatically after reply, form clears.

**Evidence** (`artifacts/b6_event.ndjson`, `b6form_event.ndjson`):
```
permission.asked  action=shell resources=["echo hello-permission-test"] save=["echo *"]
permission.replied reply=once
saved: [{action:shell, resource:"echo *"}]           (after decision:always)
/etc/hostname read → "alphaclaw", no permission.asked (external read allowed)
form.created  fields=[{key:q0, options:[Red,Green,Blue], custom:true}]
POST .../form/{id}/reply {answer:{q0:"Blue"}} → 204, turn resumes
```

**Confidence.** Verified.

**Manta impact.** Mostly compatible, one rename.
- **Permissions: near drop-in.** `permission.asked`/`permission.replied` keep their names,
  and `decision` keeps `once|always|reject`. Manta's `PermissionCard` + `chatAutoAllow`
  (auto-reply "always") port almost unchanged; the request payload is flatter/cleaner
  (`resources` array, `save` pattern, `source`). Saved-rule listing is a new nicety.
- **Questions: the Question tool → Form API.** Manta's `QuestionCard` must be rebuilt
  against `form.created` + `GET/POST .../form`. Mostly a shape remap: options carry
  `value/label/description`, `custom` replaces the always-shown free-text flag, reply is
  `{answer:{key:val}}`. Richer field types (boolean/number/multiselect) are a UI upgrade
  opportunity. `chatAutoAllow` must still NOT auto-answer forms (same rule as V1 questions).
- **external_directory allowed by default** means Manta need not special-case cross-dir
  reads (but may want to ADD an `ask`/`deny` ruleset for safety, which V2 supports per-session).

## B4. Replay / reconnect gap-fill

**Answer.** There is **no event-replay on the global `/api/event` stream** — it takes no
query params, and a fresh connect emits only `server.connected` + heartbeats (no backlog).
So a dropped `/api/event` subscriber does NOT auto-receive missed events on reconnect.

Recovery is two-part:
1. **Watermark stream:** `GET /api/experimental/session/{id}/log?after=<seq>&follow=true`
   is a **sequence/sync-point** stream. Each frame is `{type:"log.synced", aggregateID:ses_..., seq:<int>}`
   with a monotonic integer **`seq`** (not the `evt_...` ids). `?after=<seq>` resumes past
   an already-seen seq (verified: part1 saw `seq=5`, reconnect with `?after=5` resumed at
   `seq=22`, skipping the gap). But in `follow` mode it surfaced only the `log.synced`
   watermarks, not the individual text/tool events — it tells you "state advanced to seq N",
   not the content of each step.
2. **Canonical re-fetch:** `GET /api/session/{id}/message` returns the full message history
   (user/assistant/tool/idle/model-switched records) — this is the authoritative source to
   rebuild transcript state after a reconnect.

**Evidence** (`artifacts/b4_log_part1/2/full.ndjson`, `exmsg.json`):
```
part1 (dropped @4s): data:{"type":"log.synced","aggregateID":"ses_...","seq":5}
reconnect ?after=5 : data:{"type":"log.synced",...,"seq":22}   (gap skipped)
/api/event fresh connect: only server.connected + heartbeat (no replay)
/api/session/{id}/message: 5 records [idle,assistant,assistant,user,model-switched]
```

**Confidence.** Verified for the watermark/no-replay behavior; the `log` stream's exact
content granularity in non-follow mode (it returned only the latest sync marker) is
**inferred** — it may carry more per-seq detail with different params not fully exercised.

**Manta impact.** Moderate. V1 Manta already rebuilds on reconnect via a canonical
message re-fetch (`GET .../message`) plus per-directory SSE re-subscribe, so the same
pattern carries over — **re-fetch `GET /api/session/{id}/message` after any reconnect**
rather than relying on event replay. The new `seq` watermark is a useful "has anything
changed since seq N" cheap check to decide WHETHER to re-fetch, which V1 lacked. The
"scoped stream must be open before the prompt" readiness-gate concern from V1 is reduced
because the prompt POST enqueues durably to the inbox regardless of stream state.

## B7. Compact, switchModel, metadata, diff, context (quick pass)

**Answer.**
- **Compact:** `POST /api/session/{id}/compact {}` → returns a `compaction` message record;
  streams the summary live via SSE **`session.compaction.started`** then many
  **`session.compaction.delta`** frames. (V1 used `session.next.compaction.{started,delta,ended}`
  + `session.compacted`.) Rename: `next.` prefix dropped.
- **Switch model:** `POST /api/session/{id}/model {model:{providerID,id}}` → **204**
  (verified haiku-4-5 → haiku-5-5). This is THE model-set mechanism (there is no model
  field on the prompt body). Emits no error; applies to subsequent steps.
- **Session metadata round-trip:** `PATCH /api/session/{id} {title:"..."}` → **204**,
  and `GET /api/session/{id}` reflects the new title immediately. Also accepts `metadata`.
- **Diff:** `GET /api/session/{id}/diff` → `{data:[...]}` (empty here as the session's
  edit was committed/reverted; shape is a per-file diff array).
- **Context:** `GET /api/session/{id}/context` → an object (context breakdown) for the
  context-bar equivalent.

**Evidence** (`artifacts/b7_event.ndjson`):
```
compact POST -> compaction message; events: session.compaction.started(1), .delta(164)
POST .../model {haiku-5-5} -> 204
PATCH /api/session/{id} {title:"B7 renamed"} -> 204 ; GET shows title="B7 renamed"
```

**Confidence.** Verified (compact, model, metadata). Diff/context shapes only lightly probed.

**Manta impact.** Compatible with renames. Manta's `CompactionCard` remaps
`session.next.compaction.*` → `session.compaction.*`. Model switch and session rename are
cleaner single endpoints (V1 Manta switches model via renderer localStorage + per-session
overrides; V2 has a real server-side per-session model set via `POST .../model`). Context/diff
feed the ContextBar and session diff view respectively.
