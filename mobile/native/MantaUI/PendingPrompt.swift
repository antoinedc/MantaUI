import Foundation

/// A prompt the user has committed but the box has not yet acknowledged.
/// Durable: it outlives the session screen, backgrounding and app termination.
struct PendingPrompt: Equatable, Codable, Identifiable, Sendable {
    enum State: String, Codable {
        /// Accepted, not yet POSTed — a turn is running, or the app relaunched.
        case waiting
        /// The POST is in flight right now.
        case sending
        /// The POST failed, or the process died while it was in flight.
        /// Terminal until the user taps retry. NEVER retried automatically.
        case failed
        /// A send made while a turn runs whose POST ended without a verdict
        /// (timeout / network / 5xx, or the process died mid-flight): the box
        /// may have accepted it. Terminal until the user taps retry — which is
        /// safe, because the row's `messageID` is reused and V2 treats a
        /// repeated id as idempotent. The row disappears by itself the moment
        /// its id shows up in the box's pending list or the transcript.
        case uncertain
    }

    let id: String
    let sessionId: String
    let text: String
    let attachments: [SendPromptInput.Attachment]
    let model: SendPromptInput.Model?
    let mentions: [SendPromptInput.Mention]?
    let agent: String?
    var state: State
    /// The client-minted V2 message id of a send made while a turn runs
    /// (`PendingPrompt.mintMessageID()`). Persisted with the row and reused on
    /// every retry so a retry after an uncertain failure can never enqueue the
    /// message twice. nil for an ordinary idle send.
    var messageID: String? = nil
    /// `"steer"` or `"queue"` for a send made while a turn runs; nil for an
    /// idle send. A row with a `delivery` is a busy-send row.
    var delivery: String? = nil
    /// Why the box refused the send (a definite 4xx), shown on the failed row.
    var failureReason: String? = nil

    /// True for a row created by the send-while-running path.
    var isBusySend: Bool { delivery != nil }

    /// A fresh V2 message id (V2 requires the `msg_` prefix).
    static func mintMessageID() -> String {
        "msg_" + UUID().uuidString.lowercased()
    }
}

/// The durable outbox. Pure over an injected `UserDefaults` so it is unit
/// testable; mirrors the existing `ModelRecents.load(_:)` seam.
enum PendingPromptStore {
    static let defaultsKey = "manta.pendingPrompts"

    static func load(_ defaults: UserDefaults = .standard) -> [PendingPrompt] {
        guard let data = defaults.data(forKey: defaultsKey),
              let list = try? JSONDecoder().decode([PendingPrompt].self, from: data)
        else { return [] }
        return list
    }

    static func save(_ prompts: [PendingPrompt], to defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(prompts) {
            defaults.set(data, forKey: defaultsKey)
        }
    }

    /// Called ONCE per app launch, before any session screen reads the outbox.
    /// Every prompt that was `waiting` or `sending` when the process died
    /// becomes `failed` — the user decides whether it is still wanted. A
    /// busy-send row that was `sending` becomes `uncertain` instead: its POST
    /// may have landed before the process died, and its id lets the row vanish
    /// by itself if it did. Returns the migrated list AND writes it back.
    static func failStaleOnLaunch(_ defaults: UserDefaults = .standard) -> [PendingPrompt] {
        let migrated = load(defaults).map { prompt -> PendingPrompt in
            guard prompt.state == .waiting || prompt.state == .sending else { return prompt }
            var p = prompt
            p.state = (prompt.state == .sending && prompt.messageID != nil) ? .uncertain : .failed
            return p
        }
        save(migrated, to: defaults)
        return migrated
    }

    /// Persist ONE session's rows without disturbing any other session's: the
    /// outbox is a single box-wide list, so writing a session's rows alone would
    /// erase every other session's failed / uncertain rows (the tap-to-retry
    /// rows are the only record that a message may not have been sent).
    static func persist(_ sessionRows: [PendingPrompt], sessionId: String, to defaults: UserDefaults = .standard) {
        let others = load(defaults).filter { $0.sessionId != sessionId }
        save(others + sessionRows, to: defaults)
    }

    static func prompts(for sessionId: String, in all: [PendingPrompt]) -> [PendingPrompt] {
        all.filter { $0.sessionId == sessionId }
    }

    static func upsert(_ prompt: PendingPrompt, into all: [PendingPrompt]) -> [PendingPrompt] {
        if let index = all.firstIndex(where: { $0.id == prompt.id }) {
            var out = all
            out[index] = prompt
            return out
        }
        return all + [prompt]
    }

    static func remove(id: String, from all: [PendingPrompt]) -> [PendingPrompt] {
        all.filter { $0.id != id }
    }
}

extension PendingPromptStore {
    /// Drop the rows whose message the box has demonstrably received:
    /// `seenIDs` is the union of the ids in the pending list (inbox frame) and in
    /// the transcript. An `uncertain` row (it may have been sent) and a
    /// `sending` row (the frame can beat the POST's own response) are removed;
    /// a `failed` row is a definite refusal and a `waiting` row never left the
    /// device, so neither can be satisfied by an id showing up.
    static func settling(_ all: [PendingPrompt], seenIDs: Set<String>) -> [PendingPrompt] {
        guard !seenIDs.isEmpty else { return all }
        return all.filter { prompt in
            guard let id = prompt.messageID, seenIDs.contains(id) else { return true }
            return !(prompt.state == .uncertain || prompt.state == .sending)
        }
    }
}

/// The one-line notices under a pending row that did not (certainly) reach the
/// box.
enum PendingPromptNotice {
    static let uncertain = "May have been sent — tap to retry"

    static func failed(reason: String?) -> String {
        guard let reason, !reason.isEmpty else { return "Couldn't send — tap to retry" }
        return "Couldn't send: \(reason) — tap to retry"
    }
}
