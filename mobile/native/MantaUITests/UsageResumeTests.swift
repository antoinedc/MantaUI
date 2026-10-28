import XCTest
@testable import MantaUI

// WS09 F6 — decoding of `usage-stopped:view` / `usage-stopped:apply` (real output of
// src/server/usageResumeView.mjs) and the view arithmetic that stays on the phone.

private enum ResumeFx {
    static let view = #"""
{"supported":true,"title":"Resume after limit reset","header":"1 armed · 2 stopped since you last looked.","hasArmed":true,"unarmedCount":1,"totalCount":2,"emptyText":"No conversations are stopped by a provider limit right now.","groups":[{"workspace":"manta","rows":[{"conversation":"ses_1","name":"fix login","armed":false,"isNew":true,"snippet":"I updated the guard…","provider":"claude","model":"claude-opus-4-7","window":{"label":"Weekly","resetsAt":1000086400000},"cost":{"warm":false,"reReadTokens":340000,"label":"≈ 340k tokens re-read"}},{"conversation":"ses_2","name":"ses_2","armed":true,"isNew":true,"snippet":null,"provider":"claude","model":"claude-opus-4-7","window":{"label":"Session","resetsAt":null},"cost":{"warm":false,"reReadTokens":340000,"label":"≈ 340k tokens re-read"}}]}],"coldNote":{"one":"One of these resets well past your prompt-cache window, so its history is re-read from scratch. The estimate is per conversation above.","many":"{n} of these reset well past your prompt-cache window, so their history is re-read from scratch. The estimate is per conversation above."}}
"""#
    static let dryRun = #"""
{"arm":["ses_1"],"disarm":["ses_2"],"canApply":true,"title":"Update","ok":true}
"""#
    static let applyFailed = #"""
{"ok":true,"canApply":true,"title":"Update","arm":["ses_1"],"disarm":[],"applied":{"armed":[],"disarmed":[]},"failed":[{"conversation":"ses_1","name":"fix login","message":"Couldn't update fix login — boom. The ones after it weren't changed."}],"message":"Couldn't update fix login — boom."}
"""#
    static let applyDone = #"""
{"ok":true,"canApply":false,"title":"","arm":[],"disarm":[],"applied":{"armed":["ses_1"],"disarmed":[]},"failed":[],"message":"Updated — 1 conversation will carry on at reset."}
"""#
}

final class UsageResumeTests: XCTestCase {

    private func view() throws -> UsageResumeViewWire {
        try JSONDecoder().decode(UsageResumeViewWire.self, from: Data(ResumeFx.view.utf8))
    }

    func testDecodeView() throws {
        let v = try view()
        XCTAssertEqual(v.title, "Resume after limit reset")
        XCTAssertTrue(v.hasArmed)
        XCTAssertEqual(v.unarmedCount, 1)
        XCTAssertEqual(v.totalCount, 2)
        XCTAssertEqual(v.groups.map(\.workspace), ["manta"])
        XCTAssertEqual(v.rows.map(\.conversation), ["ses_1", "ses_2"])
        let first = v.rows[0]
        XCTAssertEqual(first.name, "fix login")
        XCTAssertTrue(first.isNew)
        XCTAssertEqual(first.snippet, "I updated the guard…")
        XCTAssertEqual(first.window.label, "Weekly")
        XCTAssertEqual(first.window.resetsAt, 1_000_086_400_000)
        XCTAssertEqual(first.cost.reReadTokens, 340_000)
        XCTAssertFalse(first.cost.warm)
        let second = v.rows[1]
        XCTAssertTrue(second.armed)
        XCTAssertNil(second.snippet)
        XCTAssertNil(second.window.resetsAt)
        XCTAssertTrue(v.coldNote.many.contains("{n}"))
    }

    func testDecodePlansAndApplyReplies() throws {
        let dry = try JSONDecoder().decode(UsageResumePlanWire.self, from: Data(ResumeFx.dryRun.utf8))
        XCTAssertTrue(dry.canApply)
        XCTAssertEqual(dry.title, "Update")
        XCTAssertEqual(dry.arm, ["ses_1"])
        XCTAssertEqual(dry.disarm, ["ses_2"])
        XCTAssertNil(dry.failed)

        let failed = try JSONDecoder().decode(UsageResumePlanWire.self, from: Data(ResumeFx.applyFailed.utf8))
        XCTAssertEqual(failed.failed?.first?.conversation, "ses_1")
        XCTAssertEqual(failed.failed?.first?.name, "fix login")

        let done = try JSONDecoder().decode(UsageResumePlanWire.self, from: Data(ResumeFx.applyDone.utf8))
        XCTAssertEqual(done.applied?.armed, ["ses_1"])
        XCTAssertEqual(done.failed?.isEmpty, true)
        XCTAssertEqual(done.message, "Updated — 1 conversation will carry on at reset.")
    }

    func testFooterTextForZeroWarmAndMixedSelections() throws {
        let rows = try view().rows
        XCTAssertEqual(UsageResumeFooter.text(selectedRows: []), "0 selected · no extra cost")
        XCTAssertEqual(UsageResumeFooter.text(selectedRows: [rows[0]]), "1 selected · ≈ 340k re-read")
        XCTAssertEqual(UsageResumeFooter.text(selectedRows: rows), "2 selected · ≈ 680k re-read")
        var warm = rows[0]
        warm.cost = UsageResumeRowWire.Cost(warm: true, reReadTokens: 0, label: "cache still warm · no extra cost")
        XCTAssertEqual(UsageResumeFooter.text(selectedRows: [warm]), "1 selected · no extra cost")
        XCTAssertEqual(UsageResumeFooter.text(selectedRows: [warm, rows[1]]), "2 selected · ≈ 340k re-read")
    }

    func testColdCountAndNote() throws {
        let v = try view()
        var warm = v.rows[0]
        warm.cost = UsageResumeRowWire.Cost(warm: true, reReadTokens: 0, label: "warm")
        XCTAssertEqual(UsageResumeFooter.coldCount(selectedRows: [warm]), 0)
        XCTAssertEqual(UsageResumeFooter.coldCount(selectedRows: [warm, v.rows[1]]), 1)
        XCTAssertNil(UsageResumeFooter.coldNote(v.coldNote, count: 0))
        XCTAssertEqual(UsageResumeFooter.coldNote(v.coldNote, count: 1), v.coldNote.one)
        XCTAssertTrue(UsageResumeFooter.coldNote(v.coldNote, count: 3)?.hasPrefix("3 of these reset") == true)
    }

    func testSelectionReconcile() {
        // pristine: the selection tracks the armed rows
        XCTAssertEqual(UsageResumeSelection.reconcile(selected: ["x"], pristine: true, viewIDs: ["a", "b"], armedIDs: ["b"]), ["b"])
        // touched: vanished rows leave, other choices stay, new rows are not auto-selected
        XCTAssertEqual(UsageResumeSelection.reconcile(selected: ["a", "gone"], pristine: false, viewIDs: ["a", "b", "new"], armedIDs: ["b"]), ["a"])
        XCTAssertEqual(UsageResumeSelection.reconcile(selected: [], pristine: false, viewIDs: ["a"], armedIDs: ["a"]), [])
    }
}
