import Foundation

// ===========================================================================
// S1b — reconnecting /events WebSocket (BET-593).
//
// Faithful port of the desktop reconnect controller
// (src/renderer/net/wsTransport.ts) driving the same {kind,payload} event
// envelope over a WebSocket. It owns:
//   - the /events socket (Bearer header auth — the box accepts the header on
//     WS, "a header always wins"),
//   - exponential-backoff reconnect that never permanently abandons the socket
//     inside a bounded total window (default 10 min),
//   - a re-fetch-on-reconnect signal (`onReconnect`), fired on every successful
//     open that FOLLOWED a drop — the client re-fetches rather than assuming
//     the stream resumed,
//   - an unconditional `forceReconnect` used by the liveness watchdog.
//
// It is transport-injectable (socket + scheduler) so the whole reconnect /
// degraded behaviour is unit-testable without real sockets or real sleeps.
// ===========================================================================

/// Cancel handle for a scheduled fire (real `Timer` or a fake in tests).
@MainActor
protocol MantaCancelable: AnyObject {
    func cancel()
}

/// Abstract time-scheduler so reconnect delays are testable.
@MainActor
protocol MantaScheduler {
    func schedule(after delayMs: Double, _ block: @escaping @MainActor () -> Void) -> any MantaCancelable
}

/// Minimal WebSocket surface the controller drives. Deliberately a plain
/// (non-actor) protocol: the real implementation is a nonisolated class that
/// hops every callback to the main actor before invoking the closures, so it
/// does not need to formally cross an actor boundary to adopt
/// URLSessionWebSocketDelegate.
protocol MantaWebSocketSession: AnyObject {
    var onOpen: (@MainActor () -> Void)? { get set }
    var onMessage: (@MainActor (String) -> Void)? { get set }
    /// When set, a text frame is parsed OFF the main actor and delivered here already parsed; a frame that
    /// fails to parse (and every frame when this is nil) goes to `onMessage` as text instead.
    var onFrame: (@MainActor (MantaStreamFrame) -> Void)? { get set }
    var onDrop: (@MainActor () -> Void)? { get set }
    var isOpen: Bool { get }
    func connect(to url: URL)
    /// Send one text message to the box (the C1 `kinds` / `focus` messages). Best effort: a failed send is
    /// repaired by the next connect, which re-sends both.
    func send(_ text: String)
    func close()
}

/// Real scheduler backed by `Timer` on the main run loop.
@MainActor
final class MantaTimerScheduler: MantaScheduler {
    func schedule(after delayMs: Double, _ block: @escaping @MainActor () -> Void) -> any MantaCancelable {
        TimerScheduled(delayMs: delayMs, block: block)
    }
}

@MainActor
private final class TimerScheduled: MantaCancelable {
    private var timer: Timer?
    init(delayMs: Double, block: @escaping @MainActor () -> Void) {
        let t = Timer(timeInterval: max(0, delayMs / 1000.0), repeats: false) { _ in
            Task { @MainActor in block() }
        }
        RunLoop.main.add(t, forMode: .common)
        self.timer = t
    }
    func cancel() { timer?.invalidate(); timer = nil }
}

/// Real /events socket using URLSessionWebSocketTask. Authentication is the
/// `Authorization: Bearer <boxToken>` header on the upgrade request.
final class MantaURLSessionWebSocket: NSObject, MantaWebSocketSession, URLSessionWebSocketDelegate {
    var onOpen: (@MainActor () -> Void)?
    var onMessage: (@MainActor (String) -> Void)?
    var onFrame: (@MainActor (MantaStreamFrame) -> Void)?
    var onDrop: (@MainActor () -> Void)?

    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private let authHeader: String?

    init(authHeader: String?) {
        self.authHeader = authHeader
        super.init()
    }

    var isOpen: Bool { task?.state == .running }

    func connect(to url: URL) {
        var request = URLRequest(url: url)
        if let authHeader, !authHeader.isEmpty {
            request.setValue(authHeader, forHTTPHeaderField: "Authorization")
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        let session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        let task = session.webSocketTask(with: request)
        self.urlSession = session
        self.task = task
        task.resume()
        receive()
    }

    func send(_ text: String) {
        task?.send(.string(text)) { error in
            if let error { NSLog("[events] send failed: %@", String(describing: error)) }
        }
    }

    func close() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
    }

