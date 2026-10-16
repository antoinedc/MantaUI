# OpenCode V2 — first implementation slices: Phase 1 (frames) + Phase 3 (plugin pack)

Parent plan: `docs/opencode-v2/MIGRATION-MASTER-PLAN.md` (approved 2026-10-16).
Evidence: `docs/opencode-v2/spikes/`.

Two slices that run in parallel, with disjoint ownership. Neither changes behaviour for
users: slice A lands on V1 and keeps every visible behaviour identical; slice B ships files
that nothing installs yet (Phase 4 installs them).

---

## Slice A — Phase 1.2 + 1.3 server half: recorded corpus + complete frame vocabulary

### Goal
Every raw opencode event the desktop renderer consumes today gets an equivalent
interpreted frame from `src/server/streamInterp.mjs`, and the interpreter is covered by
golden tests replaying recorded real V1 event streams. A later slice (A2) switches the
renderer onto these frames and stops reading raw events; that is NOT part of this slice.
In this slice, the raw `{kind:"opencode"}` publication stays exactly as it is.

### Owned paths
`src/server/streamInterp.mjs`, `src/server/streamInterp.test.mjs`,
`src/shared/streamInterpretation.mjs` (+ its test), `src/server/fixtures/opencodeV1Events/**`
(new), `src/server/streamInterp.golden.test.mjs` (new), the `StreamEnvelope` /
stream-payload types in `src/shared/types.ts`, `scripts/record-opencode-events.mjs` (new).
Must NOT touch: `src/renderer/**`, `mobile/**`, `docs/opencode-plugins-v2/**`.

### New frames (contract — pinned)
All are `{kind:"stream", sub, sessionId, payload}`, same envelope as today. `sessionId` is
the session the event belongs to (child sessions included — the renderer filters).

