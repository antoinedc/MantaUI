import Foundation

// ===========================================================================
// WS08 — the pure half of custom endpoints: wire types, the add-endpoint draft
// (slug, validation, collision), the model checklist, the per-model rows,
// the endpoint health words, and — the load-bearing part — how to classify a
// write to `opencode:set-providers` that may not have been atomic.
//
// `opencode:set-providers` writes the config block first and applies the model
// selection second; a selection failure is returned as `{ok:false}` WITHOUT
// undoing the config write, and a lost response can follow a committed write.
// So no endpoint write ever assumes "failed ⇒ nothing changed": after any
// refused or thrown write the screen re-reads `opencode:get-providers` and
// `EndpointWriteReconcile.outcome` says what happened.
//
// Foundation-only (compiled by the Linux SwiftPM package).
// ===========================================================================

// MARK: - Wire types

/// One custom endpoint as `opencode:get-providers` lists it. The API key value
/// never leaves the box — only whether one is set.
struct ProviderEndpoint: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var baseURL: String
    var hasApiKey: Bool = false
    var enabledModels: [String] = []

    private enum CodingKeys: String, CodingKey { case id, name, baseURL, hasApiKey, enabledModels }

    init(id: String, name: String? = nil, baseURL: String = "", hasApiKey: Bool = false, enabledModels: [String] = []) {
        self.id = id
        self.name = name ?? id
        self.baseURL = baseURL
        self.hasApiKey = hasApiKey
        self.enabledModels = enabledModels
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let rawName = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil
        name = (rawName?.isEmpty == false) ? (rawName ?? id) : id
        baseURL = (try? c.decodeIfPresent(String.self, forKey: .baseURL)) ?? ""
        hasApiKey = (try? c.decodeIfPresent(Bool.self, forKey: .hasApiKey)) ?? false
        enabledModels = ((try? c.decodeIfPresent([String].self, forKey: .enabledModels)) ?? nil) ?? []
    }

    /// Name, base URL and the SET of enabled models — what "the state of the
    /// endpoint" means when a write is classified.
    var comparable: EndpointState { EndpointState(name: name, baseURL: baseURL, models: Set(enabledModels)) }
}

struct EndpointState: Equatable, Sendable {
    var name: String
    var baseURL: String
    var models: Set<String>
}

/// `ProviderInput` for `opencode:set-providers`. `apiKey` omitted = keep the
/// stored key; `""` = no key.
struct ProviderEndpointInput: Equatable, Sendable {
    var id: String
    var name: String
    var baseURL: String
    var apiKey: String?
    var enabledModels: [String]

    /// The wire object. The `apiKey` key is OMITTED entirely when nil.
    func payload() -> [String: Any] {
        var out: [String: Any] = ["id": id, "name": name, "baseURL": baseURL, "enabledModels": enabledModels]
        if let apiKey { out["apiKey"] = apiKey }
        return out
    }
}

/// `opencode:discover-models` — `{ok:true, models:[{id}]}` or
/// `{ok:false, error, detail?}`.
struct DiscoverResult: Decodable, Equatable, Sendable {
    var ok: Bool
    var models: [String] = []
    var error: String? = nil
    var detail: String? = nil

    private enum CodingKeys: String, CodingKey { case ok, models, error, detail }
    private struct ModelRow: Decodable { var id: String? }

    init(ok: Bool, models: [String] = [], error: String? = nil, detail: String? = nil) {
        self.ok = ok
        self.models = models
        self.error = error
        self.detail = detail
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        let rows = (try? c.decodeIfPresent(LenientArray<ModelRow>.self, forKey: .models))?.elements ?? []
        var seen = Set<String>()
        models = rows.compactMap { $0.id }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}

/// `opencode:set-providers` — `{ok:true}` or `{ok:false, error}`.
struct ProviderWriteReply: Decodable, Equatable, Sendable {
    var ok: Bool = false
    var error: String? = nil

    private enum CodingKeys: String, CodingKey { case ok, error }

