import XCTest
@testable import MantaUI

// ===========================================================================
// WS07 — what the artifacts card keeps on the client: expiry LABEL, search,
// action eligibility, byte-source routing, staging / attach failure copy, day
// grouping. The list itself (and every state: expiry, plan, counts) comes from
// the box. Pure — runs under `verify.sh`.
// ===========================================================================

final class ArtifactPresentationTests: XCTestCase {

    private func item(_ id: String, _ kind: ArtifactKind, label: String, href: String = "/x",
                      at: Double = 0, plan: ArtifactPlanInfo? = nil, messageId: String? = nil) -> ArtifactItem {
        ArtifactItem(id: id, kind: kind, label: label, href: href, at: at, messageId: messageId, plan: plan)
    }

    // MARK: Expiry label

    private let now = Date(timeIntervalSince1970: 1_000_000)
    private func ms(after seconds: Double) -> Double { (1_000_000 + seconds) * 1000 }

    func testExpiryLabelStatesAndUnits() {
        XCTAssertEqual(ArtifactExpiryLabel.text(ArtifactExpiry(state: .never, expiresAt: nil), now: now), "no expiry")
        XCTAssertEqual(ArtifactExpiryLabel.text(ArtifactExpiry(state: .expired, expiresAt: ms(after: -5)), now: now), "expired")
        XCTAssertEqual(ArtifactExpiryLabel.text(ArtifactExpiry(state: .live, expiresAt: ms(after: 30 * 60)), now: now), "expires in 1h")
        XCTAssertEqual(ArtifactExpiryLabel.text(ArtifactExpiry(state: .soon, expiresAt: ms(after: 5.9 * 3600)), now: now), "expires in 5h")
        XCTAssertEqual(ArtifactExpiryLabel.text(ArtifactExpiry(state: .live, expiresAt: ms(after: 47 * 3600)), now: now), "expires in 47h")
        XCTAssertEqual(ArtifactExpiryLabel.text(ArtifactExpiry(state: .live, expiresAt: ms(after: 3.5 * 86400)), now: now), "expires in 3d")
    }

    func testExpiryLabelReadsExpiredOnceTheDeviceClockPassesTheTime() {
        XCTAssertEqual(ArtifactExpiryLabel.text(ArtifactExpiry(state: .soon, expiresAt: ms(after: -1)), now: now), "expired")
        XCTAssertEqual(ArtifactExpiryLabel.text(ArtifactExpiry(state: .live, expiresAt: nil), now: now), "no expiry")
    }

    // MARK: Search

    func testSearchFiltersOnLabelOrHrefCaseInsensitively() {
        let items = [
            item("1", .file, label: "Report.PDF", href: "/home/a/report.pdf"),
            item("2", .file, label: "notes", href: "/home/b/Budget.md"),
            item("3", .link, label: "example.com/docs", href: "https://example.com/docs"),
            item("4", .image, label: "shot.png", href: "/home/a/shot.png"),
        ]
        XCTAssertEqual(ArtifactSearch.filter(items, query: "report").map(\.id), ["1"])
        XCTAssertEqual(ArtifactSearch.filter(items, query: "BUDGET").map(\.id), ["2"])
        XCTAssertEqual(ArtifactSearch.filter(items, query: "  docs ").map(\.id), ["3"])
        XCTAssertEqual(ArtifactSearch.filter(items, query: "nothing-matches").count, 0)
        XCTAssertEqual(ArtifactSearch.filter(items, query: "   ").count, 4, "whitespace-only = everything")
        XCTAssertEqual(ArtifactSearch.filter(items, query: "").count, 4)
    }

    func testSearchCountsAreRealPerKindMatchCounts() {
        let items = [
            item("1", .file, label: "a-report.pdf"),
            item("2", .file, label: "b-report.pdf"),
            item("3", .image, label: "report.png"),
            item("4", .link, label: "other"),
            item("5", .plan, label: "report plan"),
        ]
        XCTAssertEqual(ArtifactSearch.counts(items, query: "report"), ArtifactCountsWire(link: 0, image: 1, file: 2, plan: 1))
        XCTAssertEqual(ArtifactSearch.counts(items, query: ""), ArtifactCountsWire(link: 1, image: 1, file: 2, plan: 1))
        XCTAssertTrue(ArtifactSearch.isActive("x"))
        XCTAssertFalse(ArtifactSearch.isActive("  "))
    }

