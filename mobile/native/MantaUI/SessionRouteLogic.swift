import Foundation

// ===========================================================================
// WS04 §11 — pure route resolution for `MantaNavigator` (C2). A window key is
// `"<project>#<windowIndex>"`; the project name may itself contain `#`, so the
// key is split on the LAST one. Foundation-only so it runs under `verify.sh`.
// ===========================================================================

/// What a route resolves to. `SessionListView` maps this to its own
/// `SessionOpenTarget`.
struct SessionRouteTarget: Equatable, Sendable {
    var project: String
    var windowIndex: Int
    var name: String
    var sessionId: String?
}

enum SessionRouteLogic {
    static func windowKey(project: String, windowIndex: Int) -> String {
        "\(project)#\(windowIndex)"
    }

    /// Splits on the LAST `#`. A non-numeric (or negative) index, a missing `#`
    /// or an empty project is not a key.
    static func parse(windowKey: String) -> (project: String, windowIndex: Int)? {
        guard let hash = windowKey.lastIndex(of: "#") else { return nil }
        let project = String(windowKey[..<hash])
        let indexText = String(windowKey[windowKey.index(after: hash)...])
        guard !project.isEmpty, let index = Int(indexText), index >= 0 else { return nil }
        return (project, index)
    }

    static func window(forKey key: String, in projects: [MantaProject]) -> SessionRouteTarget? {
        guard let parsed = parse(windowKey: key),
              let project = projects.first(where: { $0.tmuxSession == parsed.project }),
              let window = project.windows.first(where: { $0.index == parsed.windowIndex }) else { return nil }
        return target(project: project.tmuxSession, window: window)
    }

    static func window(forSessionID sessionID: String, in projects: [MantaProject]) -> SessionRouteTarget? {
        guard !sessionID.isEmpty else { return nil }
        for project in projects {
            if let window = project.windows.first(where: { $0.opencodeSessionId == sessionID }) {
                return target(project: project.tmuxSession, window: window)
            }
        }
        return nil
    }

    private static func target(project: String, window: MantaWindow) -> SessionRouteTarget {
        SessionRouteTarget(project: project, windowIndex: window.index, name: window.name, sessionId: window.opencodeSessionId)
    }
}
