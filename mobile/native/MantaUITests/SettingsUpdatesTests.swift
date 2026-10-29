import XCTest
@testable import MantaUI

// WS10 F18 — software updates: the display list, the row wording, the classifier
// for the `server:update-apply` answer (the box restarts ITSELF, so a dropped
// connection or a proxy 5xx is the success path, while a structured failure or an
// ordinary 500 is real) and the confirm → applying → restarting → done machine.
// Pure, Foundation-only.

final class SettingsUpdatesTests: XCTestCase {

    // MARK: - Rows are the box's (WS11 D3 / X3)

    func testTheCheckDecodesTheBoxsRowWording() throws {
        let json = #"{"available":true,"version":"0.0.40","view":{"targets":[{"id":"server","label":"Manta Server","tone":"action","text":"Update available","hasUpdate":true,"versionText":"0.0.39 → 0.0.40"},{"id":"claude","label":"Claude Code","tone":"error","text":"Couldn't check","hasUpdate":false,"versionText":null}]}}"#
        let check = try JSONDecoder().decode(ServerUpdateCheck.self, from: Data(json.utf8))
        XCTAssertEqual(check.view?.targets.map(\.id), ["server", "claude"])
        XCTAssertEqual(check.view?.targets[0].versionText, "0.0.39 → 0.0.40")
        XCTAssertEqual(check.view?.targets[0].hasUpdate, true)
        XCTAssertNil(check.view?.targets[1].versionText)
        XCTAssertEqual(UpdateTone(wire: check.view?.targets[1].tone ?? ""), .error)
    }

