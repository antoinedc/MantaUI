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
    /// The payload's own JSON bytes, cut out of the frame without re-encoding. Typed payloads
    /// decode straight from these (`decodedPayload`), so a frame is parsed once.
    var payloadData: Data?
    /// The event's TYPE, resolved once at parse time so consumers never
    /// re-derive it. For RAW opencode events it is `payload.type` (with a
    /// `payload.kind` fallback for older boxes); typed `stream` frames carry
    /// no payload-level type (it is not resolved for them: nothing reads it),
    /// so it is nil there and the `sub` drives interpretation. This is the
    /// SINGLE place the app resolves an event's type (BET-1348).
    var eventType: String?

    init(kind: String, sub: String?, sessionId: String?, payloadData: Data?, eventType: String?) {
        self.kind = kind
        self.sub = sub
        self.sessionId = sessionId
        self.payloadData = payloadData
        self.eventType = eventType
    }

    /// Fixture / test constructor: the payload is encoded once.
    init(kind: String, sub: String?, sessionId: String?, payload: JSONValue?, eventType: String?) {
        self.init(
            kind: kind, sub: sub, sessionId: sessionId,
            payloadData: payload.flatMap { try? JSONEncoder().encode($0) },
            eventType: eventType
        )
    }

    var isHeartbeat: Bool { kind == "heartbeat" }

    /// The payload as a generic JSON value, decoded on demand (raw consumers only).
    var payload: JSONValue? {
        guard let payloadData else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: payloadData)
    }

    /// Decode `payload` into a concrete Decodable type, straight from its bytes.
    func decodedPayload<T: Decodable>(_ type: T.Type) throws -> T? {
        guard let payloadData else { return nil }
        return try JSONDecoder().decode(type, from: payloadData)
    }

    /// Where the interesting top-level fields of a frame sit, found without decoding it.
    private struct PayloadProbe: Decodable {
        var type: String?
        var kind: String?
        var sessionID: String?
        var sessionId: String?
        var properties: Properties?

        struct Properties: Decodable {
            var sessionID: String?
            var sessionId: String?

            private enum CodingKeys: String, CodingKey { case sessionID, sessionId }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                sessionID = ((try? c.decodeIfPresent(String.self, forKey: .sessionID)) ?? nil)
                sessionId = ((try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? nil)
            }
        }

        private enum CodingKeys: String, CodingKey { case type, kind, sessionID, sessionId, properties }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = ((try? c.decodeIfPresent(String.self, forKey: .type)) ?? nil)
            kind = ((try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil)
            sessionID = ((try? c.decodeIfPresent(String.self, forKey: .sessionID)) ?? nil)
            sessionId = ((try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? nil)
            properties = ((try? c.decodeIfPresent(Properties.self, forKey: .properties)) ?? nil)
        }
    }

    /// Parse one frame ONCE. The envelope fields are cut out by `MantaFrameScanner`; the payload stays as
    /// bytes. Pure and `Sendable`, so the socket runs it off the main actor.
    static func parse(_ text: String) throws -> MantaStreamFrame {
        let data = Data(text.utf8)
        guard let top = MantaFrameScanner.scan(data) else {
            throw MantaError.transport("event frame not an object")
        }
        guard let kind = MantaFrameScanner.string(top.kind, in: data) else {
            throw MantaError.transport("event frame missing kind")
        }
        let sub = MantaFrameScanner.string(top.sub, in: data)
        let envelopeSession = MantaFrameScanner.string(top.sessionId, in: data)
        let payloadData = top.payload.map { data.subdata(in: $0) }

        var sessionId = envelopeSession
        var eventType: String?
        let needsProbe = kind != "stream" || (envelopeSession ?? "").isEmpty
        if needsProbe, let payloadData,
           let probe = try? JSONDecoder().decode(PayloadProbe.self, from: payloadData) {
            // sessionId: envelope key first; when absent or empty, fall back to
            // `payload.sessionID`, then `payload.sessionId`, then the same two keys
            // under `payload.properties` (the box nests it there for raw opencode
            // events). First non-empty wins.
            if (envelopeSession ?? "").isEmpty {
                func nonEmpty(_ s: String?) -> String? { (s?.isEmpty ?? true) ? nil : s }
                sessionId = nonEmpty(probe.sessionID)
                    ?? nonEmpty(probe.sessionId)
                    ?? nonEmpty(probe.properties?.sessionID)
                    ?? nonEmpty(probe.properties?.sessionId)
            }
            // eventType: `payload.type` if a non-empty string, else `payload.kind`.
            // The envelope `kind` is intentionally LEFT untouched (it stays the
            // box's frame kind).
            if let t = probe.type, !t.isEmpty { eventType = t } else if let k = probe.kind, !k.isEmpty { eventType = k }
        }
        return MantaStreamFrame(
            kind: kind,
            sub: sub,
            sessionId: sessionId,
            payloadData: payloadData,
            eventType: eventType
        )
    }
}

