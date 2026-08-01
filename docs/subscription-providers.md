# Subscription providers — spec + work evaluation

Status: **spec / evaluation. Not implemented.** Written 2026-07-27.

Goal: let a user connect a **paid AI subscription** (Claude Max, ChatGPT
Plus/Pro via Codex, Kimi For Coding, …) from inside MantaUI, with adding the
Nth provider being a registry edit rather than a feature.

Scope named by the request: onboarding model/provider selection, install-time
detection alongside Claude, and the Providers section of Settings → AI.
§6 adds the surfaces that were not named but are load-bearing.

---

## 1. The finding that changes the design

**opencode already exposes a complete programmatic provider-auth API over
HTTP.** Verified live against the box's opencode 1.15.12 (`GET /doc` +
live calls):

| Endpoint | What it does |
|---|---|
| `GET /provider/auth` | Auth methods per provider: `{type:"oauth"\|"api", label, prompts[]}` |
| `POST /provider/{id}/oauth/authorize` `{method, inputs?}` | Starts a flow → `{url, method:"auto"\|"code", instructions}` |
| `POST /provider/{id}/oauth/callback` `{method, code?}` | Completes a paste-back flow |
| `PUT /auth/{id}` | Set credentials directly (`{type:"api", key}` / `{type:"oauth", …}`) |
| `DELETE /auth/{id}` | Disconnect |
| `GET /provider` | `connected[]` — the authoritative "is it live" signal (already used) |

Live response on this box, with only the Claude plugin installed:

```
anthropic       -> oauth: "Switch Claude Code account"
openai          -> oauth: "ChatGPT Pro/Plus (browser)"
                 | oauth: "ChatGPT Pro/Plus (headless)"
                 | api:   "Manually enter API Key"
github-copilot  -> oauth: "Login with GitHub Copilot"  (2 prompts)
xai             -> oauth: "…(SuperGrok Subscription)" | oauth: "…(Headless / Remote / VPS)"
poe, gitlab, digitalocean, azure, cloudflare-*  -> oauth and/or api
kimi-for-coding -> null   (provider exists, 4 models, no auth method)
```

And the headless Codex flow actually works, returning a device code:

```
POST /provider/openai/oauth/authorize {"method":1}
  -> {"url":"https://auth.openai.com/codex/device",
      "method":"auto",
      "instructions":"Enter code: TOQR-BUA7Z"}
```

Two further behaviours, both verified by live calls:

- **A provider with `null` auth methods is still connectable.** `/provider/auth`
  only enumerates providers that define *special* methods. Everything else
  takes the generic API-key path: `PUT /auth/{id} {type:"api", key}` returns
  `true` and writes opencode's auth store. This is the sanctioned route for
  Kimi (§7).
- **Credentials do not take effect until opencode restarts.** After a
  successful `PUT /auth/…`, `GET /provider` still did not list the provider in
  `connected[]` after 6 seconds — the running server computes that set at
  startup. This matches the existing custom-endpoint behaviour, where saving a
  provider sets `restartNeeded` and the card offers a confirm-gated restart.
  **So "poll until connected" is not a completion signal on its own; every
  connect flow ends in an opencode restart.** Harmless during onboarding (no
  sessions yet); in Settings it reuses the existing confirmed restart, which
  interrupts every active session.

Three consequences:

1. **ChatGPT/Codex subscription auth is native to opencode. No plugin, no npm
   install, no `~/.codex` reading.** It is a device flow — ideal for a remote
   headless box, and renderable as a card (URL + code) on desktop and mobile
   alike.
2. **This supersedes `docs/onboarding-v2.md` §4.1**, which designed in-app
   Anthropic sign-in as "add a hidden launcher-registry entry, run
   `opencode auth login` in a PTY, poll until connected, parse nothing". That
   was the right call given what was known then; it is now the fallback, not
   the plan. A structured API beats driving a TUI in a terminal — it works
   identically on mobile, needs no `Terminal.tsx`, and gives us real error
   states.
