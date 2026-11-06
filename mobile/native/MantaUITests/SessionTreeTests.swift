import XCTest
@testable import MantaUI

// Foundation-only on purpose (no SwiftUI, no stores): the pure decisions behind the session tree on iOS — decoding
// `tmux:list`'s optional `tree`, the rows made from its roots, the "N background jobs" count, the virtual row's
// subtitle, the search / Recent / pin / Latest-activity logic over rows, and the `sessions:materialize` answer.
// The store wiring (tap → materialize → open, double-tap guard) is in SessionTreeStoreTests (needs a Mac).

final class SessionTreeTests: XCTestCase {

    // MARK: - Fixtures

    private func win(_ index: Int, sid: String? = nil, owner: String? = nil, name: String? = nil) -> MantaWindow {
        MantaWindow(index: index, name: name ?? "w\(index)", active: false, paneCurrentPath: "/p",
                    opencodeSessionId: sid, worktreePath: nil, owner: owner)
    }

    private func proj(_ name: String, _ windows: [MantaWindow], tree: [SessionTreeNode]? = nil) -> MantaProject {
        MantaProject(tmuxSession: name, defaultCwd: "/p", windows: windows, attached: false, mantaOwned: nil, tree: tree)
    }

    private func windowNode(_ index: Int, sid: String? = nil, children: [SessionTreeNode] = []) -> SessionTreeNode {
        SessionTreeNode(key: sid ?? "window:p:\(index)", sessionId: sid, kind: "window", windowIndex: index,
                        title: "w\(index)", children: children)
    }

    private func virtualNode(_ sid: String, title: String = "", outside: Bool = false,
                             job: SessionTreeJob? = nil, children: [SessionTreeNode] = []) -> SessionTreeNode {
        SessionTreeNode(key: sid, sessionId: sid, kind: "virtual", windowIndex: nil, title: title,
                        job: job, outside: outside, children: children)
    }

    private func ids(_ rows: [SessionListRow]) -> [String] { rows.map(\.id) }

    private func decodeProjects(_ json: String) throws -> [MantaProject] {
        try JSONDecoder().decode([MantaProject].self, from: Data(json.utf8))
    }

    private func date(_ seconds: Double) -> Date { Date(timeIntervalSince1970: seconds) }

    // MARK: - Decoding: `tree` is optional

    private let windowJSON = #"{"index":0,"name":"a","active":false,"paneCurrentPath":"/p","opencodeSessionId":"ses_a"}"#

    func testProjectWithoutTreeDecodesAsBefore() throws {
        let projects = try decodeProjects(#"[{"tmuxSession":"p","defaultCwd":"/p","windows":[\#(windowJSON)],"attached":false}]"#)
        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects[0].windows.map(\.index), [0])
        XCTAssertNil(projects[0].tree)
        XCTAssertNil(projects[0].mantaOwned)
    }

