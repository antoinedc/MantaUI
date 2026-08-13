import XCTest
@testable import MantaUI

final class BranchLabelTests: XCTestCase {

    // MARK: - Unchanged when it fits

    /// A short branch name is returned unchanged.
    func testShortNameUnchanged() {
        XCTAssertEqual(BranchLabel.display("main"), "main")
    }

    /// A branch that fits within the default budget is returned unchanged —
    /// no leading ellipsis is added.
    func testBranchWithinBudgetUnchanged() {
        XCTAssertEqual(BranchLabel.display("multica/BET-781"), "multica/BET-781")
    }

    // MARK: - Head-first truncation

    /// A branch that exceeds the budget keeps its distinguishing TAIL with a
    /// leading ellipsis — never the front namespace.
    func testLongNameKeepsTailAndGainsEllipsis() {
        let long = "multica/BET-781-a-really-quite-reasonably-long-branch"
        let result = BranchLabel.display(long)
        XCTAssertTrue(result.hasPrefix("…"))
        XCTAssertFalse(result.hasPrefix("multica/"), "the leading namespace must be dropped")
        XCTAssertEqual(result, "…" + long.suffix(result.count - 1), "the tail must survive verbatim")
    }

    /// The result never exceeds the default 28-char budget.
    func testLongNameRespectsBudget() {
        let long = "multica/BET-781-a-really-quite-reasonably-long-branch"
        let result = BranchLabel.display(long)
        XCTAssertLessThanOrEqual(result.count, 28)
    }

    /// A custom budget is honoured.
    func testCustomMaxChars() {
        let branch = "multica/feature-deploy-pipeline-hardening"
        let result = BranchLabel.display(branch, maxChars: 16)
        XCTAssertLessThanOrEqual(result.count, 16)
        XCTAssertTrue(result.hasPrefix("…"))
        XCTAssertTrue(result.hasSuffix("hardening"), "the final segment survives")
    }

    // MARK: - Empty

    /// Empty in → empty out (no bare ellipsis).
    func testEmptyInEmptyOut() {
        XCTAssertEqual(BranchLabel.display(""), "")
    }
}