3. **Claude is the odd one out, not the template.** Claude auth today is
   out-of-band: an external `claude` CLI writes `~/.claude/.credentials.json`,
   a third-party plugin reads it, and *MantaUI* owns re-minting (spawning
   `claude -p . --model haiku` on a 10-min poller plus reactive recovery).
   Codex/Kimi/Copilot tokens live in opencode's own auth store
   (`~/.local/share/opencode/auth.json`) and opencode refreshes them itself.
   **Do not generalize the Claude machinery to the new providers — the generic
   case is "opencode owns the token".**

---

## 2. Where we are today

- **Install** (`scripts/install.sh`): merges exactly one plugin name
  (`OPENCODE_CLAUDE_AUTH_PLUGIN` = `opencode-claude-auth@latest`,
  `scripts/install-lib.mjs:318`) into `opencode.jsonc`, then at the very end
  checks `~/.claude/.credentials.json` exists and *warns* if not
  (`install.sh:1350-1367`). No other provider is known to the installer.
- **Onboarding** is 4 steps: Pair → Providers → Model → First project.
  Step 2 (`ProvidersStep.tsx`) hardcodes three cards — Anthropic, OpenAI,
  Custom. The Anthropic card is **not clickable** and renders
  *"In-app Anthropic sign-in is coming soon"* (`ProvidersStep.tsx:176-185`).
  Step 3 (`ModelStep.tsx`) is a flat radio list over `opencodeModels()`.
- **Settings → AI → `ProvidersCard`** means one thing only: an
  **OpenAI-compatible HTTP endpoint** (`{id, name, baseURL, apiKey,
  enabledModels}`) written into `opencode.jsonc`'s `provider` block.
  Subscription providers are **deliberately excluded** — `providers.mjs:170-183`
  filters to blocks that have a `baseURL`, because rendering a plugin-authed
  provider there would give it a Refresh button that fetches `"" + "/models"`
  and a delete button that would corrupt its auth.
- **Detection** everywhere = "does `GET /provider` list it in `connected[]`".
  That part already generalizes for free.

So: the app can *see* a subscription provider but can only *connect* a
BYO-API-key endpoint. Claude is connected out-of-band by the user on the box.

---

## 3. Provider landscape

| Provider | opencode support | Flow | Effort |
|---|---|---|---|
| **Claude Max** | plugin (`opencode-claude-auth`), already installed | reuses `claude` CLI creds; `oauth: "Switch Claude Code account"` also available | done (keep as-is) |
| **Codex (ChatGPT Plus/Pro)** | **native** | device code (headless method) | low |
| **GitHub Copilot** | **native** | oauth + 2 prompts (select + conditional text) | low — free win once the prompt renderer exists |
| **xAI / SuperGrok** | **native** | oauth, headless variant | low, same |
| **Kimi For Coding** | provider exists, **no auth method** | either paste API key (`PUT /auth/kimi-for-coding`) or install `opencode-kimi-full` for the official device OAuth | medium — see §7 |

The registry should therefore describe more than Codex+Kimi from day one;
Copilot and xAI cost approximately nothing extra and prove the abstraction.

**Important UX fact:** unlike Claude, a user already signed into the Codex CLI
does **not** get Codex in opencode for free. opencode's native OpenAI OAuth
mints its own tokens; it does not read `~/.codex/auth.json`. The user signs in
once more, inside MantaUI. Say so in the UI rather than letting them wonder.

---

## 4. Design

### 4.1 One registry, one extension point

New `src/server/subscriptionProviders.mjs` — the analogue of
`launcherRegistry.mjs`, and the *only* file to touch when adding provider N+1:

