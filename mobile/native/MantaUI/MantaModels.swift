import Foundation

enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "unexpected JSON value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

private struct DynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.intValue = intValue
        self.stringValue = String(intValue)
    }
}

struct OpencodeRole: RawRepresentable, Codable, Equatable, Sendable {
    var rawValue: String

    static let user = OpencodeRole(rawValue: "user")
    static let assistant = OpencodeRole(rawValue: "assistant")
}

struct OpencodeTime: Codable, Equatable, Sendable {
    var created: Double?
    var completed: Double?
}

struct OpencodeMessageInfo: Codable, Equatable, Sendable {
    var id: String
    var sessionID: String
    var role: OpencodeRole
    var time: OpencodeTime?
    var modelID: String?
    var providerID: String?
}

struct OpencodePart: Codable, Equatable, Sendable {
    var type: String
    var id: String
    var messageID: String
    var text: String?
    var synthetic: Bool?
    var ignored: Bool?
    var extra: [String: JSONValue]

    enum CodingKeys: String, CodingKey {
        case type, id, messageID, text, synthetic, ignored
    }

    init(type: String, id: String, messageID: String, text: String? = nil,
         synthetic: Bool? = nil, ignored: Bool? = nil, extra: [String: JSONValue] = [:]) {
        self.type = type
        self.id = id
        self.messageID = messageID
        self.text = text
        self.synthetic = synthetic
        self.ignored = ignored
        self.extra = extra
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        id = try container.decode(String.self, forKey: .id)
        messageID = try container.decode(String.self, forKey: .messageID)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        synthetic = try container.decodeIfPresent(Bool.self, forKey: .synthetic)
        ignored = try container.decodeIfPresent(Bool.self, forKey: .ignored)

        let dynamic = try decoder.container(keyedBy: DynamicCodingKey.self)
        var extras: [String: JSONValue] = [:]
        let known: Set<String> = ["type", "id", "messageID", "text", "synthetic", "ignored"]
        for key in dynamic.allKeys where !known.contains(key.stringValue) {
            extras[key.stringValue] = try dynamic.decode(JSONValue.self, forKey: key)
        }
        extra = extras
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(id, forKey: .id)
        try container.encode(messageID, forKey: .messageID)
        try container.encodeIfPresent(text, forKey: .text)
        try container.encodeIfPresent(synthetic, forKey: .synthetic)
        try container.encodeIfPresent(ignored, forKey: .ignored)
        var dynamic = encoder.container(keyedBy: DynamicCodingKey.self)
        for (key, value) in extra {
            if let codingKey = DynamicCodingKey(stringValue: key) {
                try dynamic.encode(value, forKey: codingKey)
            }
        }
    }
}

struct OpencodeMessage: Codable, Equatable, Sendable {
    var info: OpencodeMessageInfo
    var parts: [OpencodePart]
}

struct SessionTokens: Codable, Equatable, Sendable {
    var input: Double
    var output: Double
}

struct SessionModel: Codable, Equatable, Sendable {
    var id: String
    var providerID: String
    var variant: String?
}

struct SessionListItemTime: Codable, Equatable, Sendable {
    var created: Double?
    var updated: Double?
}

struct OpencodeSessionListItem: Codable, Equatable, Sendable {
    var id: String
    var slug: String?
    var projectID: String?
    var directory: String?
    var title: String?
    var parentID: String?
    var cost: Double?
    var tokens: SessionTokens?
    var model: SessionModel?
    var time: SessionListItemTime?
}

struct PermissionTool: Codable, Equatable, Sendable {
    var messageID: String
    var callID: String
}

struct PermissionRequest: Codable, Equatable, Sendable {
    var id: String
    var sessionID: String
    var permission: String
    var patterns: [String]?
    var always: [String]?
    var metadata: [String: JSONValue]?
    var tool: PermissionTool?
}

struct QuestionOption: Codable, Equatable, Sendable {
    var label: String
    var description: String
}

struct QuestionInfo: Codable, Equatable, Sendable {
    var question: String
    var header: String
    var options: [QuestionOption]
    var multiple: Bool?
    var custom: Bool?
}

struct QuestionRequest: Codable, Equatable, Sendable {
    var id: String
    var sessionID: String
    var questions: [QuestionInfo]
    var tool: PermissionTool?
    var requestId: String?
}

struct SendPromptInput: Sendable {
    struct Model: Sendable, Equatable {
        var providerID: String
        var modelID: String
        var variant: String?
    }

