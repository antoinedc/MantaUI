# Spike P3 — OpenCode V2 behaviour proof (live sandbox)

V2 = v2.0.30, binary `/home/dev/v2proof/bin/opencode`. Isolated under
`/home/dev/v2proof/p3/{home,proj}` with HOME + all XDG_* redirected, server on
127.0.0.1:4213, HTTP Basic auth `opencode:<password>`. Live `opencode-serve`
(:4096) untouched. Model: anthropic/claude-haiku-4-5.

---

## Item 11 — Fixed server password / disable auth (PRIORITY)

**Answer.** The server password is controlled by the **`OPENCODE_PASSWORD`** env
var (primary), with **`OPENCODE_SERVER_PASSWORD`** as a documented fallback
(both read in the binary: `eQ = cF("OPENCODE_PASSWORD").pipe(E9(()=>cF("OPENCODE_SERVER_PASSWORD")))`).
- When `OPENCODE_PASSWORD` is set, the server uses it as the fixed password AND
  **does NOT print `server password …` to stdout** (confirmed live). So a
  manta-server systemd unit sets `OPENCODE_PASSWORD=<generated-once>` in the
  unit's `Environment=` and already knows the password — no stdout parsing.
- When UNSET, the server mints a random `randomBytes(32).base64url` password and
  prints it once: `server password <token>` (the stdout-parse path).
- Auth wire format = HTTP Basic, fixed username `opencode`, password = the value.
  Verified: fixed pw → 200, wrong pw → 401.

**No way to fully disable `/api/*` auth.** No `--no-auth` flag; `opencode serve
--help` shows only `--hostname --port --cors --service --stdio`. The binary
always requires a password (`if(!b) return Error("Missing server password")`).
`--stdio` mode DELETES `OPENCODE_PASSWORD`/`OPENCODE_SERVER_PASSWORD` from env
(stdio transport authenticates by the pipe, not HTTP) — a standalone-server
pattern the CLI itself uses (spawns `serve --stdio --port 0` with a per-spawn
`OPENCODE_PASSWORD`).

**Unauthenticated routes on loopback** (no Basic header): `GET /` → 200,
`GET /index.html` (web UI) → 200, but `GET /openapi.json` → 401 and every
`/api/*` → 401. So the gate is specifically `/api/*` + `/auth/*` + `/openapi.json`;
the web-UI static assets are open. Manta always talks `/api/*`, so it always
needs the Basic header.

**Evidence.** `pw.txt`, `serve.log` (random pw printed), `serve2.log` (fixed pw,
NOT printed); strings dump of the serve chunk showing env var names + the
`Missing server password` guard; 200/401 matrix.

**Confidence.** Verified.

**Manta impact.** Clean. manta-server's systemd/launchd unit sets a stable
`OPENCODE_PASSWORD` (mint once, store in `~/.manta/`), passes
`Authorization: Basic base64("opencode:$pw")` on every `/api/*` request and on
the SSE `/api/event` stream (Node-side fetch, header-capable). No stdout parsing
needed when Manta owns the spawn. There is no loopback auth-bypass, so the header
is mandatory — but it's one constant per box lifetime.

---

## Item 1 — Todos / TodoWrite tool (PRIORITY)

**Answer. V2 has NO todo/TodoWrite tool — it was DELIBERATELY REMOVED.** The
`build` agent's complete tool set (model self-reported AND confirmed by observing
calls) is: `edit, glob, grep, question, read, shell, skill, subagent, webfetch,
websearch, write, execute`. There is no `todo`, `todowrite`, or plan tool on any
agent.

The binary carries a compaction-migration notice proving the removal is
intentional: an internal table `Pb=["todowrite"]` emits, when an old transcript
references it, **"The `todowrite` tool is no longer available and must not be
called."** (Same mechanism renames `bash`→`shell`, `task`→`subagent`,
`apply_patch`→`patch`, and `filePath`→`path`.)

