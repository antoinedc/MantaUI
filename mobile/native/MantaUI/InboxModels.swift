import Foundation

// ===========================================================================
// Pending messages — the pure layer (OpenCode V2 next spec, Stage A-iOS).
//
// While a turn runs, a message the user sends is delivered straight into V2's
// inbox — "Now" (`steer`: the agent reads it at its next step) or "After this
// turn" (`queue`). The box interprets the inbox and publishes the FULL pending
// list on the `inbox` stream frame and through `opencode:inbox`; this file
// decodes those payloads, applies the client acceptance rule (cleanup spec §1
// K3 — port of `src/renderer/inboxState.ts`), classifies the outcome of a
// send-while-running, and derives what the pending card shows.
//
// Everything here is Foundation-only and value-in / value-out so it is
// unit-testable (and compiles on Linux — see Package.swift). Every decoder
// tolerates unknown values: a new delivery string, a new outcome, a new field
// must never crash the app or drop a whole payload.
// ===========================================================================

// MARK: - Delivery

/// How a pending message reaches the agent. `steer` is "Now", `queue` is
/// "After this turn"; any other wire value is preserved verbatim and rendered
/// neutrally, never dropped.
enum InboxDelivery: Equatable, Hashable, Sendable {
    case steer
    case queue
    case other(String)

    init(wire: String) {
        switch wire {
        case "steer": self = .steer
        case "queue": self = .queue
        default: self = .other(wire)
        }
    }

    var wire: String {
        switch self {
        case .steer: return "steer"
        case .queue: return "queue"
        case .other(let raw): return raw
        }
    }
}

// MARK: - Items + snapshot (K2 / K3)

/// One pending user message (K2). `id` is also the id of the user message it
/// becomes.
struct InboxItem: Equatable, Hashable, Sendable, Identifiable {
    var id: String
    var text: String
    var delivery: InboxDelivery
    var createdAt: Double
    var attachmentCount: Int

    /// Lenient decode from one `items[]` element: only a non-empty string `id`
    /// is required, everything else falls back, so one odd item never costs
    /// the list.
    static func parse(_ value: JSONValue?) -> InboxItem? {
        guard let object = ChatJSON.object(value),
              let id = ChatJSON.string(object["id"]), !id.isEmpty else { return nil }
        // `Int(exactly:)`, never `Int(_:)`: a huge or fractional number from an
        // unexpected payload must degrade to a default, not trap.
        let count = ChatJSON.number(object["attachmentCount"]).flatMap { Int(exactly: $0) } ?? 0
        return InboxItem(
            id: id,
            text: ChatJSON.string(object["text"]) ?? "",
            delivery: InboxDelivery(wire: ChatJSON.string(object["delivery"]) ?? ""),
            createdAt: ChatJSON.number(object["createdAt"]) ?? 0,
            attachmentCount: max(0, count)
        )
    }
}

/// The complete pending list for one session, stamped `(epoch, rev)` (K3).
struct InboxSnapshot: Equatable, Sendable {
    var epoch: String
    var rev: Int
    var items: [InboxItem]

    /// Narrow a frame payload / RPC result to a snapshot, or nil when it lacks
    /// the stamp or the list. A malformed item is skipped; the rest are kept.
    static func parse(_ value: JSONValue?) -> InboxSnapshot? {
        guard let object = ChatJSON.object(value),
              let epoch = ChatJSON.string(object["epoch"]), !epoch.isEmpty,
              let revNumber = ChatJSON.number(object["rev"]), let rev = Int(exactly: revNumber),
              let rawItems = ChatJSON.array(object["items"]) else { return nil }
        return InboxSnapshot(
            epoch: epoch,
            rev: rev,
            items: rawItems.compactMap { InboxItem.parse($0) }
        )
    }
}

extension InboxSnapshot: Decodable {
    init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard let parsed = InboxSnapshot.parse(value) else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "not an inbox snapshot"
            ))
        }
        self = parsed
    }
}

/// A pushed `inbox` stream frame, handed to whichever open session owns it.
struct InboxFrameEvent: Equatable, Sendable {
    var sessionId: String
    var payload: JSONValue?
}

// MARK: - K3 acceptance rule

/// The client-wide set of epochs known to belong to a dead manta-server
/// process. Shared by every open session: a restarted server is newer by
/// definition, and once ANY session has seen the new epoch nothing from the old
/// one may land anywhere. A main-actor singleton (`static let`, the sanctioned
/// shape — mobile/native/AGENTS.md §5); tests pass their own set instead.
@MainActor
final class InboxRetiredEpochs {
    static let shared = InboxRetiredEpochs()
    var epochs: Set<String> = []
}

