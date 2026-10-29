import XCTest
@testable import MantaUI

// ===========================================================================
// OpenCode V2 cutover, slice C4 — the iPhone's read-only "Your box is
// upgrading" screen. Pure decisions only: decoding the box's K3 object
// (`GET /api/upgrade` and `{kind:"upgrade"}` frames), the tolerance rules, the
// 503 refusal test, the state transitions, and what the screen says. No view,
// no HTTP, no box. Mirrors src/renderer/upgradeGateLogic.test.ts on the desktop.
//
// Foundation-only on purpose (UpgradeModels.swift is in the Linux SwiftPM
// package), so these run under `./verify.sh` as well as on the Mac.
// ===========================================================================

final class UpgradeModelsTests: XCTestCase {

    private func parse(_ json: String) -> UpgradeStatus? {
        UpgradeStatus.parse(Data(json.utf8))
    }

    // MARK: - K3 decoding

    func testDecodesAWellFormedRunningObject() throws {
        let s = try XCTUnwrap(parse("""
        {"state":"running","overall":0.42,"etaSeconds":240,"error":null,
         "steps":[
           {"id":"preflight","label":"Check disk","status":"done","progress":null},
           {"id":"copy","label":"Copy history","status":"running",
            "progress":{"label":"1 GB of 4 GB","numerator":25,"denominator":100}},
           {"id":"migrate","label":"Migrate","status":"pending","progress":null}
         ]}
        """))
        XCTAssertEqual(s.state, .running)
        XCTAssertEqual(s.overall, 0.42, accuracy: 0.0001)
        XCTAssertEqual(s.etaSeconds, 240)
        XCTAssertNil(s.error)
        XCTAssertEqual(s.steps.map(\.id), ["preflight", "copy", "migrate"])
        XCTAssertEqual(s.steps.map(\.status), [.done, .running, .pending])
        XCTAssertEqual(s.steps[1].progress, UpgradeProgress(label: "1 GB of 4 GB", numerator: 25, denominator: 100))
        XCTAssertNil(s.steps[0].progress)
    }

    func testDecodesAFailureWithDiskNumbers() throws {
        let s = try XCTUnwrap(parse("""
        {"state":"failed","overall":0.05,"etaSeconds":null,
         "steps":[{"id":"preflight","label":"Check disk","status":"failed","progress":null,"error":"no space"}],
         "error":{"step":"preflight","message":"Not enough free disk space","retryable":true,
                  "needBytes":33285996544,"haveBytes":3221225472}}
        """))
        XCTAssertEqual(s.state, .failed)
        XCTAssertEqual(s.error?.step, "preflight")
        XCTAssertEqual(s.error?.needBytes, 33_285_996_544)
        XCTAssertEqual(s.error?.haveBytes, 3_221_225_472)
        XCTAssertEqual(s.steps[0].error, "no space")
        XCTAssertNil(s.etaSeconds)
    }