**How V2 represents plans/todos:** it does NOT. When asked to "track a 3-step
plan", Haiku fell back to **writing a `.task_plan.md` / `TODO.md` file** with the
`write` tool (observed twice). There is no `todo.updated` event and no todo state
anywhere in the session API.

**Evidence.** `item1-sse.ndjson` (25 event types, tool calls = `read` + `write`
to `.task_plan.md`, no todo); `item1-toollist.json` (model lists 12 tools, "NO"
to todowrite/todo); binary strings of the migration-notice table.

**Confidence.** Verified.

**Manta impact. BREAKING for the ActiveTodos card.** Manta's `liveTodos` /
`ActiveTodos` pinned-checklist feature is driven entirely by V1's `todo.updated`
event + TodoWrite tool. On V2 that event never fires and the tool is gone, so the
card would always be empty. Options: (a) drop the feature; (b) re-introduce a todo
tool as a Manta PLUGIN (`ctx.tool.transform` add) that emits state Manta renders —
V2 plugins CAN register tools (proven in round1-a), so Manta could ship its own
`todowrite` tool + a bus event, fully under its control; (c) parse a convention
file (`.task_plan.md`) — fragile, not recommended. Recommendation: ship a Manta
todo plugin if the checklist UI is worth keeping; otherwise retire ActiveTodos.

---

## Item 2 — Instructions (global + project AGENTS.md, CLAUDE.md) (PRIORITY)

**Answer.** Both **global** `$XDG_CONFIG_HOME/opencode/AGENTS.md` and **project**
`<proj>/AGENTS.md` reach the model. In one turn Haiku returned BOTH canaries
verbatim: `GLOBALCANARY-ZXQ7` (global) and `PROJECTCANARY-MWP4` (project).

**CLAUDE.md is NOT loaded as instructions.** A `<proj>/CLAUDE.md` with a canary
was ignored — asked for the CLAUDE canary with no other source, the model replied
`NO-CLAUDE-INSTRUCTION`. (The binary's `OPENCODE_DISABLE_CLAUDE_CODE` /
`…_SKILLS` flags gate importing Claude Code *skills*, not a CLAUDE.md instruction
file. `config.claude:!disabled` in the serve bootstrap refers to that skill
import, not CLAUDE.md.)

