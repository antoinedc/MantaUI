# Spike A — MantaUI on OpenCode V2 — Findings

V2 binary: opencode v2.0.30 (standalone linux-x64), isolated under /home/dev/v2spike/a.
All V2 commands run with HOME/XDG_* pointed into the sandbox; live box never touched.

---

## A1. Claude Max under V2

### Answer (so far)
- **`opencode-claude-auth@2.2.1` (latest) is a V1 plugin, NOT a V2 port.** It targets
  `@opencode-ai/plugin` (V1), default-exports `const plugin = async () => ({ ...hooks })`,
  and uses V1-only hook keys. **V1 plugin implementations do not run in V2** (per docs).
  So "2.x" ≠ V2 support — it is just a newer V1 plugin. A port is required.
- The plugin's Claude Max mechanism is the V1 `auth: { provider: "anthropic", loader }` hook
  + `experimental.chat.system.transform` (injects Claude Code system identity) + a custom
  `fetch` that signs requests as Claude Code. In V2 these map to:
  `auth` → `ctx.integration.transform(...)` / integration APIs; system transform →
  `ctx.session.hook("context", ...)`; request signing → `ctx.session.hook("http.request")`
  or `model.request`. No one-to-one; a real rewrite.
- **`ANTHROPIC_CLI_VERSION` survives a port unchanged**: the plugin reads
  `process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion` (dist/index.js:16, transforms.js:272;
  hardcoded fallback ccVersion "2.1.280"). The env override is plain code, portable to V2.

### Evidence
```
npm pack opencode-claude-auth@2.2.1   # latest == 2.2.1
# package.json: peerDependencies "@opencode-ai/plugin":"*", main opencode-claude-auth.js
grep: dist/index.js:102  const plugin = async () => {
grep: dist/index.js:189  auth: { provider: "anthropic", async loader(getAuth, provider) {...}}
grep: dist/index.js:180  "experimental.chat.system.transform": async (input, output) => {...}
grep: dist/index.js:550  export const ClaudeAuthPlugin = plugin; export default plugin;
grep ANTHROPIC_CLI_VERSION: dist/index.js:16 return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
dist/model-config.js:2  ccVersion: "2.1.280"
```
Confidence: **verified** (plugin source) for "it's V1".

- **V2 has NO built-in Anthropic subscription / OAuth integration.** Live V2 server
  `GET /api/integration/anthropic` → methods `[key, env]` only. Of ~230 integrations only
  8 expose `oauth` (digitalocean, github-copilot, gitlab, openai, opencode, poe,
  snowflake-cortex, xai) — anthropic is NOT among them, and there is no `claude-max`/`pro`
  integration id. So Claude Max OAuth is not something V2 ships; the plugin is the only path.
  Confidence: **verified** (live API, artifacts/integrations.json).

### V2 server auth (needed by manta-server to talk to opencode)
- `opencode serve` prints `server password <RANDOM>` on startup. `/api/*` routes require
  **HTTP Basic auth, username `opencode`, password = that server password**
  (`curl -u opencode:$PW`). Bearer / x-password headers → 401. NOTE: non-`/api` routes like
  `/session` answered 200 without auth on loopback, but the canonical V2 surface is `/api/*`
  and IS gated. manta-server must read the password and send Basic auth.
  Confidence: **verified** (401 vs 200 matrix, live).

### Final A1 verdict
Claude Max is **usable on V2 but NOT drop-in**: requires a V2 port of opencode-claude-auth
(in-house or upstream) implementing the integration + context + http.request hooks; the
`ANTHROPIC_CLI_VERSION` gating mechanism carries over unchanged. This is the single biggest
blocker for the migration.

### Manta impact
Claude Max is NOT drop-in on V2. Either (a) wait for / fund a V2 port of opencode-claude-auth,
or (b) port it in-house (auth-integration + context + http.request hooks). The custom
`opencode-claude-auth-bui@1.5.4-bui.1` fork Manta also ships is certainly V1 too and needs the
same port. ANTHROPIC_CLI_VERSION gating still works once ported.

---

## A2. Custom tools directory + V2 plugin-registered tools

### Answer
- **V2 does NOT load single-file `$XDG_CONFIG_HOME/opencode/tools/*.ts`.** The global config
  dir is watched for `plugins/`, `skill(s)/`, `AGENTS.md` — never `tools/`. A V1-style
  `tools/spikeping.ts` is silently ignored (not in `/api/plugin`, never watched).
- **V2 DOES auto-load global plugins from `$XDG_CONFIG_HOME/opencode/plugins/*.ts`.** My
  `plugins/spikeplugin.ts` (`Plugin.define({id:"spike.a2", setup})`) loaded: serve.log shows
  `msg="loading plugin" id=.../spikeplugin.ts`, `setup()` ran (console line printed), and
  `spike.a2` appears in `GET /api/plugin`. `@opencode/plugin` resolves with NO node_modules —
  the standalone binary bundles it.
