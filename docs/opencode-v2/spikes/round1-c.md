# Spike C — MantaUI → OpenCode V2 feasibility

V2 version: **v2.0.30** (standalone linux-x64 binary). V1 live on box unchanged.

Auth scheme discovered: server prints `server password <pw>` on startup; API auth is
**HTTP Basic `opencode:<password>`** on `/api/*`. `/` and `/config` serve the web SPA unauth.

---

## C1 — Config compatibility

**Answer:** V2 LOADS our sanitised `opencode.jsonc` and transforms it into a new internal
shape, but (a) KEYS ARE RENAMED, (b) per-model `cacheControl` SURVIVES, (c) our PLUGINS
FAIL TO LOAD, (d) `PATCH /global/config` is gone.

**Evidence** (`GET /api/config`, Basic auth):
- Returns an ARRAY of config "documents" (one per config file + dirs scanned), each with
  a resolved `info`. doc[0] = our opencode.jsonc.
- Key renames in the resolved shape:
  - `agent` → `agents` (498 agents loaded; `mode:"subagent"` added)
  - `plugin` → `plugins`
  - `mcp` → `mcp.servers` (runpod/axiom/firebase loaded, shape `{type:"remote",url,disabled}`)
  - `provider` → `providers`
  - `model:"x"` → `model:{providerID,model}`
  - `permission.external_directory:"allow"` → `permissions:[{action,resource:"*",effect:"allow"}]`
- **`cacheControl` SURVIVES**: `providers.anthropic.models["claude-opus-4-8"]` =
  `{"modelID":"claude-opus-4-8","settings":{"cacheControl":{"type":"ephemeral","ttl":"1h"}}}`.
  So Manta's 1h cache TTL has a V2 home (moved under `models.<id>.settings`).
- **PLUGINS FAIL** (serve.log): both `opencode-claude-auth-bui@1.5.4-bui.1` and
  `opencode-claude-auth@latest` →
  `PluginModule.LoadError: Plugin must export a default definition with an id and an
  effect or setup function. (SchemaError Expected object at ["default"])`.
  V2 changed the plugin module contract. **This is a hard blocker** — claude-auth is how
  the box authenticates to Anthropic as Claude Max.

**Confidence:** verified (live server, our config).

**Manta impact:**
- Config still readable by V2 but the write path changes: V1's `PATCH /global/config`
  (providers.mjs) must be re-checked against V2 (see C3). Manta's `removeConfigKeys`
  surgical jsonc edit still works at the file level.
- `src/shared/subagentSync.mjs` generates an `agent` map — V2 reads it (renamed `agents`
  internally but the on-disk `agent` key is accepted). Named subagents DO load.
- **Plugin incompatibility is the biggest C1 risk**: the Claude Max auth plugin won't run
  on V2 as-is; needs a rewrite to the new default-export plugin API.

---

## C3 — Server auth & service model

**Answer:** V2 introduces a **background-service model with mandatory HTTP Basic auth**
(a per-instance generated password). It CAN still run as a plain pinned-port systemd unit
(`opencode serve --port --hostname`), but the local client must send `Authorization: Basic
opencode:<password>`. `--service` adds a registration file in XDG state. Self-update exists.

**Evidence:**
- `opencode serve --port 4198 --hostname 127.0.0.1` works, binds 127.0.0.1:4198 like today.
  Flags: `--hostname --port --cors --service --stdio`.
- On startup it PRINTS `server password <pw>` to stderr. `/api/*` require auth:
  `curl -u opencode:<pw>` → 200; no auth → 401. `/` and `/config` serve the web SPA unauth.
- `@opencode/client` 2.0.30 (`npm pack`), `dist/service.d.ts`:
  `auth?: { type:"basic", username:string, password:string }` and the registration `Info`
  carries `password?` + `pid` + base `url`. `DiscoverOptions.file` = "Absolute registration
  file path. Defaults to the XDG state directory." `EnsureOptions.command` defaults to
  `opencode serve --service`.
