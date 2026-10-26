import Foundation

// ===========================================================================
// Auto-handoff — pure models + decisions (spec 2026-10-26-auto-handoff §3, §6.4,
// §7, §8, §9, §11, §15).
//
// Foundation-only on purpose so it compiles in the Linux `swift test` view of
// the app (Package.swift). Everything that draws or does I/O lives in
// `HandoffStore.swift` / `HandoffViews.swift`; the decisions they make — which
// badge a state gets, whether the chat on screen should switch to a successor,
// how a carried-over draft merges, which records are pinned — live here so they
// are unit-tested without a view or a box.
//
// Decoding is deliberately tolerant: the server half is built against the same
// contract by someone else, so an absent optional field or an unknown state
// string must degrade to "not shown", never throw the whole reply away.
// ===========================================================================

// MARK: - Record

/// A handoff record's lifecycle state (§11). An unknown wire string is kept
/// verbatim so a newer box never breaks an older app.
enum HandoffState: Equatable, Sendable {
    case requested, generating, ready, starting, committed, failed, cancelled
    case other(String)

    init(wire: String) {
        switch wire {
        case "requested": self = .requested
        case "generating": self = .generating
        case "ready": self = .ready
        case "starting": self = .starting
        case "committed": self = .committed
        case "failed": self = .failed
        case "cancelled": self = .cancelled
        default: self = .other(wire)
        }
    }
}

/// How a start lands: `clear` replaces the predecessor in its window, `newSession`
/// branches into a new window (§1).
enum HandoffHow: String, Sendable {
    case clear = "clear"
    case newSession = "new-session"
}

/// What the successor is given (§1): `send` = the handoff text is its first turn,
/// `draft` = it is placed in the composer unsent.
enum HandoffDisposition: String, Sendable {
    case send
    case draft
    case armed
}

struct HandoffRecord: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var fromSessionId: String
    var successorId: String?
    var messageId: String?
    var kind: String?
    var trigger: String
    var state: HandoffState
    var step: String?
    var how: String?
    var disposition: String?
    var text: String
    var reason: String?
    /// Not part of the §11 contract; shown in the continuation notice only when
    /// the box happens to report it.
    var contextTokens: Double?
    var createdAt: Double?
    var updatedAt: Double?

    init(
        id: String,
        fromSessionId: String,
        successorId: String? = nil,
        messageId: String? = nil,
        kind: String? = nil,
        trigger: String = "user",
        state: HandoffState,
        step: String? = nil,
        how: String? = nil,
        disposition: String? = nil,
        text: String = "",
        reason: String? = nil,
        contextTokens: Double? = nil,
        createdAt: Double? = nil,
        updatedAt: Double? = nil
    ) {
        self.id = id
        self.fromSessionId = fromSessionId
        self.successorId = successorId
        self.messageId = messageId
        self.kind = kind
        self.trigger = trigger
        self.state = state
        self.step = step
        self.how = how
        self.disposition = disposition
        self.text = text
        self.reason = reason
        self.contextTokens = contextTokens
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, fromSessionId, successorId, messageId, kind, trigger, state, step
        case how, disposition, text, reason, contextTokens, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        fromSessionId = (try? c.decodeIfPresent(String.self, forKey: .fromSessionId)) ?? ""
        successorId = Self.nonEmpty(try? c.decodeIfPresent(String.self, forKey: .successorId))
        messageId = Self.nonEmpty(try? c.decodeIfPresent(String.self, forKey: .messageId))
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        trigger = (try? c.decodeIfPresent(String.self, forKey: .trigger)) ?? ""
        state = HandoffState(wire: (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "")
        step = try? c.decodeIfPresent(String.self, forKey: .step)
        how = try? c.decodeIfPresent(String.self, forKey: .how)
        disposition = try? c.decodeIfPresent(String.self, forKey: .disposition)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        reason = Self.nonEmpty(try? c.decodeIfPresent(String.self, forKey: .reason))
        contextTokens = try? c.decodeIfPresent(Double.self, forKey: .contextTokens)
        createdAt = try? c.decodeIfPresent(Double.self, forKey: .createdAt)
        updatedAt = try? c.decodeIfPresent(Double.self, forKey: .updatedAt)
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let value = s, !value.isEmpty else { return nil }
        return value
    }
}

