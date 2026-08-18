import Foundation

// ===========================================================================
// S6 — the native WebSocket to the box's `/pty` (BET-598).
//
// PER §9 the terminal text lives in xterm.js inside a WKWebView, but the
// socket is owned HERE, in native code (URLSessionWebSocketTask), so the
// webview never opens a connection of its own — no mixed-content / origin
// problems, and the Bearer token stays in a header, never in a URL or the
// webview. The page talks to this socket through `TerminalBridge`.
//
// Wire contract (src/server/ptyWs.mjs):
//   client → server: {type:"data",data} | {type:"resize",cols,rows}
//   server → client: raw PTY bytes (binary or UTF-8 text)
//
// This is a transport seam only — no terminal emulation here. Reconnect uses
// capped backoff so "backgrounding and coming back" re-attaches without a
// relaunch (§9.2 "Reattach"); the pty itself is ephemeral server-side, so a
// reconnect respawns the shell but the webview's scrollback survives.
// ===========================================================================

@MainActor
final class TerminalSocket {
    enum State: Equatable, Sendable {
        case idle
        case connecting
        case connected
        case failed(String)
    }

    let serverURL: URL
    let sessionKey: String
    private let cwd: String?
    private let token: String?
    private let urlSession: URLSession

    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var closedByUser = false

    private(set) var state: State = .idle

    /// Live geometry reported to the tank so a reconnect re-populates it.
    private(set) var cols: Int
    private(set) var rows: Int

    let onState: @MainActor (State) -> Void
    let onData: @MainActor (Data) -> Void

    init(serverURL: URL,
         sessionKey: String,
         token: String?,
         cwd: String? = nil,
         cols: Int = 80,
         rows: Int = 24,
         urlSession: URLSession = .shared,
         onState: @escaping @MainActor (State) -> Void,
         onData: @escaping @MainActor (Data) -> Void) {
        self.serverURL = serverURL
        self.sessionKey = sessionKey
        self.token = token
        self.cwd = cwd
        self.cols = clamp(cols, lo: 20, hi: 500)
        self.rows = clamp(rows, lo: 5, hi: 200)
        self.urlSession = urlSession
        self.onState = onState
        self.onData = onData
    }

    // MARK: - Lifecycle

    func connect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        closedByUser = false
        open()
    }

    /// Re-attach immediately (app returned to foreground / after a drop),
    /// without a full teardown.
    func reconnectNow() {
        if task == nil || task?.state != .running {
            open()
        }
    }

    /// Intentionally drop the connection (leaving terminal mode). No reconnect.
    func close() {
        closedByUser = true
        reconnectTask?.cancel()
        receiveLoop?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .idle
        onState(.idle)
    }

    // MARK: - Sends

    /// Sends shell input bytes (JSON `data` control frame carrying them).
    func sendInput(_ text: String) {
        guard task?.state == .running else { return }
        let frame = TerminalFrame.data(text)
        task?.send(.data(frame)) { [weak self] error in
            if let error {
                Task { @MainActor in self?.handleTransportFailure(error) }
            }
        }
    }

    func resize(cols: Int, rows: Int) {
        self.cols = clamp(cols, lo: 20, hi: 500)
        self.rows = clamp(rows, lo: 5, hi: 200)
        guard task?.state == .running else { return }
        let frame = TerminalFrame.resize(cols: self.cols, rows: self.rows)
        task?.send(.data(frame)) { _ in }
    }

    // MARK: - Internals

    private func open() {
        guard let url = TerminalURLBuilder.ptyURL(serverURL: serverURL, sessionKey: sessionKey, cols: cols, rows: rows, cwd: cwd) else {
            fail("could not build pty URL")
            return
        }
        var request = URLRequest(url: url)
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        state = .connecting
        onState(.connecting)
        let newTask = urlSession.webSocketTask(with: request)
        task = newTask
        newTask.resume()
        startReceiveLoop()
    }

    private func startReceiveLoop() {
        receiveLoop?.cancel()
        let task = self.task
        receiveLoop = Task { [weak self] in
            while !Task.isCancelled, let task, task.state == .running {
                do {
                    let message = try await task.receive()
                    guard !Task.isCancelled else { break }
                    switch message {
                    case .data(let data):
                        self?.handleInbound(data)
                    case .string(let string):
                        self?.handleInbound(Data(string.utf8))
                    @unknown default:
                        break
                    }
                } catch {
                    guard !Task.isCancelled else { break }
                    self?.handleTransportFailure(error)
                    break
                }
            }
        }
    }

    private func handleInbound(_ data: Data) {
        // Server control errors arrive as JSON text; raw PTY bytes pass through.
        if let err = TerminalFrame.controlError(from: data) {
            state = .failed(err)
            onState(.failed(err))
            return
        }
        if state != .connected {
            state = .connected
            onState(.connected)
        }
        onData(data)
    }

    private func handleTransportFailure(_ error: Error) {
        guard !closedByUser else { return }
        task = nil
        receiveLoop?.cancel()
        if reconnectTask == nil {
            scheduleReconnect(delay: 1)
        }
    }

    private func scheduleReconnect(delay: Double) {
        state = .failed("reconnecting")
        onState(.failed("reconnecting"))
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.reconnectTask = nil
            // A fresh failure re-arms via handleTransportFailure, so this
            // re-attempt loop repeats until the user leaves terminal mode.
            self.open()
        }
    }

    private func fail(_ message: String) {
        state = .failed(message)
        onState(.failed(message))
    }
}

private func clamp(_ v: Int, lo: Int, hi: Int) -> Int {
    max(lo, min(hi, v))
}

private extension Data {
    var utf8String: String {
        // Lossy UTF-8 on purpose: pty output arrives chunked mid-sequence, and
        // a failable initialiser would discard whole frames.
        // swiftlint:disable:next optional_data_string_conversion
        String(decoding: self, as: UTF8.self)
    }
}
