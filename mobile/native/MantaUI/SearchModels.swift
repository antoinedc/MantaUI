import Foundation

// ===========================================================================
// WS06 — conversation search, the pure layer (Foundation only, so it builds
// and tests under `verify.sh`).
//
// Server-first (master D23/D24): the BOX decides which conversations are in
// scope, groups the hits and labels each group (`opencode:search-messages`,
// `scope:"all"`). Nothing here builds a scope, groups hits or composes a title
// from workspace/name — this file only decodes the box's answer, holds the
// query sequencing (stale-result rules, KEEP-CLIENT) and the fixed copy.
// ===========================================================================

// MARK: - Wire

/// `opencode:search-messages` request. Optionals are omitted from the JSON when
/// nil, so a search from the session list sends no `primarySessionId`. There is
/// deliberately no `sessionIds` member: the box owns the scope.
struct SearchRequest: Encodable, Equatable, Sendable {
    let query: String
    /// Always `"all"`.
    let scope: String
    let primarySessionId: String?
}

struct TranscriptHit: Decodable, Equatable, Hashable, Sendable {
    let sessionId: String
    let messageId: String
    /// `"user"`; anything else renders as assistant.
    let role: String
    let pre: String
    let match: String
    let post: String
    /// Milliseconds since the epoch; nil when the box has none.
    let timeCreated: Double?

    var isUser: Bool { role == "user" }
}

struct TranscriptHitGroup: Decodable, Equatable, Identifiable, Sendable {
    let sessionId: String
    /// Only the group of the `primarySessionId` the request named.
    let isCurrent: Bool
    let workspace: String?
    let name: String?
    /// The box's title for the group — shown verbatim, never recomposed.
    let label: String
    let hits: [TranscriptHit]

    var id: String { sessionId }
}

struct SearchResponse: Decodable, Equatable, Sendable {
    let supported: Bool
    /// The old flat list — decoded for completeness, never rendered.
    let hits: [TranscriptHit]
    /// nil = the box predates `search-scope-all-1` (it never sends the key).
    let groups: [TranscriptHitGroup]?
    let truncated: Bool?
    /// The box could not run the search — a failure, never "no matches".
    let degraded: Bool?
}

extension SearchResponse {
    private enum CodingKeys: String, CodingKey {
        case supported, hits, groups, truncated, degraded
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        supported = try c.decode(Bool.self, forKey: .supported)
        hits = try c.decodeIfPresent([TranscriptHit].self, forKey: .hits) ?? []
        groups = try c.decodeIfPresent([TranscriptHitGroup].self, forKey: .groups)
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated)
        degraded = try c.decodeIfPresent(Bool.self, forKey: .degraded)
    }
}

// MARK: - Copy (fixed labels and plurals only — Q5)

enum SearchCopy {
    static let minQueryChars = 2
    static let idleDescription = "Type at least 2 characters."
    static let loadingMessage = "Searching conversations…"
    static let searchingOthers = "Searching other conversations…"
    static let currentTitle = "This conversation"
    static let otherConversations = "Other conversations"
    static let unsupportedMessage = "Search needs a newer server runtime — update the server."
    static let boxTooOldMessage = "Update your box to use search."
    static let degradedReason = "the box couldn't read its history"
    static let truncatedNote = "Showing the newest matches — this history is very large."
    static let jumpUnreachable = "That conversation is no longer open."
    static let placeholder = "Search in conversations…"

