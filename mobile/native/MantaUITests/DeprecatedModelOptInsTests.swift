import XCTest
@testable import MantaUI

// ===========================================================================
// BET-1140 — deprecated-model opt-in persistence. The opt-in set lives under a
// PER-BOX UserDefaults key (same storage idiom as ModelRecents) and round-trips
// on-device: a deprecated model the user enabled stays selectable across
// launches.
// ===========================================================================

final class DeprecatedModelOptInsTests: XCTestCase {

    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "DeprecatedModelOptInsTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testRoundTripPersistsAcrossLoads() {
        let set: Set<String> = ["anthropic/opus", "openai/gpt-4o"]
        DeprecatedModelOptIns.save(set, defaults)
        XCTAssertEqual(DeprecatedModelOptIns.load(defaults), set)
    }

    func testLoadEmptyWhenNothingStored() {
        XCTAssertEqual(DeprecatedModelOptIns.load(defaults), [])
    }

    func testSaveReplacesPreviousSet() {
        DeprecatedModelOptIns.save(["anthropic/opus"], defaults)
        DeprecatedModelOptIns.save(["anthropic/opus", "openai/gpt-4o"], defaults)
        XCTAssertEqual(DeprecatedModelOptIns.load(defaults), ["anthropic/opus", "openai/gpt-4o"])
    }
}