// MARK: - Top-level field scanner

/// Finds the byte ranges of a frame's top-level `kind`, `sub`, `sessionId` and `payload` values without
/// decoding the rest — the payload (the big part of a frame) is never touched, only skipped.
enum MantaFrameScanner {
    struct TopLevel {
        var kind: Range<Int>?
        var sub: Range<Int>?
        var sessionId: Range<Int>?
        var payload: Range<Int>?
    }

    /// nil when `data` is not a JSON object (or is cut short).
    static func scan(_ data: Data) -> TopLevel? {
        data.withUnsafeBytes { raw -> TopLevel? in
            let bytes = raw.bindMemory(to: UInt8.self)
            return scan(bytes)
        }
    }

    private static let quote = UInt8(ascii: "\"")
    private static let backslash = UInt8(ascii: "\\")
    private static let openBrace = UInt8(ascii: "{")
    private static let closeBrace = UInt8(ascii: "}")
    private static let openBracket = UInt8(ascii: "[")
    private static let closeBracket = UInt8(ascii: "]")
    private static let colon = UInt8(ascii: ":")
    private static let comma = UInt8(ascii: ",")

    private static func isSpace(_ b: UInt8) -> Bool { b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0D }

    private static func scan(_ b: UnsafeBufferPointer<UInt8>) -> TopLevel? {
        let n = b.count
        var i = 0
        func skipSpace() { while i < n, isSpace(b[i]) { i += 1 } }

        /// `i` is at an opening quote; leaves it after the closing one and returns the content range.
        func skipString() -> Range<Int>? {
            guard i < n, b[i] == quote else { return nil }
            i += 1
            let start = i
            while i < n {
                if b[i] == backslash { i += 2; continue }
                if b[i] == quote {
                    let end = i
                    i += 1
                    return start..<end
                }
                i += 1
            }
            return nil
        }

        /// Skips one JSON value starting at `i` and returns its byte range.
        func skipValue() -> Range<Int>? {
            guard i < n else { return nil }
            let start = i
            switch b[i] {
            case quote:
                guard skipString() != nil else { return nil }
            case openBrace, openBracket:
                var depth = 0
                while i < n {
                    let c = b[i]
                    if c == quote {
                        guard skipString() != nil else { return nil }
                        continue
                    }
                    if c == openBrace || c == openBracket { depth += 1 }
                    if c == closeBrace || c == closeBracket {
                        depth -= 1
                        if depth == 0 { i += 1; return start..<i }
                    }
                    i += 1
                }
                return nil
            default:
                while i < n, b[i] != comma, b[i] != closeBrace, b[i] != closeBracket, !isSpace(b[i]) { i += 1 }
            }
            return start..<i
        }

        skipSpace()
        guard i < n, b[i] == openBrace else { return nil }
        i += 1
        var out = TopLevel()
        while true {
            skipSpace()
            guard i < n else { return nil }
            if b[i] == closeBrace { return out }
            guard let key = skipString() else { return nil }
            skipSpace()
            guard i < n, b[i] == colon else { return nil }
            i += 1
            skipSpace()
            guard let value = skipValue() else { return nil }
            // Compare the raw key bytes (a key containing an escape is never one of ours).
            switch key.count {
            case 4 where matches(b, key, "kind"): out.kind = value
            case 3 where matches(b, key, "sub"): out.sub = value
            case 9 where matches(b, key, "sessionId"): out.sessionId = value
            case 7 where matches(b, key, "payload"): out.payload = value
            default: break
            }
            skipSpace()
            guard i < n else { return nil }
            if b[i] == comma { i += 1; continue }
            if b[i] == closeBrace { return out }
            return nil
        }
    }