    static func normalized(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func isActive(_ raw: String) -> Bool {
        normalized(raw).count >= minQueryChars
    }

    static func currentCount(_ n: Int) -> String {
        n == 1 ? "1 match" : "\(n) matches"
    }

    static func footer(total: Int, conversations: Int) -> String {
        let results = total == 1 ? "1 result" : "\(total) results"
        let convs = conversations == 1 ? "1 conversation" : "\(conversations) conversations"
        return "\(results) · \(convs)"
    }

    static func idleTitle(hasPrimary: Bool) -> String {
        hasPrimary
            ? "Search this conversation — and all others."
            : "Search every conversation."
    }

    static func failedMessage(_ reason: String) -> String {
        "Couldn't search — \(reason)."
    }

    /// "This conversation" when the box marked the group current, else the
    /// box's `label` verbatim. Never composed from `workspace` / `name`.
    static func sectionTitle(_ group: TranscriptHitGroup) -> String {
        group.isCurrent ? currentTitle : group.label
    }

    /// Why a search request failed, in words a person can act on. Only a
    /// message the box wrote for a human passes through.
    static func failureReason(_ error: Error) -> String {
        switch error {
        case MantaError.authRequired:
            return "this device isn't signed in to the box"
        case MantaError.server(let text) where !text.isEmpty:
            return text
        case MantaError.transport(let text) where !text.isEmpty:
            return text
        default:
            return "check the connection"
        }
    }
}

// MARK: - Jump reachability (Q6, KEEP-CLIENT)

enum SearchJump {
    /// `owner` answers "does a window carry this session id right now?"
    /// (`SessionListStore.window(forSessionID:)` bridged to a Bool).
    static func isReachable(sessionId: String, owner: (String) -> Bool) -> Bool {
        owner(sessionId)
    }
}

// MARK: - Query state machine (sequencing is KEEP-CLIENT — Q4)

struct SearchTicket: Equatable, Sendable {
    let seq: Int
    /// The trimmed query.
    let query: String
}

struct SearchQueryState: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        case idle, loading, results, empty, unsupported, boxTooOld
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var groups: [TranscriptHitGroup] = []
    private(set) var truncated = false
    /// The current request generation; anything older is dropped.
    private(set) var seq = 0
    let primarySessionId: String?
    private var lastQuery: String?

    init(primarySessionId: String?) {
        self.primarySessionId = primarySessionId
    }

    var totalHits: Int { groups.reduce(0) { $0 + $1.hits.count } }

    /// Text changed. Always bumps `seq`, invalidating anything in flight. Below
    /// the minimum length → idle, results cleared, no ticket. Otherwise
    /// loading (the previous groups stay on screen) and the ticket to run.
    mutating func queryChanged(_ raw: String) -> SearchTicket? {
        seq += 1
        let query = SearchCopy.normalized(raw)
        guard SearchCopy.isActive(query) else {
            lastQuery = nil
            phase = .idle
            groups = []
            truncated = false
            return nil
        }
        lastQuery = query
        phase = .loading
        return SearchTicket(seq: seq, query: query)
    }

    /// "Try again": re-run the last active query under a fresh generation.
    mutating func retry() -> SearchTicket? {
        guard let query = lastQuery else { return nil }
        seq += 1
        phase = .loading
        return SearchTicket(seq: seq, query: query)
    }

    /// Apply the box's answer; ignored unless it is for the current ticket.
    mutating func receive(_ response: SearchResponse, for ticket: SearchTicket) {
        guard ticket.seq == seq else { return }
        guard response.supported else {
            settle(.unsupported, [], false)
            return
        }
        guard let groups = response.groups else {
            settle(.boxTooOld, [], false)
            return
        }
        if response.degraded == true {
            settle(.failed(SearchCopy.degradedReason), [], false)
            return
        }
        if groups.isEmpty {
            settle(.empty, [], false)
            return
        }
        settle(.results, groups, response.truncated == true)
    }

    /// Apply a failure; ignored unless it is for the current ticket. A
    /// cancellation is an expected exit and never a failure.
    mutating func fail(_ error: Error, for ticket: SearchTicket) {
        guard ticket.seq == seq else { return }
        if Self.isCancellation(error) { return }
        settle(.failed(SearchCopy.failureReason(error)), [], false)
    }

    /// The sheet went away: drop any late completion.
    mutating func invalidate() {
        seq += 1
    }

    func request(for ticket: SearchTicket) -> SearchRequest {
        SearchRequest(query: ticket.query, scope: "all", primarySessionId: primarySessionId)
    }

    private mutating func settle(_ phase: Phase, _ groups: [TranscriptHitGroup], _ truncated: Bool) {
        self.phase = phase
        self.groups = groups
        self.truncated = truncated
    }

    /// `CancellationError`, or the URL loading system's "cancelled" (matched by
    /// domain/code: `URLError` lives in FoundationNetworking on Linux).
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let ns = error as NSError
        return ns.domain == "NSURLErrorDomain" && ns.code == -999
    }
}
