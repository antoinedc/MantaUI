import Foundation
import Combine

// ===========================================================================
// S1b — observable event store + degraded mode (BET-593).
//
// The store is the SwiftUI-bindable layer over the /events stream:
//
//   - `connectionState` / `degraded` — the stream lifecycle. `degraded` is the
//     §17 spec: the box became unreachable, so only *new* interpretation stops
//     and NOTHING already delivered may be clear or re-derived.
//   - `sessionStates` — the interpreted per-session state the box publishes on
//     `kind:"stream"` frames, keyed by sessionId, so S4's views can bind.
//   - reconnect with backoff + re-fetch-on-reconnect (via `resyncHandler`) and
//     a heartbeat liveness watchdog (half-open socket detection) mirror
//     src/renderer/api/httpApi.ts.
//
// The device never interprets raw events — every `stream.*` payload here is
// already interpreted by the box (src/server/streamInterp.mjs).
// ===========================================================================

// MARK: - Per-session interpreted state

/// One part's accumulated live text, tagged with the message it belongs to.
///
/// The messageID is the load-bearing field: it is what lets a finished chunk be
/// RETIRED once the canonical transcript carries the same prose. Without it the
/// live copy has no expiry and the screen renders a finished answer twice —
/// once from the transcript, once from the still-live tail (BET-655).
struct StreamTextChunk: Equatable, Sendable {
    var partID: String
    var messageID: String
    var field: String
    var text: String
}

/// A tool call currently in flight (BET-753), keyed by its stable tool part id
/// (`idx`). The device renders it as a LIVE running-tool row (with the
/// accumulated bash tail) that converges to a canonical step row once the
/// turn-boundary refetch lands. Mirror of the server's `st.tools` record.
struct LiveTool: Equatable, Sendable {
    var idx: String
    /// The tool's stable call id — the SAME identity the canonical `ToolStep`
    /// row carries (see `ChatTranscriptMapper.stepIdentity`), so the live row
    /// and its completed canonical sibling share an id and replace in place.
    /// Falls back to `idx` when the box gave no callID.
    var callID: String
    var name: String?
    var presentationHint: String?
    var status: String?
    /// Accumulated incremental stdout tail, concatenated in arrival order.
    var tail: String = ""
    /// True once the `toolEnded` frame lands; an ended tool no longer renders
    /// as a running row (the record is kept so the outcome can be reflected).
    var ended: Bool = false
    var ok: Bool = true
    var truncated: Bool = false
}

struct MantaSessionStreamState: Equatable, Sendable {
    var sessionId: String
    /// Accumulated flushed text, one entry per (part, field), in ARRIVAL order
    /// (the box already applied flush boundaries; the device just concatenates).
    ///
    /// Ordered on purpose: this used to be a dictionary, whose `values` have no
    /// defined order, so an answer streamed as several parts could reassemble
    /// with its paragraphs shuffled.
    var chunks: [StreamTextChunk] = []
    var running: Bool?
    var turnComplete: Bool?
    var context: StreamContextPayload?
    var cache: StreamCachePayload?
    var truncation: StreamTruncationPayload?
    var sessionError: StreamSessionErrorPayload?
    var todos: StreamTodosPayload?
    var questions: StreamQuestionsPayload?
    var permissions: StreamPermissionsPayload?
    var subagents: [StreamSubagentPayload] = []
    /// Live tools in flight keyed by their stable tool part id (`idx`), and
    /// the order they started in. A `toolEnded` removes the idx from the order
    /// (so `runningTools` yields only still-running tools) but keeps the record
    /// so the outcome can be reflected; the whole map is cleared on
    /// `turnComplete`, when the turn's canonical refetch has taken the tools
    /// over as step rows (BET-753).
    var tools: [String: LiveTool] = [:]
    var toolStartOrder: [String] = []

    init(sessionId: String) {
        self.sessionId = sessionId
    }

    /// The still-running tools, in start order. Ended tools are already gone
    /// from `toolStartOrder`, so this is exactly what the running-tool rows
    /// render (BET-753).
    var runningTools: [LiveTool] {
        toolStartOrder.compactMap { tools[$0] }
    }