    func testAnOlderBoxSendsNoViewAndAnUnknownToneIsNeverOk() throws {
        let check = try JSONDecoder().decode(ServerUpdateCheck.self, from: Data(#"{"available":true,"version":"0.0.40"}"#.utf8))
        XCTAssertNil(check.view)
        XCTAssertEqual(UpdateTone(wire: "something-new"), .muted)
        XCTAssertEqual(UpdateTone(wire: "ok"), .ok)
        XCTAssertEqual(UpdateTone(wire: "action"), .action)
    }

    func testLandedIsAnEdgeAndUnknownNeverCounts() {
        XCTAssertTrue(UpdateTargets.landed(from: "0.0.39", current: "0.0.40"))
        XCTAssertFalse(UpdateTargets.landed(from: "0.0.39", current: "0.0.39"))
        XCTAssertFalse(UpdateTargets.landed(from: nil, current: "0.0.40"))
        XCTAssertFalse(UpdateTargets.landed(from: "0.0.39", current: nil))
        XCTAssertFalse(UpdateTargets.landed(from: "", current: "0.0.40"))
    }

    // MARK: - Apply classifier (one case per table row)

    private func raw(_ status: Int, _ body: String) -> RawRPCResponse {
        RawRPCResponse(status: status, body: Data(body.utf8))
    }

    private func transport(_ code: Int, _ message: String = "x") -> RawRPCResponse {
        RawRPCResponse(status: nil, transportError: TransportFailure(code: code, message: message))
    }

    func testProxyGatewayStatusesWithAnyBodyAreARestart() {
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(502, "<html><body>Bad Gateway</body></html>")), .restartLikely)
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(504, "Gateway Timeout")), .restartLikely)
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(521, "error code: 521")), .restartLikely)
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(522, "")), .restartLikely)
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(524, "{}")), .restartLikely)
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(503, "Service Unavailable")), .restartLikely,
                       "a bare 503 (a proxy) is not an upgrade refusal")
    }

    func testA503WithTheUpgradeFlagIsTheUpgradeRefusal() {
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(503, #"{"error":"box upgrading","upgrade":true}"#)), .upgrading)
    }

    func testConnectionDropsAreARestart() {
        for code in [TransportFailure.networkConnectionLost, TransportFailure.timedOut, TransportFailure.cannotConnectToHost,
                     TransportFailure.notConnectedToInternet, TransportFailure.cannotFindHost,
                     TransportFailure.dnsLookupFailed, TransportFailure.cancelled] {
            XCTAssertEqual(UpdateApplyClassifier.classify(transport(code)), .restartLikely, "code \(code)")
        }
    }

    func testAnyOtherTransportErrorIsARealFailure() {
        XCTAssertEqual(UpdateApplyClassifier.classify(transport(-1000, "Bad URL")), .failed("Bad URL"))
    }

    func testAnOrdinary500IsARealFailure() {
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(500, #"{"error":"boom"}"#)), .failed("boom"))
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(500, "Internal Server Error")), .failed("HTTP 500"))
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(400, #"{"error":"bad"}"#)), .failed("bad"))
    }

    func testASuccessfulAnswerStarts() {
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(200, #"{"result":{"ok":true}}"#)), .started)
    }

    func testAStructuredFailureIsNeverTransient() {
        XCTAssertEqual(
            UpdateApplyClassifier.classify(raw(200, #"{"result":{"ok":false,"error":"self-update: manifest fetch failed"}}"#)),
            .failed("self-update: manifest fetch failed"))
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(200, #"{"result":{"ok":false}}"#)), .failed("Server update failed"))
    }

    func testAnUnreadableSuccessIsAFailure() {
        let unreadable = ApplyOutcome.failed("The box sent an answer this app couldn't read.")
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(200, #"{"result":null}"#)), unreadable)
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(200, "not json")), unreadable)
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(200, "{}")), unreadable)
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(200, #"{"result":{"version":"1"}}"#)), unreadable)
    }

    func testA401MeansThePairingWasRevoked() {
        XCTAssertEqual(UpdateApplyClassifier.classify(raw(401, #"{"error":"unauthorized"}"#)), .authRequired)
    }

    func testNoAnswerAtAllIsAFailure() {
        XCTAssertEqual(UpdateApplyClassifier.classify(RawRPCResponse(status: nil)), .failed("No answer from the box."))
    }

    // MARK: - Flow

    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func startedFlow(from version: String? = "0.0.39") -> UpdateFlow {
        var flow = UpdateFlow()
        flow.reduce(.requestConfirm)
        flow.reduce(.confirm(fromVersion: version, now: t0))
        return flow
    }

    func testConfirmThenApplyThenRestartThenLanded() {
        var flow = UpdateFlow()
        XCTAssertFalse(flow.isBusy)
        flow.reduce(.requestConfirm)
        XCTAssertEqual(flow.phase, .confirming)
        XCTAssertTrue(flow.isBusy)
        flow.reduce(.confirm(fromVersion: "0.0.39", now: t0))
        XCTAssertEqual(flow.phase, .applying)
        flow.reduce(.applyOutcome(.restartLikely))
        XCTAssertEqual(flow.phase, .restarting)
        flow.reduce(.version("0.0.40"))
        XCTAssertEqual(flow.phase, .done(version: "0.0.40"))
        XCTAssertFalse(flow.isBusy)
    }

    func testAbortFromTheConfirmFailsWithoutApplying() {
        var flow = UpdateFlow()
        flow.reduce(.requestConfirm)
        flow.reduce(.abort("no version"))
        XCTAssertEqual(flow.phase, .failed("no version"))
        XCTAssertFalse(flow.isBusy)
        // Only meaningful from the confirm.
        var applying = startedFlow()
        applying.reduce(.abort("late"))
        XCTAssertEqual(applying.phase, .applying)
    }

    func testCancelFromTheConfirmGoesBackToIdle() {
        var flow = UpdateFlow()
        flow.reduce(.requestConfirm)
        flow.reduce(.cancelConfirm)
        XCTAssertEqual(flow.phase, .idle)
    }

    func testAFailedOutcomeFails() {
        var flow = startedFlow()
        flow.reduce(.applyOutcome(.failed("self-update: manifest fetch failed")))
        XCTAssertEqual(flow.phase, .failed("self-update: manifest fetch failed"))
        XCTAssertFalse(flow.isBusy)
    }

    func testRevokedAndUpgradingOutcomesFailWithTheirOwnWords() {
        var revoked = startedFlow()
        revoked.reduce(.applyOutcome(.authRequired))
        XCTAssertEqual(revoked.phase, .failed("Sign in again — this phone's pairing was revoked."))
        var upgrading = startedFlow()
        upgrading.reduce(.applyOutcome(.upgrading))
        XCTAssertEqual(upgrading.phase, .failed("The box is upgrading right now."))
    }

    func testReconnectWithTheSameVersionKeepsWaiting() {
        var flow = startedFlow()
        flow.reduce(.applyOutcome(.started))
        flow.reduce(.connection(false))
        XCTAssertEqual(flow.phase, .restarting)
        flow.reduce(.connection(true))
        flow.reduce(.version("0.0.39"))
        XCTAssertEqual(flow.phase, .restarting, "the same version after a reconnect is not an update")
    }

    func testANewVersionEndsTheFlowEvenBeforeTheApplyCallAnswers() {
        var flow = startedFlow()
        flow.reduce(.version("0.0.40"))
        XCTAssertEqual(flow.phase, .done(version: "0.0.40"))
    }

    func testTheSafetyCapTimesOutAtTenMinutes() {
        var flow = startedFlow()
        flow.reduce(.applyOutcome(.restartLikely))
        flow.reduce(.tick(t0.addingTimeInterval(599)))
        XCTAssertEqual(flow.phase, .restarting)
        flow.reduce(.tick(t0.addingTimeInterval(600)))
        XCTAssertEqual(flow.phase, .timedOut)
        XCTAssertFalse(flow.isBusy)
    }

    func testOnlyOneUpdateInFlight() {
        var flow = startedFlow()
        flow.reduce(.requestConfirm)
        XCTAssertEqual(flow.phase, .applying, "a second request cannot start another update")
        flow.reduce(.confirm(fromVersion: "9", now: t0))
        XCTAssertEqual(flow.fromVersion, "0.0.39", "…nor change what the first one is waiting for")
    }

    func testLateEventsCannotResurrectAFinishedFlow() {
        var flow = startedFlow()
        flow.reduce(.applyOutcome(.failed("nope")))
        flow.reduce(.applyOutcome(.started))
        flow.reduce(.version("0.0.40"))
        XCTAssertEqual(flow.phase, .failed("nope"))
    }

    func testTheConnectionFlagTracksTheStream() {
        var flow = startedFlow()
        XCTAssertFalse(flow.isWaitingForBox)
        flow.reduce(.connection(false))
        XCTAssertTrue(flow.isWaitingForBox, "applying + stream down reads \"Restarting the box…\"")
        flow.reduce(.connection(true))
        XCTAssertFalse(flow.isWaitingForBox)
    }

    func testDismissAcknowledgesATerminalPhaseAndKeepsTheConnectionFlag() {
        var flow = startedFlow()
        flow.reduce(.connection(false))
        flow.reduce(.applyOutcome(.failed("x")))
        flow.reduce(.dismiss)
        XCTAssertEqual(flow.phase, .idle)
        XCTAssertFalse(flow.connected)
        // …and a dismiss while busy changes nothing.
        var busy = startedFlow()
        busy.reduce(.dismiss)
        XCTAssertEqual(busy.phase, .applying)
    }

    // MARK: - Wire

    func testServerUpdateCheckDecodesTheBoxsShape() throws {
        let json = """
        {"available":true,"version":"0.0.40","notesUrl":null,"ok":true,
         "targets":[
           {"id":"opencode","label":"opencode","current":"2.0.30","latest":"2.0.31","available":true,"ok":true,"manual":false,"disruption":"ends-turns"},
           {"id":"claude","label":"Claude Code","current":null,"latest":null,"available":false,"ok":false,"manual":true,"manualUrl":"https://example.com","disruption":"none"},
           {"label":"broken target with no id"}
         ]}
        """
        let check = try JSONDecoder().decode(ServerUpdateCheck.self, from: Data(json.utf8))
        XCTAssertTrue(check.available)
        XCTAssertEqual(check.version, "0.0.40")
        XCTAssertEqual(check.targets?.map(\.id), ["opencode", "claude"], "a malformed target is dropped, not fatal")
        XCTAssertEqual(check.targets?[1].manualUrl, "https://example.com")
        XCTAssertEqual(check.targets?[0].disruption, "ends-turns")
    }

    func testAnOldBoxsCheckDecodes() throws {
        let check = try JSONDecoder().decode(ServerUpdateCheck.self, from: Data(#"{"available":false}"#.utf8))
        XCTAssertFalse(check.available)
        XCTAssertNil(check.ok)
        XCTAssertNil(check.targets)
    }
}
