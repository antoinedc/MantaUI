import XCTest
@testable import MantaUI

// WS09 F7 — decoding of the box's alert shapes (real output of src/server/usageAlerts.mjs)
// and `UsageAlertQueue`, the client half of the hydration contract. The cases mirror
// src/renderer/usageAlertsQueue.test.ts one for one.

private enum AlertFx {
    static let list = #"""
{"supported":true,"bootId":"boot-1","revision":1,"alerts":[{"id":"claude:weekly:limit:1000003600000","key":"claude:weekly","level":"limit","provider":"claude","windowKind":"weekly","windowLabel":"Weekly","pct":100,"resetsAt":1000003600000,"text":"Weekly limit reached on Claude","raisedAt":1000000000000,"expiresAt":1000003600000,"sticky":true,"canRemind":true,"canKeepGoing":true}]}
"""#
    static let frame = #"""
{"bootId":"boot-1","revision":1,"alert":{"id":"claude:weekly:limit:1000003600000","key":"claude:weekly","level":"limit","provider":"claude","windowKind":"weekly","windowLabel":"Weekly","pct":100,"resetsAt":1000003600000,"text":"Weekly limit reached on Claude","raisedAt":1000000000000,"expiresAt":1000003600000,"sticky":true,"canRemind":true,"canKeepGoing":true}}
"""#
    static let retiredFrame = #"""
{"bootId":"boot-1","revision":2,"retired":["claude:weekly:limit:1000003600000"]}
"""#
}

final class UsageEscalationTests: XCTestCase {

    private func alert(_ id: String, level: String = "limit", sticky: Bool = true, resetsAt: Double? = 2_000_000_000_000) -> UsageAlertWire {
        UsageAlertWire(id: id, key: "claude:weekly", level: level, provider: "claude", windowKind: "weekly",
                       windowLabel: "Weekly", pct: 100, resetsAt: resetsAt, text: "text \(id)", raisedAt: 1,
                       expiresAt: resetsAt, sticky: sticky, canRemind: true, canKeepGoing: true)
    }
    private func list(_ revision: Int, _ alerts: [UsageAlertWire], boot: String = "B1") -> UsageAlertsList {
        UsageAlertsList(bootId: boot, revision: revision, alerts: alerts)
    }
    private func raise(_ revision: Int, _ a: UsageAlertWire, boot: String = "B1") -> UsageAlertFrame {
        UsageAlertFrame(bootId: boot, revision: revision, alert: a)
    }
    private func retire(_ revision: Int, _ ids: [String], boot: String = "B1") -> UsageAlertFrame {
        UsageAlertFrame(bootId: boot, revision: revision, retired: ids)
    }
    private func ids(_ q: UsageAlertQueue) -> [String] { q.visible.map(\.id) }
    private func hydrated(_ alerts: [UsageAlertWire] = [], revision: Int = 0) -> UsageAlertQueue {
        var q = UsageAlertQueue()
        let epoch = q.startHydration()
        _ = q.applySnapshot(list(revision, alerts), epoch: epoch)
        return q
    }

    // MARK: decode

    func testDecodeListAndFrames() throws {
        let l = try JSONDecoder().decode(UsageAlertsList.self, from: Data(AlertFx.list.utf8))
        XCTAssertEqual(l.bootId, "boot-1")
        XCTAssertEqual(l.revision, 1)
        let a = try XCTUnwrap(l.alerts.first)
        XCTAssertEqual(a.id, "claude:weekly:limit:1000003600000")
        XCTAssertEqual(a.level, "limit")
        XCTAssertTrue(a.sticky && a.canRemind && a.canKeepGoing)
        XCTAssertEqual(a.text, "Weekly limit reached on Claude")
        XCTAssertEqual(a.resetsAt, 1_000_003_600_000)

        let raised = try JSONDecoder().decode(UsageAlertFrame.self, from: Data(AlertFx.frame.utf8))
        XCTAssertEqual(raised.revision, 1)
        XCTAssertEqual(raised.alert?.id, a.id)
        XCTAssertNil(raised.retired)

        let retired = try JSONDecoder().decode(UsageAlertFrame.self, from: Data(AlertFx.retiredFrame.utf8))
        XCTAssertEqual(retired.retired, [a.id])
        XCTAssertNil(retired.alert)
    }

    func testDecodeAlertWithoutReset() throws {
        let json = #"{"id":"x","key":"k","level":"warn","provider":"claude","windowKind":"session","windowLabel":"Session","pct":93,"resetsAt":null,"text":"t","raisedAt":1,"expiresAt":null,"sticky":false,"canRemind":false,"canKeepGoing":false}"#
        let a = try JSONDecoder().decode(UsageAlertWire.self, from: Data(json.utf8))
        XCTAssertNil(a.resetsAt)
        XCTAssertNil(a.expiresAt)
        XCTAssertFalse(a.sticky)
    }

    // MARK: queue

    func testUnseenIDsEnqueueInOrderSeenNeverReenqueueDismissedStaysSeen() {
        var q = hydrated([alert("a"), alert("b")], revision: 2)
        XCTAssertEqual(ids(q), ["a", "b"])
        q.dismiss("a")
        XCTAssertEqual(ids(q), ["b"])
        let e = q.startHydration()
        XCTAssertEqual(q.applySnapshot(list(2, [alert("a"), alert("b")]), epoch: e), .none)
        XCTAssertEqual(ids(q), ["b"])
    }

    func testDisconnectRetirementMissedReconnect() {
        var q = hydrated([alert("x")], revision: 1)
        XCTAssertEqual(ids(q), ["x"])
        let e = q.startHydration()
        _ = q.applySnapshot(list(2, []), epoch: e)
        XCTAssertEqual(ids(q), [])
    }

    func testRaiseDuringHydrationBothVisibleAndRevisionFive() {
        var q = UsageAlertQueue()
        let e = q.startHydration()
        _ = q.applyFrame(raise(5, alert("B")))
        _ = q.applySnapshot(list(4, [alert("A")]), epoch: e)
        XCTAssertEqual(ids(q), ["A", "B"])
        XCTAssertEqual(q.lastRevision, 5)
        XCTAssertEqual(q.applyFrame(raise(6, alert("C"))), .none)
        XCTAssertEqual(ids(q), ["A", "B", "C"])
    }

    func testRetirementRacingHydrationStaysRetired() {
        var q = UsageAlertQueue()
        let e = q.startHydration()
        _ = q.applyFrame(retire(5, ["X"]))
        _ = q.applySnapshot(list(4, [alert("X")]), epoch: e)
        XCTAssertEqual(ids(q), [])
    }

    func testOlderEpochSnapshotIsIgnored() {
        var q = UsageAlertQueue()
        let old = q.startHydration()
        let current = q.startHydration()
        XCTAssertEqual(q.applySnapshot(list(9, [alert("late")]), epoch: old), .none)
        XCTAssertEqual(ids(q), [])
        _ = q.applySnapshot(list(1, [alert("ok")]), epoch: current)
        XCTAssertEqual(ids(q), ["ok"])
    }

    func testRestartDuringRequestRehydratesAndNeverRevertsBoot() {
        var q = UsageAlertQueue()
        let e = q.startHydration()
        _ = q.applyFrame(raise(1, alert("n"), boot: "B2"))
        XCTAssertEqual(q.applySnapshot(list(7, [alert("old")], boot: "B1"), epoch: e), .hydrate)
        let e2 = q.startHydration()
        XCTAssertEqual(q.applySnapshot(list(1, [alert("n")], boot: "B2"), epoch: e2), .none)
        XCTAssertEqual(ids(q), ["n"])
        XCTAssertEqual(q.applyFrame(raise(8, alert("zzz"), boot: "B1")), .hydrate)
        XCTAssertEqual(ids(q), ["n"])
        XCTAssertEqual(q.lastBootId, "B2")
    }

    func testGapWhileLiveRehydratesAndKeepsTheFrame() {
        var q = hydrated([alert("a")], revision: 4)
        XCTAssertEqual(q.applyFrame(raise(5, alert("b"))), .none)
        XCTAssertEqual(q.applyFrame(raise(7, alert("d"))), .hydrate)
        let e = q.startHydration()
        _ = q.applySnapshot(list(6, [alert("a"), alert("b"), alert("c")]), epoch: e)
        XCTAssertEqual(ids(q), ["a", "b", "c", "d"])
    }

    func testStaleFramesAreIgnored() {
        var q = hydrated([alert("a")], revision: 4)
        XCTAssertEqual(q.applyFrame(raise(4, alert("dup"))), .none)
        XCTAssertEqual(q.applyFrame(retire(3, ["a"])), .none)
        XCTAssertEqual(ids(q), ["a"])
    }

    func testFrameFromADifferentBootWhileLiveRehydrates() {
        var q = hydrated([alert("a")], revision: 4)
        XCTAssertEqual(q.applyFrame(raise(1, alert("n"), boot: "B2")), .hydrate)
    }

    func testBufferOverflowRehydrates() {
        var q = UsageAlertQueue()
        _ = q.startHydration()
        var action = UsageAlertQueue.Action.none
        for i in 1...(UsageAlertQueue.bufferCap + 1) { action = q.applyFrame(raise(i, alert("f\(i)"))) }
        XCTAssertEqual(action, .hydrate)
    }

    func testRetiredFrameRemovesAndASeenIDNeverReshows() {
        var q = hydrated([alert("a")], revision: 1)
        _ = q.applyFrame(retire(2, ["a"]))
        XCTAssertEqual(ids(q), [])
        _ = q.applyFrame(raise(3, alert("a")))
        XCTAssertEqual(ids(q), [])
    }

    func testResetForgetsEverythingButKeepsCountingEpochs() {
        var q = hydrated([alert("a")], revision: 3)
        let before = q.epoch
        q.reset()
        XCTAssertEqual(ids(q), [])
        XCTAssertNil(q.lastBootId)
        XCTAssertEqual(q.lastRevision, 0)
        XCTAssertEqual(q.epoch, before)
        let e = q.startHydration()
        XCTAssertGreaterThan(e, before)
        _ = q.applySnapshot(list(1, [alert("a")]), epoch: e)
        XCTAssertEqual(ids(q), ["a"], "a new box may show an id the old one showed")
    }

    // MARK: text

    func testLineWithAndWithoutResetAndElapsed() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let none = alert("n", resetsAt: nil)
        XCTAssertEqual(UsageAlertText.line(alert: none, now: now), "text n.")
        let soon = alert("s", resetsAt: (1_000_000 + 7_800) * 1000)
        XCTAssertTrue(UsageAlertText.line(alert: soon, now: now).hasPrefix("text s — resets in 2h10m"))
        XCTAssertTrue(UsageAlertText.line(alert: soon, now: now).hasSuffix("."))
        let elapsed = alert("e", resetsAt: (1_000_000 - 5) * 1000)
        XCTAssertEqual(UsageAlertText.line(alert: elapsed, now: now), "text e — resetting…")
    }

    func testRetryScheduleIsOneTwoFiveThenThirty() {
        XCTAssertEqual((0..<6).map(UsageAlertsRetry.delaySeconds), [1, 2, 5, 30, 30, 30])
    }
}