    /// partID -> accumulated text, for callers that only want a lookup.
    var textByPart: [String: String] {
        Dictionary(chunks.filter { $0.field != "reasoning" }.map { ($0.partID, $0.text) },
                   uniquingKeysWith: { _, latest in latest })
    }

    var reasoningByPart: [String: String] {
        Dictionary(chunks.filter { $0.field == "reasoning" }.map { ($0.partID, $0.text) },
                   uniquingKeysWith: { _, latest in latest })
    }

    /// The live assistant prose for the turn in flight, in arrival order. Empty
    /// once every chunk has been retired by a canonical transcript that covers
    /// it — which is what stops a finished answer rendering twice.
    ///
    /// Chunks are joined with a PARAGRAPH break (`\n\n`) rather than a single
    /// `\n`: separate step-narrations would otherwise render as a merged single
    /// line in the live tail and then "pop" into separate paragraphs when the
    /// canonical markdown refetch lands (BET-752 task 6).
    var liveText: String {
        chunks
            .filter { $0.field != "reasoning" && !$0.text.isEmpty }
            .map(\.text)
            .joined(separator: "\n\n")
    }

    /// Append a flushed chunk, extending the part's text when it is already
    /// known. Text and reasoning are tracked separately for the same part.
    mutating func appending(_ payload: StreamFlushPayload) {
        if let i = chunks.firstIndex(where: { $0.partID == payload.partID && $0.field == payload.field }) {
            chunks[i].text += payload.text
        } else {
            chunks.append(StreamTextChunk(
                partID: payload.partID,
                messageID: payload.messageID,
                field: payload.field,
                text: payload.text
            ))
        }
    }
}

// MARK: - Pure routing (box `stream.*` subs -> session state)

enum MantaStreamRouter {
    /// Apply one frame to a session's state. Pure so the mapping is testable.
    static func applying(_ frame: MantaStreamFrame, to state: MantaSessionStreamState?) -> MantaSessionStreamState {
        guard frame.kind == "stream", let sub = frame.sub else {
            return state ?? MantaSessionStreamState(sessionId: frame.sessionId ?? "")
        }
        var s = state ?? MantaSessionStreamState(sessionId: frame.sessionId ?? "")
        switch sub {
        case "flush":
            if let p = try? frame.decodedPayload(StreamFlushPayload.self) {
                s.appending(p)
            }
        case "running":
            if let p = try? frame.decodedPayload(StreamRunningPayload.self) {
                s.running = p.running
                // A new turn clears any stale error surfaced by the previous one.
                if p.running { s.sessionError = nil }
            }
        case "turnComplete":
            if let p = try? frame.decodedPayload(StreamTurnCompletePayload.self) {
                s.turnComplete = p.complete
                // The box only ever publishes `running:true` on the `running`
                // sub — the end of a turn is carried HERE, by turnComplete's own
                // `running` field (`session.idle` emits
                // turnComplete{complete:true, running:false} and no `running`
                // frame at all). Ignoring it left `running` latched true for the
                // life of the session, so the working row and session-list timer
                // never stopped.
                s.running = p.running
            }
            // A finished turn has no running tools; the canonical refetch now
            // owns them as step rows, so drop the live map to bound memory
            // (BET-753).
            s.tools.removeAll()
            s.toolStartOrder.removeAll()
        case "toolStarted":
            if let p = try? frame.decodedPayload(StreamToolStartedPayload.self) {
                let callID = (p.callID?.isEmpty ?? true) ? p.idx : p.callID!
                s.tools[p.idx] = LiveTool(
                    idx: p.idx,
                    callID: callID,
                    name: p.toolName,
                    presentationHint: p.toolPresentationHint,
                    status: p.status
                )
                if !s.toolStartOrder.contains(p.idx) { s.toolStartOrder.append(p.idx) }
            }
        case "toolOutput":
            if let p = try? frame.decodedPayload(StreamToolOutputPayload.self),
               var t = s.tools[p.idx] {
                t.tail += p.text
                t.status = "running"
                s.tools[p.idx] = t
            }
        case "toolEnded":
            if let p = try? frame.decodedPayload(StreamToolEndedPayload.self),
               var t = s.tools[p.idx] {
                t.ended = true
                t.ok = p.ok
                t.truncated = p.truncated ?? false
                s.tools[p.idx] = t
                s.toolStartOrder.removeAll { $0 == p.idx }
            }
        case "truncation":
            s.truncation = try? frame.decodedPayload(StreamTruncationPayload.self)
        case "sessionError":
            s.sessionError = try? frame.decodedPayload(StreamSessionErrorPayload.self)
        case "context":
            s.context = try? frame.decodedPayload(StreamContextPayload.self)
        case "cache":
            s.cache = try? frame.decodedPayload(StreamCachePayload.self)
        case "todos":
            s.todos = try? frame.decodedPayload(StreamTodosPayload.self)
        case "questions":
            s.questions = try? frame.decodedPayload(StreamQuestionsPayload.self)
        case "permissions":
            s.permissions = try? frame.decodedPayload(StreamPermissionsPayload.self)
        case "subagent":
            if let p = try? frame.decodedPayload(StreamSubagentPayload.self) {
                // Upsert keyed by the subagent's child-session id (BET-672): a
                // subagent that goes running→done would otherwise leave BOTH
                // records, so the session list's running-count counts a stale
                // "running" and the array grows without bound. An incoming
                // payload replaces the record for its child, else appends.
                if let i = s.subagents.firstIndex(where: { $0.childSessionId == p.childSessionId }) {
                    s.subagents[i] = p
                } else {
                    s.subagents.append(p)
                }
            }
        case "subagent.child", "autoRename":
            break // registration / rename triggers consumed by later stages
        default:
            break
        }
        return s
    }