    /// Parse one frame off the main actor. A plain `nonisolated` async function runs on the global executor, so
    /// the main actor only sees the finished value.
    nonisolated private static func parseOffMain(_ text: String) async -> MantaStreamFrame? {
        try? MantaStreamFrame.parse(text)
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        Task { @MainActor [weak self] in self?.onOpen?() }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Task { @MainActor [weak self] in self?.onDrop?() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil {
            Task { @MainActor [weak self] in self?.onDrop?() }
        }
    }

    private func receive() {
        guard let task else { return }
        task.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    Task { @MainActor [weak self] in
                        // Frames are handled one at a time, in arrival order: the next read starts after this one
                        // is delivered, so a slow parse can never reorder the stream.
                        if self?.onFrame != nil {
                            let frame = await MantaURLSessionWebSocket.parseOffMain(text)
                            if let frame, let deliver = self?.onFrame {
                                deliver(frame)
                            } else {
                                self?.onMessage?(text)
                            }
                        } else {
                            self?.onMessage?(text)
                        }
                        self?.receive()
                    }
                case .data:
                    Task { @MainActor [weak self] in self?.receive() }
                @unknown default:
                    break
                }
            case .failure:
                Task { @MainActor [weak self] in self?.onDrop?() }
            }
        }
    }
}

// ===========================================================================
/// Reconnecting controller (port of WsReconnectController).
@MainActor
final class MantaReconnectController {

    /// A healthy open that follows a drop fires this (re-fetch on reconnect).
    var onReconnect: (() -> Void)?
    /// Emitted on every state transition (drives the store's degraded flag).
    var onState: ((MantaConnectionState) -> Void)?
    /// Delivers one parsed frame string to the consumer.
    var onMessage: ((String) -> Void)?
    /// Called once when `url()` yields nothing usable (no server configured).
    var onConfigError: ((Error) -> Void)?
    /// Delivers a frame the socket already parsed off the main actor. While nil the socket hands over text
    /// through `onMessage` (the controller's original contract).
    var onFrame: ((MantaStreamFrame) -> Void)?

    private let url: () -> URL?
    private let makeSocket: (URL) -> any MantaWebSocketSession
    private let backoff: ExponentialBackoff
    private let maxTotalWindowMs: Double
    private let scheduler: any MantaScheduler
    /// True (the original behaviour) → the reconnect window applies always. False → the app keeps trying for as
    /// long as it is in the foreground and the window (the give-up) applies only in the background.
    private let windowAppliesInForeground: Bool
    private(set) var inBackground = false

    private var socket: (any MantaWebSocketSession)?
    private var reconnectCancelable: (any MantaCancelable)?
    private var deadlineCancelable: (any MantaCancelable)?
    private var attempt = 0
    private var hadDrop = false

    init(
        url: @escaping @MainActor () -> URL?,
        makeSocket: @escaping @MainActor (URL) -> any MantaWebSocketSession,
        backoff: ExponentialBackoff = ExponentialBackoff(),
        maxTotalWindowMs: Double = 10 * 60_000,
        scheduler: any MantaScheduler = MantaTimerScheduler(),
        windowAppliesInForeground: Bool = true
    ) {
        self.url = url
        self.makeSocket = makeSocket
        self.backoff = backoff
        self.maxTotalWindowMs = maxTotalWindowMs
        self.scheduler = scheduler
        self.windowAppliesInForeground = windowAppliesInForeground
    }

    /// The app moved to / from the background. Only in the background does the reconnect window (the give-up)
    /// apply (when configured that way): entering it starts the clock for a stream that is down; returning stops it.
    func setBackground(_ background: Bool) {
        guard inBackground != background else { return }
        inBackground = background
        if windowAppliesInForeground { return }
        if background {
            if _state.name != "connected", _state.name != "closed", reconnectCancelable != nil || _state.name == "connecting" {
                armDeadline()
            }
        } else {
            deadlineCancelable?.cancel()
            deadlineCancelable = nil
        }
    }

    /// Send a text message to the box over the live socket. Dropped (and repaired by the next connect, which
    /// re-sends the subscription) while no socket is open.
    func send(_ text: String) {
        guard let socket, socket.isOpen else { return }
        socket.send(text)
    }

    var currentState: MantaConnectionState { _state }
    private var _state: MantaConnectionState = .idle