    init(ok: Bool = false, error: String? = nil) {
        self.ok = ok
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }
}

// MARK: - Draft: slug, validation, collision

enum ProviderEndpointDraft {
    /// The subscription ids no custom endpoint may take — an upsert under one of
    /// them would overwrite that provider. Always reserved, even when the status
    /// list is unavailable.
    static let reservedIds: Set<String> = ["anthropic", "openai", "kimi-for-coding"]

    /// The provider id derived from a name (`slugifyProviderId`): lowercase,
    /// ASCII letters and digits, runs of anything else become one hyphen,
    /// no leading or trailing hyphen.
    static func slug(_ name: String) -> String {
        var out = ""
        var pendingHyphen = false
        for scalar in name.lowercased().unicodeScalars {
            let isAlnum = (scalar.value >= 0x61 && scalar.value <= 0x7A) || (scalar.value >= 0x30 && scalar.value <= 0x39)
            if isAlnum {
                if pendingHyphen, !out.isEmpty { out.append("-") }
                pendingHyphen = false
                out.unicodeScalars.append(scalar)
            } else {
                pendingHyphen = true
            }
        }
        return out
    }

    /// Every id that would collide: the endpoints already on the box, the
    /// subscription status ids, and the reserved subscription ids.
    static func takenIds(endpoints: [ProviderEndpoint], statusIds: [String]) -> Set<String> {
        Set(endpoints.map(\.id)).union(statusIds).union(reservedIds)
    }

    static func collision(slug: String, endpoints: [ProviderEndpoint], statusIds: [String]) -> Bool {
        !slug.isEmpty && takenIds(endpoints: endpoints, statusIds: statusIds).contains(slug)
    }

    static func collisionMessage(slug: String) -> String {
        "An endpoint with the id “\(slug)” already exists — choose another name."
    }

    /// Why the draft cannot be tested yet, or nil.
    static func validationError(name: String, baseURL: String, takenIds: Set<String>) -> String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Name is required." }
        let id = slug(name)
        if id.isEmpty { return "Name must contain a letter or digit." }
        if takenIds.contains(id) { return collisionMessage(slug: id) }
        let url = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if url.isEmpty { return "Base URL is required." }
        let lower = url.lowercased()
        if !(lower.hasPrefix("http://") || lower.hasPrefix("https://")) { return "Base URL must start with http:// or https://." }
        return nil
    }

    /// Why a probe failed: "Couldn't reach the endpoint: <detail>".
    static func discoverErrorText(error: String?, detail: String?) -> String {
        let head: String
        switch error {
        case "unreachable": head = "Couldn't reach the endpoint"
        case "unauthorized": head = "The endpoint rejected the key"
        default: head = "The endpoint didn't return a model list"
        }
        if let detail, !detail.isEmpty { return "\(head): \(detail)" }
        return head
    }

    static func discoverErrorText(_ result: DiscoverResult) -> String {
        discoverErrorText(error: result.error, detail: result.detail)
    }

    static let saveInventoryFailed = "Couldn't check your existing endpoints, so nothing was saved — try again."
    static let selectAtLeastOne = "Select at least one model."
    static let inventoryUnavailable = "Couldn't load your endpoints, so a new one can't be checked against them"

    static func saved(name: String, count: Int) -> String {
        "Added \(name) with \(count) model\(count == 1 ? "" : "s")."
    }

    static func savedPartial(name: String, reason: String) -> String {
        "Saved \(name), but the model list couldn't be fully applied — \(reason). Check its switches in Accounts."
    }

    static func notConfirmed(name: String) -> String { "Couldn't confirm whether \(name) was saved." }
}

/// The sentences the saved-endpoint block speaks (switches, refresh, probe, remove).
enum ProviderEndpointCopy {
    static func togglePartial(name: String, reason: String) -> String {
        "Saved \(name), but the model list couldn't be fully applied — \(reason)."
    }

    static func updateFailed(name: String, reason: String) -> String { "Couldn't update \(name) — \(reason)" }

    static func unconfirmedNote(name: String) -> String { "Couldn't confirm what's saved for \(name)." }

    static func refreshFound(name: String, count: Int) -> String {
        "Found \(count) model\(count == 1 ? "" : "s") on \(name)."
    }

