# Better UI — Workspace Context

## Project Overview

MANTA is an Electron desktop client for working with Claude on a remote Linux box over SSH+tmux. Sidebar of projects (tmux sessions) with multiple windows each; xterm.js terminal in one tab type, a native React chat panel powered by opencode in the other.

**The business model**: open-source everything except the mobile app subscription. Users bring their own compute (VPS, laptop, whatever). We sell a polished App Store/Play Store app that auto-connects to their box with zero setup.

## Current Architecture

- **Desktop app**: Electron + xterm.js + React (ChatPanel.tsx ~4150 LoC)
- **Box server**: Node HTTP+WS (`src/server/`) — tmux/pty/opencode proxy, serves `https://<box_id>.boxes.mantaui.com` directly (Caddy reverse-proxy → `127.0.0.1:8787`)
- **Mobile**: Capacitor hybrid app (`mobile/`) with iOS/Android native shells
- **Mobile/web client**: built into `mobile/www/` via Vite, served by `src/server/index.mjs`
- **Push gateway** (`gateway.mantaui.com`): the only operated hosted service. The box registers with the gateway on install (`POST /register` → gets a `gateway_token` + its `<box_id>.boxes.mantaui.com` DNS record); the gateway fans out APNs via `POST /push`. Web Push (VAPID) stays box-local.
- **Auth**: Single-box token (`box_token`) on `src/server/` (`Authorization: Bearer <box_token>`); 6-digit pairing-code handshake in `src/server/auth.mjs` for first-time device claim. The `/auth/claim` endpoint accepts both `pairing_code` and the shorter `code` spelling emitted by the mobile QR / deep-link payload.

## Key Constraints

1. **Single-user box** — everything assumes one user, one box (`~/.bui-mobile/`, one opencode on :4096). No multi-tenant complexity on the box itself.
2. **Mobile is PWA today** — real App Store distribution requires native push (APNs), no cleartext, proper onboarding flow.
3. **Direct connection** — phones reach the box directly at `https://<box_id>.boxes.mantaui.com`. The relay-era hop is gone.
4. **Upstream dependency** — rides opencode + Claude Max auth. If opencode changes the event wire format, product breaks.
5. **No auto-update** — README says "pull from git for new versions." Desktop needs packaging (.dmg/.AppImage) + auto-update for commercial viability.

## The Paid Mobile App — Target Experience

**Entry points** (both converge to the same flow):
1. **Deeplink** (from desktop "Get on mobile" → deferred deeplink via Branch/Firebase)
2. **QR scan** (from desktop Settings → "Pair phone" → shows QR)

**Flow**:
```
1. User installs app (App Store / Play)
2. App resolves pairing payload (QR or deferred deeplink) — the payload
   carries only the box form: `manta://pair?box=<box_id>&code=<6-digit>`
3. App auto-connects to https://<box_id>.boxes.mantaui.com and POSTs
   {pairing_code} to /auth/claim; on success saves {boxToken, boxId, serverUrl}
4. App shows their projects/sessions list (free preview)
5. User taps a session → blurred preview with stats
6. "Start subscription" (Apple IAP / Play Billing) — one tap
7. Running on mobile with live streaming + push
```

**What's free vs. paid**:
- **Free (metadata only)**: project list, session titles, running/idle status, token counts, message/tool counts, blurred placeholder thumbnail
- **Paid (full capability)**: live transcript streaming, sending prompts, push notifications, terminal access

**Server-side enforcement**: the gateway gates endpoints — pre-sub metadata endpoints serve free data; transcript/stream endpoints 402 until IAP receipt is bound to box_id. Blur is a placeholder, not CSS-over-real-content.

## Push Gateway (`gateway.mantaui.com`) — the operated backend

The gateway is the only operated service. The relay it replaced is gone (BET-198).

- **TLS + DNS** — the box registers with `gateway.mantaui.com` on install; the gateway provisions `<box_id>.boxes.mantaui.com` to point at the box's public IP. The box serves `https://<box_id>.boxes.mantaui.com` directly via Caddy.
- **Operated native push** — APNs/FCM are fan-out'd by the gateway using the gateway_token (`POST /push`). Web Push (VAPID) stays box-local (no external hop).
- **IAP receipt validation** — Apple IAP Server Notifications → box_id binding. The relay it used to live on is gone.

Reuse, don't duplicate: HMAC/token/rate-limit from `src/server/webhooks.mjs` + `src/server/auth.mjs`; box identity from `src/shared/claim.mjs` + `auth.mjs` (`ensureAuth`, box_token from `~/.bui-mobile/auth.json`); push routing from `src/server/push.mjs` (`routeNotification`); reconnect/backoff from `src/shared/net/`.

