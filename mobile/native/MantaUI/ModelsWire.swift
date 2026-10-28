import Foundation

// ===========================================================================
// WS09 — wire types for the box-computed models / spend / usage views
// (09-models-usage.md "Server-first"). The BOX owns every rule behind these
// shapes (src/server/modelsTable.mjs, modelsUnidentified.mjs, ledgerView.mjs,
// optimizer/view.mjs, modelsPricing.mjs, usageResumeView.mjs, usageAlerts.mjs);
// the phone decodes them and renders them verbatim. Foundation-only so it is
// covered by `verify.sh` (Package.swift manifest M-09-7).
//
// Decoding is lenient on purpose: optional fields default, so a box that adds a
// field never breaks the app, and an older box that lacks a block (`view`,
// `tone`, `unpricedByProvider`) decodes to nil — which the screens turn into
// "Update your box to use this." (D24 wire compat), never into zeros.
// ===========================================================================

/// An unknown-channel rejection means the box predates the feature (D24) — classified
/// by `BoxCapabilities.isUnknownChannel`.
enum ModelsCapability {
    static let updateYourBox = "Update your box to use this."

}

extension ModelsCapability {
    /// A short, human reason for a failed call (the box's own sentence when it sent one).
    static func reason(_ error: Error) -> String {
        switch error {
        case MantaError.server(let message): return message
        case MantaError.transport(let message): return message
        case MantaError.authRequired: return "this device is no longer signed in to the box"
        default: return error.localizedDescription
        }
    }
}

/// Money / integer formatting is presentational (KEEP-CLIENT).
enum ModelsFormat {
    static func money(_ value: Double) -> String {
        let cents = (value * 100).rounded() / 100
        return "$" + String(format: "%.2f", cents.isFinite ? cents : 0)
    }

    static func count(_ value: Int, locale: Locale = .current) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = locale
        return f.string(from: NSNumber(value: value)) ?? String(value)
    }
}

// MARK: - models:table / models:picker

struct ModelsTableRowWire: Decodable, Equatable, Sendable, Identifiable {
    struct Editable: Decodable, Equatable, Sendable {
        var name: String = ""
        var description: String = ""
        var context: Int? = nil
    }

    var key: String
    var providerID: String
    var modelID: String
    var name: String
    var contextLabel: String? = nil
    var tier: String? = nil
    var description: String? = nil
    var searchText: String = ""
    var deprecated: Bool = false
    var deprecatedLocked: Bool = false
    var isMain: Bool = false
    var isSub: Bool = false
    var isDefault: Bool = false
    var canMakeDefault: Bool = false
    var defaultHint: String? = nil
    var editable: Editable = Editable()

    var id: String { key }

    enum CodingKeys: String, CodingKey {
        case key, providerID, modelID, name, contextLabel, tier, description, searchText
        case deprecated, deprecatedLocked, isMain, isSub, isDefault, canMakeDefault, defaultHint, editable
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        providerID = try c.decode(String.self, forKey: .providerID)
        modelID = try c.decode(String.self, forKey: .modelID)
        name = try c.decode(String.self, forKey: .name)
        contextLabel = try c.decodeIfPresent(String.self, forKey: .contextLabel)
        tier = try c.decodeIfPresent(String.self, forKey: .tier)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        searchText = try c.decodeIfPresent(String.self, forKey: .searchText) ?? ""
        deprecated = try c.decodeIfPresent(Bool.self, forKey: .deprecated) ?? false
        deprecatedLocked = try c.decodeIfPresent(Bool.self, forKey: .deprecatedLocked) ?? false
        isMain = try c.decodeIfPresent(Bool.self, forKey: .isMain) ?? false
        isSub = try c.decodeIfPresent(Bool.self, forKey: .isSub) ?? false
        isDefault = try c.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        canMakeDefault = try c.decodeIfPresent(Bool.self, forKey: .canMakeDefault) ?? false
        defaultHint = try c.decodeIfPresent(String.self, forKey: .defaultHint)
        editable = try c.decodeIfPresent(Editable.self, forKey: .editable) ?? Editable()
    }

