import XCTest
@testable import MantaUI

// WS10 F7 — Restore windows: the preview state, the desktop's strings, and when
// Restore may be offered. Pure, Foundation-only.

final class SettingsBackupTests: XCTestCase {

    private func preview(
        available: Bool = true, capturedAt: Double? = 1_700_000_000_000,
        ops: [TopologyRestoreOp] = [], skipped: [TopologyRestoreSkipped] = [], restorable: Int? = nil
    ) -> TopologyRestorePreview {
        TopologyRestorePreview(available: available, capturedAt: capturedAt, ops: ops, skipped: skipped, restorable: restorable)
    }

    private let census = (
        ops: [TopologyRestoreOp(tmuxSession: "alpha", index: 1), TopologyRestoreOp(tmuxSession: "alpha", index: 2)],
        skipped: [TopologyRestoreSkipped(tmuxSession: "beta", index: 0, reason: "already-restored")]
    )

    // MARK: - Census

    func testWindowsAndProjectsCountPlannedAndSkipped() {
        let p = preview(ops: census.ops, skipped: census.skipped)
        XCTAssertEqual(BackupSummary.windows(p), 3)
        XCTAssertEqual(BackupSummary.projects(p), 2)
    }

    // MARK: - Strings (desktop Settings.tsx)

    func testStatusLinesMatchTheDesktop() {
        let p = preview(ops: census.ops, skipped: census.skipped)
        XCTAssertEqual(BackupSummary.lastBackupLine(p, formatDate: { _ in "Nov 14" }),
                       "Last backup Nov 14 · 3 windows across 2 projects")
        XCTAssertEqual(BackupSummary.restorableLine(p), "2 window(s) can be restored.")
        XCTAssertEqual(BackupSummary.statusLine(p, formatDate: { _ in "Nov 14" }),
                       "Last backup Nov 14 · 3 windows across 2 projects\n2 window(s) can be restored.")
    }

    func testNothingToRestoreWording() {
        let p = preview(ops: [], skipped: census.skipped, restorable: 0)
        XCTAssertEqual(BackupSummary.restorableLine(p), "Every saved window is already open.")
    }

    func testNoCaptureTimeOmitsTheLastBackupLine() {
        let p = preview(capturedAt: nil, ops: census.ops)
        XCTAssertNil(BackupSummary.lastBackupLine(p, formatDate: { _ in "x" }))
        XCTAssertEqual(BackupSummary.statusLine(p, formatDate: { _ in "x" }), "2 window(s) can be restored.")
    }

    func testNoBackupYet() {
        let p = preview(available: false, capturedAt: nil)
        XCTAssertEqual(BackupSummary.statusLine(p, formatDate: { _ in "x" }),
                       "No backup yet. Manta saves your window layout automatically as you work.")
    }

    // MARK: - Restore availability

    func testLoadingOffersNoRestore() {
        XCTAssertFalse(BackupSummary.showsRestore(.loading))
        XCTAssertFalse(BackupSummary.restoreEnabled(.loading))
    }

    func testLoadedWithSomethingToRestoreOffersAnEnabledRestore() {
        let state = BackupPreviewState.loaded(preview(ops: census.ops))
        XCTAssertTrue(BackupSummary.showsRestore(state))
        XCTAssertTrue(BackupSummary.restoreEnabled(state))
    }

    func testLoadedWithZeroRestorableShowsButDisablesRestore() {
        let state = BackupPreviewState.loaded(preview(ops: [], skipped: census.skipped, restorable: 0))
        XCTAssertTrue(BackupSummary.showsRestore(state))
        XCTAssertFalse(BackupSummary.restoreEnabled(state))
    }

    func testLoadedWithNoBackupHidesRestore() {
        let state = BackupPreviewState.loaded(preview(available: false, capturedAt: nil))
        XCTAssertFalse(BackupSummary.showsRestore(state))
        XCTAssertFalse(BackupSummary.restoreEnabled(state))
    }

    /// A failed preview — including a refresh that fails AFTER an earlier success —
    /// is `.failed`: Restore is hidden, never offered against a stale preview.
    func testFailedPreviewHidesRestore() {
        var state = BackupPreviewState.loaded(preview(ops: census.ops))
        XCTAssertTrue(BackupSummary.showsRestore(state))
        state = .failed("The box didn't answer.")
        XCTAssertFalse(BackupSummary.showsRestore(state))
        XCTAssertFalse(BackupSummary.restoreEnabled(state))
    }

    // MARK: - Outcome

    func testRestoreOutcomeUsesTheBoxsMessage() {
        let ok = BackupSummary.restoreOutcome(TopologyRestoreResult(ok: true, created: 2, failed: 0, message: "Restored 2 windows."))
        XCTAssertTrue(ok.ok)
        XCTAssertEqual(ok.text, "Restored 2 windows.")
    }

    func testRestoreOutcomeFallsBackToTheDefaultMessage() {
        XCTAssertEqual(BackupSummary.restoreOutcome(TopologyRestoreResult(ok: true)).text, "Windows restored.")
        XCTAssertEqual(BackupSummary.restoreOutcome(TopologyRestoreResult(ok: true, message: "")).text, "Windows restored.")
    }

    func testRestoreFailureCarriesTheReason() {
        let out = BackupSummary.restoreOutcome(TopologyRestoreResult(ok: false, error: "No saved window layout to restore from."))
        XCTAssertFalse(out.ok)
        XCTAssertEqual(out.text, "Couldn't restore your windows. No saved window layout to restore from.")
        XCTAssertEqual(BackupSummary.restoreOutcome(TopologyRestoreResult(ok: false)).text,
                       "Couldn't restore your windows. unknown error")
    }

    // MARK: - Wire

    func testPreviewDecodesTheBoxsShape() throws {
        let json = """
        {"available":true,"capturedAt":1700000000000,
         "ops":[{"kind":"create-window","tmuxSession":"alpha","mantaOwned":true,"index":1,"name":"api",
                 "opencodeSessionId":"ses_1","cwd":"/home/dev/x","worktreePath":null}],
         "skipped":[{"tmuxSession":"beta","index":0,"name":"w","opencodeSessionId":"ses_2","reason":"already-restored"}],
         "restorable":1}
        """
        let p = try JSONDecoder().decode(TopologyRestorePreview.self, from: Data(json.utf8))
        XCTAssertTrue(p.available)
        XCTAssertEqual(p.capturedAt, 1_700_000_000_000)
        XCTAssertEqual(p.ops.map(\.tmuxSession), ["alpha"])
        XCTAssertEqual(p.skipped.first?.reason, "already-restored")
        XCTAssertEqual(p.restorable, 1)
    }

    func testPreviewWithNoSnapshotDecodes() throws {
        let json = #"{"available":false,"capturedAt":null,"ops":[],"skipped":[],"restorable":0}"#
        let p = try JSONDecoder().decode(TopologyRestorePreview.self, from: Data(json.utf8))
        XCTAssertFalse(p.available)
        XCTAssertNil(p.capturedAt)
        XCTAssertEqual(p.restorable, 0)
    }
}