    private static func matches(_ b: UnsafeBufferPointer<UInt8>, _ range: Range<Int>, _ name: StaticString) -> Bool {
        let bytes = name.utf8Start
        for offset in 0..<range.count where b[range.lowerBound + offset] != bytes[offset] { return false }
        return true
    }

    /// The string a value range holds, or nil when there is none or it is not a string.
    static func string(_ range: Range<Int>?, in data: Data) -> String? {
        guard let range, range.count >= 2, data[range.lowerBound] == quote, data[range.upperBound - 1] == quote else { return nil }
        let slice = data.subdata(in: range)
        // Fast path: no escapes → the bytes between the quotes ARE the string.
        if !slice.contains(backslash) {
            return String(decoding: slice.dropFirst().dropLast(), as: UTF8.self)
        }
        return try? JSONDecoder().decode(String.self, from: slice)
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
    /// `true` on a focus replay: `text` is the WHOLE text streamed so far for the
    /// part, to be set rather than appended. Absent on every normal flush.
    var replay: Bool? = nil
}

/// `sub: "running"` — derived from `session.status` (busy/tworking/retry).
struct StreamRunningPayload: Codable, Equatable, Sendable {
    var running: Bool
    var since: Double?          // epoch ms; absent on an older box
}

/// `kind: "runningSet"` — the COMPLETE set of sessions the box currently has
/// running, replayed on every (re)connect. Authoritative: a session absent from
/// `sessions` is NOT running (BET-922).
struct StreamRunningSetPayload: Codable, Equatable, Sendable {
    struct Entry: Codable, Equatable, Sendable {
        var sessionId: String
        var since: Double?
        var type: String?
    }
    var sessions: [Entry]
    /// The box's interpreter process id (WS11 D11): run values of any other epoch are retired. nil on an older box.
    var epoch: String? = nil
}

/// `sub: "windowStatus"` — one windowed session's rolled-up status, decided on the box (WS11 D7): `busy` is work
/// anywhere beneath it (own turn, subagents at any depth, a running background job), `subagents` the direct children
/// whose own turn runs.
struct StreamWindowStatusPayload: Codable, Equatable, Sendable {
    var running: Bool = false
    var busy: Bool = false
    var startedAt: Double? = nil
    var attention: String? = nil
    /// The strongest pending ask (question over permission) among this row's descendants at any depth, excluding its
    /// own `attention` (C2). nil on an older box. A row is "waiting on you" when `attention ?? attentionBelow` is set.
    var attentionBelow: String? = nil
    var subagents: Int = 0
    var stopped: Bool = false

    /// The ask this row shows as "waiting on you": its own, else one beneath it.
    var waitingAttention: String? { attention ?? attentionBelow }

    private enum CodingKeys: String, CodingKey { case running, busy, startedAt, attention, attentionBelow, subagents, stopped }

    init(running: Bool = false, busy: Bool = false, startedAt: Double? = nil, attention: String? = nil,
         attentionBelow: String? = nil, subagents: Int = 0, stopped: Bool = false) {
        self.running = running
        self.busy = busy
        self.startedAt = startedAt
        self.attention = attention
        self.attentionBelow = attentionBelow
        self.subagents = subagents
        self.stopped = stopped
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = ((try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? nil) ?? false
        busy = ((try? c.decodeIfPresent(Bool.self, forKey: .busy)) ?? nil) ?? false
        startedAt = (try? c.decodeIfPresent(Double.self, forKey: .startedAt)) ?? nil
        attention = (try? c.decodeIfPresent(String.self, forKey: .attention)) ?? nil
        attentionBelow = (try? c.decodeIfPresent(String.self, forKey: .attentionBelow)) ?? nil
        subagents = ((try? c.decodeIfPresent(Int.self, forKey: .subagents)) ?? nil) ?? 0
        stopped = ((try? c.decodeIfPresent(Bool.self, forKey: .stopped)) ?? nil) ?? false
    }
}

/// `sub: "turnComplete"` — emitted by `message.updated`/`session.idle`.
struct StreamTurnCompletePayload: Codable, Equatable, Sendable {
    var complete: Bool
    var running: Bool
    var since: Double?
}

/// `sub: "truncation"` — classifyFinish result, box-classified.
struct StreamTruncationPayload: Codable, Equatable, Sendable {
    var kind: String
    var label: String
    /// The explanation, worded by the box (WS11 D8); nil on an older box.
    var hint: String? = nil
    var messageID: String?
}

/// `sub: "sessionError"` — a real turn failure (aborts are filtered box-side).
///
/// `display` is the box's sentence for the error and, for a credential failure,
/// the provider to reconnect (WS02 server-first: the box classifies against the
/// session's current model). An older box sends none: the raw `message` is then
/// shown as it is, never reclassified here.
struct StreamSessionErrorPayload: Codable, Equatable, Sendable {
    var name: String?
    var message: String
    var rawMessage: String? = nil
    var display: StreamSessionErrorDisplay? = nil