    init(key: String, providerID: String, modelID: String, name: String, contextLabel: String? = nil,
         tier: String? = nil, description: String? = nil, searchText: String = "", deprecated: Bool = false,
         deprecatedLocked: Bool = false, isMain: Bool = true, isSub: Bool = true, isDefault: Bool = false,
         canMakeDefault: Bool = true, defaultHint: String? = nil, editable: Editable = Editable()) {
        self.key = key; self.providerID = providerID; self.modelID = modelID; self.name = name
        self.contextLabel = contextLabel; self.tier = tier; self.description = description
        self.searchText = searchText; self.deprecated = deprecated; self.deprecatedLocked = deprecatedLocked
        self.isMain = isMain; self.isSub = isSub; self.isDefault = isDefault
        self.canMakeDefault = canMakeDefault; self.defaultHint = defaultHint; self.editable = editable
    }
}

struct ModelsTableWire: Decodable, Equatable, Sendable {
    struct DefaultLine: Decodable, Equatable, Sendable {
        var name: String
        var providerID: String
    }
    var defaultKey: String? = nil
    var defaultLine: DefaultLine? = nil
    var rows: [ModelsTableRowWire] = []

    init(defaultKey: String? = nil, defaultLine: DefaultLine? = nil, rows: [ModelsTableRowWire] = []) {
        self.defaultKey = defaultKey; self.defaultLine = defaultLine; self.rows = rows
    }

    enum CodingKeys: String, CodingKey { case defaultKey, defaultLine, rows }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        defaultKey = try c.decodeIfPresent(String.self, forKey: .defaultKey)
        defaultLine = try c.decodeIfPresent(DefaultLine.self, forKey: .defaultLine)
        rows = try c.decodeIfPresent([ModelsTableRowWire].self, forKey: .rows) ?? []
    }
}

/// Reply of every `models:*` write: `{ok:true, table, message, outcome?, retry?}` or
/// `{ok:false, field?, code, message}`.
struct ModelsWriteReply: Decodable, Equatable, Sendable {
    var ok: Bool
    var table: ModelsTableWire? = nil
    var message: String = ""
    var field: String? = nil
    var code: String? = nil
    /// "applied" | "not-applied" | "saved-not-live" (set-sub / opt-in / retry-sub-sync).
    var outcome: String? = nil
    var retry: Bool? = nil
    var ignored: [String]? = nil

    /// A write that was saved but whose subagent reconcile did not fully land.
    var isPartial: Bool { ok && outcome != nil && outcome != "applied" }

    enum CodingKeys: String, CodingKey { case ok, table, message, field, code, outcome, retry, ignored }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        table = try c.decodeIfPresent(ModelsTableWire.self, forKey: .table)
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        field = try c.decodeIfPresent(String.self, forKey: .field)
        code = try c.decodeIfPresent(String.self, forKey: .code)
        outcome = try c.decodeIfPresent(String.self, forKey: .outcome)
        retry = try c.decodeIfPresent(Bool.self, forKey: .retry)
        ignored = try c.decodeIfPresent([String].self, forKey: .ignored)
    }

    init(ok: Bool, table: ModelsTableWire? = nil, message: String = "", field: String? = nil, code: String? = nil,
         outcome: String? = nil, retry: Bool? = nil, ignored: [String]? = nil) {
        self.ok = ok; self.table = table; self.message = message; self.field = field; self.code = code
        self.outcome = outcome; self.retry = retry; self.ignored = ignored
    }
}

struct ModelsPickerGroupWire: Decodable, Equatable, Sendable {
    var provider: String
    var keys: [String]
}

struct ModelsPickerRecentWire: Decodable, Equatable, Sendable {
    var providerID: String
    var modelID: String
    var variant: String? = nil
    var fast: Bool? = nil
    var key: String
}

struct ModelsPickerWire: Decodable, Equatable, Sendable {
    var groups: [ModelsPickerGroupWire] = []
    var locked: [String] = []
    var selectable: [String] = []
    var delegateGroups: [ModelsPickerGroupWire] = []
    var recents: [ModelsPickerRecentWire] = []

    enum CodingKeys: String, CodingKey { case groups, locked, selectable, delegateGroups, recents }

    init(groups: [ModelsPickerGroupWire] = [], locked: [String] = [], selectable: [String] = [],
         delegateGroups: [ModelsPickerGroupWire] = [], recents: [ModelsPickerRecentWire] = []) {
        self.groups = groups; self.locked = locked; self.selectable = selectable
        self.delegateGroups = delegateGroups; self.recents = recents
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        groups = try c.decodeIfPresent([ModelsPickerGroupWire].self, forKey: .groups) ?? []
        locked = try c.decodeIfPresent([String].self, forKey: .locked) ?? []
        selectable = try c.decodeIfPresent([String].self, forKey: .selectable) ?? []
        delegateGroups = try c.decodeIfPresent([ModelsPickerGroupWire].self, forKey: .delegateGroups) ?? []
        recents = try c.decodeIfPresent([ModelsPickerRecentWire].self, forKey: .recents) ?? []
    }
}

