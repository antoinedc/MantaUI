import Foundation

// ===========================================================================
// Session tree, stage (b) — iOS half (docs/superpowers/specs/2026-11-05-session-tree.md §3, §4, §10).
//
// The box now sends each project's rows as a TREE over the session graph (`tmux:list` →
// `projects[].tree`): roots in display order, each with its descendants. A root is either a window row (it has a
// tmux window) or a VIRTUAL row (a shown session with no window — an API-driven session, a subagent). This file holds
// the Codable shapes and the PURE decisions the list makes from them; the store and the view only wire them up.
//
//   - `tree` is OPTIONAL and decoded tolerantly: an older box omits it and the list behaves exactly as before
//     (`windows[]` + `job.parentWindowIndex`); one malformed node is skipped, never the whole list.
//   - The rows come from the tree's ROOTS. Descendants stay hidden (a root's "N background jobs" count carries them).
//   - Tapping a virtual row asks the box to make its window (`sessions:materialize`).
//
// Foundation-only on purpose (it is part of the headless Package.swift view).
// ===========================================================================

// MARK: - Wire: tmux:list `tree`

/// The background-job fact on a tree node (`tree[].job`).
struct SessionTreeJob: Codable, Equatable, Sendable {
    var id: String
    var status: String
    var origin: String?

    /// Still live: `done`/`failed`/`stopped` are terminal, anything else (incl. a status a newer box adds) counts.
    var isActive: Bool { status != "done" && status != "failed" && status != "stopped" }
}

/// One row of the session tree. `children` are descendants at any depth, already in display order.
struct SessionTreeNode: Codable, Equatable, Sendable, Identifiable {
    /// Stable row identity: the conversation key, or `window:<project>:<index>` for a terminal / duplicate window.
    var key: String
    /// The conversation's canonical session id; nil for a terminal window.
    var sessionId: String?
    /// `"window"` or `"virtual"`; a kind a newer box adds is handled by the rows logic, not rejected here.
    var kind: String
    var windowIndex: Int?
    var title: String
    var job: SessionTreeJob?
    /// A root with no window and no known parent: work driven from outside Manta.
    var outside: Bool
    var children: [SessionTreeNode]

    static let virtualKind = "virtual"

    var id: String { key }
    var isVirtual: Bool { kind == Self.virtualKind }

    init(
        key: String, sessionId: String? = nil, kind: String = "window", windowIndex: Int? = nil, title: String = "",
        job: SessionTreeJob? = nil, outside: Bool = false, children: [SessionTreeNode] = []
    ) {
        self.key = key
        self.sessionId = sessionId
        self.kind = kind
        self.windowIndex = windowIndex
        self.title = title
        self.job = job
        self.outside = outside
        self.children = children
    }

    fileprivate enum CodingKeys: String, CodingKey {
        case key, sessionId, kind, windowIndex, title, job, outside, children
    }
}

extension SessionTreeNode {
    /// Only `key` is required (it is the row's identity). Every other field is decoded leniently — a field of an
    /// unexpected type becomes its default instead of failing the node — and `children` skips a malformed child.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let key = try c.decode(String.self, forKey: .key)
        guard !key.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .key, in: c, debugDescription: "empty node key")
        }
        self.key = key
        let sid = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? nil
        sessionId = (sid?.isEmpty == false) ? sid : nil
        kind = ((try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil) ?? "window"
        windowIndex = (try? c.decodeIfPresent(Int.self, forKey: .windowIndex)) ?? nil
        title = ((try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil) ?? ""
        job = (try? c.decodeIfPresent(SessionTreeJob.self, forKey: .job)) ?? nil
        outside = ((try? c.decodeIfPresent(Bool.self, forKey: .outside)) ?? nil) ?? false
        children = ((try? c.decodeIfPresent(LenientSessionTree.self, forKey: .children)) ?? nil)?.nodes ?? []
    }
}

/// A list of tree nodes decoded one at a time: a node that will not decode is SKIPPED rather than failing the list
/// (the same step-over technique as `LenientDelegateJobs`). Anything that is not an array decodes to an error, which a
/// caller using `try?` reads as "no tree".
struct LenientSessionTree: Decodable, Sendable {
    let nodes: [SessionTreeNode]

