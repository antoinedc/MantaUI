# P1 — Claude Max subscription auth + multi-account seat switching on OpenCode V2

V2 binary: opencode v2.0.30 (/home/dev/v2proof/bin/opencode). Isolated sandbox
HOME=/home/dev/v2proof/p1/home, XDG_* under it, port 4211. Live box (opencode-serve
on :4096) never touched. Sandbox creds = access token + expiry + sub metadata only,
NO refreshToken, mode 0600 (refresh never attempted against real tokens).

Env facts (live, read-only): `ANTHROPIC_CLI_VERSION=2.1.280`,
`subscriptionType=team`, `rateLimitTier=default_claude_max_5x`, access token
had 68 min left at spike start (>20 min floor OK).

---

## GOAL 1 — V1 plugin mechanism inventory (opencode-claude-auth@2.2.1)

Extracted by `npm pack` into the sandbox. The plugin makes OpenCode talk to
`api.anthropic.com` AS Claude Code, billed to the Max/Pro/Team subscription.
The mechanisms, each of which the V2 port must reproduce:

### M1 — Auth loader (no API key)  [dist/index.js:189]
V1 hook `auth: { provider:"anthropic", async loader(getAuth, provider) {...} }`.
Returns `{ apiKey:"", baseURL:"https://api.anthropic.com/v1", fetch }` — i.e. it
provides a **custom fetch** and an empty apiKey so the anthropic provider is
usable WITHOUT an API key. Credentials come from the file, not config.

### M2 — Credentials source  [dist/keychain.js:155, credentials.js]
Reads `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` / `.expiresAt`
/ `.refreshToken` (dir overridable by `CLAUDE_CONFIG_DIR`). Also supports a
macOS keychain + a multi-account source file
(`~/.local/share/opencode/claude-account-source.txt`) and writes a synced
`~/.local/share/opencode/auth.json`. Proactive refresh via OAuth if near expiry
(we do NOT exercise refresh in this spike).

### M3 — Request headers (impersonate Claude Code)  [dist/index.js:85-97]
On every outbound request the custom fetch sets:
- `authorization: Bearer <accessToken>`   ← subscription OAuth token, not x-api-key
- `anthropic-version: 2023-06-01`
- `anthropic-beta: <merged betas>`         ← see M4
- `anthropic-dangerous-direct-browser-access: true`
- `x-app: cli`
- `user-agent: claude-cli/<ver> (external, sdk-cli)`  (ver = ANTHROPIC_CLI_VERSION ?? ccVersion 2.1.280)
- `x-client-request-id: <uuid>`, `X-Claude-Code-Session-Id: <stable per-proc uuid>`
- x-stainless-* SDK headers (arch/lang/os/pkg-version 0.81.0/runtime…)
- **deletes `x-api-key`**.
Also appends `?beta=true` to `/v1/messages` URLs [index.js:33].

### M4 — Beta flags, model-gated  [dist/betas.js, model-config.js]
baseBetas include `claude-code-20250219`, `oauth-2025-04-20`,
`interleaved-thinking-2025-05-14`, `prompt-caching-scope-2026-01-05`,
`context-management-2025-06-27`, `advisor-tool-2026-03-01`,
`thinking-token-count-2026-05-13`, `extended-cache-ttl-2025-04-11`.
Per-model overrides: haiku EXCLUDES `effort-2025-11-24` (+disableEffort);
opus-4-5 / 4-6 / 4-7 ADD `effort-2025-11-24`. Long-context betas dropped
adaptively on "out of extra usage" errors.

### M5 — System-prompt identity  [dist/transforms.js:19 + index.js:180]
`SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."`
V1 hook `experimental.chat.system.transform` unshifts it as system[0] for the
anthropic provider. In `transformBody` it is ALSO split into its own system
entry and a billing header is injected ahead of it.

### M6 — Body rewrites (transformBody)  [dist/transforms.js:265]
On the serialized request body:
- Inject `x-anthropic-billing-header: cc_version=V.S; cc_entrypoint=E; cch=H;`
  as **system[0]** (no cache_control). Signature V.S/cch derived from the first
  user message text + salt `59cf53e54c78` (signing.js) — Claude-Code billing proof.
- Prefix every tool name with `mcp_` + PascalCase first char (`read`→`mcp_Read`):
  Anthropic's OAuth billing validation rejects lowercase tool names. Applied to
  `tools[].name` AND `messages[].content[].tool_use.name`. Response stream is
  un-prefixed on the way back (`stripToolPrefix`).
- Tool-repair pass: guarantee tool_use↔tool_result adjacency (synthesize
  placeholder results / drop orphans) so OAuth billing validation passes.
- entrypoint = `CLAUDE_CODE_ENTRYPOINT ?? "sdk-cli"`.

### M7 — Retry/limit handling  [dist/http.js]
429/529 retry with retry-after, capped (30s default) — a longer retry-after is
treated as a quota reset and surfaced rather than hung on.

