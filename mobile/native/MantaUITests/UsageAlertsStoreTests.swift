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

    // MARK: Box binding (credentials → client per box)

    private let boxA = ModelsBoxCredentials(serverUrl: "https://a.example.com", boxId: "A", boxToken: "tokA")
    private let boxB = ModelsBoxCredentials(serverUrl: "https://b.example.com", boxId: "B", boxToken: "tokB")

    private func boundStore(_ creds: UsageTestCredentials,
                            sleep: @escaping @Sendable (Double) async -> Void = { _ in try? await Task.sleep(for: .seconds(30)) }) -> UsageAlertsStore {
        UsageAlertsStore(credentials: { creds.value }, makeClient: ModelsStubProtocol.makeClient, sleep: sleep)
    }

    func testUnpairedIssuesNoRequestAndPairedUsesItsOwnHostAndBearer() async {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("a")])]
        let creds = UsageTestCredentials(nil)
        let store = boundStore(creds)
        store.beginHydration()
        try? await Task.sleep(for: .milliseconds(60))
        XCTAssertTrue(ModelsStubProtocol.recorded.isEmpty, "unpaired: no request at all")

        creds.value = boxA
        store.beginHydration()
        do { let ok = await eventually { store.queue.map(\.id) == ["a"] }; XCTAssertTrue(ok) }
        XCTAssertFalse(ModelsStubProtocol.recorded.isEmpty)
        XCTAssertTrue(ModelsStubProtocol.recorded.allSatisfy { $0.host == "a.example.com" && $0.auth == "Bearer tokA" })
    }

    func testTheFirstBindKeepsTheOpenChatAndASwitchClearsIt() async {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("a")])]
        let creds = UsageTestCredentials(boxA)
        let store = boundStore(creds)
        store.activeSessionId = "s1"      // ChatScreen set it before the stream connected
        store.presentResume()
        store.beginHydration()            // the first client bind
        do { let ok = await eventually { store.queue.map(\.id) == ["a"] }; XCTAssertTrue(ok) }
        XCTAssertEqual(store.activeSessionId, "s1", "the first bind must not wipe the open chat")
        XCTAssertTrue(store.resumeSheetPresented)

        creds.value = boxB
        ModelsStubProtocol.recorded = []
        store.beginHydration()            // a real box switch
        do { let ok = await eventually { !ModelsStubProtocol.recorded.isEmpty }; XCTAssertTrue(ok) }
        XCTAssertNil(store.activeSessionId)
        XCTAssertFalse(store.resumeSheetPresented)
        XCTAssertTrue(ModelsStubProtocol.recorded.allSatisfy { $0.host == "b.example.com" && $0.auth == "Bearer tokB" })
    }

    func testALateAnswerFromTheOldBoxIsDroppedAfterASwitch() async {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("from-a")])]
        let creds = UsageTestCredentials(boxA)
        let store = boundStore(creds)
        ModelsStubProtocol.held = ["usage:alerts"]
        store.beginHydration()
        do { let ok = await eventually { ModelsStubProtocol.count("usage:alerts") == 1 }; XCTAssertTrue(ok) }

        ModelsStubProtocol.stopHolding()
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("from-b")])]
        creds.value = boxB
        store.beginHydration()
        do { let ok = await eventually { store.queue.map(\.id) == ["from-b"] }; XCTAssertTrue(ok) }

        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("from-a")])]
        ModelsStubProtocol.releaseHeld()  // box A's answer arrives now
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(store.queue.map(\.id), ["from-b"])
    }

    func testTheConnectionStatePathHydratesExactlyOncePerConnect() async {
        ModelsStubProtocol.responses = ["usage:alerts": listReply([alertJSON("a")])]
        let stream = UsageTestStream()
        let events = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let store = store()
        store.bind(eventStore: events)
        XCTAssertEqual(ModelsStubProtocol.count("usage:alerts"), 0)
        stream.drive(.connected)
        do { let ok = await eventually { store.queue.map(\.id) == ["a"] }; XCTAssertTrue(ok) }
        stream.drive(.connected)          // a duplicate state is not a reconnect
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(ModelsStubProtocol.count("usage:alerts"), 1)
    }

    func testANoticeFromAnotherScreenReachesTheBanner() {
        let store = store(sleep: { _ in try? await Task.sleep(for: .seconds(30)) })
        store.showNotice("Updated — 2 conversations will carry on at reset.")
        XCTAssertEqual(store.notice, "Updated — 2 conversations will carry on at reset.")
    }
}