- `opencode service {start,stop,restart,status,get,set,unset}` manage the background server.
- `opencode api` CLI requires `OPENCODE_PASSWORD` env to talk to a password-protected server.

**Confidence:** verified.

**Manta impact:**
- manta-server must learn Basic auth: capture the startup password (or read the registration
  file in XDG_STATE) and send `Authorization: Basic`. V1 was unauthenticated on loopback — a
  real wiring change in `src/server/opencode.mjs`.
- Can keep today's systemd user unit shape (fixed 127.0.0.1 port) with `serve --port` — the
  `--service`/background model is optional, not forced. Recommend NOT using `--service` to
  keep the "plain unit on a fixed port" contract; just add the password header.
- **Coexistence risk:** V2 walks up from CWD and reads `.opencode` / config dirs. A V2 run
  from /home/dev read `/home/dev/.opencode`. Shared default config paths (`~/.config/opencode`)
  mean V1 and V2 would read the SAME config file — isolate V2 with its own XDG_* envs
  (as this spike did) or a dedicated config dir. Self-update: pin via config `update` / don't
  invoke `opencode upgrade`; the standalone binary does not auto-update unless told.

---

## C4 — Security defaults

**Answer:** **`GET /api/credential` LEAKS SECRET VALUES in plaintext** (hard security finding).
`external_directory` is NOT allow-by-default — the build agent defaults to `allow` ONLY because
our config set it; a stock build agent has sensible deny/ask defaults.

**Evidence:**
- Created `POST /api/credential {integrationID:"test-xyz", value:{type:"key",key:"SECRET_SENTINEL_12345"}}`
  then `GET /api/credential` → response contained `"key":"SECRET_SENTINEL_12345"` verbatim.
  (Dummy deleted, `DELETE /api/credential/<id>` → 204.)
- `GET /api/agent` build agent `permissions`: `{*:allow}`, `read *.env:ask`, `read *.env.*:ask`,
  `read *.env.example:allow`, `question *:allow`, `external_directory *:allow` (from OUR config),
  `browser *:deny`. So V2 ships `*.env` read-gating and `browser:deny` by default.

**Confidence:** verified.

**Manta impact:**
- The credential-leak means manta-server must NEVER proxy `/api/credential` to a client, and
  must treat the V2 API as holding live secrets on an authenticated loopback port. This mirrors
  V1's "`/api/model` leaks apiKey, use `/provider`" gotcha — same class, new endpoint. Audit any
  Manta code that forwards opencode responses.
- `external_directory:allow` is Manta's own config choice (migrated correctly); the default is
  safer. Manta relies on `external_directory:allow` for cross-worktree work — keep it in config.

---

## C2 — V1 history migration

**Answer:** V2 uses a **completely new SQLite schema** (`session_v2`, `session_message`,
`instruction_*`, `worktree`, `kv`, `session_inbox` — 50 drizzle migrations) stored at the
**same path** `~/.local/share/opencode/opencode.db`. A dedicated `v1→v2` migration exists
(`migration.v1-v2`, status at `GET /api/experimental/migration/v1/status` →
`required|running|completed|error`), but it is NOT triggered by dropping a raw V1 db at the
V2 path — V2 treats that as its own db and fails (`SQLiteError: table 'project' already
exists`). The migration auto-detects a V1 store by a signal I could not reproduce in-sandbox
(the route returned 404 with no V1 source present). I could not time a completed migration.

**Evidence:**
- V2 own schema (fresh db): tables `session_v2, session_message, project, workspace,
  worktree, instruction_blob/entry/state, session_inbox, session_pending, kv, credential,
  permission, event…`. V1 schema: `session, message, part, session_message, todo, …`.
- V1 `part` table (message content parts) is GONE in V2 — content is folded into
  `session_message.data` (TEXT/JSON). `session`→`session_v2` with new cols (`fork_session_id`,
  `tokens_cache_read/write`, `cost`, `summary_*`).
