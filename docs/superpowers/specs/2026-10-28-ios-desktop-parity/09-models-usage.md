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
`MantaUIApp.swift:38`). It holds the usage snapshots, the alert baseline and
queue, the visible chat id and the "resume sheet presented" flag. Stopped
records are NOT stored by WS09: per D16 they come from WS04's
`SessionListStore.stoppedRecords`. The banner overlay and the resume sheet
are mounted in `MantaAppRoot` by integration agent B (D18).

### Box lifecycle (applies to every WS09 app-wide state)

The app can switch boxes without relaunching (`MantaAppRoot.swift:185-201`
`commitPairing` with `flow.isSwitching`; `:235-240` `beginSwitch`), and WS10
posts `Notification.Name.mantaBoxRemoved` on "Remove server". WS09 has two
process-wide singletons, `UsageAlertsStore.shared` and
`ChatModelCatalog.shared`. Both:

- keep `private var generation = 0` and `private(set) var boxKey: String?`
  (`KeychainCredentialStore.shared.boxId ?? serverURL?.absoluteString`,
  captured when a seed starts);
- expose `func resetForBoxChange()`: `generation += 1`, cancel in-flight
  tasks, clear all published state (snapshots, baseline, queue,
  `activeSessionId`, `resumeSheetPresented`; for the catalogue: models,
  defaults, `deactivatedMain`, `configOptIns`, `loaded = false`,
  `didStart = false`). Nothing is fetched until the new box's stream connects;
- drop any response whose captured `generation` differs from the current one
  (a late old-box answer can never land on the new box);
- call `resetForBoxChange()` themselves on `mantaBoxRemoved`, and are called by
  mount M-09-4 in `commitPairing`'s `isSwitching` branch, right after
  `sessionStore.resetForBoxChange()`;
- refuse actions (Remind, Keep going) whose alert was raised under an older
  generation.

The pure part — "is this response still current?" and the baseline ordering
in F7 — lives in `UsageBaseline` (Foundation-only, F7) so it is tested under
`verify.sh` (D19).

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

Keys are always `"<providerID>/<modelID>"`. `defaultModel: null` must be sent
as `NSNull()` (`MantaAPIClient.makeRequest` uses `JSONSerialization`, `:918`).
No `/events` frame is involved.

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

### iOS design

New files:

- `ModelsStore.swift` — `@MainActor final class ModelsStore: ObservableObject`
  holding `phase` (`.loading/.loaded/.failed(String)`), `models`,
  `config: ModelsConfig` (the five keys above, decoded from `config:get`'s
  `[String: JSONValue]`), `busyKey: String?`, `feedback: ModelsFeedback?`
  (`.saved(String)` auto-clears after 3 s, `.failed(String)` stays until
  dismissed; `.partial(String, retry: ModelsRetry)` stays until dismissed or
  retried). It also keeps `agents: [ModelsSubagentDef]` — the last
  `opencode:sync-subagents` answer — as the baseline for verifying Sub changes.
  On `load()`: `models()` + `configGet()` concurrently, then `syncSubagents`
  with the loaded sets (desktop runs it on every load,
  `ModelsCard.tsx:200-205`); its answer seeds `agents`.
  Actions: `setDefault`, `toggleMain`, `toggleSub`, `enableDeprecated`,
  `saveOverride`. Each sets `busyKey`, awaits, takes local state from the
  RETURNED config, calls `ChatModelCatalog.shared.reload()`, and sets
  `feedback`. The outcomes are explicit, because some actions are TWO box
  calls and the first one persists before the second runs (`config:update`
  writes the preference, `rpc.mjs:848-861`; `syncSubagents` then returns the
  OLD agent list instead of throwing when its own write fails,
  `providers.mjs:808-823`):

  | Action | Calls | Outcome rules |
  |---|---|---|
  | `setDefault`, `toggleMain`, `saveOverride` | one `config:update` | throw → `.failed("Couldn't save — <reason>. Nothing was changed.")`, local state untouched. Resolved → `.saved`. |
  | `toggleSub`, `enableDeprecated` | `config:update`, then `syncSubagents` | (a) `config:update` throws → `.failed("… Nothing was changed.")`. (b) config OK, sync throws OR `ModelsTable.subOutcome(...)` says `.notApplied` / `.unverified` → `.partial("Preference saved, but the subagent list on the box wasn't updated. Try again to apply it.", retry: .sync)` — local toggle reflects the SAVED preference; NO "nothing was changed". Retry re-runs only `syncSubagents` with the current sets. (c) both OK and `.applied` → `.saved`. |
  | catalogue reload after any success | `ChatModelCatalog.shared.reload()` | a reload failure never turns the action into a failure; the catalogue keeps its previous lists and the picker shows them (the save itself is confirmed). |
- `ModelsScreen.swift` — the screen above. F1 parts:
  - Footer of the "Models" section: the desktop explainer, reworded to the
    iOS controls: "Default is the model new and cleared sessions start on.
    In picker shows it in the chat's model picker. Subagent lets agents
    dispatch work to it."
  - "Default" section: one row, `<name>` + providerID secondary, or "No default
    set — opencode default (server decides)" in `tx3`.
  - `.searchable(text:, prompt: "Search models")`, filter via
    `ModelsTable.matches`. No results → `ContentUnavailableView.search`.
  - Row (`ModelsRow`): name, providerID, context chip (`ChatModel.contextSize`),
    "deprecated" chip, a checkmark when it is the default, and two small status
    glyphs ("In picker", "Subagent") so the state reads without opening.
    Deprecated-not-opted-in rows render at reduced opacity.
  - Tap → `ModelsDetailSheet` (medium/large detent).
  - Swipe action (trailing) "Make default" when allowed; leading
    context menu mirrors the detail sheet's toggles.
