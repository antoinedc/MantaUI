# WS09 — Models, spend and usage (iOS)

Status: revised (round 1) · Wave B · Owner files: `UsageMeters.swift`,
`ModelPickerSheet.swift`, `ChatModelCatalog.swift`, `ChatModelStore.swift` (D1),
new `Models*` / `Usage*` / `Optimizer*` files, `MantaAPIClient+Models.swift`,
server module `src/server/modelsUnidentified.mjs` (D7).

## Scope

| # | Feature | Desktop source |
|---|---|---|
| F1 | Models list: default model, shown in main picker, available as subagent, context size (+ edit name/description/context, enable deprecated) | `src/renderer/ModelsCard.tsx` |
| F2 | Spend ledger ("Where your spend goes") | `src/renderer/ModelLedgerCard.tsx` |
| F3 | Optimizer dashboard — read-only view | `src/renderer/OptimizerCard.tsx` |
| F4 | "Models we couldn't identify" fix-up | `src/renderer/ModelsWeCouldntIdentify.tsx` |
| F5 | Per-model price form (unpriced models) | `src/renderer/ModelPriceForm.tsx` |
| F6 | Resume-after-limit screen + session-list entry point | `src/renderer/UsageResumeModal.tsx`, `usageResume.ts`, `Sidebar.tsx:701-712` |
| F7 | Usage alerts at 90% / at the limit with "Remind me at reset" / "Keep going at reset" | `src/renderer/usageEscalation.ts`, `App.tsx:511-560, 794-917` |
| ~~F8~~ | ~~Seat data for the context sheet~~ — **removed by D17**: WS02 renders the seat row from the existing `AccountsStore.conversationSeat` projection. WS09 provides nothing for it. | — |

Out of scope (master): optimizer savings pill, Auto-routing indicator. The
editable "Manta optimized token usage" switch is already a schema setting
(`generated/swift/SettingsSchema.swift:121`, `optimizerEnabled`) rendered by
the iOS Settings form; F3 only *shows* its state, exactly like desktop.

## Where it lives on iOS (overview)

Settings → **Models** (a fixed row above the schema sections, like the existing
Accounts row) pushes `ModelsScreen`:

```
ModelsScreen (List, insetGrouped)
├─ Section "Models we couldn't identify"   (F4, only when rows exist / catalogue down)
├─ Section "Default"                        (F1 banner: saved default)
├─ Section "Models" (searchable)            (F1 rows; tap → ModelsDetailSheet)
├─ Section "No prices"                      (F5, only when unpriced models exist)
└─ Section "Insights"
     ├─ NavigationLink "Where your spend goes" → ModelsLedgerScreen   (F2)
     └─ NavigationLink "Token optimizer"       → OptimizerScreen       (F3)
```

Resume-after-limit (F6) and usage alerts (F7) are app-level. There is ONE new
app-wide store, `UsageAlertsStore.shared` (`@MainActor`, bound to the app's
`MantaEventStore` like `WidgetLiveStore.shared.bind(eventStore:)`,
`MantaUIApp.swift:38`). It holds the box-computed alert queue (SF-M16), the
ids already shown, the visible chat id and the "resume sheet presented" flag —
no usage snapshots and no baseline (server-first). Stopped records are NOT
stored by WS09 (D16); the resume sheet renders the box's `usage-stopped:view`. The banner overlay and the resume sheet
are mounted in `MantaAppRoot` by integration agent B (D18).

### Box lifecycle (applies to every WS09 app-wide state)

The app can switch boxes without relaunching (`MantaAppRoot.swift:185-201`
`commitPairing` with `flow.isSwitching`; `:235-240` `beginSwitch`), and WS10
posts `Notification.Name.mantaBoxRemoved` on "Remove server". WS09 has two
process-wide singletons, `UsageAlertsStore.shared` and
`ChatModelCatalog.shared`. Both:

- **own their client per box.** Today `ChatModelCatalog` holds
  `private let api` built once with `.live()` (`ChatModelCatalog.swift:30-37`);
  `.live()` fixes the URL at construction (or the `https://127.0.0.1`
  placeholder when unpaired) while its default token provider re-reads the
  Keychain on every request (`MantaAPIClient.swift:8-21`). After a switch from
  box A to box B that client would send B's token to A's URL. So both
  singletons replace `api` with
  `private var api: MantaAPIClient?` + `private(set) var binding: ModelsBoxBinding?`,
  and every request goes through `private func currentClient() -> MantaAPIClient?`:
  1. read ONE credentials snapshot from an injected
     `credentials: @MainActor () -> ModelsBoxCredentials?` (default: one
     `try? KeychainCredentialStore.shared.load()` mapped to
     `ModelsBoxCredentials`);
  2. `ModelsBoxBinding.resolve(current: binding, credentials: snapshot)`
     (pure, below) → `.unpaired` (no credentials or unparseable URL → return
     nil, issue NO request, publish nothing new), `.same` (reuse `api`), or
     `.rebind(newBinding, boxChanged: Bool)`;
  3. on `.rebind`: if `boxChanged`, run `resetForBoxChange()` first; then
     `api = makeClient(newBinding)` where
     `makeClient` = `MantaAPIClient(serverURL: binding.serverURL, tokenProvider: { [token = binding.token] in token })`
     — URL and token come from the SAME snapshot and the token is captured,
     never re-read, so a request can only ever pair box B's URL with box B's
     token. `makeClient` is injectable (`(ModelsBoxBinding) -> MantaAPIClient`)
     for tests.
  The request's generation is captured AFTER `currentClient()` returns, so a
  rebind-triggered reset can never be raced by its own request. Tests inject
  the old shared `api:` init parameter only through `makeClient`;
- keep `private var generation = 0`;
- expose `func resetForBoxChange()`: `generation += 1`, cancel in-flight
  tasks, `api = nil`, `binding = nil` (the old client is invalidated), clear
  all published state (queue, seen ids, `activeSessionId`,
  `resumeSheetPresented`, `unsupported`; for the catalogue: models, defaults,
  `picker`, `pickerUnsupported`, `loaded = false`, `didStart = false`).
  Nothing is fetched until the new box's stream connects (alerts) or a chat /
  the Models screen asks (catalogue); the next request rebinds from the new
  credentials;
- drop any response whose captured `generation` differs from the current one
  (a late old-box answer can never land on the new box);
- call `resetForBoxChange()` themselves on `mantaBoxRemoved`, and are called by
  mount M-09-4 in `commitPairing`'s `isSwitching` branch, right after
  `sessionStore.resetForBoxChange()`;
- refuse actions (Remind, Keep going) whose alert was received under an older
  generation (the box also refuses an elapsed reset, SF-M17).

The pure part is Foundation-only and tested under `verify.sh` (D19): the
client binding decision lives in `ModelsBoxBinding.swift`:

```swift
struct ModelsBoxBinding: Equatable, Sendable {
  let boxKey: String        // credentials.boxId, or serverUrl when boxId is empty
  let serverURL: URL
  let token: String
}
enum ModelsBoxBindingDecision: Equatable { case unpaired, same, rebind(ModelsBoxBinding, boxChanged: Bool) }
extension ModelsBoxBinding {
  static func resolve(current: ModelsBoxBinding?, credentials: ModelsBoxCredentials?) -> ModelsBoxBindingDecision
  // nil / empty serverUrl / unparseable URL / empty token → .unpaired
  // equal to current → .same
  // different → .rebind(new, boxChanged: current == nil || current!.boxKey != new.boxKey)
  //   (a re-pair of the SAME box with a new token rebinds without a reset)
}
```

`MantaCredentials` lives in `KeychainCredentialStore.swift`, which imports
Security; so the package-buildable input is a three-field mirror
`ModelsBoxCredentials { serverUrl, boxId, boxToken }` declared in
`ModelsBoxBinding.swift`; the stores convert at the call site.