**Net:** the plugin is (a) a credential provider that swaps x-api-key for a
subscription Bearer, (b) a request impersonator (headers + betas + body
rewrites) so Anthropic bills the Max subscription and accepts the OAuth token.
Both halves must be reproduced in V2.

---

## GOAL 2 — V2 plugin `manta-claude-max` built  [PROVEN]

`plugin/manta-claude-max.ts` (also in plugins/ dir). Reproduces every mechanism:
- M1 provider-without-key: `opencode.jsonc` sets `provider.anthropic.options.apiKey=""`;
  with the plugin present, 20 anthropic models become available & usable (no key).
- M5 identity: `ctx.session.hook("context")` unshifts SYSTEM_IDENTITY into event.system.
- M3+M4+M6: `ctx.session.hook("http.request", …, {providerID:"anthropic"})` rewrites the
  native provider Request — sets Bearer + anthropic-version + merged betas + x-app:cli +
  user-agent `claude-cli/<ANTHROPIC_CLI_VERSION> (external, sdk-cli)` + stainless/session
  headers, deletes x-api-key, adds ?beta=true, and rewrites the body (billing header as
  system[0], tool-name PascalCase mcp_ prefix). Honours ANTHROPIC_CLI_VERSION.

Plugin loaded cleanly: `/api/plugin` lists `manta.claude-max` state=active source=local;
serve.log shows `[manta-claude-max] setup {"cliVersion":"2.1.280"}`. `@opencode/plugin`
resolved inside the standalone binary with NO node_modules.

## GOAL 3 — Real subscription-billed turns  [PROVEN]

V2 server on :4211, isolated sandbox, plugin only. Set model via POST /api/session/{id}/model
`{model:{providerID,id}}`; prompt via POST …/prompt `{text}`; assistant text lives in the
message `.content[]` array.

- **Haiku** (`claude-haiku-5-5`): reply `HAIKU_PROOF_OK`, finish `end_turn`, tokens
  in=4 out=15 cache.write=21061, cost 0.00264. (artifacts/haiku-proof.json)
  Plugin log: `signed {kind:primary, modelId:claude-haiku-5-5, betas:9, bodyRewritten:true,
  tokenSha12:534d78a8a3ed}`.
- **Opus** (`claude-opus-5-5`, newest, version-gated): reply `OPUS_PROOF_OK`, finish `stop`,
  cost 0.1058, same seat token. (artifacts/opus-proof.json)
  Both turns ran WITHOUT an API key — pure subscription Bearer via the plugin.

### Model-gating via ANTHROPIC_CLI_VERSION  [PROVEN, both directions]
Restarted V2 with `ANTHROPIC_CLI_VERSION=2.1.100` (stale). Same Opus request → HTTP 400
`invalid_request_error`: **"Claude Code 2.1.100 does not support this model; version 2.1.280
or newer is required."** (artifacts/stale-version-gated.json). With 2.1.280 the identical
request succeeded. So the version-gating mechanism carries over to V2 unchanged — the env
override is the single lever, exactly as on V1.

---

## GOAL 4 — Multi-account seat switching per session  [PROVEN, two REAL accounts]

