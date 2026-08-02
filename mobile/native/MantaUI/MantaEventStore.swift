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

struct MantaSessionStreamState: Equatable, Sendable {
    var sessionId: String
    /// partID -> accumulated flushed text (the box already applied flush
    /// boundaries; the device just concatenates).
    var textByPart: [String: String] = [:]
    var reasoningByPart: [String: String] = [:]
    var running: Bool?
    var turnComplete: Bool?
    var context: StreamContextPayload?
    var cache: StreamCachePayload?
    var truncation: StreamTruncationPayload?
    var todos: StreamTodosPayload?
    var questions: StreamQuestionsPayload?
    var subagents: [StreamSubagentPayload] = []

    init(sessionId: String) {
        self.sessionId = sessionId
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
                if p.field == "reasoning" {
                    s.reasoningByPart[p.partID, default: ""] += p.text
                } else {
                    s.textByPart[p.partID, default: ""] += p.text
                }
            }
        case "running":
            if let p = try? frame.decodedPayload(StreamRunningPayload.self) { s.running = p.running }
        case "turnComplete":
            if let p = try? frame.decodedPayload(StreamTurnCompletePayload.self) { s.turnComplete = p.complete }
        case "truncation":
            s.truncation = try? frame.decodedPayload(StreamTruncationPayload.self)
        case "context":
            s.context = try? frame.decodedPayload(StreamContextPayload.self)
        case "cache":
            s.cache = try? frame.decodedPayload(StreamCachePayload.self)
        case "todos":
            s.todos = try? frame.decodedPayload(StreamTodosPayload.self)
        case "questions":
            s.questions = try? frame.decodedPayload(StreamQuestionsPayload.self)
        case "subagent":
            if let p = try? frame.decodedPayload(StreamSubagentPayload.self) { s.subagents.append(p) }
        case "subagent.child", "autoRename":
            break // registration / rename triggers consumed by later stages
        default:
            break
        }
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
    func resume() {
        controller.markReconnectAndEnsure()
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
        let next = MantaStreamRouter.applying(frame, to: sessionStates[sid])
        sessionStates[sid] = next
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
            staleMs: 45_000
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
