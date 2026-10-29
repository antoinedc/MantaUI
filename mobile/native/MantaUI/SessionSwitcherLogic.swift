import Foundation

// ===========================================================================
// WS04 §10 — the quick session switcher's pure logic: an exact port of the
// desktop ⌘K palette's `fuzzySessionScore` (`chatUtils.ts:2038-2065`) and the
// recents list. Foundation-only (D19).
// ===========================================================================

/// One searchable session (a window, with the project that holds it).
struct SessionSwitcherCandidate: Equatable, Sendable {
    /// `"<project>#<windowIndex>"`.
    var key: String
    var project: String
    var windowIndex: Int
    var name: String
}

enum SessionSwitcher {
    /// > 0 when `query` matches `"<session> <workspace>"`, 0 when it doesn't.
    /// A contiguous substring scores `1000 - index` (earlier is higher); an
    /// ordered subsequence scores `100` plus `10` per adjacent hit. An empty
    /// query matches everything at 1.
    static func score(query: String, session: String, workspace: String) -> Int {
        if query.isEmpty { return 1 }
        let q = Array(query.lowercased())
        let hay = Array("\(session) \(workspace)".lowercased())
        if let at = firstIndex(of: q, in: hay) {
            return 1000 - at
        }
        var qi = 0
        var gapBonus = 0
        var lastIdx = -1
        var hi = 0
        while hi < hay.count && qi < q.count {
            if hay[hi] == q[qi] {
                if lastIdx >= 0 && hi == lastIdx + 1 { gapBonus += 10 }
                lastIdx = hi
                qi += 1
            }
            hi += 1
        }
        if qi < q.count { return 0 }
        return 100 + gapBonus
    }

    /// One project's sessions as candidates, most recent activity first (the
    /// Latest-activity list's own ordering: chat windows by `lastActivity`, then
    /// chat windows with no activity known yet, then terminal windows). Empty when
    /// `name` is not among `projects`. Pass the VISIBLE projects, so a background
    /// job's window is never offered.
    static func candidates(
        inProject name: String,
        projects: [MantaProject],
        lastActivity: (_ project: String, _ window: MantaWindow) -> Date?
    ) -> [SessionSwitcherCandidate] {
        guard let project = projects.first(where: { $0.tmuxSession == name }) else { return [] }
        return SessionActivityOrder.flatten([project], lastActivity: lastActivity).map { entry in
            SessionSwitcherCandidate(
                key: SessionRouteLogic.windowKey(project: entry.project, windowIndex: entry.window.index),
                project: entry.project, windowIndex: entry.window.index, name: entry.window.name
            )
        }
    }

    /// Candidates to show for `query`. An empty query lists every candidate,
    /// most recently opened first (`recents` front = newest), never-opened ones
    /// after in list order. A typed query keeps only matches, best score first
    /// (ties keep list order).
    static func results(candidates: [SessionSwitcherCandidate], query: String, recents: [String]) -> [SessionSwitcherCandidate] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            let rank = Dictionary(recents.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
            return candidates.enumerated().sorted { l, r in
                switch (rank[l.element.key], rank[r.element.key]) {
                case let (a?, b?): return a < b
                case (_?, nil): return true
                case (nil, _?): return false
                case (nil, nil): return l.offset < r.offset
                }
            }.map(\.element)
        }
        let scored = candidates.enumerated().compactMap { offset, c -> (Int, Int, SessionSwitcherCandidate)? in
            let s = score(query: trimmed, session: c.name, workspace: c.project)
            return s > 0 ? (s, offset, c) : nil
        }
        return scored.sorted { l, r in
            if l.0 != r.0 { return l.0 > r.0 }
            return l.1 < r.1
        }.map { $0.2 }
    }

    private static func firstIndex(of needle: [Character], in hay: [Character]) -> Int? {
        guard !needle.isEmpty, needle.count <= hay.count else { return needle.isEmpty ? 0 : nil }
        var start = 0
        while start + needle.count <= hay.count {
            if Array(hay[start..<(start + needle.count)]) == needle { return start }
            start += 1
        }
        return nil
    }
}

enum SessionRecents {
    /// Desktop `recentWindows` is capped at 64.
    static let cap = 64

    /// `key` to the front, de-duplicated, capped.
    static func push(_ key: String, into list: [String]) -> [String] {
        var next = list.filter { $0 != key }
        next.insert(key, at: 0)
        if next.count > cap { next.removeLast(next.count - cap) }
        return next
    }
}