// MARK: - ledger:summary

struct LedgerViewWire: Decodable, Equatable, Sendable {
    struct Segment: Decodable, Equatable, Sendable {
        var kind: String
        var label: String
        var pct: Int
        var inline: Bool
    }
    struct TopModel: Decodable, Equatable, Sendable {
        var key: String
        var turns: Int
        var costPerTurn: Double
        var tokensPerSec: Double? = nil
        var cost: Double
    }
    struct Agent: Decodable, Equatable, Sendable {
        var label: String
        var isChild: Bool
        var turns: Int
        var costPerTurn: Double
        var cost: Double
    }
    var segments: [Segment]
    var caption: String
    var topModels: [TopModel]
    var agents: [Agent]
    var emptyModels: String
    var emptyAgents: String
}

/// `ledger:summary`: `{supported:false}` on a box without the runtime; `view` is absent on an older box.
struct LedgerSummaryWire: Decodable, Equatable, Sendable {
    var supported: Bool
    var view: LedgerViewWire? = nil
}

// MARK: - optimizer:summary / optimizer:series / optimizer:prices

struct OptimizerStatWire: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String
    var value: String
    var detail: String
    var tone: String
}

struct OptimizerSummaryViewWire: Decodable, Equatable, Sendable {
    struct Switch: Decodable, Equatable, Sendable { var on: Bool; var label: String; var body: String }
    struct Subrow: Decodable, Equatable, Sendable, Identifiable { var id: String; var name: String; var text: String; var chip: String }
    struct Pressure: Decodable, Equatable, Sendable { var text: String; var tone: String }
    struct Window: Decodable, Equatable, Sendable, Identifiable {
        var key: String
        var title: String
        var resetsAt: Double? = nil
        var pct: Double
        var pctLabel: String
        var band: String
        var forecastPct: Double? = nil
        var forecastWarn: Bool
        var forecastLabel: String
        var pressure: Pressure
        var id: String { key }
    }
    struct Metered: Decodable, Equatable, Sendable { var name: String; var role: String; var price: String }
    struct Activity: Decodable, Equatable, Sendable, Identifiable {
        var id: String
        var ts: Double
        var headline: String
        var detail: String
        var rolledBack: Bool
    }
    var `switch`: Switch
    var subrows: [Subrow]
    var windowsCaption: String
    var windows: [Window]
    var metered: [Metered]
    var meteredCaption: String
    var activity: [Activity]
    var activityCaption: String
    var activityEmpty: String
    var stats: [OptimizerStatWire]
}

struct OptimizerSummaryWire: Decodable, Equatable, Sendable {
    var supported: Bool
    var view: OptimizerSummaryViewWire? = nil
}

struct OptimizerSeriesViewWire: Decodable, Equatable, Sendable {
    struct Trimming: Decodable, Equatable, Sendable { var name: String; var text: String; var chip: String }
    struct Legend: Decodable, Equatable, Sendable { var sent: String; var raw: String; var noCounterfactual: String? = nil }
    struct Saving: Decodable, Equatable, Sendable { var text: String; var tone: String }
    var heading: String
    var trimming: Trimming? = nil
    var hasCounterfactual: Bool
    var noActivity: Bool
    var emptyText: String
    var legend: Legend
    var savingLabel: Saving? = nil
    var potentialLine: String? = nil
    var rawValues: [Double]
    var stats: [OptimizerStatWire]
}

struct OptimizerSeriesPointWire: Decodable, Equatable, Sendable {
    var t: Double
    var tokensSent: Double
}

struct OptimizerSeriesWire: Decodable, Equatable, Sendable {
    var supported: Bool
    var range: String? = nil
    var bucket: String? = nil
    var series: [OptimizerSeriesPointWire]? = nil
    var view: OptimizerSeriesViewWire? = nil
}

struct UnpricedGroupWire: Decodable, Equatable, Sendable, Identifiable {
    var providerID: String
    var models: [String]
    var id: String { providerID }
}

/// `optimizer:prices`: only the grouped unpriced list is used; absent on an older box.
struct OptimizerPricesWire: Decodable, Equatable, Sendable {
    var supported: Bool? = nil
    var unpricedByProvider: [UnpricedGroupWire]? = nil
}

