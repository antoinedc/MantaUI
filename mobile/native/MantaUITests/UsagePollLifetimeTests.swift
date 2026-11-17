import XCTest
@testable import MantaUI

// ===========================================================================
// B5 [A half] (spec 2026-11-17): UsageStore's 60 s poll must end when its owner
// is gone. The old loop only slept `if let interval = self?.pollInterval`, so once
// the store was released it re-entered the loop with no sleep at all and spun.
// ===========================================================================

@MainActor
final class UsagePollLifetimeTests: XCTestCase {

    override func setUp() {
        super.setUp()
        ModelsStubProtocol.reset()
        ModelsStubProtocol.responses = ["usage:list": #"{"result":[]}"#]
    }

    func testThePollEndsWhenItsOwnerIsReleased() async {
        weak var weakStore: UsageStore?
        do {
            let store = UsageStore(api: ModelsStubProtocol.client(), pollInterval: 0.01)
            weakStore = store
            store.start()
            let polled = await eventually { ModelsStubProtocol.count("usage:list") >= 2 }
            XCTAssertTrue(polled, "the store polls while it is alive")
        }

        let released = await eventually { weakStore == nil }
        XCTAssertTrue(released, "the poll task must not keep the store alive")

        try? await Task.sleep(for: .milliseconds(100))
        let settled = ModelsStubProtocol.count("usage:list")
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(ModelsStubProtocol.count("usage:list"), settled, "no polling once the owner is gone")
    }

    func testStopEndsThePoll() async {
        let store = UsageStore(api: ModelsStubProtocol.client(), pollInterval: 0.01)
        store.start()
        let polled = await eventually { ModelsStubProtocol.count("usage:list") >= 2 }
        XCTAssertTrue(polled)

        store.stop()
        try? await Task.sleep(for: .milliseconds(100))
        let settled = ModelsStubProtocol.count("usage:list")
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(ModelsStubProtocol.count("usage:list"), settled)
    }
}