/// `{handoff}` on create/get/start/retry; a bare record is accepted too, so a
/// box that unwraps the envelope still decodes.
struct HandoffEnvelope: Decodable, Sendable {
    let handoff: HandoffRecord

    private enum Keys: String, CodingKey { case handoff }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if c.contains(.handoff) {
            handoff = try c.decode(HandoffRecord.self, forKey: .handoff)
        } else {
            handoff = try HandoffRecord(from: decoder)
        }
    }
}

struct HandoffLinks: Decodable, Equatable, Sendable {
    var replacedBy: String?
    var replaces: String?
    var branchedFrom: String?
    var branches: [String]

    init(replacedBy: String? = nil, replaces: String? = nil, branchedFrom: String? = nil, branches: [String] = []) {
        self.replacedBy = replacedBy
        self.replaces = replaces
        self.branchedFrom = branchedFrom
        self.branches = branches
    }

    private enum CodingKeys: String, CodingKey { case replacedBy, replaces, branchedFrom, branches }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func id(_ key: CodingKeys) -> String? {
            guard let s = (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil, !s.isEmpty else { return nil }
            return s
        }
        replacedBy = id(.replacedBy)
        replaces = id(.replaces)
        branchedFrom = id(.branchedFrom)
        branches = (try? c.decodeIfPresent([String].self, forKey: .branches)) ?? []
    }
}

/// A successor's pending delivery state (§7). Only what the client reads:
/// the armed `preamble` and the `draft` + its revision.
struct HandoffContinuation: Decodable, Equatable, Sendable {
    var preamble: String?
    var draft: String?
    /// Echoed back verbatim on `draft-consumed`, so it is kept as the JSON value
    /// the box sent (a counter or a string — the client never interprets it).
    var draftRevision: JSONValue?

    init(preamble: String? = nil, draft: String? = nil, draftRevision: JSONValue? = nil) {
        self.preamble = preamble
        self.draft = draft
        self.draftRevision = draftRevision
    }

    private enum CodingKeys: String, CodingKey { case preamble, draft, draftRevision }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) -> String? {
            guard let s = (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil, !s.isEmpty else { return nil }
            return s
        }
        preamble = text(.preamble)
        draft = text(.draft)
        let revision = (try? c.decodeIfPresent(JSONValue.self, forKey: .draftRevision)) ?? nil
        if case .null? = revision { draftRevision = nil } else { draftRevision = revision }
    }

    /// The armed preamble is shown only while it is unconsumed (the box clears it
    /// once the first admitted message is accepted).
    var hasPreamble: Bool { !(preamble ?? "").isEmpty }
}

/// `handoff:list` → `{records, links, continuation?}`. A malformed record is
/// dropped rather than failing the whole list.
struct HandoffListResult: Decodable, Equatable, Sendable {
    var records: [HandoffRecord]
    var links: HandoffLinks?
    var continuation: HandoffContinuation?

    init(records: [HandoffRecord] = [], links: HandoffLinks? = nil, continuation: HandoffContinuation? = nil) {
        self.records = records
        self.links = links
        self.continuation = continuation
    }

    private enum CodingKeys: String, CodingKey { case records, links, continuation }
    private struct Lossy: Decodable {
        let record: HandoffRecord?
        init(from decoder: Decoder) throws { record = try? HandoffRecord(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let lossy = (try? c.decodeIfPresent([Lossy].self, forKey: .records)) ?? []
        records = lossy.compactMap(\.record)
        links = (try? c.decodeIfPresent(HandoffLinks.self, forKey: .links)) ?? nil
        continuation = (try? c.decodeIfPresent(HandoffContinuation.self, forKey: .continuation)) ?? nil
    }
}

// MARK: - Bus event + the shape reconciliation reads

/// The facts reconciliation needs, shared by a full record and a bus event.
struct HandoffCommit: Equatable, Sendable {
    var id: String
    var fromSessionId: String
    var successorId: String?
    var state: HandoffState
    var how: String?
    var disposition: String?
}

extension HandoffRecord {
    var commit: HandoffCommit {
        HandoffCommit(id: id, fromSessionId: fromSessionId, successorId: successorId,
                      state: state, how: how, disposition: disposition)
    }
}

/// `{kind:"handoff", payload:{id, fromSessionId, successorId?, state, how?, disposition?}}`
/// published on every change (§11).
struct HandoffBusEvent: Decodable, Equatable, Sendable {
    var id: String
    var fromSessionId: String
    var successorId: String?
    var state: HandoffState
    var how: String?
    var disposition: String?

