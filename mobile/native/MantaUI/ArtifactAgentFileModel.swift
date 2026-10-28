import Foundation

// ===========================================================================
// WS07 F6 — the agent-sent file notice, pure half.
//
// `send_file` with `notify:true` makes the box publish ONE `agentFile` bus event
// per file (the announce decision is already server-side). The phone shows a
// notice with Save / Share. Everything race-prone lives HERE as a value-type
// state machine so it is deterministic and unit-testable without UIKit:
// every notice carries a monotonic `token`, every asynchronous operation
// captures the `(token, opID)` it started with, and every completion is a no-op
// unless BOTH still match. A staged temp file belongs to exactly one place at a
// time (the download result → the phase → an effect), and every path that drops
// one returns `.deleteTemp(url)` for the store to execute.
// ===========================================================================

struct AgentFileEvent: Equatable, Sendable {
    var remotePath: String
    var name: String
    var size: Int
    /// The opencode session id (the wire calls it `sessionName`), nil for a root-level file.
    var sessionID: String?
    var autoPulled: Bool

    private struct Payload: Decodable {
        var remotePath: String?
        var name: String?
        var size: Double?
        var sessionName: String?
        var autoPulled: Bool?
    }

    /// `{"kind":"agentFile","payload":{remotePath,name,size,sessionName,autoPulled}}`.
    /// nil for any other kind, an undecodable payload, or a missing/empty `remotePath`.
    static func from(_ frame: MantaStreamFrame) -> AgentFileEvent? {
        guard frame.kind == "agentFile" else { return nil }
        let decoded: Payload?
        do {
            decoded = try frame.decodedPayload(Payload.self)
        } catch {
            return nil
        }
        guard let p = decoded, let path = p.remotePath, !path.isEmpty else { return nil }
        let name = (p.name?.isEmpty == false) ? (p.name ?? "") : (path as NSString).lastPathComponent
        let session = (p.sessionName?.isEmpty == false) ? p.sessionName : nil
        return AgentFileEvent(remotePath: path, name: name, size: Int(p.size ?? 0),
                              sessionID: session, autoPulled: p.autoPulled ?? false)
    }
}

enum AgentFileNoticeCopy {
    static func title(_ event: AgentFileEvent) -> String { event.name }

    /// `"62 KB · AI sent you a file"` (size omitted when 0), plus `" · in <title>"`.
    static func detail(_ event: AgentFileEvent, sessionTitle: String?) -> String {
        var parts: [String] = []
        if event.size > 0, let size = ArtifactFormat.byteCount(event.size) { parts.append(size) }
        parts.append("AI sent you a file")
        if let sessionTitle, !sessionTitle.isEmpty { parts.append("in \(sessionTitle)") }
        return parts.joined(separator: " · ")
    }

    static func savedTitle(_ event: AgentFileEvent) -> String { "Saved \(event.name)" }

    static func failure(_ event: AgentFileEvent) -> String {
        "Couldn't download \(event.name) — it's still on the box, try again."
    }

    /// `"+1 more"`, nil for 0.
    static func pendingBadge(_ count: Int) -> String? {
        count > 0 ? "+\(count) more" : nil
    }
}

enum AgentFileFailure: Error, Equatable, Sendable {
    case download   // the box refused / the network failed
    case write      // the staged copy couldn't be written
}

struct AgentFileNotice: Equatable, Sendable {
    let token: UInt64
    let event: AgentFileEvent
    var phase: Phase

    enum Op: Equatable, Sendable { case save, share }

    enum Phase: Equatable, Sendable {
        case idle
        case downloading(Op, opID: UInt64)
        case presenting(Op, opID: UInt64, fileURL: URL)   // exporter / share sheet is up
        case saved(opID: UInt64, fileURL: URL)            // confirmation; file kept until close
        case failed(String)
    }
}

/// What the store must do after a machine call. The machine never touches the disk.
enum AgentFileEffect: Equatable, Sendable {
    case none
    case deleteTemp(URL)
    case scheduleSavedTimer(token: UInt64, opID: UInt64)
}

