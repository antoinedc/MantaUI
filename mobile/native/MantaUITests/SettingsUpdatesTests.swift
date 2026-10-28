import XCTest
@testable import MantaUI

// WS10 F18 — software updates: the display list, the row wording, the classifier
// for the `server:update-apply` answer (the box restarts ITSELF, so a dropped
// connection or a proxy 5xx is the success path, while a structured failure or an
// ordinary 500 is real) and the confirm → applying → restarting → done machine.
// Pure, Foundation-only.

final class SettingsUpdatesTests: XCTestCase {

    // MARK: - Targets

    private func cli(_ id: String, _ label: String, available: Bool = false) -> UpdateTarget {
        UpdateTarget(id: id, label: label, current: "1.0", latest: available ? "2.0" : "1.0",
                     available: available, disruption: id == "opencode" ? "ends-turns" : "none")
    }

    func testBuildOrdersServerThenOpencodeThenCLIsAlphabetically() {
        let check = ServerUpdateCheck(
            available: true, version: "0.0.40",
            targets: [cli("kimi", "Kimi Code"), cli("claude", "Claude Code"), cli("opencode", "opencode"), cli("codex", "Codex")])
        let rows = UpdateTargets.build(check: check, serverVersion: "0.0.39")
        XCTAssertEqual(rows.map(\.id), ["server", "opencode", "claude", "codex", "kimi"])
        XCTAssertEqual(rows[0].label, "Manta Server")
        XCTAssertEqual(rows[0].current, "0.0.39")
        XCTAssertEqual(rows[0].latest, "0.0.40")
        XCTAssertTrue(rows[0].available)
        XCTAssertEqual(rows[0].disruption, "reconnect")
    }

    func testTheDesktopRowIsNeverPresent() {
        let check = ServerUpdateCheck(available: false, targets: [cli("desktop", "Manta Desktop"), cli("claude", "Claude Code")])
        let rows = UpdateTargets.build(check: check, serverVersion: "1")
        XCTAssertFalse(rows.contains { $0.id == "desktop" })
        XCTAssertEqual(rows.map(\.id), ["server", "claude"])
    }

    func testAnOldBoxWithNoTargetsHasJustTheServerRow() {
        let rows = UpdateTargets.build(check: ServerUpdateCheck(available: false), serverVersion: "1")
        XCTAssertEqual(rows.map(\.id), ["server"])
        XCTAssertTrue(rows[0].ok, "an old box's check has no `ok` — treated as true")
    }

    func testAFailedCheckIsNeverUpToDate() {
        let rows = UpdateTargets.build(check: nil, serverVersion: "1")
        XCTAssertFalse(rows[0].ok)
        XCTAssertEqual(UpdateTargets.describe(rows[0]).tone, .error)
        XCTAssertEqual(UpdateTargets.describe(rows[0]).text, "Couldn't check")
        // …and so is a verdict that says it could not determine.
        let notOk = UpdateTargets.build(check: ServerUpdateCheck(available: false, ok: false), serverVersion: "1")
        XCTAssertFalse(notOk[0].ok)
    }

    // MARK: - Row wording (order is the semantics)

    func testDescribeTonesAndText() {
        XCTAssertEqual(UpdateTargets.describe(UpdateTarget(id: "a", label: "A", ok: false)).tone, .error)
        // `!ok` wins even over `available` and `manual`.
        XCTAssertEqual(UpdateTargets.describe(UpdateTarget(id: "a", label: "A", available: true, ok: false, manual: true)).text,
                       "Couldn't check")
        let manual = UpdateTargets.describe(UpdateTarget(id: "a", label: "A", available: true, manual: true))
        XCTAssertEqual(manual.tone, .muted)
        XCTAssertEqual(manual.text, "Update manually")
        let available = UpdateTargets.describe(UpdateTarget(id: "a", label: "A", available: true))
        XCTAssertEqual(available.tone, .action)
        XCTAssertEqual(available.text, "Update available")
        let upToDate = UpdateTargets.describe(UpdateTarget(id: "a", label: "A"))
        XCTAssertEqual(upToDate.tone, .ok)
        XCTAssertEqual(upToDate.text, "Up to date")
    }

    func testHasUpdateNeedsOkAvailableAndNotManual() {
        XCTAssertTrue(UpdateTargets.hasUpdate(UpdateTarget(id: "a", label: "A", available: true)))
        XCTAssertFalse(UpdateTargets.hasUpdate(UpdateTarget(id: "a", label: "A", available: true, manual: true)))
        XCTAssertFalse(UpdateTargets.hasUpdate(UpdateTarget(id: "a", label: "A", available: true, ok: false)))
        XCTAssertFalse(UpdateTargets.hasUpdate(UpdateTarget(id: "a", label: "A")))
    }

    func testVersionText() {
        XCTAssertEqual(UpdateTargets.versionText(UpdateTarget(id: "a", label: "A", current: "1", latest: "2")), "1 → 2")
        XCTAssertEqual(UpdateTargets.versionText(UpdateTarget(id: "a", label: "A", current: "1", latest: "1")), "1")
        XCTAssertEqual(UpdateTargets.versionText(UpdateTarget(id: "a", label: "A", latest: "2")), "2")
        XCTAssertNil(UpdateTargets.versionText(UpdateTarget(id: "a", label: "A")))
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