    private enum CodingKeys: String, CodingKey { case id, fromSessionId, successorId, state, how, disposition }

    init(id: String, fromSessionId: String, successorId: String? = nil, state: HandoffState,
         how: String? = nil, disposition: String? = nil) {
        self.id = id
        self.fromSessionId = fromSessionId
        self.successorId = successorId
        self.state = state
        self.how = how
        self.disposition = disposition
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        fromSessionId = (try? c.decodeIfPresent(String.self, forKey: .fromSessionId)) ?? ""
        let succ = (try? c.decodeIfPresent(String.self, forKey: .successorId)) ?? nil
        successorId = (succ?.isEmpty ?? true) ? nil : succ
        state = HandoffState(wire: (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "")
        how = (try? c.decodeIfPresent(String.self, forKey: .how)) ?? nil
        disposition = (try? c.decodeIfPresent(String.self, forKey: .disposition)) ?? nil
    }

    var commit: HandoffCommit {
        HandoffCommit(id: id, fromSessionId: fromSessionId, successorId: successorId,
                      state: state, how: how, disposition: disposition)
    }

    /// nil for any other frame kind or a payload that is not a handoff event.
    static func from(frame: MantaStreamFrame) -> HandoffBusEvent? {
        guard frame.kind == "handoff" else { return nil }
        return (try? frame.decodedPayload(HandoffBusEvent.self)) ?? nil
    }
}

// MARK: - Tool part marker (§3, §15)

/// The agent-path `handoff` tool part's output ends with
/// `<!-- manta-handoff:<id> -->`; the card is drawn from the record that id names.
enum HandoffToolMarker {
    static let pattern = "<!-- manta-handoff:([A-Za-z0-9_-]+) -->"

    private static func regex() -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern)
    }

    static func id(in output: String) -> String? {
        guard let re = regex() else { return nil }
        let ns = output as NSString
        guard let match = re.firstMatch(in: output, range: NSRange(location: 0, length: ns.length)),
              match.numberOfRanges > 1 else { return nil }
        return ns.substring(with: match.range(at: 1))
    }