```js
export const SUBSCRIPTION_PROVIDERS = [
  {
    id: "anthropic",              // opencode provider id
    label: "Claude",
    plan: "Claude Pro / Max",
    // How to pick the auth method out of GET /provider/auth. NEVER an index —
    // indices are positional and shift between opencode versions.
    prefer: [{ type: "oauth", match: /claude code account/i }],
    // Optional npm plugin that must be present for the method to exist.
    plugin: "opencode-claude-auth@latest",
    // Extra local credential files that count as "already set up".
    detect: ["~/.claude/.credentials.json"],
    docs: "https://claude.com/pricing",
  },
  {
    id: "openai",
    label: "Codex",
    plan: "ChatGPT Plus / Pro",
    // Headless FIRST: the browser variant redirects to localhost:1455 on the
    // BOX, which is unreachable from the user's laptop or phone.
    prefer: [{ type: "oauth", match: /headless/i },
             { type: "oauth", match: /chatgpt/i }],
    plugin: null,
    detect: [],
  },
  { id: "kimi-for-coding", label: "Kimi", plan: "Kimi For Coding", /* … */ },
];
```

Everything else is generic: resolve the entry → read `GET /provider/auth` →
pick the first `prefer` rule that matches a live method → drive the flow →
poll `GET /provider` until `connected` contains the id.

**Method resolution by label/type match, never by index, is the single most
important rule here.** `POST …/oauth/authorize` takes `{method: <number>}`, a
positional index into that provider's method array. Hardcoding `1` for "Codex
headless" silently becomes "browser" or "API key" the day opencode reorders
them, and the user gets a localhost URL they can't open.

### 4.2 Connect flow (one component, three shapes)

`POST /provider/{id}/oauth/authorize` returns `{url, method, instructions}`:

- `method: "auto"` — opencode completes the flow itself (device poll or its own
  callback listener). UI shows the URL + the code from `instructions` and a
  copy button. This is Codex.
- `method: "code"` — user pastes a code back; UI collects it and
  `POST …/oauth/callback {method, code}`.
- `type: "api"`, **or no auth methods at all** — a plain key field →
  `PUT /auth/{id} {type:"api", key}`. This is Kimi, and the escape hatch for
  every provider opencode hasn't given a bespoke flow.

All three then converge on the same tail: **restart opencode, re-read
`GET /provider`, confirm the id is in `connected[]`, report success or a
specific failure.** The restart is what makes the credential live; the
re-read is what proves the credential is real (a mistyped API key writes
successfully and only fails at connect time). Without the confirm step the UI
would cheerfully report a bad key as connected.

Plus `prompts[]` (Copilot's select + conditional text, with a `when`
`{key, op:"eq"|"neq", value}` guard) collected *before* authorize and passed as
`inputs`. A small form renderer; ~60 lines, pure and testable.

The same component serves onboarding step 2 and Settings. Build it once.

### 4.3 Settings: a second, separate section

Do **not** widen `ProvidersCard` to cover subscriptions. Its whole shape —
baseURL, API key, model discovery via `GET <baseURL>/models`, delete — is
meaningless for a plugin/OAuth provider, and the exclusion filter at
`providers.mjs:170-183` exists precisely to stop that row from being rendered
and corrupted.

Add **`SubscriptionsCard`** above it in Settings → AI:

```
Subscriptions
  Claude    Claude Pro / Max     ● connected      [Re-authenticate] [Disconnect]
  Codex     ChatGPT Plus / Pro   ○ not connected  [Connect]
  Kimi      Kimi For Coding      ○ not connected  [Connect]
  Copilot   GitHub Copilot       ○ not connected  [Connect]

Custom endpoints                                    ← existing ProvidersCard
```

Shared component ⇒ mobile gets it free (`MobileSettings.tsx` already renders
`<ProvidersCard />`).

### 4.4 Install-time

The installer cannot perform an interactive OAuth. It can and should:

1. Seed the plugin list from the registry (`plugin: [...]` entries that are
   non-null), replacing the single-constant merge. `opencode plugin <mod> -g`
   now exists and does install+config in one step; the existing tested
   `mergeOpencodeConfig` is still the safer path for the seed.
