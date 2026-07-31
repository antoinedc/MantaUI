import SwiftUI

// Hardcoded sample data for the visual reference. No networking, no state.

enum SessionStatus {
    case running
    case needsAttention
    case idle

    var dotColor: (Tokens) -> Color {
        switch self {
        case .running: return { $0.accent }
        case .needsAttention: return { $0.warn }
        case .idle: return { $0.tx4 }
        }
    }

    // "running" vs "idle" word for the chat header line 2.
    func word() -> String {
        switch self {
        case .running: return "running"
        case .needsAttention: return "needs you"
        case .idle: return "idle"
        }
    }
}

struct Session: Identifiable {
    let id: Int
    let name: String
    let project: String
    let status: SessionStatus
    // Subtitle rendered only when non-nil (e.g. "running - opus 4.8", or "needs you").
    let subtitle: String?
    // Time since last activity, formatted like formatDuration ("2m", "1h 05m").
    let timer: String
    // Whether this is the most recently active row (gets fill background).
    let mostRecent: Bool

    // Chat transcript for this session.
    let messages: [Message]
}

enum MessageParts {
    case user(String)
    case assistant(String)
    case tool(name: String, running: Bool)
}

struct Message: Identifiable {
    let id: Int
    let parts: MessageParts
}

enum Sample {
    static let sessions: [Session] = [
        Session(
            id: 1, name: "API Gateway", project: "Alpha", status: .running,
            subtitle: "running - opus 4.8", timer: "1m", mostRecent: true,
            messages: ChatSample.apiGateway
        ),
        Session(
            id: 2, name: "Database", project: "Alpha", status: .idle,
            subtitle: nil, timer: "3h 12m", mostRecent: false,
            messages: ChatSample.apiGateway
        ),
        Session(
            id: 3, name: "Mobile Client", project: "Beta", status: .needsAttention,
            subtitle: "needs you", timer: "24m", mostRecent: false,
            messages: ChatSample.apiGateway
        ),
        Session(
            id: 4, name: "Docs", project: "Beta", status: .idle,
            subtitle: nil, timer: "1d", mostRecent: false,
            messages: ChatSample.apiGateway
        ),
        Session(
            id: 5, name: "Infra", project: "Gamma", status: .idle,
            subtitle: nil, timer: "2h 40m", mostRecent: false,
            messages: ChatSample.apiGateway
        ),
        Session(
            id: 6, name: "Analytics", project: "Gamma", status: .idle,
            subtitle: nil, timer: "5h 03m", mostRecent: false,
            messages: ChatSample.apiGateway
        ),
    ]

    // Grouped by project name, preserving session order within each project.
    static let groups: [(project: String, sessions: [Session])] = {
        let ordered = sessions
        var out: [(String, [Session])] = []
        var seen = Set<String>()
        for s in ordered {
            if seen.insert(s.project).inserted {
                out.append((s.project, ordered.filter { $0.project == s.project }))
            }
        }
        return out
    }()
}

enum ChatSample {
    // 2 user, 3 assistant, 2 tool rows (one still running).
    static let apiGateway: [Message] = [
        Message(id: 1, parts: .assistant(
            "I've finished the refactor of the request routing layer. The new auth middleware is now wired in front of the project list endpoint."
        )),
        Message(id: 2, parts: .tool(name: "apply_patch", running: false)),
        Message(id: 3, parts: .assistant(
            "Let me start a fresh migration to move the sessions table onto the new index. This is the biggest remaining piece before the deploy."
        )),
        Message(id: 4, parts: .tool(name: "bash", running: true)),
        Message(id: 5, parts: .user(
            "Shut the migration down and restore from the last backup before we go further."
        )),
        Message(id: 6, parts: .assistant(
            "Rolling the migration back now. I'm restoring the sessions table from the snapshot taken at 09:14 and will confirm the index is back to the previous shape."
        )),
        Message(id: 7, parts: .user(
            "Good. Keep me posted once the restore completes."
        )),
        Message(id: 8, parts: .assistant(
            "Restore complete. The sessions table is back on the previous index and all queries are running against it again."
        )),
    ]
}