    struct Attachment: Sendable, Equatable {
        var remotePath: String
        var mime: String
        var filename: String?
    }

    struct MentionSource: Sendable, Equatable {
        var value: String
        var start: Int
        var end: Int
    }

    struct Mention: Sendable, Equatable {
        var name: String
        var source: MentionSource
    }

    var sessionId: String
    var text: String
    var model: Model?
    var attachments: [Attachment]?
    var mentions: [Mention]?
    /// Send the prompt as a named opencode agent (e.g. `"plan"` mode) on
    /// `opencode:prompt`, structurally identical to the `variant` field. Omitted
    /// → the body carries no `agent` key (BET-949/BET-952).
    var agent: String?

    init(sessionId: String, text: String, model: Model? = nil,
         attachments: [Attachment]? = nil, mentions: [Mention]? = nil,
         agent: String? = nil) {
        self.sessionId = sessionId
        self.text = text
        self.model = model
        self.attachments = attachments
        self.mentions = mentions
        self.agent = agent
    }
}

/// A named opencode agent (the `plan` primary agent, subagents, …), mirrored from
/// the box's `GET /agent` (desktop `OpencodeAgent`). Only the fields the plan
/// toggle reads are required.
struct OpencodeAgent: Codable, Equatable, Sendable {
    var name: String
    var description: String?
    var mode: String?
    var native: Bool?
    var builtIn: Bool?
}

enum PermissionReply: String, Sendable {
    case once
    case always
    case reject
}

// MARK: - S5 composer: model picker (BET-597)
//
// Models for the composer extras. `OpencodeModel` mirrors the box's
// `opencode:models` payload (from `getProviders()` → `listModels()`). These
// are wire DTOs only — resolution/selection logic lives in ChatModel (pure,
// tested).

/// A model from a connected provider, as served by `opencode:models`.
struct OpencodeModel: Codable, Equatable, Sendable {
    struct Variant: Codable, Equatable, Sendable {
        var id: String
    }

    var id: String
    var providerID: String
    var name: String
    var family: String?
    var status: String?
    var enabled: Bool?
    var variants: [Variant]?
    /// The model's provider-declared limits. `context` is the model's own
    /// context window (Opus 4.7 reports 1M, Sonnet 200k) — the denominator the
    /// context meter must use, never a hardcoded 200k.
    var limit: ModelLimit? = nil
    /// The model's declared capabilities from the box (the wire object also
    /// carries `temperature`, `attachment`, `toolcall`, `output`,
    /// `interleaved` — declared as our `ModelCapabilities` only reads what the
    /// catalogue row renders). `input.image` is whether the row shows a
    /// "vision" glyph. Absent for providers that don't annotate it.
    var capabilities: ModelCapabilities? = nil
}

/// The model's advertised capabilities from `opencode:models` (`capabilities`).
///
/// Declares ONLY the two facts the catalogue row renders. The wire object also
/// carries `temperature`, `attachment`, `toolcall`, `output` and `interleaved`,
/// and `interleaved` is a Bool on some models and an object on others — so
/// declaring a field this app does not use is a decode failure waiting to
/// happen. Unknown keys are ignored by the synthesized Decodable; a key that is
/// present with the wrong TYPE throws and takes the whole model list with it,
/// which is exactly how the catalogue silently came up empty.
struct ModelCapabilities: Codable, Equatable, Sendable {
    /// Input modalities, an OBJECT of flags on the wire (`{"text":true,
    /// "image":true,…}`) — never a list of strings.
    struct Modalities: Codable, Equatable, Sendable {
        var image: Bool?
    }
    var reasoning: Bool?
    var input: Modalities?
}

/// The model's advertised limits from `opencode:models` (`limit: { context }`).
struct ModelLimit: Codable, Equatable, Sendable {
    /// Context window in tokens. Absent early / for models the provider
    /// doesn't annotate — callers fall back, never assume a value.
    var context: Double?
}

/// `{ providerID, modelID }` — the minimal selection sent with a prompt and
/// returned by `opencode:default-model`.
struct OpencodeModelID: Codable, Equatable, Hashable, Sendable {
    var providerID: String
    var modelID: String

    enum CodingKeys: String, CodingKey {
        case providerID
        case modelID
    }
}
// MARK: - Overflow sheet resources (BET-627: attach, scheduled tasks, secrets)
//
// Server-owned resource payloads for the chat overflow sheet items. Mirrors
// src/shared/types.ts (ScheduledJob, SecretMeta) and the box `schedule:list` /
// `secrets:list` RPC channels. Secrets never carry a value to the device — the
// box strips it and returns metadata only.

