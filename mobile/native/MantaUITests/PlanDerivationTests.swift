import XCTest
@testable import MantaUI

// ===========================================================================
// BET-1026 — the Swift port of src/renderer/chatUtils.ts's plan-card helpers
// (isPlanExitQuestion / extractPlanData / planRefsFromPart, lines 2140-2307)
// plus the deterministic plan-page URL rule from src/shared/planMode.mjs.
//
// These tests are the oracle that keeps the iOS plan card in sync with the
// desktop panel. The detection rule is pinned by test: the plan card matches
// the question's `tool.callID` against a `plan_exit` tool part — NEVER the
// question's wording.
// ===========================================================================

final class PlanDerivationTests: XCTestCase {

    private func message(role: String = "assistant", id: String = "m1",
                         parts: [OpencodePart]) -> OpencodeMessage {
        OpencodeMessage(
            info: OpencodeMessageInfo(
                id: id, sessionID: "ses_1", role: OpencodeRole(rawValue: role),
                time: OpencodeTime(created: 1750000000000)),
            parts: parts)
    }

    private func question(callID: String?, header: String = "Build Agent",
                          questionText: String = "Plan complete. Proceed?") -> QuestionRequest {
        QuestionRequest(
            id: "q1",
            sessionID: "ses_1",
            questions: [QuestionInfo(question: questionText, header: header, options: [])],
            tool: callID.map { PermissionTool(messageID: "m1", callID: $0) },
            requestId: "que_1")
    }

    private func toolPart(tool: String, callID: String,
                          input: [String: JSONValue]? = nil,
                          files: [String]? = nil) -> OpencodePart {
        var extra: [String: JSONValue] = [:]
        extra["tool"] = .string(tool)
        if !callID.isEmpty { extra["callID"] = .string(callID) }
        if let input {
            extra["state"] = .object([
                "status": .string("completed"),
                "input": .object(input),
            ])
        }
        if let files {
            extra["files"] = .array(files.map(JSONValue.string))
        }
        return OpencodePart(type: "tool", id: "p-\(tool)-\(callID)", messageID: "m1", extra: extra)
    }

    // MARK: - isPlanExitQuestion

    /// True ONLY when the question's `tool.callID` matches a `plan_exit` tool
    /// part in the transcript.
    func testTrueWhenCallIDMatchesPlanExitPart() {
        let q = question(callID: "call-exit")
        let msg = message(parts: [
            toolPart(tool: "read", callID: "call-read"),
            toolPart(tool: "plan_exit", callID: "call-exit"),
        ])
        XCTAssertTrue(PlanDerivation.isPlanExitQuestion(q, in: [msg]))
    }

    /// False when the matching callID belongs to a DIFFERENT tool.
    func testFalseWhenCallIDBelongsToDifferentTool() {
        let q = question(callID: "call-exit")
        let msg = message(parts: [toolPart(tool: "edit", callID: "call-exit")])
        XCTAssertFalse(PlanDerivation.isPlanExitQuestion(q, in: [msg]))
    }

    /// False for a non-plan question whose callID matches a non-plan tool.
    func testFalseForNonPlanQuestion() {
        let q = question(callID: "call-read")
        let msg = message(parts: [
            toolPart(tool: "read", callID: "call-read"),
            toolPart(tool: "plan_exit", callID: "call-exit"),
        ])
        XCTAssertFalse(PlanDerivation.isPlanExitQuestion(q, in: [msg]))
    }

    /// False when the question carries no tool (an orphaned/recovered question
    /// cannot be matched — a callID is required).
    func testFalseWhenQuestionHasNoTool() {
        let q = question(callID: nil)
        let msg = message(parts: [toolPart(tool: "plan_exit", callID: "call-exit")])
        XCTAssertFalse(PlanDerivation.isPlanExitQuestion(q, in: [msg]))
    }

    /// False when NO part matches the callID, even though a plan_exit part
    /// exists with a different callID — the question text mentioning "plan" is
    /// never consulted. Pins the "never match on wording" rule.
    func testFalseWhenQuestionTextMentionsPlanButCallIDMatchesNothing() {
        let q = question(callID: "call-other", questionText: "Plan is complete — build it?")
        let msg = message(parts: [toolPart(tool: "plan_exit", callID: "call-exit")])
        XCTAssertFalse(PlanDerivation.isPlanExitQuestion(q, in: [msg]))
    }

    /// The tolerant tool-name read: a name nested under `state.input.tool`
    /// (the reconciled transcript shape) still matches even when the part
    /// carries no direct `tool` field.
    func testTrueWithNestedStateInputToolShape() {
        let q = question(callID: "call-exit")
        let part = OpencodePart(
            type: "tool", id: "p", messageID: "m1",
            extra: [
                "callID": .string("call-exit"),
                "state": .object([
                    "status": .string("completed"),
                    "input": .object(["tool": .string("plan_exit")]),
                ]),
            ])
        XCTAssertTrue(PlanDerivation.isPlanExitQuestion(q, in: [message(parts: [part])]))
    }

    // MARK: - planMetrics