enum InboxAcceptance {
    /// K3: should `incoming` replace `shown`?
    ///  - a retired epoch → never;
    ///  - the same epoch → only a higher `rev`;
    ///  - a new, non-retired epoch → yes, and the previous epoch is retired.
    /// Returns the state to show (`shown` itself when the payload is dropped).
    static func accept(
        shown: InboxSnapshot?,
        incoming: InboxSnapshot?,
        retired: inout Set<String>
    ) -> (next: InboxSnapshot?, accepted: Bool) {
        guard let incoming else { return (shown, false) }
        if retired.contains(incoming.epoch) { return (shown, false) }
        guard let shown else { return (incoming, true) }
        if incoming.epoch == shown.epoch {
            return incoming.rev > shown.rev ? (incoming, true) : (shown, false)
        }
        retired.insert(shown.epoch)
        return (incoming, true)
    }
}

/// One tracker per open session. Holds what the card shows and the request
/// generation that lets a late `opencode:inbox` answer be discarded when the
/// events socket has reconnected since it was asked (it may be a dead server's
/// word).
struct InboxTracker: Sendable {
    private(set) var shown: InboxSnapshot?
    private var generation = 0
    private var disposed = false

    /// A pushed `inbox` frame. True when it replaced the shown list.
    mutating func offerFrame(_ payload: JSONValue?, retired: inout Set<String>) -> Bool {
        offer(InboxSnapshot.parse(payload), retired: &retired)
    }

    /// Stamp a request at the moment it is issued.
    func beginRequest() -> Int { generation }

    /// The request's answer. Dropped when a resync happened after it was issued,
    /// or the tracker was disposed.
    mutating func offerResponse(stamp: Int, snapshot: InboxSnapshot?, retired: inout Set<String>) -> Bool {
        guard stamp == generation else { return false }
        return offer(snapshot, retired: &retired)
    }

    /// The events socket reconnected: every answer still in flight is stale.
    mutating func markResync() { generation += 1 }

    /// The session stopped being shown: nothing may land any more.
    mutating func dispose() { disposed = true }

    private mutating func offer(_ incoming: InboxSnapshot?, retired: inout Set<String>) -> Bool {
        if disposed { return false }
        let result = InboxAcceptance.accept(shown: shown, incoming: incoming, retired: &retired)
        guard result.accepted else { return false }
        shown = result.next
        return true
    }
}

// MARK: - Action outcomes (K4 / N1)

enum InboxCancelOutcome: Equatable, Sendable {
    case cancelled
    case delivered
    case unknown
}

/// `opencode:inbox-cancel` reply. An unrecognised outcome decodes as `.unknown`
/// (the honest "couldn't confirm"), never throws.
struct InboxCancelResult: Equatable, Sendable, Decodable {
    var outcome: InboxCancelOutcome
    var item: InboxItem?

    init(outcome: InboxCancelOutcome, item: InboxItem? = nil) {
        self.outcome = outcome
        self.item = item
    }

    init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        let object = ChatJSON.object(value) ?? [:]
        switch ChatJSON.string(object["outcome"]) {
        case "cancelled": outcome = .cancelled
        case "delivered": outcome = .delivered
        default: outcome = .unknown
        }
        item = InboxItem.parse(object["item"])
    }
}

enum InboxSetDeliveryOutcome: Equatable, Sendable {
    case changed
    case delivered
    case unknown
}

/// `opencode:inbox-set-delivery` reply. Unrecognised outcome → `.unknown`.
struct InboxSetDeliveryResult: Equatable, Sendable, Decodable {
    var outcome: InboxSetDeliveryOutcome

    init(outcome: InboxSetDeliveryOutcome) {
        self.outcome = outcome
    }

    init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        switch ChatJSON.string(ChatJSON.object(value)?["outcome"]) {
        case "changed": outcome = .changed
        case "delivered": outcome = .delivered
        default: outcome = .unknown
        }
    }
}

/// What the user is told after an inbox action. `nil` = nothing to say (the
/// next `inbox` frame is the confirmation). Every other outcome is a visible
/// message — never a silent no-op.
enum InboxActionReport {
    static let alreadySent = "Already sent to the agent"

    /// × on a row. A cancelled message needs no words: the row leaves.
    static func cancel(_ result: InboxCancelResult) -> String? {
        switch result.outcome {
        case .cancelled: return nil
        case .delivered: return alreadySent
        case .unknown: return "Couldn't confirm it was cancelled — it may still be sent"
        }
    }