struct AgentFileNoticeMachine: Equatable, Sendable {
    /// Arrivals beyond this many waiting are dropped oldest-first (every file is
    /// still listed in the Artifacts card).
    static let queueCap = 5

    private(set) var current: AgentFileNotice?
    private(set) var queued: [AgentFileEvent] = []
    private var tokenCounter: UInt64 = 0
    private var opCounter: UInt64 = 0

    init() {}

    // MARK: Arrival

    mutating func receive(_ event: AgentFileEvent) {
        if current?.event.remotePath == event.remotePath { return }
        if queued.contains(where: { $0.remotePath == event.remotePath }) { return }
        guard let existing = current else {
            current = makeNotice(event)
            return
        }
        switch existing.phase {
        case .idle, .failed:
            // Newest wins; an idle/failed notice owns no temp file.
            current = makeNotice(event)
        case .downloading, .presenting, .saved:
            // Never replace a notice whose operation is in flight.
            queued.append(event)
            while queued.count > Self.queueCap { queued.removeFirst() }
        }
    }

    // MARK: Operations

    /// nil = refused (a notice that is not idle/failed cannot start another operation).
    mutating func begin(_ op: AgentFileNotice.Op) -> (token: UInt64, opID: UInt64)? {
        guard var notice = current else { return nil }
        switch notice.phase {
        case .idle, .failed: break
        default: return nil
        }
        opCounter += 1
        notice.phase = .downloading(op, opID: opCounter)
        current = notice
        return (notice.token, opCounter)
    }

    mutating func downloadFinished(token: UInt64, opID: UInt64, result: Result<URL, AgentFileFailure>) -> AgentFileEffect {
        guard var notice = current, notice.token == token,
              case .downloading(let op, let runningID) = notice.phase, runningID == opID else {
            // The notice was dismissed or replaced: a late success owns a temp file nobody wants.
            if case .success(let url) = result { return .deleteTemp(url) }
            return .none
        }
        switch result {
        case .failure:
            notice.phase = .failed(AgentFileNoticeCopy.failure(notice.event))
        case .success(let url):
            notice.phase = .presenting(op, opID: opID, fileURL: url)
        }
        current = notice
        return .none
    }

    /// The exporter / share sheet finished. `fileURL` is what the per-presentation
    /// delegate captured, so a stale callback can still clean up its own file.
    mutating func presentationFinished(token: UInt64, opID: UInt64, fileURL: URL, completed: Bool) -> AgentFileEffect {
        guard var notice = current, notice.token == token,
              case .presenting(let op, let runningID, _) = notice.phase, runningID == opID else {
            return .deleteTemp(fileURL)
        }
        if !completed {
            notice.phase = .idle
            current = notice
            return .deleteTemp(fileURL)
        }
        switch op {
        case .save:
            notice.phase = .saved(opID: opID, fileURL: fileURL)
            current = notice
            return .scheduleSavedTimer(token: token, opID: opID)
        case .share:
            closeCurrent()
            return .deleteTemp(fileURL)
        }
    }

    mutating func savedTimerFired(token: UInt64, opID: UInt64) -> AgentFileEffect {
        guard let notice = current, notice.token == token,
              case .saved(let savedID, let url) = notice.phase, savedID == opID else { return .none }
        closeCurrent()
        return .deleteTemp(url)
    }

    /// The × button. Refused while the picker / share sheet is up (its delegate owns the file).
    mutating func dismiss() -> AgentFileEffect {
        guard let notice = current else { return .none }
        if case .presenting = notice.phase { return .none }
        closeCurrent()
        if case .saved(_, let url) = notice.phase { return .deleteTemp(url) }
        return .none
    }

    // MARK: Helpers

    private mutating func makeNotice(_ event: AgentFileEvent) -> AgentFileNotice {
        tokenCounter += 1
        return AgentFileNotice(token: tokenCounter, event: event, phase: .idle)
    }

    /// Clear the current notice and promote the oldest queued event.
    private mutating func closeCurrent() {
        current = nil
        if !queued.isEmpty {
            current = makeNotice(queued.removeFirst())
        }
    }
}