    /// True once the stream has had at least one healthy connect. The store
    /// uses this to distinguish "fresh connecting" (not degraded) from "was up
    /// and dropped" (degraded).
    var hasConnectedOnce = false

    /// Ensure a live socket. Idempotent when already live.
    func ensure() {
        if let socket, socket.isOpen {
            return
        }
        open()
    }

    /// Unconditional restart (liveness watchdog / app foreground resume):
    /// mark the next open as a reconnect (so onReconnect fires) and reopen now.
    func forceReconnect() {
        hadDrop = true
        attempt = 0
        open()
    }

    func markReconnectAndEnsure() {
        hadDrop = true
        ensure()
    }

    func retryNow() {
        attempt = 0
        reconnectCancelable?.cancel()
        reconnectCancelable = nil
        deadlineCancelable?.cancel()
        deadlineCancelable = nil
        hadDrop = true
        open()
        if maxTotalWindowMs > 0, deadlineCancelable == nil,
           !(_state.name == "connected" || _state.name == "closed") {
            armDeadline()
        }
    }

    func close(reason: String) {
        reconnectCancelable?.cancel()
        reconnectCancelable = nil
        deadlineCancelable?.cancel()
        deadlineCancelable = nil
        socket?.close()
        socket = nil
        transition(.closed(reason: reason))
    }

    // MARK: - Socket callbacks

    private func socketDidOpen(_ sock: any MantaWebSocketSession) {
        guard sock === self.socket else { return }
        attempt = 0
        hasConnectedOnce = true
        deadlineCancelable?.cancel()
        deadlineCancelable = nil
        transition(.connected)
        if hadDrop {
            hadDrop = false
            onReconnect?()
        }
    }

    private func socketDidReceive(_ sock: any MantaWebSocketSession, text: String) {
        guard sock === self.socket else { return }
        onMessage?(text)
    }

    private func socketDidReceive(_ sock: any MantaWebSocketSession, frame: MantaStreamFrame) {
        guard sock === self.socket else { return }
        onFrame?(frame)
    }

    private func socketDidDrop(_ sock: any MantaWebSocketSession) {
        guard sock === self.socket else { return }
        drop()
    }

    // MARK: - Internal

    private func open() {
        reconnectCancelable?.cancel()
        reconnectCancelable = nil
        socket?.close()
        socket = nil

        guard let url = url() else {
            onConfigError?(MantaError.transport("no server configured"))
            transition(.closed(reason: "no server configured"))
            return
        }
        transition(.connecting(attempt: attempt))
        let sock = makeSocket(url)
        sock.onOpen = { [weak self, weak sock] in
            guard let self, let sock else { return }
            self.socketDidOpen(sock)
        }
        sock.onMessage = { [weak self, weak sock] text in
            guard let self, let sock else { return }
            self.socketDidReceive(sock, text: text)
        }
        if onFrame != nil {
            sock.onFrame = { [weak self, weak sock] frame in
                guard let self, let sock else { return }
                self.socketDidReceive(sock, frame: frame)
            }
        }
        sock.onDrop = { [weak self, weak sock] in
            guard let self, let sock else { return }
            self.socketDidDrop(sock)
        }
        self.socket = sock
        sock.connect(to: url)
    }

    private func drop() {
        guard self.socket != nil, reconnectCancelable == nil else { return }
        // A drop means the next successful open is a *reconnect* (→ onReconnect
        // → re-fetch), matching the reference controller.
        hadDrop = true
        let delay = backoff.delayMs(forAttempt: attempt)
        attempt += 1
        transition(.reconnecting(attempt: attempt, backoffMs: delay))
        reconnectCancelable = scheduler.schedule(after: delay) { [weak self] in
            guard let self else { return }
            self.reconnectCancelable = nil
            self.open()
        }
        if maxTotalWindowMs > 0 {
            armDeadline()
        }
    }

    private func armDeadline() {
        guard deadlineCancelable == nil, maxTotalWindowMs > 0, windowAppliesInForeground || inBackground else { return }
        deadlineCancelable = scheduler.schedule(after: maxTotalWindowMs) { [weak self] in
            guard let self else { return }
            self.deadlineCancelable = nil
            if self._state.name != "connected" {
                self.close(reason: "reconnect window exceeded")
            }
        }
    }

    private func transition(_ next: MantaConnectionState) {
        _state = next
        onState?(next)
    }
}