    /// Send now / Wait. `changed` is confirmed by the next frame.
    static func setDelivery(_ result: InboxSetDeliveryResult) -> String? {
        switch result.outcome {
        case .changed: return nil
        case .delivered: return alreadySent
        case .unknown: return "Couldn't confirm the change — check the pending list"
        }
    }

    /// The request itself failed (no verdict from the box at all).
    static let cancelFailed = "Couldn't cancel — check the connection"
    static let setDeliveryFailed = "Couldn't change it — check the connection"
}

// MARK: - Busy-send outcome

/// What happened to a send made while a turn runs.
enum BusySendOutcome: Equatable, Sendable {
    /// The box answered 2xx: the message is in V2's inbox.
    case delivered
    /// A definite refusal (HTTP 4xx): the message was NOT admitted.
    case refused(reason: String)
    /// No verdict (timeout / network / 5xx): the message may have been
    /// admitted. Retrying with the same id is safe.
    case uncertain
}

enum BusySendClassifier {
    /// Classify the error a busy-send POST threw. Conservative by design:
    /// only a refusal the box ITSELF reports as a 4xx (or a 401) proves the
    /// message was not admitted; everything else — including errors we do not
    /// recognise — is `uncertain`, because a spurious "refused" would make the
    /// user re-send text that may already be queued.
    ///
    /// The box wraps opencode's HTTP failure as `opencode sendPrompt <status>:
    /// <body>` inside its own RPC error envelope.
    static func classify(_ error: Error) -> BusySendOutcome {
        guard let manta = error as? MantaError else { return .uncertain }
        switch manta {
        case .authRequired:
            return .refused(reason: "you're signed out — sign in again")
        case .server(let message):
            guard let status = opencodeStatus(in: message) else { return .uncertain }
            guard (400..<500).contains(status) else { return .uncertain }
            return .refused(reason: reason(from: message, status: status))
        case .transport, .storedButUntranscribed:
            return .uncertain
        }
    }

    /// The `<status>` of an `opencode sendPrompt <status>:` message, or nil.
    static func opencodeStatus(in message: String) -> Int? {
        let prefix = "opencode sendPrompt "
        guard message.hasPrefix(prefix) else { return nil }
        let digits = message.dropFirst(prefix.count).prefix(while: { $0.isNumber })
        guard digits.count == 3 else { return nil }
        return Int(digits)
    }

    private static func reason(from message: String, status: Int) -> String {
        let prefix = "opencode sendPrompt \(status):"
        let body = message.dropFirst(prefix.count)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: " ")
        guard !body.isEmpty else { return "the box refused it (\(status))" }
        let clipped = body.count > 120 ? String(body.prefix(120)) + "…" : String(body)
        return "the box refused it (\(status)): \(clipped)"
    }
}

// MARK: - The pending card (what it shows)

/// One row of the pending card, derived from an item and the running state.
struct PendingRowModel: Equatable, Sendable, Identifiable {
    enum Badge: Equatable, Sendable {
        case now
        case afterThisTurn
        case other(String)
    }

    var id: String
    /// Single line: newlines collapsed so the row is one ellipsised line.
    var text: String
    var badge: Badge
    /// The quiet caption on a "Now" row: "at next step", or "runs next" once
    /// the agent has stopped. nil on every other row.
    var caption: String?
    /// "Now" rows offer Wait (→ After this turn).
    var offersWait: Bool
    /// "After this turn" rows offer Send now (→ Now).
    var offersSendNow: Bool
    var attachmentCount: Int
}

enum PendingCardLogic {
    static func rows(items: [InboxItem], running: Bool) -> [PendingRowModel] {
        items.map { item in
            let badge: PendingRowModel.Badge
            switch item.delivery {
            case .steer: badge = .now
            case .queue: badge = .afterThisTurn
            case .other(let raw): badge = .other(raw)
            }
            return PendingRowModel(
                id: item.id,
                text: singleLine(item.text),
                badge: badge,
                caption: item.delivery == .steer ? (running ? "at next step" : "runs next") : nil,
                offersWait: item.delivery == .steer,
                offersSendNow: item.delivery == .queue,
                attachmentCount: item.attachmentCount
            )
        }
    }

    static func header(count: Int) -> String {
        "Pending · \(count) message\(count == 1 ? "" : "s")"
    }

    /// The stopped-agent footer: the agent is not running and "After this turn"
    /// messages remain — they will not start by themselves.
    static let stoppedFooter = "Agent stopped — these are waiting. Send now, or ×."

    static func showsStoppedFooter(items: [InboxItem], running: Bool) -> Bool {
        !running && items.contains { $0.delivery == .queue }
    }

    static func singleLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