## Token Identity Model (Anonymous by Construction)

- **box_id**: 32 hex chars (128-bit random), opaque pseudonym, maps to nothing human. Stable for the box's life.
- **box_token**: 32 hex chars (128-bit random) bearer secret. `Authorization: Bearer <box_token>` on every gated request. Generated on first run, persisted 0600 in `~/.bui-mobile/auth.json`, never logged in full.
- **pairing_code**: 6 digits, one-time, ~5 min TTL, in-memory only. A device proves physical/visual proximity by echoing it back and receives the box_token. Consumed on first successful claim.

All traffic authenticated with `box_token` (reuses `webhooks.mjs` pattern: `isValidToken`, constant-time compare, token-bucket rate limiter).

## Onboarding Flow (M6 — Desktop Upsell)

**Vision**: Zero-manual-config onboarding. User runs one curl command on their VPS, gets a pairing code, enters it in the desktop app. Everything else is automatic.

### Step 1: Self-Install on VPS

**User action:**
```bash
curl -fsSL https://mantaui.com/install.sh | bash
```

**What the script does:**
1. Verifies prereqs (curl, tar, sha256sum, tmux, git)
2. Downloads the versioned tarball from the manifest (`manta-latest.txt`), sha256-verifies, extracts to `~/manta/`
3. Installs opencode (official installer)
4. Seeds `~/.config/opencode/opencode.jsonc` with the manta opencode-claude-auth plugin
5. Mints box identity via `ensureAuth` (box_id + box_token → `~/.manta/auth.json`, 0600)
6. Creates systemd --user service (`manta-server.service`)
7. **Privileged section (BET-205, sudo NOPASSWD):** installs Caddy via apt, POSTs `gateway.mantaui.com/register {box_id}` for DNS provisioning, writes the per-box Caddy vhost, reloads Caddy
8. **Outputs to stdout:**
   ```
   Your box serves its own public hostname — https://<box_id>.boxes.mantaui.com
   (Caddy on this box terminates TLS and reverse-proxies 127.0.0.1:8787). The
   desktop / mobile app discovers it directly via the box_id below; no relay,
   no tunnel, no dial-out.

   Pair link:     manta://pair?box=<box_id>&code=<6-digit>
                  (paste into the desktop app, or scan as a QR)
   ```

**Script location:** `scripts/install.sh` (in repo), served at `https://mantaui.com/install.sh`.

### Step 2: Desktop Onboarding — Pair (Full-Screen)

**Trigger:** Fresh install (no `config.json` or empty `host` + no `boxId`).

**UI:** Full-screen modal (no sidebar, no header, no footer).

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│              Connect to your server                     │
│                                                         │
│              Enter Box ID:                              │
│              [_____________________________________]    │
│                                                         │
│              Enter pairing code:                        │
│              [________]                                 │
│                                                         │
│              [Connect]                                  │
│                                                         │
│       Or paste the manta://pair?box=…&code=… link       │
│              [_____________________________________]    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Behavior:**
- Box ID input validates as 32 hex chars; pairing code auto-focuses and validates as 6 digits (`^\d{6}$`). The pair-link paste field accepts the `manta://pair?box=…&code=…` form and routes to the same claim call.
- "Connect" button disabled until both fields are valid (or pair-link is parseable).
- On connect: POST `{pairing_code}` to `<boxDirectUrl(boxId)>/auth/claim`. The server claims and returns `{box_token, box_id}`; main persists `{boxToken, boxId, serverUrl = https://<box_id>.boxes.mantaui.com}` to `config.json`, then closes the modal and proceeds to Step 3.

**Config schema (direct mode):**
```json
{
  "boxId": "<box_id>",
  "boxToken": "<box_token>",
  "serverUrl": "https://<box_id>.boxes.mantaui.com",
  "projects": []
}
```