    /// The line to show: the box's text, else the raw message.
    var shownText: String { display?.text ?? message }
}

struct StreamSessionErrorDisplay: Codable, Equatable, Sendable {
    struct Reconnect: Codable, Equatable, Sendable {
        var providerID: String
        var label: String
        /// The id the Accounts screen accepts as its focus provider.
        var accountsId: String
    }

    var text: String
    var reconnect: Reconnect?
}

/// `sub: "retry"` — the provider is being retried (rate limit, overload). A
/// `null` payload clears it. `headline` / `caption` / `body` are the BOX's copy;
/// an older box sends none (the card then falls back to a fixed label + `message`).
struct StreamRetryAction: Codable, Equatable, Sendable {
    var title: String?
    var message: String?
    var label: String?
    var link: String?
}

struct StreamRetryPayload: Codable, Equatable, Sendable {
    var attempt: Double
    var message: String
    var next: Double? = nil
    var action: StreamRetryAction? = nil
    var headline: String? = nil
    var caption: String? = nil
    var body: String? = nil
}

/// `sub: "compaction"` — started / delta / ended. `firstLine` rides the `ended`
/// frame (the box's first non-blank line of what the compaction streamed).
struct StreamCompactionPayload: Codable, Equatable, Sendable {
    var phase: String
    var text: String? = nil
    var reason: String? = nil
    var firstLine: String? = nil
}

/// `sub: "optimizer.compacted"` — a background compaction of the open
/// conversation. `text` is the box's whole line; an older box sends none.
struct StreamOptimizerCompactedPayload: Codable, Equatable, Sendable {
    var text: String? = nil
}

/// `sub: "commandExecuted"` — the origin of a slash-command user message. The
/// box always sends `arguments` as a string (`""` when absent).
struct StreamCommandExecutedPayload: Codable, Equatable, Sendable {
    var messageID: String
    var name: String
    var arguments: String
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
    /// nil when the selected model's limit is unknown (`hasLimit` false) — the box sends `pct: null` then.
    var pct: Double?
    var hasLimit: Bool
    var segments: [StreamContextSegment]
    // WS11 D2: the box measures against the session's SELECTED model. Absent on an
    // older box (decode-if-present).
    var limit: Double? = nil
    var model: StreamContextModel? = nil
    var basis: String? = nil
}

/// `context.model` — the model the percentage is measured against.
struct StreamContextModel: Codable, Equatable, Sendable {
    var providerID: String
    var modelID: String
}

/// `sub: "cache"` — computeStaleCache output.
struct StreamCachePayload: Codable, Equatable, Sendable {
    var isStale: Bool
    var idleMs: Double
    var staleTokens: Double
    var ttlMs: Double
    // WS11 D2: `staleAt` is the epoch-ms instant the cache goes cold (nil = nothing
    // to warn about, or an older box); the client compares it with its own clock.
    var lastCompleted: Double? = nil
    var staleAt: Double? = nil
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

/// `sub: "planMode"` — the box mirrors opencode's LOCAL plan_enter/plan_exit
/// switch so the phone's Plan chip stays honest (BET-977). `on` is the plan
/// mode the model is now in.
struct StreamPlanModePayload: Codable, Equatable, Sendable {
    var on: Bool
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
    /// The tool's stable call id. Optional so a frame from an older box (or a
    /// fixture that omits it) still decodes; callers fall back to `idx`.
    var callID: String?
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
