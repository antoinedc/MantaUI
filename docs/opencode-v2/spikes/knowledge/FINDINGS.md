# Knowledge spike — three plugin behaviours of the pinned OpenCode V2 (2.0.30)

Spec: `docs/superpowers/specs/2026-11-16-shared-knowledge.md` §0. Binary: opencode v2.0.30 (the
pinned one, via `scripts/opencode-v2/fetch-binary.mjs`).

Reproduce (sandbox harness + `mock-anthropic.mjs`; no paid model call, live :4096 / ~/.config/opencode untouched):

```
node docs/opencode-v2/spikes/knowledge/run.mjs        # ~30 s, writes last-run.json (the run quoted below)
```

Files: `run.mjs` (driver), `knowledge-probe.ts` (the spike plugin, loaded into the sandbox only),
`last-run.json` (full output of the final run). Request bodies are captured by the mock Anthropic
server — it is the real provider HTTP request the binary sent, after all plugin hooks ran.

## Answers

| # | Question | Answer |
|---|---|---|
| 1 | Can `ctx.session.hook("context")` be async and awaited? | **YES** |
| 2 | Can a plugin observe session creation? | **YES** — `ctx.event.subscribe()` yields `session.created` |
| 3 | Are global `AGENTS.md` / skills re-read per request? | **Re-read during a session (within ~1–2.5 s of the change), but surfaced differently**: existing sessions keep their original system block and get the change as an appended `<system-update>` user message; new sessions get it in the system block |

## 1. Async `context` hook is awaited

Probe plugin hook (`knowledge-probe.ts`):

```ts
await ctx.session.hook("context", async (event) => {
  await sleep(200)
  event.system.push({ type: "text", text: "SPIKE_ASYNC_MARKER_7f3a (appended after await 200ms)" })
})
```

Plugin log: `context.enter systemLen=4` → `context.exit tookMs=201 systemLen=5` (every main turn,
5 turns in the run). Outgoing provider request (mock server) for the first turn: `system` has 5 blocks, the last
one ends with:

```
...make the worktree the session's working directory.\nSPIKE_ASYNC_MARKER_7f3a (appended after await 200ms)
```

The marker is present in the system blocks of **every** main request (turn 1, 2, same-session retries, a new
session). Notes:
- The hook only runs for main turns (event keys: `sessionID, model, system, messages, options, agent, tools`).
  The title request (1 system block, no tools) is a different hook kind and did not get the marker — consistent
  with `manta-claude-max` registering its identity hook per kind.
- The handler adds ~its own latency to every request (200 ms here); a briefing handler must be cache-only (no
  network wait on the hot path) — prefetch elsewhere.

## 2. Session-created event is observable

`ctx` (plugin context) keys in 2.0.30: `app, location, options, agent, aisdk, command, credential, event,
experimental, generate, model, provider, integration, mcp, permission, plugin, reference, rpc, skill, storage,
tool, vcs, websearch, worktree, session, shell`. `ctx.session` keys: `hook, create, get, remove, switchAgent,
switchModel, prompt, generate, command, compact, synthetic, interrupt, update, move, wait, context`.
`ctx.event.subscribe()` returns an **async iterable** (`isAsyncIterable: true`; the built-in `opencode.plan`
plugin uses the same call, `event.subscribe().pipe(filter(type === "session.created"…))`).

Observed (`for await (const ev of ctx.event.subscribe())`). Envelope keys: `id, created, type, durable, location,
data`. Top-level session:

```json
{"type":"session.created","data":{"sessionID":"ses_e1709c59…","projectID":"5126…","location":{"directory":"/tmp/manta-v2-sandbox-XB3Oic/project"},"subpath":"","slug":"hidden-engine","model":{"id":"claude-haiku-4-5","providerID":"anthropic"},"version":"2.0.30"}}
```

Child session (created with `parentID`):

```json
{"type":"session.created","data":{"sessionID":"ses_e1709981…","projectID":"5126…","location":{"directory":"…/project"},"subpath":"","parentID":"ses_e1709c59…","slug":"cosmic-engine","model":{…},"version":"2.0.30"}}
```

Fields: `sessionID`, `parentID` (only when a child), `location.directory`, `subpath`, `model`, `slug`, `projectID`.
(`agent`/`title` were absent for sessions created without them.) The event arrives before the session's first
`context` hook call (created at +22 ms, first `context.enter` ≈ +440 ms after in the run), so a prefetch started
on `session.created` can be warm by the first request. Other session events seen on the same stream:
`session.instructions.updated`, `session.inbox.*`, `session.execution.*`, `session.step.*`, `session.text.*`,
`session.compaction.*`, `session.renamed`, `session.usage.updated`.

## 3. Global AGENTS.md and skills

Sandbox config dir `$XDG_CONFIG_HOME/opencode/` with `AGENTS.md` (marker V1) and `skills/alpha-skill/SKILL.md`
before start. Same session A; files changed between prompts. "where" = where the marker appeared in the outgoing
request body (`run.mjs` `summ()`; main request only).

| Step | AGENTS V1 | AGENTS V2 / V3 | alpha skill | beta skill (added later) |
|---|---|---|---|---|
| A turn 1 (start) | system | – | system | – |
| write AGENTS V2 + add beta skill; A turn 2 immediately (<1 s) | system | **absent** | system | **absent** |
| A turn 3 after 5 s | system | **messages** (V2) | system | **messages** |
| new session B | **absent** | **system** | system | **system** |
| A: write V3, prompt at +984 ms | – | V3 absent | | |
| A: prompt at +2554 ms | – | V3 in **messages** | | |

Mechanism (from the captured body): the existing session's `system` blocks stay byte-identical (5 blocks,
V1 text); the change arrives as an extra user message right before the new prompt:

```
{"role":"user","content":[{"type":"text","text":"<system-update>\nThe instructions changed:\nInstructions from: <sandbox>/xdg/config/opencode/AGENTS.md\nGLOBAL_AGENTS_V3_marker_cc33\n\n</system-update>"}]}
```

and a `session.instructions.updated` event (delta keyed `core/instructions`, `core/skill-guidance`, …) fires
for the session. The skill list lives in the system prompt (not a tool description). Conclusions:

- OpenCode does **not** cache these per process; it re-reads within ~1–2.5 s of a change (file watcher or a
  short TTL — not distinguished). Whichever it is, daily batching is not needed to avoid staleness.
- A mid-session change does **not** rewrite the system prompt (prompt cache of the existing prefix is intact);
  it appends one `<system-update>` user message per change to the conversation. Each global write therefore
  adds visible conversation noise (and tokens) to every active session, and sessions that stay idle past their
  cache TTL re-bill anyway. This keeps §6.8's batching useful as the default (fewer updates ⇒ fewer
  `<system-update>` messages) even though it is no longer required for correctness.
- New sessions pick the current files up in the system block.

## Not verified / limits

- Compaction effect on instructions: an explicit `/compact` was attempted but the mock model's summary did
  not match opencode's required template (`compaction.failed`), so what a successful compaction does to the
  instructions block was not measured.
- Watcher vs TTL for the re-read was not distinguished (only "≤ ~2.5 s").
- Process-restart behaviour not run (trivially a fresh read; not worth a restart in the sandbox).
- The mock model replaces the real one only; every observation is of requests produced by the real binary.
- Plugin SDK types: no `@opencode/plugin` package is installed on this box (the module is bundled in the
  binary), so Q2's field list comes from the live experiment plus the bundled built-in plugin source
  (`strings` of the binary), not from `.d.ts` files.