2. **Detect** each registry entry — local credential files (`detect[]`) plus a
   `GET /provider` read once opencode is up — and print a per-provider summary
   instead of today's single Claude warning:

   ```
   ✓ Claude    connected (Claude Code credentials found)
   ○ Codex     not connected — connect from MantaUI, or `opencode auth login -p openai`
   ○ Kimi      not connected
   ```
3. Never fail on a missing provider. Same posture as today's warn-not-die.

`opencode auth login -p <provider> -m <method>` skips both interactive prompts,
so the printed hint is a real one-liner, and it is also the documented manual
fallback if the in-app flow breaks.

---

## 5. Onboarding

Step 2 (`ProvidersStep`) becomes registry-driven: one row per subscription
provider with a Connect button wired to §4.2, plus the existing "custom
endpoint" affordance demoted to a secondary link. The three hardcoded cards and
the "coming soon" dead end go away.

Step 3 (`ModelStep`) needs no structural change — it already renders whatever
`opencodeModels()` returns, so a newly connected Codex subscription simply adds
GPT-5.x rows. Two real gaps:

- The model list is fetched once on mount. After connecting a provider mid-flow
  it must refetch (and after opencode restarts, if a plugin install forced one).
- No blurb or tier badge for any GPT-5.x or Kimi model — see §6.4.

Note `docs/onboarding-v2.md` §4.4 plans to **delete** `ModelStep` entirely in
favour of a defaults card. These two pieces of work overlap; whoever goes second
should read the other's decisions rather than re-deriving them.

---

## 6. Surfaces beyond the three named

### 6.1 Credential maintenance is Claude-shaped and must stay that way

`opencode.mjs:953-1182` runs a 10-minute poller that reads
`~/.claude/.credentials.json`, and a reactive recovery on `session.error`, both
ending in a spawn of the `claude` binary. None of this applies to a provider
whose tokens opencode owns. Action: leave it alone, but gate it on the Claude
entry being present, and document in-file that it is provider-specific by
design so nobody "generalizes" it into spawning a `codex` binary.

### 6.2 Auth-error copy is hardcoded to Claude

`claudeAuth.mjs:111` matches error text containing *claude* + *credential* +
*expired|unavailable*; the renderer surfaces opencode's raw "Run `claude` to
refresh them" (`useSseBus.ts:444-476`). A Codex token expiring produces an
error nobody classified, with advice that names the wrong CLI. Needs a
per-provider mapping from provider id → "Reconnect Codex" with a button that
opens the connect flow.

### 6.3 The session-mode dropdown — dynamic already, but gated wrong

Target behaviour: **Chat and Terminal always present; every AI CLI appears only
if it is actually usable on this box.**

Half of that already exists. The dropdown is built from a registry and filtered
at runtime by probing the binary through a login shell, and an entry the user
saved that later disappears is downgraded back to Chat. Chat and Terminal are
hardcoded and unconditional. So the mechanism is right; it has one entry
(`claude`) and one wrong gate.

**The wrong gate.** A registry entry currently declares an *opencode provider*
that must be connected, on top of the binary probe. That conflates two
unrelated authentications. The `claude` CLI holds its own credentials and works
whether or not opencode's Anthropic connection is alive — yet today, if
opencode's Anthropic side were disconnected, Claude Code would vanish from the
dropdown despite working perfectly in a terminal. For Codex it is strictly
worse: opencode's ChatGPT connection is minted *separately* from the Codex
CLI's own login (§3), so a user with a fully working `codex` install and no
opencode connection would never see the option.

**Fix:** replace the opencode-provider gate with a per-launcher readiness
probe — binary on PATH, plus optionally the CLI's own credential file:

