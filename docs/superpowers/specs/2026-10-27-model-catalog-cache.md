# Model catalog cache — stop sessions silently resetting to "Server default"

## Problem

Several conversations at once lose their chosen model and fall back to
"Server default" (`anthropic/claude-opus-4-8` on the dev box).

Chain:

1. `fetchProviders()` (`src/server/opencode.mjs`) reads `/api/provider`,
   `/api/integration`, `/api/model`, `/api/model/default` with `getJsonSoft`,
   which turns ANY failure into `null`. A failed read degrades silently:
   `/api/provider` failing → `{connected: []}`; `/api/model` failing → every
   provider with `{}` models.
2. `listModels()` therefore returns `[]` (or a partial list) as a normal,
   fulfilled value.
3. The renderer's catalog (`src/renderer/modelCatalog.ts`) keeps its last value
   only on a REJECTED request, so it adopts the empty list.
4. `useComposerController` clears the box-stored per-session model whenever
   that model is not in the list → every mounted conversation wipes its choice.

Since the V2 cutover every config edit triggers `POST /api/location/reload`,
during which opencode's `/api/*` reads fail briefly (measured: 2 of 40 polls
failed across one reload). opencode restarts do the same. The renderer
re-fetches the list every 10 s per panel mount, so it hits those windows.

## Design

The model list rarely changes. Cache it on the box, re-check it rarely,
invalidate it on the events that really change it, and never let a failed read
replace a good one.

### Box (`src/server/opencode.mjs`)

- **K1 — last-good snapshot.** `getProviders()` keeps the last SUCCESSFUL
  snapshot in module memory. A fetch is successful only when `/api/provider`
  AND `/api/model` AND `/api/integration` all returned 2xx with a `data` array.
  (`/api/model/default` failing alone is not a failure: keep the previous
  `default` if one exists.) Any other outcome is a failure.
- **K2 — TTL.** A snapshot younger than `PROVIDERS_CACHE_TTL_MS = 10 * 60_000`
  is served without contacting opencode. Older (or invalidated) → fetch;
  concurrent callers keep sharing one in-flight fetch (existing single-flight).
- **K3 — failure never replaces a good snapshot.** If a fetch fails and a
  last-good snapshot exists, return it (it stays stale, so the next call
  retries). Do NOT stamp it fresh on failure. Log one `console.warn` line per
  failed refresh (`[providers] refresh failed, serving last-good snapshot`).
- **K4 — cold failure.** No last-good snapshot + failed fetch → keep today's
  contract for `getProviders()` (never throws, returns `{connected: []}`) but
  mark the result `unavailable: true`. `listModels()` keeps returning `[]` for
  internal callers (CTO, routing, appControl, delegate are unchanged).
- **K5 — RPC `opencode:models` rejects when unavailable.** The
  `opencode:models` channel (`src/server/rpc.mjs`) must reject with
  `Error("model list unavailable")` when the snapshot behind it is
  `unavailable`, so the renderer keeps its own cached list instead of adopting
  `[]`. Implement via an exported helper (e.g. `listModels(overrides, {strict:
  true})` throwing) — one code path, no second fetch.
- **K6 — invalidation.** `invalidateProvidersCache()` (exported) marks the
  snapshot stale WITHOUT discarding it (so K3 still has a fallback during the
  reload window right after a change). Called:
  - after a successful `reloadOpencodeConfig()` (`opencodeAdmin.mjs`) — this is
    the single path every opencode config edit takes (models, subagents,
    cache TTL, provider whitelist, …);
  - after `restartOpencode()` (`opencodeAdmin.mjs`);
  - after every successful provider credential/auth mutation in
    `opencode.mjs` (`completeProviderOauth`, `setProviderAuthEntry`,
    `removeProviderAuth`, and any other connect/disconnect/credential write);
  - when the opencode event stream RECONNECTS (`onConnect({reconnect:true})`
    in `index.mjs`) — opencode may have restarted outside Manta.
  Avoid an import cycle: if `opencodeAdmin.mjs` can't import from
  `opencode.mjs`, inject the invalidator.
- `getProviders()` doc comment updated: it is now cached (TTL + invalidation),
  never throws, `unavailable:true` only when nothing good was ever read.
- Test seam: `_resetProvidersCacheForTests()` (or injectable clock/fetch) so
  tests are deterministic.

### Renderer

- **K7 — `modelCatalog.ts` STALE_MS** 10 s → 5 min. Settings already calls
  `refreshModelCatalog()` after a model edit; also call it after a successful
  provider connect/disconnect and after toggling a model on/off in Settings
  (find those sites; do not add new UI).
- **K8 — guard in `useComposerController`.** The effect that clears a saved
  session model "not in the current list" must do nothing when the list is
  EMPTY. (A genuinely removed model in a non-empty list still clears, as today.)

## Non-goals

- No repair of choices already wiped.
- No change to the routing logic, `listRoutableModels`, or the CTO.
- No new RPC channel or bus event.

## Tests

- Server (`src/server/opencode.test.mjs` or a new focused test file): fresh
  serve within TTL makes no fetch; expiry refetches; failed refetch returns
  last-good and does not reset the TTL; partial failure (`/api/model` 500)
  counts as failure; cold failure → `unavailable:true`, `listModels` → `[]`,
  strict path throws; invalidate → next call refetches but still falls back to
  last-good on failure; single-flight still holds.
- `opencodeAdmin` tests: reload success and restart call the invalidator.
- Renderer: the clear-on-missing guard does not clear on an empty list, still
  clears on a non-empty list missing the model.