@MainActor
final class UsageTestCredentials {
    var value: ModelsBoxCredentials?
    init(_ value: ModelsBoxCredentials?) { self.value = value }
}

private final class UsageTestStream: MantaEventStreamControl {
    var onState: ((MantaConnectionState) -> Void)?
    var onMessage: ((String) -> Void)?
    var onReconnect: (() -> Void)?
    var onConfigError: ((Error) -> Void)?
    var hasConnectedOnce = false
    var currentState: MantaConnectionState = .idle

    func ensure() {}
    func markReconnectAndEnsure() {}
    func retryNow() {}
    func forceReconnect() {}
    func close(reason: String) {}

    func drive(_ state: MantaConnectionState) { onState?(state) }
}

// ===========================================================================
// WS09 F6 — the resume sheet's model (Mac / Xcode only).
// ===========================================================================

@MainActor
final class UsageResumeModelTests: XCTestCase {

    override func setUp() {
        super.setUp()
        ModelsStubProtocol.reset()
    }

    private func row(_ id: String, armed: Bool) -> String {
        #"{"conversation":"\#(id)","name":"Chat \#(id)","armed":\#(armed),"isNew":false,"window":{"label":"Weekly"},"cost":{"warm":true,"reReadTokens":1000,"label":"~$0.10"}}"#
    }

    private func viewReply(_ rows: [String]) -> String {
        #"{"result":{"title":"Resume after limit reset","header":"h","hasArmed":true,"unarmedCount":0,"totalCount":\#(rows.count),"emptyText":"","groups":[{"workspace":"w","rows":[\#(rows.joined(separator: ","))]}],"coldNote":{"one":"1 cold","many":"n cold"}}}"#
    }

    private let plan = #"{"result":{"ok":true,"canApply":true,"title":"Resume at reset","arm":[],"disarm":[]}}"#

    private func model(usage: UsageAlertsStore? = nil) -> (UsageResumeModel, UsageAlertsStore) {
        let usage = usage ?? UsageAlertsStore(api: ModelsStubProtocol.client(), sleep: { _ in try? await Task.sleep(for: .seconds(30)) })
        let model = UsageResumeModel(api: ModelsStubProtocol.client(), usage: usage, planDebounce: 0, refreshStopped: {})
        return (model, usage)
    }

    func testAnUncheckedRowEnablesTheButtonOnceTheDryRunSaysSo() async {
        ModelsStubProtocol.responses = ["usage-stopped:view": viewReply([row("c1", armed: true), row("c2", armed: false)]),
                                        "usage-stopped:apply": plan]
        let (model, _) = model()
        model.start()
        do { let ok = await eventually { model.phase == .loaded && model.plan?.canApply == true }; XCTAssertTrue(ok) }
        XCTAssertEqual(model.selected, ["c1"], "pristine: the armed rows are selected")

        model.toggle("c2")
        XCTAssertNil(model.plan, "a new selection disables the button until the box re-plans")
        do { let ok = await eventually { model.plan?.canApply == true }; XCTAssertTrue(ok) }
        XCTAssertEqual(model.selected, ["c1", "c2"])
    }