    /// Retire the live chunks whose message the canonical transcript now
    /// carries. Pure so the retirement rule is testable without a socket.
    ///
    /// The contract is caller-enforced: `covered` names ONLY the message ids
    /// the canonical transcript actually renders — i.e. COMPLETED assistant
    /// messages (`ChatTranscriptMapper` skips any assistant message still in
    /// flight, and `opencode:messages` returns the running one with no
    /// `time.completed`). So a chunk is retired exactly when a second,
    /// permanent copy of its prose already exists in the transcript, and the
    /// still-streaming message is protected simply by never appearing in
    /// `covered`.
    ///
    /// This replaces a "keep the last chunk while running" guard that was wrong
    /// twice over: one turn is SEVERAL assistant messages (one per step), so
    /// the last chunk is frequently a completed step rather than the streaming
    /// one; and it read `running`, a flag that latches true (the box only ever
    /// publishes `running:true` on the `running` sub — see `applying`), so the
    /// guard fired against a stale value. Kept pure, same signature, idempotent.
    static func retiring(_ state: MantaSessionStreamState, covered: Set<String>) -> MantaSessionStreamState {
        var s = state
        s.chunks.removeAll { covered.contains($0.messageID) }
        return s
    }
}

// MARK: - Liveness policy (pure)

enum MantaLivenessPolicy {
    /// true when the socket reports connected but no frame (incl. heartbeats)
    /// has arrived within `staleMs` — a half-open path the OS didn't surface.
    static func shouldForceReconnect(state: MantaConnectionState, lastFrameAt: Date, now: Date, staleMs: Double) -> Bool {
        guard state.name == "connected" else { return false }
        return (now.timeIntervalSince(lastFrameAt) * 1000.0) > staleMs
    }
}

// MARK: - Stream control abstraction (injectable so the store is testable)

@MainActor
protocol MantaEventStreamControl: AnyObject {
    var onState: ((MantaConnectionState) -> Void)? { get set }
    var onMessage: ((String) -> Void)? { get set }
    var onReconnect: (() -> Void)? { get set }
    var onConfigError: ((Error) -> Void)? { get set }
    var hasConnectedOnce: Bool { get }
    var currentState: MantaConnectionState { get }
    func ensure()
    func markReconnectAndEnsure()
    func retryNow()
    func forceReconnect()
    func close(reason: String)
}

extension MantaReconnectController: MantaEventStreamControl {}

// MARK: - The store

@MainActor
final class MantaEventStore: ObservableObject {