Manta has 11 real Claude seats under `~/.manta-secrets/accounts/claude/seat-*/.credentials.json`.
Copied seat-1 and seat-2 ACCESS TOKENS ONLY (no refresh) into the sandbox. One V2 server,
two sessions; a live JSON map file (`seat-map.json`, RE-READ per request by the plugin —
the stand-in for manta-server's `GET /api/accounts/resolve`) mapped session A→seat-1,
session B→seat-2. Ran a Haiku turn in each:

- session A → signed with seat-1 token (sha12 `a30137195753`), reply `SEAT_A_OK`, finish stop.
- session B → signed with seat-2 token (sha12 `90ff233ecbcf`), reply `SEAT_B_OK`, finish stop.

(artifacts/multi-seat-A.json, multi-seat-B.json, multi-signed.log). Two DISTINCT real
subscription tokens, selected per request by `event.sessionID` inside the `http.request`
hook. This is the mechanism manta-accounts needs — and it is CLEANER than V1:

- V1 `manta-accounts.ts` monkey-patches `globalThis.fetch` and sniffs the
  `x-opencode-session-id` / `x-opencode-parent-session-id` HEADERS opencode injected on the
  provider request to learn the session.
- V2 gives `event.sessionID` + `event.kind` DIRECTLY on the `http.request` hook, so no global
  patch and no header-sniffing. The parentSessionID fallback (child inherits root's seat) still
  needs resolving — either from the session tree via `ctx.session.get`, or by manta-server as
  today. The per-request seat read, token swap, Codex residency header, and the 429→re-place→
  re-send-once logic all map onto this one hook.

## GOAL 5 — Token refresh design (not executed against real tokens)

The spike deliberately strips refresh tokens and never refreshes. The port's refresh design:

- **Keep refresh in manta-server, as today.** manta-accounts already refreshes a seat by
  `POST /api/accounts/refresh` (server runs the `claude` CLI / OAuth exchange, rewrites the
  seat's `.credentials.json`), then the plugin RE-READS the file. The V2 plugin keeps that
  contract: on a token within `EXPIRY_MARGIN_MS` (60s) of expiry, or a 401 from a non-live
  seat, call manta-server to refresh, re-read the seat file, retry once. The `http.request`
  hook is async (proven — our hook awaits `req.clone().text()`), so an `await` to manta-server
  before signing is fine.
- **Could V2's own credential/integration store own it?** Partially. V2 ships
  `ctx.integration.oauth.{connect,status,complete}` + `ctx.credential.activate` and a
  `/api/credential` store — but (a) anthropic is NOT an OAuth-enabled integration in V2 (round1
  finding: only 8 integrations expose oauth, anthropic not among them), and (b) `/api/credential`
  LEAKS values in plaintext (round1-c C4). So the V2 integration OAuth machinery cannot mint a
  Claude Max token; refresh must stay the manta-server `claude`-CLI path. V2's credential store
  is usable as a token CACHE at most, not as the refresh authority. Recommendation: refresh
  stays server-side exactly as V1; the plugin only reads + retries.
- The single-login path (M2) refreshes the live `~/.claude/.credentials.json` the same way the
  box does today (self-update keeps `claude` current); the plugin must NOT rotate the refresh
  token itself — that is the box's login and belongs to the `claude` CLI.

## GOAL 6 — Risks / fragility in the V2 port

- **R1 (FOUND + FIXED in spike) — tool-name prefix needs a RESPONSE un-prefix hook.** V1 did
  request-prefix AND response-un-prefix (`stripToolPrefix`) inside ONE custom fetch. In V2 the
  two are SEPARATE hooks: `http.request` (prefix `shell`→`mcp_Shell` for OAuth billing
  validation) and `http.response` (un-prefix so opencode's tool router sees `shell`). With only
  the request hook, a tool turn FAILED (`mcp_Shell` not found, finish=tool-calls, model gave up).
  Adding the `http.response` SSE-rewrite hook fixed it: tool `shell` completed, model replied
  `DONE` (artifacts/tool-roundtrip-proof.json). **The port MUST register both hooks.** Caveat:
  streaming chunks can split a `"name":"mcp_X"` token across reads; V1 buffered whole SSE events.
  A production port should buffer to event boundaries before the regex (a known, bounded piece of
  work), not rewrite raw decoder chunks as the spike does.
- **R2 — body is a one-shot stream; must clone before read and rebuild the Request.** Proven
  workable (`req.clone().text()` then `new Request(url, {..., duplex:"half"})`). A Request's url
  and body are immutable, so the `?beta=true` URL change requires constructing a new Request.
- **R3 — cache_control (1h TTL) survives.** With `models.<id>.settings.cacheControl.ttl:"1h"`
  in config, turns ran and billed cache.write normally (round1-c confirmed the config key moved
  under `models.<id>.settings`; this spike ran with it set and saw cache.write=355/read=21969).
  The plugin does NOT touch cache_control — opencode owns breakpoint placement, as in V1. Low risk.
- **R4 — provider-without-apiKey depends on `options.apiKey:""`.** Setting apiKey to "" (plus the
  plugin) made all 20 anthropic models usable. A cleaner port would register the provider via
  `ctx.provider.transform` so no sentinel empty key is needed; the config route works today.
- **R5 — betas/version drift.** BASE_BETAS, ccVersion fallback, and model overrides are copied
  from V1 model-config.js and will drift as Anthropic changes them (exactly as V1 drifts). The
  `ANTHROPIC_CLI_VERSION` env lever is the box's existing mitigation and carries over unchanged
  (proven: 2.1.280 works, 2.1.100 is rejected by Anthropic with a precise version error).
- **R6 — billing header signature.** The `x-anthropic-billing-header` cc_version/cch signing
  (signing.js, salt 59cf53e54c78) is reproduced; it is an undocumented Claude-Code impersonation
  detail and the single most likely thing Anthropic could change to break subscription billing on
  non-Claude-Code clients. Shared risk with V1, not new to V2.

## Net verdict

Claude Max subscription auth AND Manta multi-account seat switching both WORK on OpenCode V2,
via a ~260-line in-house plugin using `ctx.provider.transform` (no-key provider),
`ctx.session.hook("context")` (identity), and `ctx.session.hook("http.request"/"http.response")`
(headers + betas + body prefix/un-prefix + per-session seat token). Real subscription-billed
Haiku and Opus turns succeeded with no API key; version-gating via ANTHROPIC_CLI_VERSION works
both ways; two distinct real seats were selected per session. The port is a rewrite (not a
config flip) but is mechanically clear and de-risked by this spike.

## Safety closeout
Live box opencode-serve :4096 never touched (active throughout). Only our sandbox servers on
4211/4214/4215/4216/4217 were started and stopped. All sandbox credential copies
(1 single-login + 2 seat tokens, access tokens only, no refresh tokens) deleted at spike end.