    func testAFailedApplyKeepsTheSheetOpenAndASuccessHandsTheMessageToTheBanner() async {
        ModelsStubProtocol.responses = ["usage-stopped:view": viewReply([row("c1", armed: true)]), "usage-stopped:apply": plan]
        let (model, usage) = model()
        model.start()
        do { let ok = await eventually { model.plan?.canApply == true }; XCTAssertTrue(ok) }

        ModelsStubProtocol.responses["usage-stopped:apply"] =
            #"{"result":{"ok":false,"canApply":true,"failed":[{"conversation":"c1","name":"Chat c1","message":"no"}],"message":"1 failed"}}"#
        let closedAfterFailure = await model.apply()
        XCTAssertFalse(closedAfterFailure)
        XCTAssertEqual(model.message, "1 failed")
        XCTAssertNil(usage.notice)

        do { let ok = await eventually { model.plan?.canApply == true }; XCTAssertTrue(ok) }
        ModelsStubProtocol.responses["usage-stopped:apply"] =
            #"{"result":{"ok":true,"canApply":true,"message":"Updated — 1 conversation will carry on at reset."}}"#
        let closedAfterSuccess = await model.apply()
        XCTAssertTrue(closedAfterSuccess)
        XCTAssertEqual(usage.notice, "Updated — 1 conversation will carry on at reset.")
    }

    func testCloseStampsLastLookedOnce() async {
        ModelsStubProtocol.responses = ["usage-stopped:view": viewReply([row("c1", armed: true)]), "usage-stopped:apply": plan]
        let (model, _) = model()
        await model.close()
        await model.close()
        XCTAssertEqual(ModelsStubProtocol.count("usage-stopped:stamp-last-looked"), 1)
    }

    func testAChangedViewDropsAVanishedIdKeepsTheUsersToggleAndReRunsTheDryRun() async {
        ModelsStubProtocol.responses = ["usage-stopped:view": viewReply([row("c1", armed: true), row("c2", armed: false)]),
                                        "usage-stopped:apply": plan]
        let (model, usage) = model()
        model.start()
        do { let ok = await eventually { model.plan?.canApply == true }; XCTAssertTrue(ok) }
        model.toggle("c2")
        do { let ok = await eventually { model.plan?.canApply == true }; XCTAssertTrue(ok) }
        XCTAssertEqual(model.selected, ["c1", "c2"])
        let dryRunsBefore = ModelsStubProtocol.count("usage-stopped:apply")

        ModelsStubProtocol.responses["usage-stopped:view"] = viewReply([row("c2", armed: false)])
        usage.stoppedUpdates.send()
        do { let ok = await eventually { model.view?.rows.map(\.conversation) == ["c2"] }; XCTAssertTrue(ok) }
        XCTAssertEqual(model.selected, ["c2"], "c1 vanished; the user's c2 choice stays")
        do { let ok = await eventually { ModelsStubProtocol.count("usage-stopped:apply") > dryRunsBefore }; XCTAssertTrue(ok) }
    }

    func testAnOlderViewAnswerArrivingAfterANewerOneIsIgnored() async {
        ModelsStubProtocol.responses = ["usage-stopped:view": viewReply([row("old", armed: true)]), "usage-stopped:apply": plan]
        let (model, _) = model()
        ModelsStubProtocol.held = ["usage-stopped:view"]
        let first = Task { await model.load() }
        do { let ok = await eventually { ModelsStubProtocol.count("usage-stopped:view") == 1 }; XCTAssertTrue(ok) }

        ModelsStubProtocol.stopHolding()
        ModelsStubProtocol.responses["usage-stopped:view"] = viewReply([row("new", armed: true)])
        await model.load()
        XCTAssertEqual(model.view?.rows.map(\.conversation), ["new"])

        ModelsStubProtocol.responses["usage-stopped:view"] = viewReply([row("old", armed: true)])
        ModelsStubProtocol.releaseHeld()
        await first.value
        XCTAssertEqual(model.view?.rows.map(\.conversation), ["new"], "the older answer is dropped")
    }

    func testAReconnectReloadsTheListOnce() async {
        ModelsStubProtocol.responses = ["usage-stopped:view": viewReply([row("c1", armed: true)]), "usage-stopped:apply": plan]
        let (model, usage) = model()
        model.start()
        do { let ok = await eventually { ModelsStubProtocol.count("usage-stopped:view") == 1 }; XCTAssertTrue(ok) }
        usage.reconnects.send()
        do { let ok = await eventually { ModelsStubProtocol.count("usage-stopped:view") == 2 }; XCTAssertTrue(ok) }
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(ModelsStubProtocol.count("usage-stopped:view"), 2)
    }
}