    /// Decodes anything and consumes exactly one element: an unkeyed container's index only advances on a SUCCESSFUL
    /// decode, so a throwing element would otherwise be retried forever.
    private struct Skip: Decodable {}

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var out: [SessionTreeNode] = []
        while !container.isAtEnd {
            if let node = try? container.decode(SessionTreeNode.self) {
                out.append(node)
                continue
            }
            do { _ = try container.decode(Skip.self) } catch { break }
        }
        nodes = out
    }
}

// MARK: - Wire: sessions:materialize

/// `sessions:materialize` → the box made (or found) the window of a virtual row, or refused with a sentence.
/// Never thrown for an expected refusal (`reason`: `handoff` / `no-project` / `not-found` / `failed`; a reason a newer
/// box adds is carried as is).
enum SessionMaterializeResult: Decodable, Equatable, Sendable {
    case opened(project: String, windowIndex: Int, sessionId: String)
    case refused(reason: String, message: String)

    /// What the user reads when the box refused without a sentence, or the call itself failed.
    static let failureMessage = "Couldn't open this session."

    private enum Keys: String, CodingKey { case ok, project, windowIndex, sessionId, reason, message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if try c.decode(Bool.self, forKey: .ok) {
            let project = try c.decode(String.self, forKey: .project)
            let windowIndex = try c.decode(Int.self, forKey: .windowIndex)
            let sessionId = try c.decode(String.self, forKey: .sessionId)
            self = .opened(project: project, windowIndex: windowIndex, sessionId: sessionId)
        } else {
            let reason = ((try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil) ?? "failed"
            let message = ((try? c.decodeIfPresent(String.self, forKey: .message)) ?? nil) ?? ""
            self = .refused(reason: reason, message: message.isEmpty ? Self.failureMessage : message)
        }
    }
}

/// What a tap on a virtual row came to, as the list acts on it.
enum SessionMaterializeOutcome: Equatable, Sendable {
    /// Open this window, as a tap on its window row would.
    case opened(project: String, windowIndex: Int, sessionId: String)
    /// Say this to the user; nothing opens.
    case message(String)
    /// The same row is already being opened — the tap does nothing.
    case ignored
}

// MARK: - Rows

/// A top-level row of a project card: a window, or a virtual row.
struct SessionVirtualRow: Equatable, Sendable, Identifiable {
    /// The tree node key — stable across renders, so it is the row's identity.
    var key: String
    var sessionId: String
    var title: String
    var outside: Bool
    var job: SessionTreeJob?

    var id: String { key }
    var displayTitle: String { title.isEmpty ? "session" : title }
}

enum SessionListRow: Equatable, Sendable, Identifiable {
    case window(MantaWindow)
    case virtual(SessionVirtualRow)

    /// Unique within a project. A window row's id is its index; a virtual row's is its node key.
    var id: String {
        switch self {
        case .window(let w): return "w\(w.index)"
        case .virtual(let v): return "v:\(v.key)"
        }
    }

    /// The window of a window row (a case and a property cannot share the name `window`).
    var asWindow: MantaWindow? {
        if case .window(let w) = self { return w }
        return nil
    }

    var title: String {
        switch self {
        case .window(let w): return w.name
        case .virtual(let v): return v.displayTitle
        }
    }

    /// The opencode session the row stands for; nil for a terminal window.
    var sessionId: String? {
        switch self {
        case .window(let w): return w.hasChatSession ? w.opencodeSessionId : nil
        case .virtual(let v): return v.sessionId
        }
    }
}

/// A project's rows as the list shows them (search, the Recent filter and pins already applied where relevant).
struct SessionProjectRows: Equatable, Sendable, Identifiable {
    var name: String
    var rows: [SessionListRow]

    var id: String { name }
}

/// One descendant of a root, flattened out of the tree: all the count needs of it.
struct SessionTreeDescendant: Equatable, Sendable {
    var sessionId: String?
    var jobActive: Bool
}

enum SessionTreeRows {