| Launcher | Binary | Own credentials | Install |
|---|---|---|---|
| Claude Code | `claude` | `~/.claude/.credentials.json` | already a prerequisite |
| Codex | `codex` | `~/.codex/auth.json` | `npm i -g @openai/codex` |
| Kimi Code | `kimi` | Kimi CLI config | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` |

Keep the gate a two-state one — *present* vs *absent* — not three-state. If the
binary exists but is signed out, still show it; the CLI's own first-run flow
handles login far better than we can guess at it, and hiding a CLI the user
installed on purpose is the more confusing failure.

This also means install-time detection (§4.4) should probe binaries, not only
credentials, and report both.

Small change, and it is the surface most likely to be what someone actually
pictures when they say "add Codex".

### 6.4 Model catalog has no GPT-5.x and no Kimi

`src/shared/modelGuide.mjs` is a hand-written catalog matched by substring on
the model id: haiku/sonnet/opus, gpt-4o/o1/o3/o4-mini, flash/gemini. A
connected Codex subscription yields `gpt-5.2`, `gpt-5.2-codex`,
`gpt-5.1-codex-max`… — **none match**, so `ModelsCard` shows no blurb and no
tier badge for every new model. Same for `kimi-for-coding`. Add families.

### 6.5 Subagent auto-registration will fan out

Every model returned by `opencodeModels()` is auto-registered as a named
subagent (BET-123), with the name derived from `familyKey()` — which returns
null for unknown families, falling back to a slugified model id. Connecting
Codex adds ~20 model rows ⇒ ~20 new `agent` blocks in `opencode.jsonc` with
names like `gpt-5-2-codex`. Functional, ugly, and it makes the Settings model
table long. Worth a decision: extend the family map (§6.4 fixes naming as a
side effect), or don't auto-register beyond the first N per provider.

### 6.6 One default model, several subscriptions

`AppConfig.defaultModel` is a single global. With two or three subscriptions
the real questions appear: what happens when one hits its plan limit, is there
a fallback order, do subagents default to a different subscription than the
main agent. Out of scope for v1, but the registry is where a
`fallbackOrder` would live, so leave room.

### 6.7 Quota / usage is invisible

Subscriptions have caps. The Kimi plugin ships a `/kimi:usage` command;
Anthropic surfaces limits in errors. Today MantaUI shows nothing until a turn
fails. Not v1, but it is the first thing a user with three plans will ask for.

### 6.8 Docs, units, and one live drift

`llms-install.md`, `website/`, `scripts/systemd/opencode-serve.service:20-22`
and `scripts/launchd/com.mantaui.opencode.plist:24-26` all state that chat
needs Anthropic OAuth specifically. Also: **the box is running
`opencode-claude-auth-bui@1.5.4-bui.1` while `install.sh` seeds
`opencode-claude-auth@latest`** — a fork/version drift that a registry-driven
plugin list should either encode or resolve, not preserve by accident.

### 6.9 Analytics

`shareAnalytics` exists. Provider-connect success/failure per provider is the
one event that will actually tell us whether this feature works in the field —
device flows fail silently and users don't report them.

---

## 7. Kimi — what day 1 actually needs

Short answer: **an API-key field and nothing else.** Kimi is the *cheapest*
provider to support, not the hardest. The earlier "needs a plugin" read was
wrong.

### Using the subscription in opencode is officially supported

Moonshot publishes a page titled *Using Kimi in OpenCode*
(`kimi.com/code/docs/en/third-party-tools/opencode.html`). The sanctioned flow
is `opencode auth login` → select **Kimi For Coding** → paste an API key. No
plugin. opencode ships the provider built in.

**"API key" here does NOT mean pay-as-you-go API billing.** Do not confuse the
two Kimi products:

| | Kimi Code (what we want) | Kimi Open Platform |
|---|---|---|
| Base URL | `api.kimi.com/coding/` | `api.moonshot.cn/v1` |
| Billing | **membership subscription**, rate-limited | pay-as-you-go credits |
| Key from | Kimi Code Console | platform console |

The Kimi Code Console key **is** the subscription credential. Moonshot states
it plainly: Kimi Code is "provided together with a Kimi membership subscription
and sharing the same quota. Requests from the CLI, VS Code, and third-party
tools all count toward that quota", and "all logged-in devices and API Keys
share the same quota". So a request opencode makes with that key draws on the
same pool as one typed into Kimi's own CLI. It is the subscription, reached
through a key instead of a browser login.

Members create up to 5 such keys in the Kimi Code Console
(`kimi.com/code/console`); each is shown once at creation. The same key is what
Moonshot tells you to use for Claude Code and Codex too, so a user with a Kimi
plan likely already holds one.

Quota shape worth knowing for §6.7: refreshes every 7 days, does not roll over,
plus a rolling 5-hour rate window that can throttle you even with quota left.
An "Extra Usage" balance can be enabled as an overflow. Their CLI exposes
`/usage`; we surface nothing.

Endpoint and models (from models.dev and confirmed on the box's live opencode):

- Anthropic-protocol endpoint `https://api.kimi.com/coding/`, adapter
  `@ai-sdk/anthropic`, env `KIMI_API_KEY`.