| sub | payload | Emitted from (V1 raw) | Replaces renderer reading |
|---|---|---|---|
| `retry` | `{attempt:number, message:string, next?:number, action?:{title,message,label,link?}}` or `null` (cleared) | `session.status` type `retry` → value; next `busy`/`idle` → `null` | `useSseBus` retry banner |
| `stepEnded` | `{messageID:string, tokens:{input,output,reasoning,cache:{read,write}}, cost?:number, finish?:string}` | `session.next.step.ended` | stepTokens + step-boundary drain |
| `toolBoundary` | `{messageID:string, partID:string, callID:string, tool:string, status:"completed"\|"error"}` | `message.part.updated` with tool part at terminal status | `isToolStepBoundary` drain trigger |
| `compaction` | `{phase:"started"\|"delta"\|"ended", text?:string}` | `session.next.compaction.{started,delta,ended}` | CompactionCard |
| `transcriptStale` | `{}` | `session.compacted` | refetch |
| `messageChanged` | `{messageID:string}` | `message.updated` (`properties.info.id`), `message.part.updated` (`properties.part.messageID`), `message.part.removed`, `message.removed` — **resolve messageID across all three paths** (see AGENTS.md "messageID + debounce-starvation trap"). Coalesce: at most one frame per messageID per 100 ms, trailing edge guaranteed | `spliceMessage` / child refetch |
| `commandExecuted` | `{messageID:string, name:string, arguments:string}` | `command.executed` | `commandByMessageId` |
| `childSession` | `{childSessionId:string, parentSessionId:string}` | `session.created` with `info.parentID` | `App.tsx` setSessionParent (frame published under the PARENT's sessionId) |
| `attention` | `{kind:"question"\|"permission"\|null}` | `question.asked`/`permission.asked` → kind; `*.replied`/`*.rejected` → `null` when none pending | `App.tsx` setChatAttention |

Existing frames keep their exact shapes. `sessionError` keeps `{name, message}` and must
carry the raw `name` unchanged (the renderer's drain-abort suppression keys on
`MessageAbortedError`). `running` / `runningSet` stay the source of running state.

Rules:
- The interpreter stays pure-ish: injected `publish`, `now`; no new I/O.
- De-dup by event id as today (`createSeenIdFilter`) — every new frame passes the same
  filter, so the global + per-directory double delivery never doubles a frame.
- Add the new `sub` names to `StreamEnvelope.sub` in `src/shared/types.ts` together with
  payload types; also add the existing subs the type is missing (`toolStarted`,
  `toolOutput`, `toolEnded`, `planMode`, `permissions`, `sessionError`).

### Recorded corpus
- `scripts/record-opencode-events.mjs <out.jsonl> -- <prompt>`: creates a throwaway session
  on the local V1 opencode (`127.0.0.1:4096`) in a scratch directory under `/tmp`,
  subscribes to the global and the scoped `/event` stream, sends the prompt, records every
  raw event as one JSON line until the session goes idle (plus 2 s), then deletes the
  session. Read-only towards config; uses the box's normal default model.
- Scrubbing is mandatory before commit: replace absolute home paths with `/home/user`,
  drop any `auth`/`token`/`apiKey`-looking fields, and keep only the scratch prompts' own
  content. The prompts are harmless synthetic tasks written for recording.
- Record 6 scenarios: (1) plain text answer; (2) slow shell command
  `for i in 1 2 3 4 5; do echo $i; sleep 1; done`; (3) file edit + TodoWrite with 3 items;
  (4) a `task` subagent (explore); (5) a question tool call answered via
  `POST /question/:id/reply`; (6) a long turn aborted with `POST /session/:id/abort`.
  Permission scenario: skip if trust mode is on for the box (note it in the test file).
- `streamInterp.golden.test.mjs`: for each `.jsonl`, replay through
  `createStreamInterpreter` with a fake clock, write frames, compare against the checked-in
  `<name>.frames.json`. `UPDATE_GOLDEN=1` rewrites. Volatile fields (timestamps) are
  normalised by the fake clock; ids come from the corpus and are stable.

### Done
`npm run typecheck`, `npm test` green; the 6 golden files exist and were reviewed by eye
for plausibility (each new frame appears in at least one golden file); no renderer change.

---

## Slice B — Phase 3.1: the `manta` V2 plugin (all tools) + V2 test harness

### Goal
One V2 plugin that registers every Manta tool with the same names, inputs and result text
as today's V1 tools, plus a `todo_write` tool, and a harness that proves it against a real,
pinned V2 binary. Nothing installs it yet.

### Owned paths
`docs/opencode-plugins-v2/manta/**` (new), `scripts/opencode-v2/**` (new),
`package.json` (only adding the `test:opencode-v2` script). Must NOT touch
`docs/opencode-tools/**` (V1 stays as-is until cut-over), `src/**`, `scripts/install.sh`,
`scripts/self-update.sh`.

### Layout
```
docs/opencode-plugins-v2/manta/
  index.ts          Plugin.define({ id: "manta", setup }) — registers every tool
  lib/server.ts     manta-server client: base URL (MANTA_SERVER_URL or 127.0.0.1:8787),
                    bearer from MANTA_BOX_TOKEN or ~/.manta/auth.json (same rules as
                    docs/opencode-tools/manta-auth.ts), call(method, path, body) with the
                    same error semantics as the V1 `call` helper
  lib/context.ts    resolves {sessionID, messageID, directory} for a tool call
  tools/<area>.ts   one file per V1 tool file; each exports `tools: ToolDef[]`
  tools/todo.ts     todo_write
  *.test.ts         pure unit tests (run by vitest via the existing renderer runner? NO —
                    see Tests)
```

### Tool contract (pinned)
- Names: identical to V1 (`schedule_create`, `notify`, `delegate`, `media_show`, … — all 44;
  the inventory is in the slice brief). AGENTS.md guidance therefore stays valid.
- Inputs: JSON Schema equivalent to each V1 zod schema — same field names, types, enums,
  optionality, descriptions (copy descriptions verbatim; they are load-bearing for the
  model). `additionalProperties: false`.
- Output: `{ content: <exactly the string the V1 tool returned> }`. Errors: throw with the
  same message.
- Context: `sessionID` and `messageID` come from the V2 execute context. `directory` is not
  in the V2 tool context: resolve it from the plugin's `ctx.location.directory` if the
  plugin is instantiated per location, otherwise from manta-server
  (`GET /api/session-directory?sessionID=`), whichever the harness proves. Document which.
- `todo_write`: input identical to V1 TodoWrite
  (`{todos:[{content:string, status:"pending"|"in_progress"|"completed"|"cancelled", priority:"high"|"medium"|"low"}]}`),
  description adapted from V1's TodoWrite description, result `{content:"Todos updated"}`.
  Do NOT name it `todowrite` (V2 reserves that name with a removal notice). Phase 2's event
  mapper derives the `todos` frame from this tool's input.

### Harness (`scripts/opencode-v2/`)
- `fetch-binary.mjs`: downloads the pinned binary via the npm registry tarball of
  `@opencode/cli-<platform>@2.0.30` into `~/.cache/manta/opencode-v2/2.0.30/`, verifies the
  tarball integrity hash reported by the registry, extracts `opencode`. Version constant
  lives in `scripts/opencode-v2/version.mjs` (single source).
- `sandbox.mjs`: starts the binary with HOME and all XDG dirs in a fresh temp dir,
  `OPENCODE_PASSWORD` random, a free port, and the plugin under test copied into
  `$XDG_CONFIG_HOME/opencode/plugins/`; returns `{url, auth, stop}`. Never touches the
  real `~/.config/opencode`, `~/.local/share/opencode`, or port 4096.
- `fake-manta-server.mjs`: records requests, answers each route with canned JSON.
- `plugin-pack.e2e.mjs` (`npm run test:opencode-v2`): requires `ANTHROPIC_API_KEY` in env
  (skips with a clear message otherwise); Haiku-class model; asserts the plugin loads
  (`GET /api/plugin`), every tool is registered, and live turns call at least
  `schedule_list`, `notify`, `todo_write` and one directory-dependent tool with the correct
  `sessionID` / `directory` arriving at the fake server. Spend cap documented (< $0.50/run).
- Not part of `npm test` (needs network + a key). Pure helpers ARE unit-tested in
  `npm test` (node:test files under `scripts/opencode-v2/*.test.mjs`, picked up by the
  existing server test glob if it covers `scripts/`; otherwise add them to it explicitly).

### Done
`npm run typecheck`, `npm test` green; `npm run test:opencode-v2` green with a real key,
output pasted into the PR; every V1 tool has a V2 twin (a test asserts the name sets match
by parsing `docs/opencode-tools/*.ts`).
