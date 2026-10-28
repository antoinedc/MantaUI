import XCTest
@testable import MantaUI

// ===========================================================================
// WS04 §6 / D14 — the GitHub device sign-in STATE MACHINE (Linux-eligible; an
// injected clock drives every case). The store's lifecycle is in
// `GitHubDeviceSignInStoreTests` (Mac).
// ===========================================================================

final class GitHubDeviceSignInTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func grant(poll: Int = 5, expires: Int = 900) -> GitHubDeviceStart {
        GitHubDeviceStart(grant: GitHubDeviceGrant(grantId: "g1", userCode: "AB12-CD34",
                                                   verificationUri: "https://github.com/login/device",
                                                   expiresIn: expires, pollInterval: poll))
    }

    private func started(poll: Int = 5, expires: Int = 900) -> GitHubDeviceFlow {
        var flow = GitHubDeviceFlow()
        flow.started(grant(poll: poll, expires: expires), now: t0)
        return flow
    }

    private func pending(_ interval: Int? = nil) -> GitHubDevicePoll { GitHubDevicePoll(status: "pending", pollInterval: interval) }
    private func error(_ message: String? = nil) -> GitHubDevicePoll { GitHubDevicePoll(status: "error", error: message) }

    func testStartAlreadyConnectedIsConnected() {
        var flow = GitHubDeviceFlow()
        flow.started(GitHubDeviceStart(connected: true), now: t0)
        XCTAssertEqual(flow.stage, .connected)
    }

    func testStartNotConfigured() {
        var flow = GitHubDeviceFlow()
        flow.started(GitHubDeviceStart(notConfigured: true), now: t0)
        XCTAssertEqual(flow.stage, .notConfigured)
    }

    func testStartGrantSetsCodeIntervalAndDeadline() {
        let flow = started(poll: 8, expires: 600)
        XCTAssertEqual(flow.stage, .code)
        XCTAssertEqual(flow.interval, 8)
        XCTAssertEqual(flow.deadline, t0.addingTimeInterval(600))
        XCTAssertEqual(flow.lastPoll, t0)
        XCTAssertEqual(started(poll: 1).interval, 5)
    }

    func testStartWithNeitherGrantNorFlagIsAnError() {
        var flow = GitHubDeviceFlow()
        flow.started(GitHubDeviceStart(error: "boom"), now: t0)
        XCTAssertEqual(flow.stage, .error("boom"))
        var empty = GitHubDeviceFlow()
        empty.started(GitHubDeviceStart(), now: t0)
        XCTAssertEqual(empty.stage, .error(GitHubDeviceFlow.unreachableMessage))
        var threw = GitHubDeviceFlow()
        threw.startFailed()
        XCTAssertEqual(threw.stage, .error("Couldn't reach the server. Try again."))
    }

    func testPendingReReadsIntervalAndResetsErrors() {
        var flow = started()
        flow.polled(error("x"), now: t0.addingTimeInterval(5))
        flow.polled(error("x"), now: t0.addingTimeInterval(10))
        XCTAssertEqual(flow.consecutiveErrors, 2)
        flow.polled(pending(12), now: t0.addingTimeInterval(15))
        XCTAssertEqual(flow.consecutiveErrors, 0)
        XCTAssertEqual(flow.interval, 12)
        XCTAssertEqual(flow.lastPoll, t0.addingTimeInterval(15))
        XCTAssertEqual(flow.stage, .code)
    }

    func testSlowDownLengthensInterval() {
        var flow = started(poll: 5)
        flow.polled(pending(10), now: t0.addingTimeInterval(5))
        XCTAssertEqual(flow.interval, 10)
    }

    func testPendingIntervalNeverBelowFive() {
        var flow = started(poll: 5)
        flow.polled(pending(1), now: t0.addingTimeInterval(5))
        XCTAssertEqual(flow.interval, 5)
        flow.polled(pending(nil), now: t0.addingTimeInterval(10))
        XCTAssertEqual(flow.interval, 5)
    }

    func testThreeConsecutiveErrorsStopWithServerMessage() {
        var flow = started()
        flow.polled(error("denied"), now: t0.addingTimeInterval(5))
        flow.polled(error("denied"), now: t0.addingTimeInterval(10))
        XCTAssertEqual(flow.stage, .code)
        flow.polled(error("denied"), now: t0.addingTimeInterval(15))
        XCTAssertEqual(flow.stage, .error("denied"))
    }

    func testThreeErrorsWithEmptyMessageUseDefault() {
        var flow = started()
        for i in 1...3 { flow.polled(error(""), now: t0.addingTimeInterval(Double(i) * 5)) }
        XCTAssertEqual(flow.stage, .error("GitHub sign-in failed."))
    }

    func testTransportThrowsCountTowardBudget() {
        var flow = started()
        flow.pollThrew(now: t0.addingTimeInterval(5))
        flow.polled(error("x"), now: t0.addingTimeInterval(10))
        XCTAssertEqual(flow.stage, .code)
        flow.pollThrew(now: t0.addingTimeInterval(15))
        XCTAssertEqual(flow.stage, .error("Couldn't reach the server. Try again."))
    }

    func testDoneConnects() {
        var flow = started()
        flow.polled(GitHubDevicePoll(status: "done"), now: t0.addingTimeInterval(5))
        XCTAssertEqual(flow.stage, .connected)
    }

    func testExpiredReply() {
        var flow = started()
        flow.polled(GitHubDevicePoll(status: "expired"), now: t0.addingTimeInterval(5))
        XCTAssertEqual(flow.stage, .expired)
    }

    func testUnknownStatusIsAnErrorNotSuccess() {
        var flow = started()
        for i in 1...3 { flow.polled(GitHubDevicePoll(status: "from-the-future"), now: t0.addingTimeInterval(Double(i) * 5)) }
        XCTAssertEqual(flow.stage, .error("GitHub sign-in failed."))
    }

    func testTickPastDeadlineExpires() {
        var flow = started(expires: 60)
        flow.tick(now: t0.addingTimeInterval(60))
        XCTAssertEqual(flow.stage, .expired)
    }

    func testTickBeforeDeadlineKeepsCode() {
        var flow = started(expires: 60)
        flow.tick(now: t0.addingTimeInterval(59.9))
        XCTAssertEqual(flow.stage, .code)
    }

    func testRepliesAfterTheFlowEndedAreIgnored() {
        var flow = started()
        flow.polled(GitHubDevicePoll(status: "expired"), now: t0.addingTimeInterval(5))
        flow.polled(GitHubDevicePoll(status: "done"), now: t0.addingTimeInterval(10))
        XCTAssertEqual(flow.stage, .expired)
    }

    func testShouldPollNowAfterIntervalElapsed() {
        XCTAssertTrue(GitHubDeviceFlow.shouldPollNow(lastPoll: t0, now: t0.addingTimeInterval(5), interval: 5))
    }

    func testShouldPollNowFalseBeforeInterval() {
        XCTAssertFalse(GitHubDeviceFlow.shouldPollNow(lastPoll: t0, now: t0.addingTimeInterval(4.9), interval: 5))
    }

    func testShouldPollNowWithNoPreviousPoll() {
        XCTAssertTrue(GitHubDeviceFlow.shouldPollNow(lastPoll: nil, now: t0, interval: 5))
    }

    func testCountdownLabel() {
        XCTAssertEqual(GitHubDeviceFlow.countdownLabel(remaining: 245), "4:05")
        XCTAssertEqual(GitHubDeviceFlow.countdownLabel(remaining: 0), "0:00")
        XCTAssertEqual(GitHubDeviceFlow.countdownLabel(remaining: -10), "0:00")
        XCTAssertEqual(GitHubDeviceFlow.countdownLabel(remaining: 0.4), "0:01")
        XCTAssertEqual(GitHubDeviceFlow.countdownLabel(remaining: 900), "15:00")
    }

    func testDisplayURL() {
        XCTAssertEqual(GitHubDeviceFlow.displayURL("https://github.com/login/device"), "github.com/login/device")
        XCTAssertEqual(GitHubDeviceFlow.displayURL("http://x.test/a"), "x.test/a")
        XCTAssertEqual(GitHubDeviceFlow.displayURL("github.com/x"), "github.com/x")
    }

    func testRemainingFollowsTheDeadline() {
        let flow = started(expires: 100)
        XCTAssertEqual(flow.remaining(now: t0.addingTimeInterval(40)), 60)
        XCTAssertNil(GitHubDeviceFlow().remaining(now: t0))
    }
}