**Mode detection:**
- If `boxId` + `boxToken` are set → direct mode (no SSH fields needed).
- If `host` is set → SSH mode (legacy, for self-hosted users who don't want the Caddy + DNS path).
- If neither → onboarding flow.

### Step 3: Pick AI Providers (Full-Screen)

**Trigger:** After successful pairing.

**UI:** Full-screen modal.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│              Choose your AI providers                   │
│                                                         │
│   Select one or more. You'll pick a default model next. │
│                                                         │
│   ┌──────────────────────────────────────────────────┐  │
│   │ ☑ Anthropic                  3 models            │  │
│   │   claude-sonnet-4-6, claude-opus-4-7, ...        │  │
│   │   [✓ Connected via opencode auth plugin]         │  │
│   └──────────────────────────────────────────────────┘  │
│                                                         │
│   ┌──────────────────────────────────────────────────┐  │
│   │ ☐ DeepSeek                 2 models              │  │
│   │   deepseek-chat, deepseek-coder                  │  │
│   │   [✓ Connected]                                  │  │
│   └──────────────────────────────────────────────────┘  │
│                                                         │
│   ┌──────────────────────────────────────────────────┐  │
│   │ ☐ Groq                   12 models               │  │
│   │   llama-3.3-70b-versatile, deepseek-r1, ...      │  │
│   │   [✓ Connected]                                  │  │
│   └──────────────────────────────────────────────────┘  │
│                                                         │
│   ┌──────────────────────────────────────────────────┐  │
│   │ ☐ OpenAI                 8 models                │  │
│   │   gpt-4o, gpt-4o-mini, ...                       │  │
│   │   [✗ Not connected — add API key]                │  │
│   └──────────────────────────────────────────────────┘  │
│                                                         │
│   ┌──────────────────────────────────────────────────┐  │
│   │ + Add custom provider                            │  │
│   │ ID: [____] Name: [____] baseURL: [____] key: [__]│  │
│   └──────────────────────────────────────────────────┘  │
│                                                         │
│              [Continue] (disabled until 1+ selected)    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Behavior:**

**Fetch providers:**
- GET `/provider` from opencode (over the direct connection)
- Response shape:
  ```json
  {
    "all": [{ id: "anthropic", models: {...} }, { id: "deepseek", models: {...} }, ...],
    "connected": ["anthropic", "deepseek", "groq"],
    "default": { "anthropic": "claude-sonnet-4-6", "deepseek": "deepseek-chat" }
  }
  ```
- Filter `all` by `connected` → show only connected providers
- For each, show model count + status

**User selects providers:**
- Checkboxes next to each provider
- "Add custom provider" expands form (id, name, baseURL, apiKey)
- User can add OpenAI/custom providers with their own API keys
- "Continue" disabled until at least 1 provider is selected

**Next step (model picker):**
- After selecting providers, show model picker for the first selected provider
- User picks default model
- Save `defaultModel: { providerID, modelID }` to `config.json`

**Save providers:**
- Write selected providers to `opencode.jsonc` via `setProviders({ upsert: [...] })`
- Restart opencode if needed (existing `applyRestart` flow)

### Step 4: Create First Project

**Sidebar shows:**
```
┌─────────────────────────────────────────────────────────┐
│  better-ui                                              │
│                                                         │
│  + Create first project                                 │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**User clicks "+ Create first project":**
- Existing `Sidebar.tsx` flow: enter `defaultCwd`, autocomplete, worktree detection
- Creates tmux session + opens first window
- App is now usable

### Key Design Decisions

1. **Provider list comes from opencode's `/provider`** — not hardcoded. opencode ships with ~128 providers (Anthropic, OpenAI, DeepSeek, Groq, etc.), and `connected[]` shows which ones have credentials on the box.

2. **User selects from connected providers** — can't enable a provider that's not connected (no credentials). "Add custom provider" lets them add new ones.

3. **Default model is required** — can't proceed without selecting at least one provider + one model.

4. **Full-screen onboarding** — no sidebar, no header, no footer. Just the onboarding flow.

5. **SSH fields hidden during onboarding** — direct mode doesn't need them. Can be added later in Settings for self-hosted users.

6. **Separate UI from Settings** — onboarding has simplified provider picker (just select + default model). Settings has full provider management (add/edit/remove/discover models).

### Open Questions (Resolved)

1. ✅ **Where do models come from?** — opencode's `/provider` endpoint, filtered by `connected[]`.

2. ✅ **Default model required?** — Yes, can't proceed without it.

3. ✅ **Can user skip providers?** — No, "Continue" disabled until 1+ selected.

4. ✅ **Separate UI from Settings?** — Yes, simplified version for onboarding.

5. ✅ **SSH fields hidden?** — Yes, direct mode doesn't need them.

### Mockups

**Onboarding mockup (interactive):** _(retired — was onboarding.bui.antoinedc.com; the `*.bui.antoinedc.com` vhost is being decommissioned in BET-160 §7)_
- 4 clickable steps: Pair → Providers → Model → Project
- Full-screen layout for each step

**Settings mockup (interactive):** _(retired — was settings-redesign.bui.antoinedc.com; same decommission)_
- 5 tabs: Connection, AI, Voice, Files, General
- Providers show model lists with checkboxes

**Screenshots:** `/tmp/screenshots/` (saved to BET-40 metadata)

---

## Settings Redesign (M6 — Desktop Upsell)

**Status:** Spec complete. Mockups generated.

### Current Problems

1. **Everything in one long list** — 694 lines of settings, hard to find anything
2. **480px width** — cramped, especially with wide fields (baseURL, API keys)
3. **No logical grouping** — connection, transport, uploads, agent push, auto-rename, model, cache, voice, tmux, skills, providers, bootstrap all mixed together
4. **Bootstrap section tacked on at bottom** — feels afterthought
5. **No tabs** — user scrolls through everything every time

### Proposed Layout

**Full-screen panel** (not a modal), wider layout (~900px or full-screen).

**Left sidebar navigation** with tabs:
```
┌─────────────────────────────────────────────────────────┐
│  Settings                                    [✕ Close]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Connection      ◄── active tab (highlighted)          │
│  AI               │                                     │
│  Voice            │                                     │
│  Files            │                                     │
│  General          │                                     │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │                                                 │   │
│  │  (tab content — wide, spacious)                │   │
│  │                                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Tab Structure

#### 1. Connection (default tab)

**Purpose:** Direct/SSH config + remote setup.

**Fields:**
- **Mode** (direct vs SSH) — shown only if both are possible
  - Direct: `boxId`, `boxToken`, `serverUrl` (read-only, from pairing)
  - SSH: `host`, `user`, `identityFile`, `transport`
- **Test connection** (probe) — runs diagnostic, shows status pills
- **Bootstrap remote** — installs opencode, merges auth plugin
- **Remote tmux config** — set up / restore

#### 2. AI

**Purpose:** Model selection, providers, cache settings.

**Fields:**
- **Default model** — dropdown (provider/model)
- **Providers** — embedded ProvidersCard with model checkboxes
- **Cache TTL** — 5m / 1h toggle
- **Skill registries** — list + add URL

#### 3. Voice

**Purpose:** Groq STT settings.

**Fields:**
- **Groq API key** — password input
- **Transcription model** — text input
- **Command classifier model** — text input

#### 4. Files

**Purpose:** Upload/agent push settings.

**Fields:**
- **Upload cleanup** — number input (hours)
- **Agent file delivery** — checkbox + downloads dir

#### 5. General

**Purpose:** Miscellaneous settings.

**Fields:**
- **Auto-rename sessions** — checkbox
- **About** — version, link to docs

### Key Design Decisions

1. **Full-screen panel** — not a modal, takes up the whole app window
2. **Left sidebar navigation** — tabs on the left, content on the right
3. **Wide layout** — ~900px or full-screen, fields get proper breathing room
4. **Logical grouping** — each tab has a clear theme (Connection, AI, Voice, Files, General)
5. **Save/Cancel at bottom right** — consistent across all tabs
6. **ProvidersCard embedded in AI tab** — reused from existing component, but with wider layout
7. **Bootstrap/probe in Connection tab** — not tacked on at bottom, but part of the flow

### Screenshots

Saved to `/tmp/screenshots/settings/`:
- `tabcon.png` — Connection tab
- `tabai.png` — AI tab (with providers + model checkboxes)
- `tabvoi.png` — Voice tab
- `tabfil.png` — Files tab
- `tabgen.png` — General tab

## Existing Multica Setup

- **Workspace**: https://multica.ai/better-ui (ID: `264c89bb-4659-4570-af7b-5f8daaf87985`)
- **Agent**: `better-ui-dev` (ID: `87bf6d8f-5fd0-4fb6-8dd8-a5e7c36b0747`) — OpenCode runtime
- **Skill**: `verify-build-better-ui` (ID: `95d4a528-3756-4ee0-a4e2-bf072e54399a`) — runs `npm run typecheck && npm test`

## Hard Rules

1. **Source of truth flows repo → Cloud.** Edit `.multica/` files first, commit, then push.
2. **Never commit PATs or daemon tokens.** `~/.multica/config.json` lives outside the repo.
3. **Skill descriptions in frontmatter must stay accurate.** The dispatcher uses them at task-dispatch time.
4. **No production deploy from agents.** No `ssh root@…`, no `./scripts/deploy.sh`, no `docker` on prod.
5. **Mobile changes need rebuild + commit** — `npm run build:mobile` then `git add mobile/www && git commit && git push`. Source edits alone do NOTHING on phone.
6. **Auth on `src/server/` is job zero** — cannot ship commercial product without it.
