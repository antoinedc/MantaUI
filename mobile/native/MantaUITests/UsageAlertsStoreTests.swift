import XCTest
@testable import MantaUI

// ===========================================================================
// WS09 F7 — store tests (Mac / Xcode only; the queue rules themselves are the
// Foundation-only UsageEscalationTests).
// ===========================================================================

@MainActor
final class UsageAlertsStoreTests: XCTestCase {

    override func setUp() {
        super.setUp()
        ModelsStubProtocol.reset()
    }

    private func alertJSON(_ id: String, level: String = "limit", sticky: Bool = true, resetsAt: Double = 2_000_000_000_000) -> String {
        #"{"id":"\#(id)","key":"claude:weekly","level":"\#(level)","provider":"claude","windowKind":"weekly","windowLabel":"Weekly","pct":100,"resetsAt":\#(Int(resetsAt)),"text":"Weekly limit reached on Claude","raisedAt":1,"expiresAt":\#(Int(resetsAt)),"sticky":\#(sticky),"canRemind":true,"canKeepGoing":true}"#
    }

    private func listReply(_ alerts: [String], revision: Int = 1, boot: String = "B1") -> String {
        #"{"result":{"supported":true,"bootId":"\#(boot)","revision":\#(revision),"alerts":[\#(alerts.joined(separator: ","))]}}"#
    }

    private func frame(_ payload: String) throws -> MantaStreamFrame {
        MantaStreamFrame(kind: "usage.alert", sub: nil, sessionId: nil,
                         payload: try JSONDecoder().decode(JSONValue.self, from: Data(payload.utf8)), eventType: nil)
    }

    private func store(sleep: @escaping @Sendable (Double) async -> Void = { _ in }) -> UsageAlertsStore {
        UsageAlertsStore(api: ModelsStubProtocol.client(), sleep: sleep)
    }