    func testEmptyCopyNamesTheOtherSegments() {
        let counts = ArtifactCountsWire(link: 2, image: 0, file: 3, plan: 1)
        XCTAssertEqual(ArtifactEmptyCopy.big(.plan), "No plans yet")
        XCTAssertEqual(ArtifactEmptyCopy.big(.link), "No links yet")
        XCTAssertEqual(ArtifactEmptyCopy.big(.image), "No images yet")
        XCTAssertEqual(ArtifactEmptyCopy.big(.file), "No files yet")
        XCTAssertEqual(ArtifactEmptyCopy.sub(.plan, counts), "2 links, 0 images, 3 files")
        XCTAssertEqual(ArtifactEmptyCopy.sub(.link, counts), "0 images, 3 files, 1 plans")
        XCTAssertEqual(ArtifactEmptyCopy.sub(.image, counts), "2 links, 3 files, 1 plans")
        XCTAssertEqual(ArtifactEmptyCopy.sub(.file, counts), "2 links, 0 images, 1 plans")
    }

    // MARK: Actions

    func testAttachNeedsFileOrImageAndComposerThatAcceptsInputAndAProject() {
        XCTAssertTrue(ArtifactActions.canAttach(kind: .file, hasComposer: true, acceptsInput: true, hasProject: true))
        XCTAssertTrue(ArtifactActions.canAttach(kind: .image, hasComposer: true, acceptsInput: true, hasProject: true))
        XCTAssertFalse(ArtifactActions.canAttach(kind: .link, hasComposer: true, acceptsInput: true, hasProject: true))
        XCTAssertFalse(ArtifactActions.canAttach(kind: .plan, hasComposer: true, acceptsInput: true, hasProject: true))
        XCTAssertFalse(ArtifactActions.canAttach(kind: .file, hasComposer: false, acceptsInput: true, hasProject: true))
        XCTAssertFalse(ArtifactActions.canAttach(kind: .file, hasComposer: true, acceptsInput: false, hasProject: true),
                       "a read-only chat takes no attachment")
        XCTAssertFalse(ArtifactActions.canAttach(kind: .file, hasComposer: true, acceptsInput: true, hasProject: false))
    }

    func testJumpNeedsAHandlerAndAMessage() {
        XCTAssertTrue(ArtifactActions.canJump(hasHandler: true, messageId: "msg_1"))
        XCTAssertFalse(ArtifactActions.canJump(hasHandler: false, messageId: "msg_1"))
        XCTAssertFalse(ArtifactActions.canJump(hasHandler: true, messageId: nil))
        XCTAssertFalse(ArtifactActions.canJump(hasHandler: true, messageId: ""))
    }

    func testOpenPlanFileOnlyWhenTheBoxKnowsTheFolder() {
        let withFile = ArtifactPlanInfo(status: .draft, steps: 1, pageUrl: nil, pageUrlReason: nil, fileAvailable: true)
        let withoutFile = ArtifactPlanInfo(status: .draft, steps: 1, pageUrl: nil, pageUrlReason: nil, fileAvailable: false)
        XCTAssertTrue(ArtifactActions.canOpenPlanFile(item("p", .plan, label: "p", plan: withFile)))
        XCTAssertFalse(ArtifactActions.canOpenPlanFile(item("p", .plan, label: "p", plan: withoutFile)))
        XCTAssertFalse(ArtifactActions.canOpenPlanFile(item("p", .plan, label: "p")))
        XCTAssertFalse(ArtifactActions.canOpenPlanFile(item("f", .file, label: "f", plan: withFile)))
    }

    // MARK: Attach copy / filenames / staging names

    func testAttachRejectionCopyIsWS03sCopy() {
        XCTAssertEqual(ArtifactAttach.rejectionMessage(.duplicate, name: "a.pdf"), "Already attached")
        XCTAssertEqual(ArtifactAttach.rejectionMessage(.readOnly, name: "a.pdf"), "This chat is read-only.")
        XCTAssertEqual(ArtifactAttach.rejectionMessage(.notAbsolute, name: "a.pdf"), "Couldn't attach a.pdf.")
        XCTAssertEqual(ArtifactAttach.rejectionMessage(nil, name: "a.pdf"), "Couldn't attach a.pdf.")
    }

    func testAttachFailureCopyCarriesTheStagingReason() {
        XCTAssertEqual(ArtifactAttach.stagingFailureMessage(.missing, name: "a.pdf"),
                       "Couldn't attach a.pdf — it may no longer be on the box.")
        XCTAssertEqual(ArtifactAttach.stagingFailureMessage(.badDataURI, name: "a.png"),
                       "Couldn't attach a.png — the file data is damaged.")
        XCTAssertEqual(ArtifactAttach.stagingFailureMessage(.remote(host: "cdn.example.com"), name: "a.png"),
                       "Couldn't attach a.png — couldn't download it from cdn.example.com.")
        XCTAssertEqual(ArtifactAttach.uploadFailureMessage(name: "a.pdf"),
                       "Couldn't attach a.pdf — the upload to the box failed.")
    }

