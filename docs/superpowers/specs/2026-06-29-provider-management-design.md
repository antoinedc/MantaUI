# Provider Management in manta

**Date:** 2026-06-29
**Branch:** `feat/provider-management`
**Status:** Approved design, ready for implementation plan

## Problem

manta's model picker is dynamic — it reads opencode's `GET /provider` endpoint,
filters to connected providers, and flattens each provider's `models` map
(`src/main/opencode.ts:listModels`). But opencode only advertises models that
are **hand-listed** in the provider's `models` block in `opencode.jsonc` on the
box. It does not auto-discover from a provider's real `/v1/models`.

Concrete case: the `voska` provider (`https://api.voska.org/v1`) actually serves
three models — `qwen3.6-27b`, `default`, `ornith` — but only `qwen3.6-27b` is
registered in `opencode.jsonc`, so the picker shows only that one. Surfacing the
others today requires SSHing to alphaclaw, hand-editing `opencode.jsonc`, and
restarting opencode.

## Goal

A **Providers** section in manta Settings where the user can:

- **Add an endpoint** — name, baseURL, API key (any OpenAI-compatible provider).
- **Refresh discovery** — query the endpoint's `/v1/models` and list everything
  it returns.
- **Toggle enabled models** — checked models are written into that provider's
  `models` map in `opencode.jsonc`.
- **Remove an endpoint** — drop the provider block.

The model picker is unchanged: it keeps reading opencode `/provider`. opencode.jsonc
on the box remains the single source of truth, so any enabled model is actually
servable for prompts end-to-end.

## Non-goals

- manta does NOT route prompts directly to providers. opencode does all prompting;
  manta only edits opencode's config and triggers a reload.
- No second persistent store in manta. The endpoint list lives only in
  `opencode.jsonc`; manta reads it back to populate the UI.
- Comment preservation in `opencode.jsonc` is out of scope (see Risks).

## Architecture

Three pieces, each with one clear responsibility.

### 1. Discovery — `src/main/providers.ts` (new)

`discoverModels(config, baseURL, apiKey): Promise<DiscoverResult>`