    func testHydrationShowsTheBoxsAlertsAndASeenIDNeverReturns() async {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("a")])]
        let store = store()
        store.beginHydration()
        do { let ok = await eventually { store.queue.map(\.id) == ["a"] }; XCTAssertTrue(ok) }

        store.dismiss(id: "a")
        XCTAssertTrue(store.queue.isEmpty)
        store.beginHydration() // a reconnect re-reads the box
        do { let ok = await eventually { ModelsStubProtocol.count("usage:alerts") == 2 }; XCTAssertTrue(ok) }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(store.queue.isEmpty, "a dismissed alert is not shown again")
    }

    func testARetiredFrameClosesTheBanner() async throws {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("a")], revision: 1)]
        let store = store()
        store.beginHydration()
        do { let ok = await eventually { store.queue.count == 1 }; XCTAssertTrue(ok) }
        store.handle(frame: try frame(#"{"bootId":"B1","revision":2,"retired":["a"]}"#))
        XCTAssertTrue(store.queue.isEmpty)
    }

    func testAFrameWeCannotReadReReadsTheBoxSet() async throws {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([])]
        let store = store()
        store.beginHydration()
        do { let ok = await eventually { ModelsStubProtocol.count("usage:alerts") == 1 }; XCTAssertTrue(ok) }
        store.handle(frame: try frame(#"{"unexpected":true}"#))
        do { let ok = await eventually { ModelsStubProtocol.count("usage:alerts") == 2 }; XCTAssertTrue(ok) }
    }

    func testWarnAlertsLeaveByThemselvesLimitAlertsStay() async {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("w", level: "warn", sticky: false), alertJSON("l")], revision: 2)]
        let store = store() // the injected sleep returns at once: the 6 s warn lifetime elapses immediately
        store.beginHydration()
        do { let ok = await eventually { store.queue.map(\.id) == ["l"] }; XCTAssertTrue(ok) }
    }

    func testRemindExpiredRemovesTheAlertAndShowsTheBoxMessage() async {
        ModelsStubProtocol.responses = [
            "usage:alerts": listReply([alertJSON("a")]),
            "usage:remind-at-reset": #"{"result":{"ok":false,"code":"expired","message":"This window has already reset — you can keep working."}}"#,
        ]
        let store = store(sleep: { _ in try? await Task.sleep(for: .seconds(30)) })
        store.beginHydration()
        do { let ok = await eventually { store.queue.count == 1 }; XCTAssertTrue(ok) }
        store.activeSessionId = "ses_1"
        await store.remindAtReset(store.queue[0])
        XCTAssertTrue(store.queue.isEmpty)
        XCTAssertEqual(store.notice, "This window has already reset — you can keep working.")
        let sent = ModelsStubProtocol.recorded.last { $0.channel == "usage:remind-at-reset" }?.args ?? ""
        XCTAssertTrue(sent.contains("ses_1") && sent.contains("claude:weekly"))
    }

    func testRemindWithoutAnOpenChatSaysSoAndSendsNothing() async {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("a")])]
        let store = store(sleep: { _ in try? await Task.sleep(for: .seconds(30)) })
        store.beginHydration()
        do { let ok = await eventually { store.queue.count == 1 }; XCTAssertTrue(ok) }
        await store.remindAtReset(store.queue[0])
        XCTAssertEqual(store.notice, "Open a chat to set a reminder.")
        XCTAssertEqual(ModelsStubProtocol.count("usage:remind-at-reset"), 0)
    }

    func testRemindSuccessConfirmsAndClosesTheAlert() async {
        ModelsStubProtocol.responses = [
            "usage:alerts": listReply([alertJSON("a")]),
            "usage:remind-at-reset": #"{"result":{"ok":true,"fireAt":2000000060000}}"#,
        ]
        let store = store(sleep: { _ in try? await Task.sleep(for: .seconds(30)) })
        store.beginHydration()
        do { let ok = await eventually { store.queue.count == 1 }; XCTAssertTrue(ok) }
        store.activeSessionId = "ses_1"
        await store.remindAtReset(store.queue[0])
        XCTAssertTrue(store.notice?.hasPrefix("Reminder set for ") == true)
        XCTAssertTrue(store.queue.isEmpty)
    }

    func testAFailedRequestRetriesAndThenLands() async {
        ModelsStubProtocol.responses = ["usage:alerts": #"{"error":"box busy"}"#]
        let store = store()
        store.beginHydration()
        do { let ok = await eventually { ModelsStubProtocol.count("usage:alerts") >= 2 }; XCTAssertTrue(ok) }
        ModelsStubProtocol.responses["usage:alerts"] = listReply([alertJSON("a")])
        do { let ok = await eventually { store.queue.map(\.id) == ["a"] }; XCTAssertTrue(ok) }
    }

    func testOlderBoxIsMarkedUnsupportedWithoutRetrying() async {
        ModelsStubProtocol.responses = ["usage:alerts": #"{"error":"unknown rpc channel: usage:alerts"}"#]
        let store = store()
        store.beginHydration()
        do { let ok = await eventually { store.unsupported }; XCTAssertTrue(ok) }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(ModelsStubProtocol.count("usage:alerts"), 1)
    }

    func testResetForBoxChangeClearsEverythingAndDropsALateOldBoxAnswer() async {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("a")])]
        let store = store()
        store.activeSessionId = "ses_old"
        ModelsStubProtocol.held = ["usage:alerts"]
        store.beginHydration()
        do { let ok = await eventually { ModelsStubProtocol.count("usage:alerts") == 1 }; XCTAssertTrue(ok) }
        store.resetForBoxChange()
        XCTAssertNil(store.activeSessionId)
        XCTAssertFalse(store.resumeSheetPresented)
        ModelsStubProtocol.releaseHeld()
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(store.queue.isEmpty, "the old box's answer must not land on the new box")
    }

    func testResetForgetsSeenIDsSoTheNewBoxMayShowTheSameID() async {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("a")])]
        let store = store()
        store.beginHydration()
        do { let ok = await eventually { store.queue.count == 1 }; XCTAssertTrue(ok) }
        store.dismiss(id: "a")
        store.resetForBoxChange()
        store.beginHydration()
        do { let ok = await eventually { store.queue.map(\.id) == ["a"] }; XCTAssertTrue(ok) }
    }

    func testKeepGoingOpensTheResumeSheetAndBoxRemovalResetsIt() async {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("a")])]
        let store = store()
        store.beginHydration()
        do { let ok = await eventually { store.queue.count == 1 }; XCTAssertTrue(ok) }
        store.keepGoing(store.queue[0])
        XCTAssertTrue(store.resumeSheetPresented)
        NotificationCenter.default.post(name: .mantaBoxRemoved, object: nil)
        do { let ok = await eventually { !store.resumeSheetPresented && store.queue.isEmpty }; XCTAssertTrue(ok) }
    }
}
