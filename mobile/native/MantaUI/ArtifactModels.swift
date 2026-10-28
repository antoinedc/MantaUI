import Foundation

// ===========================================================================
// WS07 — wire types of the box's `artifacts:list` channel (src/server/
// artifacts.mjs). The box derives everything — links, files, images, hosted
// pages, outbox files, plans, expiry state, counts; this file only DECODES it.
// Pure (Foundation only) so it runs under `verify.sh`.
//
// Additive-wire tolerance: an unknown `kind` / `state` decodes to `.unknown`
// (never a failed decode), and `ArtifactsListResult.renderable` skips those
// rows. Missing optional fields decode to nil / defaults.
// ===========================================================================

enum ArtifactKind: String, Decodable, Hashable, Sendable {
    case link, image, file, plan
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ArtifactKind(rawValue: raw) ?? .unknown
    }

    /// The four kinds the card has a segment for, in segment order.
    static let segments: [ArtifactKind] = [.file, .image, .link, .plan]
}

enum ArtifactOrigin: String, Decodable, Hashable, Sendable {
    case user, agent
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ArtifactOrigin(rawValue: raw) ?? .unknown
    }
}

enum ArtifactExpiryState: String, Decodable, Hashable, Sendable {
    case live, soon, expired, never
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ArtifactExpiryState(rawValue: raw) ?? .unknown
    }
}

enum ArtifactPlanStatus: String, Decodable, Hashable, Sendable {
    case draft, approved, building, done
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ArtifactPlanStatus(rawValue: raw) ?? .unknown
    }
}

/// `expiresAt` is epoch milliseconds, nil for `.never`.
struct ArtifactExpiry: Decodable, Equatable, Hashable, Sendable {
    var state: ArtifactExpiryState
    var expiresAt: Double?

    init(state: ArtifactExpiryState, expiresAt: Double?) {
        self.state = state
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey { case state, expiresAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(ArtifactExpiryState.self, forKey: .state)
        expiresAt = try c.decodeIfPresent(Double.self, forKey: .expiresAt)
    }
}

struct ArtifactPlanInfo: Decodable, Equatable, Hashable, Sendable {
    var status: ArtifactPlanStatus
    var steps: Int
    var pageUrl: String?
    /// `"other-session"` | `"no-public-address"` | nil — non-nil iff `pageUrl` is nil.
    /// An unknown reason is kept as the raw string and treated as generic.
    var pageUrlReason: String?
    var fileAvailable: Bool

    init(status: ArtifactPlanStatus, steps: Int, pageUrl: String?, pageUrlReason: String?, fileAvailable: Bool) {
        self.status = status
        self.steps = steps
        self.pageUrl = pageUrl
        self.pageUrlReason = pageUrlReason
        self.fileAvailable = fileAvailable
    }

    private enum CodingKeys: String, CodingKey { case status, steps, pageUrl, pageUrlReason, fileAvailable }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(ArtifactPlanStatus.self, forKey: .status) ?? .draft
        steps = Int(try c.decodeIfPresent(Double.self, forKey: .steps) ?? 0)
        pageUrl = try c.decodeIfPresent(String.self, forKey: .pageUrl)
        pageUrlReason = try c.decodeIfPresent(String.self, forKey: .pageUrlReason)
        fileAvailable = try c.decodeIfPresent(Bool.self, forKey: .fileAvailable) ?? false
    }
}

/// One row of the box's artifact list. `at` is epoch milliseconds.
struct ArtifactItem: Decodable, Identifiable, Equatable, Hashable, Sendable {
    var id: String
    var kind: ArtifactKind
    var origin: ArtifactOrigin
    var label: String
    /// Absolute box path, `data:` URI, or URL.
    var href: String
    var mime: String?
    var size: Int?
    var at: Double
    var messageId: String?
    var context: String?
    var isHosted: Bool
    var expiry: ArtifactExpiry?
    var plan: ArtifactPlanInfo?