    @Published private(set) var connectionState: MantaConnectionState = .idle
    @Published private(set) var degraded = false
    @Published private(set) var sessionStates: [String: MantaSessionStreamState] = [:]
    /// Routing stamp of the MOST RECENT stream frame the store applied: which
    /// session it was for and which `sub` it carried. The `$sessionStates` sink
    /// fires on any session's change with only the ACCUMULATED snapshot, which
    /// can't tell a consumer which fields the frame just delivered. This is the
    /// per-frame delta the single-writer merge (BET-668) feeds off.
    private(set) var lastStreamFrame: StreamFrameStamp?

    /// Which session the most recent stream frame targeted and the `sub` it
    /// carried. `sub == nil` for a non-routed frame (nothing turn-state-related
    /// changed).
    struct StreamFrameStamp: Equatable {
        var sessionId: String
        var sub: String?
    }
    /// Invoked on every healthy reconnect so the app re-fetches state that may
    /// have changed while disconnected (rather than assuming the stream
    /// resumed). S4 wires this to re-fetch sessions / messages / permissions /
    /// questions.
    var resyncHandler: (() -> Void)?

    /// Event frame we do NOT understand from the interpreted stream are still
    /// delivered here (raw `opencode`, `status`, …) for consumers that want
    /// them. S1b only binds to interpreted stream state.
    var rawFrameHandler: ((MantaStreamFrame) -> Void)?

    private let controller: any MantaEventStreamControl
    private var lastFrameAt: Date
    private var watchdog: Timer?
    /// Sessions that have a live observer attached (a `ChatSessionStore` that
    /// has `start()`ed and not yet `stop()`ed). The store clears a session's
    /// accumulated stream chunks when its turn completes while NO observer is
    /// attached — nothing would ever retire them, so they'd otherwise
    /// accumulate without bound (BET-672).
    private(set) var registeredSessionIDs: Set<String> = []
    /// No frame (heartbeats included) for this long means the socket is dead
    /// even if it claims otherwise. Shared by the watchdog and `resume()`.
    private let staleFrameMs: Double = 45_000

    init(
        stream: (any MantaEventStreamControl)? = nil,
        tokenProvider: @escaping () -> String? = { KeychainCredentialStore.shared.boxToken },
        serverProvider: @escaping () -> URL? = { KeychainCredentialStore.shared.serverURL }
    ) {
        self.lastFrameAt = Date()
        let controller = stream ?? Self.makeController(tokenProvider: tokenProvider, serverProvider: serverProvider)
        self.controller = controller
        controller.onState = { [weak self] state in self?.handleState(state) }
        controller.onMessage = { [weak self] text in self?.handleFrame(text) }
        controller.onReconnect = { [weak self] in self?.handleReconnect() }
        controller.onConfigError = { _ in }
    }

    static func makeController(
        tokenProvider: @escaping () -> String?,
        serverProvider: @escaping () -> URL?
    ) -> any MantaEventStreamControl {
        MantaReconnectController(
            url: { Self.eventsWebSocketURL(from: serverProvider()) },
            makeSocket: { url in
                MantaURLSessionWebSocket(authHeader: Self.bearer(token: tokenProvider()))
            }
        )
    }

    /// Connect the stream (idempotent) and arm the liveness watchdog.
    func start() {
        controller.ensure()
        startWatchdog()
    }

    /// App foreground / resume: force a reconnect + resync of missed state.
    ///
    /// `ensure()` alone is not enough here. A socket the OS tore down while the
    /// process was suspended can still report itself open, so `ensure()`'s
    /// "already live" short-circuit leaves the stream permanently silent; and a
    /// backgrounded app's reconnect timers do not fire, so the controller may
    /// have burnt its whole reconnect window and closed for good. Whenever the
    /// stream is not demonstrably healthy — not `connected`, or no frame
    /// (heartbeats included) for longer than the watchdog's staleness bar — we
    /// reopen unconditionally rather than trust it.
    func resume() {
        let stale = MantaLivenessPolicy.shouldForceReconnect(
            state: connectionState,
            lastFrameAt: lastFrameAt,
            now: Date(),
            staleMs: staleFrameMs
        )
        if connectionState.name == "connected" && !stale {
            controller.markReconnectAndEnsure()
        } else {
            controller.forceReconnect()
        }
        lastFrameAt = Date()
        // Timers are suspended with the process; re-arm rather than assume the
        // watchdog survived the trip to the background.
        startWatchdog()
    }