- Placed a consistent reduced V1 db (`sqlite3 ".backup"`-style selective copy: 20 sessions,
  781 messages, 3039 parts, 14MB) at `$XDG_DATA_HOME/opencode/opencode.db`; V2 startup logged
  `database migration started migration=20260127222353_familiar_lady_ursula` then
  `SQLiteError: table 'project' already exists` and the CLI process died. So V2 ran its OWN
  drizzle migrations over the V1 file rather than a V1→V2 import.
- `/api/experimental/migration/v1/status` → 404 in all tests (no pending migration detected
  without a recognized V1 source).

**Confidence:** verified (schema divergence, failed raw-db placement, route behaviour);
INFERRED that a real migration needs V2's own detection trigger (could not exercise it).

**Manta impact:**
- **Manta's direct-SQLite reads BREAK on V2.** `src/server/messageSearch.mjs` and the ledger
  code query V1 `message`/`part`/`session` tables; V2 has `session_v2`/`session_message` and no
  `part` table. Search/ledger must be rewritten against the new schema (content now lives in
  `session_message.data` JSON — likely needs JSON extraction or the new `/api/*` search route).
- Migration of the live 34GB / 4414-session V1 db is a real operation: budget time, run it
  OFFLINE once, and verify V1 is left intact (V2 appears to migrate in place at the same path —
  **back up the V1 db first**; the same-path collision is a coexistence hazard).
- Recommend: do NOT rely on dropping the V1 db in; use V2's official migration trigger (likely
  a first-run detection or an explicit start call) and poll `/api/experimental/migration/v1/status`.

---

## C5 — Instructions (AGENTS.md / CLAUDE.md / LSP)

**Answer:** V2 loads global `~/.config/opencode/AGENTS.md` and project `AGENTS.md` (there are
dedicated `instruction_*` tables and a `GET /api/session/{id}/context` route). Config
instructions normalize cleanly. Could not run a live turn (plugins fail → no Anthropic auth),
so context-load is inferred from schema+routes, not a turn.

**Evidence:**
- V2 db has `instruction_blob`, `instruction_entry`, `instruction_state` tables (session-scoped
  FKs to `session_v2`), and the client exposes `session.instructions.entry.{list,put,remove}`
  and `session.context`. Our global AGENTS.md was copied into the sandbox config dir and V2
  scanned the config directory (`/api/config` lists the config dir as a document).
- `session.context` route exists (`SessionContextInput`), the intended verification path.

**Confidence:** inferred (routes + tables present; no live turn run because the claude-auth
plugin won't load to make a cheap model call).

**Manta impact:**
- AGENTS.md loading is preserved — Manta's big global+project AGENTS.md should still apply.
  CLAUDE.md fallback / LSP are opencode-internal; not something Manta depends on directly.
  Low risk, but verify with one real turn once the auth plugin is ported.

---

## C6 — Maturity

**Answer:** V2 is **v2.0.30** (standalone linux-x64 binary from
opencode.ai/update/api/latest). It is a distinct, actively-developed line (own client pkg
`@opencode/client@2.0.30`, new service model). V1 (`opencode-ai` on npm) is the installed
line on the box.

**Evidence:**
- `./bin/opencode --version` → `opencode v2.0.30`.
- `@opencode/client` npm latest = `2.0.30` (`npm view`), published package pulled.
- Binary is a self-contained bun executable (`/$bunfs/root/...`); 212MB.

**Confidence:** verified (version); INFERRED on stable-vs-beta (did not fetch changelog/release
URL — no network doc fetch done).

**Manta impact:**
- V2 is a major-version rewrite (new schema, new plugin API, new auth, new config shape), not a
  point upgrade. Migration is a project, not a flag flip. Pin whichever version Manta targets;
  do not let the box auto-`opencode upgrade` across the V1→V2 boundary.