    func testAttachFilenameKeepsAnExtensionOrBorrowsTheHrefs() {
        XCTAssertEqual(ArtifactAttach.filename(for: item("1", .file, label: "report.pdf", href: "/a/b.bin")), "report.pdf")
        XCTAssertEqual(ArtifactAttach.filename(for: item("2", .file, label: "report", href: "/a/b/data.csv")), "report.csv")
        XCTAssertEqual(ArtifactAttach.filename(for: item("3", .file, label: "report", href: "/a/b/noext")), "report")
    }

    func testStagingExtensionFallsBackToTheHrefForPlans() {
        XCTAssertEqual(ArtifactStaging.fileExtension(label: "ship it", href: "/proj/.opencode/plans/2026-08-15-ship-it.md"), ".md")
        XCTAssertEqual(ArtifactStaging.fileExtension(label: "report.pdf", href: "/x/other.bin"), ".pdf")
        XCTAssertEqual(ArtifactStaging.fileExtension(label: "title", href: "/x/noext"), "")
        XCTAssertEqual(ArtifactStaging.fileExtension(label: "a.toolongextension", href: "/x/y"), "")
    }

    func testAStagedCopyIsReusedOnlyWhileTheRowIsUnchanged() {
        let v1 = ArtifactItem(id: "o", kind: .file, label: "r.pdf", href: "/r.pdf", size: 100, at: 1000)
        let rev = ArtifactStaging.revision(v1)
        XCTAssertTrue(ArtifactStaging.isCurrent(stagedRevision: rev, for: v1))
        // re-pushed at the same path: new mtime and/or size → fetched again
        XCTAssertFalse(ArtifactStaging.isCurrent(stagedRevision: rev,
                                                 for: ArtifactItem(id: "o", kind: .file, label: "r.pdf", href: "/r.pdf", size: 100, at: 2000)))
        XCTAssertFalse(ArtifactStaging.isCurrent(stagedRevision: rev,
                                                 for: ArtifactItem(id: "o", kind: .file, label: "r.pdf", href: "/r.pdf", size: 101, at: 1000)))
        XCTAssertFalse(ArtifactStaging.isCurrent(stagedRevision: nil, for: v1))
        // a plan is never reusable: opening its file always fetches afresh
        let plan = ArtifactItem(id: "p", kind: .plan, label: "p", href: "/p.md", at: 5)
        XCTAssertFalse(ArtifactStaging.isCurrent(stagedRevision: ArtifactStaging.revision(plan), for: plan))
    }