    static func refreshFailed(name: String, text: String) -> String { "Couldn't refresh \(name) — \(text)" }

    static func copiedURL(name: String) -> String { "Copied \(name)'s URL." }

    static func removeTitle(name: String) -> String { "Remove \(name)?" }
    static let removeMessage = "Its models leave the model picker. Conversations using one of them will need another model."
    static let removeDestructive = "Remove endpoint"
    static func removed(name: String) -> String { "Removed \(name)." }
    static func removeFailed(name: String, reason: String) -> String { "Couldn't remove \(name) — \(reason)" }
}

// MARK: - Model checklist

/// The model checklist of the add form: every discovered model starts ticked; a
/// filter narrows the visible rows; All / None act on the VISIBLE rows only.
struct ModelChecklistState: Equatable, Sendable {
    private(set) var ids: [String]
    private(set) var selected: Set<String>
    var filter: String = ""

    init(ids: [String], selected: Set<String>? = nil) {
        var seen = Set<String>()
        self.ids = ids.filter { seen.insert($0).inserted }
        self.selected = selected ?? Set(self.ids)
    }

    var visible: [String] {
        let query = filter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return ids }
        return ids.filter { $0.lowercased().contains(query) }
    }

    var selectedCount: Int { ids.filter { selected.contains($0) }.count }
    /// "K of N selected · M shown".
    var countsLine: String { "\(selectedCount) of \(ids.count) selected · \(visible.count) shown" }
    var allChecked: Bool { !visible.isEmpty && visible.allSatisfy { selected.contains($0) } }
    var noneChecked: Bool { !visible.contains { selected.contains($0) } }
    var emptyMessage: String? {
        guard visible.isEmpty, !ids.isEmpty else { return nil }
        return "No model matches “\(filter.trimmingCharacters(in: .whitespacesAndNewlines))”."
    }
    var canSave: Bool { selectedCount > 0 }
    var saveTitle: String { "Save \(selectedCount) model\(selectedCount == 1 ? "" : "s")" }
    /// Selected ids in the box's order.
    var selectedIds: [String] { ids.filter { selected.contains($0) } }

    func isSelected(_ id: String) -> Bool { selected.contains(id) }

    mutating func set(_ id: String, selected on: Bool) {
        guard ids.contains(id) else { return }
        if on { selected.insert(id) } else { selected.remove(id) }
    }

    mutating func selectAllVisible() { selected.formUnion(visible) }
    mutating func selectNoneVisible() { selected.subtract(visible) }
}

// MARK: - Per-model rows (saved endpoint)

enum ProviderEndpointModels {
    /// The switches of a saved endpoint: the discovered list when there is one,
    /// else the enabled ids — plus ids the user switched off on this screen
    /// visit, so a switched-off model stays re-tickable instead of vanishing.
    static func rows(enabled: [String], discovered: [String]?, disabledThisSession: [String]) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        for id in (discovered ?? enabled) + disabledThisSession where !id.isEmpty && seen.insert(id).inserted {
            out.append(id)
        }
        return out
    }

    /// The enabled set after flipping one model, keeping the displayed order.
    static func toggled(enabled: [String], rows: [String], id: String, on: Bool) -> [String] {
        var next = Set(enabled)
        if on { next.insert(id) } else { next.remove(id) }
        var ordered = rows.filter { next.contains($0) }
        let known = Set(ordered)
        ordered.append(contentsOf: enabled.filter { next.contains($0) && !known.contains($0) })
        return ordered
    }

    static let noneInPicker = "No models from this endpoint are in the picker."
}

// MARK: - Write reconciliation

enum EndpointWriteReply: Equatable, Sendable {
    /// `{ok:true}`.
    case ok
    /// `{ok:false, error}`.
    case refused(String)
    /// A transport error — the write may or may not have landed.
    case threw(String)

    var errorText: String {
        switch self {
        case .ok: return ""
        case .refused(let e), .threw(let e): return e
        }
    }
}

enum EndpointWriteExpectation: Equatable, Sendable {
    case present(id: String, enabledModels: [String])
    case absent(id: String)

