# Secrets — inline editing + Settings → Secrets

Status: agreed (mockup approved 2026-10-23). Visual reference: `docs/secrets/mockup.html`.

## Goal

1. Every secret in the chat's 🔑 popover (`SecretsCard`) can be edited in place: **name, value, hint**.
2. A new **Settings → Secrets** section lists every secret on the box, grouped
   Shared / Projects / Sessions, with the same inline editor, add, and delete.

Desktop renderer only. The native iOS client is out of scope (it must keep working
unchanged against the server — extra JSON fields are fine).

## Invariant (unchanged, load-bearing)

A stored value is **never** returned to any client. "Editing the value" means
**replacing** it. No new code path may read `entry.value` except the existing
materialize path. `toMeta` stays the only serializer.

## Server contract

### `updateSecret(id, patch)` — `src/server/secrets.mjs`

```
updateSecret(
  id: string,
  patch: { key?: string; value?: string; hint?: string },
  { load, save, publish, now } = {}   // injectable, same shape as setSecret
) → { ok: true, meta: SecretMeta } | { ok: false, error: string }
```

- Unknown id → `{ok:false, error:"Secret not found."}`.
- `key` present and different → must pass `isValidKey`; must not collide with
  another entry in the **same slot** (same scope + same owner) →
  `{ok:false, error:'A <scope> secret named "<KEY>" already exists here.'}`
  (`<scope>` = shared / project / session). Same key → no-op for the name.
- `value`: `undefined`/`null`/absent = keep the stored value. A string must be
  non-empty (`""` → `{ok:false, error:"value cannot be empty"}`).
- `hint`: string replaces (trimmed); absent = keep.
- Scope and owner (sessionID / project) are **immutable** here.
- Bumps `updatedAt` only when something actually changed; `createdAt` and `id`
  preserved.
- When the key **or** value changes, best-effort `rm` the entry's previously
  materialized file (old path) so a stale value/name does not linger on disk.
- Publishes `{kind:"secrets.updated", payload:{sessionID, project}}` on success.
- Returned meta never contains the value.

### `overrides` on visible listings

`visibleSecrets` adds `overrides: "project" | "shared" | null` to each returned
meta: for a session-scoped entry, the highest-precedence tier it shadows
(project if a same-key project entry exists for that project, else shared if a
same-key shared exists); for a project entry, `"shared"` if a same-key shared
exists; shared → `null`. The `includeAll` listing sets `overrides: null`
(the Settings page computes its own cross-reference from the full list).
`toMeta` itself is unchanged; the field is added in `visibleSecrets` only.

### Transport

- New RPC channel `secrets:update` → `(id, patch)` → `updateSecret` with the bus
  publisher (`src/server/rpc.mjs`, next to `secrets:set`).
- `IPC.secretsUpdate = "secrets:update"` in `src/shared/types.ts`.
- `Api.secretsUpdate(id: string, patch: SecretPatch): Promise<{ ok: boolean; meta?: SecretMeta; error?: string }>`
  in `src/shared/api.ts`; implemented in `src/renderer/api/httpApi.ts` (and any
  other `Api` implementer the typechecker requires: preload, demo/harness).
- `SecretPatch = { key?: string; value?: string; hint?: string }` and
  `SecretMeta.overrides?: "project" | "shared" | null` in `src/shared/types.ts`.
- No REST route change (the agent tools never edit).

## Renderer

### Shared inline editor — `SecretEditor`

One component used by both surfaces:

- Name input (mono), validated with the same regex as the server; inline error.
- Scope shown as a read-only badge.
- Value row: locked by default — dots + "stored · set <relative time>" +
  **Replace value…** button. Pressing it swaps in an empty password input with
  a **Keep current** button that restores the locked state. Save sends `value`
  only if the replace input is open and non-empty.
- Hint input.
- If the name changed: warning box "Renaming OLD → NEW. Agents or notes that ask
  for the old name won't find it." and the primary button reads **Rename & save**.
- Enter saves, Esc cancels. Save disabled while invalid / saving / nothing
  changed. Server errors shown inline (e.g. duplicate name). On success the
  editor closes; the value is cleared from component state.
- Every press reports its outcome (AGENTS.md "never stub a control"): failures
  show the error, success closes the editor and the list refreshes.

### Chat popover (`SecretsCard`, `src/renderer/PanelCards.tsx`)

- Header gets a **Manage all in Settings ↗** link that opens Settings on the
  Secrets section.
- Add form collapses behind **+ Add secret** (expands to the existing form; the
  BET-1437 `prefillKey` deep-link must still open the form pre-filled with the
  value focused and the matching row highlighted).
- Each row: ✎ edit and 🗑 delete (visible on hover / focus-within; keyboard
  reachable). Double-click a row opens the editor. One row editing at a time.
- Rows whose meta has `overrides` show a warn badge "overrides shared" /
  "overrides project".

### Settings → Secrets (`SETTING_SECTIONS` id `"secrets"`, label "Secrets",
group AGENT, placed after Extensions; icon `KeyRound` or `Key`)

- Desktop-only section; data via `secretsList(undefined, true)`.
- Toolbar: search (matches key or hint, case-insensitive), segmented filter
  All / Shared / Projects / Sessions with counts, **+ Add secret**.
- Groups:
  - **Shared** — one table.
  - **Projects** — sub-header per project name with "N secrets".
  - **Sessions** — sub-header per sessionID, labelled `workspace / window name`
    resolved from the store's tmux projects (window `opencodeSessionId`), with
    **Open chat ↗** that navigates to that window. If no window has that
    session id: label is the truncated session id + "chat closed" badge and a
    **Delete all** button (confirm first) instead of Open chat.
- Row: key (mono), hint (italic "no hint" when empty), relative updated time,
  ✎ / 🗑 on hover. Session rows that shadow a same-key shared/project secret
  (computed from the full list: same project for project-tier; shared otherwise)
  show the "overrides …" badge; shared/project rows overridden somewhere show
  "Overridden in N session(s)" inside the editor.
- Delete asks for confirmation.
- Add dialog: scope segmented control (Every session / A project / One chat);
  project → select of known workspaces; one chat → select of chat windows;
  name, value (password), hint. Uses existing `secretsSet` (project scope passes
  `project` explicitly; session scope passes the chosen `sessionID`).
- Refetch on open, after every mutation, and on the `secrets.updated` bus event
  if the renderer already receives it; otherwise a 10s poll while the section is
  visible (same as SecretsCard).
- Settings search must find the section (schema `custom` entry so
  `searchSettings` lists it).

## Tests

- `src/server/secrets.test.mjs`: updateSecret — rename, rename collision in same
  slot (and NO collision across different slots), value replace, value keep,
  empty value rejected, hint-only change, unknown id, invalid key, scope/owner
  immutable, materialized file removed on rename/value change, meta has no value,
  updatedAt unchanged on no-op. visibleSecrets `overrides` cases.
- `src/server/rpc.test.mjs` (or equivalent): `secrets:update` dispatches.
- Renderer: pure helpers (grouping, search filter, session label resolution,
  override cross-reference, editor dirty/valid logic) extracted and unit-tested
  with vitest.

## Out of scope

Changing a secret's scope; iOS UI; agent-facing editing tools.