/// A durable scheduled-prompt job (box store: ~/.manta/schedule.json).
struct ScheduledJob: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var cron: String
    var prompt: String
    var recurring: Bool
    var label: String
    var sessionID: String
    var directory: String
    var createdAt: Int
    var lastFiredMinute: String?
}

/// Metadata for a stored secret (box store: ~/.manta/secrets.json). Values are
/// never transmitted to the device; `hasValue` is the only value-adjacent fact.
struct SecretMeta: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var key: String?
    var scope: String?
    var sessionID: String?
    var project: String?
    var hint: String?
    var hasValue: Bool
    var createdAt: Int?
    var updatedAt: Int?
}

/// Client→box input for `secrets:set` (mirrors src/shared/types.ts SecretInput
/// and the `{key,value,scope,sessionID,project,hint}` wire shape in
/// src/server/rpc.mjs). The value travels device → box and is never returned or
/// rendered again. Nil optionals are omitted by the synthesized Encodable, so a
/// shared-scope set sends only `{key,value,scope}`.
struct SecretInput: Encodable, Sendable {
    var key: String
    var value: String
    var scope: String?
    var sessionID: String?
    var project: String?
    var hint: String?
}

/// `secrets:set` reply (src/server/secrets.mjs `secretsSetStore`). `meta` is the
/// value-stripped metadata on success; `error` is present when `ok` is false.
struct SecretSetResult: Decodable, Equatable, Sendable {
    var ok: Bool
    var meta: SecretMeta?
    var error: String?
}

// MARK: - Artifacts / agent-file outbox (BET-750)

/// A row from the box's artifact mailbox (`~/.manta-outbox/`), as served by
/// the `outbox:list` RPC and `src/server/outbox.mjs` `statRow`. Non-destructive:
/// files expire via the box's TTL sweep, never on download. `size` is bytes,
/// `mtime`/`expiresAt` are epoch milliseconds (nullable — a loose root file or
/// a file stat that failed can carry nulls). `path` is the absolute box path
/// and doubles as the stable identity for `GET /api/download?path=<path>`
/// (BET-750).
struct OutboxFile: Codable, Equatable, Sendable, Identifiable {
    var path: String
    var name: String
    var size: Int
    var sessionID: String?
    var mtime: Double?
    var expiresAt: Double?

    var id: String { path }
}

/// A published page from the box's serve-page registry (`serve-page:list`),
/// mirroring `ServedPageMeta` in `src/shared/types.ts`. `createdAt`/`expiresAt`
/// are epoch milliseconds; `sessionID` is the opencode session that called
/// `serve_page`. `url` is "" when the box has no addressable base URL
/// (`publicBaseUrl()` returned falsy) — the artifacts card filters such rows
/// out by their empty `href` rather than ever presenting a dead link.
struct ServedPageMeta: Codable, Equatable, Sendable {
    var subdomain: String
    var url: String
    var expiresAt: Double?
    var createdAt: Double
    var sessionID: String?
}

// MARK: - Plan usage (BET-824)

// Mirrors src/server/usage.mjs (the `usage:list` RPC): per-provider snapshots
// of subscription-plan windows. `UsageWindow.kind` is open ("session" =
// rolling 5-hour, "weekly" = 7-day), `pct` is 0-100 and always present,
// `resetsAt` is epoch MILLISECONDS. These are wire DTOs only; the band /
// window-selection / reset-format decision logic lives in `UsageMeters`
// (pure, tested).

/// One plan window (e.g. the rolling 5-hour or the 7-day) for a provider.
struct UsageWindow: Codable, Equatable, Sendable {
    var kind: String
    var label: String? = nil
    var pct: Double
    var used: Double? = nil
    var limit: Double? = nil
    /// Epoch milliseconds of the reset.
    var resetsAt: Double? = nil
    var binding: Bool? = nil
}

/// One provider's full `usage:list` snapshot.
struct UsageSnapshot: Codable, Equatable, Sendable {
    var provider: String? = nil
    var providerIDs: [String]? = nil
    var planLabel: String? = nil
    var windows: [UsageWindow]
    /// Epoch ms of the successful fetch — the "Updated X ago" stamp.
    var fetchedAt: Double? = nil
}