- Four model ids, gated by membership tier: `kimi-for-coding` (K2.7 Code, all
  tiers), `kimi-for-coding-highspeed` (Allegretto+), `k3` (Moderato+, up to 1M
  context on Allegretto+), `k3-256k`. Calling a model above your tier fails
  with an error — worth surfacing verbatim rather than translating.
- `k3` supports thinking-effort variants, which opencode already exposes as
  model variants and `ModelPicker` already renders.

### Day-1 requirement, concretely

1. A text field for the key and a link to the console. That is the entire
   provider-specific surface.
2. `PUT /auth/kimi-for-coding {type:"api", key}` — **verified working on the
   box**: returns `true`, writes opencode's auth store, and `DELETE` cleanly
   reverses it.
3. Restart opencode, then confirm `kimi-for-coding` appears in `connected[]`.
   This is the generic tail from §4.2, not Kimi-specific work.
4. Four model entries in the descriptions catalog (§6.4) so they don't render
   blank.

Everything above is already covered by the generic registry + connect flow.
Kimi's marginal cost over "the machinery exists" is a registry entry, a console
link, and the catalog entries — call it **half a day**, and it lands in the
same PR as the API-key branch of the flow rather than as its own workstream.

The one open question is whether `PUT` with a *valid* key yields a working
provider end-to-end. I could only verify the write path (I have no Kimi
subscription). Given Moonshot documents exactly this flow for opencode, the
risk is low, but it is the one thing to test with a real key before calling
Kimi shipped.

### What *is* actually restricted

Nothing about using the subscription in a third-party tool — Moonshot documents
three of them by name. The one prohibition is on **identity**: *"Please maintain
the tool's real identity identifier when using. Tampering with the client
identifier (User-Agent) is considered a violation and may result in suspension
of membership benefits."*

opencode identifying itself as opencode and presenting a valid key is exactly
the supported path. A tool identifying itself as Kimi's own CLI when it isn't
is the prohibited one.

### Why not the OAuth plugin

`opencode-kimi-full` implements Kimi's device-flow login, registers a separate
provider id (`kimi-for-coding-oauth`), and — by its own README — sends "the same
`User-Agent` / `X-Msh-*` fingerprint headers as `kimi-cli`". Kimi's docs state:
*"Please maintain the tool's real identity identifier when using. Tampering with
the client identifier (User-Agent) is considered a violation and may result in
suspension of membership benefits."*

So the plugin route is worse on three axes at once: it needs runtime plugin
installation plus a service restart, it is unofficial, and it impersonates
another client in a way the vendor explicitly calls a suspendable violation.
**Recommendation: do not ship it, and do not build the runtime-plugin-install
machinery for its sake.** If a user wants Kimi's device login they can run the
official `kimi` CLI, which is a launcher concern (§6.3), not an auth concern.