    func testTempFileNamesAreShortSafeAndDistinct() {
        let longID = "outbox:" + String(repeating: "/very/long/path", count: 40) + "/report.pdf"
        let a = ArtifactStaging.tempFileName(id: longID, label: "report.pdf", href: longID)
        let b = ArtifactStaging.tempFileName(id: longID + "2", label: "report.pdf", href: longID)
        XCTAssertTrue(a.hasPrefix("manta-qp-"))
        XCTAssertTrue(a.hasSuffix(".pdf"))
        XCTAssertFalse(a.contains("/"))
        XCTAssertFalse(a.contains(":"))
        XCTAssertLessThan(a.count, 100)
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a, ArtifactStaging.tempFileName(id: longID, label: "report.pdf", href: longID), "stable per id")
    }

    // MARK: Byte source routing

    private func url(_ string: String) -> URL { URL(string: string) ?? URL(fileURLWithPath: "/invalid") }

    func testByteSourceClassification() {
        XCTAssertEqual(ArtifactByteSource.classify("data:image/png;base64,AAA"), .dataURI("data:image/png;base64,AAA"))
        XCTAssertEqual(ArtifactByteSource.classify("DATA:text/plain,hi"), .dataURI("DATA:text/plain,hi"))
        XCTAssertEqual(ArtifactByteSource.classify("https://cdn.example.com/a.png"), .remote(url("https://cdn.example.com/a.png")))
        XCTAssertEqual(ArtifactByteSource.classify("http://x/y"), .remote(url("http://x/y")))
        XCTAssertEqual(ArtifactByteSource.classify("https://"), .unsupported)
        XCTAssertEqual(ArtifactByteSource.classify("/home/dev/.manta-outbox/s/a.pdf"), .boxPath("/home/dev/.manta-outbox/s/a.pdf"))
        XCTAssertEqual(ArtifactByteSource.classify("~/a.pdf"), .boxPath("~/a.pdf"))
        XCTAssertEqual(ArtifactByteSource.classify("relative/a.pdf"), .unsupported)
        XCTAssertEqual(ArtifactByteSource.classify("ftp://x/a"), .unsupported)
        XCTAssertEqual(ArtifactByteSource.classify(""), .unsupported)
    }

    func testDataURIDecode() {
        XCTAssertEqual(ArtifactDataURI.decode("data:text/plain;base64,aGVsbG8="), Data("hello".utf8))
        XCTAssertEqual(ArtifactDataURI.decode("data:text/plain,hello%20world"), Data("hello world".utf8))
        XCTAssertEqual(ArtifactDataURI.decode("data:,plain"), Data("plain".utf8))
        XCTAssertNil(ArtifactDataURI.decode("data:image/png;base64"), "no comma")
        XCTAssertNil(ArtifactDataURI.decode("data:image/png;base64,@@@not-base64@@@"))
        XCTAssertNil(ArtifactDataURI.decode("/home/a.png"))
    }

    func testStagingErrorCopyForEveryCase() {
        XCTAssertEqual(ArtifactStagingError.message(.missing, name: "plan.md"),
                       "Couldn't open plan.md — it may no longer be on the box.")
        XCTAssertEqual(ArtifactStagingError.message(.badDataURI, name: "a.png"),
                       "Couldn't open a.png — the file data is damaged.")
        XCTAssertEqual(ArtifactStagingError.message(.remote(host: "cdn.example.com"), name: "a.png"),
                       "Couldn't download a.png from cdn.example.com.")
        XCTAssertEqual(ArtifactStagingError.message(.write, name: "a.png"), "Couldn't prepare a.png for preview.")
    }

    func testPlanPageFailureCopy() {
        let other = ArtifactPlanInfo(status: .draft, steps: 1, pageUrl: nil, pageUrlReason: "other-session", fileAvailable: true)
        let none = ArtifactPlanInfo(status: .draft, steps: 1, pageUrl: nil, pageUrlReason: "no-public-address", fileAvailable: true)
        XCTAssertEqual(ArtifactPlanCopy.openFailure(other),
                       "Couldn't open the plan page. Another conversation's page uses this address.")
        XCTAssertEqual(ArtifactPlanCopy.openFailure(none), "Couldn't open the plan page.")
        XCTAssertEqual(ArtifactPlanCopy.openFailure(nil), "Couldn't open the plan page.")
    }

    // MARK: Row text + day grouping

    func testRowTextHelpers() {
        XCTAssertEqual(ArtifactFormat.planSubline(steps: 3), "3 steps")
        XCTAssertEqual(ArtifactFormat.planSubline(steps: 1), "1 step")
        XCTAssertEqual(ArtifactFormat.planSubline(steps: 0), "plan")
        let base = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(ArtifactFormat.relativeAge(base.addingTimeInterval(-30), now: base), "just now")
        XCTAssertEqual(ArtifactFormat.relativeAge(base.addingTimeInterval(-4 * 60), now: base), "4m ago")
        XCTAssertEqual(ArtifactFormat.relativeAge(base.addingTimeInterval(-3 * 3600), now: base), "3h ago")
        XCTAssertEqual(ArtifactFormat.relativeAge(base.addingTimeInterval(-2 * 86400), now: base), "2d ago")
        XCTAssertNil(ArtifactFormat.relativeAge(nil, now: base))
        let agent = ArtifactItem(id: "a", kind: .file, origin: .agent, label: "r.pdf", href: "/r.pdf",
                                 size: 2048, at: (1_000_000 - 4 * 60) * 1000)
        let line = ArtifactFormat.secondaryLine(agent, now: base)
        XCTAssertTrue(line.contains("from the agent"))
        XCTAssertTrue(line.hasSuffix("4m ago"))
        let user = ArtifactItem(id: "u", kind: .file, origin: .user, label: "u", href: "/u", at: 0)
        XCTAssertEqual(ArtifactFormat.secondaryLine(user, now: base), "you attached")
    }

    func testDayGroupingTodayYesterdayAndOlderNewestFirst() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        calendar.locale = Locale(identifier: "en_US_POSIX")
        func at(_ day: Int, _ hour: Int) throws -> Double {
            let date = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour)))
            return date.timeIntervalSince1970 * 1000
        }
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 28, hour: 12)))
        let items = [
            ArtifactItem(id: "older", kind: .file, label: "o", href: "/o", at: try at(26, 9)),
            ArtifactItem(id: "today1", kind: .file, label: "t1", href: "/t1", at: try at(28, 1)),
            ArtifactItem(id: "yest", kind: .file, label: "y", href: "/y", at: try at(27, 23)),
            ArtifactItem(id: "today2", kind: .file, label: "t2", href: "/t2", at: try at(28, 9)),
        ]
        let groups = ArtifactDayGrouping.grouped(items, now: now, calendar: calendar)
        XCTAssertEqual(groups.map(\.label), ["Today", "Yesterday", "Mon 26 Oct"])
        XCTAssertEqual(groups[0].items.map(\.id), ["today2", "today1"])
        XCTAssertEqual(groups[1].items.map(\.id), ["yest"])
        XCTAssertEqual(groups[2].items.map(\.id), ["older"])
        XCTAssertTrue(ArtifactDayGrouping.grouped([], now: now, calendar: calendar).isEmpty)
    }
}
