import XCTest
@testable import MantaUI

// ===========================================================================
// OpenCode V2 cutover, slice C4 — the iPhone's read-only "Your box is
// upgrading" screen. Pure decisions only: decoding the box's K3 object
// (`GET /api/upgrade` and `{kind:"upgrade"}` frames), the tolerance rules, the
// 503 refusal test, the state transitions, and what the screen says. No view,
// no HTTP, no box. Mirrors src/renderer/upgradeGate.test.ts on the desktop.
//
// Foundation-only on purpose (UpgradeModels.swift is in the Linux SwiftPM
// package), so these run under `./verify.sh` as well as on the Mac.
// ===========================================================================

final class UpgradeModelsTests: XCTestCase {

    private let GiB = 1_073_741_824.0

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

    private func status(_ state: UpgradeState, steps: [UpgradeStep] = [], error: UpgradeFailure? = nil) -> UpgradeStatus {
        UpgradeStatus(state: state, steps: steps, overall: 0.3, etaSeconds: nil, error: error)
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

    func testRunningModelCarriesStepsOverallEtaAndTheCurrentBar() throws {
        let steps = [
            UpgradeStep(id: "preflight", status: .done),
            UpgradeStep(id: "copy", status: .running,
                        progress: UpgradeProgress(label: "1 GB of 4 GB", numerator: 25, denominator: 100)),
            UpgradeStep(id: "migrate", status: .pending),
        ]
        var s = status(.running, steps: steps)
        s.etaSeconds = 240
        var g = UpgradeGateState()
        g.apply(status: s)
        let m = try XCTUnwrap(UpgradeScreenModel.make(g))
        XCTAssertEqual(m.kind, .running)
        XCTAssertEqual(m.title, "Your box is upgrading")
        XCTAssertEqual(m.overall, 0.3)
        XCTAssertEqual(m.eta, "about 4 min left")
        XCTAssertEqual(m.currentStep?.id, "copy")
        XCTAssertEqual(try XCTUnwrap(m.currentFraction), 0.25, accuracy: 0.0001)
        XCTAssertEqual(m.steps.count, 3)
    }

    func testAStepWithoutMeasurableProgressIsIndeterminate() throws {
        var g = UpgradeGateState()
        g.apply(status: status(.running, steps: [UpgradeStep(id: "stop", status: .running)]))
        let m = try XCTUnwrap(UpgradeScreenModel.make(g))
        XCTAssertNil(m.currentFraction)
        XCTAssertEqual(m.currentStep?.id, "stop")
    }

    func testFailedModelShowsTheMessageTheDiskNumbersAndWhereToAct() throws {
        let failure = UpgradeFailure(step: "preflight", message: "Not enough free disk space",
                                     needBytes: 31 * GiB, haveBytes: 3 * GiB)
        var g = UpgradeGateState()
        g.apply(status: status(.failed, steps: [UpgradeStep(id: "preflight", status: .failed)], error: failure))
        let m = try XCTUnwrap(UpgradeScreenModel.make(g))
        XCTAssertEqual(m.kind, .failed)
        XCTAssertEqual(m.message, "Not enough free disk space")
        XCTAssertEqual(m.disk, "needs 31 GB free, has 3 GB")
        XCTAssertEqual(m.hint, "Open Manta on your computer to retry or roll back.")
    }

    func testFailedFallsBackToTheFailedStepsOwnError() throws {
        var g = UpgradeGateState()
        g.apply(status: status(.failed, steps: [UpgradeStep(id: "copy", status: .failed, error: "disk went away")]))
        XCTAssertEqual(try XCTUnwrap(UpgradeScreenModel.make(g)).message, "disk went away")
    }

    func testRolledBackModel() throws {
        var g = UpgradeGateState()
        g.apply(status: status(.rolledBack))
        let m = try XCTUnwrap(UpgradeScreenModel.make(g))
        XCTAssertEqual(m.kind, .rolledBack)
        XCTAssertEqual(m.title, "Your box was rolled back")
        XCTAssertNil(m.overall)
    }

    // MARK: - Formatting

    func testDiskText() {
        XCTAssertEqual(UpgradePresentation.diskText(UpgradeFailure(step: "p", message: "m", needBytes: 31 * GiB, haveBytes: 3 * GiB)),
                       "needs 31 GB free, has 3 GB")
        XCTAssertEqual(UpgradePresentation.diskText(UpgradeFailure(step: "p", message: "m", needBytes: 31 * GiB)),
                       "needs 31 GB free")
        XCTAssertEqual(UpgradePresentation.diskText(UpgradeFailure(step: "p", message: "m", needBytes: 5 * GiB, haveBytes: 0)),
                       "needs 5 GB free, has 0 B")
        XCTAssertNil(UpgradePresentation.diskText(UpgradeFailure(step: "migrate", message: "m")))
        XCTAssertNil(UpgradePresentation.diskText(nil))
    }

    func testBytesMatchTheDesktopsFormatting() {
        XCTAssertEqual(UpgradePresentation.bytes(512), "512 B")
        XCTAssertEqual(UpgradePresentation.bytes(1.5 * GiB), "1.5 GB")
        XCTAssertEqual(UpgradePresentation.bytes(31 * GiB), "31 GB")
        XCTAssertEqual(UpgradePresentation.bytes(2 * 1024 * GiB), "2 TB")
    }

    func testEtaText() {
        XCTAssertNil(UpgradePresentation.etaText(nil))
        XCTAssertEqual(UpgradePresentation.etaText(10), "less than a minute left")
        XCTAssertEqual(UpgradePresentation.etaText(240), "about 4 min left")
        XCTAssertEqual(UpgradePresentation.etaText(3600), "about 1 h left")
        XCTAssertEqual(UpgradePresentation.etaText(5400), "about 1 h 30 min left")
    }

    func testFractionClampsAndRefusesAZeroDenominator() {
        func step(_ p: UpgradeProgress?) -> UpgradeStep { UpgradeStep(id: "copy", status: .running, progress: p) }
        XCTAssertNil(UpgradePresentation.fraction(step(UpgradeProgress(numerator: 5, denominator: 0))))
        XCTAssertEqual(UpgradePresentation.fraction(step(UpgradeProgress(numerator: 500, denominator: 100))), 1)
        XCTAssertNil(UpgradePresentation.fraction(step(UpgradeProgress(label: "x"))))
        XCTAssertNil(UpgradePresentation.fraction(nil))
    }

    func testSentenceCapitalisesAndTerminates() {
        XCTAssertEqual(UpgradePresentation.sentence("needs 31 GB free, has 3 GB"), "Needs 31 GB free, has 3 GB.")
        XCTAssertEqual(UpgradePresentation.sentence(""), "")
    }
}
