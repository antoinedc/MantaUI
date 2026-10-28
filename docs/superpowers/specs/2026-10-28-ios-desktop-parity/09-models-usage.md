# WS09 — Models, spend and usage (iOS)

Status: draft · Wave B · Owner files: `UsageMeters.swift`, `ModelPickerSheet.swift`,
`ChatModelCatalog.swift`, new `Models*` / `Usage*` / `Optimizer*` files,
`MantaAPIClient+Models.swift`, server module `src/server/modelsUnidentified.mjs`.

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
| F8 | Seat data for the context sheet's "Seat" row (WS02 renders it) | `chatUtils.ts:3812 describeSeatLine`, `SessionHeader.tsx:641-798` |

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

Resume-after-limit (F6) and usage alerts (F7) are app-level: two `static let
shared` `@MainActor` stores bound to the app's `MantaEventStore` (same pattern
as `WidgetLiveStore.shared.bind(eventStore:)`, `MantaUIApp.swift:38`), a top
banner overlay and one sheet, both mounted in `MantaAppRoot` (WS04 mount).

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

### iOS design

New files:

- `ModelsStore.swift` — `@MainActor final class ModelsStore: ObservableObject`
  holding `phase` (`.loading/.loaded/.failed(String)`), `models`,
  `config: ModelsConfig` (the five keys above, decoded from `config:get`'s
  `[String: JSONValue]`), `busyKey: String?`, `feedback: ModelsFeedback?`
  (`.saved(String)` auto-clears after 3 s, `.failed(String)` stays until
  dismissed). On `load()`: `models()` + `configGet()` concurrently, then
  `syncSubagents` with the loaded sets (desktop runs it on every load,
  `ModelsCard.tsx:200-205`; failure here is logged into `feedback` only if the
  call throws). Actions: `setDefault`, `toggleMain`, `toggleSub`,
  `enableDeprecated`, `saveOverride` — each sets `busyKey`, awaits, updates
  local state from the RETURNED config, calls
  `ChatModelCatalog.shared.reload()`, and sets `feedback`. Every failure keeps
  the previous state and says "Couldn't save — <reason>. Nothing was changed."
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
- Picker honours Main + config opt-ins (owned edits):
  - `ChatModelCatalog`: add `@Published private(set) var deactivatedMain:
    Set<String>`, `@Published private(set) var configOptIns: Set<String>`
    (both parsed from the same `config:get` it already makes), and
    `func reload()` (clears `didStart`/`loaded` guard semantics: refetch the
    three reads and republish; safe to call while a load is in flight —
    coalesce with a single in-flight `Task`).
  - `ModelPickerSheet`: before grouping, filter with
    `ModelsTable.pickerVisible(models, deactivatedMain:)` (drops keys in
    `deactivatedMain`; the currently-active model is kept so the cockpit never
    shows an empty selection); the disabled-row decision uses
    `modelStore.deprecatedOptIns ∪ catalog.configOptIns`.
  - When the user opts in to a deprecated model from the picker, ALSO write
    `config:update {optInModels: …}` (desktop `store.optInModel`,
    `store.ts:1186`). The opt-in action lives in `ChatModelStore.swift:~280`,
    which no workstream owns — see Mount requests (M5).

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
  static func pickerVisible(_ models: [OpencodeModel], deactivatedMain: Set<String>, keep active: String?) -> [OpencodeModel]
  static func syncPayload(_ models: [OpencodeModel]) -> [[String: Any]]   // {providerID,id,name,status?}
}
```

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
- `pickerVisible`: drops deactivated, keeps the active key even if deactivated.
- `ModelsConfig` decode from a `[String: JSONValue]` with missing keys →
  empty sets / nil default; `defaultModel: null` → nil.

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
- [ ] Edit saves only changed fields; clearing every field removes the override.
- [ ] Every action shows a saved confirmation or an actionable error; nothing
      changes on failure.

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
- Save: `ModelsStore.declare(key:decl:)` → fresh `config:get`, merge, `config:update
  {modelRouting}`, then reload the section; success → feedback "Saved — Auto
  can now describe <modelID>" and the row disappears; failure → inline error,
  nothing changed.

### Pure logic — `ModelsIdentify` (in `ModelsIdentifyLogic.swift`)

`missingPhrase([String]) -> String?` (exact desktop join),
`helpText(row) -> String`, `search(entries, query) -> [CatalogEntry]` (top 30
when empty, else id/name/family substring, cap 50),
`canSave(selected:, priceMode:, costIn:, costOut:) -> Bool`,
`declaration(selected:, priceMode:, costIn:, costOut:, cacheMode:, reads:, writes:) -> [String: Any]`,
`mergedRouting(config:, key:, decl:) -> [String: Any]` (preset default
"balanced", preserves other keys and other declarations).

### Tests

- `MantaUITests/ModelsTests.swift`: missingPhrase for 0/1/2/4 keys and unknown
  keys; helpText for each state incl. probable with/without evidence and
  "Auto still needs"; canSave matrix (no price / Free / Custom with one rate /
  Custom with none / no selection); declaration (free → `"free"`, custom with
  one blank rate → 0, caching none → `false`); mergedRouting keeps existing
  declarations and preset.
- `src/server/modelsUnidentified.test.mjs` (node:test): eligible model skipped;
  exact certain/probable; ambiguous with candidates; none; declared catalogId
  wins; empty catalogue → `{supported:false}`; a parity test that runs the
  renderer's row logic (extract the row-building loop from
  `ModelsWeCouldntIdentify.tsx` into an exported pure function in the same
  file only if needed — otherwise replicate the fixture expectations) and
  `buildUnidentifiedRows` over one fixture and asserts the same keys/states/
  missing. Uses injected catalogue/models; no live opencode, no state files.

### Acceptance criteria

- [ ] An endpoint the router can't describe appears with the same case and
      help text as on desktop; a fully described one does not.
- [ ] Confirm / candidate pick / editor Save each write
      `modelRouting.declaredModels[key]` and the row disappears; desktop shows
      the same declaration.
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
Models, not Accounts — WS08 owns Accounts; see M6 for an optional link).
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
  "Update" (disabled at 0 selected). Default selection on open = already
  armed rows.
- Apply (`:97-109`): for each record, selected & not armed → arm; armed & not
  selected → disarm (which REMOVES the row). Close always stamps last-looked.
  Empty: "No conversations are stopped by a provider limit right now."
- The record is box-owned; `usage-stopped.updated` triggers a refetch
  (`App.tsx:760-770`).

### Wire contract

| Channel | Args | Result |
|---|---|---|
| `usage-stopped:list` (`rpc.mjs:2394`, `stoppedStore.mjs:287`) | `[]` | `{records: StoppedRecord[], lastLooked: number\|null}`; `StoppedRecord` = `{workspace, conversation, provider, model?, window: string\|null, stoppedAt, cachedTokens?, armed?, attempts?}` (`types.ts:2333`) |
| `usage-stopped:arm` | `["<conversation>"]` (positional string) | `null` |
| `usage-stopped:disarm` | `["<conversation>"]` | `null` (removes the row) |
| `usage-stopped:stamp-last-looked` | `[]` | `null` |
| `usage:list` (exists, `MantaAPIClient.usageList`) | `[]` | `UsageSnapshot[]` — reset instants |
| `opencode:messages` (exists, `MantaAPIClient.messages(sessionId:limit:)`) | | snippet |
| `config:get` | | `cacheTtl` ("5m" default) |

Frame: raw bus frame `kind: "usage-stopped.updated"`, payload
`{conversation?}` — a refetch hint (observed via
`MantaEventStore.addRawFrameHandler`, `MantaEventStore.swift:464`; no change
to WS02's event store).

### iOS design

- `UsageStoppedStore.swift` — `@MainActor final class UsageStoppedStore:
  ObservableObject`, `static let shared`. `@Published records`, `lastLooked`,
  `snapshots` (from `usage:list`, refreshed on open and on `usage.updated`),
  `cacheTtl`, `isResumeSheetPresented: Bool`. `bind(eventStore:)` (idempotent)
  registers a raw-frame handler: `usage-stopped.updated` → `refresh()`;
  `usage.updated` → take `payload.snapshots`. `refresh()` on bind and on
  `MantaEventStore` reconnect (desktop pulls on every api change). Derived:
  `unarmedCount`, `isStopped(sessionId:)` (for WS04 row markers),
  `presentResume()`.
- `UsageResumeSheet.swift` — presented ONCE at app root (M3) from
  `isResumeSheetPresented`. `NavigationStack` + `List`:
  - Header text (desktop copy) as the first section's header.
  - Toolbar: leading Cancel/Close; trailing primary "Resume N at reset" /
    "Update" (disabled at 0); a bottom `safeAreaInset` bar with "Check all"
    / "Uncheck all" and "s of t selected" + the batch-cost line.
  - Sections per workspace; rows are tappable (toggle selection, checkmark
    accessory `Image(systemName: selected ? "checkmark.circle.fill" : "circle")`),
    with name, chips (armed / new), snippet, provider·model, window chip, cost
    chip — desktop copy.
  - Footer callout for cold selections (desktop copy).
  - Apply: sequential awaits; on success dismiss + toast-style banner
    "Updated — N conversation(s) will carry on at reset."; on the first
    failure stop, keep the sheet open, show "Couldn't update <name> —
    <reason>. Nothing after it was changed." (desktop fires-and-forgets;
    iOS must report). Dismissal by any route calls `stamp-last-looked`
    (failure logged, not surfaced — it only clears "new" badges).
  - Snippets: fetched on open, best-effort, per row.
  - Name: `UsageResume.name(for:projects:)` using `SessionListStore.projects`
    (`MantaWindow.opencodeSessionId` → `MantaWindow.name`), fallback the id —
    passed into the sheet by the mount.
- Session-list entry point (M2): a toolbar capsule `"pause.circle" + N` (warn
  tint) when `unarmedCount > 0`, accessibility label "N conversation(s)
  stopped by a provider limit", tap → `UsageStoppedStore.shared.presentResume()`.

### Pure logic — `UsageResume` (in `UsageResumeLogic.swift`)

Ports of `usageResume.ts`: `unarmedCount`, `extractLastSnippet(messages)`,
`resetAt(record, snapshots) -> Date?`, `resumeCost(record, resetsAt, now, ttl)`,
`costs(records, snapshots, now, ttl)`, `selectionSummary(records, selected,
costs)`, `isNew(record, lastLooked)`, `groupByWorkspace(records)` (empty
workspace → "—"), plus `headerText(records, lastLooked)`,
`windowChipLabel(record, snapshots)`, `windowChipText(record, snapshots, now)`,
`applyPlan(records, selected) -> (arm: [String], disarm: [String])`,
`name(for:projects:)`, `ttlMs(cacheTtl:)` ("1h" → 3 600 000 else 300 000).

### Tests — `MantaUITests/UsageResumeTests.swift`

Port `src/renderer/usageResume.test.ts` cases + header singular/plural/armed
variants; applyPlan (select unarmed → arm, unselect armed → disarm, unchanged
→ nothing); windowChipLabel fallbacks (no window → "Limit", unknown kind →
capitalised); name lookup + fallback; warm/cold boundary exactly at TTL.

### Acceptance criteria

- [ ] When a provider limit stops a conversation, the session list shows the
      pause capsule with the unarmed count within one bus event.
- [ ] The sheet lists the same rows as desktop; arming/unarming here is
      reflected on desktop (and vice versa) without reopening.
- [ ] Unchecking an armed row removes it after Update; failures are reported.
- [ ] Closing clears "new" badges on both clients.

---

## F7 — Usage alerts (90% / limit)

### Desktop behaviour today

`usageEscalation.ts` + `App.tsx:794-917`:
- Baseline seeded from `usage:list` on load/reconnect (`buildUsageLevels`,
  stale windows included verbatim).
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

### Wire contract

- `usage:list` (exists), frame `kind:"usage.updated"` payload
  `{snapshots: UsageSnapshot[]}` (full set, `httpApi.ts:1329`).
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

- `UsageAlertsStore.swift` — `@MainActor final class`, `static let shared`.
  `bind(eventStore:)` (idempotent): seeds the level map from `usage:list`
  (`UsageEscalation.levels`), re-seeds on reconnect, and on each
  `usage.updated` raw frame runs `UsageEscalation.fired(prev:next:)`, appends
  `UsageAlert`s to `@Published var queue`, then replaces the level map.
  `@Published var activeSessionId: String?` — set by ChatScreen (M4) to the
  visible chat. Actions `remindAtReset(_:)` (calls `schedule:create`, then
  queues a confirmation or error banner) and `keepGoing(_:)`
  (`UsageStoppedStore.shared.presentResume()`).
- `UsageAlertBanner.swift` — top overlay (M3) showing the head of the queue:
  glass capsule, icon `gauge.with.dots.needle.67percent` (warn) /
  `exclamationmark.octagon` (limit, danger tint), message text (desktop
  copy), close button. Warn auto-dismisses after 6 s; limit stays until closed.
  Limit actions rendered only when `UsageEscalation.actionsAvailable(alert,
  activeSessionId)` (desktop gate). Haptic `.warning` on a limit alert when
  haptics are enabled. Confirmation banner "Reminder set for <resetAt>." (uses
  `UsageMeters.resetAt`), error banner "Couldn't set a reminder: <error>".
- Interaction with the existing per-chat weekly banner
  (`ChatScreen.swift:1265-1300`): unchanged; the app-level warn is transient
  (6 s) so both may appear once — see Open questions.

### Pure logic — `UsageEscalation` (in `UsageEscalation.swift`)

`level(pct)`, `levels(snapshots) -> [String: Level]`,
`fired(prev:next:) -> [UsageAlert]`, `warnMessage(provider:window:now:)`,
`limitMessage(provider:window:now:)` (window label fallback: `label ??
kind.capitalized`; reset clause `"resets " + UsageMeters.formatReset(...)`
except "resetting…" verbatim; omitted when no `resetsAt`),
`reminderJob(alert:sessionID:) -> [String: Any]?` (nil without `resetsAt`;
`fireAt = resetsAt + 60_000`), `actionsAvailable(alert, sessionID)`.

### Tests — `MantaUITests/UsageEscalationTests.swift`

Port `src/renderer/usageEscalation.test.ts`: boundaries 89.9/90/99.9/100;
fire-once while holding; re-arm after drop; warn→limit fires; none→limit fires
once as limit; stale never fires but seeds baseline (cold start at 100 % stale
then fresh 100 % → no fire); messages with and without reset; reminder job
shape and nil without reset; actions gate.

### Acceptance criteria

- [ ] Crossing 90 % shows one transient banner; crossing 100 % shows one
      sticky banner; neither repeats until the window resets and re-crosses.
- [ ] With a chat open, "Remind me at reset" creates a one-shot job (visible in
      the chat's schedules card) and a push arrives at reset; without a chat
      open the actions are not shown.
- [ ] "Keep going at reset" opens the resume sheet.

---

## F8 — Seat data for the context sheet

### Desktop behaviour today

The context popover shows "Seat: <account>" or "Seat: <account> · <seat>"
(`describeSeatLine`, `chatUtils.ts:3812-3822`; `SessionHeader.tsx:792-798`):
account/seat labels from `accounts:list` when found, else from the
`accounts:session-seat` answer; seat label omitted when the account has one
seat or no seat label; absent seat → no line.

### Wire contract

`accounts:session-seat` (`accountsManager.mjs:1131`) `[{sessionId}]` →
`SessionSeat | null`, and `accounts:list` — both already fetched by the
`AccountsStore` that `ChatScreen` owns (`ChatScreen.swift:321`,
`AccountsStore.swift:44, 190-199`). No new reads.

### iOS design

`UsageSeatLine.swift`:

```swift
enum UsageSeatLine {
  /// "Seat: Work · Seat 2" / "Seat: Work"; nil when the conversation has no seat.
  static func text(providers: [AccountsProvider], sessionSeat: SessionSeat?) -> String?
}
```

Built on `AccountsSelectors.conversationSeat(...).displayName`
(`AccountsModels.swift:752-763, 874`) with the "Seat: " prefix; returns nil
for an empty display name. WS02 renders the row in `ContextSheet` from
`accountsStore.providers` / `accountsStore.sessionSeat` (see C4 mount, owned by
WS02). Tests in `ModelsTests.swift`: nil seat → nil; single-seat account →
account label only; multi-seat → "account · seat"; seat not in list → labels
from the session-seat answer.

### Acceptance criteria

- [ ] For a conversation on a known seat, the context sheet shows the same
      "Seat: …" text as the desktop popover.

---

## Files

Create (all `mobile/native/MantaUI/` unless noted):

| File | Contents |
|---|---|
| `MantaAPIClient+Models.swift` | `modelsSyncSubagents`, `ledgerSummary`, `optimizerSummary`, `optimizerSeries(range:)`, `optimizerPrices`, `setModelCost`, `modelCatalog`, `modelsUnidentified`, `usageStoppedList/Arm/Disarm/StampLastLooked`, `scheduleCreate(job:)` |
| `ModelsWire.swift` | Decodable wire types for all of the above (tolerant decoding, `supported` gate) |
| `ModelsLogic.swift` | `ModelsTable`, `ModelsConfig`, `ModelsFormat` |
| `ModelsStore.swift` | `ModelsStore` |
| `ModelsScreen.swift` | screen + sections + `ModelsRow` |
| `ModelsDetailSheet.swift` | detail sheet + `ModelsEditForm` |
| `ModelsInsightsLogic.swift`, `ModelsLedgerScreen.swift` | F2 |
| `OptimizerLogic.swift`, `OptimizerScreen.swift` | F3 (`OptimizerGauge` inside) |
| `ModelsIdentifyLogic.swift`, `ModelsUnidentifiedView.swift` | F4 (section + `ModelsIdentifyForm`) |
| `ModelsPriceLogic.swift`, `ModelsPriceForm.swift` | F5 |
| `UsageResumeLogic.swift`, `UsageStoppedStore.swift`, `UsageResumeSheet.swift` | F6 |
| `UsageEscalation.swift`, `UsageAlertsStore.swift`, `UsageAlertBanner.swift` | F7 |
| `UsageSeatLine.swift` | F8 |
| `MantaUITests/ModelsTests.swift`, `OptimizerTests.swift`, `UsageResumeTests.swift`, `UsageEscalationTests.swift` | XCTest |
| `src/server/modelsUnidentified.mjs`, `src/server/modelsUnidentified.test.mjs` | F4 server module + node test |

Edit (owned): `ChatModelCatalog.swift` (reload, deactivatedMain,
configOptIns), `ModelPickerSheet.swift` (Main filter + opt-in union),
`UsageMeters.swift` (only if a shared helper is needed; no behaviour change).

Edit (additive, wave-B server slot): `src/server/rpc.mjs` — import
`modelsUnidentified.mjs` and register `"models:unidentified"`. If another
wave-B workstream also edits `rpc.mjs`, serialise behind it. `project.yml`
needs no change (the `MantaUI` folder is a directory source; new files are
picked up), but the `.pbxproj` must be regenerated on the Mac.

## Mount requests

| # | File (owner) | Mount |
|---|---|---|
| M1 | `SettingsScreen.swift` (WS10) | A fixed "Models" row above the schema sections, styled like `accountsEntry` (`:174-200`): title "Models", subtitle "Default, picker, subagents, spend and optimizer" → `NavigationLink { ModelsScreen() }`; search words "models default subagent picker spend cost optimizer prices identify". |
| M2 | `SessionListView.swift` (WS04) | `@ObservedObject var stopped = UsageStoppedStore.shared`; a `ToolbarItem(placement: .topBarTrailing)` before `orderMenu` (`:116`), rendered only when `stopped.unarmedCount > 0`: `UsageStoppedCapsule(count:)` (WS09 ships it in `UsageResumeSheet.swift`), action `stopped.presentResume()`. |
| M3 | `MantaAppRoot.swift` (WS04) | In the paired branch's `.onAppear` (next to `startModelPrefs()`, `:104`): `UsageStoppedStore.shared.bind(eventStore: store)` and `UsageAlertsStore.shared.bind(eventStore: store)`. On the root `Group`, only when `paired && scene == nil`: `.overlay(alignment: .top) { UsageAlertBanner(store: .shared) }` and `.sheet(isPresented: $stopped.isResumeSheetPresented) { UsageResumeSheet(store: .shared, nameFor: { UsageResume.name(for: $0, projects: sessionStore.projects) }) }`. |
| M4 | `ChatScreen.swift` (WS02) | Beside the two `reportFocus(... visible: true)` calls (`:371`, `:472`): `UsageAlertsStore.shared.activeSessionId = store.sessionId`; beside the `visible: false` calls (`:381`, `:475`): clear it only if it still equals this session. |
| M5 | `ChatModelStore.swift` (unowned — orchestrator to assign to WS09) | Where the picker opt-in is saved (`DeprecatedModelOptIns.save`, `:280`): also `config:update {optInModels: catalog.configOptIns ∪ key}` and `ChatModelCatalog.shared.reload()`; failure keeps the local opt-in and logs. |
| M6 | `ContextSheet` in `UsageSheets.swift` (WS02, C4) | A "Seat" row (`LabeledContent`, value `UsageSeatLine.text(providers: accounts.providers, sessionSeat: accounts.sessionSeat)`) rendered only when non-nil; ChatScreen passes its `accountsStore`. |
| M7 (optional) | `AccountsScreen.swift` (WS08) | A footer link "Set prices for unpriced models" → `ModelsScreen()` scrolled to the "No prices" section, mirroring where desktop mounts the panel. Default: skip unless WS08 wants it. |

## Contracts provided / consumed

- **C1 provided**: `MantaAPIClient+Models.swift` (methods above). Consumed:
  the internal `call/callRequired/callVoid/jsonObject` helpers.
- **C4**: the "Seat" row data for WS02's context sheet (`UsageSeatLine`, M6).
- **Provided to WS04**: `UsageStoppedStore.shared` — `records`,
  `unarmedCount`, `isStopped(sessionId:) -> Bool`, `presentResume()`. WS04's
  "stopped by limit" row marker must read `isStopped` (and apply desktop
  precedence: a pending question/permission outranks it,
  `usageResume.ts shouldShowStoppedMarker`, exported as
  `UsageResume.showsStoppedMarker(isStopped:hasPendingAsk:)`).
- **Consumed**: `MantaEventStore.addRawFrameHandler` (no edit to WS02's
  store), `AccountsStore`/`AccountsSelectors` (WS08, read-only),
  `SessionListStore.projects` (WS04, read-only), C6 untouched (no schema
  change: `optimizerEnabled`, `cacheTtl`, `alwaysShowUsage` already exist).
- C2/C3/C5/C7: C7 only (tests as listed). No new stream frames.

## Deferred

- **Model tier tag + guide blurb** in the models list and its search
  ("fast/balanced/deep", "good for"): they come from `src/shared/modelGuide.mjs`,
  a JS data table with no wire channel. Porting it forks curated data; F4's new
  channel carries `tier` for matched rows only. iOS shows the provider's own
  `description` (override) where present. Revisit with a `models:guide` read if
  wanted.
- **Push notification at 90 % / limit**: the box sends none today; adding one
  is a server routing decision (notification tiers) outside this parity
  effort. "Remind me at reset" already produces a real push via the schedule
  `notify` job.
- **Optimizer per-session savings list** (`bySession` detail beyond the count):
  desktop shows only the count too.
- **Desktop's "restart opencode" banner** after subagent changes: obsolete on
  V2 (writes hot-apply); iOS deliberately does not reproduce it.

## Open questions

1. Weekly ≥ 90 %: the per-chat weekly banner (existing) and the new app-level
   warn banner can both show once. Default: keep both (the app-level one is
   transient; the chat one is the persistent reminder).
2. Who owns `ChatModelStore.swift` for M5? Default: assign to WS09 (no other
   workstream lists it).
3. Should the `models:unidentified` row derivation also replace the desktop's
   client-side derivation? Default: no — desktop unchanged in this effort; the
   parity test keeps them aligned.