    /// The status line with the marker removed.
    static func stripped(_ output: String) -> String {
        guard let re = regex() else { return output }
        let ns = output as NSString
        let cleaned = re.stringByReplacingMatches(
            in: output, range: NSRange(location: 0, length: ns.length), withTemplate: "")
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A `handoff` tool part as the transcript sees it. Pure data, so the block
/// stays Equatable and its row identity (the part id) survives a refetch.
struct HandoffToolRef: Equatable, Sendable {
    let partId: String
    /// nil until the tool has produced its output (still running / errored).
    let handoffId: String?
    /// The tool's status line without the marker.
    let statusLine: String
    /// `state.status` as the wire spells it.
    let toolStatus: String

    static func isHandoffTool(_ part: OpencodePart) -> Bool {
        guard part.type == "tool" else { return false }
        return (ChatJSON.string(part.extra["tool"]) ?? "").lowercased() == "handoff"
    }

    static func from(part: OpencodePart) -> HandoffToolRef? {
        guard isHandoffTool(part) else { return nil }
        let state = ChatJSON.object(part.extra["state"]) ?? [:]
        let output = ChatJSON.string(state["output"]) ?? ""
        return HandoffToolRef(
            partId: part.id,
            handoffId: HandoffToolMarker.id(in: output),
            statusLine: HandoffToolMarker.stripped(output),
            toolStatus: (ChatJSON.string(state["status"]) ?? "").lowercased()
        )
    }
}

// MARK: - Badge + actions

enum HandoffBadgeTone: Equatable, Sendable { case neutral, progress, ok, danger }

struct HandoffBadge: Equatable, Sendable {
    let label: String
    let tone: HandoffBadgeTone
    /// "started → tap to open": the badge is a link to the successor.
    let opensSuccessor: Bool
}

enum HandoffCardLogic {
    /// §3 header badge: preparing / ready / starting / started → link / failed.
    static func badge(for record: HandoffRecord) -> HandoffBadge {
        switch record.state {
        case .requested, .generating: return HandoffBadge(label: "Preparing", tone: .progress, opensSuccessor: false)
        case .ready: return HandoffBadge(label: "Ready", tone: .ok, opensSuccessor: false)
        case .starting: return HandoffBadge(label: "Starting", tone: .progress, opensSuccessor: false)
        case .committed:
            return HandoffBadge(label: "Started", tone: .ok, opensSuccessor: (record.successorId ?? "").isEmpty == false)
        case .failed: return HandoffBadge(label: "Failed", tone: .danger, opensSuccessor: false)
        case .cancelled: return HandoffBadge(label: "Cancelled", tone: .neutral, opensSuccessor: false)
        case .other(let raw): return HandoffBadge(label: raw.isEmpty ? "Unknown" : raw, tone: .neutral, opensSuccessor: false)
        }
    }

    /// Every action (Copy, Clear & start, Start in new session, Edit first) is
    /// enabled only in `ready`, and so disabled for everyone once started (§3).
    static func actionsEnabled(_ record: HandoffRecord) -> Bool { record.state == .ready }

    static func showsRetry(_ record: HandoffRecord) -> Bool { record.state == .failed }

    /// Who produced it, as the header's source label.
    static func sourceLabel(_ record: HandoffRecord) -> String {
        switch record.trigger {
        case "agent": return "agent"
        case "auto": return "auto"
        case "button": return "button"
        case "user": return "you"
        default: return record.kind == "auto" ? "auto" : (record.trigger.isEmpty ? "manual" : record.trigger)
        }
    }

    /// The text a start would carry (`text?` override aside).
    static let expiredCopy = "This handoff has expired"

    /// A server record is pinned above the composer when it did not come from the
    /// agent tool (that card renders inline) and is still actionable or
    /// informative: preparing, ready, starting or failed. `requested`/
    /// `generating` are included so pressing "Hand off" shows something at once.
    static func pinned(records: [HandoffRecord], sessionId: String) -> [HandoffRecord] {
        records
            .filter { record in
                guard record.fromSessionId == sessionId, record.trigger != "agent" else { return false }
                switch record.state {
                case .requested, .generating, .ready, .starting, .failed: return true
                case .committed, .cancelled, .other: return false
                }
            }
            .sorted { ($0.createdAt ?? 0) < ($1.createdAt ?? 0) }
    }

    // MARK: Collapse (markdown body, ~12 lines)

    static let collapsedLineLimit = 12

    static func isCollapsible(_ text: String) -> Bool {
        text.components(separatedBy: "\n").count > collapsedLineLimit
    }

    /// The first ~12 lines when collapsed, the whole text when expanded.
    static func visibleText(_ text: String, expanded: Bool) -> String {
        guard !expanded, isCollapsible(text) else { return text }
        return text.components(separatedBy: "\n").prefix(collapsedLineLimit).joined(separator: "\n")
    }
}

// MARK: - Reconciliation (§6.4)

enum HandoffReconcile {
    enum Action: Equatable, Sendable {
        case none
        /// A committed REPLACEMENT while viewing the predecessor: show the successor.
        case switchTo(String)
        /// A committed BRANCH this device started: open the new session.
        case openBranch(String)
    }

    /// Decide what the chat on screen (`viewing`) should do about a commit.
    /// A replacement switches whatever device is showing the predecessor; a
    /// branch only moves the device that started it (`awaitingBranch`).
    static func action(viewing: String, commit: HandoffCommit, awaitingBranch: Set<String>) -> Action {
        guard commit.state == .committed,
              let successor = commit.successorId, !successor.isEmpty,
              successor != viewing,
              commit.fromSessionId == viewing else { return .none }
        switch commit.how {
        case HandoffHow.clear.rawValue: return .switchTo(successor)
        case HandoffHow.newSession.rawValue:
            return awaitingBranch.contains(commit.id) ? .openBranch(successor) : .none
        default: return .none
        }
    }

    /// Reconnect/load path: the box's replacement link says this session has
    /// been replaced even though no frame was seen.
    static func action(viewing: String, links: HandoffLinks?) -> Action {
        guard let next = links?.replacedBy, !next.isEmpty, next != viewing else { return .none }
        return .switchTo(next)
    }
}

// MARK: - Composer carry-over (§8)

enum HandoffComposerCarry {
    /// Text moved from the predecessor's composer onto the successor's. A
    /// successor that already holds a draft (Edit first) keeps it on top and the
    /// carried text is appended below it — never overwritten.
    static func appendBelow(_ base: String, _ added: String) -> String {
        let a = added.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty { return base }
        let b = base.trimmingCharacters(in: .whitespacesAndNewlines)
        if b.isEmpty { return added }
        return base.trimmingCharacters(in: .newlines) + "\n\n" + added
    }

    /// Attachments move without duplicates; an id already present is kept once.
    static func appendAttachments<A: Identifiable & Equatable>(_ base: [A], _ added: [A]) -> [A] where A.ID: Hashable {
        var seen = Set(base.map(\.id))
        var result = base
        for item in added where !seen.contains(item.id) {
            seen.insert(item.id)
            result.append(item)
        }
        return result
    }
}

// MARK: - Draft consumption (§7)

/// Minimal key-value seam so the local draft copy is testable without
/// `UserDefaults` (which the live store adapts).
protocol HandoffKeyValueStore {
    func string(forKey key: String) -> String?
    func set(_ value: String?, forKey key: String)
}

/// The client's own persisted copy of a draft. A draft is only reported
/// consumed AFTER this copy exists, so a crash between the two cannot lose the
/// only copy of the user's handoff text.
struct HandoffLocalDraft: Codable, Equatable, Sendable {
    var sessionId: String
    var recordId: String
    var revision: String
    var text: String
}

enum HandoffDraftStorage {
    private static func draftKey(_ sessionId: String) -> String { "manta:handoff-draft:\(sessionId)" }
    private static func consumedKey(_ recordId: String) -> String { "manta:handoff-draft-consumed:\(recordId)" }

    static func save(_ draft: HandoffLocalDraft, in store: HandoffKeyValueStore) {
        guard let data = try? JSONEncoder().encode(draft), let json = String(data: data, encoding: .utf8) else { return }
        store.set(json, forKey: draftKey(draft.sessionId))
    }

    static func load(sessionId: String, from store: HandoffKeyValueStore) -> HandoffLocalDraft? {
        guard let json = store.string(forKey: draftKey(sessionId)),
              let draft = try? JSONDecoder().decode(HandoffLocalDraft.self, from: Data(json.utf8)) else { return nil }
        return draft
    }

    static func clear(sessionId: String, in store: HandoffKeyValueStore) {
        store.set(nil, forKey: draftKey(sessionId))
    }

    static func markConsumed(recordId: String, revision: String, in store: HandoffKeyValueStore) {
        store.set(revision, forKey: consumedKey(recordId))
    }

    static func isConsumed(recordId: String, revision: String, in store: HandoffKeyValueStore) -> Bool {
        store.string(forKey: consumedKey(recordId)) == revision
    }

    /// A stable string for a revision JSON value (counter or string).
    static func revisionKey(_ revision: JSONValue) -> String {
        switch revision {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return ""
        case .object, .array:
            guard let data = try? JSONEncoder().encode(revision), let s = String(data: data, encoding: .utf8) else { return "" }
            return s
        }
    }

    /// The draft a client should load for `sessionId`, or nil when there is none
    /// or its revision is already consumed. The record that carries it is the
    /// newest committed `draft` record whose successor is this session.
    static func pending(
        sessionId: String,
        records: [HandoffRecord],
        continuation: HandoffContinuation?,
        isConsumed: (String, String) -> Bool
    ) -> HandoffLocalDraft? {
        guard let continuation, let draft = continuation.draft, !draft.isEmpty,
              let revision = continuation.draftRevision else { return nil }
        let key = revisionKey(revision)
        guard !key.isEmpty else { return nil }
        let carrier = records
            .filter { $0.successorId == sessionId && $0.disposition == HandoffDisposition.draft.rawValue }
            .max { ($0.updatedAt ?? $0.createdAt ?? 0) < ($1.updatedAt ?? $1.createdAt ?? 0) }
        guard let carrier, !isConsumed(carrier.id, key) else { return nil }
        return HandoffLocalDraft(sessionId: sessionId, recordId: carrier.id, revision: key, text: draft)
    }
}

// MARK: - Handoff mode (§9)

enum HandoffMode: String, CaseIterable, Identifiable, Sendable {
    case auto, suggest, off

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .suggest: return "Suggest"
        case .off: return "Off"
        }
    }

