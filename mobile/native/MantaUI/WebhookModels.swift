import Foundation

// ===========================================================================
// WS07 F7 / F7b — webhooks card + secret scope, pure half (Foundation only).
// ===========================================================================

/// One inbound webhook of a session, as `webhook:list` returns it (metadata only —
/// the signing secret and token never leave the box). `provider` / `instructions`
/// are optional for older boxes. Timestamps are epoch milliseconds.
struct WebhookMeta: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var provider: String?
    var label: String
    var url: String?
    var unsigned: Bool
    var sessionID: String?
    var instructions: String?
    var createdAt: Double?
    var lastDeliveredAt: Double?
    var deliveries: Int

    init(id: String, provider: String? = nil, label: String = "", url: String? = nil, unsigned: Bool = false,
         sessionID: String? = nil, instructions: String? = nil, createdAt: Double? = nil,
         lastDeliveredAt: Double? = nil, deliveries: Int = 0) {
        self.id = id
        self.provider = provider
        self.label = label
        self.url = url
        self.unsigned = unsigned
        self.sessionID = sessionID
        self.instructions = instructions
        self.createdAt = createdAt
        self.lastDeliveredAt = lastDeliveredAt
        self.deliveries = deliveries
    }

    private enum CodingKeys: String, CodingKey {
        case id, provider, label, url, unsigned, sessionID, instructions, createdAt, lastDeliveredAt, deliveries
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        url = try c.decodeIfPresent(String.self, forKey: .url)
        unsigned = try c.decodeIfPresent(Bool.self, forKey: .unsigned) ?? false
        sessionID = try c.decodeIfPresent(String.self, forKey: .sessionID)
        instructions = try c.decodeIfPresent(String.self, forKey: .instructions)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt)
        lastDeliveredAt = try c.decodeIfPresent(Double.self, forKey: .lastDeliveredAt)
        deliveries = Int(try c.decodeIfPresent(Double.self, forKey: .deliveries) ?? 0)
    }
}

enum WebhookFormat {
    static let untitled = "Untitled webhook"

    /// "never fired", or "<abbreviated date, short time> · 3×".
    static func lastDelivery(_ hook: WebhookMeta, calendar: Calendar = .current) -> String {
        if hook.deliveries == 0 && hook.lastDeliveredAt == nil { return "never fired" }
        guard let ms = hook.lastDeliveredAt else { return "\(hook.deliveries)×" }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = calendar.locale ?? .current
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        let date = formatter.string(from: Date(timeIntervalSince1970: ms / 1000.0))
        return "\(date) · \(hook.deliveries)×"
    }

    /// The delivery URL without its scheme; nil passes through.
    static func displayURL(_ url: String?) -> String? {
        guard var url else { return nil }
        for scheme in ["https://", "http://"] where url.lowercased().hasPrefix(scheme) {
            url = String(url.dropFirst(scheme.count))
            break
        }
        return url
    }

    /// The row title: the label, or "Untitled webhook".
    static func title(_ hook: WebhookMeta) -> String {
        let label = hook.label.trimmingCharacters(in: .whitespacesAndNewlines)
        return label.isEmpty ? untitled : label
    }
}

// MARK: - Secrets scope

/// The scope picker of the add-secret form: shared (every session), this project,
/// this session. Desktop parity — the default is `.shared`.
enum SecretScopeOption: String, CaseIterable, Identifiable, Equatable, Sendable {
    case shared, project, session

    var id: String { rawValue }

    var title: String {
        switch self {
        case .shared: return "Shared — every session"
        case .project: return "This project"
        case .session: return "This session"
        }
    }

    var wireScope: String { rawValue }

    /// The `secrets:set` payload. `sessionID` is sent for session AND project scope
    /// (the box resolves the project name from it) and omitted for shared.
    static func input(key: String, value: String, scope: SecretScopeOption, sessionId: String,
                      hint: String?) -> SecretInput {
        let trimmed = hint?.trimmingCharacters(in: .whitespacesAndNewlines)
        return SecretInput(
            key: key,
            value: value,
            scope: scope.wireScope,
            sessionID: scope == .shared ? nil : sessionId,
            project: nil,
            hint: (trimmed?.isEmpty ?? true) ? nil : hint
        )
    }

    /// Row badge: `shared` / `project:<name or ?>` / `session`.
    static func badge(_ meta: SecretMeta) -> String {
        switch meta.scope {
        case "shared": return "shared"
        case "project": return "project:\(meta.project ?? "?")"
        default: return "session"
        }
    }
}
