import Foundation

// ===========================================================================
// S1b — event stream transport models (BET-593).
//
// Port of the box /events contract from src/renderer/api/httpApi.ts. The
// /events endpoint is a WebSocket that delivers one JSON text frame per event
// in the SAME {kind, payload, sub, sessionId} envelope as the SSE route
// (src/server/events.mjs). The box interprets the raw opencode stream
// box-side (src/server/streamInterp.mjs) and republishes the derived events as
// `kind:"stream"` frames with a `sub` routing field. This file owns the pure,
// sendable, unit-testable half of that: the exponential backoff, the
// connection-state machine (ports of src/shared/net/backoff.ts + state.ts),
// the frame envelope + parse, and the typed interpreted-stream payloads.
//
// The DEVICE DOES NOT interpret raw events (see §17). Every payload below is
// already interpreted by the box; the device only demuxes and stores it.
// ===========================================================================

// MARK: - Exponential backoff (port of src/shared/net/backoff.ts)

/// Deterministic exponential backoff. `delayMs(forAttempt:)` returns a
/// full-jitter delay in `[0, base * factor^attempt]` capped at `max`.
struct ExponentialBackoff: Equatable, Sendable {
    var baseMs: Double
    var maxMs: Double
    var factor: Double
    var jitter: Bool

    /// Matches the reference default: 1s → 15s, binary growth, full jitter.
    init(base: Double = 1000, max: Double = 15000, factor: Double = 2, jitter: Bool = true) {
        self.baseMs = base
        self.maxMs = max
        self.factor = factor
        self.jitter = jitter
    }

    /// The capped, un-jittered delay for `attempt` (0-indexed): base*factor^n.
    func cappedDelayMs(forAttempt attempt: Int) -> Double {
        let computed = baseMs * pow(factor, Double(Swift.max(0, attempt)))
        return Swift.min(computed, maxMs)
    }

    /// The scheduled delay for `attempt`. With jitter, a uniform random in
    /// `[0, capped]`; without, exactly `capped`. `rng` is injectable so tests
    /// can pin the value.
    func delayMs(forAttempt attempt: Int, rng: () -> Double = { Double.random(in: 0.0..<1.0) }) -> Double {
        let capped = cappedDelayMs(forAttempt: attempt)
        guard jitter else { return capped }
        return rng() * capped
    }
}

// MARK: - Connection state machine (port of src/shared/net/state.ts)

enum MantaConnectionState: Equatable, Sendable {
    case idle
    case connecting(attempt: Int)
    case connected
    case stalled
    case reconnecting(attempt: Int, backoffMs: Double)
    case closed(reason: String)

    var name: String {
        switch self {
        case .idle: return "idle"
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .stalled: return "stalled"
        case .reconnecting: return "reconnecting"
        case .closed: return "closed"
        }
    }

    /// True while the stream is NOT carrying events. Used to drive degraded
    /// mode once the box was reachable and then dropped.
    var isUnreachable: Bool {
        switch self {
        case .idle, .connecting: return false
        case .connected: return false
        case .stalled, .reconnecting, .closed: return true
        }
    }
}

/// Legal single-step transitions, mirroring the reference table.
enum MantaConnectionRule {
    static func canTransition(from: MantaConnectionState, to: MantaConnectionState) -> Bool {
        let table: [String: Set<String>] = [
            "idle": ["connecting"],
            "connecting": ["connected", "reconnecting", "closed"],
            "connected": ["stalled", "closed"],
            "stalled": ["reconnecting", "connected", "closed"],
            "reconnecting": ["connected", "reconnecting", "closed"],
            "closed": ["idle"],
        ]
        guard let allowed = table[from.name] else { return false }
        return allowed.contains(to.name)
    }
}

// MARK: - Frame envelope + parse

/// A parsed /events frame. `payload` is kept as `JSONValue` so both the raw
/// opencode events and the typed interpreted stream payloads stay reachable.
/// The box publishes `{ kind, payload, sub, sessionId }` per frame.
struct MantaStreamFrame: Equatable, Sendable {
    var kind: String
    var sub: String?
    var sessionId: String?
    var payload: JSONValue?

    var isHeartbeat: Bool { kind == "heartbeat" }

    /// Decode `payload` into a concrete Decodable type.
    func decodedPayload<T: Decodable>(_ type: T.Type) throws -> T? {
        guard let payload else { return nil }
        let data = try JSONEncoder().encode(payload)
        return try JSONDecoder().decode(type, from: data)
    }

    static func parse(_ text: String) throws -> MantaStreamFrame {
        let data = Data(text.utf8)
        let json = try JSONDecoder().decode(JSONValue.self, from: data)
        guard case .object(let obj) = json else {
            throw MantaError.transport("event frame not an object")
        }
        func string(_ key: String) -> String? {
            if case .string(let s)? = obj[key] { return s }
            return nil
        }
        guard let kind = string("kind") else {
            throw MantaError.transport("event frame missing kind")
        }
        return MantaStreamFrame(
            kind: kind,
            sub: string("sub"),
            sessionId: string("sessionId"),
            payload: obj["payload"]
        )
    }
}

// MARK: - Interpreted stream payloads (produced by src/server/streamInterp.mjs)

/// `sub: "flush"` — a text/reasoning delta flushed at a markdown-safe
/// boundary. `field` is `"text"` or `"reasoning"`. This is the raw material
/// S4 accumulates into the transcript (the box already applied flush
/// boundaries; the device just concatenates `text` onto the part).
struct StreamFlushPayload: Codable, Equatable, Sendable {
    var messageID: String
    var partID: String
    var field: String
    var text: String
}

