import Foundation

// ===========================================================================
// WS04 §2 — the per-session mode (chat / terminal / installed AI CLI) as PURE
// logic. Foundation-only (D19): plain ids in, plain values out, so the
// decisions that kept breaking on desktop (a CLI that is "gone" because the
// check failed, a reconnect that relaunches a plain shell) are unit-testable.
//
// The raw form is desktop-identical — `"chat" | "terminal" | "tui:<launcherId>"`
// under the key `manta:session:<sid>:mode` (`chatShared.tsx:422-457`). It is
// per DEVICE, never synced.
// ===========================================================================

enum SessionMode: Hashable, Sendable {
    case chat
    case terminal
    case cli(launcherID: String)

    /// `"chat"` | `"terminal"` | `"tui:<id>"`.
    var raw: String {
        switch self {
        case .chat: return "chat"
        case .terminal: return "terminal"
        case .cli(let id): return "tui:\(id)"
        }
    }

    /// Parse only: nil, empty, an empty launcher id or anything unrecognised is
    /// chat — the desktop default.
    init(raw: String?) {
        guard let raw else { self = .chat; return }
        if raw == "terminal" { self = .terminal; return }
        if raw.hasPrefix("tui:") {
            let id = String(raw.dropFirst(4))
            self = id.isEmpty ? .chat : .cli(launcherID: id)
            return
        }
        self = .chat
    }
}

/// What the app knows about which AI CLIs are installed on the box.
enum SessionLauncherCatalog: Equatable, Sendable {
    /// Never loaded on this launch.
    case loading
    /// The last SUCCESSFUL `launchers:list` — authoritative.
    case loaded(ids: [String])
    /// The last attempt failed. `lastGood` is the previous successful list, if any.
    case failed(message: String, lastGood: [String]?)

    /// The ids a downgrade decision may be based on; nil = unknown.
    var authoritativeIDs: [String]? {
        switch self {
        case .loading: return nil
        case .loaded(let ids): return ids
        case .failed(_, let lastGood): return lastGood
        }
    }
}

enum SessionModeResolution: Equatable, Sendable {
    case ready(SessionMode)
    /// A saved CLI whose installation can't be confirmed yet — don't guess.
    case waiting(launcherID: String)

    /// chat / terminal are always ready. A saved CLI is kept when the
    /// authoritative list names it, downgraded to chat ONLY when an
    /// authoritative list lacks it, and otherwise waits. A network failure
    /// therefore never silently becomes "chat".
    static func resolve(saved: SessionMode, catalog: SessionLauncherCatalog) -> SessionModeResolution {
        guard case .cli(let id) = saved else { return .ready(saved) }
        guard let ids = catalog.authoritativeIDs else { return .waiting(launcherID: id) }
        return ids.contains(id) ? .ready(saved) : .ready(.chat)
    }
}

/// The device-local saved mode. A downgrade never rewrites it — a later
/// authoritative list that contains the CLI again restores it (desktop also
/// leaves localStorage alone).
enum SessionModeStore {
    static func key(sessionID: String) -> String { "manta:session:\(sessionID):mode" }

    static func read(sessionID: String, defaults: UserDefaults = .standard) -> SessionMode {
        SessionMode(raw: defaults.string(forKey: key(sessionID: sessionID)))
    }

    static func write(_ mode: SessionMode, sessionID: String, defaults: UserDefaults = .standard) {
        defaults.set(mode.raw, forKey: key(sessionID: sessionID))
    }
}

/// The `/pty` session key. A reconnect with the same key and launcher
/// re-launches the same CLI (the pty itself is ephemeral server-side).
enum SessionPtyKey {
    /// `.terminal` (and `.chat`, which only reaches a terminal as the plain
    /// "Open terminal" path) keep today's `"<project>:<index>"`; a CLI gets its
    /// own key so it can never reattach to a shell's pty.
    static func key(project: String, windowIndex: Int, mode: SessionMode) -> String {
        switch mode {
        case .chat, .terminal: return "\(project):\(windowIndex)"
        case .cli(let id): return "\(project):\(windowIndex):tui:\(id)"
        }
    }
}

/// The `launcher` query value `/pty` reads: `{id}` (the box applies the saved launch
/// options) or `{id, flags}` when explicit flags are given.
struct SessionPtyLauncher: Equatable, Sendable {
    var id: String
    var flags: [String: Bool]?

    init(id: String, flags: [String: Bool]? = nil) {
        self.id = id
        self.flags = flags
    }

    /// Compact JSON with sorted keys, so the same launcher always produces the
    /// same URL: `{"id":"…"}` or `{"flags":{…},"id":"…"}`.
    var queryJSON: String {
        var object: [String: Any] = ["id": id]
        if let flags { object["flags"] = flags }
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return "{\"id\":\"\(id)\"}"
        }
        return text
    }
}