---

## 8. Work breakdown

| # | Item | Size | Notes |
|---|---|---|---|
| W0 | Spike: Codex device flow end-to-end incl. restart-then-confirm; Kimi `PUT /auth` with a real key | 0.5d | Gates W1/W5 |
| W1 | `subscriptionProviders.mjs` registry + pure resolvers (method matching, prompt gating, status) + tests | 1d | No I/O; the extension point |
| W2 | `opencode.mjs` auth proxy fns + rpc channels + `httpApi` + `Api` type + IPC constants | 1d | The standard 6-site wiring |
| W3 | `ConnectProviderFlow` component: prompts form, device-code card, poll-until-connected, error states | 1.5d | Shared by W4 + W5 |
| W4 | `SubscriptionsCard` in Settings → AI (desktop + mobile free) | 1d | |
| W5 | Onboarding step 2 rewritten registry-driven; delete dead-end hint; refetch models after connect | 1d | Coordinate with onboarding-v2 §4.4 |
| W6 | Install: registry-driven plugin seeding + per-provider detection summary + binary probes | 1d | `install.test.mjs` has the harness |
| W7 | Kimi: registry entry, console link, API-key branch, 4 catalog entries | 0.5d | §7 |
| W8 | Auth-error classification + reconnect CTA per provider | 0.5d | §6.2 |
| W9 | `modelGuide.mjs` families for GPT-5.x + Kimi | 0.5d | §6.4, fixes subagent naming too |
| W10 | Launcher gate fix (drop provider coupling) + `codex` / `kimi` entries | 0.5d | §6.3, separable |
| W11 | Docs / unit comments / `llms-install.md`; resolve the plugin fork drift | 0.5d | §6.8 |
| — | **Core (W0-W6, W8, W9)** | **~7.5d** | Claude + Codex + Copilot + xAI connectable |
| — | **+ Kimi (W7)** | ~8d | |
| — | **Optional (W10, W11)** | ~1d | |

Runtime plugin installation is **not** in the plan. §7 removes the only reason
we had to build it.

---

## 9. Risks

1. **opencode's provider-auth API is undocumented-stability.** It is in `/doc`
   and clearly deliberate, but it is not a contract we control. Feature-detect
   (`GET /provider/auth` 404 or empty ⇒ hide the Connect buttons and fall back
   to the "sign in on the box" hint we render today) rather than assuming.
2. **Positional method indices.** Covered in §4.1; the mitigation is a hard
   rule, and a test that fails if any code path passes a literal index.
3. **Browser-variant OAuth is unusable on a remote box** (localhost:1455 on the
   *box*). Registries must prefer headless/device variants; if a provider only
   offers the browser variant, show the manual CLI hint instead of a URL that
   cannot work.
4. **Device codes expire.** The card needs a countdown/expiry and a retry, or
   users will stare at a dead code.
5. **Every connect ends in an opencode restart**, which kills every in-flight
   session across every chat window. Free during onboarding; in Settings it
   must stay behind the existing confirm. If a user connects a provider while
   three sessions are mid-turn, they lose all three — consider deferring the
   restart with a "connected, restart to use" state rather than forcing it.
6. **Two Anthropic paths now coexist** — the plugin reading
   `~/.claude/.credentials.json`, and opencode's own oauth entry in its auth
   store (both are live on this box right now). Connecting Anthropic in-app
   would write the second. Decide which wins and make the UI say which one is
   in effect, or users will "reconnect Claude" and change nothing observable.

---

## 10. Non-goals (v1)

- Multi-account per provider / account switching.
- Quota and usage display.
- Automatic fallback between subscriptions on rate limit.
- Any credential value crossing into the renderer or an AI transcript. Keys are
  written box-side via `PUT /auth/{id}` and never read back, matching the
  existing `hasApiKey`-only contract.