    var caption: String {
        switch self {
        case .auto: return "Hand off long chats automatically"
        case .suggest: return "Offer a handoff, never start one"
        case .off: return "Only when you or the agent ask"
        }
    }

    /// The server default is `auto`; an absent or unrecognised value reads as it.
    static func from(config: [String: JSONValue]?) -> HandoffMode {
        guard let raw = ChatJSON.string(config?["handoffMode"]), let mode = HandoffMode(rawValue: raw) else { return .auto }
        return mode
    }
}

// MARK: - Previous sessions + notice (§9)

struct HandoffPreviousEntry: Equatable, Identifiable, Sendable {
    enum Kind: Equatable, Sendable { case predecessor, branchedFrom }
    let sessionId: String
    let kind: Kind
    var id: String { "\(kind == .predecessor ? "p" : "b"):\(sessionId)" }
}

enum HandoffPrevious {
    /// The lineage walk: `lineage[0]` is the session on screen, then its
    /// predecessor, and so on. Each predecessor is listed nearest-first (newest
    /// first); a branch origin follows the lineage member it belongs to.
    static func entries(lineage: [(sessionId: String, links: HandoffLinks?)]) -> [HandoffPreviousEntry] {
        var out: [HandoffPreviousEntry] = []
        var seen = Set<String>()
        for (index, member) in lineage.enumerated() {
            if index > 0, seen.insert("p:" + member.sessionId).inserted {
                out.append(HandoffPreviousEntry(sessionId: member.sessionId, kind: .predecessor))
            }
            if let origin = member.links?.branchedFrom, !origin.isEmpty, seen.insert("b:" + origin).inserted {
                out.append(HandoffPreviousEntry(sessionId: origin, kind: .branchedFrom))
            }
        }
        return out
    }