Tests (`MantaUITests/ModelsBoxBindingTests.swift`, Foundation-only):
nil → unpaired; empty token → unpaired; first pairing → rebind(boxChanged:
true); same snapshot → same; same box, rotated token → rebind(boxChanged:
false); box B → rebind(boxChanged: true); boxId empty falls back to the URL as
the key. Store tests (Mac, `URLProtocol` stub recording `request.url.host` and
the `Authorization` header): **unpaired → paired**: no request while unpaired,
then the first request goes to the paired host with that box's bearer;
**A → B**: after the Keychain changes to B, the next catalogue reload and the
next `usage:alerts` read both hit B's host with B's token (never A's host), and a
response from A that lands after the switch is dropped.

---

## Server-first (D23/D24)

Authority: `server-first-audit.md` §WS09 and §3a. Folded MOVE-NOW items:
**M1, M2, M6, M7, M9, M10, M11, M13, M14, M15, M16, M17, M18** (M18 partly,
see "Rejected"). KEEP-CLIENT items stay on the clients: M4 fuzzy match, M5
context-size label, M8 cumulative path + axis ticks (chart geometry), M12
catalogue typeahead + Save gating, M19 reset-time/distance formatting. M3
(effective selection precedence + fast/plan toggles) is MOVE-LATER (WS11
follow-ups) — the fast toggle keeps today's client resolution, but over the
SERVER's selectable set (SF-M2).

Common rules for every module below:
- Pure functions take injected inputs; the service/registration layer does the
  I/O. Every module has `src/server/<name>.test.mjs` (node:test, run by
  `npm run test:server`; no live opencode, no state files — the
  `MANTA_STATE_HOME` sandbox applies).
- Writes that read-modify-write box config are serialized through ONE promise
  chain per module (`serialize(fn)`), so two devices can no longer lose each
  other's `optInModels` / `modelOverrides` / `declaredModels` edits.
- Every write publishes the hint frame `{kind:"models.updated", payload:{}}`
  on the bus (raw frame, NOT `streamInterp.mjs`), so every client refetches
  `models:table` / `models:picker`.
- Errors: validation failures RESOLVE as `{ok:false, field?, code, message}`
  (desktop copy); only programmer errors / opencode being down reject. An
  unknown key resolves `{ok:false, code:"unknown-model", message:"That model
  is no longer on this box."}`.
- Channel registration lines in `rpc.mjs`, the publish-point hook in
  `index.mjs` and nothing in `streamInterp.mjs` are applied by **integration
  agent B** in the server order 02 → 07 → **09** → 06 (mounts M-09-srv-n). WS09
  edits no line in those three files.

### Capability ids and the "Update your box" behaviour (D24 wire compat)

All changes are additive (new channels, new optional fields; no field is
removed or renamed — `opencode:sync-subagents`, `config:update`,
`opencode:set-model-cost`, `usage:list`, `usage-stopped:*` keep working for
older clients). Capability ids — appended to WS02's
`src/server/boxCapabilities.mjs` by integration agent B in wave B (mount
M-09-srv-2, master D25), so `/api/version` / `server:version` advertise them
from this wave on, like `search-scope-all-1` (WS06) and `artifacts-list-1`
(WS07). The clients' detection signal stays the exact one in the third column
(no extra round trip); any capability-list read goes through WS02's
`boxCapabilities()` / `useBoxCapability`, never a WS09 copy:

| Id | Covers | Gate until the list exists (and also after) |
|---|---|---|
| `models-table-1` | SF-M1 | `models:table` rejects with `unknown rpc channel: models:table` (`rpc.mjs:431-434`) |
| `models-picker-1` | SF-M2 | `models:picker` unknown channel |
| `models-unidentified-1` | SF-M9/M10/M11 | `models:unidentified` / `models:declare` unknown channel |
| `models-price-form-1` | SF-M13 | `models:set-price` unknown channel, or `optimizer:prices` without `unpricedByProvider` |
| `ledger-view-1` | SF-M6 | `ledger:summary` result without `view` |
| `optimizer-view-1` | SF-M7 | `optimizer:summary` / `optimizer:series` result without `view` |
| `usage-resume-view-1` | SF-M14/M15 | `usage-stopped:view` unknown channel |
| `usage-alerts-1` | SF-M16/M17 | `usage:alerts` unknown channel |
| `usage-window-tone-1` | SF-M18 | `usage:list` window without `tone` |

Client behaviour on an older box (both clients, no fallback copy of the old
logic): the dependent surface renders a single muted line **"Update your box to
use this."** in place of its content — the Models list, the unidentified block,
the price section, the ledger/optimizer screens, the resume sheet. Specific
cases:
- **Picker on an older box**: the picker still lists models (it is core), but
  from the raw `opencode:models` list with NO hiding and NO deprecated locking
  (that derivation is the box's now), plus a footer "Update your box to hide
  models and manage deprecated ones." on both clients.
- **Usage alerts on an older box**: no alerts are shown; Settings → Models →
  Insights shows "Update your box to get usage alerts."
- **Meter tone on an older box**: rings render in the neutral track colour (no
  band) and the usage sheet shows "Update your box to see usage colours."
iOS detection: `ModelsCapability.isUnsupported(_ error: Error) -> Bool` (true
for `MantaError.server` whose message starts with `unknown rpc channel`), and
`nil` `view`/`tone`/`unpricedByProvider` fields. Desktop detection: the same
error-message prefix (`err.message.startsWith("unknown rpc channel")`) and the
same absent fields.

### SF-M1 — models table → new `src/server/modelsTable.mjs`

Ports and replaces `ModelsCard.tsx:244-380` (row state, Main/Sub/Default
invariants, deprecated lock, opt-in, override diff) and WS09's planned
`ModelsTable` Swift type.

```js
// pure
export function modelKey(providerID, id)
export function buildTableRows({ models, config, guide = describeModel }) // → Row[]
export function overrideFor({ model, providerDefaults, fields })          // → {override} | {error:{field,message}}
export function buildPicker({ models, config, recents })                 // → models:picker result (SF-M2)
export function subOutcome(detail)  // detail = syncSubagentsDetailed() result → "applied" | "not-applied" | "saved-not-live"
// service
export function createModelsTable({
  listModels,              // (overrides) => Promise<OpencodeModel[]>   — oc.listModels(overrides, {strict:true})
  configGet,               // () => Promise<AppConfig>                   — local.configGet
  configUpdate,            // (patch) => Promise<AppConfig>              — local.configUpdate
  syncSubagentsDetailed,   // providers.syncSubagentsDetailed (below)
  getModelPrefs,           // () => Promise<{sessions, recents}>         — modelPrefs.mjs getModelPrefs
  publish,                 // (evt) => void                              — bus.publish
}) // → {
//   table(): Promise<TableResult>,
//   picker(): Promise<PickerResult>,
//   setDefault({key}): Promise<WriteReply>,
//   setMain({key, on}): Promise<WriteReply>,
//   setSub({key, on}): Promise<WriteReply & {outcome}>,
//   retrySubSync(): Promise<WriteReply & {outcome}>,
//   optIn({keys}): Promise<WriteReply & {outcome, ignored}>,
//   setOverride({key, fields}): Promise<WriteReply>,
// }
```

**Outcome-aware reconcile (finding: the old helper swallows the write
result).** `providers.syncSubagents` (`providers.mjs:803-832`) returns `[]` on
a read failure, the OLD list on a write failure and the new list on success,
so no caller can tell a failed write from a successful no-op. WS09 adds, in
`src/server/providers.mjs` (WS09-owned in wave B — master D27 table):

```js
export async function syncSubagentsDetailed({ models = [], deactivated = [], optIn = [] } = {},
                                            readConfig = readRemoteConfig, applySubagents = setSubagents)
// → { agents: SubagentDef[],                                   // exactly what syncSubagents returns today
//     read:   "ok" | "failed",
//     write:  "noop" | "ok" | "failed",                         // noop = reconcile found nothing to change
//     reload: "ok" | "failed" | "n/a",                          // n/a for noop / failed writes
//     error?: string }
export async function syncSubagents(input, readConfig, applySubagents) {
  return (await syncSubagentsDetailed(input, readConfig, applySubagents)).agents; // unchanged contract
}
```

The single implementation moves into `syncSubagentsDetailed`; `syncSubagents`
becomes the one-line projection, so `opencode:sync-subagents` (older clients)
is byte-identical. The write status comes from `setSubagents`' result, which is
`editConfig`'s `{ok, changed}` (`providers.mjs:666-681`, `:220-226`):
`ok:true` → write ok/reload ok; `ok:false, changed:true` → write ok, reload
failed; `ok:false, changed:false` → write failed. No second config writer, no
second reconciliation. `subOutcome(detail)`: `read ok` and `write ∈
{noop, ok}` and `reload ∈ {ok, n/a}` → `applied`; `write ok` + `reload failed`
→ `saved-not-live`; anything else → `not-applied`. Tests in
`providers.test.mjs` (`syncSubagentsDetailed` describe): read failure →
`read:"failed"`, `agents:[]`; successful no-op → `write:"noop"`; write failure
→ `write:"failed"` with the old list; reload failure → `write:"ok",
reload:"failed"`; `syncSubagents` still returns the same arrays as today in all
four cases.

**`models:table`** — `args: []`. Result:

```jsonc
{
  "supported": true,
  "defaultKey": "anthropic/claude-opus-4-7",       // null = no default
  "defaultLine": { "name": "Opus 4.7", "providerID": "anthropic" }, // null → clients show "No default set — opencode default (server decides)"
  "rows": [{
    "key": "anthropic/claude-opus-4-7", "providerID": "anthropic", "modelID": "claude-opus-4-7",
    "name": "Opus 4.7",
    "contextLabel": "1M",                          // formatModelContextSize, null when unknown
    "tier": "deep",                                // describeModel(...).tier, null when unknown (restores the D8-deferred tag)
    "description": "…",                            // override ?? model.description ?? guide blurb, null
    "searchText": "opus 4.7 anthropic claude-opus-4-7 … good for …", // lower-case; client search = substring
    "deprecated": false, "deprecatedLocked": false,
    "isMain": true, "isSub": true, "isDefault": true,
    "canMakeDefault": true,                        // isMain && !deprecatedLocked
    "defaultHint": null,                           // "Enable Main first" | "Enable this deprecated model first" | null
    "editable": { "name": "Opus 4.7", "description": "…", "context": 1000000 } // current effective values for the edit form
  }]
}
```

**Writes** (all `args: [{…}]`, all return `{ok:true, table: <models:table result>, message}`
or `{ok:false, field?, code, message}`; all serialized; all publish
`models.updated`):

| Channel | Input | Behaviour | `message` on success |
|---|---|---|---|
| `models:set-default` | `{key: string\|null}` | Refuses a key whose row has `canMakeDefault:false` (`code:"not-main"`, "Turn on Main first."). Writes `defaultModel` (`null` clears). | "Default set to <name>." |
| `models:set-main` | `{key, on}` | Off on the current default also writes `defaultModel:null` in the SAME `config:update` (`ModelsCard.tsx:255-276`). | "Hidden from the model picker." / "Shown in the model picker." (+ " The default was cleared." when it was) |
| `models:set-sub` | `{key, on}` | Writes `deactivatedSubagents`, then `syncSubagentsDetailed` and `subOutcome` (no client heuristics). Result adds `"outcome": "applied" \| "not-applied" \| "saved-not-live"` and `"retry": boolean` (true only for `not-applied`). `not-applied`/`saved-not-live` are still `ok:true` because the preference WAS saved. | applied: "Subagent list updated." · not-applied: "Preference saved, but the subagent list on the box wasn't updated. Try again to apply it." · saved-not-live: "Preference saved and written, but opencode didn't reload it — it takes effect when opencode restarts (Settings → Box → Restart opencode)." |
| `models:retry-sub-sync` | `{}` | `retrySubSync()`: re-runs only `syncSubagentsDetailed` with the saved `deactivatedSubagents`/`optInModels` and the current model list; same `{ok, outcome, retry, table, message}`. | as above |
| `models:opt-in` | `{keys: string[]}` | Union into `optInModels` read INSIDE the serialized write (no lost update), then `syncSubagentsDetailed` (same outcome/retry/message rules as `set-sub`). Used by the Models list "Enable deprecated", the picker "Enable", and the iOS one-time copy (below). Unknown keys are ignored (`ignored: string[]` in the result). | "Enabled <name>." / "Enabled N models." (+ the not-applied / saved-not-live sentence when not `applied`) |
| `models:set-override` | `{key, fields:{name?, description?, context?}}` (strings as typed) | Builds the override with `overrideFor` (only fields that differ from the provider default; blank = keep default; context must be a positive whole number else `{ok:false, field:"context", message:"Context size must be a whole number of tokens above 0."}`); an empty override deletes the key; read-modify-write of `modelOverrides` inside the chain. | "Saved." |

Node tests `src/server/modelsTable.test.mjs`: row state for live / deprecated
locked / deprecated opted-in / Main off (`canMakeDefault:false`, hint);
`searchText` includes guide "good for"; `set-main` off on the default clears it
in ONE `configUpdate` call; `set-default` refuses a hidden key; `set-sub`
config write OK + injected `syncSubagentsDetailed` returning `write:"failed"`
→ `ok:true, outcome:"not-applied", retry:true`; `read:"failed"` → `not-applied`;
`write:"ok", reload:"failed"` → `saved-not-live, retry:false`; successful no-op
(`write:"noop"`) → `applied`; `retrySubSync()` re-runs only the reconcile
(no `configUpdate` call); `opt-in` uses the same mapping; config write rejects
→ `ok:false`; `opt-in` concurrent calls both land (two
interleaved calls → final list has both keys); `opt-in` ignores unknown keys;
`overrideFor` blank/unchanged/invalid context/all-unchanged → delete;
`models.updated` published once per successful write.

### SF-M2 — picker → same module, channel `models:picker`

Ports `chatUtils.ts:2356-2470` (`hideFastSiblingGroups`, `selectableModelList`,
`selectableModelGroups`, `mainPickerGroups`) and WS09's planned `ModelsPicker`.

**`models:picker`** — `args: []` (box-wide; per-session selection stays in
`model-prefs`). Result:

```jsonc
{
  "supported": true,
  "groups": [{ "provider": "anthropic", "keys": ["anthropic/claude-opus-4-7", "…"] }], // main picker: enabled, not Main-hidden, -fast siblings folded, deprecated KEPT
  "locked": ["anthropic/claude-3-opus"],          // deprecated and not opted in → render disabled with "Enable"
  "selectable": ["anthropic/claude-opus-4-7", "anthropic/claude-opus-4-7-fast"],   // flat: enabled, not hidden, not locked (fast twins included — the ⚡ toggle input)
  "delegateGroups": [{ "provider": "anthropic", "keys": ["…"] }], // desktop delegate picker = selectableModelGroups (deprecated excluded)
  "recents": [{ "providerID": "anthropic", "modelID": "claude-opus-4-7", "variant": "high", "fast": false, "key": "anthropic/claude-opus-4-7" }] // model-prefs recents whose key is selectable (or whose -fast twin is), order kept
}
```

Inputs: `oc.listModels(overrides)`, config `deactivatedMainModels` /
`optInModels`, `getModelPrefs().recents` (`modelPrefs.mjs:146`). Clients look
the model OBJECTS up by key in the `opencode:models` list they already hold
(names, variants, capability badges stay presentational). Freshness: clients
refetch on `models.updated` and on `model-prefs.updated` (recents).

Node tests (same file): hidden key absent from `groups`/`selectable`/
`delegateGroups`/`recents`; locked deprecated present in `groups` + `locked`,
absent from `selectable`; opted-in deprecated selectable; `-fast` twin folded
out of `groups` but present in `selectable`; `enabled:false` absent
everywhere; recents of a removed model dropped.

**iOS behaviour change (D24):** deprecated opt-ins move from UserDefaults
(`DeprecatedModelOptIns`, `ChatModelStore.swift:97,276-281`) to box config.
One-time copy per box: on the first successful `models:picker` read for a box
binding, if `DeprecatedModelOptIns.load()` is non-empty and the per-box flag
`manta:deprecated-opt-ins-copied:<boxKey>` is unset, call
`models:opt-in {keys: <local set>}`; on `ok:true` set the flag and
`DeprecatedModelOptIns.save([])`; on failure keep both and retry on the next
read (silent — the user did nothing; the models stay locked until it lands).
From then on iOS reads only `locked`/`selectable`.

### SF-M6 — ledger view → new `src/server/ledgerView.mjs`

```js
export function ledgerView(summary)     // → view (pure); summary = ledgerSummary() result
export function withLedgerView(summary) // → summary.supported ? {...summary, view: ledgerView(summary)} : summary
```

Registration wraps the existing channel (M-09-srv-1):
`"ledger:summary": async (opts) => withLedgerView(await ledgerSummary(opts ?? {}))`
where `withLedgerView(s) = s.supported ? {...s, view: ledgerView(s)} : s`.

```jsonc
"view": {
  "segments": [ { "kind": "cacheRead", "label": "cache read", "pct": 61, "inline": true },
                { "kind": "cacheWrite", "label": "cache write", "pct": 22, "inline": true },
                { "kind": "output", "label": "output", "pct": 14, "inline": true },
                { "kind": "input", "label": "fresh input", "pct": 3, "inline": false } ], // fixed order; inline = pct >= 4 (ModelLedgerCard.tsx:118-128)
  "caption": "Cache is 83% of your bill — carrying the conversation, not generating answers.",
  "topModels": [ { "key": "…", "turns": 120, "costPerTurn": 0.12, "tokensPerSec": 41, "cost": 14.4 } ], // ≤ 6, tokensPerSec null kept
  "agents": [ { "label": "main", "isChild": false, "turns": 90, "costPerTurn": 0.1, "cost": 9 } ],
  "emptyModels": "No model spend recorded.", "emptyAgents": "No agent spend recorded."
}
```

Money (`$1.20`) and thousands separators stay client formatting. Tests
`src/server/ledgerView.test.mjs`: order, rounding, inline threshold at 3/4,
caption sums cache read + write, top-6 cap, null agent → "main", unsupported
input untouched.

### SF-M7 — optimizer view → new `src/server/optimizer/view.mjs`

```js
export function summaryView(summary, { optimizerEnabled })   // → view
export function seriesView(series, { range })                // → view
export function withSummaryView(summary, config)  // → summary.supported ? {...summary, view: summaryView(summary, {optimizerEnabled: config?.optimizerEnabled === true})} : summary
export function withSeriesView(series, range)     // → series.supported ? {...series, view: seriesView(series, {range: series.range ?? range ?? "24h"})} : series
```

Registration wraps both channels (M-09-srv-1):
`"optimizer:summary": async () => withSummaryView(await optimizerSummaryFn(), await local.configGet())`,
`"optimizer:series": async (opts) => withSeriesView(await optimizerSeriesFn(opts?.range), opts?.range)`
(view only when `supported`).

`optimizer:summary` `view`:

```jsonc
{
  "switch": { "on": false, "label": "Off",
              "body": "Manta trims, paces and compacts your conversations to make a plan last longer. It never changes which model you picked by hand. Everything it changes is listed below." },
  "subrows": [ // only those backed by data; trimming comes from the series view
    { "id": "pacing", "name": "Pacing", "text": "Cheaper models while a plan window is ahead of pace. Build and plan work keeps its quality floor.", "chip": "eco · +6 pts ahead of pace" },
    { "id": "compacting", "name": "Compacting", "text": "Long idle conversations are summarized in the background, before you come back to them.", "chip": "3 of 5 in background" },
    { "id": "cache", "name": "Prompt cache", "text": "Reads billed at 0.1×; TTL 5m measured.", "chip": "74% hit" } ],
  "windowsCaption": "Forecast from your recent usage. Tick = forecast at reset. Pressure chip = how far ahead of pace this window is right now.",
  "windows": [ { "key": "claude:session", "title": "Max 20x — Session (5h)", "resetsAt": 1761660000000,
                 "pct": 62, "pctLabel": "62% used", "band": "warn",               // <60 ok · 60–84 warn · ≥85 danger (OptimizerCard.tsx:75-79)
                 "forecastPct": 88, "forecastWarn": true, "forecastLabel": "forecast 88%", // "gathering history…" when null
                 "pressure": { "text": "+6 pts ahead of pace", "tone": "warn" } } ],
  "metered": [ { "name": "…", "role": "…", "price": "…" } ], "meteredCaption": "Pay-per-token endpoints have no window and never reset, …",
  "activity": [ { "id": "a1", "ts": 1761650000000, "headline": "Kept — eco level 2", "detail": "Turns 62 · Hit 74.1%", "rolledBack": false } ],
  "activityCaption": "Every parameter change the optimizer made on its own, with the evidence it used. Rolled-back entries stay — that is the point.",
  "activityEmpty": "Nothing changed yet. Manta needs a few days of your usage before it starts tuning anything.",
  "stats": [ { "id": "cacheHit", "label": "Cache hit", "value": "74%", "detail": "TTL 5m measured · 30d", "tone": "neutral" },
             { "id": "sessions", "label": "Sessions", "value": "18", "detail": "3 of 5 in background · 30d", "tone": "neutral" } ]
}
```

`optimizer:series` `view`:

```jsonc
{
  "heading": "Token consumption — with & without optimization",
  "trimming": { "name": "Trimming", "text": "Old tool output is replaced by a one-line placeholder after a few newer tool uses. The last 40k tokens are never touched.", "chip": "−12% sent" }, // null when trimmedPct == 0
  "hasCounterfactual": true, "noActivity": false,
  "emptyText": "No model activity in the last 24h.",
  "legend": { "sent": "sent", "raw": "raw counterfactual — same turns, nothing trimmed (est.)", "noCounterfactual": null }, // or "Hourly comparison starts collecting today." / "No trimming recorded in this window."
  "savingLabel": { "text": "−1.2M tokens · ≈ $3.40 est.", "tone": "ok" },   // null when nothing trimmed; tone "warn" when negative
  "potentialLine": "Potential, not applied: −400k tokens · ≈ $1.10 est.",    // null when 0
  "rawValues": [12, 40, 91],          // per-bucket sent + actual trimmed (the client builds the cumulative path — M8 KEEP-CLIENT)
  "stats": [ { "id": "sent", "label": "Sent (24h)", "value": "3.4M tokens", "detail": "raw 3.9M tokens", "tone": "neutral" },
             { "id": "saved", "label": "Saved (est.)", "value": "≈ $3.40", "detail": "≈$4.50 potential · 80% priced", "tone": "ok" },  // "not priced"/"these endpoints declare no price"; negative "−$1.20"/"re-cache cost exceeded savings" tone warn
             { "id": "costPerTurn", "label": "Cost / turn", "value": "$0.12", "detail": "24h average", "tone": "neutral" } ]
}
```

Ports `describePressure`, `describeActivityEntry` (`chatUtils.ts:246-302`),
`ttlLabel`, `gaugeColor`, `formatSavedUsd`, the totals/counterfactual block,
the saved-stat branches and every empty text (`OptimizerCard.tsx:55-581`), and
desktop `formatTokens` (`chatUtils.ts:219-223`) for the token strings. Chart
geometry (cumulative path, axis ticks: `buildCumulativePath`,
`chartAxisTicks`) stays client (M8). Tests
`src/server/optimizer/view.test.mjs`: every branch named above (gauge bands at
59/60/84/85, ttl labels incl. 10m, pressure no-signal/on-pace/ahead, activity
verdict words + unknown verdict, potential falls back to `maskedTokens`, raw
excludes potential, each saved basis incl. negative, empty/legend texts per
range, sub-rows present only with data, `supported:false` untouched).

### SF-M9 / M10 / M11 — unidentified models (`src/server/modelsUnidentified.mjs`, extended)

- **M9:** the desktop switches to `models:unidentified` in this change; the
  round-2 "desktop not changed" clause and the desktop-parity node test are
  **withdrawn**. The module is the only implementation.
- **M10:** each row adds `"help": string` — the full help line the desktop
  composes today (`ModelsWeCouldntIdentify.tsx:485-562`: "Matched automatically
  → <name> · <tier> · <ctx> — Auto still needs: …", "We think this is <name>
  — <evidence>…", "N models share this name — which one is it? — <evidence>",
  "No match — tell us which model this is") and `"actions":
  ["confirm"?, "change"?, "pick"?, "identify"?]`. The missing-phrase join
  (`AccountsCard.tsx:170-187` `describeMissing`) moves to
  `src/shared/autoEligibility.mjs` as `export function describeMissing(missing)`
  — the ONE implementation; the server imports it. `AccountsCard.tsx` IMPORTS
  it for its retained local caller (`helpText`, `:189-195`) and re-exports
  that binding for its existing importer `AccountsCard.test.ts:16` (see the
  desktop row; an `export … from` alone would leave `helpText` unbound).
- Rows also add `"label": "anthropic / opaque-id"` and, for ambiguous rows,
  `"chips": boolean` (`candidates.length <= 4`, `:539-555`). The envelope adds
  `"intro"`, `"footer"` and, when `supported:false`, `"unavailableText"` (the
  desktop copy at `:398-447`).
- **Module surface (pinned for M-09-srv-1):**

  ```js
  // pure
  export function buildUnidentifiedRows({ models, declared, catalog })   // → rows[] (help/label/actions/chips included)
  export function unidentifiedList({ models, declared, catalog })        // → {supported, intro, footer, unavailableText?, rows}
  export function buildDeclaration({ catalogId, form })                  // → {decl} | {error:{field, message}}
  export function mergeDeclared(routing, key, decl)                      // → new modelRouting (preset default "balanced")
  // service
  export function createModelsUnidentified({
    listModels,     // (overrides) => Promise<OpencodeModel[]>   — oc.listModels(overrides, {strict:true})
    configGet,      // local.configGet
    configUpdate,   // local.configUpdate
    catalog,        // { lookupModel, matchModel, allModels }    — src/server/modelCatalog.mjs exports
    publish,        // bus.publish
  }) // → { list(): Promise<UnidentifiedList>, declare({key, catalogId?, form?}): Promise<DeclareReply> }
  ```
- **M11 — `models:declare`** (new channel, same module). `args: [{key, catalogId}]`
  for Confirm / candidate pick, or `[{key, form:{catalogId, price:"free"|"custom"|null, costIn:string, costOut:string, caching:"none"|"custom", reads:bool, writes:bool}}]`
  for the editor. The box builds the declaration (`IdentifyEditor.save`,
  `:157-174`), validates (`{ok:false, field:"price", message:"Choose Free or enter a price."}`;
  `{ok:false, field:"catalogId", message:"Pick the model this is."}`),
  merges it into `modelRouting.declaredModels[key]` inside the serialized
  read-modify-write (same-key fields overwrite, absent fields keep; `preset`
  defaults to "balanced", `:295-299`), recomputes the rows and returns:

  ```jsonc
  { "ok": true,
    "outcome": "resolved" | "still-needs" | "catalogue-unavailable",
    "row": { /* refreshed row */ } | null,          // null when resolved
    "list": { /* full models:unidentified result */ },
    "message": "Saved — Auto can now describe opaque-id"
            // | "Identity saved — Auto still needs: what it costs, and whether it caches."
            // | "Saved. Manta couldn't load the model catalogue, so it can't confirm what Auto still needs — reopen Settings in a minute."
  }
  ```
  Publishes `models.updated`.

Node tests `src/server/modelsUnidentified.test.mjs` (extended): `help` text
for every case incl. probable with/without evidence and the "Auto still
needs" suffix; `describeMissing` 0/1/2/4 keys + unknown keys (moved test);
`declare` Confirm on an endpoint with no price → `still-needs` + help; editor
form free → `resolved`; custom with one blank rate → 0 for that rate;
missing price → field error; two interleaved declares on different keys both
persist; unsupported catalogue → `catalogue-unavailable`.

### SF-M13 — price form → new `src/server/modelsPricing.mjs`

```js
export function parseCostDraft(draft)        // moved verbatim from ModelPriceForm.tsx:40-69 → {ok, cost} | {ok:false, field, message}
export function groupUnpriced(keys)          // moved from ModelPriceForm.tsx:78-91
export function withUnpricedGroups(prices)   // optimizer:prices result → {...prices, unpricedByProvider: groupUnpriced(prices.unpriced)} when `unpriced` is an array, else unchanged
export function createModelsPricing({
  setModelCostDetailed,   // providers.setModelCostDetailed (below)
  invalidatePrices,       // () => optimizerPricesApi.invalidate()
  getPrices,              // () => optimizerPricesApi.get()
}) // → { setPrice({providerID, modelID, draft}): Promise<SetPriceReply> }
```

`providers.setModelCost` (`providers.mjs:760-782`) collapses `editConfig`'s
`{ok:false, changed:true}` (written to disk, live reload failed —
`providers.mjs:224-226`) into `{ok:false, error}`, so a caller would wrongly
say "nothing was changed". WS09 splits it in `providers.mjs` (WS09-owned in
wave B): `export async function setModelCostDetailed(input, deps)` keeps the
existing validation and the single `editConfig` writer and returns
`{ok, changed, reloaded, error?}` unchanged from `editConfig`;
`setModelCost` becomes `r => r.ok ? {ok:true} : {ok:false, error}` over it
(byte-identical for `opencode:set-model-cost`).

- **`models:set-price`** (new) — `args: [{providerID, modelID, draft:{input, output, cacheRead, cacheWrite}}]`
  (strings as typed). Validates with `parseCostDraft` (desktop messages:
  "<Label> is required." / "<Label> must be a number of dollars per million
  tokens (0 or more).") → `{ok:false, field, message}`; else calls
  `setModelCostDetailed` and maps:
  - `ok:true` → invalidate prices → `{ok:true, message:"Saved — the optimizer will use these prices", unpricedByProvider}`;
  - `ok:false, changed:true` (on disk, reload refused) → invalidate prices
    (the optimizer reads the config FILE through `providers.readOpencodeConfig`,
    `rpc.mjs:771-773`, so its prices ARE in effect) →
    `{ok:true, warning:"opencode didn't reload its config, so its own cost display picks the new prices up after it restarts.", message:"Saved — the optimizer will use these prices", unpricedByProvider}`;
  - `ok:false, changed:false` → `{ok:false, message:"Couldn't save — <why>. Nothing was changed; try again."}` (true: nothing was written).
  `opencode:set-model-cost` stays as is (additive). Clients show `warning`
  (when present) as a muted second line under the confirmation.
- **`optimizer:prices`** result adds `"unpricedByProvider": [{providerID, models:[modelID]}]`
  (registration wrapper, M-09-srv-1).

Tests `src/server/modelsPricing.test.mjs`: the moved `ModelPriceForm.test.tsx`
pure cases (required fields, "1e3"/"0x10"/"-1"/"1,5" rejected, ".5"/"3."
accepted, cache write optional), first-slash split, malformed keys dropped,
sort order, set-price mapping for each `setModelCostDetailed` result
(written + reloaded; **written + reload refused → `ok:true` with `warning`,
prices invalidated**; not written → "Nothing was changed"), `withUnpricedGroups`
leaves a result without `unpriced` untouched. `providers.test.mjs`:
`setModelCostDetailed` returns `changed:true, ok:false` on an injected reload
failure; `setModelCost` keeps its old shape for all three.

### SF-M14 / M15 — resume view → new `src/server/usageResumeView.mjs`

Ports `usageResume.ts:24-151` (except `unarmedStoppedCount` and
`shouldShowStoppedMarker`, which are row-marker logic owned by WS04/WS11) and
the `UsageResumeModal.tsx` derivations.

```js
// pure
export function buildResumeView({
  stopped,     // REQUIRED full store envelope {records: StoppedRecord[], lastLooked: number|null} — exactly listStopped()'s shape (stoppedStore.mjs:287-290)
  snapshots,   // UsageSnapshot[] (reset instants)
  cacheTtl,    // "5m" | "1h"
  names,       // Map<sessionId, windowName> from tmux.listProjects()
  snippets,    // Map<sessionId, string|null>
  now,         // epoch ms
}) // → UsageStoppedViewResult (below). isNew = lastLooked == null || stoppedAt > lastLooked
export function planApply({ records, selected })  // → {arm[], disarm[], canApply, title}
// service
export function createUsageResumeView({
  listStopped,    // () => Promise<{records, lastLooked}>   — stoppedStore listStopped (rpc alias usageStoppedList)
  listSnapshots,  // () => UsageSnapshot[]                  — usage.mjs listSnapshots
  configGet,      // local.configGet (cacheTtl)
  listProjects,   // tmux.listProjects
  listMessages,   // (sessionId, {limit:5}) => Promise<OpencodeMessage[]> — oc.listMessages
  arm,            // ({conversation}) => Promise<void>      — stoppedStore armStopped bound to {publish}
  disarm,         // ({conversation}) => Promise<void>      — stoppedStore disarmStopped bound to {publish}
  now,            // Date.now
}) // → { view(): Promise<UsageStoppedViewResult>, apply({selected, dryRun}): Promise<ApplyReply> }
```

This module serves ONLY the resume screen (D29): WS04's `usage-stopped:list`,
`stoppedRecords`, `stoppedLastLooked`, `unarmedStoppedCount` keep driving the
row markers and the M-09-2 capsule. Closing the screen uses the existing
`usage-stopped:stamp-last-looked`, which updates the same envelope's
`lastLooked`, so the next `view()` (and WS04's next list) clears "new".

**`usage-stopped:view`** — `args: []`. Result:

```jsonc
{
  "supported": true,
  "title": "Resume after limit reset",
  "header": "2 armed · 1 stopped since you last looked.",   // or "3 conversations were stopped by a provider limit. Pick which ones…"
  "hasArmed": true, "unarmedCount": 1, "totalCount": 3,
  "emptyText": "No conversations are stopped by a provider limit right now.",
  "groups": [{ "workspace": "manta", "rows": [{
    "conversation": "ses_1", "name": "fix login",              // tmux window name for that session, else the id
    "armed": true, "isNew": false,
    "snippet": "I updated the guard…",                           // null when none (box reads the last 5 messages)
    "provider": "claude", "model": "claude-opus-4-7",
    "window": { "label": "Weekly", "resetsAt": 1761700000000 },  // label "Limit" when the refusal named no window
    "cost": { "warm": false, "reReadTokens": 340000, "label": "≈ 340k tokens re-read" } // warm → label "cache still warm · no extra cost"
  }]}],
  "coldNote": { "one": "One of these resets well past your prompt-cache window, so its history is re-read from scratch. The estimate is per conversation above.",
                "many": "{n} of these reset well past your prompt-cache window, so their history is re-read from scratch. The estimate is per conversation above." }
}
```

The "· Thu 09:00 · in 2h" part of the window chip is clock-relative and stays
client (M19). The selection-dependent footer ("N selected · ≈ X re-read"/" ·
no extra cost") and the cold note pick ("one"/"many" with the count) are sums
over the rows the box returned and the client's selection — view arithmetic,
kept client.

**`usage-stopped:apply`** — `args: [{selected: [conversation], dryRun?: boolean}]`.
`planApply` diffs the selection against the CURRENT records (selected & not
armed → arm; armed & not selected → disarm). Result:
`{ok:true, canApply, title, arm:[…], disarm:[…], applied:{armed:[…], disarmed:[…]}, failed:[{conversation, name, message}], message}`.
`canApply` is true whenever the plan has ANY arm or disarm (fixes the desktop
defect — the last armed row could not be disarmed, `UsageResumeModal.tsx:229-230`);
`title` = "Resume N at reset" when nothing is armed yet, else "Update".
`dryRun:true` computes only `canApply`/`title`/`arm`/`disarm` (no writes) — the
clients call it (debounced 150 ms) on selection change to enable/title the
button. A real apply runs arms then disarms, stops at the first failure
(`failed` has it; `message` = "Couldn't update <name> — <reason>. The ones after
it weren't changed."), and publishes `usage-stopped.updated` through the store
functions as today. Success `message`: "Updated — N conversation(s) will carry
on at reset." / "Removed N conversation(s) from resume.".

Tests `src/server/usageResumeView.test.mjs`: the moved `usageResume.test.ts`
cases (snippet extraction, reset lookup, warm/cold boundary exactly at TTL,
grouping order, isNew with null/equal/before/after lastLooked), header
variants, names from projects + id fallback, `planApply` (one armed row
unchecked → `canApply`, title "Update"; all unchecked; no change → false;
nothing armed → "Resume N at reset"), apply stops at first failure; `view()`
passes the full `{records, lastLooked}` envelope (a record stopped before
`lastLooked` is not new; after stamping, `isNew` flips to false).

### SF-M16 / M17 — usage alerts → new `src/server/usageAlerts.mjs`

Ports `usageEscalation.ts` (levels, upward transition, stale guard, baseline,
warn/limit text) and the remind-at-reset policy; the clients lose all
baseline/seed logic. **In-app only (D24): no push, no `fireNotify` call.**

```js
export function level(pct)                                  // none | warn | limit (90 / 100)
export function levels(snapshots)                           // baseline map, stale verbatim
export function transitions(prev, next, now)                // fired alerts (stale never fires)
export function alertText({ provider, window, level })      // "Claude Session (5h) 93% used" / "Weekly limit reached on Claude"
export function createUsageAlerts({ now, publish, bootId = randomUUID() })
// → {
//   observe(snapshots): void,                               // called from usage.mjs's poller observe hook
//   list(): {supported:true, bootId, revision, alerts},     // usage:alerts
//   remind({key, sessionID}, {createJob, publish}): Promise<RemindReply>,  // usage:remind-at-reset
//   stop(): void,                                           // clears the expiry timer
// }
```

- **Observation point:** the usage poller's existing `observe` hook
  (`usage.mjs:647`, wired in `startUsagePoller`, `usage.mjs:701-704`). WS09
  extends `usage.mjs` itself (not a registration file): `startUsagePoller`
  creates `createUsageAlerts({ now: Date.now, publish: (evt) => bus.publish(evt) })`,
  calls `alerts.observe(results)` inside the existing `observe` callback, and
  exposes it through `export function getUsageAlerts()` (same pattern as
  `activePoller` / `listSnapshots`, `:706,727`). The engine owns one unref'd
  timer for the earliest `expiresAt`. No `index.mjs` change.
  The FIRST observation after box start seeds the baseline silently (no
  alerts — parity with the desktop cold start); later observations fire upward
  transitions and replace the baseline. Because the box keeps the baseline,
  alerts that fire while a client is disconnected are not lost.
- **Frame:** raw bus frame `{kind:"usage.alert", payload:{bootId, revision, alert}}`
  or `{kind:"usage.alert", payload:{bootId, revision, retired:[id]}}`, published
  through the poller's `publish` (`/events`; not `streamInterp.mjs`).
  `revision` is a counter bumped by EVERY change to the active set (raise or
  retire); `bootId` is fixed per box process (`randomUUID()` at creation), so a
  box restart is recognisable.
- **Alert shape:**

  ```jsonc
  { "id": "claude:weekly:limit:1761700000000",   // key:level:resetsAt — stable, so a re-read never re-shows it
    "key": "claude:weekly", "level": "limit",     // "warn" | "limit"
    "provider": "claude", "windowKind": "weekly", "windowLabel": "Weekly",
    "pct": 100, "resetsAt": 1761700000000,         // null when the provider gives none
    "text": "Weekly limit reached on Claude",      // the reset clause ("— resets in …") is appended by the client (M19)
    "raisedAt": 1761650000000,
    "expiresAt": 1761700000000,                    // limit: resetsAt (null = until the level drops); warn: raisedAt + 15 min
    "sticky": true,                                // limit alerts stay until closed/retired; warn auto-dismiss 6 s on the client
    "canRemind": true, "canKeepGoing": true }      // false once resetsAt <= now or resetsAt == null
  ```
- **`usage:alerts`** — `args: []` → `{supported:true, bootId, revision, alerts:[…]}`:
  the alerts still ACTIVE (level holds and `expiresAt` not passed) as of
  `revision`. An alert is retired from the active set when its key drops below
  its level or `expiresAt` passes; a retirement publishes the `retired` frame.
- **Client reconciliation contract (both clients, identical):** the client
  keeps `lastBootId`, `lastRevision`, the displayed queue and a per-box
  `seenIDs` set (ids ever shown OR dismissed — dismissal never removes from
  `seenIDs`).
  - *Snapshot* (`usage:alerts`, on connect and every disconnect→connect): if
    `bootId != lastBootId`, reset `lastRevision = -1`. If `revision <
    lastRevision`, DROP the snapshot (a newer frame was already applied while
    it was in flight). Else it is authoritative: remove from the queue every
    id NOT in `alerts` (retirements missed while disconnected), then enqueue
    each active id not in `seenIDs` (and add it), set `lastRevision =
    revision`, `lastBootId = bootId`.
  - *Frame*: if `bootId != lastBootId` → treat as a gap: apply it and trigger
    a snapshot read. Else ignore when `revision <= lastRevision`; otherwise
    apply (`alert` → enqueue if unseen; `retired` → remove those ids) and set
    `lastRevision = revision`.
  This removes a banner whose retirement was missed, and a snapshot that
  raced a newer retirement can never resurrect it.
- **M17 — `usage:remind-at-reset`** — `args: [{key, sessionID}]`. The box uses
  the CURRENT snapshot's `resetsAt` for that key (not a client copy):
  `resetsAt == null` → `{ok:false, code:"no-reset", message:"This window has no reset time."}`;
  `resetsAt <= now` → `{ok:false, code:"expired", message:"This window has already reset — you can keep working."}`;
  missing `sessionID` → `{ok:false, code:"no-session", message:"Open a chat to set a reminder."}`.
  Else `schedule.createJob({fireAt: resetsAt + 60_000, kind:"notify", recurring:false, sessionID, prompt:"<Provider> <Window> has reset — you can keep working.", label:"Reminder: <Provider> <Window> reset"})`
  → `{ok:true, job, fireAt}` (the client prints "Reminder set for <time>." with
  its own clock formatting). This fixes the desktop bug where a toast left open
  past its reset scheduled a reminder a year out (`schedule.mjs:258-284`). The
  notify job itself is the existing schedule path (its push at reset already
  exists; no new notification type).

Tests `src/server/usageAlerts.test.mjs`: the moved `usageEscalation.test.ts`
cases (boundaries 89.9/90/99.9/100, fire-once while holding, re-arm after
drop, warn→limit, none→limit once, stale never fires but seeds baseline,
cold start at 100% stale then fresh 100% → no fire), first observation seeds
silently, ids stable, retirement on drop and on `expiresAt`, `revision`
increases by one per raise and per retirement and `list()` reports the current
value, `bootId` constant per instance, `remind` refuses
expired / no-reset / no-session and passes `fireAt = resetsAt + 60 000` to an
injected `createJob`, no `fireNotify` dependency exists.

### SF-M18 — usage window tone → `src/server/usageWindowView.mjs` + `usage.mjs`

```js
export function windowTone(pct)        // "under" (<70) | "warn" (70–89) | "danger" (90–99) | "over" (≥100) — usageTone, chatUtils.ts:3372-3377
export function decorateSnapshot(s)    // {...s, windows: s.windows.map(w => ({...w, tone: windowTone(w.pct)}))}
```

Applied in `usage.mjs`'s tick by decorating the SOURCE arrays once, before
anything reads them (`usage.mjs:619-648` today stores
`snapshots = results; seatSnapshots = seatResults` and then publishes
`{snapshots: results, seatSnapshots: seatResults}` — two separate uses):

```js
const decorated = results.map(decorateSnapshot);
const decoratedSeats = seatResults.map(decorateSnapshot);
snapshots = decorated;
seatSnapshots = decoratedSeats;
// content key, observe(...) and publish all use the decorated arrays:
observe?.(decorated, decoratedSeats);
publish?.({ kind: "usage.updated", payload: { snapshots: decorated, seatSnapshots: decoratedSeats } });
```

So `usage:list` (`listSnapshots`), `usage:list-seats` (`listSeatSnapshots`),
the `usage.updated` frame and the seat windows `accounts:list` passes through
from `listSeatSnapshots()` (`accountsViews.mjs:135` copies `snap.windows` by
reference; `accountsManager.mjs:204,796,1097`) all carry the SAME `tone`. A
stale window keeps its pct tone (the dial's "awaiting reset" rule is
unchanged). Tests: `src/server/usageWindowView.test.mjs` (69/70/89/90/99/100);
`usage.test.mjs` — with injected adapters, a first tick then `listSnapshots()`
/ `listSeatSnapshots()` have `tone`; a SECOND tick with changed pcts publishes
a `usage.updated` payload whose `snapshots[].windows[]` and
`seatSnapshots[].windows[]` all carry the new `tone` (asserted on the published
event, not only the decorator).

### Rejected (with evidence)

- **M18 `role:"session"|"weekly"`** — rejected. "Role" is the window's
  existing `kind` compared to a literal (`UsageMeters.swift:63-79`
  `first(whereKind:)`; desktop `seatBarWindows` `chatUtils.ts:3827-3835` and
  `usageDialState` use `windows[0]`/`kind`). `kind` already comes from the box;
  a `role` field would duplicate it without moving any rule. The window CHOICE
  for the desktop dial (`windows[0]`, worst-pct visibility) is a dial-display
  rule and stays with M3/WS11 follow-ups.

## Desktop migration (D23 — no parallel implementation)

The desktop switches to every SF channel/field above in this workstream.
Deleted functions must not come back (WS11 U5 adds the grep guard).

| SF | Desktop file | Change | Deleted from the desktop |
|---|---|---|---|
| M1 | `src/renderer/ModelsCard.tsx` | `useCachedResource("models", …)` now loads `window.api.modelsTable()`; rows/banner render the row fields; Default radio / Main / Sub / Enable deprecated / Edit call `modelsSetDefault` / `modelsSetMain` / `modelsSetSub` / `modelsOptIn` / `modelsSetOverride` and replace the cache with the reply `table`; `outcome != "applied"` (set-sub, opt-in, retry) shows the reply `message`, with a "Try again" button (`modelsRetrySubSync`) only when `retry` is true; `ok:false` shows `message` (under the context field when `field:"context"`). The `opencodeRestartNeeded` raise is removed (V2 hot-applies; the box answers the outcome). Refetch on `onModelsUpdated`. Unknown channel → "Update your box to use this." | `toggleMain`/`toggleSub`/`enableDeprecated`/`setDefault`/`saveOverride` bodies (`:244-380`), the client override diff in `EditModelModal.save` (`:79-90`), the `filtered` search over guide fields (now `searchText`), `describeModel`/`isDeprecated`/`formatModelContextSize` imports |
| M2 | `src/renderer/ModelPicker.tsx` | `picker`/`selectableModels` come from `useModelsPicker()` (new hook in `src/renderer/modelsPicker.ts`: loads `window.api.modelsPicker()`, refetches on `onModelsUpdated` / `onModelPrefsUpdated`, maps keys → `OpencodeModel` objects from the existing catalogue). `resolveFastToggle(selectableModels, …)` unchanged (M3 later). "Enable" → `modelsOptIn({keys:[key]})`. Unknown channel → raw list + footer "Update your box to hide models and manage deprecated ones." | `selectableModelList`, `mainPickerGroups` calls (`:137,148`) |
| M2 | `src/renderer/ChatPanel.tsx` | `delegateSelectable` = `useModelsPicker().delegateGroups` mapped to objects (`:2933-2936`). | `selectableModelGroups` call |
| M2 | `src/renderer/chatUtils.ts` + `chatUtils.test.ts` | Delete `hideFastSiblingGroups`, `selectableModelList`, `selectableModelGroups`, `mainPickerGroups`, `MainPickerGroups` (`:2356-2470`) and their describe blocks (cases moved to `modelsTable.test.mjs`). | as listed |
| M2 | `src/renderer/store.ts` | `optInModel` → `window.api.modelsOptIn({keys:[key]})`; drop the `deactivatedMainModels`/`optInModels` mirrors (`:393-397,859-860,1146-1147,1186-1193`) once no reader is left (ModelPicker/ChatPanel no longer read them). | the mirrors |
| M6 | `src/renderer/ModelLedgerCard.tsx` | Renders `data.view` (segments, caption, topModels, agents, empty texts); `supported:true` without `view` → "Update your box to use this." | `SEGMENTS` pct math, `wholePct`, the caption sum, `slice(0,6)` (`:28-34,105-218`) |
| M7 | `src/renderer/OptimizerCard.tsx` | Renders `summary.view` + `series.view` (sub-rows, gauges with `band`, pressure chips, stats, legend, empty texts, saving label, potential line, activity). Keeps `buildCumulativePath` + `chartAxisTicks` (M8) over `series.series[].tokensSent` and `view.rawValues`. | `formatSavedUsd`, `wholePct`, `ttlLabel`, `gaugeColor`, `noCounterfactualText`, `emptyWindowText`, `RANGE_LABEL` copy, the totals/saved/pacing derivations (`:55-581`) |
| M7 | `src/renderer/chatUtils.ts` + test | Delete `describePressure`, `describeActivityEntry`, `PressureTone`, `ActivityEntry`, `VERDICT_WORD`, `evidenceLine` (`:232-302`) and their tests (moved to `optimizer/view.test.mjs`). `formatTokens` lives in `src/shared/formatTokens.mjs`, created by WS02 in wave B (master D26 — one implementation used by the box views AND the renderer callers `Transcript.tsx`, `TaskCard.tsx`, `MessageRow.tsx`, `ChatPanel.tsx`, `OptimizerCard.tsx`, `UsageResumeModal.tsx`); `chatUtils.ts` re-exports it (WS02's edit). | as listed |
| M9/M10/M11 | `src/renderer/ModelsWeCouldntIdentify.tsx` | Loads `window.api.modelsUnidentified()`; renders `intro`/`footer`/`unavailableText`, row `label`/`help`/`actions`/`chips`; Confirm/chip → `modelsDeclare({key, catalogId})`; `IdentifyEditor` Save → `modelsDeclare({key, form})`, shows the reply `message`/field error and replaces the list with `list`. Typeahead keeps `useRoutingCatalog().entries` (M12). | the `rows` derivation (`:315-390`) incl. `resolveIdentity`/`autoEligibility` imports, `declare`'s config read-modify-write (`:290-313`), `IdentifyEditor.save` declaration build (`:157-174`), the `exact`-row `bits`/`help` composition (`:476-500`), `describeMissing` import |
| M10 | `src/shared/autoEligibility.mjs` (+ `.d.mts`) | Gains `export function describeMissing(missing)` (moved verbatim from `AccountsCard.tsx:170-187`, with `MISSING_PHRASE`). | — |
| M10 | `src/renderer/AccountsCard.tsx` | The existing import line (`:33`) becomes `import { autoEligibility, MISSING, describeMissing } from "../shared/autoEligibility.mjs";` and, where the local function stood, `export { describeMissing };` — the import gives the retained `helpText` (`:189-195`) its local binding; the re-export keeps `AccountsCard.test.ts:16` (and its `describeMissing` describe block, `:127-157`) compiling unchanged. `MISSING` stays imported (still used at `:88,169`). WS11 D4 later moves the custom-row text to the box. Verification: `npm run typecheck`, `AccountsCard.test.ts` (custom-row help + `describeMissing` cases) green. | local `describeMissing` + `MISSING_PHRASE` (`:169-187`) |
| M9 | `src/renderer/routingCatalog.ts` | **Unchanged in wave B.** The `matcher` stays: `AccountsCard.tsx` still uses it for custom-endpoint identity/eligibility (`:278-306`, reads at `:577,684,702`) until WS11 D4 (wave D) moves those derivations to the box. WS09 only stops using it in `ModelsWeCouldntIdentify.tsx` (which keeps `entries` for the typeahead). Final deletion of `matcher`/`createModelIndex` belongs to WS11 D4 after its last Accounts consumer migrates (Cross-spec dependencies). | nothing |
| M13 | `src/renderer/ModelPriceForm.tsx` + test | `UnpricedModelsPanel` groups from `optimizerPrices().unpricedByProvider`; Save sends the draft strings to `modelsSetPrice`; field/form errors and the success notice are the reply's `message`; a `warning` (written but opencode didn't reload) is shown as a muted line under the notice. Test file keeps only render/interaction cases (pure cases moved to `modelsPricing.test.mjs`). | `parseCostDraft`, `groupUnpriced`, `DECIMAL`, `parseField`, `SAVED_MESSAGE` (`:31-94`) |
| M14/M15 | `src/renderer/UsageResumeModal.tsx` + test | Loads `window.api.usageStoppedView()` on open, on `onUsageStoppedUpdated` and on the `resync` stream frame (`onStreamEvent`, `httpApi.ts:513-517,1158`) while open; every load carries a request seq and only the newest response is applied. On each applied view the selection is reconciled by the shared rule in F6 ("Selection reconciliation"); then the dry-run plan is invalidated and recomputed (debounced, seq-guarded). Renders the box rows/header/chips; the footer sums `cost.reReadTokens` over the selection; button title/enabled from the latest `usageStoppedApply({selected, dryRun:true})`; Apply awaits `usageStoppedApply({selected})` and shows `message`/`failed` (no more fire-and-forget). Fixes the zero-selection defect. Test: a second-device arm/removal (mock `onUsageStoppedUpdated` + changed view) while open updates the rows, drops the vanished id from the selection, keeps the user's other choices, and re-runs the dry run; a stale (older-seq) view response is ignored. | the `resumeCosts`/`selectionSummary`/`groupStoppedByWorkspace`/`isNewStopped`/snippet effect/`windowChipLabel`/header logic (`:31-128`) |
| M14 | `src/renderer/usageResume.ts` + `usageResume.test.ts` | Keep only `unarmedStoppedCount` and `shouldShowStoppedMarker` (row markers, Sidebar), and add `reconcileResumeSelection({selected, pristine, viewIds, armedIds})` — the view-state rule F6 pins (same as iOS `UsageResumeSelection.reconcile`), with tests. | `extractLastSnippet`, `resetAtFor`, `resumeCost`, `resumeCosts`, `selectionSummary`, `isNewStopped`, `groupStoppedByWorkspace` and their tests |
| M16/M17 | `src/renderer/App.tsx` | Replace the escalation effect (`:511-531` baseline seeding in `pullUsage`, `:794-917`) with: `usageAlerts()` on mount, on `apiGeneration` change and on every `resync` stream frame (`onStreamEvent`, the client's reconnect signal, `httpApi.ts:513-517`); `onUsageAlert` subscription; refs `seenAlertIds`, `lastBootId`, `lastRevision`, applied with the SF-M16 "Client reconciliation contract" (snapshot prunes toasts whose id is absent, older-revision snapshots dropped, older-revision frames ignored, bootId change resets); toasts from `alert.text` + `formatWindowReset` (M19); limit actions shown when `canRemind`/`canKeepGoing` and an active chat; "Remind me at reset" → `usageRemindAtReset({key, sessionID})` → "Reminder set for <formatResetAt(fireAt)>." / the reply `message`; "Keep going at reset" → resume modal. `retired` frames dismiss the matching sticky toast. | `usageLevelsRef`, `buildUsageLevels` seeding, `fireAtFor`, `scheduleAtReset`, `shouldFireUsageAlert` use |
| M16 | `src/renderer/usageEscalation.ts` + `usageEscalation.test.ts` | **Deleted** (cases moved to `usageAlerts.test.mjs`). | whole file |
| M16 | `src/renderer/usageAlertsQueue.ts` + `usageAlertsQueue.test.ts` (NEW, WS09) | Pure client bookkeeping of the SF-M16 reconciliation contract (`createAlertQueue()` → `applySnapshot(list)`, `applyFrame(frame)` → `"applied" \| "ignored-stale" \| "needs-snapshot"`, `dismiss(id)`, `visible()`), used by `App.tsx`. Tests: disconnect → missed retirement → reconnect prunes the toast; a retirement frame applied during an in-flight snapshot is not undone by the older snapshot; seen/dismissed ids never re-show; new `bootId` resets. | — |
| M18 | `src/renderer/UsageDial.tsx`, `src/renderer/chatUtils.ts` | Rings and popover rows use `window.tone` (`:601,627`); `usageDialState` returns `primary.tone ?? null` (null → neutral track + "Update your box to see usage colours." in the popover). | `usageTone` (`chatUtils.ts:3372-3377`) and its tests |
| all | `src/shared/api.ts`, `src/shared/types.ts` (`IPC`), `src/renderer/api/httpApi.ts`, `src/renderer/api/demoApi.ts` | Additive: the methods below + `onModelsUpdated` / `onUsageAlert` bus subscriptions (`on("models.updated")`, `on("usage.alert")`, like `onUsageUpdated` at `httpApi.ts:1329`), wire types next to `LedgerSummary`/`OptimizerSummary` (`types.ts:1953-2123`, `view?` optional), demo fixtures. | — |

New `window.api` methods (each `rpc(IPC.x, arg)`): `modelsTable()`,
`modelsPicker()`, `modelsSetDefault({key})`, `modelsSetMain({key,on})`,
`modelsSetSub({key,on})`, `modelsRetrySubSync()`, `modelsOptIn({keys})`,
`modelsSetOverride({key,fields})`, `modelsUnidentified()`,
`modelsDeclare({key, catalogId?|form?})`, `modelsSetPrice({providerID, modelID, draft})`,
`usageStoppedView()`, `usageStoppedApply({selected, dryRun?})`,
`usageAlerts()`, `usageRemindAtReset({key, sessionID})`.

Vitest updates: `ModelsCard.test.tsx`, `ModelLedgerCard.test.tsx`,
`OptimizerCard.test.tsx`, `ModelPriceForm.test.tsx`, `UsageResumeModal.test.tsx`,
`ModelPicker.test.tsx`, `ModelMenu.test.tsx` (if it stubs the picker helpers),
`UsageDial.*.test.tsx`, `chatUtils.test.ts`, `usageResume.test.ts` mock the new
methods via `installMockApi` and assert rendering of box fields, the write
calls, the unknown-channel "Update your box to use this." state, and (resume)
that unchecking the only armed row enables Update and that a second-device
change while open reconciles the selection. New
`src/renderer/modelsPicker.test.ts` (key → object mapping, unsupported
fallback) and `src/renderer/usageAlertsQueue.test.ts`. `AccountsCard.test.ts`
(custom-row help, `describeMissing`) stays green unchanged. `npm run typecheck` and `npm test` green.

---

## F1 — Models list

### Desktop behaviour today

`ModelsCard.tsx` (Settings → Models):

- Explainer line (`:399-404`): "**Default** = the model new & cleared sessions
  start on (exactly one; must be Main-available). **Main** = selectable as the
  chat main agent (off hides it from the composer's model picker). **Sub** =
  dispatchable as a subagent."
- Saved-default banner (`:408-429`): "DEFAULT  <model name>  <providerID>" or,
  with none, "No default set — opencode default (server decides)". Reflects the
  SAVED value only.
- Search field "Search models by name, provider, capability…" (`:435`):
  case-insensitive over name, providerID, id, description, guide blurb,
  guide "good for".
- One row per model from `opencode:models` (already override-applied
  server-side): name, providerID, context tag (`formatModelContextSize`:
  "200k", "1M", "1.5M"), "deprecated" tag, tier tag from the guide, description.
  Controls: **Default** radio (disabled unless Main on; title "Enable Main
  first"), **Main** checkbox, **Sub** checkbox, **Edit** pencil. Empty search →
  "No models found" (`:479`).
- `toggleMain` (`:244-283`): writes `deactivatedMainModels`; turning Main off
  on the current default ALSO writes `defaultModel: null` in the same
  `config:update` (invariant: a default is Main-available).
- `toggleSub` (`:285-312`): writes `deactivatedSubagents`, then
  `opencode:sync-subagents` with `{models, deactivated, optIn}`. (Desktop still
  raises a panel "restart opencode" banner; on V2 the agent write hot-applies —
  root `AGENTS.md` "Subagent management" — so iOS shows **no** restart prompt.)
- Deprecated model (`isDeprecated` = `status == "deprecated"`) not opted in:
  row dimmed, all controls disabled, link "Enable deprecated (also registers
  as a subagent)" (`:534`) → `enableDeprecated` (`:315-336`): appends to
  `optInModels`, then sync-subagents.
- `setDefault` (`:339-354`): `config:update {defaultModel:{providerID,modelID}}`.
- Edit dialog (`:52-159`): Name / Description / "Context size (tokens)",
  "Leave a field blank to keep the provider's default for it." Save writes only
  fields that differ into `modelOverrides["p/m"]`; an empty override deletes
  the key (`saveOverride`, `:357-380`, read-modify-write of the whole map).
- Desktop's main picker hides `deactivatedMainModels` and greys deprecated
  models not in `optInModels` (`chatUtils.ts:2396-2470`, `mainPickerGroups`).

### Wire contract (verified)

| Purpose | Channel | Args | Result |
|---|---|---|---|
| model list | `opencode:models` (`rpc.mjs:1444`) | `[]` | `OpencodeModel[]` (overrides applied; strict: rejects on unreadable catalogue) |
| config read | `config:get` (`rpc.mjs`, `MantaAPIClient.configGet` exists, `:757`) | `[]` | `AppConfig` — keys used: `defaultModel` `{providerID,modelID}\|null`, `deactivatedMainModels: string[]`, `deactivatedSubagents: string[]`, `optInModels: string[]`, `modelOverrides: {[key]: {name?,description?,context?}}` |
| config write | `config:update` (`rpc.mjs:848`; `MantaAPIClient.configUpdate` exists, `:752`) | `[patch]` (shallow merge; `null` clears) | merged `AppConfig` |
| subagent reconcile | `opencode:sync-subagents` (`rpc.mjs:1881` → `providers.syncSubagents`, `providers.mjs:803`) | `[{models:[{providerID,id,name,status?}], deactivated:[key], optIn:[key]}]` — reconcile reads only `providerID`, `id`, `status` (`subagentSync.mjs:103-113`) | `SubagentDef[]`; never throws (degrades to existing list, logged) |

Keys are always `"<providerID>/<modelID>"`. **Server-first:** the table
above is now the INPUT of `src/server/modelsTable.mjs` (SF-M1/M2); neither
client calls `config:update` / `opencode:sync-subagents` for this feature any
more — they call `models:table`, `models:picker` and the `models:set-*` /
`models:opt-in` writes, and refetch on the raw `models.updated` frame.

### iOS today

- `ChatModelCatalog.swift` (owned) loads models + `opencode:default-model` +
  config `defaultModel` once (`loadIfNeeded`, `:46`); no reload, no knowledge
  of `deactivatedMainModels` or config `optInModels`.
- `ModelPickerSheet.swift` (owned) renders `modelStore.models` through
  `ChatModel.catalogueGroups` (`ChatModel.swift:198`) and greys deprecated rows
  using **on-device** opt-ins (`DeprecatedModelOptIns`, UserDefaults) — so a
  model hidden from Main on desktop still appears on iOS, and a desktop opt-in
  is invisible on iOS. `ChatModel.contextSize` (`ChatModel.swift:268`) already
  formats context.
- There are THREE ways to select a model in the picker today, and each must
  apply the same policy:
  1. a catalogue row → `ModelCatalogueView.select` (`ModelPickerSheet.swift:318-322`),
     guarded only by the local opt-in set;
  2. a recent chip → `modelStore.apply(choice)` (`ModelPickerSheet.swift:217-229`),
     rendered straight from `modelStore.recents` with no filter at all;
  3. the fast toggle → `ChatModelStore.setFast` (`ChatModelStore.swift:259-267`)
     through `ChatModel.fastToggle(models:…)` (`ChatModel.swift:59-80`), which
     only excludes disabled/deprecated twins.
  "Server default" (`:230-238`) is always allowed.
- `ChatModelStore.optIn` (`ChatModelStore.swift:276-281`) is synchronous and
  writes only UserDefaults.

### iOS design (server-first: renders `models:table` / `models:picker`)

iOS keeps view state only; every rule above is the box's (SF-M1, SF-M2).

- `ModelsStore.swift` — `@MainActor final class ModelsStore: ObservableObject`:
  `phase` (`.loading / .loaded(ModelsTableWire) / .unsupported / .failed(String)`),
  `busyKey: String?`, `feedback: ModelsFeedback?` (`.saved(String)` auto-clears
  after 3 s; `.failed(String)` and `.partial(String)` stay until dismissed;
  `.partial` carries a "Try again" that calls `models:retry-sub-sync`). Load =
  `modelsTable()`; an unknown-channel error → `.unsupported`. Every action calls
  ONE write channel (`modelsSetDefault`, `modelsSetMain`, `modelsSetSub`,
  `modelsOptIn`, `modelsSetOverride`), takes `table` from the reply (no local
  recomputation), shows the reply's `message` (`ok:true`), its `message`
  (`ok:false`, inline under the field when `field` is set), and for
  `models:set-sub` / `models:opt-in` / `models:retry-sub-sync` with
  `outcome != "applied"` shows `.partial(message)` — with the "Try again"
  button only when the reply's `retry` is true (`not-applied`); a
  `saved-not-live` partial has no retry (the box says how to apply it).
  After any `ok:true` it calls `ChatModelCatalog.shared.reload()` (a reload
  failure never turns the save into a failure). It also refetches on the raw
  bus frame `models.updated` (via `MantaEventStore.addRawFrameHandler`) while the
  screen is open.
- `ModelsScreen.swift`: the screen from the overview. Rows render the row fields
  verbatim: `name`, `providerID`, `contextLabel` chip, `tier` chip (from the box
  — restores the tag D8 had deferred), "deprecated" chip when `deprecated`,
  checkmark when `isDefault`, "In picker" / "Subagent" glyphs from
  `isMain`/`isSub`, `description` as the secondary line, reduced opacity when
  `deprecatedLocked`. Default section = `defaultLine` or the desktop copy "No
  default set — opencode default (server decides)". Search = case-insensitive
  substring over `searchText` (client filtering, KEEP-CLIENT); no results →
  `ContentUnavailableView.search`. `.unsupported` → "Update your box to use this."
- `ModelsDetailSheet.swift` — `Form` driven by the row:
  - `deprecatedLocked` → callout "This model is deprecated." + "Enable deprecated
    model" (sub-caption "Also registers it as a subagent") → `models:opt-in
    {keys:[key]}`; nothing else rendered until enabled.
  - `Toggle("Show in model picker")` (`isMain`) → `models:set-main`. When turning
    it off and `isDefault`, first a confirmation "This is your default model.
    Hiding it also clears the default." [Hide and clear default] [Cancel] (the
    box clears it atomically).
  - `Toggle("Available as subagent")` (`isSub`) → `models:set-sub`.
  - "Make default" → `models:set-default`; disabled with `defaultHint` as the
    footer when `canMakeDefault` is false; reads "Default model ✓" when
    `isDefault`.
  - "Edit name, description, context" pushes `ModelsEditForm`, prefilled from
    `editable`; Save sends the three strings as typed to `models:set-override`;
    a `field:"context"` error shows under the context field. Footer "Leave a
    field blank to keep the provider's default for it."
  - While `busyKey == key` the changed control shows a `ProgressView`.
- **Picker** (owned edits `ChatModelCatalog.swift`, `ChatModelStore.swift` (D1),
  `ModelPickerSheet.swift`):
  - `ChatModelCatalog` adds `@Published private(set) var picker: ModelsPickerWire?`
    and `@Published private(set) var pickerUnsupported = false`, loaded with the
    model list in `loadIfNeeded()` / `reload()` (`models:picker`), refetched on
    the raw frames `models.updated` and `model-prefs.updated`, and the box
    lifecycle above. The round-2 plan to parse `deactivatedMainModels` /
    `optInModels` and `applyConfig(_:)` is **deleted**.
  - `ChatModelStore` reads `catalog.picker`: `func isSelectable(_ key: String) -> Bool`
    = `true` when `catalog.pickerUnsupported` (older box: nothing is derived
    client-side, so everything enabled is selectable), `false` while the picker
    has not loaded, else `picker.selectable.contains(key)`. `selectableModels` = `models.filter { isSelectable(key($0)) }`.
    All three selection paths go through it: catalogue `select(_:)` guard,
    `apply(_ choice:)` guard, and `setFast` / the sheet's `fast` computation
    (`ChatModel.fastToggle(models: selectableModels, …)` — M3 stays client but
    over the box's set). `effectiveOptIns`, the union with
    `DeprecatedModelOptIns`, and the round-2 `ModelsPicker` helpers are
    **deleted**.
  - `ModelCatalogueView.groups`: groups come from `picker.groups` (provider +
    keys → model objects looked up in `modelStore.models`; a key with no object
    is skipped), then the existing capability filter + query
    (`ChatModel.matches`, `ChatModel.filteredGroups` — search stays client).
    A row is disabled iff its key is in `picker.locked`. With
    `pickerUnsupported`: `ChatModel.catalogueGroups(models)` raw, nothing
    locked, footer "Update your box to hide models and manage deprecated ones."
  - Recents chips render `picker.recents` (already filtered by the box), label
    via the existing `ModelRecents.label(for:models:)` (presentational).
  - `ChatModelStore.optIn(_:) async` → `models:opt-in {keys:[key]}` with the
    round-2 pending spinner and visible error + "Try again"; on `ok:true`
    `catalog.reload()`. No UserDefaults write.
  - **One-time copy** of on-device opt-ins (SF-M2): run by `ChatModelCatalog`
    after its first successful `models:picker` read for a binding.
  - Received mount **M-03-5** (`agentsLoadError`, `retryAgents()`) and
    **M-08-1** (provider-change observer → `reload()`) are unchanged.

### Pure logic

Only presentational helpers remain on iOS: none new for F1 (search is a
substring check inline; labels come from the box). The round-2
`ModelsTable`, `ModelsPicker`, `ModelsConfig` types are **deleted** from the
plan; their rules are pinned by `src/server/modelsTable.test.mjs` instead.

### Tests

- `MantaUITests/ModelsTests.swift` (Foundation-only): decode `models:table`,
  `models:picker`, every write reply (`ok:true` with `table`/`outcome`,
  `ok:false` with/without `field`), `{supported:false}`; `ModelsCapability.isUnsupported`
  for `MantaError.server("unknown rpc channel: models:table")` → true and for
  another server error → false; `DeprecatedOptInCopy.shouldCopy(local:, alreadyCopied:)`
  (empty → false; non-empty & not copied → true; copied → false).
- `MantaUITests/ModelsStoreTests.swift` (Mac, URLProtocol stub): `set-sub`
  reply `outcome:"not-applied", retry:true` → `.partial` with Try again calling
  `models:retry-sub-sync`; `outcome:"saved-not-live", retry:false` →
  `.partial` without a retry button; `opt-in` reply `not-applied` → same
  partial; write `ok:false, field:"context"` → inline error, no
  table change; unknown channel → `.unsupported`; a `models.updated` frame
  refetches the table once; picker: a key absent from `selectable` cannot be
  applied via recents, catalogue or fast toggle; a key in `locked` renders
  disabled and Enable calls `models:opt-in`; one-time copy sends the local set
  once, then clears it, and is not re-sent after a relaunch; box binding and
  M-08-1 / M-03-5 tests from round 2 stay.

### Acceptance criteria

- [ ] Settings → Models lists every model `opencode:models` returns, with the
      saved default shown at the top.
- [ ] Turning "Show in model picker" off removes the model from the chat's
      model picker (cockpit and All models) after returning to a chat; on the
      current default it asks first and clears the default in the same save.
- [ ] "Available as subagent" off removes the model's agent block on the box
      (verified with `config:get`/opencode.jsonc); no restart prompt appears.
- [ ] A deprecated model shows only "Enable deprecated model"; enabling it
      unlocks the row and the picker row, on iOS and desktop alike.
- [ ] A model hidden from the picker cannot be chosen through ANY path: it is
      absent from All models, its recent chip is not shown, and it is never the
      fast-toggle target. The active model stays displayed but is not offered.
- [ ] A deprecated model opted in on desktop is selectable on iOS (row enabled
      and the tap selects it); opting in on iOS shows a spinner, then either
      enables the model on both clients or shows "Couldn't enable … " with Try
      again and leaves it disabled.
- [ ] Edit saves only changed fields; clearing every field removes the override.
- [ ] Every action ends in exactly one of: saved; failed with nothing changed;
      or "Preference saved, but the subagent list on the box wasn't updated"
      with Try again. "Nothing was changed" never appears after the preference
      was written.
- [ ] After switching boxes, the picker and Models screen show only the new
      box's models.

---

## F2 — Spend ledger ("Where your spend goes")

### Desktop behaviour today

`ModelLedgerCard.tsx`, fetched once on mount, no polling (`:51-72`):

- loading → "Reading your history…" (`:84`)
- fetch rejected → the card is hidden entirely (`:89-91`)
- `{supported:false}` → "Spend history needs a newer box runtime." (`:98`)
- loaded → (1) the cache-split legend + stacked bar in order cache read
  (danger), cache write (warn), output (accent), fresh input (neutral), each
  "NN%", in-bar % only when ≥ 4%; caption "Cache is NN% of your bill —
  carrying the conversation, not generating answers." (`:140`); (2) by-model
  table, top 6: Model · Turns · $/turn · tok/s · Total ("No model spend
  recorded."); (3) by-agent table: Agent (`main` when null, "subagent" chip
  when `isChild`) · Turns · $/turn · Total ("No agent spend recorded.").
- Money `$0.00`; turns with thousands separators; null tok/s → "—".

### Wire contract

`ledger:summary` (`rpc.mjs:2024` → `ledgerSummary(opts ?? {})`), args `[]`.
Result `LedgerSummary` (`src/shared/types.ts:1953-1969`):
`{supported, totals{turns,cost,input,output,cacheRead,cacheWrite},
cacheShare{output,cacheRead,cacheWrite,input} (fractions ~sum 1),
byModel[{key,turns,cost,costPerTurn,outPerTurn,tokensPerSec,p50Ms|null,p90Ms|null}],
byAgent[{agent|null,isChild,turns,cost,costPerTurn}], byProject[...]}`.
On an unsupported box only `{supported:false}` arrives — the Swift type must
make every other field optional/defaulted. **Server-first:** the result gains
an additive `view` block (SF-M6); clients render only `view` (+ money
formatting).

### iOS design (server-first: renders `ledger:summary.view`)

`ModelsLedgerScreen.swift` (pushed from "Insights"), `List`:
- Section "Bill split": a 24pt `HStack` of `view.segments` in order, each
  `Rectangle` at `frame(width: geo * pct / 100)`, colours by `kind`
  (`danger` cacheRead, `warn` cacheWrite, `accent` output, neutral input),
  in-bar "NN%" only when `inline`; legend rows (swatch · `label` · "NN%");
  footer = `view.caption`.
- Section "By model": `view.topModels` — `key` (monospaced caption), trailing
  total `$x.xx`, secondary "N turns · $x/turn · N tok/s" ("—" for null tok/s).
  Empty → `view.emptyModels`.
- Section "By agent": `view.agents` — `label`, "subagent" chip when `isChild`.
  Empty → `view.emptyAgents`.
- States: loading → `ProgressView("Reading your history…")`; `supported:false`
  → "Spend history needs a newer box runtime."; `supported:true` without
  `view` → "Update your box to use this."; fetch error → "Couldn't load spend
  history — <reason>" + Retry. Pull-to-refresh refetches.
- Money / integer formatting is client (`ModelsFormat.money`, `.count`) —
  presentational only.

### Pure logic

`ModelsFormat.money(Double) -> String` ("$1.20") and `.count(Int)` (grouping
separator) in `ModelsWire.swift`. The round-2 `ModelsInsights` type is
**deleted** (its rules are `src/server/ledgerView.test.mjs`).

### Tests — `MantaUITests/ModelsTests.swift` (ledger section)

Decode `ledger:summary` with `view`, without `view` (→ unsupported), and
`{supported:false}`; `ModelsFormat.money` rounding.

### Acceptance criteria

- [ ] The screen shows the split bar, caption, by-model (≤ 6) and by-agent
      tables with the same numbers the desktop card shows for the same box.
- [ ] Unsupported box → the one sentence, no zeros. Network failure → error +
      Retry.

---

## F3 — Optimizer dashboard (read-only)

### Desktop behaviour today

`OptimizerCard.tsx`, header "Token optimizer". Two reads: `optimizer:summary`
once on mount (`:119-131`) and `optimizer:series(range)` per selected range
(`:133-146`, default "24h"). States as F2 (loading / hidden on error /
"Spend history needs a newer box runtime.").

1. **Switch block** (`:278-333`): title "Manta optimized token usage", body
   "Manta trims, paces and compacts your conversations to make a plan last
   longer. It never changes which model you picked by hand. Everything it
   changes is listed below.", state "On"/"Off" from `optimizerEnabled` (no
   toggle here). Sub-rows only when backed by data:
   - Trimming (when trimmed% > 0): "Old tool output is replaced by a one-line
     placeholder after a few newer tool uses. The last 40k tokens are never
     touched." · "−N% sent".
   - Pacing (when any window has `tokensPerPct`): "Cheaper models while a plan
     window is ahead of pace. Build and plan work keeps its quality floor." ·
     "eco · <worst window's pressure text>".
   - Compacting (when `compaction.total > 0`): "Long idle conversations are
     summarized in the background, before you come back to them." · "B of T in
     background".
   - Prompt cache (always): "Reads billed at 0.1×; TTL <5m|1h|Nm> measured." ·
     "NN% hit" where hit = cacheRead / (cacheRead + cacheWrite + input).
2. **Subscription windows** (`:335-380`, when `windows` non-empty): caption
   "Forecast from your recent usage. Tick = forecast at reset. Pressure chip =
   how far ahead of pace this window is right now." Per window: title
   `planLabel — windowLabel`, "resets <formatResetAt>", a gauge filled to `pct`
   (colour <60 ok, 60–84 warn, ≥85 danger), a forecast tick at `forecastPct`
   (warn when ≥85), "NN% used", "forecast NN%" or "gathering history…", and the
   pressure chip (`describePressure`, `chatUtils.ts:246`: "no pressure signal
   yet" / "on pace" / "+N pts ahead of pace").
3. **Consumption chart** (`:382-533`): heading "Token consumption — with &
   without optimization", range chips 24h / 7d / 30d. Cumulative "sent" line
   (accent, filled) and, only when actual trims > 0, a dashed "raw
   counterfactual" line (sent + actual trimmed). Saving label "−<tokens> ·
   ≈ $x est." (warn colour if negative). Legend; when no counterfactual:
   "Hourly comparison starts collecting today." (24h) / "No trimming recorded
   in this window." Empty window: "No model activity in the last <range>."
   "Potential, not applied: −<tokens> · ≈ $x est." when potential > 0.
   Stats: Sent (<range>) / raw; Saved (est.) — "not priced" + "these endpoints
   declare no price" | negative "−$x" + "re-cache cost exceeded savings" |
   "≈ $x" + "≈$y potential[ · NN% priced]"; Cache hit + "TTL <x> <confidence> ·
   30d"; Cost / turn + "<range> average"; Sessions (`bySession.length`) +
   "B of T in background · 30d" or "30d". While a new range loads the old
   chart stays at 60% opacity; series unsupported/failed → only the chart block
   says "Spend history needs a newer box runtime."
4. **Metered endpoints** (when non-empty): caption "Pay-per-token endpoints
   have no window and never reset, so there is nothing to fill — only a role
   and the price at which they beat the subscription." Rows name · role · price.
5. **Activity** (`:553-581`): caption "Every parameter change the optimizer
   made on its own, with the evidence it used. Rolled-back entries stay — that
   is the point." Rows: "HH:MM" + headline "<Kept|Rolled back|Applied> —
   <subject>" + evidence line ("Turns 62 · Hit 74.1%") (`describeActivityEntry`,
   `chatUtils.ts:290`); rolled-back rows struck/dimmed. Empty: "Nothing changed
   yet. Manta needs a few days of your usage before it starts tuning anything."

### Wire contract

| Channel | Args | Result |
|---|---|---|
| `optimizer:summary` (`rpc.mjs:2030`) | `[]` | `OptimizerSummary` (`types.ts:1991-2063`) or `{supported:false}`; server-memoized 60 s |
| `optimizer:series` (`rpc.mjs:2037`) | `[{range:"24h"\|"7d"\|"30d"}]` (unknown → 24h) | `OptimizerSeries` (`types.ts:2082-2123`): `{supported, range, bucket:"hour"\|"day", startMs, endMs, series[{t, tokensSent, actualTrimmedTokens, potentialTrimmedTokens, maskedTokens}], counterfactualAvailable, totals{turns,cost,tokensSent,actualTrimmedTokens,potentialTrimmedTokens,maskedTokens,rewarmTokens}, saved{usd\|null, potentialUsd\|null, pricedShare, basis:"measured"\|"partial"\|"unpriced"}}` |

**Server-first:** both results gain an additive `view` block (SF-M7) — the
On/Off state comes from `summary.view.switch` (the box reads `optimizerEnabled`),
so clients no longer read `config:get` for it. Clients decode only `view` plus
the raw `series[].t` / `tokensSent` they need for chart geometry (M8).

### iOS design (server-first: renders the `view` blocks)

`OptimizerScreen.swift` (pushed from "Insights"), `List` sections in the
desktop order, every string from `optimizer:summary.view` /
`optimizer:series.view`:
- Switch block → Section header "Manta optimized token usage" with trailing
  `view.switch.label` capsule; `view.switch.body`; sub-rows = `series.view.trimming`
  (when non-nil) followed by `summary.view.subrows`, each a `LabeledContent`
  (`name`, `text`, trailing `chip`). Footer: "Change this in Settings → Models."
  (no second toggle).
- Windows → `summary.view.windowsCaption` + one row per `summary.view.windows`:
  custom `OptimizerGauge` (capsule track, fill to `pct`, colour from `band`,
  2pt tick at `forecastPct` tinted warn when `forecastWarn`), meta line
  `pctLabel` · `forecastLabel`, "resets <UsageMeters.resetAt(resetsAt)>" (M19
  client formatting), pressure chip (`pressure.text`, tint by `tone`).
- Chart → `series.view.heading`; `Picker(.segmented)` 24h / 7d / 30d (view
  state) refetches `optimizer:series`; while loading the previous chart stays
  at 60% opacity. Swift Charts: cumulative "sent" from the raw
  `series.series[].tokensSent`, dashed cumulative raw from `view.rawValues`
  only when `view.hasCounterfactual`; x = `Date(t)`, axis ticks from
  `OptimizerChart.axisTicks` (M8 KEEP-CLIENT); `view.savingLabel` drawn in the
  top-right in its tone; legend from `view.legend`; `view.potentialLine` below;
  `view.noActivity` → `view.emptyText` instead of the chart.
- Stats → 2-column `Grid` of `series.view.stats` then `summary.view.stats`
  (label, value, detail, tint by `tone`).
- Metered → `summary.view.meteredCaption` + rows when non-empty.
- Activity → `summary.view.activityCaption`; rows `formatClock(ts)` +
  `headline` + `detail`; `rolledBack` → strikethrough headline, `tx3`; empty →
  `summary.view.activityEmpty`.
- States as F2 (`view` absent → "Update your box to use this."; series
  unsupported/failed degrades only the chart section).

### Pure logic — `OptimizerChart` (in `OptimizerLogic.swift`, Foundation-only)

Chart geometry only (M8 KEEP-CLIENT): `cumulative(_ values: [Double]) -> [Double]`
(running sum, non-finite → 0) and `axisTicks(_ ts: [Double], bucket: String) ->
[(index: Int, label: String)]` (mirror of `chartAxisTicks`: ≤ budget → one per
point, always first + last, budget 5 hour / 4 day, "14:00" / "Aug 3"), plus
`formatClock(_ ms: Double) -> String` ("HH:MM"). The round-2 `OptimizerLogic`
rules (bands, ttl labels, pressure, activity text, totals, saved stat, empty
texts) are **deleted** — `src/server/optimizer/view.test.mjs` pins them.

### Tests — `MantaUITests/OptimizerTests.swift`

`cumulative` with NaN; `axisTicks` budgets and first/last; `formatClock`;
decode both `view` blocks from fixture JSON copied from
`src/server/optimizer/view.test.mjs` outputs, plus no-`view` (→ unsupported)
and `{supported:false}`.

### Acceptance criteria

- [ ] Settings → Models → Token optimizer shows the switch state, sub-rows
      only when their data exists, window gauges with forecast tick + pressure
      chip, the chart with a working 24h/7d/30d selector, the five stats,
      metered rows and the activity log.
- [ ] Nothing on the screen edits a setting.
- [ ] No fabricated zeros: unsupported → one sentence; unpriced → "not priced".

---

## F4 — "Models we couldn't identify"

### Desktop behaviour today

`ModelsWeCouldntIdentify.tsx`. The renderer loads `opencode:models`,
`config.modelRouting.declaredModels` and the routing catalogue
(`opencode:model-catalog` → `createModelIndex`, `routingCatalog.ts`), then for
each model runs `resolveIdentity` (`shared/modelIdentity.mjs:136`) and
`autoEligibility` (`shared/autoEligibility.mjs`); an endpoint is listed only
when NOT eligible (`:328-390`). Rows:

- **exact** (certain): help "Matched automatically → <name> · <tier> · <ctx>
  — Auto still needs: <missing phrases>"; action **Change** (opens editor).
  **probable**: "We think this is <name> — <evidence>[ — Auto still needs: …]",
  actions **Confirm** (declares `{catalogId}`) and **Change**.
- **ambiguous**: "N models share this name — which one is it?[ — evidence]";
  ≤ 4 candidates → chips (pick = declare `{catalogId}`); > 4 → the editor.
- **none**: "No match — tell us which model this is" + editor.
- Editor (`IdentifyEditor`, `:126-260`): catalogue typeahead ("Search the
  catalogue…", top 30 unfiltered, 50 filtered over id/name/family), selected
  model's description, "Costs here" Free | Custom (in / out per 1M; NO
  default — Save disabled until Free or ≥ 1 finite rate), "Caching" None |
  Custom (reads / writes checkboxes, default both on). Save →
  `{catalogId, price: "free"|{input,output}, caches: false|{read,write}}`.
- Declaring (`:290-313`): read config, write
  `modelRouting: {...routing, declaredModels: {...declared, [key]: decl}}`
  (routing defaults to `{preset:"balanced"}`), refresh; error shown as an alert
  line.
- Intro: "Served under a name the catalogue doesn't recognise, so Manta can't
  tell what they are or what they're good at. They stay usable by hand.
  Identify one and Auto can start choosing it." Footer: "Can't say? Leave it.
  The model stays available to pick by hand — Auto just won't choose something
  it can't describe."
- Catalogue unavailable → intro + "Manta couldn't load the model catalogue, so
  it can't tell what any of these endpoints are. Auto won't choose a model it
  can't describe. This usually clears on its own — reopen Settings in a
  minute." No rows and catalogue OK → block hidden.
- Missing phrases (`AccountsCard.tsx:170-187`, `describeMissing`):
  identity→"which model", price→"what it costs", caching→"whether it caches",
  quality→"how it compares"; Oxford-comma join.

### Wire contract — reuse + ONE new channel

The identity resolver + eligibility gate + catalogue matcher are ~750 lines of
shared JS (`modelIdentity.mjs`, `autoEligibility.mjs`, `modelCatalog.mjs`).
Porting them to Swift would fork the routing gate the server itself uses
("what the UI says is missing is exactly what the router is waiting for",
`autoEligibility.mjs:9-11`). So the ROW DERIVATION moves server-side, running
the very same shared modules; the writes stay on the existing channels.

**NEW — `models:unidentified`** (module `src/server/modelsUnidentified.mjs`,
registered in `rpc.mjs` next to `opencode:model-catalog`; auth = the existing
bearer gate on `/rpc`).

- Args: `[]`.
- Implementation: `cfg = local.configGet()`; `models = oc.listModels(cfg.modelOverrides ?? {}, {strict:true})`;
  `declared = cfg.modelRouting?.declaredModels ?? {}`; catalogue from
  `src/server/modelCatalog.mjs` (`lookupModel`, `matchModel`, `allModels`, the
  same exports `ctoSessions.mjs:14` uses). If `allModels().length === 0` →
  `{supported:false, rows:[]}`. Else for each model call the pure
  `buildUnidentifiedRows({models, declared, catalog})` which mirrors
  `ModelsWeCouldntIdentify.tsx:328-390` exactly (same `resolveIdentity`,
  `autoEligibility` with `providerClass:"supported"`, same skip-if-eligible).
- Result:
  ```ts
  { supported: true,
    rows: Array<{
      key: string;                 // "providerID/modelID"
      providerID: string; modelID: string;
      state: "exact" | "ambiguous" | "none";
      confidence?: "certain" | "probable";
      evidence?: string;
      catalogId: string | null;    // exact only
      match?: { id: string; name: string; tier?: "fast"|"balanced"|"deep"; context?: number; description?: string }; // exact only (describeModel(providerID, catalogId)?.tier)
      candidates: Array<{ id: string; name: string }>;   // ambiguous only, in matcher order
      missing: Array<"identity"|"price"|"caching"|"quality">;
    }> }
  ```
- Errors: `opencode:models` failure propagates as the RPC error (the client
  shows it); the channel never writes anything.
- **Superseded by D24 (SF-M9):** the desktop switches to this channel in the
  same change; there is no parity fixture. Rows also carry `help`, `label`,
  `actions`, `chips` and the envelope `intro`/`footer`/`unavailableText`
  (SF-M10).

Reused channels:
- `opencode:model-catalog` (`rpc.mjs:1818`): `[]` →
  `{supported, size, entries: ModelCatalogEntry[]}` (`id,name,family,description,limit{context,output}`, …) — for the editor's typeahead.
- Writes go through the NEW `models:declare` (SF-M11), which does the
  `modelRouting` read-modify-write on the box; clients no longer call
  `config:get`/`config:update` for it.

### iOS design (server-first: renders `models:unidentified`, writes `models:declare`)

- `ModelsUnidentifiedSection` (in `ModelsUnidentifiedView.swift`) at the top of
  `ModelsScreen`; loads `models:unidentified` with the screen and on
  `models.updated`. Hidden when `supported && rows.isEmpty`; `!supported` →
  `intro` + `unavailableText`; unknown channel → "Update your box to use this.";
  other error → "Couldn't check your models — <reason>" + Retry. Section header
  "Models we couldn't identify", first row `intro`, last row `footer` (box copy).
- Row: title `label` (monospaced), help line `help` (box copy). Actions from
  `actions`: "confirm" → `models:declare {key, catalogId}` with the row's
  `catalogId`; "change"/"identify" → push `ModelsIdentifyForm`; "pick" with
  `chips` → `Menu("Which one?")` over `candidates` (pick = `models:declare
  {key, catalogId: candidate.id}`); "pick" without `chips` → the form.
- `ModelsIdentifyForm`: `.searchable` list over the lazy-loaded
  `opencode:model-catalog` entries (client typeahead, M12 KEEP-CLIENT:
  top 30 when empty, else id/name/family substring, cap 50), selected entry +
  description; "Costs here" segmented [Free, Custom] with no initial selection,
  two decimal fields for Custom; "Caching" [None, Custom] default None, toggles
  Reads/Writes (default on). Save enabled iff a model is selected and Free is
  chosen or ≥ 1 rate is a number (M12 KEEP-CLIENT gating). Save sends the
  form as typed (`models:declare {key, form:{…}}`) — the box builds and
  validates the declaration; a `field` error shows under that field. Opened from
  a `still-needs` row it is pre-selected to the row's `catalogId`.
- Result handling is the reply verbatim: show `message`; replace the section
  with `list`; when `outcome == "still-needs"` keep the row (it is in `list`)
  and offer its editor; `resolved` → the row is gone from `list`;
  `catalogue-unavailable` → the `unavailableText` state. `ok:false` → inline
  `message`, nothing changed. A thrown error after which the write may have
  landed → "Couldn't confirm the save — pull to refresh."

### Pure logic

`ModelsIdentifySearch.filter(entries:query:)` and
`ModelsIdentifySearch.canSave(selected:priceMode:costIn:costOut:)` in
`ModelsIdentifyLogic.swift` (M12 KEEP-CLIENT). `missingPhrase`, `helpText`,
`declaration`, `mergedRouting`, `declareOutcome` are **deleted** from the plan
(server: SF-M10/M11).

### Tests

- `MantaUITests/ModelsTests.swift`: `filter` (empty → 30, substring, cap 50);
  `canSave` matrix (no model / no price / Free / Custom one rate / Custom none);
  decode `models:unidentified` (rows with `help`/`actions`/`chips`,
  `supported:false` with `unavailableText`) and each `models:declare` outcome.
- Server: `src/server/modelsUnidentified.test.mjs` per SF-M9/M10/M11 (the
  round-2 desktop-parity fixture test is withdrawn — the desktop consumes the
  channel).

### Acceptance criteria

- [ ] An endpoint the router can't describe appears with the same case and
      help text as on desktop; a fully described one does not.
- [ ] Identity-only (Confirm / candidate pick on an endpoint with no price or
      caching facts): the declaration is written, desktop shows it, and the row
      STAYS with "Identity saved — Auto still needs: …" and an editor
      pre-selected to that model.
- [ ] Complete declaration (editor Save with a price answer, or identity for an
      endpoint that already reports price + caching): the row disappears with
      "Saved — Auto can now describe …".
- [ ] Save is disabled until a model and a price answer are chosen.
- [ ] `npm test` includes the new server test and stays green.

---

## F5 — Per-model price form (unpriced models)

### Desktop behaviour today

`UnpricedModelsPanel` in `ModelPriceForm.tsx`, mounted in the desktop
Accounts card (`AccountsCard.tsx:1007`). Reads `optimizer:prices`; hidden when
unsupported or on read failure. Groups `unpriced` keys by provider (split at
the FIRST slash, `groupUnpriced`, `:78-91`), each group collapsible:
"▸ <Provider name> No prices — the optimizer won't trim these models (N
models)". Each model: "Set prices" → form "Dollars per million tokens. Input,
output and cache read are required. Leave cache write empty if the provider
charges nothing extra to cache." Fields Input / Output / Cache read / Cache
write (optional). Validation (`parseCostDraft`, `:55-69`): a non-negative
decimal (`^(\d+\.?\d*|\.\d+)$`), messages "<Label> is required." / "<Label>
must be a number of dollars per million tokens (0 or more)." Save "Saving…" →
`opencode:set-model-cost`; failure "Couldn't save — <why>. Nothing was
changed; try again."; success → refetch prices, panel-level notice
"<modelID> · Saved — the optimizer will use these prices" (+ " (couldn't
refresh the list — reopen Settings to update it)" when the refetch failed).

### Wire contract

- `optimizer:prices` (`rpc.mjs:2045`), `[]` →
  `{fetchedAt, models:{[key]:{input,cacheRead,cacheWrite,cacheWrite1h?,tiers?,source}}, unpriced: string[]}`
  (or a body without `unpriced` on older boxes → hide).
- `opencode:set-model-cost` (`rpc.mjs:2006` → `providers.setModelCost`,
  `providers.mjs:760`), `[{providerID, modelID, cost:{input, output, cache_read?, cache_write?}}]`
  → `{ok:true} | {ok:false, error}` (validates ids and rates; invalidates the
  prices memo on success). Edit is a config edit + live reload — no restart.

### iOS design (server-first: `unpricedByProvider` + `models:set-price`)

`ModelsPriceSection` (`ModelsPriceForm.swift`) in `ModelsScreen` (Settings →
Models; M-09-6 adds the Accounts link). Section header "No prices", footer "The
optimizer won't trim a model it can't price." One `DisclosureGroup` per
`optimizer:prices.unpricedByProvider` entry ("<Provider> · N models", provider
name via `UsageMeters.providerLabel`, falling back to the id); each model row →
"Set prices" pushes `ModelsPriceEditor` (`Form`, four `.decimalPad` fields with
the desktop labels/placeholders "e.g. 3", "e.g. 15", "e.g. 0.3", "e.g. 3.75",
footer = desktop help text, toolbar Save → spinner "Saving…"). Save sends the
four strings AS TYPED to `models:set-price`; `ok:false` with `field` → the
message under that field; `ok:false` without → the message under the form;
`ok:true` → pop the editor, re-render the section from the reply's
`unpricedByProvider` (a `warning`, when present, is shown as a muted second
line under the confirmation), and keep a section-level confirmation row ("<modelID> ·
<message>") until the screen is left. Section hidden when the read fails or
the list is empty and no notices exist; `optimizer:prices` without
`unpricedByProvider` → "Update your box to use this." (and the section is
otherwise hidden).

### Pure logic

None — validation and grouping are the box's (SF-M13). The round-2
`ModelsPricing` type and `ModelsPriceLogic.swift` are **deleted** from the plan.

### Tests

`ModelsTests.swift`: decode `optimizer:prices` with/without
`unpricedByProvider`, and `models:set-price` replies (`ok:true` with groups,
`ok:false` with/without `field`). The moved validation cases live in
`src/server/modelsPricing.test.mjs`.

### Acceptance criteria

- [ ] Unpriced models appear grouped by provider; saving valid prices removes
      the model from the list and shows the confirmation; the same model shows
      priced on desktop.
- [ ] Invalid input is rejected by the box with the desktop sentence under the
      right field, and nothing is written.

---

## F6 — Resume after limit reset

### Desktop behaviour today

- Entry points: sidebar pill with the count of stopped-and-not-yet-armed
  conversations (`Sidebar.tsx:701-712`, title "N conversation(s) stopped by a
  provider limit") and the limit toast's "Keep going at reset" (F7).
- `UsageResumeModal.tsx`: title "Resume after limit reset"; header
  (`:124-128`): with any armed → "<A> armed · <N> stopped since you last
  looked."; else "<N> conversation(s) was/were stopped by a provider limit.
  Pick which ones should carry on by themselves when quota returns." Toolbar
  "Check all" / "Uncheck all" + "<s> of <t> selected". Groups by workspace
  (`groupStoppedByWorkspace`, most recent first). Row: checkbox, name
  (`nameFor(conversation)` = sidebar window name, fallback the id), "armed"
  chip, "new" chip (`isNewStopped`: stoppedAt > lastLooked or never looked),
  last-activity snippet (`opencode:messages` limit 5 → `extractLastSnippet`,
  90 chars + "…"), provider · model chip, window chip "<label> · <resetAt> ·
  in <distance>" (or just the label / "Limit"), cost chip "cache still warm ·
  no extra cost" or "≈ <tokens> re-read" (`resumeCost`: warm iff reset within
  the cache TTL — 5 min or 1 h from config `cacheTtl`). Warn callout when any
  selected row is cold (`:212-216`). Footer "<s> selected · ≈ <tokens> re-read"
  or " · no extra cost"; buttons Cancel/Close and "Resume <s> at reset" /
  "Update" (disabled at 0 selected, `:229-230`). Default selection on open =
  already armed rows. **Desktop defect (report only, D10):** that zero-selection
  guard makes the disarm branch of Apply unreachable when the user unchecks
  every armed row — e.g. the single-row case — so the last armed conversation
  can never be un-armed from the modal. iOS does not copy the guard (see design).
- Apply (`:97-109`): for each record, selected & not armed → arm; armed & not
  selected → disarm (which REMOVES the row). Close always stamps last-looked.
  Empty: "No conversations are stopped by a provider limit right now."
- The record is box-owned; `usage-stopped.updated` triggers a refetch
  (`App.tsx:760-770`).

### Wire contract

| Source | Owner | Used for |
|---|---|---|
| `usage-stopped:view` (new, SF-M14) | WS09 server module | everything the sheet shows |
| `usage-stopped:apply` (new, SF-M15) | WS09 server module | `dryRun` for the button state, then the real apply |
| `usage-stopped:stamp-last-looked` (existing, `stoppedStore.mjs:274`) | box | on dismiss |
| `SessionListStore.unarmedStoppedCount: Int` (D16) | WS04 | the session-list capsule (M-09-2) only |
| `SessionListStore.refreshStopped() async` (D16) | WS04 | after a successful apply / stamp, so row markers update even if the bus frame is missed |
| raw bus frame `usage-stopped.updated` | box | the open sheet refetches `usage-stopped:view` |

The round-2 plan to map `SessionListStore.stoppedRecords` /
`stoppedLastLooked` into a client `UsageStoppedEntry` is **deleted**: the
sheet no longer reads WS04's records at all (WS04's store still drives its
row markers and the capsule count — D16 unchanged for those).

### iOS design (server-first)

- Presentation flag on `UsageAlertsStore.shared` (F7): `resumeSheetPresented`,
  `presentResume()`.
- `UsageResumeSheet.swift` — `struct UsageResumeSheet: View` with
  `@ObservedObject var sessions: SessionListStore` (only for
  `refreshStopped()`) and `@ObservedObject var usage: UsageAlertsStore`;
  presented ONCE at app root (M-09-3). It owns a
  `@StateObject UsageResumeModel` (`view: UsageResumeViewWire?`,
  `selected: Set<String>`, `pristine: Bool` (true until the user toggles
  anything), `plan: UsageResumePlanWire?`, `phase`, private `viewSeq`/`planSeq`
  counters).
  - **Loading and refresh (lifetime-bound).** On appear it loads
    `usage-stopped:view`. While the sheet is presented it also reloads on
    (a) every `usage-stopped.updated` raw frame and (b) every
    disconnect→connect. Both arrive through two `PassthroughSubject<Void, Never>`
    that `UsageAlertsStore` (app-lifetime, already bound to the event store)
    exposes — `stoppedUpdates` (fed by its single raw-frame handler) and
    `reconnects` (fed by its `$connectionState` subscription) — because
    `MantaEventStore.addRawFrameHandler` cannot unregister (`MantaEventStore.swift:464-466`);
    the model holds the `AnyCancellable`s, so they end with the sheet. Each load
    increments `viewSeq`; a response is applied only if its seq is still the
    newest (older responses are dropped).
  - **Selection reconciliation** (`UsageResumeSelection.reconcile`, shared rule
    with the desktop modal): with the new view's ids `V` and armed ids `A`:
    if `pristine`, `selected = A`; otherwise `selected = selected ∩ V` (vanished
    rows leave the selection, the user's other choices stay; new rows are not
    auto-selected). After every applied view or selection change the current
    `plan` is invalidated (button disabled) and the dry run
    (`usage-stopped:apply {selected, dryRun:true}`, debounced 150 ms) runs with
    a new `planSeq`; only the newest plan reply is applied.
  Renders:
  - title `view.title`, header `view.header`; empty → `view.emptyText` + Close.
  - Sections per `view.groups[].workspace`; rows (tap toggles selection,
    accessory `checkmark.circle.fill` / `circle`) with `name`, "armed" / "new"
    chips from `armed` / `isNew`, `snippet`, provider · model, window chip
    "`window.label` · `UsageMeters.resetAt(resetsAt)` · in
    `UsageMeters.resetDistance(…)`" (clock-relative, M19 client), cost chip
    `cost.label` (ok tint when `cost.warm`).
  - Bottom `safeAreaInset`: "Check all" / "Uncheck all" (view state), "s of t
    selected", and the footer "s selected · ≈ <sum of selected
    `cost.reReadTokens`> re-read" or " · no extra cost" (view arithmetic over the
    box's numbers, using `UsageMeters.formatTokens`); cold callout
    `coldNote.one` / `coldNote.many` with `{n}` = selected rows whose
    `cost.warm == false`.
  - Primary button: title and enabled state from the newest plan reply
    (disabled while no current plan exists). Unchecking the only armed row
    therefore enables "Update" (the box computes `canApply`).
  - Apply: `usage-stopped:apply {selected}` → show `message`; `failed`
    non-empty → keep the sheet open with that message; else dismiss. Then
    `await sessions.refreshStopped()`.
  - Dismissal by any route: `usage-stopped:stamp-last-looked` (failure logged
    only), then `refreshStopped()`.
  - Unknown channel → "Update your box to use this." with a Close button.
  - Box lifecycle: the model is per presentation; responses that arrive after
    dismissal are dropped.
- Session-list entry point (M-09-2): `UsageStoppedCapsule(count:action:)`
  (in `UsageResumeSheet.swift`) — `pause.circle` + N in warn tint,
  accessibility label "N conversation(s) stopped by a provider limit", shown
  when WS04's `store.unarmedStoppedCount > 0`; action
  `UsageAlertsStore.shared.presentResume()`.

### Pure logic

`UsageResumeFooter.text(selectedRows:)`, `.coldCount(selectedRows:)` and
`UsageResumeSelection.reconcile(selected:pristine:viewIDs:armedIDs:) -> Set<String>`
in `UsageResumeLogic.swift` (Foundation-only; view state over decoded rows —
the desktop modal applies the same rule).
The round-2 `UsageResume` ports (snippet, reset lookup, cost, grouping, isNew,
header, window chip label, applyPlan, canApply, applyTitle, name lookup,
`lastLookedMs`) and `UsageStoppedEntry` are **deleted** — SF-M14/M15 own them.

### Tests — `MantaUITests/UsageResumeTests.swift` (Foundation-only)

Decode `usage-stopped:view` and `usage-stopped:apply` (dry run and real, with
`failed`); footer text for 0 / warm-only / mixed selections; cold count;
`reconcile`: pristine → armed set; user-modified selection keeps its choices,
drops a vanished id, does not add a new row. Store test (Mac): one armed row
unchecked → dry run reply `canApply:true` enables "Update"; a `failed` reply
keeps the sheet open; dismiss stamps last-looked; **another device arms row B
and removes row C while the sheet is open** (`usage-stopped.updated` frame +
changed view) → rows update without reopening, C leaves the selection, the
user's toggle on A survives, a new dry run is issued; an older view response
arriving after a newer one is ignored; a reconnect triggers one reload.

### Acceptance criteria

- [ ] When a provider limit stops a conversation, the session list shows the
      pause capsule with the unarmed count (driven by WS04's records).
- [ ] The sheet lists the same rows as desktop; arming/unarming here is
      reflected on desktop (and vice versa) without reopening.
- [ ] Unchecking the ONLY armed row enables "Update", and tapping it removes
      the row; failures are reported with the row name.
- [ ] Closing clears "new" badges on both clients.
- [ ] WS09 adds no `usage-stopped:list` call (grep).

---

## F7 — Usage alerts (90% / limit)

### Desktop behaviour today

`usageEscalation.ts` + `App.tsx:794-917`:
- Baseline seeded from `usage:list` on load/reconnect (`buildUsageLevels`,
  stale windows included verbatim, `App.tsx:521-531`).
- On every `usage.updated` (`{snapshots}`): `shouldFireUsageAlert` fires only
  on an UPWARD transition per `provider:window.kind` (none→warn at ≥ 90,
  →limit at ≥ 100); stale windows never fire; then the level map is replaced
  (re-arms after a reset).
- Warn toast (6 s): "<Provider> <Window label> NN% used — resets in 2h10m."
  (`buildWarnMessage`).
- Limit toast (error, sticky): "<Window label> limit reached on <Provider> —
  resets in 6d 3h (Thu, 21 Aug, 09:00)." (`buildLimitMessage`). Actions only
  when the window has `resetsAt` AND a chat session is active:
  - "Remind me at reset" → `schedule:create {fireAt: resetsAt+60 000, prompt:
    "<Provider> <Window> has reset — you can keep working.", recurring:false,
    label: "Reminder: <Provider> <Window> reset", sessionID, kind:"notify"}` →
    toast "Reminder set for <resetAt>." or "Couldn't set a reminder: <error>".
  - "Keep going at reset" → opens the resume modal (F6).
- Desktop never re-checks the reset instant at tap time: a limit toast left
  open past its reset still sends a past `fireAt`, which `createJob` turns into
  a yearless cron (`schedule.mjs:258-266`) whose next match is a year later
  (`:277-284`). iOS must not copy that (design below).

### Wire contract (server-first)

- Raw bus frame `{kind:"usage.alert", payload:{alert}}` / `{payload:{retired:[id]}}`
  (SF-M16), observed via `MantaEventStore.addRawFrameHandler`
  (`MantaEventStore.swift:464`, multicast; no change to WS02's store).
- `usage:alerts` → `{supported, alerts:[…]}` — read on connect and on every
  disconnect→connect, detected from `eventStore.$connectionState` (pattern of
  `ChatSessionStore.swift:406,710-727`; never the single-owner
  `resyncHandler`).
- `usage:remind-at-reset {key, sessionID}` → `{ok, job?, fireAt?, code?, message?}`
  (SF-M17). The box resolves the CURRENT reset instant and refuses an elapsed
  one; the reminder is the existing schedule `notify` job.
- **No push for 90 %/limit (D24).** Alerts are in-app only on both clients.
- `usage.updated` / `usage:list` are no longer read by the alerts store (the
  chat's `UsageStore` keeps its own poll for the meters).

### iOS design (server-first)

- `UsageAlertsStore.swift` — `@MainActor final class UsageAlertsStore:
  ObservableObject`, `static let shared`. Published: `queue: [UsageAlertWire]`,
  `activeSessionId: String?`, `resumeSheetPresented`, `unsupported: Bool`.
  Private: `state: UsageAlertQueue` (pure value: queue ids, `seenIDs`,
  `lastBootId`, `lastRevision` — per binding), the box lifecycle (above). Also
  exposes `let stoppedUpdates = PassthroughSubject<Void, Never>()` and
  `let reconnects = PassthroughSubject<Void, Never>()` for the resume sheet (F6).
  - `bind(eventStore:)` — idempotent. Registers ONE raw-frame handler
    (`usage.alert` → `state.applyFrame`; `usage-stopped.updated` →
    `stoppedUpdates.send()`) and a retained `$connectionState` subscription.
    On first `.connected` and every disconnect→connect it sends `reconnects`
    and reads `usage:alerts` → `state.applySnapshot` (the SF-M16 "Client
    reconciliation contract": prune ids absent from the active set, drop a
    snapshot older than the last applied revision, enqueue unseen ids, reset on
    a new `bootId`; a frame with a new `bootId` triggers a snapshot read).
    Closing a banner removes it from the queue but keeps its id in `seenIDs`.
    Unknown channel → `unsupported = true` (no alerts; Insights shows "Update
    your box to get usage alerts."). No baseline, no levels — the box owns
    them.
  - Warn alerts (`sticky == false`) leave the queue 6 s after shown; sticky
    ones stay until closed or retired.
  - `remindAtReset(_ alert:)` — shown only when `alert.canRemind && activeSessionId != nil`.
    Calls `usage:remind-at-reset {key: alert.key, sessionID}`. `ok` → banner
    "Reminder set for <UsageMeters.resetAt(fireAt)>."; `ok:false` → banner
    `message` (the box's "already reset" / "no reset time" / "open a chat"
    copy) and, for `code:"expired"`, the alert is removed; throw → "Couldn't set
    a reminder: <error>".
  - `keepGoing(_ alert:)` — shown only when `alert.canKeepGoing`; →
    `presentResume()`.
  - `activeSessionId` — set by ChatScreen (M-09-5).
- `UsageAlertBanner.swift` — top overlay (M-09-3) for the head of the queue:
  glass capsule, icon `gauge.with.dots.needle.67percent` (warn) /
  `exclamationmark.octagon` (limit, danger tint), text `alert.text` + the
  client reset clause (" — resets " + `UsageMeters.formatReset(resetsAt)`, or
  " — resetting…", omitted when `resetsAt` is nil — M19 KEEP-CLIENT), close
  button. Limit buttons hide when `resetsAt <= now`
  (`TimelineView(.periodic(from: .now, by: 30))`) — the box refuses the
  action anyway. Haptic `.warning` on a limit alert when haptics are enabled.
- Interaction with the existing per-chat weekly banner
  (`ChatScreen.swift:1265-1300`): unchanged (see Open questions).

### Pure logic

`UsageAlertText.line(alert:now:)` in `UsageAlertsLogic.swift` (Foundation-only)
— appends the reset clause to the box text via `UsageMeters.formatReset` — and
`struct UsageAlertQueue` with `mutating func applySnapshot(_ list: UsageAlertsList) -> Bool`
(returns false when dropped as stale), `mutating func applyFrame(_ f: UsageAlertFrame) -> FrameResult`
(`.applied` / `.ignoredStale` / `.needsSnapshot` for a new `bootId`),
`mutating func dismiss(_ id: String)`, and `var visible: [UsageAlertWire]` — the
client bookkeeping of the SF-M16 contract (same rule as the desktop's
`src/renderer/usageAlertsQueue.ts`). The round-2
`UsageEscalation`/`UsageBaseline` types (levels, transitions, baseline, seed
ordering, action policy, retirement) are **deleted** — SF-M16/M17 own them.

### Tests — `MantaUITests/UsageEscalationTests.swift` (Foundation-only)

Decode alert / retired frames and `usage:alerts`; `UsageAlertQueue`: unseen
ids enqueue in order, a seen id never re-enqueues, a dismissed id stays seen;
**disconnect → retirement missed → reconnect**: snapshot without the id
removes it from `visible`; **retirement during an in-flight snapshot**: frame
(revision 5, retired X) applied, then snapshot (revision 4, contains X) →
dropped, X stays gone; frame with `revision <= lastRevision` ignored; new
`bootId` → `.needsSnapshot` and the next snapshot (revision 1) is accepted; `line` with/without `resetsAt` and with an elapsed reset
("resetting…"). Store test (Mac, `UsageAlertsStoreTests.swift`): reconnect
re-reads `usage:alerts` exactly once and does not re-show a seen id; a
`retired` frame closes the banner; `ok:false, code:"expired"` removes the alert
and shows the box message; `resetForBoxChange()` clears queue + seen ids and a
late old-box response is dropped.

### Acceptance criteria

- [ ] Crossing 90 % shows one transient banner; crossing 100 % shows one
      sticky banner; neither repeats until the window resets and re-crosses.
- [ ] A crossing that happened while the phone was disconnected is alerted
      once after reconnect (from `usage:alerts`); each alert id is shown at most
      once per app run; levels the box saw on its own first poll never raise an
      alert.
- [ ] With a chat open, "Remind me at reset" creates a one-shot job (visible in
      the chat's schedules card) and a push arrives at reset; without a chat
      open the actions are not shown.
- [ ] A limit banner left open past its reset loses its buttons and is retired;
      no job is ever created for an elapsed reset.
- [ ] "Keep going at reset" opens the resume sheet.
- [ ] After switching or removing the box, no alert or chat id from the old
      box survives, and no old-box reminder can be created.
- [ ] No push notification is sent for 90 %/limit (D24); the desktop shows the
      same alerts as iOS, from the same frames.

---

## Libraries considered (user rule: research before building)

- **iOS chart (F3):** Apple's Swift Charts (`import Charts`, system framework,
  iOS 16+; the app targets iOS 26) — chosen over third-party DGCharts
  (Apache-2.0, widely used) because it is first-party, needs no package
  (`Package.swift`/`project.yml` unchanged) and covers line/area/dash marks.
- **Desktop chart:** keeps the existing hand-built SVG in `OptimizerCard.tsx`
  (this change moves derivations, not rendering); adopting Recharts (MIT,
  widely used) would be a separate visual change with no
  server-first benefit — recorded, not adopted here.
- **Server view modules / alert queue / selection reconcile:** small pure
  functions over the box's own data; no library offers these domain rules.
  Concurrency for config writes reuses the existing single `editConfig` chain
  and a promise chain (no `p-queue`/`async-mutex` dependency needed for one
  in-process serializer).
- **iOS lists/sheets:** native SwiftUI (`List`, `Form`, `.searchable`,
  `.sheet`) — the codebase's existing idiom; no UI library.
- **M4 model fuzzy match (KEEP-CLIENT, `fuzzyMatchModel` in
  `src/shared/modelGuide.mjs` + its iOS port):** Fuse.js 7.5.0 (Apache-2.0,
  ~12M/wk) and fuzzysort 4.0.2 (MIT, ~12M/wk) considered — **kept
  hand-written**: the iOS app needs a byte-identical port of the scoring and
  neither library has a Swift twin, so adopting one on the desktop would make
  the two clients rank models differently.
- **M5 context label ("1M"/"200k") and M19 reset-time text:**
  `Intl.NumberFormat({notation:"compact"})` / Swift
  `.formatted(.number.notation(.compactName))` and `Intl.DurationFormat`
  considered — **kept hand-written**: compact notation prints "200K" (house
  style is "200k"), and `Intl.DurationFormat` is not available in every
  runtime the app ships on.
- **No new npm or Swift package dependency** — WS09 does not edit
  `package.json` / `package-lock.json` (wave B's only dependency change is
  WS07's `lru-cache`, master ledger M-07-pkg-1). Verified against
  `libraries.md` §09.

## Files

### Server (WS09-owned new modules; `npm run test:server`)

| File | Contents |
|---|---|
| `src/server/modelsTable.mjs` + `.test.mjs` | SF-M1/M2: `models:table`, `models:picker`, `models:set-*`, `models:retry-sub-sync`, `models:opt-in` |
| `src/server/modelsUnidentified.mjs` + `.test.mjs` | F4 + SF-M9/M10/M11 (`models:unidentified`, `models:declare`) |
| `src/server/ledgerView.mjs` + `.test.mjs` | SF-M6 |
| `src/server/optimizer/view.mjs` + `.test.mjs` | SF-M7 |
| `src/server/modelsPricing.mjs` + `.test.mjs` | SF-M13 (`models:set-price`, `unpricedByProvider`) |
| `src/server/usageResumeView.mjs` + `.test.mjs` | SF-M14/M15 |
| `src/server/usageAlerts.mjs` + `.test.mjs` | SF-M16/M17 |
| `src/server/usageWindowView.mjs` + `.test.mjs` | SF-M18 |
| `src/server/usage.mjs` (edit, WS09 — not a registration file) + `usage.test.mjs` case | decorate the source arrays with `tone` before storing AND publishing; create/observe `usageAlerts`; `getUsageAlerts()` |
| `src/server/rpc.models.test.mjs` (NEW, WS09) | integration smoke test for M-09-srv-1: `buildHandlers` with injected fakes; every new channel resolves to its pinned shape (run by IB after applying the mount) |
| `src/server/providers.mjs` (edit, WS09 in wave B — master D27 table) + `providers.test.mjs` cases | additive `syncSubagentsDetailed` (the single reconcile implementation; `syncSubagents` projects `.agents`) and `setModelCostDetailed` (`setModelCost` projects to its old shape); no second writer |
| `src/shared/autoEligibility.mjs` (+ `.d.mts`) | `describeMissing` moved here |
| `src/shared/formatTokens.mjs` (+ `.d.mts`) | **consumed, not created** — WS02 creates it in wave B (master D26) with `formatTokens(n)` and `formatTokenCount(n)`; WS09's views import it. Until WS02's commit is integrated, WS09 verifies against the pinned signatures with a local uncommitted copy. |

Registrations in `src/server/rpc.mjs`: mount M-09-srv-1; capability ids in
WS02's `src/server/boxCapabilities.mjs`: mount M-09-srv-2 (both integration
agent B).
No `index.mjs` and no `streamInterp.mjs` change.

### Desktop

See "Desktop migration" for each file. WS09-only files (edited by WS09):
`ModelsCard.tsx`, `ModelLedgerCard.tsx`, `OptimizerCard.tsx`,
`ModelsWeCouldntIdentify.tsx`, `ModelPriceForm.tsx`, `UsageResumeModal.tsx`,
`usageResume.ts`, `usageEscalation.ts` (deleted), `ModelPicker.tsx`,
`UsageDial.tsx`, `AccountsCard.tsx` (import + re-export of the shared
`describeMissing`), new `modelsPicker.ts`, new `usageAlertsQueue.ts`, and their
tests (`routingCatalog.ts` is NOT edited in wave B — its matcher stays for
Accounts); also `src/renderer/App.tsx` and
`src/renderer/store.ts` (WS09 is their only wave-B editor — master D27).
WS02-owned shared desktop files, WS09 hunks applied by integration agent B
(M-09-dsk-1/2/4/5): `src/shared/api.ts`, `src/shared/types.ts`,
`src/renderer/api/httpApi.ts`, `src/renderer/api/demoApi.ts`,
`src/renderer/api/demoCoverage.test.ts`, `src/renderer/chatUtils.ts` (+ test),
`src/renderer/ChatPanel.tsx`. WS09 applies them locally (uncommitted) to verify.

### iOS (all `mobile/native/MantaUI/` unless noted)

| File | Contents | Foundation-only (Package.swift, D19) |
|---|---|---|
| `MantaAPIClient+Models.swift` | client members (see Client members) | no |
| `ModelsWire.swift` | Decodable wire types: `ModelsTableWire`, `ModelsWriteReply`, `ModelsPickerWire`, `LedgerSummaryWire` (+ `view`), `OptimizerSummaryWire`/`OptimizerSeriesWire` (+ `view`), `OptimizerPricesWire` (+ `unpricedByProvider`), `ModelsCatalogWire`, `UnidentifiedList`, `ModelsDeclareReply`, `ModelsSetPriceReply`, `UsageResumeViewWire`, `UsageResumePlanWire`, `UsageAlertWire`, `UsageAlertsList`, `UsageRemindReply`; `ModelsCapability.isUnsupported`; `ModelsFormat.money/count` | yes |
| `ModelsStore.swift` | `ModelsStore` | no |
| `ModelsScreen.swift` | screen + sections + `ModelsRow` | no |
| `ModelsDetailSheet.swift` | detail sheet + `ModelsEditForm` | no |
| `ModelsLedgerScreen.swift` | F2 | no |
| `OptimizerLogic.swift` / `OptimizerScreen.swift` | F3 chart geometry (`OptimizerChart`) / screen + `OptimizerGauge` | yes / no |
| `ModelsIdentifyLogic.swift` / `ModelsUnidentifiedView.swift` | F4 typeahead + Save gating (`ModelsIdentifySearch`) / section + `ModelsIdentifyForm` | yes / no |
| `ModelsPriceForm.swift` | F5 | no |
| `UsageResumeLogic.swift` / `UsageResumeSheet.swift` | F6 footer arithmetic (`UsageResumeFooter`) / sheet + `UsageResumeModel` + `UsageStoppedCapsule` | yes / no |
| `UsageAlertsLogic.swift` / `UsageAlertsStore.swift`, `UsageAlertBanner.swift` | F7 `UsageAlertText`, `UsageAlertQueue` / store + banner | yes / no |
| `ModelsBoxBinding.swift` | box binding decision + `ModelsBoxCredentials` + `DeprecatedOptInCopy.shouldCopy` | yes |
| `MantaUITests/ModelsTests.swift`, `OptimizerTests.swift`, `UsageResumeTests.swift`, `UsageEscalationTests.swift`, `ModelsBoxBindingTests.swift` | decode + presentational XCTests | yes |
| `MantaUITests/ModelsStoreTests.swift`, `UsageAlertsStoreTests.swift` | store tests (Combine/URLProtocol) | no |

**Deleted from the plan (server-first):** `ModelsLogic.swift` (`ModelsTable`,
`ModelsPicker`, `ModelsConfig`), `ModelsInsightsLogic.swift`,
`ModelsPriceLogic.swift`, `UsageEscalation.swift`, `UsageBaseline.swift`,
the `UsageResume` ports and `UsageStoppedEntry`. (`UsageStoppedStore.swift`
and `UsageSeatLine.swift` were already dropped — D16, D17.)

Edit (owned): `ChatModelCatalog.swift` (per-box client binding + lifecycle,
`picker`/`pickerUnsupported`, one-time opt-in copy, `models.updated` /
`model-prefs.updated` refetch, received mount M-08-1), `ChatModelStore.swift`
(D1: `isSelectable` over `picker.selectable`, guarded `apply`/`setFast`,
async `optIn` via `models:opt-in`, received mount M-03-5),
`ModelPickerSheet.swift` (groups/locked/recents from the picker, unsupported
footer, async Enable), `UsageMeters.swift` (`band(_ window: UsageWindow) ->
MeterBand?` from `tone`; `UsageWindow.tone` is added by M-09-8 — see M-09-9).
`DeprecatedModelOptIns.swift` is not edited (read once + cleared via its
existing `load`/`save`).

Manifest for integration agent B (D18; ledger M-09-7): add to
`mobile/native/Package.swift` `sources`: `ModelsWire.swift`,
`OptimizerLogic.swift`, `ModelsIdentifyLogic.swift`, `UsageResumeLogic.swift`,
`UsageAlertsLogic.swift`, `ModelsBoxBinding.swift`; test `sources`:
`ModelsTests.swift`, `OptimizerTests.swift`, `UsageResumeTests.swift`,
`UsageEscalationTests.swift`, `ModelsBoxBindingTests.swift`. In-package
dependencies: `MantaModels.swift`, `UsageMeters.swift`, `MantaError.swift`
(already listed). IB runs `mobile/native/verify.sh` after adding them. WS09
edits neither `Package.swift`, `project.yml` nor the `.pbxproj`.

## Client members

All in `MantaUI/MantaAPIClient+Models.swift`, via C1 `call` / `callRequired`
/ `callVoid` / `jsonObject`. None duplicates a member owned elsewhere (the
stopped list is WS04's `usageStoppedList()`, D16; `configGet`, `configUpdate`,
`models`, `defaultModel`, `usageList`, `messages` exist and are reused).
Round-2 members **removed** by server-first: `modelsSyncSubagents`,
`setModelCost`, `usageStoppedArm`, `usageStoppedDisarm`, `scheduleCreate`.

| Member | Channel |
|---|---|
| `func modelsTable() async throws -> ModelsTableWire` | `models:table` |
| `func modelsSetDefault(key: String?) async throws -> ModelsWriteReply` | `models:set-default` |
| `func modelsSetMain(key: String, on: Bool) async throws -> ModelsWriteReply` | `models:set-main` |
| `func modelsSetSub(key: String, on: Bool) async throws -> ModelsWriteReply` | `models:set-sub` |
| `func modelsRetrySubSync() async throws -> ModelsWriteReply` | `models:retry-sub-sync` |
| `func modelsOptIn(keys: [String]) async throws -> ModelsWriteReply` | `models:opt-in` |
| `func modelsSetOverride(key: String, name: String, description: String, context: String) async throws -> ModelsWriteReply` | `models:set-override` |
| `func modelsPicker() async throws -> ModelsPickerWire` | `models:picker` |
| `func ledgerSummary() async throws -> LedgerSummaryWire` | `ledger:summary` |
| `func optimizerSummary() async throws -> OptimizerSummaryWire` | `optimizer:summary` |
| `func optimizerSeries(range: String) async throws -> OptimizerSeriesWire` | `optimizer:series` |
| `func optimizerPrices() async throws -> OptimizerPricesWire` | `optimizer:prices` |
| `func modelsSetPrice(providerID: String, modelID: String, input: String, output: String, cacheRead: String, cacheWrite: String) async throws -> ModelsSetPriceReply` | `models:set-price` |
| `func modelCatalog() async throws -> ModelsCatalogWire` | `opencode:model-catalog` |
| `func modelsUnidentified() async throws -> UnidentifiedList` | `models:unidentified` |
| `func modelsDeclare(key: String, catalogId: String) async throws -> ModelsDeclareReply` | `models:declare` |
| `func modelsDeclare(key: String, form: ModelsDeclareForm) async throws -> ModelsDeclareReply` | `models:declare` |
| `func usageStoppedView() async throws -> UsageResumeViewWire` | `usage-stopped:view` |
| `func usageStoppedApply(selected: [String], dryRun: Bool) async throws -> UsageResumePlanWire` | `usage-stopped:apply` |
| `func usageStoppedStampLastLooked() async throws` | `usage-stopped:stamp-last-looked` |
| `func usageAlerts() async throws -> UsageAlertsList` | `usage:alerts` |
| `func usageRemindAtReset(key: String, sessionID: String) async throws -> UsageRemindReply` | `usage:remind-at-reset` |

Before dispatch, grep: no other `MantaAPIClient+*.swift` declares any of these
names (checked against specs 01–08, 10).

## Mount requests

Per D18/D24 and the canonical ledger. "IB" = integration agent B. Provider
symbols are WS09's unless marked. Server rows are applied in the D24 server
order 02 → 07 → **09** → 06.

| ID | Receiving file | Applier | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-09-srv-1 | `src/server/rpc.mjs` | IB (after 02, 07 server rows; before 06) | Exactly the exports pinned in SF-M1/M2/M6/M7/M9–11/M13/M14–15/M16–17: `createModelsTable` (`modelsTable.mjs`), `createModelsUnidentified` (`modelsUnidentified.mjs`), `withLedgerView` (`ledgerView.mjs`), `withSummaryView`, `withSeriesView` (`optimizer/view.mjs`), `withUnpricedGroups`, `createModelsPricing` (`modelsPricing.mjs`), `createUsageResumeView` (`usageResumeView.mjs`), `getUsageAlerts` (`usage.mjs` — add to the existing usage import, `:18`); `syncSubagentsDetailed`, `setModelCostDetailed` (`providers.mjs`, already imported as `providers`); `getModelPrefs` (already imported as `modelPrefsGetStore`, `:26`); `lookupModel`, `matchModel` (add to the existing `./modelCatalog.mjs` import, `:68`); `usageStoppedList`, `usageStoppedArm`, `usageStoppedDisarm` (existing aliases of `listStopped`/`armStopped`/`disarmStopped`, `:19-25`) | See the exact code block "M-09-srv-1 registration" below. `npm run test:server` green after, plus the integration smoke test `src/server/rpc.models.test.mjs` (WS09 provides it; IB runs it): builds `buildHandlers` with injected fakes and calls every new channel once — incl. `models:retry-sub-sync`, `models:set-price` and both `models:declare` forms — asserting each resolves to its pinned shape. | WS09 server modules landed |
| M-09-srv-2 | `src/server/boxCapabilities.mjs` (WS02, wave B) + `boxCapabilities.test.mjs` | IB (right after M-09-srv-1) | `BOX_CAPABILITIES` (WS02) | Append the nine ids of the capability table (`models-table-1` … `usage-window-tone-1`); extend the test's expected ids. | WS02 SF-0 landed; M-07-S2 applied first |
| M-09-dsk-1 | `src/shared/api.ts`, `src/shared/types.ts` (WS02 owns in B, master D27) | IB, desktop order 02 → 07 → **09** → 06 | the `window.api` methods + wire types under "Desktop migration" | additive members / `IPC` constants / types | WS02 desktop commit; M-07-D2/D3 |
| M-09-dsk-2 | `src/renderer/api/httpApi.ts`, `src/renderer/api/demoApi.ts`, `src/renderer/api/demoCoverage.test.ts` (WS02 owns in B) | IB | same | `rpc(IPC.x, arg)` methods; `onModelsUpdated` = `on("models.updated")`, `onUsageAlert` = `on("usage.alert")`; demo fixtures; each new key either stubbed or listed in `DEMO_UNIMPLEMENTED` | M-09-dsk-1; M-07-D4/D5 |
| M-09-dsk-3 | `src/renderer/App.tsx` | **WS09 directly** (sole wave-B editor, D27) | `usageAlerts`, `onUsageAlert`, `usageRemindAtReset` | replace the escalation effect per "Desktop migration" M16/M17 | M-09-dsk-2 (applied locally to verify) |
| M-09-dsk-4 | `src/renderer/chatUtils.ts` + `chatUtils.test.ts` (WS02 owns in B) | IB | `src/shared/formatTokens.mjs` (WS02, D26) | delete the picker helpers, optimizer formatters, `usageTone` and their tests. `formatTokens` is ALREADY a re-export of the shared module (WS02) — no formatter edit here. | WS02 desktop commit; M-07-D1 |
| M-09-dsk-5 | `src/renderer/ChatPanel.tsx` (WS02 owns in B) → IB; `src/renderer/store.ts` → **WS09 directly** (sole wave-B editor) | as stated | `useModelsPicker`, `modelsOptIn` | delegate groups from the picker (ChatPanel); `optInModel` via `modelsOptIn`, drop the mirrors (store) | M-09-dsk-2 |
| M-09-1 | `SettingsScreen.swift` (WS10) | IB (after B) | `ModelsScreen()` | A fixed "Models" row styled like `accountsEntry` (`SettingsScreen.swift:174-200`), placed directly after it (`10-settings-box.md:1187`): title "Models", subtitle "Default, picker, subagents, spend and optimizer", `NavigationLink { ModelsScreen() }`; matched by search for "models default subagent picker spend cost optimizer prices identify" (mechanism of `accountsMatchesQuery`, `:167-171`). | WS10 (A) and WS09 (B) landed |
| M-09-2 | `SessionListView.swift` (WS04) | IB (after B) | `UsageStoppedCapsule(count:action:)`, `UsageAlertsStore.shared.presentResume()`; WS04: `SessionListStore.unarmedStoppedCount` | A `ToolbarItem(placement: .topBarTrailing)` before the `orderMenu` item (`SessionListView.swift:116`), rendered only when `store.unarmedStoppedCount > 0`: `UsageStoppedCapsule(count: store.unarmedStoppedCount) { UsageAlertsStore.shared.presentResume() }`. | WS04 §9 (A), WS09 (B); ledger order with M-06-2 |
| M-09-3 | `MantaAppRoot.swift` (WS04) | IB (after B) | `UsageAlertsStore.shared.bind(eventStore:)`, `UsageAlertBanner(store:)`, `UsageResumeSheet(sessions:usage:)`, `UsageAlertsStore.resumeSheetPresented` | (a) in the paired branch's `.onAppear` next to `startModelPrefs()` (`MantaAppRoot.swift:104`) AND in `commitPairing` after `startModelPrefs()` (`:197`): `UsageAlertsStore.shared.bind(eventStore: store)`; (b) `@ObservedObject private var usageAlerts = UsageAlertsStore.shared`; on the root `Group`, only when `paired && scene == nil`: `.overlay(alignment: .top) { UsageAlertBanner(store: usageAlerts) }` and `.sheet(isPresented: $usageAlerts.resumeSheetPresented) { UsageResumeSheet(sessions: sessionStore, usage: usageAlerts) }`. | WS04 (A), WS09 (B); ledger order with M-07-3 |
| M-09-4 | `MantaAppRoot.swift` (WS04) | IB (after B) | `UsageAlertsStore.resetForBoxChange()`, `ChatModelCatalog.resetForBoxChange()` | (a) in `commitPairing`'s `if flow.isSwitching { … }` (`:187-190`) after `sessionStore.resetForBoxChange()`; (b) in M-10-2's `.onReceive(… .mantaBoxRemoved)` closure (`10-settings-box.md:1173`) after `sessionStore.resetForBoxChange()`: `UsageAlertsStore.shared.resetForBoxChange(); ChatModelCatalog.shared.resetForBoxChange()` (idempotent). | as M-09-3; M-10-2 (A2) |
| M-09-5 | `ChatScreen.swift` (WS02) | WS02 (B) | `UsageAlertsStore.shared.activeSessionId` | Beside the two `reportFocus(sessionId: store.sessionId, visible: true)` calls (`:371`, `:472`): `UsageAlertsStore.shared.activeSessionId = store.sessionId`; beside the two `visible: false` calls (`:381`, `:475`): clear it only if it still equals this session. (WS02's legacy receipt label "M4".) | WS09 symbol pinned (same wave) |
| M-09-6 (optional — accepted by WS08, `08-accounts.md:1004`) | `AccountsScreen.swift` (WS08) | IB (after B) | `ModelsScreen()` | Footer row "Set prices for unpriced models" → `NavigationLink { ModelsScreen() }`. | WS08 (A), WS09 (B) |
| M-09-9 | `ComposerView.swift` (WS03), `AccountsScreen.swift` (WS08), `UsageSheets.swift` (WS02, usage sheet rows) | IB (after B) for ComposerView/AccountsScreen; WS02 (B) for UsageSheets | `UsageMeters.band(_ window: UsageWindow) -> MeterBand?` (nil = no `tone` → neutral) | Replace `UsageMeters.band(window.pct)` at `ComposerView.swift:616`, `AccountsScreen.swift:716`, `UsageSheets.swift:513` with `UsageMeters.band(window)`; a nil band tints with `tokens.tx4` (neutral). `UsageMeters.band(_ pct:)` stays for the CONTEXT meter only (`ChatScreen.swift:1143`) until WS11 U3 (T20). | WS09 landed |
| M-09-8 | `MantaModels.swift` (WS01, D1) | IB (after B) | — | `struct UsageWindow` gains `var tone: String? = nil` (additive; decoded from the box, SF-M18). | WS01 (A1) |
| M-09-7 | `mobile/native/Package.swift` | IB (after B) | files under Files → iOS manifest | add sources/tests; run `verify.sh` | WS09 landed |

**M-09-srv-1 registration** (inside `buildHandlers`, next to the existing
`optimizerPricesApi` construction, `rpc.mjs:754-775`; `publish` =
`(evt) => bus.publish(evt)`):

```js
const publish = (evt) => bus.publish(evt);
const modelsTable = createModelsTable({
  listModels: (overrides) => oc.listModels(overrides, { strict: true }),
  configGet: () => local.configGet(),
  configUpdate: (patch) => local.configUpdate(patch),
  syncSubagentsDetailed: (input) => providers.syncSubagentsDetailed(input),
  getModelPrefs: () => modelPrefsGetStore(),
  publish,
});
const modelsUnidentified = createModelsUnidentified({
  listModels: (overrides) => oc.listModels(overrides, { strict: true }),
  configGet: () => local.configGet(),
  configUpdate: (patch) => local.configUpdate(patch),
  catalog: { lookupModel, matchModel, allModels: catalogAllModels },
  publish,
});
const modelsPricing = createModelsPricing({
  setModelCostDetailed: (input) => providers.setModelCostDetailed(input),
  invalidatePrices: () => optimizerPricesApi.invalidate(),
  getPrices: () => optimizerPricesApi.get(),
});
const usageResumeView = createUsageResumeView({
  listStopped: () => usageStoppedList(),
  listSnapshots: () => usageListSnapshots(),
  configGet: () => local.configGet(),
  listProjects: () => tmux.listProjects(),
  listMessages: (sid, opts) => oc.listMessages(sid, opts),
  arm: ({ conversation }) => usageStoppedArm({ conversation }, { publish }),
  disarm: ({ conversation }) => usageStoppedDisarm({ conversation }, { publish }),
  now: Date.now,
});
// handlers:
"models:table": () => modelsTable.table(),
"models:picker": () => modelsTable.picker(),
"models:set-default": (i) => modelsTable.setDefault(i ?? {}),
"models:set-main": (i) => modelsTable.setMain(i ?? {}),
"models:set-sub": (i) => modelsTable.setSub(i ?? {}),
"models:retry-sub-sync": () => modelsTable.retrySubSync(),
"models:opt-in": (i) => modelsTable.optIn(i ?? {}),
"models:set-override": (i) => modelsTable.setOverride(i ?? {}),
"models:unidentified": () => modelsUnidentified.list(),
"models:declare": (i) => modelsUnidentified.declare(i ?? {}),
"models:set-price": (i) => modelsPricing.setPrice(i ?? {}),
"usage-stopped:view": () => usageResumeView.view(),
"usage-stopped:apply": (i) => usageResumeView.apply(i ?? {}),
"usage:alerts": () => getUsageAlerts()?.list() ?? { supported: true, bootId: null, revision: 0, alerts: [] },
"usage:remind-at-reset": (i) =>
  getUsageAlerts()?.remind(i ?? {}, { createJob: (input) => scheduleCreateJob(input, { publish }) })
  ?? { ok: false, code: "no-reset", message: "This window has no reset time." },
// wrapped existing handlers (additive fields only):
"ledger:summary": async (opts) => withLedgerView(await ledgerSummary(opts ?? {})),
"optimizer:summary": async () => withSummaryView(await optimizerSummaryFn(), await local.configGet()),
"optimizer:series": async (opts) => withSeriesView(await optimizerSeriesFn(opts?.range), opts?.range),
"optimizer:prices": async () => withUnpricedGroups(await optimizerPricesApi.get()),
```

`getUsageAlerts()` is null only before `startUsagePoller` runs (tests /
early boot); the fallbacks above keep the channel answering. `usageStoppedArm`
/ `usageStoppedDisarm` are the same calls the existing `usage-stopped:arm` /
`:disarm` handlers make (`rpc.mjs:2396-2399`), so `usage-stopped.updated` is
published exactly as today. Verify the import names against `rpc.mjs` at
integration time (`usageStoppedList`, `scheduleCreateJob`, `catalogAllModels`,
`modelPrefsGetStore` are the existing aliases at `:18-26,68`).

Superseded (history only): draft M5, M6, M7 (= M-09-6).

## Mounts applied by this workstream

| ID | From | Receiving file | Applier | Change | Check | Prerequisite |
|---|---|---|---|---|---|---|
| M-08-1 (mandatory) | WS08 | `ChatModelCatalog.swift` | WS09 (B, owns the file) | In `init`, `providersObserver = NotificationCenter.default.addObserver(forName: .mantaProvidersChanged, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.reload() } }`; token in `private var providersObserver: NSObjectProtocol?` (removed in `deinit`). Provider: `Notification.Name.mantaProvidersChanged` (WS08, `ProviderConnectionModels.swift`). `reload()` goes through `currentClient()` and also refetches `models:picker`. | `ModelsStoreTests.testProvidersChangedReloadsCatalog`: a loaded catalog re-fetches `opencode:models` (and `models:picker`) exactly once after the notification. | WS08 (A) |
| M-03-5 | WS03 | `ChatModelStore.swift` | WS09 (B, D1) | `@Published private(set) var agentsLoadError: String?` + `func retryAgents()` exactly as requested (`03-composer.md:597`); `loadAgentsIfNeeded()` records the error and leaves `agents` nil; `retryAgents()` clears the error, resets `didLoadAgents`, reloads. M-03-6 (IB) consumes them. | `ModelsStoreTests.testAgentsLoadErrorThenRetry` | — |

No other request targets a WS09-owned file (`UsageMeters.swift`,
`ModelPickerSheet.swift`, `ChatModelCatalog.swift`, `ChatModelStore.swift`)
in specs 01–08 and 10 or the canonical ledger. M-09-9 is an outbound request
created by SF-M18.

## Contracts provided / consumed

- **C1 provided**: `MantaAPIClient+Models.swift` (Client members).
- **Server provided (D24)**: the channels and frames in "Server-first" and the
  capability ids `models-table-1`, `models-picker-1`, `models-unidentified-1`,
  `models-price-form-1`, `ledger-view-1`, `optimizer-view-1`, `usage-resume-view-1`,
  `usage-alerts-1`, `usage-window-tone-1` (appended to `boxCapabilities.mjs` in
  wave B, M-09-srv-2).
- **Provided to WS02/WS03/WS08 (M-09-9)**: `UsageMeters.band(_ window:)`.
- **C4**: no ChatScreen mount other than M-09-5. Seat row is WS02's (D17).
- **D16 consumed from WS04**: `SessionListStore.unarmedStoppedCount`,
  `refreshStopped() async`. The resume sheet no longer reads
  `stoppedRecords` / `stoppedLastLooked` (it renders `usage-stopped:view`);
  WS04's row markers are unchanged.
- **Provided to WS03**: `ChatModelStore.agentsLoadError`, `retryAgents()` (M-03-5).
- **Consumed**: `MantaEventStore.addRawFrameHandler` and `$connectionState`;
  WS08 `Notification.Name.mantaProvidersChanged` (M-08-1); WS10
  `Notification.Name.mantaBoxRemoved`; C6 untouched.
- C2/C3/C5: none (no `streamInterp.mjs` frame). C7: tests as listed.

## Cross-spec dependencies

- **WS11 D4 (wave D)** must add to its deletion list: `routingCatalog.ts`'s
  `matcher` + `createModelIndex` use, once `AccountsCard.tsx` (`:278-306,577,684,702`)
  no longer reads it. WS09 keeps it intact in wave B (server-first review
  finding 2).

- **Stopped state — two channels, decided (master D29):** WS04's built
  `usageStoppedList()` + `SessionListStore.stoppedRecords` / `unarmedStoppedCount`
  stay the source for ROW MARKERS and the M-09-2 capsule count; WS09's
  `usage-stopped:view` drives ONLY the resume screen (and `usage-stopped:apply`
  its writes). Neither replaces the other in waves B/C; WS11 D7 may later feed
  row markers from `windowStatus.stopped`, migrating M-09-2 in the same step.
- **WS02 (same wave)**: `src/server/boxCapabilities.mjs` (WS09's ids appended
  by IB, M-09-srv-2) and `src/shared/formatTokens.mjs` (consumed) — master
  D25/D26. Client detection stays the unknown-channel error and absent fields
  (both clients), exactly as WS06/WS07.
- **WS11 follow-ups**: M3 (effective selection + fast/plan toggles); seat-row
  custom help text (`AccountsCard.helpText`, U4) — it now imports the shared
  `describeMissing`.

## Deferred

- ~~Model tier tag + guide blurb~~ — **no longer deferred**: `models:table`
  carries `tier` and the guide blurb in `description` (the box has
  `describeModel`).
- **Push notification at 90 % / limit**: none, by decision (D24) — in-app on
  both clients. "Remind me at reset" keeps its existing notify job.
- **Optimizer per-session savings list**: desktop shows only the count too.
- **Desktop's "restart opencode" banner** after subagent changes: removed (V2
  hot-applies; the box returns the outcome).
- **M3** effective-selection/fast/plan move: MOVE-LATER (WS11 follow-ups).
- **Desktop defects found (D10)**: the zero-selection resume guard
  (`UsageResumeModal.tsx:229-230`), the year-out reminder (`App.tsx` +
  `schedule.mjs:258-284`) and the fire-and-forget Apply are now FIXED via the
  shared server modules (SF-M15/M17), not reported-only.

## Open questions

1. Weekly ≥ 90 %: the per-chat weekly banner (existing) and the new app-level
   warn banner can both show once. Default: keep both.
2. ~~Should `models:unidentified` replace the desktop derivation?~~ Resolved by
   D24: yes.

## Review responses (round 1)

WS09 review (`reviews/round1/09-models-usage.md`):

1. **BLOCKING, Sub mutation contract** — F1: explicit outcome table
   (failed / partial "Preference saved, but the subagent list on the box
   wasn't updated" with Retry of sync only / saved); `ModelsTable.subOutcome`
   checks the returned `SubagentDef[]` against the reconcile rules, including
   the `[]`-on-read-failure case as `.unverified`; "Nothing was changed" only
   when the first call failed; catalogue reload failure never downgrades a
   save. Store tests for config-OK+sync-throws, config-OK+old-list,
   reload-failure-after-success.
2. **BLOCKING, Apply enabled state** — F6: enabled iff `applyPlan` has any arm
   or disarm (`canApply`), title "Update" for a disarm-only plan; tests for one
   armed row unchecked, all unchecked, no-change. Desktop defect recorded under
   Deferred (report only, D10).
3. **BLOCKING, picker paths** — F1: all three selection paths enumerated with
   code refs; one `ChatModelStore.isSelectable` policy over `deactivatedMain`
   and `effectiveOptIns` used by catalogue render + `select` guard, recents
   (render filter + `apply` guard) and fast toggle (`selectableModels`); active
   model kept for display only. Tests: hidden recent, hidden fast twin,
   desktop-opted-in deprecated model selectable.
4. **BLOCKING, silent opt-in failure** — F1: `ChatModelStore.optIn` is async
   with `optInPending` spinner and a visible `optInError` + Try again; fresh
   `config:get` merge before writing; confirmed box value mirrored via
   `catalog.applyConfig`; local mirror updated only on success. Tests for a
   rejected write and a concurrent addition. Unresolved-owner wording removed
   (D1).
5. **SHOULD, F4 row disappearance** — F4: outcome decided from the refreshed
   rows (`declareOutcome`): resolved → row disappears; still listed → "Identity
   saved — Auto still needs: …" with the editor pre-selected; separate
   acceptance criteria; server + Swift tests for an identity-only candidate.
6. **SHOULD, box-switch lifecycle** — new "Box lifecycle" section: generation
   counter + `resetForBoxChange()` on `UsageAlertsStore` and `ChatModelCatalog`,
   late responses dropped, actions refused for older generations, triggered by
   M-09-4 (`commitPairing` switch branch) and WS10's `mantaBoxRemoved`. Tests
   for a late old-box response (pure `UsageBaseline` + store tests).
7. **SHOULD, reconnect/seed ordering** — F7: Combine subscription to
   `$connectionState` with drop→connect detection (never the single-owner
   `resyncHandler`); `UsageBaseline` rejects a seed overtaken by a newer frame
   and suppresses alerts until a baseline exists; reconnect reseed diffs
   against the old baseline. Tests for delayed seed, frame-before-baseline,
   reconnect with missed update.
8. **SHOULD, expired sticky alert** — F7: `actionPolicy(…, now:)` returns
   `.expired` after `resetsAt`; re-checked at tap with "This window has already
   reset" feedback and no job; alerts retired on level drop or reset time;
   buttons hidden once expired. Test for a sticky alert acted on after expiry.
   No server change.

Cross-cutting review (`reviews/round1/00-cross-cutting.md`):

- **#6 duplicate client members** — `usageStoppedList` removed from WS09; full
  member inventory under "Client members".
- **#7 wave-B shared-file edits** — every SessionListView / MantaAppRoot /
  SettingsScreen mount is assigned to Integration B (D18); WS09 edits none of
  those files.
- **#9 stopped-state ownership** — WS09's `UsageStoppedStore` deleted; F6 reads
  WS04's `stoppedRecords` (D16); WS04's row marker is not asked to change.
  New dependency: `stoppedLastLooked` (Cross-spec dependencies).
- **#10 package / pbxproj** — Foundation-only files listed as a manifest for
  Integration B; WS09 does not touch `Package.swift`, `project.yml` or the
  `.pbxproj`.
- **#11 seat row** — F8 and `UsageSeatLine` removed (D17).

## Review responses (round2)

WS09 review (`reviews/round2/09-models-usage.md`):

1. **BLOCKING, client not rebound to the new box** — "Box lifecycle": both
   singletons replace their fixed `api` with a per-box client built by
   `currentClient()` from ONE credentials snapshot (URL + captured token from
   the same box), via the pure `ModelsBoxBinding.resolve` (unpaired → no
   request; same → reuse; rebind with/without reset). `resetForBoxChange()`
   invalidates the client. Tests: pure binding decisions
   (`ModelsBoxBindingTests`) and Mac store tests asserting request host +
   `Authorization` for unpaired→paired and A→B, plus late-response rejection.
   M-09-4 now also hooks the `mantaBoxRemoved` path.
2. **BLOCKING, `stoppedLastLooked` type** — (reconciled after round 2) F6
   consumes WS04's `Double?` epoch ms unchanged, no conversion; entries carry
   `stoppedAtMs` (epoch ms, pinned). Stale "WS04 has not provided" text
   removed. Tests: nil, equal, 1 ms before, 1 ms after (all in ms).
3. **BLOCKING, `UsageStoppedEntry` in an excluded file** — the struct is
   declared in `UsageResumeLogic.swift` (package); the sheet file holds only
   the `init(_ record: SessionStoppedRecord)` extension, the capsule and the
   view. Manifest lists exact files; IB must run `verify.sh` with the resume
   tests compiling without the sheet file.
4. **SHOULD, stale received-mount check** — "Mounts applied by this
   workstream" now records M-08-1 (observer + `testProvidersChangedReloadsCatalog`)
   and M-03-5; WS02's legacy "M4" noted as the same request as M-09-5; M-09-6
   recorded as accepted.
5. **SHOULD, unsupported refresh mistaken for success** — `declareOutcome`
   takes the whole `UnidentifiedList?`; only `supported == true` with the key
   absent is `.resolved`; `supported:false` → `.catalogueUnavailable` ("Saved.
   Manta couldn't load the model catalogue …"). Test: successful write →
   unsupported refresh.

Cross-cutting (`reviews/round2/00-cross-cutting.md`):

- **#4 M-03-5/M-03-6** — WS09 implements `agentsLoadError` + `retryAgents()`
  in `ChatModelStore` (F1, received-mount table, store test); plan chip reads
  "unavailable" rather than loading forever on an error. M-03-6 (IB) is
  unblocked by this commit.
- **#10 ledger integrity** — mount tables now use only current IDs matching the
  consolidated ledger (M-09-1…6, manifest row); superseded draft IDs moved to a
  history line; M-08-1 and M-03-5 receipts added; M-09-2 uses WS04's exact
  `unarmedStoppedCount`; M-09-6 marked accepted; the stale "no request targets
  my files" claim removed.

## Review responses (server-first)

Brief: `_serverfirst-revise-brief.md`; authority D23/D24 and
`server-first-audit.md` §WS09.

- **Folded MOVE-NOW items:** M1, M2, M6, M7, M9, M10, M11, M13, M14, M15, M16,
  M17, M18 (tone). New section "Server-first (D23/D24)" pins each module,
  channel/field, JSON shape, errors and node tests; "Desktop migration" lists
  every desktop file switched and every function deleted (no parallel
  implementation; the D7 desktop-parity fixture is withdrawn).
- **iOS rewritten to render:** F1 (`models:table` / `models:picker`, writes via
  `models:set-*` / `models:opt-in`), F2/F3 (`view` blocks; chart geometry kept,
  M8), F4 (`models:unidentified` rows with `help`/`actions`; `models:declare`),
  F5 (`unpricedByProvider`, `models:set-price`), F6 (`usage-stopped:view` /
  `:apply` with box `canApply`), F7 (box `usage.alert` frames + `usage:alerts`
  + `usage:remind-at-reset`; no baseline/seed logic on the phone). Deleted from
  the iOS plan: `ModelsTable`, `ModelsPicker`, `ModelsConfig`, `ModelsInsights`,
  `OptimizerLogic` rules, `ModelsIdentify` rules, `ModelsPricing`,
  `UsageResume` ports + `UsageStoppedEntry`, `UsageEscalation`,
  `UsageBaseline`.
- **D24 decisions applied:** desktop consumes `models:unidentified`; usage
  alerts are box-computed and in-app only on both clients (no `fireNotify`);
  deprecated-model opt-ins live in box config with a one-time iOS copy
  (`models:opt-in {keys}` from `DeprecatedModelOptIns`, per-box flag).
- **Wire compat:** additive only; capability ids listed (WS11 U5 publishes
  them); until then unknown-channel / absent-field gates with "Update your box
  to use this." and the specific picker / alerts / meter-tone degraded states.
- **Mounts:** new M-09-srv-1 (`rpc.mjs`, IB, server order 02 → 07 → 09 → 06);
  desktop shared-file rows M-09-dsk-1…5; new M-09-7 (meter callers switch to
  `UsageMeters.band(_ window:)`) and M-09-8 (`UsageWindow.tone`). No
  `index.mjs`/`streamInterp.mjs` rows: alerts and tone are wired inside
  `usage.mjs`.
- **Client members:** replaced by the server-first set; `modelsSyncSubagents`,
  `setModelCost`, `usageStoppedArm/Disarm`, `scheduleCreate` removed.
- **Rejected:** M18 `role` field (evidence in "Server-first → Rejected").
- **Un-deferred:** the model tier tag (D8) — the box now supplies it.
- **Reconciliation (master "Reconciliation log (server-first)"):** capability
  ids renamed to the master format (`models-table-1` …) and appended in wave B
  by IB (new M-09-srv-2) to WS02's `boxCapabilities.mjs`; `formatTokens.mjs`
  is created by WS02 (D26) and only consumed here; App.tsx/store.ts are WS09's
  own wave-B edits, the WS02-owned shared desktop files get WS09's hunks via IB
  (D27); mount IDs renumbered to the canonical ledger: M-09-7 = Package
  manifest (unchanged), M-09-8 = `UsageWindow.tone`, M-09-9 = band call sites
  (was M-09-7 in the server-first draft); stopped-state split recorded (D29).

## Review responses (server-first review)

WS09 review (`reviews/server-first/09-models-usage.md`):

1. **BLOCKING, reconcile outcome swallowed** — SF-M1: new additive
   `providers.syncSubagentsDetailed` (`read`/`write`/`reload` status) is the
   single reconcile implementation; `syncSubagents` projects `.agents`
   (byte-identical for `opencode:sync-subagents`). `subOutcome(detail)`
   replaces the before/after heuristic; set-sub, retry-sub-sync AND opt-in all
   use it, with `applied` / `not-applied` (retry) / `saved-not-live` (no retry,
   restart hint). Same `editConfig` writer. Tests for failure vs successful
   no-op, reload failure, and partial feedback/retry on both clients.
   `providers.mjs` ledgered to WS09 — **master edit:** the "Wave-B shared
   desktop / server file ownership" WS09 server row now lists `providers.mjs`
   (and the new `rpc.models.test.mjs`).
2. **BLOCKING, matcher removal breaks Accounts** — `routingCatalog.ts` is not
   edited in wave B; only `ModelsWeCouldntIdentify.tsx` stops using the
   matcher. Final deletion handed to WS11 D4 (Cross-spec dependencies).
   **Master edit:** the WS09 desktop ownership row marks `routingCatalog.ts`
   "not edited in B".
3. **BLOCKING, re-export leaves `helpText` unbound** — AccountsCard now
   imports `describeMissing` from the shared module (local binding) and
   re-exports it (`AccountsCard.test.ts` keeps compiling); verification =
   typecheck + `AccountsCard.test.ts`.
4. **BLOCKING, live frames undecorated** — SF-M18 decorates the source arrays
   once and uses them for the caches, `observe` AND the `usage.updated`
   publish (code pinned); test asserts the published payload of a second,
   changed tick.
5. **SHOULD, missed retirements** — SF-M16 adds `bootId` + `revision` to frames
   and `usage:alerts`; one client reconciliation contract (snapshot prunes
   absent ids, older snapshots dropped, older frames ignored, bootId reset,
   dismissed ids stay seen) implemented by iOS `UsageAlertQueue` and desktop
   `usageAlertsQueue.ts` with the disconnect→retire→reconnect and
   in-flight-race tests.
6. **SHOULD, false "nothing changed"** — SF-M13 uses additive
   `providers.setModelCostDetailed`; written-but-not-reloaded is `ok:true` with
   a `warning` (the optimizer reads the config file, so prices are in effect);
   "Nothing was changed" only when nothing was written. Tests added.
7. **SHOULD, last-looked input** — `buildResumeView` takes the full
   `{records, lastLooked}` envelope (listStopped's shape); D29 split restated;
   isNew/stamp tests pinned.
8. **SHOULD, iOS resume refresh** — `UsageResumeModel` reloads on
   `usage-stopped.updated` and reconnect via `UsageAlertsStore` subjects
   (lifetime-bound cancellables), seq-guarded responses, shared
   selection-reconcile rule (iOS `UsageResumeSelection`, desktop
   `reconcileResumeSelection`), dry run invalidated + re-run; second-device
   test on both clients.

Cross-cutting (`reviews/server-first/00-cross-cutting.md`):

- **B1 provider contract** — every M-09-srv-1 import is now a pinned export
  with its factory deps and returned method surface (`createModelsTable` incl.
  `retrySubSync`, `createModelsUnidentified`, `withLedgerView`,
  `withSummaryView`/`withSeriesView`, `withUnpricedGroups`,
  `createModelsPricing`, `createUsageResumeView`, `createUsageAlerts` /
  `getUsageAlerts`); the mount row carries the exact registration code and an
  integration smoke test (`rpc.models.test.mjs`) exercising every new channel.
- **B2 AccountsCard binding** — as finding 3.
- Also applied the new user rule (research libraries first): section
  "Libraries considered".