    func testProjectWithTreeDecodesEveryField() throws {
        let json = #"""
        [{"tmuxSession":"p","defaultCwd":"/p","windows":[\#(windowJSON)],"attached":true,"mantaOwned":true,"tree":[
          {"key":"ses_a","sessionId":"ses_a","kind":"window","windowIndex":0,"title":"a","job":null,"outside":false,
           "children":[{"key":"ses_c","sessionId":"ses_c","kind":"virtual","windowIndex":null,"title":"sub",
                        "job":{"id":"j1","status":"running","origin":"delegate"},"outside":false,"children":[]}]},
          {"key":"ses_v","sessionId":"ses_v","kind":"virtual","windowIndex":null,"title":"driver","job":null,"outside":true,"children":[]}
        ]}]
        """#
        let p = try decodeProjects(json)[0]
        XCTAssertEqual(p.mantaOwned, true)
        let tree = try XCTUnwrap(p.tree)
        XCTAssertEqual(tree.map(\.key), ["ses_a", "ses_v"])
        XCTAssertEqual(tree[0].kind, "window")
        XCTAssertEqual(tree[0].windowIndex, 0)
        XCTAssertFalse(tree[0].isVirtual)
        XCTAssertEqual(tree[0].children.map(\.key), ["ses_c"])
        XCTAssertEqual(tree[0].children[0].job, SessionTreeJob(id: "j1", status: "running", origin: "delegate"))
        XCTAssertTrue(tree[1].isVirtual)
        XCTAssertTrue(tree[1].outside)
        XCTAssertEqual(tree[1].title, "driver")
        XCTAssertNil(tree[1].windowIndex)
    }

    func testAMalformedNodeIsSkippedNotTheWholeList() throws {
        // A child with no key, a non-object, a null, an empty key and a non-string key are junk; the good nodes on
        // either side — and the good child of the first — survive, in order.
        let json = #"""
        [{"tmuxSession":"p","defaultCwd":"/p","windows":[\#(windowJSON)],"attached":false,"tree":[
          {"key":"a","kind":"window","windowIndex":0,"children":[{"kind":"virtual"},{"key":"c1","sessionId":"ses_c","kind":"virtual"}]},
          "junk",
          null,
          {"key":""},
          {"key":7},
          {"key":"v","sessionId":"ses_v","kind":"virtual","title":"V","outside":true}
        ]}]
        """#
        let p = try decodeProjects(json)[0]
        XCTAssertEqual(p.windows.count, 1, "the project and its windows are intact")
        let tree = try XCTUnwrap(p.tree)
        XCTAssertEqual(tree.map(\.key), ["a", "v"])
        XCTAssertEqual(tree[0].children.map(\.key), ["c1"])
    }

    func testAFieldOfTheWrongTypeCostsTheFieldNotTheNode() throws {
        let json = #"""
        [{"tmuxSession":"p","defaultCwd":"/p","windows":[],"attached":false,"tree":[
          {"key":"k","kind":5,"windowIndex":"x","title":{},"job":{"id":1},"outside":"yes","children":"nope","sessionId":9}
        ]}]
        """#
        let node = try XCTUnwrap(try decodeProjects(json)[0].tree).first
        XCTAssertEqual(node?.key, "k")
        XCTAssertEqual(node?.kind, "window")
        XCTAssertNil(node?.windowIndex)
        XCTAssertEqual(node?.title, "")
        XCTAssertNil(node?.job)
        XCTAssertEqual(node?.outside, false)
        XCTAssertEqual(node?.children, [])
        XCTAssertNil(node?.sessionId)
    }

    func testATreeThatIsNotAnArrayReadsAsAbsentAndKeepsTheProject() throws {
        for bad in [#""x""#, "5", "null", #"{"a":1}"#] {
            let p = try decodeProjects(#"[{"tmuxSession":"p","defaultCwd":"/p","windows":[\#(windowJSON)],"attached":false,"tree":\#(bad)}]"#)[0]
            XCTAssertNil(p.tree, "tree: \(bad)")
            XCTAssertEqual(p.windows.count, 1)
        }
    }

    func testAnEmptyTreeIsPresentNotAbsent() throws {
        let p = try decodeProjects(#"[{"tmuxSession":"p","defaultCwd":"/p","windows":[],"attached":false,"tree":[]}]"#)[0]
        XCTAssertEqual(p.tree, [])
    }

    func testProjectStillBuildsWithTheOriginalFiveFieldInitializer() {
        let p = MantaProject(tmuxSession: "p", defaultCwd: "/p", windows: [], attached: false, mantaOwned: nil)
        XCTAssertNil(p.tree)
    }

    func testTreeRoundTripsThroughCodable() throws {
        let p = proj("p", [win(0, sid: "ses_a")], tree: [windowNode(0, sid: "ses_a", children: [virtualNode("ses_c", job: SessionTreeJob(id: "j", status: "paused", origin: nil))])])
        let back = try JSONDecoder().decode(MantaProject.self, from: JSONEncoder().encode(p))
        XCTAssertEqual(back, p)
    }

    // MARK: - Rows without a tree (an older box)

    func testNoTreeIsTodaysListTheWindowsMinusTheJobWindows() {
        let p = proj("p", [win(0, sid: "a"), win(1, sid: "job", owner: "job"), win(2)])
        XCTAssertEqual(ids(SessionTreeRows.rows(for: p)), ["w0", "w2"])
    }

    func testNoTreeAWindowNestedByTheBoxIsHiddenToo() {
        var child = win(1, sid: "c")
        child.job = MantaWindowJob(id: "j", status: "running", parentWindowIndex: 0)
        XCTAssertEqual(ids(SessionTreeRows.rows(for: proj("p", [win(0, sid: "a"), child]))), ["w0"])
    }

    // MARK: - Rows from the tree's roots

    func testRowsAreTheRootsInOrderWithDescendantsHidden() {
        let p = proj("p", [win(0, sid: "a"), win(1, sid: "b"), win(2, sid: "c")], tree: [
            windowNode(0, sid: "a", children: [windowNode(1, sid: "b")]),
            virtualNode("ses_v", title: "driver", outside: true),
            windowNode(2, sid: "c"),
        ])
        let rows = SessionTreeRows.rows(for: p)
        XCTAssertEqual(ids(rows), ["w0", "v:ses_v", "w2"], "window 1 is a descendant: no top-level row")
        guard case .virtual(let v) = rows[1] else { return XCTFail("expected a virtual row") }
        XCTAssertEqual(v.sessionId, "ses_v")
        XCTAssertEqual(v.displayTitle, "driver")
        XCTAssertTrue(v.outside)
    }

    func testAVirtualRootKeepsItsTreeSlotAmongWindowRoots() {
        let p = proj("p", [win(0, sid: "a"), win(1, sid: "b")], tree: [
            windowNode(0, sid: "a"), virtualNode("ses_v"), windowNode(1, sid: "b"),
        ])
        XCTAssertEqual(ids(SessionTreeRows.rows(for: p)), ["w0", "v:ses_v", "w1"], "the box's order, not windows-then-virtual")
    }

    func testAProjectWithOnlyAVirtualRootStillHasARow() {
        let p = proj("p", [], tree: [virtualNode("ses_v", title: "x")])
        XCTAssertEqual(ids(SessionTreeRows.rows(for: p)), ["v:ses_v"])
        XCTAssertTrue(SessionTreeRows.hadContent(p))
    }

    func testRootsWithNothingToOpenAreSkipped() {
        let p = proj("p", [win(0, sid: "a")], tree: [
            SessionTreeNode(key: "x", sessionId: nil, kind: "virtual"),               // no session to materialise
            SessionTreeNode(key: "y", sessionId: "", kind: "virtual"),
            SessionTreeNode(key: "gone", kind: "window", windowIndex: 9),             // its window is not in the list
            SessionTreeNode(key: "nowin", kind: "window", windowIndex: nil),
            windowNode(0, sid: "a"),
        ])
        XCTAssertEqual(ids(SessionTreeRows.rows(for: p)), ["w0"])
    }

    func testARepeatedRowIdIsDropped() {
        let p = proj("p", [win(0, sid: "a")], tree: [
            windowNode(0, sid: "a"), windowNode(0, sid: "a2"), virtualNode("v"), virtualNode("v"),
        ])
        XCTAssertEqual(ids(SessionTreeRows.rows(for: p)), ["w0", "v:v"])
    }

    func testAKindANewerBoxAddsIsTreatedAsAWindowWhenItNamesOne() {
        let p = proj("p", [win(0, sid: "a")], tree: [SessionTreeNode(key: "a", sessionId: "a", kind: "pinned-window", windowIndex: 0)])
        XCTAssertEqual(ids(SessionTreeRows.rows(for: p)), ["w0"])
    }

    func testARootWindowIsShownEvenWhenTheLegacyRulesWouldHideIt() {
        // The box placed it as a root (its parent is elsewhere): the tree is authoritative.
        let p = proj("p", [win(0, sid: "job", owner: "job")], tree: [windowNode(0, sid: "job")])
        XCTAssertEqual(ids(SessionTreeRows.rows(for: p)), ["w0"])
    }

    func testAWindowTheTreeNeverMentionsIsAppendedUnlessTheLegacyRulesHideIt() {
        // A node the decoder had to skip must not make a session vanish — but a job window stays hidden.
        let p = proj("p", [win(2, sid: "c"), win(0, sid: "a"), win(1, sid: "job", owner: "job")], tree: [windowNode(0, sid: "a")])
        XCTAssertEqual(ids(SessionTreeRows.rows(for: p)), ["w0", "w2"])
    }

    func testAnEmptyTreeListsTheWindowsInIndexOrder() {
        let p = proj("p", [win(1), win(0)], tree: [])
        XCTAssertEqual(ids(SessionTreeRows.rows(for: p)), ["w0", "w1"])
    }

    func testHadContentIsFalseOnlyForAProjectThatNeverHadAnything() {
        XCTAssertFalse(SessionTreeRows.hadContent(proj("p", [])))
        XCTAssertFalse(SessionTreeRows.hadContent(proj("p", [], tree: [])))
        XCTAssertTrue(SessionTreeRows.hadContent(proj("p", [win(0)])))
    }

    // MARK: - Descendants and the background count

    func testDescendantsAreFlattenedDepthFirstPreOrder() {
        let root = windowNode(0, sid: "a", children: [
            virtualNode("b", job: SessionTreeJob(id: "j1", status: "running", origin: nil), children: [
                virtualNode("c", job: SessionTreeJob(id: "j2", status: "done", origin: nil)),
            ]),
            virtualNode("d"),
        ])
        XCTAssertEqual(SessionTreeRows.descendants(of: root), [
            SessionTreeDescendant(sessionId: "b", jobActive: true),
            SessionTreeDescendant(sessionId: "c", jobActive: false),
            SessionTreeDescendant(sessionId: "d", jobActive: false),
        ])
        XCTAssertEqual(SessionTreeRows.descendants(of: windowNode(1)), [])
    }

    func testRootDescendantsAreKeyedByTheRootSessionAndOnlyForAProjectWithATree() {
        let tree = [
            windowNode(0, sid: "a", children: [virtualNode("b")]),
            virtualNode("v", children: [virtualNode("w")]),
            SessionTreeNode(key: "window:p:5", sessionId: nil, kind: "window", windowIndex: 5),    // terminal: no session
        ]
        let found = SessionTreeRows.rootDescendants(project: proj("p", [win(0, sid: "a")], tree: tree))
        XCTAssertEqual(Set(found.keys), ["a", "v"])
        XCTAssertEqual(found["a"]?.map(\.sessionId), ["b"])
        XCTAssertEqual(found["v"]?.map(\.sessionId), ["w"])
        XCTAssertTrue(SessionTreeRows.rootDescendants(project: proj("p", [win(0, sid: "a")])).isEmpty)
    }

    func testADuplicateWindowRowNeverEmptiesTheRealRowsDescendants() {
        let real = windowNode(0, sid: "a", children: [virtualNode("b")])
        let dup = SessionTreeNode(key: "window:p:3", sessionId: "a", kind: "window", windowIndex: 3)
        for tree in [[real, dup], [dup, real]] {
            let found = SessionTreeRows.rootDescendants(project: proj("p", [], tree: tree))
            XCTAssertEqual(found["a"]?.count, 1)
        }
    }

    func testTheBoxsRollupWinsWhenItHasReported() {
        let d = [SessionTreeDescendant(sessionId: "b", jobActive: true)]
        XCTAssertEqual(SessionTreeRows.backgroundCount(descendants: d, reported: 3, isRunning: { _ in false }), 3,
                       "it also counts collapsed descendants the tree does not list")
        XCTAssertEqual(SessionTreeRows.backgroundCount(descendants: d, reported: 0, isRunning: { _ in true }), 0)
        XCTAssertEqual(SessionTreeRows.backgroundCount(descendants: [], reported: 2, isRunning: { _ in false }), 2)
        XCTAssertEqual(SessionTreeRows.backgroundCount(descendants: d, reported: -1, isRunning: { _ in false }), 0)
    }

    func testWithoutARollupTheCountIsDescendantsThatAreALiveJobOrRunning() {
        let d = [
            SessionTreeDescendant(sessionId: "job", jobActive: true),
            SessionTreeDescendant(sessionId: "sub", jobActive: false),       // a subagent whose own turn runs
            SessionTreeDescendant(sessionId: "idle", jobActive: false),
            SessionTreeDescendant(sessionId: nil, jobActive: false),
            SessionTreeDescendant(sessionId: nil, jobActive: true),
        ]
        let running: Set<String> = ["sub"]
        XCTAssertEqual(SessionTreeRows.backgroundCount(descendants: d, reported: nil, isRunning: { running.contains($0) }), 3)
        XCTAssertEqual(SessionTreeRows.backgroundCount(descendants: [], reported: nil, isRunning: { _ in true }), 0)
    }

    func testATerminalJobStatusIsNotActive() {
        XCTAssertTrue(SessionTreeJob(id: "j", status: "running", origin: nil).isActive)
        XCTAssertTrue(SessionTreeJob(id: "j", status: "paused", origin: nil).isActive)
        XCTAssertTrue(SessionTreeJob(id: "j", status: "a-status-a-newer-box-adds", origin: nil).isActive)
        for done in ["done", "failed", "stopped"] {
            XCTAssertFalse(SessionTreeJob(id: "j", status: done, origin: nil).isActive)
        }
    }

    // MARK: - Subtitle for a virtual row

    func testVirtualSubtitleMarksARootDrivenFromOutside() {
        let idle = SessionRowStatus(running: false, attention: false, backgroundJobs: 0, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.virtualText(for: idle, outside: true, projectName: nil), "started outside Manta")
        XCTAssertNil(SessionRowSubtitle.virtualText(for: idle, outside: false, projectName: nil))
        let busy = SessionRowStatus(running: false, attention: false, backgroundJobs: 2, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.virtualText(for: busy, outside: true, projectName: nil),
                       "started outside Manta · 2 background jobs")
        XCTAssertEqual(SessionRowSubtitle.virtualText(for: busy, outside: false, projectName: nil), "2 background jobs")
    }

    func testVirtualSubtitleCarriesTheProjectCaptionFirst() {
        let running = SessionRowStatus(running: true, attention: false, backgroundJobs: 0, modelLabel: "opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.virtualText(for: running, outside: true, projectName: "Better Ui"),
                       "Better Ui · started outside Manta · running · opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.virtualText(for: running, outside: false, projectName: ""), "running · opus 4.8")
    }

    // MARK: - Search / Recent / pins over rows

    private func rowsProject(_ name: String, _ rows: [SessionListRow]) -> SessionProjectRows {
        SessionProjectRows(name: name, rows: rows)
    }

    private func virtualRow(_ sid: String, title: String) -> SessionListRow {
        .virtual(SessionVirtualRow(key: sid, sessionId: sid, title: title, outside: false, job: nil))
    }

    func testSearchMatchesWindowAndVirtualTitlesAndAProjectNameKeepsTheGroup() {
        let a = rowsProject("alpha", [.window(win(0, sid: "s", name: "Deploy")), virtualRow("v", title: "Nightly Driver")])
        let b = rowsProject("beta", [.window(win(0, sid: "t", name: "Other"))])
        let byDriver = SessionRowsLogic.search([a, b], query: "driver")
        XCTAssertEqual(byDriver.map(\.name), ["alpha"])
        XCTAssertEqual(ids(byDriver[0].rows), ["v:v"])
        let byProject = SessionRowsLogic.search([a, b], query: "BETA")
        XCTAssertEqual(byProject.map(\.name), ["beta"])
        XCTAssertEqual(SessionRowsLogic.search([a, b], query: "alp")[0].rows.count, 2, "a project-name match keeps the whole group")
        XCTAssertEqual(SessionRowsLogic.search([a, b], query: ""), [a, b])
        XCTAssertTrue(SessionRowsLogic.search([a, b], query: "zzz").isEmpty)
    }

    func testAVirtualRowWithNoTitleIsSearchableAsSession() {
        let a = rowsProject("alpha", [virtualRow("v", title: "")])
        XCTAssertEqual(SessionRowsLogic.search([a], query: "sess").count, 1)
    }

    func testFilteredDropsRowsAndEmptiedProjects() {
        let a = rowsProject("a", [.window(win(0, sid: "s")), virtualRow("v", title: "x")])
        let b = rowsProject("b", [.window(win(0, sid: "t"))])
        let out = SessionRowsLogic.filtered([a, b]) { $0.sessionId == "v" }
        XCTAssertEqual(out.map(\.name), ["a"])
        XCTAssertEqual(ids(out[0].rows), ["v:v"])
    }

    func testPinnedWindowsGoFirstStablyAndAVirtualRowIsNeverPinned() {
        let a = rowsProject("p", [
            .window(win(0, sid: "a")), virtualRow("v", title: "x"), .window(win(2, sid: "c")), .window(win(3, sid: "d")),
        ])
        let out = SessionRowsLogic.pinnedFirst([a], pinned: [SessionPinID.window("p", index: 3), SessionPinID.window("p", index: 0)])
        XCTAssertEqual(ids(out[0].rows), ["w0", "w3", "v:v", "w2"])
        XCTAssertEqual(ids(SessionRowsLogic.pinnedFirst([a], pinned: [])[0].rows), ids(a.rows))
        XCTAssertEqual(ids(SessionRowsLogic.pinnedFirst([a], pinned: [SessionPinID.window("other", index: 0)])[0].rows), ids(a.rows))
    }

    // MARK: - Latest-activity ordering over rows

    private func order(_ projects: [SessionProjectRows], _ activity: [String: Double]) -> [String] {
        SessionRowsLogic.flatten(projects) { project, row in
            activity["\(project)/\(row.id)"].map(date)
        }
        .map { "\($0.project)/\($0.row.id)" }
    }

    func testVirtualRowsSortWithTheChatWindowsByTheirActivity() {
        let a = rowsProject("a", [.window(win(0, sid: "s0")), virtualRow("v", title: "x")])
        let got = order([a], ["a/w0": 100, "a/v:v": 300])
        XCTAssertEqual(got, ["a/v:v", "a/w0"])
    }

    func testTiesBreakOnProjectThenWindowBeforeVirtualThenPosition() {
        let a = rowsProject("a", [virtualRow("v1", title: ""), .window(win(4, sid: "s")), virtualRow("v2", title: "")])
        let b = rowsProject("b", [.window(win(0, sid: "t"))])
        let all: [String: Double] = ["a/v:v1": 5, "a/w4": 5, "a/v:v2": 5, "b/w0": 5]
        XCTAssertEqual(order([a, b], all), ["a/w4", "a/v:v1", "a/v:v2", "b/w0"])
        XCTAssertEqual(order([b, a], all), ["b/w0", "a/w4", "a/v:v1", "a/v:v2"])
    }

    func testUnknownActivityGoesAfterKnownAndTerminalsComeLast() {
        let a = rowsProject("a", [.window(win(0)), .window(win(1, sid: "known")), virtualRow("unknown", title: ""), .window(win(2, sid: "x"))])
        let got = order([a], ["a/w1": 10, "a/w0": 999])
        XCTAssertEqual(got, ["a/w1", "a/w2", "a/v:unknown", "a/w0"], "terminal w0 is last even with a date")
    }

    func testFlattenDoesNotDependOnTheIncomingRowOrderForWindows() {
        let forward = rowsProject("a", [.window(win(0, sid: "s0")), .window(win(1, sid: "s1")), .window(win(2, sid: "s2"))])
        let shuffled = rowsProject("a", [.window(win(2, sid: "s2")), .window(win(0, sid: "s0")), .window(win(1, sid: "s1"))])
        let activity: [String: Double] = ["a/w0": 10, "a/w1": 30, "a/w2": 20]
        XCTAssertEqual(order([forward], activity), order([shuffled], activity))
        XCTAssertEqual(order([forward], activity), ["a/w1", "a/w2", "a/w0"])
        XCTAssertTrue(order([], [:]).isEmpty)
        XCTAssertTrue(order([rowsProject("a", [])], [:]).isEmpty)
    }

    // MARK: - sessions:materialize answers

    private func decodeResult(_ json: String) throws -> SessionMaterializeResult {
        try JSONDecoder().decode(SessionMaterializeResult.self, from: Data(json.utf8))
    }

    func testMaterializeOkNamesTheWindowToOpen() throws {
        let r = try decodeResult(#"{"ok":true,"project":"cantina","windowIndex":7,"sessionId":"ses_x"}"#)
        XCTAssertEqual(r, .opened(project: "cantina", windowIndex: 7, sessionId: "ses_x"))
    }

    func testMaterializeRefusalCarriesTheBoxsSentenceAndReason() throws {
        let r = try decodeResult(#"{"ok":false,"reason":"handoff","message":"A handoff of this conversation is in progress — try again in a moment."}"#)
        XCTAssertEqual(r, .refused(reason: "handoff", message: "A handoff of this conversation is in progress — try again in a moment."))
        let other = try decodeResult(#"{"ok":false,"reason":"a-new-reason","message":"Nope."}"#)
        XCTAssertEqual(other, .refused(reason: "a-new-reason", message: "Nope."))
    }

    func testMaterializeRefusalWithNoSentenceFallsBackToTheGenericOne() throws {
        for json in [#"{"ok":false}"#, #"{"ok":false,"reason":"failed","message":""}"#, #"{"ok":false,"message":7}"#] {
            guard case .refused(_, let message) = try decodeResult(json) else { return XCTFail("expected a refusal") }
            XCTAssertEqual(message, "Couldn't open this session.", json)
        }
    }

    func testMaterializeOkWithoutAWindowIsAnErrorNotAnOpen() {
        XCTAssertThrowsError(try decodeResult(#"{"ok":true,"project":"p","sessionId":"s"}"#))
        XCTAssertThrowsError(try decodeResult(#"{"ok":true,"windowIndex":1,"sessionId":"s"}"#))
        XCTAssertThrowsError(try decodeResult(#"{"project":"p"}"#))
    }
}