    /// The notice at the top of a successor: "Continued from <title> — handed off
    /// at 182k tokens". `tokens` is shown only when the box reported it.
    struct Notice: Equatable, Sendable {
        let text: String
        /// The session "View previous" opens.
        let previousSessionId: String
    }

    static func notice(links: HandoffLinks?, title: (String) -> String?, handedOffTokens: Double?) -> Notice? {
        if let from = links?.replaces, !from.isEmpty {
            var text = "Continued from \(title(from) ?? "previous session")"
            if let tokens = handedOffTokens, tokens > 0 { text += " — handed off at \(UsageMeters.formatTokens(tokens)) tokens" }
            return Notice(text: text, previousSessionId: from)
        }
        if let origin = links?.branchedFrom, !origin.isEmpty {
            return Notice(text: "Branched from \(title(origin) ?? "previous session")", previousSessionId: origin)
        }
        return nil
    }
}

// MARK: - Errors

enum HandoffFailure {
    /// A user-facing line for a failed handoff call. The box's error string is a
    /// short code; only the ones a person can act on get their own wording.
    static func message(_ error: Error, doing action: String) -> String {
        let raw: String
        switch error {
        case MantaError.server(let s): raw = s.lowercased()
        case MantaError.transport(let s): raw = s.lowercased()
        case MantaError.authRequired: return "\(action) — sign in again"
        default: raw = ""
        }
        if raw.contains("already_started") { return "That handoff was already started" }
        if raw.contains("busy") { return "\(action) — the session is busy, try again in a moment" }
        if raw.contains("not_ready") { return "\(action) — the handoff isn't ready yet" }
        if raw.contains("expired") { return HandoffCardLogic.expiredCopy }
        return "\(action) — check the connection"
    }

    static func isExpired(_ error: Error) -> Bool {
        if case MantaError.server(let s) = error { return s.lowercased().contains("expired") || s.lowercased().contains("not found") }
        return false
    }

    static func isAlreadyStarted(_ error: Error) -> Bool {
        if case MantaError.server(let s) = error { return s.lowercased().contains("already_started") }
        return false
    }
}