- `ModelsDetailSheet.swift` — `Form`:
  - Header: name, `providerID / id`, context chip.
  - If deprecated & not opted in: callout "This model is deprecated." + button
    "Enable deprecated model" (sub-caption "Also registers it as a subagent").
    All other controls are **not rendered** until enabled (no dead controls).
  - `Toggle("Show in model picker")` (Main) — when turning off the current
    default, a confirmation dialog: "This is your default model. Hiding it
    also clears the default." [Hide and clear default] [Cancel].
  - `Toggle("Available as subagent")` (Sub).
  - Button "Make default" — disabled with footer "Turn on Show in model
    picker first." when Main is off; reads "Default model ✓" (disabled) when
    already default.
  - Section "Display" → "Edit name, description, context" pushes
    `ModelsEditForm` (TextField name, TextField description (axis vertical),
    TextField context `.numberPad`; footer "Leave a field blank to keep the
    provider's default for it."; Save / Cancel). Save builds the override with
    `ModelsTable.override(draft:model:)` and writes the whole `modelOverrides`
    map (read-modify-write from a fresh `config:get`, like desktop).
  - Busy: the row/sheet shows a `ProgressView` in place of the changed
    control; controls disabled while `busyKey == key`.
- Picker honours Main + box opt-ins (owned edits, `ChatModelCatalog.swift`,
  `ChatModelStore.swift` (D1), `ModelPickerSheet.swift`):
  - `ChatModelCatalog`: add `@Published private(set) var deactivatedMain:
    Set<String>`, `@Published private(set) var configOptIns: Set<String>`
    (both parsed from the same `config:get` it already makes),
    `func reload()` (refetch the three reads and republish; coalesces into one
    in-flight `Task`; a failed read keeps the previous value),
    `func applyConfig(_ cfg: [String: JSONValue])` (re-derive
    `configDefault`/`deactivatedMain`/`configOptIns` from a config the caller
    already holds), and the box lifecycle above. It observes
    `Notification.Name.mantaProvidersChanged` (WS08, posted after a provider
    connect/disconnect/endpoint change) and calls `reload()`.
  - **One selection policy** in `ChatModelStore`:
    `var effectiveOptIns: Set<String> { deprecatedOptIns ∪ catalog.configOptIns }`
    and `func isSelectable(_ m: OpencodeModel) -> Bool` =
    `ModelsPicker.isSelectable(m, deactivatedMain: catalog.deactivatedMain, optIns: effectiveOptIns)`
    (enabled != false, key not in `deactivatedMain`, and not
    deprecated-without-opt-in — desktop `mainPickerGroups`,
    `chatUtils.ts:2452-2470`). `selectableModels` = `models.filter(isSelectable)`.
    Every selection path uses it:
    1. catalogue: `ModelCatalogueView.groups` drops `deactivatedMain` keys
       (`ModelsPicker.catalogueVisible`); the disabled-row look AND
       `select(_:)`'s guard both use `effectiveOptIns` (a model opted in on
       desktop renders enabled and its tap selects);
    2. recents: the chip list is `ModelsPicker.visibleRecents(recents, models:,
       deactivatedMain:, optIns:)` — a recent whose model is hidden or
       deprecated-not-opted-in is not rendered; `ChatModelStore.apply(_:)`
       also returns early (no state change) for such a choice;
    3. fast toggle: `setFast` and the sheet's `fast` computation call
       `ChatModel.fastToggle(models: selectableModels, …)`, so a hidden or
       locked twin reads "No fast mode for this model" (desktop passes the
       selectable list to `resolveFastToggle`, `chatUtils.ts:2389-2395`).
    The ACTIVE model is still shown in the identity card even if it has since
    been hidden (`ChatModel.activeModel` over the unfiltered list) — that is
    display only; it does not make any hidden model a selectable alternative.
  - **Opt-in becomes a box write** (desktop `store.optInModel`,
    `store.ts:1186-1193`): `ChatModelStore.optIn(_:) async` with
    `@Published private(set) var optInPending: Set<String>` and
    `@Published var optInError: (key: String, message: String)?`. Steps:
    insert key into `optInPending` (row's Enable button becomes a spinner) →
    fresh `config:get` → `ModelsPicker.mergedOptIns(fresh: cfg.optInModels,
    adding: key)` (so another device's newer opt-ins are never dropped) →
    `config:update {optInModels: merged}` → `catalog.applyConfig(returned)`
    (the CONFIRMED box value becomes `configOptIns`) → also insert into the
    local `DeprecatedModelOptIns` (legacy mirror, kept so an older box still
    works) → remove from pending. On any throw: no local change, row stays
    disabled, `optInError` = "Couldn't enable <name> — <reason>." shown as an
    inline row line with a "Try again" button that calls `optIn` again. An
    older box that rejects the key cannot happen (`config:update` merges any
    key, `local.mjs`).
    The disabled row's `Button("Enable")` (`ModelPickerSheet.swift:438`)
    becomes `Task { await modelStore.optIn(m) }`.

### Pure logic — `ModelsTable` (in `ModelsLogic.swift`)

```swift
enum ModelsTable {
  static func key(_ m: OpencodeModel) -> String                         // "p/id"
  static func matches(_ m: OpencodeModel, description: String?, query: String) -> Bool
  struct RowState: Equatable { let isMain, isSub, isDefault, deprecatedLocked: Bool; let canMakeDefault: Bool }
  static func rowState(_ m: OpencodeModel, config: ModelsConfig) -> RowState
  /// The config patch for a Main toggle; includes `defaultModel: NSNull` when hiding the current default.
  static func mainPatch(key: String, turnOn: Bool, config: ModelsConfig) -> (deactivatedMain: [String], clearsDefault: Bool)
  static func subList(key: String, turnOn: Bool, config: ModelsConfig) -> [String]
  static func optInList(adding key: String, config: ModelsConfig) -> [String]
  static func override(draft: ModelsEditDraft, model: OpencodeModel) -> ModelOverrideDraft  // only differing, non-blank fields; context must be finite > 0
  static func syncPayload(_ models: [OpencodeModel]) -> [[String: Any]]   // {providerID,id,name,status?}
  enum SubOutcome: Equatable { case applied, notApplied, unverified }
  /// Mirrors reconcileSubagents (subagentSync.mjs:94-122): ON expects an agent
  /// with model == key afterwards (unless the model is deprecated and not opted
  /// in → .applied, nothing to register); OFF expects fewer agents with
  /// model == key than `before` (or none before → .applied). An EMPTY `after`
  /// while `before` was non-empty is `.unverified` — syncSubagents returns []
  /// when it could not read opencode.jsonc (providers.mjs:808-813).
  static func subOutcome(key: String, turnOn: Bool, deprecatedLocked: Bool,
                         before: [ModelsSubagentDef], after: [ModelsSubagentDef]) -> SubOutcome
}

enum ModelsPicker {
  static func isSelectable(_ m: OpencodeModel, deactivatedMain: Set<String>, optIns: Set<String>) -> Bool
  static func catalogueVisible(_ models: [OpencodeModel], deactivatedMain: Set<String>) -> [OpencodeModel]
  static func visibleRecents(_ recents: [ModelChoice], models: [OpencodeModel],
                             deactivatedMain: Set<String>, optIns: Set<String>) -> [ModelChoice]
  static func mergedOptIns(fresh: [String], adding key: String) -> [String]   // order-preserving union, no dupes
}
```

`ModelsSubagentDef { name: String; model: String; description: String }`
decodes `SubagentDef` (`providers.mjs:392-401`).

### Tests — `MantaUITests/ModelsTests.swift`

- `rowState`: deprecated & not opted in → all false, `deprecatedLocked`;
  opted-in deprecated behaves like live; Main off → `canMakeDefault == false`.
- `mainPatch`: hiding the default sets `clearsDefault`; hiding a non-default
  does not; turning on removes the key; result has no duplicates.
- `subList` / `optInList` idempotent (adding an existing key is a no-op).
- `override`: blank fields omitted; unchanged name omitted; `"0"`, `"-5"`,
  `"abc"` context ignored; all-unchanged → empty (caller deletes the key).
- `matches`: name/provider/id/description, case-insensitive; empty query
  matches all.
- `ModelsConfig` decode from a `[String: JSONValue]` with missing keys →
  empty sets / nil default; `defaultModel: null` → nil.
- `subOutcome`: ON with the agent present → applied; ON still absent →
  notApplied; ON for a locked deprecated model → applied; OFF removed →
  applied; OFF still present (old list returned after a failed write) →
  notApplied; OFF with empty `after` and non-empty `before` → unverified; OFF
  with nothing before → applied.
- `ModelsPicker.isSelectable`: deactivated → false; deprecated without opt-in
  → false; deprecated opted in on the box only (`optIns` from config) → true;
  `enabled:false` → false.
- `visibleRecents`: a recent whose model is hidden from the picker is dropped;
  a recent of a deprecated model opted in on desktop is kept; a recent whose
  model no longer exists is dropped.
- fast twin: `ChatModel.fastToggle(models: selectable…)` with the `-fast` twin
  deactivated → `available == false`.
- `mergedOptIns`: keeps keys added by another device; adding an existing key
  is a no-op; order preserved.

Store tests (Mac-only, `MantaUITests/ModelsStoreTests.swift`, injected
`MantaAPIClient` via a `URLProtocol` stub — same seam as
`MantaActionRPCWireTests`):
- config OK + sync throws → `.partial`, toggle shows the saved preference,
  Retry re-runs only sync.
- config OK + sync returns the old list → `.partial`.
- config throws → `.failed`, no state change.
- action OK + catalogue reload throws → still `.saved`; picker keeps the old
  list.
- `ChatModelStore.optIn`: rejected write → row stays disabled, `optInError`
  set, no UserDefaults change; concurrent addition (fresh `config:get` already
  holds another key) → the written list holds both keys.
- `ChatModelCatalog`: `resetForBoxChange()` then a late old-generation
  response → ignored.

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
make every other field optional/defaulted.

### iOS design

`ModelsLedgerScreen.swift` (pushed from "Insights"): a `List` with
- Section "Bill split": a 24pt `HStack` bar of four `Rectangle`s with
  `frame(width: geo * share)`, segment colours from `Theme` tokens (`danger`,
  `warn`, `accent`, a neutral fill), legend rows (swatch · label · %), footer
  = the "Cache is …" caption.
- Section "By model": rows `key` (monospaced caption) with trailing
  `Total`; secondary line "N turns · $x/turn · N tok/s". Empty → "No model
  spend recorded."
- Section "By agent": same shape, "subagent" chip.
- States: loading → `ProgressView("Reading your history…")`; unsupported →
  the sentence; fetch error → **unlike desktop, show** "Couldn't load spend
  history — <reason>" with a Retry button (a pushed screen that silently shows
  nothing would be a dead destination). Pull-to-refresh refetches.

### Pure logic — `ModelsInsights` (in `ModelsInsightsLogic.swift`)

`money(Double) -> String` ("$1.20"), `wholePct(fraction) -> String`,
`segments(cacheShare) -> [(kind, pct: Int, showsInlineLabel: Bool)]` (order
fixed; inline label iff pct ≥ 4), `cacheCaption(cacheShare) -> String`,
`topModels(_:limit:6)`, `agentLabel(agent:) -> String` (nil → "main").

### Tests — `MantaUITests/ModelsTests.swift` (ledger section)

Segment order + rounding; 3% segment has no inline label; caption uses
cacheRead+cacheWrite; `{supported:false}` decodes; topModels caps at 6;
nil agent → "main".

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
| `config:get` | `[]` | `optimizerEnabled: Bool` for the On/Off state |

Decode tolerantly: `actualTrimmedTokens`/`potentialTrimmedTokens` default 0,
falling back to `maskedTokens` for potential (desktop `:233-234`); `ttl`,
`compaction`, `activity`, `metered`, `windows` optional.

### iOS design

`OptimizerScreen.swift` (pushed from "Insights"), `List` sections in the
desktop order. Native mapping:
- Switch block → Section header "Manta optimized token usage" with trailing
  "On"/"Off" capsule; body text; sub-rows as `LabeledContent`. Footer:
  "Change this in Settings → Models." (the toggle lives in the schema form —
  no second toggle).
- Windows → one row each with a custom `OptimizerGauge` (capsule track,
  filled fraction, 2pt forecast tick) + meta line + pressure chip.
- Chart → Swift Charts (`import Charts`): `AreaMark`+`LineMark` for cumulative
  sent, `LineMark` with `StrokeStyle(dash:[5,4])` for raw; x = `Date(t)`,
  axis values from `OptimizerLogic.axisTicks`. `Picker(.segmented)` for the
  range above it. Stats as a 2-column `Grid`.
- Activity → rows; rolled-back rows `.strikethrough()` headline + `tx3`.
- Loading/unsupported/error as F2 (error shows Retry; series failure degrades
  only the chart section). Pull-to-refresh refetches both.

### Pure logic — `OptimizerLogic` (in `OptimizerLogic.swift`)

```swift
enum OptimizerLogic {
  static func cacheHitPct(_ share: CacheShare) -> Double
  static func ttlLabel(ms: Double) -> String                    // 3_600_000→"1h", 300_000→"5m", else "Nm"
  static func gaugeBand(_ pct: Double) -> MeterBand              // <60 .ok, 60–84 .warn, ≥85 .danger (NOT UsageMeters.band)
  static func pressure(deficit: Double?, hasSignal: Bool) -> (text: String, tone: PressureTone)
  static func activityText(_ e: OptimizerActivityEntry) -> (headline: String, detail: String)
  struct SeriesTotals: Equatable { let sent, actual, potential, raw: Double; let trimmedPct: Double; let hasCounterfactual, noActivity: Bool }
  static func totals(_ s: OptimizerSeries) -> SeriesTotals
  static func cumulative(_ values: [Double]) -> [Double]         // running sum, non-finite → 0
  static func axisTicks(_ ts: [Double], bucket: String) -> [(index: Int, label: String)]  // mirror chartAxisTicks
  static func savedStat(_ saved: OptimizerSaved) -> (value: String, detail: String, tone: PressureTone)
  static func formatSaved(_ usd: Double) -> String               // "−$1.20" | "≈ $1.20"
  static func worstPressureWindow(_ w: [OptimizerWindow]) -> OptimizerWindow?
  static func emptyWindowText(_ range: String) -> String
  static func noCounterfactualText(_ range: String) -> String
}
enum ModelsFormat { static func tokens(_ n: Double) -> String }  // mirror desktop formatTokens: "950 tokens", "12.3k tokens", "123k tokens"
```

### Tests — `MantaUITests/OptimizerTests.swift`

Every function above: gauge bands at 59/60/84/85; ttl labels incl. 600 000
→ "10m"; pressure no-signal/≤0/positive rounding; activity verdict words +
unknown verdict passthrough + camelCase evidence keys ("rewarmTokens 3" →
"Rewarm Tokens 3"); totals with missing actual (falls back to 0) and
potential falling back to `maskedTokens`; raw excludes potential;
noActivity; cumulative with NaN; axis ticks (≤ budget → one per point, always
first + last, budget 5 hour / 4 day, "14:00" format); saved stat for each
basis and a negative value; summary + series decode from fixture JSON copied
from `src/server/optimizer/*.test.mjs` shapes, plus `{supported:false}`.

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
- The desktop renderer is NOT changed (it keeps its client-side derivation);
  a node test pins that `buildUnidentifiedRows` and the renderer's derivation
  agree on a shared fixture (see Tests).

Reused channels:
- `opencode:model-catalog` (`rpc.mjs:1818`): `[]` →
  `{supported, size, entries: ModelCatalogEntry[]}` (`id,name,family,description,limit{context,output}`, …) — for the editor's typeahead.
- `config:get` / `config:update` for the declaration (read-modify-write of
  `modelRouting`, exactly as `:295-299`).

### iOS design

- `ModelsUnidentifiedSection` (in `ModelsUnidentifiedView.swift`) at the top of
  `ModelsScreen`; loads `models:unidentified` with the screen. Hidden when
  `supported && rows.isEmpty`; catalogue-down sentence when `!supported`; on
  RPC error: "Couldn't check your models — <reason>" + Retry (an unknown-
  channel error on an older box → hide the section).
- Row: title `providerID / modelID` (monospaced), help line from
  `ModelsIdentify.helpText(row)`. Actions:
  - exact certain → trailing "Change".
  - exact probable → "Confirm" + "Change".
  - ambiguous ≤ 4 → `Menu("Which one?")` listing candidates (pick = declare).
  - ambiguous > 4 / none → "Identify…".
- "Change"/"Identify…" push `ModelsIdentifyForm`: `.searchable` catalogue list
  (lazy-loaded `opencode:model-catalog`, filtered by `ModelsIdentify.search`),
  selected entry row with description; Section "Costs here": `Picker`
  segmented [Free, Custom] with **no initial selection** (custom
  `Optional` binding; segmented control shows none selected), two decimal
  fields for Custom; Section "Caching": [None, Custom] default None, toggles
  "Reads" / "Writes" (default on); toolbar Save disabled until
  `ModelsIdentify.canSave`. Footer: "Can't say? Leave it. …".
- Save / Confirm / candidate pick: `ModelsStore.declare(key:decl:)` → fresh
  `config:get`, merge, `config:update {modelRouting}`, then re-read
  `models:unidentified`. The result is decided by the REFRESHED rows, not by
  the action (`ModelsIdentify.declareOutcome(key:, refreshed:)`):
  - key absent from the refreshed rows → feedback "Saved — Auto can now
    describe <modelID>"; the row disappears;
  - key still present (typical after Confirm or a candidate pick, which only
    declare `{catalogId}` — price and caching are endpoint facts that identity
    never supplies, `modelIdentity.mjs:78-88`, `autoEligibility.mjs:42-55`) →
    the row stays, now in its refreshed state, with feedback "Identity saved —
    Auto still needs: <missing phrase>." and its "Change" action opening the
    editor PRE-SELECTED to the declared model so the user can add price and
    caching. An editor Save for that row merges into the existing declaration
    (`catalogId` kept unless changed);
  - refresh fails after a successful write → "Saved. Couldn't refresh the
    list — pull to refresh." (the write is not reported as failed);
  - write fails → inline error "Couldn't save — <reason>. Nothing was changed."

### Pure logic — `ModelsIdentify` (in `ModelsIdentifyLogic.swift`)

`missingPhrase([String]) -> String?` (exact desktop join),
`helpText(row) -> String`, `search(entries, query) -> [CatalogEntry]` (top 30
when empty, else id/name/family substring, cap 50),
`canSave(selected:, priceMode:, costIn:, costOut:) -> Bool`,
`declaration(selected:, priceMode:, costIn:, costOut:, cacheMode:, reads:, writes:) -> [String: Any]`,
`mergedRouting(config:, key:, decl:) -> [String: Any]` (preset default
"balanced", preserves other keys and other declarations; for the same key,
fields of the new declaration overwrite, absent fields keep the existing
value), `declareOutcome(key:, refreshed: [UnidentifiedRow]?) ->
.resolved | .stillNeeds(String) | .refreshFailed`.

### Tests

- `MantaUITests/ModelsTests.swift`: missingPhrase for 0/1/2/4 keys and unknown
  keys; helpText for each state incl. probable with/without evidence and
  "Auto still needs"; canSave matrix (no price / Free / Custom with one rate /
  Custom with none / no selection); declaration (free → `"free"`, custom with
  one blank rate → 0, caching none → `false`); mergedRouting keeps existing
  declarations and preset; same-key merge keeps the earlier `catalogId` when
  the new declaration only adds price; `declareOutcome` resolved /
  stillNeeds (candidate with no price/cache metadata → "what it costs, and
  whether it caches") / refreshFailed.
- `src/server/modelsUnidentified.test.mjs` (node:test): eligible model skipped;
  exact certain/probable; ambiguous with candidates; none; declared catalogId
  wins; a model with only `{catalogId}` declared and no cost stays listed with
  `missing: ["price","caching"]`; empty catalogue → `{supported:false}`.
  Desktop-parity test (D7): a fixture of models + declarations + catalogue
  entries, run through `buildUnidentifiedRows` AND through the same shared
  calls the renderer makes (`resolveIdentity` + `autoEligibility` with
  `providerClass:"supported"`, `ModelsWeCouldntIdentify.tsx:328-390`), asserting
  identical keys/states/missing. The renderer file is not edited. Injected
  catalogue/models; no live opencode, no state files.

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

### iOS design

`ModelsPriceSection` (`ModelsPriceForm.swift`) in `ModelsScreen` (Settings →
Models, not Accounts — WS08 owns Accounts; see M-09-6 for an optional link).
Section header "No prices", footer "The optimizer won't trim a model it can't
price." One `DisclosureGroup` per provider ("<Provider> · N models",
provider name via `UsageMeters.providerLabel`-style fallback to the id); each
model row → "Set prices" pushes `ModelsPriceEditor` (`Form`, four
`.decimalPad` fields with the desktop labels/placeholders "e.g. 3", "e.g. 15",
"e.g. 0.3", "e.g. 3.75", footer = desktop help text, toolbar Save → spinner
"Saving…"). Errors inline under the form (validation and box errors, desktop
copy). Success pops the editor; a section-level confirmation row with the
desktop copy persists until the screen is left. Section hidden when the read
fails or `unpriced` is empty and no notices exist.

### Pure logic — `ModelsPricing` (in `ModelsPriceLogic.swift`)

`parseCostDraft(PriceDraft) -> Result<CostPayload, PriceError>` and
`groupUnpriced([String]) -> [(providerID, models)]` — byte-for-byte ports of
the desktop functions.

### Tests

Port the cases of `src/renderer/ModelPriceForm.test.tsx` that cover the pure
functions into `ModelsTests.swift`: required fields, "1e3"/"0x10"/"-1"/"1,5"
rejected, ".5" and "3." accepted, cache write optional and omitted when blank,
first-slash split ("openrouter/deepseek/deepseek-v4-flash"), malformed keys
dropped, provider and model sort order.

### Acceptance criteria

- [ ] Unpriced models appear grouped by provider; saving valid prices removes
      the model from the list and shows the confirmation; the same model shows
      priced on desktop.
- [ ] Invalid input never reaches the box; a box rejection is shown with the
      desktop sentence.

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

Stopped records are READ through WS04 (D16) — WS09 makes no
`usage-stopped:list` call and declares no stopped-record type:

| Source | Owner | Used for |
|---|---|---|
| `SessionListStore.stoppedRecords: [SessionStoppedRecord]` (fetched from `usage-stopped:list`, `rpc.mjs:2394` → `stoppedStore.mjs:287-290`, refetched on `usage-stopped.updated`) | WS04 §9 | the rows; unarmed count |
| `SessionListStore.stoppedLastLooked: Double?` (the `lastLooked` field of the same `SessionStoppedList` answer) | WS04 — **new dependency, see Cross-spec dependencies** | "new" badges, header text |

Mutations are WS09's own client members:

| Channel | Args | Result |
|---|---|---|
| `usage-stopped:arm` (`rpc.mjs:2396`, `stoppedStore.mjs:162`) | `["<conversation>"]` (positional string) | `null`; publishes `usage-stopped.updated` |
| `usage-stopped:disarm` (`stoppedStore.mjs:181`) | `["<conversation>"]` | `null`; REMOVES the row; publishes the event |
| `usage-stopped:stamp-last-looked` (`stoppedStore.mjs:274`) | `[]` | `null`; publishes the event |
| `usage:list` (existing `MantaAPIClient.usageList`, `:459`) | `[]` | `UsageSnapshot[]` — reset instants (held by `UsageAlertsStore`, F7) |
| `opencode:messages` (existing `MantaAPIClient.messages(sessionId:limit:slim:)`, `:43`) | | snippet |
| `config:get` (existing) | | `cacheTtl` ("5m" default) |

After a mutation the box publishes `usage-stopped.updated`; WS04's store
refetches and the sheet re-renders from `stoppedRecords`. No new frame.

### iOS design

- No stopped store in WS09. The presentation flag lives on
  `UsageAlertsStore.shared` (F7): `@Published var resumeSheetPresented`,
  `func presentResume()`.
- `UsageResumeSheet.swift` — `struct UsageResumeSheet: View` with
  `@ObservedObject var sessions: SessionListStore` and
  `@ObservedObject var usage: UsageAlertsStore`; presented ONCE at app root
  (M-09-3). It maps `sessions.stoppedRecords` → `[UsageStoppedEntry]`
  (WS09's own Foundation value: `workspace, conversation, provider, model?,
  window?, stoppedAt, cachedTokens?, armed`) through
  `UsageStoppedEntry.init(_ record: SessionStoppedRecord)` in the sheet file —
  the only place that touches WS04's type, so the pure logic stays
  Package-buildable. `NavigationStack` + `List`:
  - Header text (desktop copy) as the first section's header.
  - Toolbar: leading "Cancel" (nothing armed) / "Close"; trailing primary
    button titled by `UsageResume.applyTitle(plan:, hasArmed:, selectedCount:)`
    — "Resume N at reset" when nothing is armed yet, else "Update". It is
    ENABLED iff `UsageResume.applyPlan(entries, selected)` has at least one
    arm OR disarm (so unchecking the only armed row and tapping Update works,
    with zero selected); disabled for a no-change plan. A bottom
    `safeAreaInset` bar: "Check all" / "Uncheck all", "s of t selected", and
    the batch-cost line.
  - Sections per workspace; tappable rows (toggle; accessory
    `checkmark.circle.fill` / `circle`) with name, "armed" / "new" chips,
    snippet, provider·model, window chip, cost chip — desktop copy. Footer
    callout for cold selections (desktop copy).
  - Apply: sequential awaits over the plan (arms first, then disarms). Success
    → dismiss + banner (through `UsageAlertsStore`'s queue) "Updated — N
    conversation(s) will carry on at reset." (or "Removed N conversation(s)
    from resume." for a disarm-only plan). First failure → stop, keep the sheet
    open, "Couldn't update <name> — <reason>. The ones after it weren't
    changed." Desktop fires-and-forgets; iOS reports.
  - Dismissal by any route calls `stamp-last-looked` (failure logged only — it
    only clears "new" badges).
  - Snippets: fetched on open, best-effort, per row; responses for a sheet that
    has been dismissed are dropped.
  - Name: `UsageResume.name(for:windows:)` over
    `[(sessionId: String, name: String)]` built from `sessions.projects`
    (`MantaWindow.opencodeSessionId` → `MantaWindow.name`); fallback the id.
  - Empty list (all removed while open): "No conversations are stopped by a
    provider limit right now." with a Close button.
- Session-list entry point (M-09-2): `UsageStoppedCapsule(count:action:)`
  (in `UsageResumeSheet.swift`) — `pause.circle` + N in warn tint, accessibility
  label "N conversation(s) stopped by a provider limit". Shown only when
  `UsageResume.unarmedCount(sessions.stoppedRecords mapped) > 0`; action
  `UsageAlertsStore.shared.presentResume()`.

### Pure logic — `UsageResume` (in `UsageResumeLogic.swift`, Foundation-only)

Ports of `usageResume.ts` over `UsageStoppedEntry`: `unarmedCount`,
`extractLastSnippet(texts:)` (input = assistant text parts newest-last, so it
does not depend on transcript types), `resetAt(entry, snapshots) -> Double?`,
`resumeCost(entry, resetsAt, now, ttl)`, `costs(entries, snapshots, now, ttl)`,
`selectionSummary(entries, selected, costs)`, `isNew(entry, lastLooked)`,
`groupByWorkspace(entries)` (empty workspace → "—"),
`showsStoppedMarker(isStopped:hasPendingAsk:)` (offered to WS04 if it wants
it), plus `headerText(entries, lastLooked)`, `windowChipLabel(entry,
snapshots)`, `windowChipText(entry, snapshots, now)`,
`applyPlan(entries, selected) -> (arm: [String], disarm: [String])`,
`applyTitle(plan:, hasArmed:, selectedCount:)`, `canApply(plan) -> Bool`,
`name(for:windows:)`, `ttlMs(cacheTtl:)` ("1h" → 3 600 000 else 300 000).

### Tests — `MantaUITests/UsageResumeTests.swift` (Foundation-only)

Port `src/renderer/usageResume.test.ts` cases + header singular/plural/armed
variants; `applyPlan` (select unarmed → arm, unselect armed → disarm,
unchanged → nothing); **`canApply`: one armed row unchecked (zero selected) →
true, title "Update"; all armed rows unchecked → true; zero selected and
nothing armed → false; selection equal to armed set → false**;
`windowChipLabel` fallbacks (no window → "Limit", unknown kind →
capitalised); name lookup + fallback; warm/cold boundary exactly at TTL.

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

### Wire contract

- `usage:list` (existing), raw bus frame `kind:"usage.updated"`, payload
  `{snapshots: UsageSnapshot[]}` (full set, `httpApi.ts:1329`), observed via
  `MantaEventStore.addRawFrameHandler` (`MantaEventStore.swift:464`, a
  multicast list — no change to WS02's store).
- Connection transitions: `eventStore.$connectionState` (the published-state
  pattern already used by `ChatSessionStore.swift:406`, `AccountsStore.swift:125`,
  `UpgradeStore.swift:61`). WS09 never touches the single-owner
  `resyncHandler` (`MantaEventStore.swift:421-424`), which belongs to the
  session list.
- `schedule:create` (`rpc.mjs:2371` → `schedule.mjs:244 createJob`), args
  `[{fireAt, prompt, recurring:false, label, sessionID, kind:"notify"}]` →
  `{ok:true, job:{id,…}} | {ok:false, error}`. When it fires, the box calls
  `push.fireNotify` — the EXISTING notification router — so the phone gets an
  APNs push at reset even when the app is closed.
- Push today: the box sends **no** push for crossing 90 % / 100 % (verified:
  no `fireNotify` on the usage path in `index.mjs`; the only related push is
  "Provider needs attention", `index.mjs:943-961`, for out-of-credit). So the
  90 %/limit alerts are in-app only — as on desktop.

### iOS design

- `UsageAlertsStore.swift` — `@MainActor final class UsageAlertsStore:
  ObservableObject`, `static let shared`. Published: `snapshots`,
  `queue: [UsageAlert]`, `activeSessionId: String?`, `resumeSheetPresented`,
  plus the box lifecycle (above). Internal state is one
  `UsageBaseline` value (pure, below).
  - `bind(eventStore:)` — idempotent (a `bound` flag). Registers the raw-frame
    handler and retains a Combine `AnyCancellable` on
    `eventStore.$connectionState`. A `wasConnected` flag detects
    disconnect→connect exactly like `ChatSessionStore.handleConnection`
    (`ChatSessionStore.swift:710-727`): the replayed current value on subscribe
    does not count as a reconnect, but if it is `.connected` and no baseline
    exists for this generation, a first seed starts.
  - Seed / reseed: `let ticket = baseline.beginSeed(generation:)`, then
    `usage:list`; on success `baseline.completeSeed(ticket, snapshots, now)`.
    `UsageBaseline` rejects the completion if the generation changed OR a
    `usage.updated` frame was applied after the ticket was issued (the frame is
    newer, so the seed would overwrite it). On failure the baseline stays as it
    was (a first seed that fails leaves "no baseline": alerts stay suppressed
    until a frame establishes one).
  - Frame: `baseline.applyFrame(snapshots, generation:, now)` →
    `[UsageAlert]` fired + the new level map. With NO baseline yet it records
    the levels and fires NOTHING (no alert storm on a cold start or right after
    a box switch).
  - Reconnect: a reseed whose completion is accepted runs
    `UsageEscalation.fired(prev: baseline.levels, next: seeded)` — so a window
    that crossed 90/100 while the phone's stream was down still alerts once —
    then replaces the levels. (Desktop's `pullUsage` silently overwrites; this
    is a deliberate iOS addition, because a phone loses its stream far more
    often.) A cold seed never fires.
  - `snapshots` is updated from both the seed and every frame (F6 reads reset
    instants from here).
  - `activeSessionId` — set by ChatScreen (M-09-5) to the visible chat.
  - Retiring limit alerts: a queued limit alert is removed when (a) an applied
    frame or seed shows its key below `limit`, or (b) its `resetsAt` passes. For
    (b) the store keeps ONE `Task` sleeping until the earliest `resetsAt` among
    queued limit alerts (re-planned whenever the queue changes, cancelled on
    reset); on wake it retires every alert with `resetsAt <= now`. Warn alerts
    auto-dismiss after 6 s as before.
  - Actions (all through `UsageEscalation.actionPolicy(alert:, sessionID:,
    generation:, now:)`):
    - `remindAtReset(_:)` — re-evaluates the policy AT TAP TIME. `.expired`
      (`resetsAt <= now`) → no job, alert retired, banner "This window has
      already reset — you can keep working." `.unavailable` (no session, older
      generation) → no job, banner "Open a chat to set a reminder."
      `.available(job)` → `schedule:create`; `ok` → banner "Reminder set for
      <UsageMeters.resetAt(fireAt)>."; `ok:false`/throw → "Couldn't set a
      reminder: <error>".
    - `keepGoing(_:)` — same expiry check (an expired window just retires the
      alert with the same "already reset" banner); otherwise `presentResume()`.
- `UsageAlertBanner.swift` — top overlay (M-09-3) showing the head of the queue:
  glass capsule, icon `gauge.with.dots.needle.67percent` (warn) /
  `exclamationmark.octagon` (limit, danger tint), message text (desktop copy),
  close button. The two limit buttons are RENDERED only when the policy is
  `.available` for the current `now` (re-evaluated with
  `TimelineView(.periodic(from: .now, by: 30))`), so an expired alert never
  shows a button; the tap re-checks anyway. Haptic `.warning` on a limit alert
  when haptics are enabled.
- Interaction with the existing per-chat weekly banner
  (`ChatScreen.swift:1265-1300`): unchanged; the app-level warn is transient
  (6 s) so both may appear once — see Open questions.

### Pure logic (Foundation-only)

`UsageEscalation.swift`:
`level(pct)`, `levels(snapshots) -> [String: Level]`,
`fired(prev:next:) -> [UsageAlert]`, `warnMessage(provider:window:now:)`,
`limitMessage(provider:window:now:)` (window label fallback: `label ??
kind.capitalized`; reset clause `"resets " + UsageMeters.formatReset(...)`
except "resetting…" verbatim; omitted when no `resetsAt`),
`enum ActionPolicy { case available(job: ReminderJob), unavailable, expired }`,
`actionPolicy(alert:, sessionID:, generation:, now:) -> ActionPolicy`
(`resetsAt == nil` → unavailable; `resetsAt <= now` → expired; nil session or
`alert.generation != generation` → unavailable; else available with
`fireAt = resetsAt + 60_000`), `retire(queue:, levels:, now:) -> [UsageAlert]`,
`nextRetireAt(queue:) -> Double?`.
`UsageAlert` carries `key, level, provider, window, raisedAt, generation`.

`UsageBaseline.swift` — `struct UsageBaseline`:
`levels: [String: Level]?` (nil = no baseline), `frameSeq: Int`,
`mutating func beginSeed(generation:) -> SeedTicket` (captures generation +
`frameSeq`), `mutating func completeSeed(_:snapshots:generation:) -> [UsageAlert]?`
(nil = rejected as stale; `[]` for a cold seed; fired list for a reseed),
`mutating func applyFrame(_:generation:) -> [UsageAlert]` (bumps `frameSeq`;
no baseline → records levels, returns `[]`), `mutating func reset()`.

### Tests — `MantaUITests/UsageEscalationTests.swift` (Foundation-only)

Port `src/renderer/usageEscalation.test.ts`: boundaries 89.9/90/99.9/100;
fire-once while holding; re-arm after drop; warn→limit fires; none→limit fires
once as limit; stale never fires but seeds baseline (cold start at 100 % stale
then fresh 100 % → no fire); messages with and without reset. Plus:
- `actionPolicy`: available; no session → unavailable; older generation →
  unavailable; **sticky alert acted on after its reset → expired, no job**;
  `resetsAt == nil` → unavailable; `fireAt == resetsAt + 60 000`.
- `retire`: a limit alert retired when its key drops below limit and when
  `resetsAt <= now`; warn alerts untouched; `nextRetireAt` = earliest.
- `UsageBaseline`: **delayed seed** — seed issued, frame applied, seed
  completes → rejected, levels are the frame's; **frame before any baseline**
  fires nothing; **reconnect with missed update** — baseline at 80 %, reseed
  returns 100 % → one limit alert; reseed at the same level → none; **late
  old-box seed** — `reset()` then completion with the old generation →
  rejected.

Store-level test (Mac-only, `MantaUITests/UsageAlertsStoreTests.swift`, with a
fake `MantaEventStreamControl` as in `MantaEventStreamTests.swift`):
disconnect→connect triggers exactly one reseed; the replayed `.connected` on
subscribe does not count as a reconnect; `resetForBoxChange()` clears the
queue and a late response is dropped.

### Acceptance criteria

- [ ] Crossing 90 % shows one transient banner; crossing 100 % shows one
      sticky banner; neither repeats until the window resets and re-crosses.
- [ ] A crossing that happened while the phone was disconnected is alerted
      once after reconnect; opening the app cold never raises an alert for a
      level that was already reached.
- [ ] With a chat open, "Remind me at reset" creates a one-shot job (visible in
      the chat's schedules card) and a push arrives at reset; without a chat
      open the actions are not shown.
- [ ] A limit banner left open past its reset loses its buttons and is retired;
      no job is ever created for an elapsed reset.
- [ ] "Keep going at reset" opens the resume sheet.
- [ ] After switching or removing the box, no alert, baseline or chat id from
      the old box survives, and no old-box reminder can be created.

---

## Files

Create (all `mobile/native/MantaUI/` unless noted):

| File | Contents | Foundation-only (Package.swift, D19) |
|---|---|---|
| `MantaAPIClient+Models.swift` | client members (see Client members) | no |
| `ModelsWire.swift` | Decodable wire types (tolerant decoding, `supported` gate): ledger, optimizer summary/series/prices, `ModelsSubagentDef`, `ModelsCatalogEntry`, `UnidentifiedRow`/`UnidentifiedList`, `ScheduleCreateReply` | yes |
| `ModelsLogic.swift` | `ModelsTable`, `ModelsPicker`, `ModelsConfig`, `ModelsFormat` | yes |
| `ModelsStore.swift` | `ModelsStore` | no |
| `ModelsScreen.swift` | screen + sections + `ModelsRow` | no |
| `ModelsDetailSheet.swift` | detail sheet + `ModelsEditForm` | no |
| `ModelsInsightsLogic.swift` / `ModelsLedgerScreen.swift` | F2 | yes / no |
| `OptimizerLogic.swift` / `OptimizerScreen.swift` | F3 (`OptimizerGauge` inside the screen) | yes / no |
| `ModelsIdentifyLogic.swift` / `ModelsUnidentifiedView.swift` | F4 (section + `ModelsIdentifyForm`) | yes / no |
| `ModelsPriceLogic.swift` / `ModelsPriceForm.swift` | F5 | yes / no |
| `UsageResumeLogic.swift` / `UsageResumeSheet.swift` | F6 (`UsageStoppedEntry`, `UsageStoppedCapsule` in the sheet file; the `SessionStoppedRecord` mapping lives in the sheet file) | yes / no |
| `UsageEscalation.swift`, `UsageBaseline.swift` / `UsageAlertsStore.swift`, `UsageAlertBanner.swift` | F7 | yes / no |
| `MantaUITests/ModelsTests.swift`, `OptimizerTests.swift`, `UsageResumeTests.swift`, `UsageEscalationTests.swift` | pure XCTests | yes |
| `MantaUITests/ModelsStoreTests.swift`, `UsageAlertsStoreTests.swift` | store tests (Combine/URLProtocol) | no |
| `src/server/modelsUnidentified.mjs`, `src/server/modelsUnidentified.test.mjs` | F4 server module + node test (D7) | — |

(`UsageStoppedStore.swift` and `UsageSeatLine.swift` from the draft are
dropped — D16, D17.)

Edit (owned): `ChatModelCatalog.swift` (reload, applyConfig,
deactivatedMain, configOptIns, provider-change observer, box lifecycle),
`ChatModelStore.swift` (D1: `effectiveOptIns`, `isSelectable`,
`selectableModels`, guarded `apply`/`setFast`, async `optIn` with
pending/error), `ModelPickerSheet.swift` (catalogue/recents/fast filtering,
async Enable with spinner + error line), `UsageMeters.swift` (only if a shared
helper is needed; no behaviour change).

Edit (additive, wave-B server slot, D7): `src/server/rpc.mjs` — import
`modelsUnidentified.mjs` and register `"models:unidentified"`.

Manifest for integration agent B (D18): add the "yes" rows above to
`mobile/native/Package.swift` `sources` / test `sources`. WS09 edits neither
`Package.swift`, `project.yml` nor the `.pbxproj`; `project.yml` needs no
change (the `MantaUI` folder is a directory source).

## Client members

All in `MantaUI/MantaAPIClient+Models.swift`, via C1 `call` / `callRequired` /
`callVoid` / `jsonObject`. None duplicates a member owned elsewhere: the
stopped list is WS04's `usageStoppedList()` (D16); `configGet`, `configUpdate`,
`models`, `defaultModel`, `usageList`, `messages` already exist in
`MantaAPIClient.swift` and are reused.

| Member | Channel |
|---|---|
| `func modelsSyncSubagents(models: [[String: Any]], deactivated: [String], optIn: [String]) async throws -> [ModelsSubagentDef]` | `opencode:sync-subagents` |
| `func ledgerSummary() async throws -> LedgerSummaryWire` | `ledger:summary` |
| `func optimizerSummary() async throws -> OptimizerSummaryWire` | `optimizer:summary` |
| `func optimizerSeries(range: String) async throws -> OptimizerSeriesWire` | `optimizer:series` |
| `func optimizerPrices() async throws -> OptimizerPricesWire` | `optimizer:prices` |
| `func setModelCost(providerID: String, modelID: String, cost: [String: Double]) async throws -> ModelCostReply` | `opencode:set-model-cost` |
| `func modelCatalog() async throws -> ModelsCatalogWire` | `opencode:model-catalog` |
| `func modelsUnidentified() async throws -> UnidentifiedList` | `models:unidentified` (new, D7) |
| `func usageStoppedArm(conversation: String) async throws` | `usage-stopped:arm` |
| `func usageStoppedDisarm(conversation: String) async throws` | `usage-stopped:disarm` |
| `func usageStoppedStampLastLooked() async throws` | `usage-stopped:stamp-last-looked` |
| `func scheduleCreate(_ job: [String: Any]) async throws -> ScheduleCreateReply` | `schedule:create` |

Before dispatch, grep: no other `MantaAPIClient+*.swift` declares any of
these names (checked against specs 01–08, 10 at revision time: none do).

## Mount requests

Per D18. "Integration B" = the single wave-B integration agent.

| ID | Receiving file | Applier | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-09-1 | `SettingsScreen.swift` (WS10) | Integration B | `ModelsScreen()` (WS09, `ModelsScreen.swift`) | A fixed "Models" row styled like `accountsEntry` (`SettingsScreen.swift:174-200`), placed directly under it: title "Models", subtitle "Default, picker, subagents, spend and optimizer", `NavigationLink { ModelsScreen() }`; matched by search for "models default subagent picker spend cost optimizer prices identify" (same mechanism as `accountsMatchesQuery`, `:167-171`). | WS10 wave A landed; WS09 `ModelsScreen.swift` landed. |
| M-09-2 | `SessionListView.swift` (WS04) | Integration B | `UsageStoppedCapsule(count:action:)`, `UsageResume.unarmedCount(_:)`, `UsageStoppedEntry.init(_:)` (WS09); `store.stoppedRecords` (WS04) | A `ToolbarItem(placement: .topBarTrailing)` before the `orderMenu` item (`SessionListView.swift:116`), rendered only when the unarmed count > 0: `UsageStoppedCapsule(count: n) { UsageAlertsStore.shared.presentResume() }`. | WS04 §9 (`stoppedRecords`) landed; WS09 landed; applied in ledger order with WS06's search entry in the same file. |
| M-09-3 | `MantaAppRoot.swift` (WS04) | Integration B | `UsageAlertsStore.shared.bind(eventStore:)`, `UsageAlertBanner(store:)`, `UsageResumeSheet(sessions:usage:)` | (a) in the paired branch's `.onAppear`, next to `startModelPrefs()` (`MantaAppRoot.swift:104`), AND in `commitPairing` after `startModelPrefs()` (`:197`): `UsageAlertsStore.shared.bind(eventStore: store)`; (b) on the root `Group`, only when `paired && scene == nil`: `.overlay(alignment: .top) { UsageAlertBanner(store: .shared) }` and `.sheet(isPresented: $usageAlerts.resumeSheetPresented) { UsageResumeSheet(sessions: sessionStore, usage: .shared) }` with `@ObservedObject private var usageAlerts = UsageAlertsStore.shared`. | WS04 + WS09 landed; applied in ledger order with WS07's agent-file notice in the same file. |
| M-09-4 | `MantaAppRoot.swift` (WS04) | Integration B | `UsageAlertsStore.resetForBoxChange()`, `ChatModelCatalog.resetForBoxChange()` (WS09) | In `commitPairing`'s `if flow.isSwitching { … }` block (`MantaAppRoot.swift:187-190`), after `sessionStore.resetForBoxChange()`: `UsageAlertsStore.shared.resetForBoxChange(); ChatModelCatalog.shared.resetForBoxChange()`. | as M-09-3 |
| M-09-5 | `ChatScreen.swift` (WS02) | WS02 (wave B, per D18) | `UsageAlertsStore.shared.activeSessionId` (WS09) | Beside the two `reportFocus(sessionId: store.sessionId, visible: true)` calls (`ChatScreen.swift:371`, `:472`): `UsageAlertsStore.shared.activeSessionId = store.sessionId`. Beside the two `visible: false` calls (`:381`, `:475`): `if UsageAlertsStore.shared.activeSessionId == store.sessionId { UsageAlertsStore.shared.activeSessionId = nil }`. | WS09's `UsageAlertsStore.swift` (provider symbol pinned here, so WS02 may write it in the same wave). |
| M-09-6 (optional) | `AccountsScreen.swift` (WS08) | Integration B, only if WS08 accepts | `ModelsScreen()` | A footer link "Set prices for unpriced models" → `ModelsScreen()`, mirroring where desktop mounts the panel. Default: not applied. | WS08 landed. |

The draft's M5 (ChatModelStore) is no longer a mount — D1 gives the file to
WS09. The draft's M6 (seat row) is void — D17.

## Mounts applied by this workstream

None. Cross-checked the mount tables of specs 01–08 and 10 in this folder: no
request targets a WS09-owned file (`UsageMeters.swift`, `ModelPickerSheet.swift`,
`ChatModelCatalog.swift`, `ChatModelStore.swift`). WS03 reads
`ChatModelStore.agents` (`03-composer.md:44,601`); WS09 does not change that
member. WS08's `Notification.Name.mantaProvidersChanged` (`08-accounts.md:741-744`)
is a provided contract WS09 consumes inside its own file (`ChatModelCatalog`),
not a mount.

## Contracts provided / consumed

- **C1 provided**: `MantaAPIClient+Models.swift` (Client members above).
  Consumed: the internal `call/callRequired/callVoid/jsonObject` helpers.
- **C4**: no ChatScreen mount other than M-09-5. The seat row is WS02's (D17).
- **D16 consumed from WS04**: `SessionStoppedRecord`, `SessionListStore.stoppedRecords`,
  `SessionListStore.stoppedLastLooked` (new — see below), `SessionListStore.projects`.
  WS04's row marker keeps reading its own `stoppedConversations`; WS09 offers
  `UsageResume.showsStoppedMarker` but WS04 is free to keep its own.
- **Consumed**: `MantaEventStore.addRawFrameHandler` and `$connectionState`
  (no edit to WS02's store); WS08 `Notification.Name.mantaProvidersChanged`;
  WS10 `Notification.Name.mantaBoxRemoved`; C6 untouched (`optimizerEnabled`,
  `cacheTtl`, `alwaysShowUsage` already exist).
- C2/C3/C5: none. C7: tests as listed.

## Cross-spec dependencies

- **WS04 (wave A)** must publish `SessionListStore.stoppedLastLooked: Double?`
  from the `lastLooked` field of the `usage-stopped:list` answer it already
  decodes (`04-sessions.md:766`). Without it the "new" badges and the armed
  header fall back to "never looked" (every row "new") — degraded, not broken.
  If WS04 names its `SessionStoppedRecord` properties differently from the wire
  keys, only `UsageStoppedEntry.init(_:)` adapts.

## Deferred

- **Model tier tag + guide blurb** (D8): from `src/shared/modelGuide.mjs`, a JS
  data table with no wire channel. F4's channel carries `tier` for matched rows
  only. iOS shows the provider's own `description` (override) where present.
- **Push notification at 90 % / limit**: the box sends none today; adding one
  is a server routing decision outside this effort (D7 lists the only accepted
  server changes). "Remind me at reset" already produces a real push.
- **Optimizer per-session savings list**: desktop shows only the count too.
- **Desktop's "restart opencode" banner** after subagent changes: obsolete on
  V2 (writes hot-apply); iOS deliberately does not reproduce it.
- **Desktop defects found (report only, D10)**: the resume modal's
  zero-selection guard blocks disarming the last armed row
  (`UsageResumeModal.tsx:97-106,229-230`); the limit toast can schedule an
  elapsed reset a year out (`App.tsx:846-880` + `schedule.mjs:258-284`); the
  resume modal's Apply is fire-and-forget (`UsageResumeModal.tsx:97-109`).

## Open questions

1. Weekly ≥ 90 %: the per-chat weekly banner (existing) and the new app-level
   warn banner can both show once. Default: keep both (the app-level one is
   transient; the chat one is the persistent reminder).
2. Should the `models:unidentified` row derivation also replace the desktop's
   client-side derivation? Default: no — desktop unchanged; the parity test
   keeps them aligned.

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