    /// The rows a project shows, in order.
    ///
    /// Without a tree (an older box) this is today's list: the windows minus the job windows. With one it is the
    /// tree's ROOTS, verbatim — a window root whose window is gone from `windows` is skipped (nothing to open), a virtual
    /// root without a session id is skipped (nothing to materialise), and a repeated row id is dropped (a duplicate id
    /// in a `ForEach` is a trap). A window the tree never mentions — a malformed node the decoder skipped — is appended
    /// in index order unless the legacy rules hide it, so a decoding slip can never make a session vanish.
    static func rows(for project: MantaProject) -> [SessionListRow] {
        let legacyHidden = SessionJobWindows.hiddenIndices(project: project)
        guard let tree = project.tree else {
            return project.windows.filter { !legacyHidden.contains($0.index) }.map { SessionListRow.window($0) }
        }
        var byIndex: [Int: MantaWindow] = [:]
        for w in project.windows where byIndex[w.index] == nil { byIndex[w.index] = w }
        var mentioned = Set<Int>()
        collectWindowIndices(tree, into: &mentioned)

        var rows: [SessionListRow] = []
        var seen = Set<String>()
        for root in tree {
            let row: SessionListRow
            if root.isVirtual {
                guard let sid = root.sessionId, !sid.isEmpty else { continue }
                row = .virtual(SessionVirtualRow(key: root.key, sessionId: sid, title: root.title, outside: root.outside, job: root.job))
            } else {
                guard let index = root.windowIndex, let window = byIndex[index] else { continue }
                row = .window(window)
            }
            if seen.insert(row.id).inserted { rows.append(row) }
        }
        for w in project.windows.sorted(by: { $0.index < $1.index })
        where !mentioned.contains(w.index) && !legacyHidden.contains(w.index) {
            let row = SessionListRow.window(w)
            if seen.insert(row.id).inserted { rows.append(row) }
        }
        return rows
    }

    /// Whether the project had anything to list at all. A project whose rows are all gone is dropped from the list
    /// (its header would head an empty card); one that never had any is kept as it was.
    static func hadContent(_ project: MantaProject) -> Bool {
        !project.windows.isEmpty || !(project.tree ?? []).isEmpty
    }

    private static func collectWindowIndices(_ nodes: [SessionTreeNode], into set: inout Set<Int>) {
        for node in nodes {
            if let index = node.windowIndex { set.insert(index) }
            collectWindowIndices(node.children, into: &set)
        }
    }

    /// A node's descendants, depth-first pre-order, excluding the node itself.
    static func descendants(of node: SessionTreeNode) -> [SessionTreeDescendant] {
        var out: [SessionTreeDescendant] = []
        for child in node.children {
            out.append(SessionTreeDescendant(sessionId: child.sessionId, jobActive: child.job?.isActive ?? false))
            out.append(contentsOf: descendants(of: child))
        }
        return out
    }

    /// Root session id → its descendants, for a project that has a tree (empty for one that has not). A row repeated
    /// for the same session (a duplicate window carries no children) never replaces the real one's descendants.
    static func rootDescendants(project: MantaProject) -> [String: [SessionTreeDescendant]] {
        guard let tree = project.tree else { return [:] }
        var out: [String: [SessionTreeDescendant]] = [:]
        for root in tree {
            guard let sid = root.sessionId, !sid.isEmpty else { continue }
            let found = descendants(of: root)
            if out[sid] == nil || !found.isEmpty { out[sid] = found }
        }
        return out
    }

    /// The "N background jobs" count of a root. The box's own rollup (`windowStatus.subagents`: descendants at any
    /// depth that run or wait on a question/permission — including collapsed ones the tree does not list) wins when it
    /// has reported; otherwise the descendants the tree lists that are a live job or whose own turn is running.
    static func backgroundCount(
        descendants: [SessionTreeDescendant], reported: Int?, isRunning: (String) -> Bool
    ) -> Int {
        if let reported { return max(0, reported) }
        return descendants.filter { d in
            d.jobActive || (d.sessionId.map(isRunning) ?? false)
        }.count
    }
}

// MARK: - Subtitle for a virtual row

extension SessionRowSubtitle {
    /// The marker a root with no window carries (the desktop's "started outside Manta").
    static let outsideMarker = "started outside Manta"