    /// Permanent teardown.
    func stop() {
        watchdog?.invalidate()
        watchdog = nil
        controller.close(reason: "store stopped")
    }

    func restart() {
        controller.retryNow()
    }

    /// Tear down / stop scheduling — leaves delivered data intact.
    func leaveDegradedWithRetry() {
        restart()
    }

    // MARK: - Controller callbacks

    private func handleState(_ state: MantaConnectionState) {
        connectionState = state
        degraded = controller.hasConnectedOnce && state.isUnreachable
    }

    private func handleFrame(_ text: String) {
        lastFrameAt = Date()
        guard let frame = try? MantaStreamFrame.parse(text) else { return }
        if frame.isHeartbeat { return }
        if frame.kind == "stream" {
            routeStream(frame)
        } else {
            rawFrameHandler?(frame)
        }
    }

    private func routeStream(_ frame: MantaStreamFrame) {
        // Degraded mode (§17): only *new* interpretation stops. Nothing already
        // delivered is cleared or re-derived; the composer stays usable and the
        // transcript + scroll are untouched because we simply don't mutate the
        // already-published state while unreachable.
        guard !degraded else { return }
        let sid = frame.sessionId ?? ""
        var next = MantaStreamRouter.applying(frame, to: sessionStates[sid])
        // A turn that COMPLETED with no observer attached has no one who will
        // retire its accumulated chunks (retirement lives in the observing
        // ChatSessionStore's refetch path). Clear them here so an unopened
        // session's stream text can't accumulate forever (BET-672). An OBSERVED
        // session is never cleared — its live text is load-bearing for the open
        // transcript.
        if next.turnComplete == true, !registeredSessionIDs.contains(sid) {
            next.chunks.removeAll()
        }
        sessionStates[sid] = next
        lastStreamFrame = StreamFrameStamp(sessionId: sid, sub: frame.sub)
    }

    /// Mark a session as having a live observer. Only an observed session keeps
    /// its accumulated chunks past a completed turn (BET-672).
    func registerSession(_ sessionId: String) {
        registeredSessionIDs.insert(sessionId)
    }

    /// Mark a session as no longer observed. Its turn-complete chunks become
    /// eligible for eviction on the next routing pass.
    func unregisterSession(_ sessionId: String) {
        registeredSessionIDs.remove(sessionId)
    }

    /// Retire live stream text the canonical transcript now carries. A session
    /// store calls this straight after a successful refetch — the one moment
    /// the live copy turns from "the only copy" into a duplicate.
    ///
    /// Publishes only on a real change, so an already-clean state does not wake
    /// every subscriber (and cannot loop: retirement is idempotent).
    func retireCoveredStreamText(sessionId: String, covered: Set<String>) {
        guard let state = sessionStates[sessionId] else { return }
        let next = MantaStreamRouter.retiring(state, covered: covered)
        if next != state {
            sessionStates[sessionId] = next
            // This is a local republish, not a new stream frame — clear the
            // frame stamp so a consumer doesn't replay the PREVIOUS frame's
            // fields over a newer optimistic value (BET-668 review cycle 2).
            lastStreamFrame = nil
        }
    }

    private func handleReconnect() {
        // On reconnect, re-fetch rather than assuming the stream resumed.
        resyncHandler?()
    }

    // MARK: - Liveness watchdog

    private func startWatchdog() {
        watchdog?.invalidate()
        let timer = Timer(timeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.watchdogTick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        watchdog = timer
    }

    private func watchdogTick() {
        if MantaLivenessPolicy.shouldForceReconnect(
            state: connectionState,
            lastFrameAt: lastFrameAt,
            now: Date(),
            staleMs: staleFrameMs
        ) {
            controller.forceReconnect()
        }
    }

    // MARK: - URL + auth helpers

    static func eventsWebSocketURL(from server: URL?) -> URL? {
        guard let server else { return nil }
        var comps = URLComponents(url: server, resolvingAgainstBaseURL: false)
        comps?.scheme = server.scheme == "https" ? "wss" : "ws"
        comps?.path = "/events"
        comps?.query = nil
        return comps?.url
    }

    static func bearer(token: String?) -> String? {
        guard let token, !token.isEmpty else { return nil }
        return "Bearer \(token)"
    }
}