**No system-prompt-dump endpoint.** `GET /api/session/{id}/context` returns the
MESSAGE LOG (user/assistant/model-switched records), not a system-prompt
breakdown. `GET /api/experimental/session/{id}/instructions/entries` returns
`{data:[]}` by default — it's a per-session *override* store (`PUT/DELETE
…/entries/{key}`), a NEW primitive Manta could use to inject session-scoped
instructions programmatically, not a read of the assembled prompt. The
`session.instructions.updated` SSE event (delta) fires once per turn.

**Evidence.** `item2-msgs.json` (both canaries echoed, text under `content[]`),
`item2-claude.json` (NO-CLAUDE-INSTRUCTION), `item2-context.json`,
instructions/entries empty.

**Confidence.** Verified.

**Manta impact.** Low/compatible. Manta's AGENTS.md injection (global guidance
blurb appended to `~/.config/opencode/AGENTS.md`, project AGENTS.md) works
unchanged — both layers reach the model. **One migration note: if any Manta/user
box relies on CLAUDE.md for instructions, those must be renamed/merged into
AGENTS.md on V2.** The `instructions/entries` override API is a new, cleaner way
to push per-session system text than appending to a file. NOTE a general wire
change: assistant text lives in `message.content[]` (type:"text"), NOT `parts[]` —
Manta's transcript parser must read `content[]`.

---

## Item 3 — Permissions hardening (PRIORITY)

**Answer. All three behaviours proven.**

**(a) Restore V1 "ask before outside-project":** V2 has a real
**`external_directory`** permission action. A rule
`{action:"external_directory",resource:"*",effect:"ask"}` gates reads outside the
session's project dir. Set it either:
- **per-session** on create: `permissions:[{action,resource,effect}]`, OR
- **globally** in `opencode.json` as `{"permission":{"external_directory":"ask"}}`
  + `POST /api/location/reload` — applies box-wide to new sessions with NO
  per-session ruleset (verified: outside read → `permission.asked`).

A gated outside read fires SSE `permission.asked` + a pending
`GET /api/session/{id}/permission` entry:
`{id:per_…, action:"external_directory", resources:["/etc/*"], save:["/etc/*"],
source:{type:"tool",messageID,id}}`. (Note `resources`/`save` are
GLOB-widened to `/etc/*`, not the literal file.)

**(b) Per-session trust mode (allow-all) skips prompts:** create with
`permissions:[{action:"*",resource:"*",effect:"allow"}]` → a turn that reads
`/etc/hostname` AND runs a `shell` command produced **ZERO `permission.asked`**
events; both tools ran. This is Manta's `chatAutoAllow` equivalent, done
server-side per session instead of auto-replying.

**(c) "always" persists + saved list + removal:**
- `POST …/permission/{reqID}/reply {decision:"always"}` → 204, emits
  `permission.replied`, and **persists** to `GET /api/permission/saved` →
  `[{id:psv_…, projectID, action:"external_directory", resource:"/etc/*",
  time}]` (the `save` glob).
- A **second** outside read then fired **0** `permission.asked` (saved rule
  auto-allows).
- `DELETE /api/permission/saved/{psvID}` → 204, saved list back to `[]`.

`decision ∈ {once, always, reject}` (V1-compatible). `effect ∈ {allow, deny, ask}`.

**Evidence.** `item3a-sse.ndjson` (external_directory asked), saved-list JSON
after always, `item3a2-sse.ndjson` (0 asks on 2nd read), delete→empty,
`item3b-sse.ndjson` (trust mode, 0 asks, read+shell ran), `item3c-sse.ndjson`
(global-config ask rule fired).

**Confidence.** Verified.

**Manta impact. Strong win, near drop-in.** (1) Manta can restore its V1
ask-before-outside UX with one global config key (`permission.external_directory
= ask`) — V2 defaults to ALLOWING outside reads, so Manta must OPT IN. (2)
`chatAutoAllow` becomes a per-session allow-all ruleset at session create (cleaner
than V1's bus-layer auto-reply, though the auto-reply path also still works since
`permission.asked`/`reply` are unchanged). (3) The saved-rule list + DELETE give
Manta a real "manage remembered permissions" UI that V1 lacked. Names
(`permission.asked`, `permission.replied`, `once|always|reject`) are
V1-compatible, so `PermissionCard` ports with minimal change — only the request
payload is flatter (`resources[]` + `save[]` globs + `source`).

---

## Item 5 — Errors & lifecycle events (PRIORITY)

**Answer.** V2 has a clean, typed outcome model. Every turn ends in exactly one
of three terminal states, visible BOTH as an SSE event and as the trailing
`idle` message's `outcome` field + Session.Info `outcome`:

| outcome | SSE event | idle.outcome / Session.Info.outcome |
|---|---|---|
| success | `session.execution.succeeded` | `succeeded` |
| error | `session.execution.failed` | `failed` |
| user stop | `session.execution.interrupted` | `interrupted` |

**(a) Provider error (bad model id):** setting
`model.id="claude-nonexistent-999"` then prompting →
`session.execution.failed` with
`data.error:{type:"provider.no-route", message:"Model unavailable: anthropic/claude-nonexistent-999"}`,
plus a sibling `provider.no-route` event, and `idle.outcome="failed"`. Error is
STRUCTURED (`error.type` + `error.message`), not a bare string.

**(b) Interrupt mid-turn:** `POST …/interrupt {resume:true}` →
`{"interrupted":true}` HTTP 200, session leaves `/api/session/active`
(`{data:{}}`). Event cascade: `session.tool.failed` (error.type:`aborted`,
"Tool execution interrupted"), `session.step.failed` (error.type:`aborted`,
"Step interrupted", carries `rawFinish`+`cost`), then top-level
**`session.execution.interrupted {reason:"user"}`**. Shell resource also emits
`shell.exited`+`shell.deleted`. **No V1-style `MessageAbortedError` to suppress** —
interrupt is a first-class control-outcome, not an error.

**(c) Retry:** no dedicated retry endpoint — you just re-send the prompt. After
fixing the model and re-prompting the failed session, a NEW execution ran and
appended a fresh `idle.outcome="succeeded"` (the old `failed` idle stays in
history). `revert`/`revert/commit`/`revert/stage` handle rolling back edits, not
re-running.

**(d) Context overflow:** not force-tested (cost), but the error type exists in
the binary: `context.length` / `context overflow` / `context window`. By analogy
with (a) it surfaces as `session.execution.failed` with that `error.type`.
Other known error types in the binary: `provider.no-route`, `provider.auth`,
`output.length`, `max_tokens`, `aborted`, plus tagged API errors
(`UnauthorizedError`, `ProviderNotFoundError`).

**"Turn finished with outcome" signal:** the authoritative pair is the
`session.execution.{succeeded,failed,interrupted}` SSE event AND the trailing
`idle` message `{type:"idle", outcome:"succeeded|failed|interrupted"}`. Live
running-state is `/api/session/active` (empty when done).

**Evidence.** `item5a-sse.ndjson` (execution.failed + provider.no-route),
`item5b-sse.ndjson` (tool.failed/step.failed/execution.interrupted reason:user),
`item5-retry.json` (failed→succeeded on re-send), Session.Info outcomes.

**Confidence.** Verified (a,b,c + error catalogue). Context-overflow error TYPE
confirmed in binary; its live event not force-provoked.

**Manta impact. Large simplification.** V1 Manta switches on `err.name`
(`ProviderAuthError`, `ContextOverflowError`, `MessageOutputLengthError`,
`MessageAbortedError`…) scraped from a single `session.error` event, AND runs the
fragile drain-abort suppression (`isDrainAbortError`, `drainAbortRef`) so user
interrupts don't show an error banner. On V2: (1) errors are a typed
`error.{type,message}` on `session.execution.failed` — map `error.type` to
Manta's banner copy directly; (2) **interrupt is its OWN event
(`session.execution.interrupted`), never an error** — the entire
abort-error-suppression hack is DELETED; (3) the `idle.outcome` field gives a
durable per-turn outcome for the transcript (truncation/failure badges).

---

## Item 6 — Live shell output (PRIORITY)

**Answer.** Live stdout is fetched by **polling `GET /api/shell/{shellID}/output`**,
NOT from the event stream. Response: `{output, cursor, size, truncated}` (wrapped
in `{data:…, location:…}`). During a `for i in seq 1 10; do echo tick$i; sleep
0.5; done` shell, polling every ~0.4s showed output growing in real time:
2 lines (cursor 12) → 3 → 5 → 7 → 10 lines (cursor 61) over ~4s, tracking the
0.5s loop cadence exactly. Latency between a line being emitted and appearing at
`/output` was sub-poll-interval (≤0.4s observed).

**Incremental fetch:** the endpoint takes a **`?cursor=<N>`** query param and
returns ONLY bytes after N (verified: `?cursor=30` → `tick6..tick10`, cursor 61).
So a tailer polls, advances its cursor to the returned `cursor`, and fetches only
the delta — no re-reading the whole buffer.

**No event per new output chunk.** `session.tool.progress` fired **exactly ONCE**
for the whole shell run — it is a one-shot POINTER carrying
`metadata.shellID`, NOT a per-chunk notification. The `shell.created` event
(carrying `info.id` = the shellID) is the trigger to START polling; `shell.exited`
is the signal to stop. Between them there is no push — you must poll. Final output
also lands in `session.tool.success.content[].text`.

**Evidence.** `item6-sse.ndjson` (1 tool.progress, shell.created→exited); the
timestamped poll table (lines 2→10, cursor 12→61); `?cursor=30` delta fetch.

**Confidence.** Verified.

**Manta impact. This is the single biggest live-bash rewrite (same as round1-b).**
V1 Manta tails bash via `message.part.updated → state.metadata.output` events (~30ms
push) with the messageID+debounce+max-wait machinery (`spliceMessage`,
`SPLICE_MAX_WAIT_MS`). On V2 that whole push path is gone. Replacement: on
`shell.created` (or `tool.progress.metadata.shellID`), START a poller on
`GET /api/shell/{id}/output?cursor=N` (~300-500ms cadence is plenty — matches the
V1 ~4Hz splice cap), append the returned delta, advance the cursor, STOP on
`shell.exited`. No debounce-starvation problem (it's a pull), and `truncated`
tells Manta when to show a "output truncated" marker. One poller per live shell,
keyed off shellID — simpler than the V1 event-routing bug surface.

---

## Item 4 — Question tool → Forms (PRIORITY)

**Answer.** The model HAS a **`question`** tool (in the build agent's tool set;
the `question` permission action is `allow` by default). A question surfaces as a
**Form**:
- SSE **`form.created`** `{data:{form:{…}}}` and `GET /api/session/{id}/form` →
  `[{id:frm_…, sessionID, title:"Questions", metadata:{kind:"question",
  tool:{messageID,id}}, fields:[…]}]`.
- **Field shape:** `{key:"q0", title, description, type:"string",
  options:[{value,label,description}], custom:true}`. `custom:true` = free-text
  allowed alongside options (Manta's "type your own answer"). Haiku even
  auto-generated option descriptions.
- **Reply:** `POST /api/session/{id}/form/{formID}/reply` body
  **`{answer:{<key>:<value>}}`** (singular `answer`, a map keyed by field key) →
  204. Form clears, turn resumes automatically, model acknowledges the answer.
- **Cancel:** `DELETE /api/session/{id}/form/{formID}` → 204, emits
  **`form.cancelled {id, sessionID}`**, form clears.
- Field TYPES in the spec: `String, Boolean, Integer, Number, Multiselect,
  External` (`Form.{String,Boolean,Integer,Number,Multiselect,External}Field`) —
  richer than V1's text/options-only question.
- `GET /api/form` lists all pending forms across sessions;
  `GET /api/session/{id}/form/{formID}` fetches one.

**Evidence.** `item4-sse.ndjson` (form.created full schema: q0, Red/Green/Blue,
custom:true), reply `{answer:{q0:"Blue"}}`→204 + model ack, `item4-cancel-sse.ndjson`
(form.created→form.cancelled on DELETE).

**Confidence.** Verified.

**Manta impact.** Manta's `QuestionCard` is rebuilt against the Form API (not a
rename — a reshape). Map: V1 question options → `fields[].options[]`
(`value/label/description`); V1 always-shown free-text → `custom` flag; reply
`{answers:[[…]]}` → `{answer:{key:value}}`. Cancel is `DELETE …/form/{id}`. The
new typed fields (boolean/number/multiselect/external) are a UI UPGRADE
opportunity. `chatAutoAllow`/trust mode must still NOT auto-answer forms (same as
V1 questions — a form is a user decision, distinct from a permission). Events:
`form.created` / `form.cancelled` (plus a reply implicitly clears it).

---

## Item 7 — Subagents (foreground vs background)

**Answer.** The model has a **`subagent`** tool (V1's `task`, renamed). A
foreground subagent run:
- **Child announced** via SSE `session.created` with `data.parentID` (=parent SID)
  + `agent` (e.g. `explore`) + `title` (model-generated, e.g. "Count markdown
  files"). Child events interleave on the SAME global `/api/event` stream under
  the child's sessionID.
- **Parent learns progress** via `session.tool.progress` with
  `metadata.sessionID`(child)+`status`, and **learns COMPLETION** via
  `session.tool.success` whose `metadata:{sessionID:<child>, status:"completed"}`
  and `content[].text` = the child's result (wrapped
  `<subagent sessionID=… state="completed">…</subagent>`).
- **`GET /api/session?parentID=<parentSID>`** is a real filter — returned exactly
  the 1 child for the parent, 0 for an unrelated session. (The endpoint also takes
  `limit`/`order`.) This is how Manta enumerates a session's children.

**Background option:** the `subagent` tool input carries a **`background`** option
(present in the binary). Foreground (wait-for-result) proven live; background not
force-exercised, but the plumbing (child session + parentID + tool.progress) is
identical — background just means the parent's turn doesn't block on the child's
result.

**Child permission routing:** a child is its OWN session with its own
permissions; its `permission.asked` events carry the CHILD's sessionID. (Not
force-provoked here, but follows from the per-session permission model in item 3.)
So Manta routes a child's permission/question to the child session, not the
parent — matching V1's open-item about tagging "from subagent: X".

**Evidence.** `item7-sse.ndjson`: `session.created parentID=<parent>
agent=explore title="Count markdown files"`; `tool.success
metadata{sessionID:<child>,status:completed}` + `<subagent>` result; parentID
filter 1 vs 0.

**Confidence.** Verified (foreground, parentID filter, completion signal).
Background option present in binary, not live-run.

**Manta impact. Cleaner than V1.** V1's `collectChildSessionIds` /
`registerChildSessionFromCreated` / the "register-before-filter" ordering trap all
simplify to: watch `session.created` for a matching `parentID`, add the child SID
to the allowlist, and read completion off the parent's `tool.success`
(metadata.sessionID + content). `GET /api/session?parentID=` replaces walking the
transcript for child ids. The uniform `data.sessionID` field path removes V1's
multi-path messageID hack. Background subagents map to Manta's `delegate`/bg-task
sidebar rows.

---

## Item 8 — Plan mode / agents, model variants, reasoning

**Answer.** Agents: `GET /api/agent` → `build`(primary), `plan`(primary),
`general`/`explore`(subagent), plus internal `compaction`/`title`/`summary`.
- **Switch agent:** `POST /api/session/{id}/agent {agent:"plan"}` → 204 (verified).
- **Plan mode is enforced by PERMISSIONS, not tool removal.** The `plan` agent has
  the SAME tool list as build, but its permission ruleset **denies `edit`**
  (`{action:"edit",resource:"*",effect:"deny"}`) except a plan scratch dir
  (`…/.opencode/plan/*`). So "plan mode = read-only" is a permission policy the
  model works within.
- **Model variants / effort:** `Model.Ref` is `{id, providerID, variant?}`. For
  `anthropic/claude-haiku-4-5`, `variants:[{id:"high",thinking:{budgetTokens:16000}},
  {id:"max",budgetTokens:31999}]` (thinking-effort levels). The opencode provider's
  models use `{id:"low|medium|high", reasoningEffort}`. Set via
  `POST …/model {model:{providerID,id,variant:"high"}}` → 204 (verified).
- **Reasoning events:** with `variant:"high"`, a "think step by step" prompt
  emitted **`session.reasoning.started` → `session.reasoning.delta`(×8) →
  `session.reasoning.ended`** — a SEPARATE stream from `session.text.*` (V1 mixed
  them in one delta).

**Evidence.** `item8-plan.json` (plan agent, edit denied), `/api/agent/plan`
permissions, `models.json` (haiku variants high/max thinking), `item8-reason-sse.ndjson`
(reasoning started/delta/ended under variant high).

**Confidence.** Verified.

**Manta impact.** Plan mode = `POST …/agent {agent:"plan"}` (server-side, real —
V1 Manta had no true plan agent). Model effort/thinking = a per-session `variant`
on `POST …/model` (cleaner than V1's renderer-localStorage override). Render
`session.reasoning.*` as a distinct collapsible "thinking" block separate from the
answer text.

---

## Item 13 — Usage / cost / context window

**Answer.**
- **Per-model context limit** for the context pill: model record (`GET /api/model`)
  carries `limit:{context, output}`. `anthropic/claude-haiku-4-5` →
  `{context:200000, output:64000}`. This is Manta's `resolveContextLimit`
  denominator, read straight from the model record (no hardcode).
- **Live token/cost:** SSE **`session.usage.updated`** fires repeatedly during a
  turn (carries `data.sessionID`). **Session.Info** (`GET /api/session/{id}`)
  carries `cost` and `tokens:{input, output, reasoning, cache:{read, write}}` —
  the authoritative cumulative snapshot. (The create response already showed the
  `tokens` shape: `{input,output,reasoning,cache:{read,write}}`.)
- Current-context tokens for the pill = the session's `tokens` (input + cache.read
  + cache.write, same disjoint-bucket logic as V1's `computeContextBreakdown`),
  over `limit.context`.

**Evidence.** `models.json` (haiku limit.context=200000), create-response tokens
shape, `session.usage.updated` events seen in every turn capture.

**Confidence.** Verified (limit + tokens shape + usage event). Exact
`session.usage.updated` payload fields not dumped in full but the cumulative
truth is Session.Info.tokens.

**Manta impact.** ContextBar/`resolveContextLimit` ports cleanly: denominator from
`model.limit.context`, numerator from Session.Info `tokens` (input+cache.read+
cache.write). V1's `session.next.step.ended`-scraped tokens → V2
`session.usage.updated` event (trigger a refetch of Session.Info, or read the
event payload). The disjoint cache-bucket math is unchanged.

---

## Item 12 — Session titles (auto-title)

**Answer.** V2 **auto-titles** new sessions. After the first turn, SSE
**`session.renamed`** fires with a model-generated `data.title` (e.g. "Plan and
Read README: Todo Setup"), and `GET /api/session/{id}` reflects it. There are
dedicated agents for this: `title` and `summary` (mode:primary, in `/api/agent`).
A **custom** title/text generation primitive exists:
`POST /api/session/{id}/generate {prompt}` → `{data:{text}}` (tested: returned
"Code Exploration Foundation"). Manual rename stays `PATCH /api/session/{id}
{title}` (round1-b).

**Evidence.** `session.renamed` event with title; `session/generate` round-trip.

**Confidence.** Verified.

**Manta impact.** V2 auto-titles natively — Manta's BET-1018 auto-rename
machinery (first-name-from-opencode-title, title agent, retry) largely collapses
to "listen for `session.renamed` and mirror the title to the tmux window name".
`session.generate` replaces the V1 `prompt_async {agent:"title"}` hack (and note
the V1 structured-output trap is irrelevant — generate returns plain text).

---

## Item 9 — Slash commands & skills

**Answer. Both load from config + are runnable via API.**
- **Commands:** a `$XDG_CONFIG_HOME/opencode/command/<name>.md` (or project
  `.opencode/command/<name>.md`) with frontmatter loads after
  `POST /api/location/reload`; `GET /api/command` lists it. **Run:**
  `POST /api/session/{id}/command {name, text}` (BOTH `name` AND `text` required;
  `text` may be "") → 204. The command's template body expands into a **user
  message** and the model responds (verified: `/greet` → model replied
  `COMMAND-GREET-OK`). **NOTE: no `command.executed` event** — the expanded
  command arrives as a plain `user` message with NO command-origin tag
  (`m.command`/`m.metadata` were null). V1 had `command.executed` to render the
  collapsed `/name args` bar.
- **Skills:** `$XDG_CONFIG_HOME/opencode/skills/<name>/SKILL.md` loads;
  `GET /api/skill` lists it (verified my `testskill`). The model also has a
  `skill` tool to self-activate. **Programmatic activation:**
  `POST /api/experimental/session/{id}/skill {id}` → 204, injects the skill body
  (verified: model then returned `SKILL-CANARY-RTX5`). The `skill` tool takes
  `id` (renamed from V1's `name` — per the migration notice).
- **V2 also imports Claude Code skills by default** (`~/.claude/skills/**` all
  appeared in `/api/skill`) unless `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`.

**Evidence.** `greet` in `/api/command`, `item9c-sse.ndjson` (command → user msg
→ COMMAND-GREET-OK, no command.executed), `testskill` in `/api/skill`,
`item9-skill.json` (SKILL-CANARY-RTX5 after activation).

**Confidence.** Verified.

**Manta impact.** Commands run via `POST …/command {name,text}` (V1 Manta's slash
path). **GAP: no `command.executed` event** means Manta's `UserCommandBar`
(collapsed `/name args` view) has no signal to key on — it would need to detect
command origin another way, or drop the collapsed-command UI. Skills: Manta can
pre-activate a skill with the experimental endpoint, and `skillRegistryUrls`
config carries over. Claude Code skill auto-import is a new default to be aware of
(may want `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` to avoid leaking the box's global
skills into every project).

---

## Item 14 — session.log detail

**Answer.** `GET /api/experimental/session/{id}/log` takes only **`after`**
(an `Event.Seq` watermark) and **`follow`** (true/false). In BOTH modes it emits
ONLY `{type:"log.synced", aggregateID:ses_…, seq:<int>}` watermark frames — NOT
the individual text/tool/step events. `?after=0` on a session with 40 events
still returned just `seq:40` (the current high-water mark), never the per-event
content. So the log stream is a **monotonic sequence/sync-point feed** ("state
advanced to seq N"), not an event-replay channel.

**Evidence.** log without follow → single `log.synced seq:40`; `?after=0` →
same (no backlog of events).

**Confidence.** Verified.

**Manta impact.** The `/log` stream is a cheap "has anything changed since seq N?"
check, useful to decide WHETHER to re-fetch after a reconnect — but it does NOT
replay missed events. Reconnect recovery is the same as V1: re-subscribe
`/api/event` + re-fetch `GET /api/session/{id}/message` (the canonical transcript).
The `seq` watermark is the new, cheap gating signal V1 lacked.

---

## Item 10 — MCP

**Answer. Works.** V2 has first-class MCP support via the `mcp` config key +
dedicated endpoints.
- **Config** (`opencode.json`): `{"mcp":{"<name>":{"type":"local",
  "command":["node","/path/server.mjs"], cwd?, environment?, disabled?}}}`
  (remote MCP = `{type:"remote", url, header}`). After
  `POST /api/location/reload` the server is registered.
- **Lifecycle endpoints:** `PUT/DELETE /api/experimental/mcp/{server}`,
  `POST …/mcp/{server}/connect` (→204), `…/disconnect`. Connect succeeded for a
  20-line stdio Node MCP server exposing one `spike_ping` tool.
- **Tools callable by the model.** The MCP tool's output reached the model
  verbatim: it returned `MCP-CANARY-QPZ8`. **Namespacing:** V2 exposes MCP tools
  under a **codemode** namespace `tools.<server>.<tool>` invoked through the
  `execute` tool — the model called `await tools.spikemcp.spike_ping()` (seen in
  `session.tool.called.input.code`), and `session.tool.success.content[].text`
  carried the canary. (So MCP tools are reached via code-execution, not as
  top-level named tools — a V2 "codemode" design.)

**Evidence.** `mcp-server.mjs` (minimal stdio server), connect→204,
`item10-sse.ndjson`: `tool.called input.code = "await tools.spikemcp.spike_ping()"`,
`tool.success = MCP-CANARY-QPZ8`.

**Confidence.** Verified (local stdio MCP end-to-end).

**Manta impact.** MCP is configured in `opencode.json` under `mcp` + a reload
(no restart), and manta-server can drive connect/disconnect via the experimental
endpoints. The codemode `tools.<server>.<tool>` exposure means Manta's transcript
renderer should expect MCP calls to surface as `execute`/code-tool calls
referencing `tools.*`, not as distinct named tool parts — relevant for how the
tool card is labelled.