    init(id: String, kind: ArtifactKind, origin: ArtifactOrigin = .agent, label: String, href: String,
         mime: String? = nil, size: Int? = nil, at: Double = 0, messageId: String? = nil,
         context: String? = nil, isHosted: Bool = false, expiry: ArtifactExpiry? = nil,
         plan: ArtifactPlanInfo? = nil) {
        self.id = id
        self.kind = kind
        self.origin = origin
        self.label = label
        self.href = href
        self.mime = mime
        self.size = size
        self.at = at
        self.messageId = messageId
        self.context = context
        self.isHosted = isHosted
        self.expiry = expiry
        self.plan = plan
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, origin, label, href, mime, size, at, messageId, context, isHosted, expiry, plan
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(ArtifactKind.self, forKey: .kind)
        origin = try c.decodeIfPresent(ArtifactOrigin.self, forKey: .origin) ?? .agent
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        href = try c.decodeIfPresent(String.self, forKey: .href) ?? ""
        mime = try c.decodeIfPresent(String.self, forKey: .mime)
        size = try c.decodeIfPresent(Double.self, forKey: .size).map { Int($0) }
        at = try c.decodeIfPresent(Double.self, forKey: .at) ?? 0
        messageId = try c.decodeIfPresent(String.self, forKey: .messageId)
        context = try c.decodeIfPresent(String.self, forKey: .context)
        isHosted = try c.decodeIfPresent(Bool.self, forKey: .isHosted) ?? false
        expiry = try c.decodeIfPresent(ArtifactExpiry.self, forKey: .expiry)
        plan = try c.decodeIfPresent(ArtifactPlanInfo.self, forKey: .plan)
    }

    /// The row's timestamp as a `Date`.
    var date: Date { Date(timeIntervalSince1970: at / 1000.0) }
}

/// Per-kind totals as the box counted them.
struct ArtifactCountsWire: Decodable, Equatable, Hashable, Sendable {
    var link: Int
    var image: Int
    var file: Int
    var plan: Int

    init(link: Int = 0, image: Int = 0, file: Int = 0, plan: Int = 0) {
        self.link = link
        self.image = image
        self.file = file
        self.plan = plan
    }

    private enum CodingKeys: String, CodingKey { case link, image, file, plan }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        link = try c.decodeIfPresent(Int.self, forKey: .link) ?? 0
        image = try c.decodeIfPresent(Int.self, forKey: .image) ?? 0
        file = try c.decodeIfPresent(Int.self, forKey: .file) ?? 0
        plan = try c.decodeIfPresent(Int.self, forKey: .plan) ?? 0
    }

    func count(for kind: ArtifactKind) -> Int {
        switch kind {
        case .link: return link
        case .image: return image
        case .file: return file
        case .plan: return plan
        case .unknown: return 0
        }
    }
}

struct ArtifactsListResult: Decodable, Equatable, Sendable {
    var sessionId: String
    var generatedAt: Double
    var items: [ArtifactItem]
    var counts: ArtifactCountsWire
    /// Subset of `"pages" | "outbox" | "directory" | "public-address"`.
    var degraded: [String]

    init(sessionId: String, generatedAt: Double = 0, items: [ArtifactItem], counts: ArtifactCountsWire,
         degraded: [String] = []) {
        self.sessionId = sessionId
        self.generatedAt = generatedAt
        self.items = items
        self.counts = counts
        self.degraded = degraded
    }

    private enum CodingKeys: String, CodingKey { case sessionId, generatedAt, items, counts, degraded }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        generatedAt = try c.decodeIfPresent(Double.self, forKey: .generatedAt) ?? 0
        items = try c.decodeIfPresent([ArtifactItem].self, forKey: .items) ?? []
        counts = try c.decodeIfPresent(ArtifactCountsWire.self, forKey: .counts) ?? ArtifactCountsWire()
        degraded = try c.decodeIfPresent([String].self, forKey: .degraded) ?? []
    }

    /// Rows this client knows how to draw: a future `kind` or expiry `state`
    /// is skipped rather than guessed at.
    var renderable: [ArtifactItem] {
        items.filter { item in
            item.kind != .unknown && item.expiry?.state != .unknown
        }
    }
}

/// Detects a box that predates `artifacts:list`: it answers an unknown channel
/// with `{error: "unknown rpc channel: artifacts:list"}`, which `MantaAPIClient`
/// surfaces as `MantaError.server`. No fallback derivation exists.
enum ArtifactsCapability {
    static func isUnsupported(_ error: Error) -> Bool {
        guard case MantaError.server(let message) = error else { return false }
        return message.hasPrefix("unknown rpc channel: artifacts:list")
    }
}

/// Footnote copy for `degraded` entries.
enum ArtifactDegradedCopy {
    static let publicAddress = "Published pages are hidden — this box has no public address."
    static let generic = "Some items couldn't be loaded."

    static func footer(_ degraded: [String]) -> String? {
        var parts: [String] = []
        if degraded.contains("public-address") { parts.append(publicAddress) }
        if degraded.contains(where: { $0 != "public-address" }) { parts.append(generic) }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}