/// `sub: "running"` — derived from `session.status` (busy/tworking/retry).
struct StreamRunningPayload: Codable, Equatable, Sendable {
    var running: Bool
}

/// `sub: "turnComplete"` — emitted by `message.updated`/`session.idle`.
struct StreamTurnCompletePayload: Codable, Equatable, Sendable {
    var complete: Bool
    var running: Bool
}

/// `sub: "truncation"` — classifyFinish result, box-classified.
struct StreamTruncationPayload: Codable, Equatable, Sendable {
    var kind: String
    var label: String
    var messageID: String?
}

/// `sub: "sessionError"` — a real turn failure (aborts are filtered box-side).
struct StreamSessionErrorPayload: Codable, Equatable, Sendable {
    var name: String?
    var message: String
}

/// `sub: "context"` — computeContextBreakdown output (all box-computed).
struct StreamContextSegment: Codable, Equatable, Sendable {
    var kind: String
    var pct: Double
}

struct StreamContextPayload: Codable, Equatable, Sendable {
    var freshInput: Double
    var cacheRead: Double
    var cacheWrite: Double
    var totalInput: Double
    var pct: Double
    var segments: [StreamContextSegment]
}

/// `sub: "cache"` — computeStaleCache output.
struct StreamCachePayload: Codable, Equatable, Sendable {
    var isStale: Bool
    var idleMs: Double
    var staleTokens: Double
    var ttlMs: Double
}

/// `sub: "todos"` — selectActiveTodos + selectVisibleTodos output.
struct StreamTodoItem: Codable, Equatable, Sendable {
    var id: String?
    var content: String?
    var status: String?

    enum CodingKeys: String, CodingKey { case id, content, status }

    init(id: String? = nil, content: String? = nil, status: String? = nil) {
        self.id = id
        self.content = content
        self.status = status
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        content = try c.decodeIfPresent(String.self, forKey: .content)
        status = try c.decodeIfPresent(String.self, forKey: .status)
    }
}

struct StreamVisibleTodos: Codable, Equatable, Sendable {
    var visible: [StreamTodoItem]
    var hiddenPending: Double
    var hiddenDone: Double
}

struct StreamTodosPayload: Codable, Equatable, Sendable {
    var active: [StreamTodoItem]?
    var visible: StreamVisibleTodos?
    var allTerminal: Bool
    var anyTerminal: Bool
}

/// `sub: "questions"` — applyQuestionEvent output (QuestionLike rows).
struct StreamQuestionsPayload: Codable, Equatable, Sendable {
    var questions: [QuestionRequest]
}

/// `sub: "permissions"` — the pending permission requests for the session.
/// Same wire shape as the `opencode:permissions` RPC, so the existing
/// PermissionRequest Codable decodes both.
struct StreamPermissionsPayload: Codable, Equatable, Sendable {
    var permissions: [PermissionRequest]
}

/// `sub: "subagent"` — extractSubagentInfo + runningCount.
struct StreamSubagentPayload: Codable, Equatable, Sendable {
    var childSessionId: String
    var agent: String?
    var description: String?
    var prompt: String?
    var status: String?
    var title: String?
    var output: String?
    var truncated: Bool?
    var durationMs: Double?
    var runningCount: Double?
    var model: StreamSubagentModel?

    struct StreamSubagentModel: Codable, Equatable, Sendable {
        var providerID: String?
        var modelID: String?
    }
}

/// `sub: "subagent.child"` — a child session registered via session.created.
struct StreamSubagentChildPayload: Codable, Equatable, Sendable {
    var childSessionId: String
}

// MARK: - Live tool frames (server BET-745 / app BET-753)
//
// The server half (BET-745) publishes three temporary, additive frames so a
// thin client can render a LIVE running-tool row with a bash tail mid-turn,
// before the canonical turn-boundary refetch lands. The device reads exactly
// these field names (never the raw opencode event):
//   toolStarted { sessionId, idx, toolName, toolPresentationHint?, status }
//   toolOutput  { sessionId, idx, text }
//   toolEnded   { sessionId, idx, ok, truncated? }
// `idx` is the tool PART ID — stable per tool across the whole run, identical
// on started/output/ended — so the device keys its running-tool rows by it.

/// `sub: "toolStarted"` — a live tool call began.
struct StreamToolStartedPayload: Codable, Equatable, Sendable {
    var sessionId: String
    var idx: String
    var toolName: String?
    var toolPresentationHint: String?
    var status: String?
}

/// `sub: "toolOutput"` — one incremental stdout chunk for a running tool. The
/// server sends only the delta since the last chunk (never the full output),
/// bounded by its per-tool cap.
struct StreamToolOutputPayload: Codable, Equatable, Sendable {
    var sessionId: String
    var idx: String
    var text: String
}

/// `sub: "toolEnded"` — the tool call settled. `ok` is true when the tool
/// completed, false when it errored; `truncated` is present true only when the
/// per-tool output cap was hit.
struct StreamToolEndedPayload: Codable, Equatable, Sendable {
    var sessionId: String
    var idx: String
    var ok: Bool
    var truncated: Bool?
}

/// `sub: "autoRename"` — a title-summarization trigger.
struct StreamAutoRenamePayload: Codable, Equatable, Sendable {
    var turns: Double
    var promptInput: String
    var instruction: String
}