    var id: String {
        switch self {
        case .present(let id, _), .absent(let id): return id
        }
    }
}

enum EndpointWriteOutcome: Equatable, Sendable {
    /// The endpoint is as the write intended.
    case confirmed
    /// The write landed in part: adopt what the box has.
    case partial(String)
    /// Nothing changed.
    case rejected(String)
    /// The box could not be read back; nobody knows. No rollback is claimed.
    case unconfirmed

    var changeOutcome: ProviderChangeOutcome {
        switch self {
        case .confirmed: return .confirmed
        case .partial: return .partial
        case .rejected: return .rejected
        case .unconfirmed: return .unconfirmed
        }
    }
}

/// What a write that came back unconfirmed is carrying, kept until a re-read
/// settles it. The expectation is the ORIGINAL attempt's: editing the draft
/// afterwards never rewrites it.
struct PendingEndpointWrite: Equatable, Sendable {
    var id: String
    var baseURL: String
    /// The endpoint as it was listed before the write (nil = did not exist).
    var before: ProviderEndpoint?
    var expect: EndpointWriteExpectation
}

enum EndpointRecheck: Equatable, Sendable {
    /// The earlier write is on the box: this is its classified outcome.
    case classified(EndpointWriteOutcome)
    /// Nothing of the earlier write is there; run the normal flow again.
    case writeAgain
}

enum EndpointWriteReconcile {
    /// Classify one write. Order:
    /// 1. reply ok → confirmed.
    /// 2. read-back failed → unconfirmed.
    /// 3. read-back state == expect → confirmed if the reply was lost (`threw`),
    ///    partial if the box refused (something didn't finish).
    /// 4. read-back state == before state → rejected (nothing changed).
    /// 5. otherwise (a third state) → partial.
    static func outcome(reply: EndpointWriteReply,
                        before: ProviderEndpoint?,
                        readBack: Result<[ProviderEndpoint], Error>?,
                        expect: EndpointWriteExpectation) -> EndpointWriteOutcome {
        if case .ok = reply { return .confirmed }
        guard let readBack, case .success(let list) = readBack else { return .unconfirmed }
        let after = list.first { $0.id == expect.id }
        let error = reply.errorText.isEmpty ? "the box didn't confirm the change" : reply.errorText

        if matches(after, expect) {
            if case .threw = reply { return .confirmed }
            return .partial(error)
        }
        if after?.comparable == before?.comparable { return .rejected(error) }
        return .partial(error)
    }

    /// What "the write landed" means: the endpoint exists with the expected SET of
    /// models (or is gone). Deliberately narrower than `ProviderEndpoint.comparable`
    /// (name + base URL + models): a toggle never changes the name or URL, and a
    /// new endpoint's id was proven free by the fresh inventory, so the model set
    /// is the only part of the write that can come out differently. `recheck`
    /// compares the base URL itself.
    private static func matches(_ after: ProviderEndpoint?, _ expect: EndpointWriteExpectation) -> Bool {
        switch expect {
        case .absent:
            return after == nil
        case .present(_, let models):
            guard let after else { return false }
            return Set(after.enabledModels) == Set(models)
        }
    }

    /// Save was pressed again after an unconfirmed write. The fresh inventory is
    /// read through the SAME classifier against the ORIGINAL expectation: the
    /// same id and URL with the expected selection is the earlier write having
    /// landed (confirmed); with a different selection it is partial — never
    /// silently "confirmed". Anything else (absent, or a different URL — a
    /// collision) means nothing of it landed: write again, under the normal
    /// collision guard.
    static func recheck(pending: PendingEndpointWrite, fresh: [ProviderEndpoint]) -> EndpointRecheck {
        guard let found = fresh.first(where: { $0.id == pending.id }),
              normalizedURL(found.baseURL) == normalizedURL(pending.baseURL) else { return .writeAgain }
        let result = outcome(
            reply: .threw("the earlier save wasn't confirmed"),
            before: pending.before,
            readBack: .success(fresh),
            expect: pending.expect
        )
        if case .rejected = result { return .writeAgain }
        return .classified(result)
    }

    private static func normalizedURL(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }
}