    /// Counts steps (markdown "Step …" headings) and files (bulleted code
    /// spans) on a representative plan body.
    func testCountsStepsAndFiles() {
        let body = """
        # Add login

        ## Step 1: scaffold
        - `src/auth.ts`

        ## Step 2: wire route
        - `src/routes/auth.ts`
        - `src/views/Login.tsx`

        ## Files
        - affected `README.md`
        """
        let m = PlanDerivation.planMetrics(body)
        XCTAssertEqual(m.steps, 2)
        XCTAssertEqual(m.files, 4)
    }

    /// Empty input yields zeros — never a crash.
    func testEmptyInputYieldsZeros() {
        let m = PlanDerivation.planMetrics("")
        XCTAssertEqual(m.steps, 0)
        XCTAssertEqual(m.files, 0)
    }

    // MARK: - extractPlanData / path recovery

    /// Recovers the plan path from the transcript when the `plan_exit` part
    /// carries none — the plan was authored by the `write` tool, which stashed
    /// the path in its own input.
    func testRecoversPathFromAuthoringTool() {
        let q = question(callID: "call-exit")
        let msg = message(parts: [
            toolPart(tool: "write", callID: "call-write",
                     input: ["filePath": .string(".opencode/plans/2026-01-01-add-login.md")]),
            toolPart(tool: "plan_exit", callID: "call-exit",
                     input: ["plan": .string("# Add login\n## Step 1\n- `src/a.ts`")]),
        ])
        let d = PlanDerivation.extractPlanData(q, in: [msg])
        XCTAssertEqual(d.path, ".opencode/plans/2026-01-01-add-login.md")
        XCTAssertEqual(d.title, "Add login")
        XCTAssertTrue(d.text.contains("## Step 1"))
    }

    /// A nil path (not a crash) when the transcript has no discoverable plan
    /// reference. Tolerant: the card still gets a title from the plan text.
    func testNilPathWhenNothingFound() {
        let q = question(callID: "call-exit")
        let msg = message(parts: [
            toolPart(tool: "plan_exit", callID: "call-exit",
                     input: ["plan": .string("# Some Plan")]),
        ])
        let d = PlanDerivation.extractPlanData(q, in: [msg])
        XCTAssertNil(d.path)
        XCTAssertEqual(d.title, "Some Plan")
    }

    /// Title extraction handles a plan whose FIRST line is not a heading (and
    /// which has no heading at all) — the first non-empty line becomes title.
    func testTitleWhenFirstLineNotHeading() {
        let q = question(callID: "call-exit")
        let msg = message(parts: [
            toolPart(tool: "plan_exit", callID: "call-exit",
                     input: ["plan": .string("We will add login.\nThen wire the route.")]),
        ])
        let d = PlanDerivation.extractPlanData(q, in: [msg])
        XCTAssertEqual(d.title, "We will add login.")
    }

    /// Falls back to the question header when the plan text is empty.
    func testTitleFallsBackToQuestionHeader() {
        let q = question(callID: "call-exit", header: "Build Agent", questionText: "Switch to build agent?")
        let d = PlanDerivation.extractPlanData(q, in: [])
        XCTAssertEqual(d.title, "Build Agent")
        XCTAssertEqual(d.text, "")
    }

    // MARK: - planRefs / planPaths

    /// Dedupes identical refs across a part and collects them from text, tool
    /// input and patch files, while a `read` reference is not an authoring
    /// signal.
    func testPlanRefsFromPartScansTextInputAndFiles() {
        let a = toolPart(tool: "write", callID: "c1",
                         input: ["filePath": .string(".opencode/plans/b.md")])
        let b = toolPart(tool: "multiEdit", callID: "c2",
                         files: [".opencode/plans/c.md", ".opencode/plans/c.md"])
        XCTAssertEqual(PlanDerivation.planRefsFromPart(a), [".opencode/plans/b.md"])
        XCTAssertEqual(PlanDerivation.planRefsFromPart(b), [".opencode/plans/c.md"])

        // A `read` pointing at a plan path is a reference, not an authoring
        // signal — and does not resolve.
        let r = toolPart(tool: "read", callID: "c3",
                         input: ["filePath": .string(".opencode/plans/ignored.md")])
        XCTAssertEqual(PlanDerivation.planRefsFromPart(r), [])
    }

    // MARK: - plan-page URL

    /// The deterministic subdomain/URL mirror rule (planMode.mjs: lowercased,
    /// stripped of non-alphanumerics, truncated to 20 chars).
    func testPlanPageURL() {
        XCTAssertEqual(
            PlanDerivation.planSubdomain("ses_A1b2C3d4E5f6G7h8I9j0K1"),
            "plan-sesa1b2c3d4e5f6g7h8i")
        let url = PlanDerivation.planPageURL(sessionID: "ses_A1b2C3", baseURL: URL(string: "https://abc.boxes.mantaui.com/")!)
        XCTAssertEqual(url, "https://abc.boxes.mantaui.com/pages/plan-sesa1b2c3")
        XCTAssertNil(PlanDerivation.planPageURL(sessionID: "", baseURL: URL(string: "https://a.b")!))
    }
}