struct ModelsSetPriceReply: Decodable, Equatable, Sendable {
    var ok: Bool
    var message: String = ""
    var warning: String? = nil
    var field: String? = nil
    var unpricedByProvider: [UnpricedGroupWire]? = nil

    enum CodingKeys: String, CodingKey { case ok, message, warning, field, unpricedByProvider }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        warning = try c.decodeIfPresent(String.self, forKey: .warning)
        field = try c.decodeIfPresent(String.self, forKey: .field)
        unpricedByProvider = try c.decodeIfPresent([UnpricedGroupWire].self, forKey: .unpricedByProvider)
    }
}

// MARK: - opencode:model-catalog (typeahead only)

struct ModelsCatalogEntryWire: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String? = nil
    var family: String? = nil
    var description: String? = nil
}

struct ModelsCatalogWire: Decodable, Equatable, Sendable {
    var supported: Bool
    var entries: [ModelsCatalogEntryWire] = []

    enum CodingKeys: String, CodingKey { case supported, entries }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        supported = try c.decodeIfPresent(Bool.self, forKey: .supported) ?? false
        entries = try c.decodeIfPresent([ModelsCatalogEntryWire].self, forKey: .entries) ?? []
    }
}

// MARK: - models:unidentified / models:declare

struct UnidentifiedRowWire: Decodable, Equatable, Sendable, Identifiable {
    struct Candidate: Decodable, Equatable, Sendable, Identifiable { var id: String; var name: String }
    var key: String
    var label: String
    var providerID: String
    var modelID: String
    var state: String
    var confidence: String? = nil
    var evidence: String? = nil
    var catalogId: String? = nil
    var candidates: [Candidate] = []
    var missing: [String] = []
    var help: String
    var actions: [String] = []
    var chips: Bool? = nil
    var id: String { key }

    enum CodingKeys: String, CodingKey {
        case key, label, providerID, modelID, state, confidence, evidence, catalogId, candidates, missing, help, actions, chips
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(String.self, forKey: .label)
        providerID = try c.decodeIfPresent(String.self, forKey: .providerID) ?? ""
        modelID = try c.decodeIfPresent(String.self, forKey: .modelID) ?? ""
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "none"
        confidence = try c.decodeIfPresent(String.self, forKey: .confidence)
        evidence = try c.decodeIfPresent(String.self, forKey: .evidence)
        catalogId = try c.decodeIfPresent(String.self, forKey: .catalogId)
        candidates = try c.decodeIfPresent([Candidate].self, forKey: .candidates) ?? []
        missing = try c.decodeIfPresent([String].self, forKey: .missing) ?? []
        help = try c.decodeIfPresent(String.self, forKey: .help) ?? ""
        actions = try c.decodeIfPresent([String].self, forKey: .actions) ?? []
        chips = try c.decodeIfPresent(Bool.self, forKey: .chips)
    }
}

struct UnidentifiedList: Decodable, Equatable, Sendable {
    var supported: Bool
    var intro: String = ""
    var footer: String = ""
    var unavailableText: String? = nil
    var rows: [UnidentifiedRowWire] = []

    enum CodingKeys: String, CodingKey { case supported, intro, footer, unavailableText, rows }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        supported = try c.decodeIfPresent(Bool.self, forKey: .supported) ?? false
        intro = try c.decodeIfPresent(String.self, forKey: .intro) ?? ""
        footer = try c.decodeIfPresent(String.self, forKey: .footer) ?? ""
        unavailableText = try c.decodeIfPresent(String.self, forKey: .unavailableText)
        rows = try c.decodeIfPresent([UnidentifiedRowWire].self, forKey: .rows) ?? []
    }
}

/// The identify editor's form, sent AS TYPED; the box builds and validates the declaration.
struct ModelsDeclareForm: Encodable, Equatable, Sendable {
    var catalogId: String
    /// "free" | "custom" | nil (nothing chosen yet — the box refuses).
    var price: String?
    var costIn: String
    var costOut: String
    /// "none" | "custom".
    var caching: String
    var reads: Bool
    var writes: Bool
}

struct ModelsDeclareReply: Decodable, Equatable, Sendable {
    var ok: Bool
    /// "resolved" | "still-needs" | "catalogue-unavailable".
    var outcome: String? = nil
    var row: UnidentifiedRowWire? = nil
    var list: UnidentifiedList? = nil
    var message: String = ""
    var field: String? = nil
    var code: String? = nil