    /// A virtual row's subtitle: the project caption (flat ordering only), the outside marker, then the usual line.
    static func virtualText(for s: SessionRowStatus, outside: Bool, projectName: String?) -> String? {
        var parts: [String] = []
        if let projectName, !projectName.isEmpty { parts.append(projectName) }
        if outside { parts.append(outsideMarker) }
        if let base = text(for: s), !base.isEmpty { parts.append(base) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// MARK: - Search / recency / pins / activity over rows

enum SessionRowsLogic {

    /// The name search. A project-name match keeps the whole group; otherwise only the rows whose title matches, and a
    /// group left with none is dropped. An empty query is an exact no-op.
    static func search(_ projects: [SessionProjectRows], query: String) -> [SessionProjectRows] {
        guard !query.isEmpty else { return projects }
        let q = query.lowercased()
        return projects.compactMap { p -> SessionProjectRows? in
            if p.name.lowercased().contains(q) { return p }
            let kept = p.rows.filter { $0.title.lowercased().contains(q) }
            guard !kept.isEmpty else { return nil }
            return SessionProjectRows(name: p.name, rows: kept)
        }
    }

    /// Keep the rows `keep` accepts; a group left with none is dropped.
    static func filtered(_ projects: [SessionProjectRows], keep: (SessionListRow) -> Bool) -> [SessionProjectRows] {
        projects.compactMap { p -> SessionProjectRows? in
            let kept = p.rows.filter(keep)
            guard !kept.isEmpty else { return nil }
            return SessionProjectRows(name: p.name, rows: kept)
        }
    }

    /// Pinned windows first, everything else in its existing order — STABLE within each half (two filters, not a sort,
    /// which Swift does not guarantee stable). A virtual row has no pin identity and stays in the second half.
    static func pinnedFirst(_ projects: [SessionProjectRows], pinned: Set<String>) -> [SessionProjectRows] {
        projects.map { p in
            let isPinned = { (row: SessionListRow) -> Bool in
                guard let w = row.asWindow else { return false }
                return pinned.contains(SessionPinID.window(p.name, index: w.index))
            }
            return SessionProjectRows(name: p.name, rows: p.rows.filter(isPinned) + p.rows.filter { !isPinned($0) })
        }
    }

    /// One row of the flat Latest-activity list.
    struct FlatEntry: Equatable, Sendable {
        let project: String
        let row: SessionListRow
    }

    /// Flatten into one list, newest activity first. Three tiers, in this order: rows with a session and a known
    /// activity, newest first; rows with a session and no known activity yet; terminal windows, by window index.
    /// Ties break on project order, then windows before virtual rows, then window index / position in the project.
    /// Every comparator is a TOTAL order, so the result is deterministic and an unstable sort cannot make rows jump.
    static func flatten(
        _ projects: [SessionProjectRows],
        lastActivity: (_ project: String, _ row: SessionListRow) -> Date?
    ) -> [FlatEntry] {
        struct Item {
            let entry: FlatEntry
            let projectOrder: Int
            let rank: Int        // 0 window, 1 virtual
            let ordinal: Int     // window index, or position within the project for a virtual row
            let date: Date?
        }
        var dated: [Item] = []
        var undated: [Item] = []
        var terminals: [Item] = []
        for (projectOrder, project) in projects.enumerated() {
            for (position, row) in project.rows.enumerated() {
                let entry = FlatEntry(project: project.name, row: row)
                switch row {
                case .window(let w):
                    let item = { (date: Date?) in Item(entry: entry, projectOrder: projectOrder, rank: 0, ordinal: w.index, date: date) }
                    if !w.hasChatSession {
                        terminals.append(item(nil))
                    } else if let date = lastActivity(project.name, row) {
                        dated.append(item(date))
                    } else {
                        undated.append(item(nil))
                    }
                case .virtual:
                    let date = lastActivity(project.name, row)
                    let item = Item(entry: entry, projectOrder: projectOrder, rank: 1, ordinal: position, date: date)
                    if date != nil { dated.append(item) } else { undated.append(item) }
                }
            }
        }
        func tieBroken(_ l: Item, _ r: Item) -> Bool {
            if l.projectOrder != r.projectOrder { return l.projectOrder < r.projectOrder }
            if l.rank != r.rank { return l.rank < r.rank }
            return l.ordinal < r.ordinal
        }
        dated.sort { l, r in
            if let ld = l.date, let rd = r.date, ld != rd { return ld > rd }
            return tieBroken(l, r)
        }
        undated.sort(by: tieBroken)
        terminals.sort { l, r in
            if l.ordinal != r.ordinal { return l.ordinal < r.ordinal }
            return l.projectOrder < r.projectOrder
        }
        return (dated + undated + terminals).map(\.entry)
    }
}
