import XCTest
@testable import MantaUI

// ===========================================================================
// WS07 F6 — the agent-sent file notice, pure half: the bus-event decode, the
// copy, and the state machine's interleavings. Every sequence is deterministic
// (a stale download / picker completion / saved timer is a no-op, and each path
// that drops a staged file returns `.deleteTemp`). Pure — runs under `verify.sh`.
// ===========================================================================

final class ArtifactAgentFileTests: XCTestCase {

    private func event(_ name: String, size: Int = 62 * 1024, session: String? = "ses_1") -> AgentFileEvent {
        AgentFileEvent(remotePath: "/home/dev/.manta-outbox/ses_1/\(name)", name: name, size: size,
                       sessionID: session, autoPulled: false)
    }

    private func staged(_ name: String) -> URL {
        URL(fileURLWithPath: "/tmp/manta-agentfile/\(name)-dir/\(name)")
    }

    // MARK: Event decode

    func testDecodesTheDesktopPayloadExactly() throws {
        let frame = try MantaStreamFrame.parse(#"""
        {"kind":"agentFile","payload":{"remotePath":"/home/dev/.manta-outbox/ses_1/report.pdf","name":"report.pdf","size":63488,"sessionName":"ses_1","autoPulled":false}}
        """#)
        let e = try XCTUnwrap(AgentFileEvent.from(frame))
        XCTAssertEqual(e.remotePath, "/home/dev/.manta-outbox/ses_1/report.pdf")
        XCTAssertEqual(e.name, "report.pdf")
        XCTAssertEqual(e.size, 63488)
        XCTAssertEqual(e.sessionID, "ses_1", "the wire's sessionName is the opencode session id")
        XCTAssertFalse(e.autoPulled)
    }

    func testIgnoresOtherKindsAndUnusablePayloads() throws {
        XCTAssertNil(AgentFileEvent.from(try MantaStreamFrame.parse(#"{"kind":"delegate.updated","payload":{"remotePath":"/a/b"}}"#)))
        XCTAssertNil(AgentFileEvent.from(try MantaStreamFrame.parse(#"{"kind":"agentFile","payload":{"name":"a"}}"#)))
        XCTAssertNil(AgentFileEvent.from(try MantaStreamFrame.parse(#"{"kind":"agentFile","payload":{"remotePath":"","name":"a"}}"#)))
        XCTAssertNil(AgentFileEvent.from(try MantaStreamFrame.parse(#"{"kind":"agentFile"}"#)))
    }

    func testEmptyNameFallsBackToTheBasenameAndNullSessionIsNil() throws {
        let e = try XCTUnwrap(AgentFileEvent.from(try MantaStreamFrame.parse(
            #"{"kind":"agentFile","payload":{"remotePath":"/home/dev/.manta-outbox/loose.csv","name":"","size":0,"sessionName":null,"autoPulled":false}}"#)))
        XCTAssertEqual(e.name, "loose.csv")
        XCTAssertNil(e.sessionID)
        XCTAssertEqual(e.size, 0)
    }

    // MARK: Copy

    func testCopy() {
        let e = event("report.pdf", size: 63488)
        let size = ArtifactFormat.byteCount(63488) ?? ""
        XCTAssertEqual(AgentFileNoticeCopy.title(e), "report.pdf")
        XCTAssertEqual(AgentFileNoticeCopy.detail(e, sessionTitle: nil), "\(size) · AI sent you a file")
        XCTAssertEqual(AgentFileNoticeCopy.detail(e, sessionTitle: "better-ui"), "\(size) · AI sent you a file · in better-ui")
        XCTAssertEqual(AgentFileNoticeCopy.detail(event("x.txt", size: 0), sessionTitle: nil), "AI sent you a file")
        XCTAssertEqual(AgentFileNoticeCopy.savedTitle(e), "Saved report.pdf")
        XCTAssertEqual(AgentFileNoticeCopy.failure(e), "Couldn't download report.pdf — it's still on the box, try again.")
        XCTAssertNil(AgentFileNoticeCopy.pendingBadge(0))
        XCTAssertEqual(AgentFileNoticeCopy.pendingBadge(1), "+1 more")
        XCTAssertEqual(AgentFileNoticeCopy.pendingBadge(2), "+2 more")
    }

    // MARK: Interleavings

    /// A starts, B arrives, A finishes: B waits, A is never replaced mid-operation.
    func testArrivalDuringADownloadQueuesAndDoesNotReplace() throws {
        var m = AgentFileNoticeMachine()
        let a = event("a.pdf"), b = event("b.pdf")
        m.receive(a)
        let begun = try XCTUnwrap(m.begin(.save))
        m.receive(b)
        XCTAssertEqual(m.current?.event, a)
        XCTAssertEqual(m.current?.phase, .downloading(.save, opID: begun.opID))
        XCTAssertEqual(m.queued, [b])

        let u = staged("a")
        XCTAssertEqual(m.downloadFinished(token: begun.token, opID: begun.opID, result: .success(u)), .none)
        XCTAssertEqual(m.current?.phase, .presenting(.save, opID: begun.opID, fileURL: u))
        XCTAssertEqual(m.queued, [b])
    }

    /// Dismiss is refused while the picker is up; its (late) completion still saves.
    func testDismissIsRefusedWhilePresentingThenTheCompletionSaves() throws {
        var m = AgentFileNoticeMachine()
        m.receive(event("a.pdf"))
        let begun = try XCTUnwrap(m.begin(.save))
        let u = staged("a")
        _ = m.downloadFinished(token: begun.token, opID: begun.opID, result: .success(u))
        let before = m

        XCTAssertEqual(m.dismiss(), .none)
        XCTAssertEqual(m, before, "dismiss changed nothing while presenting")

        let effect = m.presentationFinished(token: begun.token, opID: begun.opID, fileURL: u, completed: true)
        XCTAssertEqual(effect, .scheduleSavedTimer(token: begun.token, opID: begun.opID))
        XCTAssertEqual(m.current?.phase, .saved(opID: begun.opID, fileURL: u), "the file is kept until the notice closes")
    }

    /// An old saved timer must not close a different file's notice.
    func testAnOldSavedTimerNeverClosesALaterNotice() throws {
        var m = AgentFileNoticeMachine()
        let a = event("a.pdf"), b = event("b.pdf")
        m.receive(a)
        let begun = try XCTUnwrap(m.begin(.save))
        let u = staged("a")
        _ = m.downloadFinished(token: begun.token, opID: begun.opID, result: .success(u))
        m.receive(b)
        _ = m.presentationFinished(token: begun.token, opID: begun.opID, fileURL: u, completed: true)
        XCTAssertEqual(m.queued, [b])

        XCTAssertEqual(m.dismiss(), .deleteTemp(u), "dismissing a saved notice deletes its file")
        XCTAssertEqual(m.current?.event, b, "B is promoted")
        XCTAssertEqual(m.current?.phase, .idle)
        let bToken = try XCTUnwrap(m.current?.token)
        XCTAssertNotEqual(bToken, begun.token)

        XCTAssertEqual(m.savedTimerFired(token: begun.token, opID: begun.opID), .none)
        XCTAssertEqual(m.current?.event, b)
        XCTAssertEqual(m.current?.phase, .idle)
    }

    func testTheSavedTimerClosesItsOwnNoticeAndDeletesTheFile() throws {
        var m = AgentFileNoticeMachine()
        m.receive(event("a.pdf"))
        let begun = try XCTUnwrap(m.begin(.save))
        let u = staged("a")
        _ = m.downloadFinished(token: begun.token, opID: begun.opID, result: .success(u))
        _ = m.presentationFinished(token: begun.token, opID: begun.opID, fileURL: u, completed: true)

        XCTAssertEqual(m.savedTimerFired(token: begun.token, opID: begun.opID), .deleteTemp(u))
        XCTAssertNil(m.current)
    }

    func testAShareThatCompletesClosesTheNoticeAndDeletesTheFile() throws {
        var m = AgentFileNoticeMachine()
        m.receive(event("a.pdf"))
        let begun = try XCTUnwrap(m.begin(.share))
        let u = staged("a")
        _ = m.downloadFinished(token: begun.token, opID: begun.opID, result: .success(u))
        XCTAssertEqual(m.presentationFinished(token: begun.token, opID: begun.opID, fileURL: u, completed: true), .deleteTemp(u))
        XCTAssertNil(m.current)
    }

    /// A duplicate / stale presentation callback cleans its own file and changes nothing.
    func testStalePresentationCallbacksOnlyRemoveTheirOwnFile() throws {
        var m = AgentFileNoticeMachine()
        m.receive(event("a.pdf"))
        let begun = try XCTUnwrap(m.begin(.share))
        let u = staged("a")
        _ = m.downloadFinished(token: begun.token, opID: begun.opID, result: .success(u))

        XCTAssertEqual(m.presentationFinished(token: begun.token, opID: begun.opID, fileURL: u, completed: false), .deleteTemp(u))
        XCTAssertEqual(m.current?.phase, .idle)
        let afterFirst = m
        XCTAssertEqual(m.presentationFinished(token: begun.token, opID: begun.opID, fileURL: u, completed: false), .deleteTemp(u),
                       "idempotent removal")
        XCTAssertEqual(m, afterFirst)

        // a foreign (token, opID) while another notice is current
        let other = staged("zzz")
        XCTAssertEqual(m.presentationFinished(token: 999, opID: 999, fileURL: other, completed: true), .deleteTemp(other))
        XCTAssertEqual(m, afterFirst)
    }

    func testDismissDuringADownloadLeavesTheFileToTheLateCompletion() throws {
        var m = AgentFileNoticeMachine()
        m.receive(event("a.pdf"))
        let begun = try XCTUnwrap(m.begin(.share))
        XCTAssertEqual(m.dismiss(), .none)
        XCTAssertNil(m.current)

        let u = staged("a")
        XCTAssertEqual(m.downloadFinished(token: begun.token, opID: begun.opID, result: .success(u)), .deleteTemp(u))
        XCTAssertNil(m.current)
        XCTAssertEqual(m.downloadFinished(token: begun.token, opID: begun.opID, result: .failure(.download)), .none)
    }

    func testBeginIsRefusedUnlessIdleOrFailedAndAWrongOpIDIsIgnored() throws {
        var m = AgentFileNoticeMachine()
        XCTAssertNil(m.begin(.save), "nothing to act on")
        m.receive(event("a.pdf"))
        let begun = try XCTUnwrap(m.begin(.save))
        let before = m
        XCTAssertNil(m.begin(.share), "a second tap while downloading starts nothing")
        XCTAssertEqual(m, before)

        let u = staged("a")
        XCTAssertEqual(m.downloadFinished(token: begun.token, opID: begun.opID + 7, result: .success(u)), .deleteTemp(u),
                       "a completion for another operation owns a file nobody wants")
        XCTAssertEqual(m.current?.phase, .downloading(.save, opID: begun.opID), "and does not touch this one")
    }

    func testAFailedDownloadCanBeRetriedWithANewOperation() throws {
        var m = AgentFileNoticeMachine()
        let a = event("a.pdf")
        m.receive(a)
        let first = try XCTUnwrap(m.begin(.save))
        XCTAssertEqual(m.downloadFinished(token: first.token, opID: first.opID, result: .failure(.download)), .none)
        XCTAssertEqual(m.current?.phase, .failed(AgentFileNoticeCopy.failure(a)))
        let second = try XCTUnwrap(m.begin(.save))
        XCTAssertEqual(second.token, first.token)
        XCTAssertNotEqual(second.opID, first.opID)
    }

    func testAnIdleNoticeIsReplacedByTheNewestAndDuplicatesAreIgnored() throws {
        var m = AgentFileNoticeMachine()
        let a = event("a.pdf"), b = event("b.pdf")
        m.receive(a)
        let aToken = try XCTUnwrap(m.current?.token)
        m.receive(a)
        XCTAssertEqual(m.current?.token, aToken, "duplicate path ignored")
        m.receive(b)
        XCTAssertEqual(m.current?.event, b)
        XCTAssertGreaterThan(try XCTUnwrap(m.current?.token), aToken)
        XCTAssertTrue(m.queued.isEmpty)
    }

    func testAnArrivalDuplicateOfAQueuedFileIsIgnoredAndTheQueueIsCapped() throws {
        var m = AgentFileNoticeMachine()
        m.receive(event("a.pdf"))
        _ = try XCTUnwrap(m.begin(.save)) // busy: everything after queues
        for n in 0..<7 { m.receive(event("q\(n).pdf")) }
        XCTAssertEqual(m.queued.count, AgentFileNoticeMachine.queueCap)
        XCTAssertEqual(m.queued.first?.name, "q2.pdf", "the oldest were dropped")
        let before = m
        m.receive(event("q6.pdf"))
        XCTAssertEqual(m, before, "a duplicate of a queued file changes nothing")
    }

    func testCancellingTheExporterReturnsToIdleAndDeletesTheFile() throws {
        var m = AgentFileNoticeMachine()
        m.receive(event("a.pdf"))
        let begun = try XCTUnwrap(m.begin(.save))
        let u = staged("a")
        _ = m.downloadFinished(token: begun.token, opID: begun.opID, result: .success(u))
        XCTAssertEqual(m.presentationFinished(token: begun.token, opID: begun.opID, fileURL: u, completed: false), .deleteTemp(u))
        XCTAssertEqual(m.current?.phase, .idle)
        // a retry downloads again — no stale bytes are reused
        let again = try XCTUnwrap(m.begin(.save))
        XCTAssertNotEqual(again.opID, begun.opID)
    }
}