- **A plugin-registered tool is callable by the model AND its `execute(input, context)`
  receives the calling session id.** Forced a Haiku turn to call `spikev2`; the tool dumped
  its context: keys `[sessionID, agent, messageID, id, progress, signal]`,
  `sessionID="ses_..."`, `agent="general"`, `messageID="msg_..."`. **sessionID is present** —
  the load-bearing requirement for every Manta tool is satisfied.
- Nuance: the sessionID seen inside the tool was a child/agent session id, distinct from the
  top-level session I created (opencode ran the turn in a sub-session). Manta tools pass
  `context.sessionID` straight to manta-server; verify manta-server tolerates receiving a
  child session id (it already resolves by directory as a fallback in peers.mjs).

### Evidence
```
serve.log: msg="loading plugin" id=.../plugins/spikeplugin.ts ... SPIKE_A2_PLUGIN_SETUP_RAN
GET /api/plugin (Basic opencode:$PW) -> data[].id includes "spike.a2"
watcher subscribe paths under opencode/: plugins/spikeplugin.ts, skill, skills, AGENTS.md (NO tools/)
session context after forced turn:
  tool call "spikev2" -> content "v2tool pong note=HELLO CTX={...}"
  CTX = {"keys":["sessionID","agent","messageID","id","progress","signal"],
         "sessionID":"ses_ebb75f4d...","messageID":"msg_...","agent":"general"}
```
Confidence: **verified** (live load + live Haiku turn, artifacts/a2-context.json).

### Manta impact
Every Manta tool must be repackaged from a single `tools/*.ts` export into a V2 plugin
(`Plugin.define` + `ctx.tool.transform/editor.add`), placed in `plugins/`. sessionID/directory
survive, so the thin-registrar → manta-server design is preserved. The per-tool `manta-auth.ts`
sibling-import trick is unnecessary in V2 (plugins can share a module normally and the bundler
resolves `@opencode/plugin`). JSON Schema replaces `tool.schema` (zod).

---

## A3. Port a real Manta tool (schedule_list) to V2

### Answer
Ported `schedule_list` from docs/opencode-tools/schedule.ts into a V2 plugin
`plugins/manta-schedule.ts` pointed at a fake manta-server on 127.0.0.1:4199. It loaded,
the model called it in a live Haiku turn, and the fake server received:
`GET /api/schedule?sessionID=ses_ebb740b37ffeug0wOkegP5vAaw` with `Authorization: Bearer
FAKE_TOKEN`. **The session id passed through correctly and the bearer header works.**
`@opencode/plugin` resolves inside the standalone binary with no install step.

### Evidence
```
serve.log: MANTA_SCHEDULE_PLUGIN_LOADED ; /api/plugin -> "manta.schedule" present
fake-manta.log: {"method":"GET","url":"/api/schedule?sessionID=ses_ebb740b37ffeug0wOkegP5vAaw",
                 "auth":"Bearer FAKE_TOKEN"}  (SID == the session created for the turn)
```
Confidence: **verified** (live turn hitting fake endpoint, artifacts/fake-manta.log).

### Porting effort for all ~21 tools
Mechanical and low-risk per tool. Each `tools/<name>.ts` (one or more `tool()` exports) becomes
ONE `plugins/<name>.ts` with `Plugin.define({id, setup})` wrapping each export in
`ctx.tool.transform(e=>e.add({name,description,input:<JSONSchema>,execute}))`. Changes needed:
1. Import `@opencode/plugin` (not `@opencode-ai/plugin`); default-export a `Plugin.define`.
2. Convert `args:{x:tool.schema.string()}` (zod) → `input:{type:"object",properties:{x:{type:"string"}},required:[...],additionalProperties:false}` (JSON Schema).
3. `return "str"` → `return { content: "str" }`.
4. `context.sessionID` / `context.directory` still available (directory present in A2 keys dump? sessionID+agent+messageID+id confirmed; directory likely via ctx.location — VERIFY per-tool).
5. Drop the per-tool `manta-auth.ts` sibling-copy ritual — a shared module imports normally.
Estimate: ~0.5–1.5h per tool for the straightforward registrars (schedule, notify, secrets,
webhook, peers, send-file, serve-page, delegate, progress, cto*, app, widget, media, plan,
plugins, forge). ~21 tools ≈ 2–3 focused days incl. testing. The 2 LOCAL plugins (A4) are the
harder items. One open item: tools reading `context.directory` must confirm its V2 location.

---

## A4. Local plugins → V2 hook mapping

Both local plugins import V1 `@opencode-ai/plugin` and use the V1 object-return shape; neither
runs in V2 as-is.

### manta-optimizer.ts
Returns two hooks:
- `experimental.chat.messages.transform` → **V2: `ctx.session.hook("context", e => edit e.messages)`**
  (per migration table). Masks completed tool outputs in the transcript to save cache tokens.