- Runs **on the box** (not the Mac), via the existing SSH-once path, because the
  box is where opencode reaches these endpoints (honors the "remote box is
  backend-only" invariant — discovery must reflect the box's network view).
- Command shape:
  `curl -s -H "Authorization: Bearer <key>" <baseURL>/models`
  (baseURL already ends in `/v1`; append `/models`).
- Parses `data[].id` into `{ id: string }[]`.
- Returns a discriminated result:
  - `{ ok: true, models: { id: string }[] }`
  - `{ ok: false, error: "unreachable" | "unauthorized" | "bad_response", detail?: string }`
- API key passed via the SSH command is shell-escaped; never logged.

### 2. Read-merge-write config — `src/main/index.ts` (extend)

New IPC handler `opencode:setProviders` mirrors the proven skill-registry-URLs
block (`index.ts:958-1004`):

1. `cat ~/.config/opencode/opencode.jsonc 2>/dev/null || echo '{}'`
2. Strip `//` comments, `JSON.parse`. On parse failure: abort with an error to
   the renderer (do NOT clobber an unparseable file).
3. Mutate ONLY the top-level `provider` object — set/remove the named provider
   blocks. Each block uses the fixed `@ai-sdk/openai-compatible` shape:
   ```jsonc
   "<id>": {
     "npm": "@ai-sdk/openai-compatible",
     "name": "<display name>",
     "options": { "baseURL": "<url>", "apiKey": "<key>" },
     "models": { "<modelId>": { "id": "<modelId>", "name": "<modelId>" } }
   }
   ```
4. `JSON.stringify(merged, null, 2)` → `buildRemoteConfigWriteCmd(content, path)`
   → `runSshOnce`. Reuses the tested heredoc writer (`remoteConfigWrite.ts`) —
   no hand-rolled interpolation, no double-encoding.

A separate IPC `opencode:getProviders` reads opencode.jsonc and returns the
current provider blocks (id, name, baseURL, enabled model ids; apiKey presence
only, never the value) so the UI can populate without a second store.

A separate IPC `opencode:discoverModels` wraps piece 1 for the renderer.

### Restart handling — **prompt before restart**

Writing config does NOT restart opencode. After a successful write, the renderer
shows: *"Restart opencode now to apply? (interrupts active sessions)"* with
**Apply Now** / **Apply Later**. Apply Now calls a new IPC `opencode:restart`
that tears down the `manta-opencode` tmux session and lets the existing ensure
path respawn it (`opencode.ts`), then the picker re-fetches. Apply Later leaves
the new config on disk to take effect on the next natural restart.

### 3. UI — `src/renderer/Settings.tsx` + `src/renderer/mobile/MobileSettings.tsx`

`ProvidersCard` (shared logic, two thin render surfaces):

- List of endpoints. Each row: name + baseURL, expand to show models.
- Expanded: discovered models as checkboxes (enabled = in opencode `models` map),
  a **Refresh** button per endpoint (calls discoverModels), **Remove** endpoint.
- **Add endpoint** form: id, name, baseURL, API key.
- API keys are write-only: shown masked once present; editing replaces.
- Save triggers `opencode:setProviders`, then the restart prompt.

## Data flow

```
opencode.jsonc (box)  ──cat──▶  opencode:getProviders  ──▶  ProvidersCard
       ▲                                                         │
       │ buildRemoteConfigWriteCmd                               │ Refresh
       └────── opencode:setProviders ◀── Save ───────────────────┤
                                                                 ▼
endpoint /v1/models  ◀──curl(box)──  opencode:discoverModels ◀── ProvidersCard
                                                                 │
   (after restart) opencode /provider ──▶ listModels ──▶ model picker (unchanged)
```

## Types (`src/shared/types.ts`)

```ts
export type ProviderEndpoint = {
  id: string;            // opencode provider id, e.g. "voska"
  name: string;          // display, e.g. "VoskaAI"
  baseURL: string;       // e.g. "https://api.voska.org/v1"
  hasApiKey: boolean;    // never send the key to the renderer
  enabledModels: string[]; // model ids present in opencode `models` map
};

export type DiscoverResult =
  | { ok: true; models: { id: string }[] }
  | { ok: false; error: "unreachable" | "unauthorized" | "bad_response"; detail?: string };
```

## Error handling

- Discovery failures surface inline per-endpoint (not a global error); the
  existing enabled list stays intact.
- Config read parse failure → abort the write, tell the user opencode.jsonc is
  unparseable (don't overwrite). This matches the defensive stance already taken
  for skill URLs.
- Write failure → surface to renderer; nothing on the box changed (the write is
  the last step).
- Restart failure → the ensure path already self-heals stale tmux sessions on
  next use; surface a warning but don't block.

## Testing

- Unit: `providers.ts` discovery parser — valid `/v1/models` JSON, empty `data`,
  unauthorized, non-JSON body. Pure function over a response string.
- Unit: the provider-block merge — given an existing parsed config, setting and
  removing providers preserves `plugin`, `model`, `skills`, and other keys
  byte-for-byte (mirror `remoteConfigWrite.test.ts`'s preservation assertions).
- Reuse existing `remoteConfigWrite.test.ts` coverage for the write byte-safety.

## Risks & mitigations

- **opencode.jsonc corruption** (documented history, 2026-05-18 incident):
  mitigated by reusing the tested `buildRemoteConfigWriteCmd` heredoc writer and
  the parse-merge-preserve pattern. No string interpolation of JSON.
- **Comment loss:** `JSON.parse` after comment-strip drops hand-written comments
  on write-back. Consistent with the existing skill-URLs behavior; accepted for
  v1. Called out so it's a known trade-off, not a surprise.
- **Restart blast radius:** gated behind explicit prompt-before-restart; never
  automatic.
- **Don't drop the auth plugin:** the merge only touches the `provider` key, so
  the `plugin` array (opencode-claude-auth-bui) is preserved untouched.