    func testEveryWireStateDecodes() {
        let states: [(String, UpgradeState)] = [
            ("idle", .idle), ("running", .running), ("failed", .failed),
            ("completed", .completed), ("rolled_back", .rolledBack),
        ]
        for (wire, expected) in states {
            XCTAssertEqual(parse(#"{"state":"\#(wire)","steps":[],"overall":0}"#)?.state, expected, wire)
        }
    }

    /// A state this build does not know must NOT decode — a newer box can never
    /// flip the screen to something guessed.
    func testUnknownStateDoesNotDecode() {
        XCTAssertNil(parse(#"{"state":"exploding","steps":[],"overall":0}"#))
        XCTAssertNil(parse(#"{"steps":[]}"#))
        XCTAssertNil(parse(#"[1,2,3]"#))
        XCTAssertNil(parse("not json"))
    }

    func testMalformedPiecesAreRepairedNotFatal() throws {
        let s = try XCTUnwrap(parse("""
        {"state":"running","overall":7,"etaSeconds":-5,
         "steps":[
           {"id":"copy","status":"exploding","progress":{"numerator":"x","denominator":10,"label":""}},
           "garbage",
           {"label":"no id"}
         ],
         "error":{"message":"","retryable":"yes"}}
        """))
        XCTAssertEqual(s.steps.count, 1, "the malformed siblings are dropped, the good step kept")
        XCTAssertEqual(s.steps[0].status, .pending)
        XCTAssertEqual(s.steps[0].label, "Copy history", "a missing label falls back to the default")
        XCTAssertNil(s.steps[0].progress?.numerator)
        XCTAssertEqual(s.steps[0].progress?.denominator, 10)
        XCTAssertNil(s.steps[0].progress?.label, "an empty caption is no caption")
        XCTAssertEqual(s.overall, 1, "clamped to 0...1")
        XCTAssertNil(s.etaSeconds, "a negative estimate is no estimate")
        XCTAssertEqual(s.error?.message, "The upgrade failed.")
        XCTAssertEqual(s.error?.retryable, true)
    }

    func testRetryableIsOnlyFalseWhenExplicitlyFalse() throws {
        let f = try XCTUnwrap(parse(#"{"state":"failed","steps":[],"error":{"step":"migrate","message":"m","retryable":false}}"#))
        XCTAssertEqual(f.error?.retryable, false)
        let g = try XCTUnwrap(parse(#"{"state":"failed","steps":[],"error":{"step":"migrate","message":"m"}}"#))
        XCTAssertEqual(g.error?.retryable, true)
    }

    // MARK: - /events frames

    func testUpgradeFrameDecodesItsPayload() throws {
        let text = #"{"kind":"upgrade","payload":{"state":"running","steps":[{"id":"stop","label":"Stop","status":"running","progress":null}],"overall":0.1,"etaSeconds":null,"error":null}}"#
        let frame = try MantaStreamFrame.parse(text)
        let s = try XCTUnwrap(UpgradeStatus.from(frame: frame))
        XCTAssertEqual(s.state, .running)
        XCTAssertEqual(s.steps.first?.id, "stop")
    }

    func testOtherFramesAndGarbagePayloadsAreIgnored() throws {
        let other = try MantaStreamFrame.parse(#"{"kind":"usage.updated","payload":{"state":"running"}}"#)
        XCTAssertNil(UpgradeStatus.from(frame: other), "only kind:upgrade is read")
        let junk = try MantaStreamFrame.parse(#"{"kind":"upgrade","payload":{"hello":1}}"#)
        XCTAssertNil(UpgradeStatus.from(frame: junk), "a payload that is not K3 never flips the screen")
        let bare = try MantaStreamFrame.parse(#"{"kind":"upgrade"}"#)
        XCTAssertNil(UpgradeStatus.from(frame: bare))
    }

    // MARK: - The 503 refusal

    func testOnlyTheK3RefusalCounts() {
        let body = Data(#"{"error":"box upgrading","upgrade":true}"#.utf8)
        XCTAssertTrue(UpgradeStatus.isUpgradeRefusal(statusCode: 503, body: body))
        XCTAssertFalse(UpgradeStatus.isUpgradeRefusal(statusCode: 200, body: body))
        XCTAssertFalse(UpgradeStatus.isUpgradeRefusal(statusCode: 500, body: body))
        // A bare 503 from a proxy / overloaded box is not an upgrade.
        XCTAssertFalse(UpgradeStatus.isUpgradeRefusal(statusCode: 503, body: Data("Service Unavailable".utf8)))
        XCTAssertFalse(UpgradeStatus.isUpgradeRefusal(statusCode: 503, body: Data(#"{"error":"busy"}"#.utf8)))
        XCTAssertFalse(UpgradeStatus.isUpgradeRefusal(statusCode: 503, body: Data(#"{"upgrade":false}"#.utf8)))
    }

    // MARK: - Gate state transitions

    private func status(_ state: UpgradeState, steps: [UpgradeStep] = [], error: UpgradeFailure? = nil, view: UpgradeView? = nil) -> UpgradeStatus {
        UpgradeStatus(state: state, steps: steps, overall: 0.3, etaSeconds: nil, error: error, view: view)
    }

    func testNothingToShowForAnIdleOrOldBox() {
        var g = UpgradeGateState()
        XCTAssertNil(UpgradeScreenModel.make(g))
        g.apply(status: status(.idle))
        XCTAssertNil(UpgradeScreenModel.make(g))
        g.apply(status: nil) // 404: a box that predates the API
        XCTAssertNil(UpgradeScreenModel.make(g))
        XCTAssertFalse(g.isActive)
    }

    func testCompletedOpensTheApp() {
        var g = UpgradeGateState()
        g.apply(status: status(.running))
        XCTAssertNotNil(UpgradeScreenModel.make(g))
        g.apply(status: status(.completed))
        XCTAssertNil(UpgradeScreenModel.make(g))
    }

    func testA503WithNoStatusYetShowsWaiting() throws {
        var g = UpgradeGateState()
        g.markUpgradeMode()
        let m = try XCTUnwrap(UpgradeScreenModel.make(g))
        XCTAssertEqual(m.kind, .waiting)
        XCTAssertTrue(g.isActive)
    }

    func testAnAnswerThatSaysNotUpgradingClearsTheRefusalFlag() {
        for cleared in [status(.idle), status(.completed), nil] as [UpgradeStatus?] {
            var g = UpgradeGateState()
            g.markUpgradeMode()
            g.apply(status: cleared)
            XCTAssertFalse(g.upgradeModeSeen)
            XCTAssertNil(UpgradeScreenModel.make(g))
        }
    }

    func testRunningKeepsTheRefusalFlagButTheStatusDrivesTheView() throws {
        var g = UpgradeGateState()
        g.markUpgradeMode()
        g.apply(status: status(.running))
        XCTAssertTrue(g.upgradeModeSeen)
        XCTAssertEqual(try XCTUnwrap(UpgradeScreenModel.make(g)).kind, .running)
    }

    // MARK: - What the screen says

    func testNothingChangedOnlyForPreflight() throws {
        XCTAssertTrue(try failedModel(step: "preflight").nothingChanged)
        for step in ["stop", "copy", "migrate", "verify", "cutover"] {
            XCTAssertFalse(try failedModel(step: step).nothingChanged, step)
        }
    }

    func testOutcomesResetWhenTheBoxMovesToAnotherState() throws {
        var g = UpgradeGateState()
        g.apply(status: status(.failed, error: UpgradeFailure(step: "copy", message: "m")))
        g.actionStarted(.retry)
        XCTAssertEqual(g.retry, .pending)
        g.actionFinished(.retry, result: UpgradeActionResult(ok: true))
        XCTAssertEqual(g.retry, .ok)
        // The same state again (a poll) keeps the outcome…
        g.apply(status: status(.failed, error: UpgradeFailure(step: "copy", message: "m")))
        XCTAssertEqual(g.retry, .ok)
        // …but failed → running (the retry took) clears it.
        g.apply(status: status(.running))
        XCTAssertEqual(g.retry, .idle)
        XCTAssertEqual(g.rollback, .idle)
    }

    func testActionResultsBecomeOutcomes() {
        var g = UpgradeGateState()
        g.actionFinished(.rollback, result: UpgradeActionResult(ok: false, error: "no previous version"))
        XCTAssertEqual(g.rollback, .error("no previous version"))
        g.actionFinished(.rollback, result: UpgradeActionResult(ok: false))
        XCTAssertEqual(g.rollback, .error("The box refused the request."))
        g.actionFinished(.retry, result: UpgradeActionResult(ok: false, error: ""))
        XCTAssertEqual(g.retry, .error("The box refused the request."))
    }

    func testOutcomeLines() {
        XCTAssertEqual(UpgradeActionOutcome.ok.line(okText: "Retry requested"), "Retry requested")
        XCTAssertEqual(UpgradeActionOutcome.error("nope").line(okText: "x"), "nope")
        XCTAssertNil(UpgradeActionOutcome.idle.line(okText: "x"))
        XCTAssertNil(UpgradeActionOutcome.pending.line(okText: "x"))
        XCTAssertTrue(UpgradeActionOutcome.pending.isPending)
        XCTAssertTrue(UpgradeActionOutcome.error("e").isError)
    }

    func testTheModelCarriesTheOutcomes() throws {
        var g = UpgradeGateState()
        g.apply(status: status(.failed, error: UpgradeFailure(step: "copy", message: "m")))
        g.actionStarted(.rollback)
        let m = try XCTUnwrap(UpgradeScreenModel.make(g))
        XCTAssertEqual(m.rollback, .pending)
        XCTAssertEqual(m.retry, .idle)
    }

    // MARK: - The box's wording (WS11 D3 / X5)

    private func failedModel(step: String, view: UpgradeView? = nil, steps: [UpgradeStep]? = nil) throws -> UpgradeScreenModel {
        let failure = UpgradeFailure(step: step, message: "It broke")
        var g = UpgradeGateState()
        g.apply(status: status(.failed, steps: steps ?? [UpgradeStep(id: step, status: .failed)], error: failure, view: view))
        return try XCTUnwrap(UpgradeScreenModel.make(g))
    }

    func testRunningModelRendersTheBoxsView() throws {
        let steps = [
            UpgradeStep(id: "preflight", status: .done),
            UpgradeStep(id: "copy", status: .running, progress: UpgradeProgress(label: "1 GB of 4 GB", numerator: 25, denominator: 100)),
        ]
        let view = UpgradeView(kind: "running", currentStepId: "copy", currentFraction: 0.25, etaText: "about 4 min left", details: "Manta box upgrade — running")
        var g = UpgradeGateState()
        g.apply(status: status(.running, steps: steps, view: view))
        let m = try XCTUnwrap(UpgradeScreenModel.make(g))
        XCTAssertEqual(m.kind, .running)
        XCTAssertEqual(m.eta, "about 4 min left")
        XCTAssertEqual(m.currentStep?.id, "copy")
        XCTAssertEqual(try XCTUnwrap(m.currentFraction), 0.25, accuracy: 0.0001)
        XCTAssertEqual(m.details, "Manta box upgrade — running")
        XCTAssertEqual(m.steps.count, 2)
    }

    func testRunningOnAnOlderBoxShowsTheStepsWithoutEtaOrBar() throws {
        var g = UpgradeGateState()
        g.apply(status: status(.running, steps: [UpgradeStep(id: "stop", status: .running)]))
        let m = try XCTUnwrap(UpgradeScreenModel.make(g))
        XCTAssertNil(m.eta)
        XCTAssertNil(m.currentFraction)
        XCTAssertNil(m.currentStep)
        XCTAssertEqual(m.details, "")
    }

    func testFailedModelRendersTheBoxsDiskSentenceAndRetryRules() throws {
        let view = UpgradeView(kind: "failed", currentStepId: "preflight", details: "Manta box upgrade — failed",
                               failedStep: "preflight", message: "Not enough free disk space",
                               diskSentence: "Needs 31 GB free, has 3 GB.", retryLabel: "Check again",
                               canRetry: true, canRollback: false)
        let m = try failedModel(step: "preflight", view: view)
        XCTAssertEqual(m.message, "Not enough free disk space")
        XCTAssertEqual(m.disk, "Needs 31 GB free, has 3 GB.")
        XCTAssertEqual(m.retryLabel, "Check again")
        XCTAssertEqual(m.retryOkText, "Checking again…")
        XCTAssertTrue(m.canRetry)
        XCTAssertFalse(m.canRollback)
        XCTAssertTrue(m.nothingChanged)
        XCTAssertFalse(m.needsBoxUpdate)
        XCTAssertEqual(m.details, "Manta box upgrade — failed")
        XCTAssertNil(m.hint)
    }

    func testAnUnretryableFailureDisablesRetryWithTheBoxsReason() throws {
        let view = UpgradeView(kind: "failed", failedStep: "migrate", retryLabel: "Retry", canRetry: false,
                               retryDisabledReason: "This failure can't be retried — roll back instead.", canRollback: true)
        let m = try failedModel(step: "migrate", view: view)
        XCTAssertFalse(m.canRetry)
        XCTAssertEqual(m.retryDisabledReason, "This failure can't be retried — roll back instead.")
        XCTAssertTrue(m.canRollback)
        XCTAssertFalse(m.nothingChanged)
    }

    func testFailedOnAnOlderBoxStillOffersRetryButNotRollbackAndSaysWhy() throws {
        let m = try failedModel(step: "migrate")
        XCTAssertEqual(m.message, "It broke")
        XCTAssertTrue(m.canRetry, "never a dead end: the box refuses a retry it cannot do with its own sentence")
        XCTAssertFalse(m.canRollback)
        XCTAssertTrue(m.needsBoxUpdate)
        XCTAssertEqual(m.failedStep, "migrate")
        XCTAssertEqual(m.details, "")
    }

    func testFailedFallsBackToTheFailedStepsOwnError() throws {
        var g = UpgradeGateState()
        g.apply(status: status(.failed, steps: [UpgradeStep(id: "copy", status: .failed, error: "disk went away")]))
        XCTAssertEqual(try XCTUnwrap(UpgradeScreenModel.make(g)).message, "disk went away")
    }

    func testTheWaitingStateHasNoDetails() throws {
        var g = UpgradeGateState()
        g.markUpgradeMode()
        XCTAssertEqual(try XCTUnwrap(UpgradeScreenModel.make(g)).details, "")
    }

    func testRolledBackModel() throws {
        var g = UpgradeGateState()
        g.apply(status: status(.rolledBack, view: UpgradeView(kind: "rolled_back", details: "Manta box upgrade — rolled back")))
        let m = try XCTUnwrap(UpgradeScreenModel.make(g))
        XCTAssertEqual(m.kind, .rolledBack)
        XCTAssertEqual(m.title, "Your box was rolled back")
        XCTAssertNil(m.overall)
        XCTAssertEqual(m.details, "Manta box upgrade — rolled back")
    }

    func testTheViewDecodesFromTheWire() throws {
        let s = try XCTUnwrap(parse(#"{"state":"failed","steps":[],"overall":0,"etaSeconds":null,"error":{"step":"preflight","message":"m","retryable":true},"view":{"kind":"failed","failedStep":"preflight","message":"m","diskSentence":"Needs 31 GB free.","retryLabel":"Check again","canRetry":true,"canRollback":false,"details":"d"}}"#))
        XCTAssertEqual(s.view?.diskSentence, "Needs 31 GB free.")
        XCTAssertEqual(s.view?.retryLabel, "Check again")
        let old = try XCTUnwrap(parse(#"{"state":"running","steps":[],"overall":0,"etaSeconds":null,"error":null}"#))
        XCTAssertNil(old.view)
    }
}