- `experimental.session.compacting` → **V2: `ctx.session.hook("compaction", ...)`** (set `event.result`).
  Appends retained constraints to the compaction summary.
Both have clean V2 equivalents. **Portable.** Confidence: verified (source + migration doc table).
Caveat: the migration doc explicitly flags `experimental.*` hooks as "re-evaluate, not rename";
the `context`/`compaction` event payload shapes differ from V1 input/output, so the masking logic
needs reworking against `event.messages` / `event.result`, not a literal transliteration.

### manta-accounts.ts  ← HARDEST / RISK
Returns `{}` and does its work by **monkey-patching `globalThis.fetch`** (`install()` sets
`g.fetch = wrapped`, line 707). The wrapper inspects every outbound provider HTTP request,
extracts sessionID/parentSessionID/model, calls manta-server `/api/accounts/{resolve,refresh,limit}`
to pick a seat, and rewrites auth headers — the multi-account seat router.
- There is **no V1 hook** for this either; it relies on a global side-effect that happened to work
  because V1 ran plugins in the server's own JS realm.
- **V2 mapping:** the intent (rewrite the provider request / swap credentials per request) maps to
  `ctx.session.hook("http.request", ...)` (native provider request, has sessionID+kind) and/or
  `ctx.session.hook("model.request")`, plus `ctx.integration`/`ctx.credential` for seat switching.
  This is a **rewrite, not a port** — the biggest single item in the migration. Whether a global
  `fetch` patch still works in V2's plugin runtime is unverified and should not be relied on;
  use the http.request hook instead.
Confidence: verified (source: globalThis.fetch patch); V2 target inferred from migration table.

### Summary
| Plugin | V1 mechanism | V2 target | Portability |
|---|---|---|---|
| manta-optimizer (mask) | experimental.chat.messages.transform | ctx.session.hook("context") | rework, low risk |
| manta-optimizer (compact) | experimental.session.compacting | ctx.session.hook("compaction") | rework, low risk |
| manta-accounts (seats) | globalThis.fetch monkey-patch | ctx.session.hook("http.request")/model.request + credential/integration APIs | REWRITE, high effort/risk |

---

## A5. Plugin RPC (POST /api/rpc/{rpcID}/{method})

### Answer
**Works.** A plugin using `Rpc.define({id,methods,events})` + `ctx.rpc.register` exposes an HTTP
RPC. `POST /api/rpc/spikerpc/echo` (Basic auth) with body `{"input":{"msg":"hi"}}` →
`{"output":{"reply":"rpc-ok:hi"}}`. This gives manta-server a clean, typed channel to call into
opencode plugins (and plugins to call back) — the push alternative to the current /api polling.

### Gotchas (both cost a retry)
1. The `Rpc.define` method shape needs `errors: {}` and a top-level `events: {}` present, or the
   plugin dies at load with `Object.entries requires that input parameter not be null or undefined`
   (silent WARN "failed to load plugin", the plugin still shows in /api/plugin but RPC is
   `rpc.unavailable`).
2. The HTTP body is WRAPPED: `{"input": <your-input-object>}`, response `{"output": <...>}`. A bare
   input object → `rpc.invalid_input: Expected object`. Path also accepts `?location=` query.

### Evidence
```
serve.log: SPIKE_RPC_REGISTERED  (and earlier: WARN "failed to load plugin" until errors/events added)
curl -u opencode:$PW -XPOST /api/rpc/spikerpc/echo -d '{"input":{"msg":"hi"}}' -> {"output":{"reply":"rpc-ok:hi"}}
openapi: POST /api/rpc/{rpcID}/{method} body=$ref Rpc.Input, params rpcID+method(path)+location(query)
```
Confidence: **verified** (live round-trip).

### Manta impact
Viable transport for manta-server ↔ opencode beyond the current SSE+POST pattern; typed and
auth-gated. Not required for the tool port, but a nice option for the accounts/optimizer rewrites.

---

## Overall verdict
Migration is FEASIBLE. Blockers in priority order:
1. **Claude Max auth (A1)** — no V2 port of opencode-claude-auth exists; must port in-house
   (integration + context + http.request hooks). ANTHROPIC_CLI_VERSION gating survives. BIGGEST ITEM.
2. **manta-accounts (A4)** — globalThis.fetch monkey-patch must be rewritten as a session
   http.request hook. High effort.
3. **~21 custom tools (A2/A3)** — mechanical repackage from tools/*.ts to plugins/*.ts
   (Plugin.define + ctx.tool.transform, JSON Schema, {content}); sessionID+bearer preserved. ~2–3 days.
4. **manta-optimizer (A4)** — rework two experimental hooks to context/compaction. Low risk.
5. **Server auth change** — manta-server must use Basic auth (opencode:<server-password>) for /api/*.