    enum CodingKeys: String, CodingKey { case ok, outcome, row, list, message, field, code }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        outcome = try c.decodeIfPresent(String.self, forKey: .outcome)
        row = try c.decodeIfPresent(UnidentifiedRowWire.self, forKey: .row)
        list = try c.decodeIfPresent(UnidentifiedList.self, forKey: .list)
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        field = try c.decodeIfPresent(String.self, forKey: .field)
        code = try c.decodeIfPresent(String.self, forKey: .code)
    }
}

// MARK: - usage-stopped:view / usage-stopped:apply

struct UsageResumeRowWire: Decodable, Equatable, Sendable, Identifiable {
    struct Window: Decodable, Equatable, Sendable { var label: String; var resetsAt: Double? = nil }
    struct Cost: Decodable, Equatable, Sendable { var warm: Bool; var reReadTokens: Double; var label: String }
    var conversation: String
    var name: String
    var armed: Bool
    var isNew: Bool
    var snippet: String? = nil
    var provider: String? = nil
    var model: String? = nil
    var window: Window
    var cost: Cost
    var id: String { conversation }
}

struct UsageResumeViewWire: Decodable, Equatable, Sendable {
    struct Group: Decodable, Equatable, Sendable, Identifiable {
        var workspace: String
        var rows: [UsageResumeRowWire]
        var id: String { workspace }
    }
    struct ColdNote: Decodable, Equatable, Sendable { var one: String; var many: String }
    var title: String
    var header: String
    var hasArmed: Bool
    var unarmedCount: Int
    var totalCount: Int
    var emptyText: String
    var groups: [Group]
    var coldNote: ColdNote

    var rows: [UsageResumeRowWire] { groups.flatMap(\.rows) }
}

struct UsageResumePlanWire: Decodable, Equatable, Sendable {
    struct Applied: Decodable, Equatable, Sendable { var armed: [String] = []; var disarmed: [String] = [] }
    struct Failure: Decodable, Equatable, Sendable { var conversation: String; var name: String; var message: String }
    var ok: Bool
    var canApply: Bool = false
    var title: String = ""
    var arm: [String] = []
    var disarm: [String] = []
    var applied: Applied? = nil
    var failed: [Failure]? = nil
    var message: String? = nil

    enum CodingKeys: String, CodingKey { case ok, canApply, title, arm, disarm, applied, failed, message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        canApply = try c.decodeIfPresent(Bool.self, forKey: .canApply) ?? false
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        arm = try c.decodeIfPresent([String].self, forKey: .arm) ?? []
        disarm = try c.decodeIfPresent([String].self, forKey: .disarm) ?? []
        applied = try c.decodeIfPresent(Applied.self, forKey: .applied)
        failed = try c.decodeIfPresent([Failure].self, forKey: .failed)
        message = try c.decodeIfPresent(String.self, forKey: .message)
    }
}

// MARK: - usage:alerts / usage.alert / usage:remind-at-reset

struct UsageAlertWire: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var key: String
    var level: String
    var provider: String
    var windowKind: String
    var windowLabel: String
    var pct: Double
    var resetsAt: Double? = nil
    var text: String
    var raisedAt: Double
    var expiresAt: Double? = nil
    var sticky: Bool
    var canRemind: Bool
    var canKeepGoing: Bool
}

struct UsageAlertsList: Decodable, Equatable, Sendable {
    var bootId: String? = nil
    var revision: Int = 0
    var alerts: [UsageAlertWire] = []

    enum CodingKeys: String, CodingKey { case bootId, revision, alerts }

    init(bootId: String?, revision: Int, alerts: [UsageAlertWire]) {
        self.bootId = bootId; self.revision = revision; self.alerts = alerts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bootId = try c.decodeIfPresent(String.self, forKey: .bootId)
        revision = try c.decodeIfPresent(Int.self, forKey: .revision) ?? 0
        alerts = try c.decodeIfPresent([UsageAlertWire].self, forKey: .alerts) ?? []
    }
}

/// A raw `usage.alert` bus frame payload: exactly one of `alert` / `retired`.
struct UsageAlertFrame: Decodable, Equatable, Sendable {
    var bootId: String
    var revision: Int
    var alert: UsageAlertWire? = nil
    var retired: [String]? = nil

    init(bootId: String, revision: Int, alert: UsageAlertWire? = nil, retired: [String]? = nil) {
        self.bootId = bootId; self.revision = revision; self.alert = alert; self.retired = retired
    }
}

struct UsageRemindReply: Decodable, Equatable, Sendable {
    var ok: Bool
    var fireAt: Double? = nil
    var code: String? = nil
    var message: String? = nil
}
