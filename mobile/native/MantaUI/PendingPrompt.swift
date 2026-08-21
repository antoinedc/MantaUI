import Foundation

/// A prompt the user has committed but the box has not yet acknowledged.
/// Durable: it outlives the session screen, backgrounding and app termination.
struct PendingPrompt: Equatable, Codable, Identifiable {
    enum State: String, Codable {
        /// Accepted, not yet POSTed — a turn is running, or the app relaunched.
        case waiting
        /// The POST is in flight right now.
        case sending
        /// The POST failed, or the process died while it was in flight.
        /// Terminal until the user taps retry. NEVER retried automatically.
        case failed
    }

    let id: String
    let sessionId: String
    let text: String
    let attachments: [SendPromptInput.Attachment]
    let model: SendPromptInput.Model?
    let mentions: [SendPromptInput.Mention]?
    let agent: String?
    var state: State
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
    /// becomes `failed` — the user decides whether it is still wanted.
    /// Returns the migrated list AND writes it back.
    static func failStaleOnLaunch(_ defaults: UserDefaults = .standard) -> [PendingPrompt] {
        let migrated = load(defaults).map { prompt -> PendingPrompt in
            guard prompt.state == .waiting || prompt.state == .sending else { return prompt }
            var p = prompt
            p.state = .failed
            return p
        }
        save(migrated, to: defaults)
        return migrated
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
