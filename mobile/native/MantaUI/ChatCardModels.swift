import Foundation

// ===========================================================================
// WS02 — chat cards, queue and the chat-screen hotspot: wire + state types.
//
// FOUNDATION ONLY, so the Linux package (`verify.sh`) compiles and tests them.
// Server-first (D23/D24): the box writes the copy of every card — these types
// DECODE what it sent (retry headline, job bar lines, approval refusals); none
// of them computes a sentence. The pure rules over them are in
// `ChatCardLogic.swift`.
// ===========================================================================

// MARK: - Background-job approval (delegate:pending-approvals / approve / decline)

/// One rule the model asked for: `permission` (a category such as `bash`) and a
/// glob `pattern`. `action` is carried through untouched.
struct ChatCardApprovalTool: Codable, Equatable, Hashable, Sendable {
    var permission: String
    var pattern: String
    var action: String? = nil
}

/// A pre-flight approval the box is holding for a `delegate` call (trust mode
/// off). Decoded leniently: only a non-empty `id` is required, so one odd field
/// never hides the card the user has to answer.
struct ChatCardApproval: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var parentSessionID: String?
    var name: String
    var prompt: String
    var tools: [ChatCardApprovalTool]
    var createdAt: Double?

    init(id: String, parentSessionID: String? = nil, name: String = "", prompt: String = "",
         tools: [ChatCardApprovalTool] = [], createdAt: Double? = nil) {
        self.id = id
        self.parentSessionID = parentSessionID
        self.name = name
        self.prompt = prompt
        self.tools = tools
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, parentSessionID, name, prompt, tools, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        guard !id.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "empty approval id")
        }
        self.id = id
        parentSessionID = (try? c.decodeIfPresent(String.self, forKey: .parentSessionID)) ?? nil
        name = ((try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil) ?? ""
        prompt = ((try? c.decodeIfPresent(String.self, forKey: .prompt)) ?? nil) ?? ""
        tools = ((try? c.decodeIfPresent([ChatCardApprovalTool].self, forKey: .tools)) ?? nil) ?? []
        createdAt = (try? c.decodeIfPresent(Double.self, forKey: .createdAt)) ?? nil
    }
}

/// The list reply: a bare array, or `{approvals: []}` (what the desktop also
/// tolerates). A malformed element is skipped rather than failing the list.
struct ChatCardApprovalList: Decodable, Equatable, Sendable {
    var approvals: [ChatCardApproval]

    private struct Lenient: Decodable {
        let value: ChatCardApproval?
        init(from decoder: Decoder) throws {
            value = try? ChatCardApproval(from: decoder)
        }
    }

    private enum Keys: String, CodingKey { case approvals }

    init(approvals: [ChatCardApproval]) { self.approvals = approvals }

    init(from decoder: Decoder) throws {
        if let array = try? decoder.singleValueContainer().decode([Lenient].self) {
            approvals = array.compactMap(\.value)
            return
        }
        let keyed = try decoder.container(keyedBy: Keys.self)
        approvals = ((try? keyed.decodeIfPresent([Lenient].self, forKey: .approvals)) ?? nil)?.compactMap(\.value) ?? []
    }
}

/// `delegate:approve` → `{ok, error?}`. `ok:false` WITH an `error` means the box
/// refused the rules (the approval stays pending); `ok:false` without one means
/// the entry is no longer pending (expired, or decided elsewhere).
struct ChatCardApproveResult: Decodable, Equatable, Sendable {
    var ok: Bool
    var error: String?

    init(ok: Bool, error: String? = nil) {
        self.ok = ok
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case ok, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = ((try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil) ?? false
        let raw = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        error = (raw?.isEmpty == false) ? raw : nil
    }
}

// MARK: - Read-only background job (delegate:job-for-session)

struct ChatCardJobParent: Decodable, Equatable, Sendable {
    var sessionId: String
    var name: String
    var project: String
    var windowIndex: Int
}

/// The box's reading of a job session: every line on the bar is its sentence.
struct ChatCardJobView: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var status: String
    var statusLabel: String
    var headline: String
    var statusLine: String
    var parentLine: String
    var stoppable: Bool
    var parent: ChatCardJobParent?
}

/// `{readOnly:false}` or `{readOnly:true, job}`. A `readOnly:true` without a
/// decodable `job` THROWS — the caller then keeps its current state instead of
/// treating the session as writable.
enum ChatCardJobForSession: Decodable, Equatable, Sendable {
    case writable
    case readOnly(ChatCardJobView)

    private enum CodingKeys: String, CodingKey { case readOnly, job }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if try c.decode(Bool.self, forKey: .readOnly) {
            self = .readOnly(try c.decode(ChatCardJobView.self, forKey: .job))
        } else {
            self = .writable
        }
    }
}

/// Who may change this conversation. `.resolving` is connection state (the box
/// has not answered yet): typing stays possible, sends are held. The box itself
/// refuses a message aimed at a job session (HTTP 409) — this is the client UX.
enum ChatCardMutationPolicy: Equatable, Sendable {
    case resolving
    case allowed
    case readOnlyJob
}

// MARK: - Compaction

struct ChatCardCompactionState: Equatable, Sendable {
    enum Phase: Equatable, Sendable { case running, done }

    var generation: Int
    var reason: String
    var text: String
    var phase: Phase
    /// The box's first line of what the compaction streamed (set by `ended`).
    var firstLine: String? = nil
}

/// The quiet "Compacted while you were away" line — the box's own text.
struct ChatCardCompactionNotice: Equatable, Sendable {
    var text: String
}

// MARK: - Jump to a message (C2 `.message`)

enum ChatCardFocusPhase: Equatable, Sendable {
    case none
    case locating(id: String, token: Int)
    case presented(id: String, token: Int)
    case failed(String)
}

// MARK: - Bounded keyed log

/// An insertion-ordered dictionary capped at `limit` entries (the oldest key is
/// evicted first). Event-store state lives for the app's lifetime, so a map fed
/// by a frame per command turn must be bounded.
struct ChatCardBoundedLog<Value: Equatable & Sendable>: Equatable, Sendable {
    let limit: Int
    private(set) var keys: [String] = []
    private(set) var values: [String: Value] = [:]

    init(limit: Int = 200) {
        self.limit = max(1, limit)
    }

    mutating func set(_ key: String, _ value: Value) {
        if values[key] == nil {
            keys.append(key)
        }
        values[key] = value
        while keys.count > limit {
            let oldest = keys.removeFirst()
            values[oldest] = nil
        }
    }

    var count: Int { keys.count }
}
