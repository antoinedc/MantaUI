import XCTest
@testable import MantaUI

@MainActor
final class BoxCapabilitiesStoreTests: XCTestCase {

    private actor Script {
        var results: [Result<ServerVersionInfo, Error>]
        private(set) var calls = 0
        init(_ results: [Result<ServerVersionInfo, Error>]) { self.results = results }
        func next() throws -> ServerVersionInfo {
            calls += 1
            let r = results.count > 1 ? results.removeFirst() : results[0]
            return try r.get()
        }
    }

    private func info(_ ids: [String]?) -> ServerVersionInfo { ServerVersionInfo(version: "t", capabilities: ids) }

    func testLoadingThenLoaded() async {
        let script = Script([.success(info(["chat-cards-1"]))])
        let store = BoxCapabilitiesStore(load: { try await script.next() })
        XCTAssertEqual(store.state, .loading)
        XCTAssertNil(store.has(.chatCards))
        await store.refresh()
        XCTAssertEqual(store.has(.chatCards), true)
        XCTAssertEqual(store.has(.devicesView), false)
    }

    func testABodyWithoutTheFieldIsAnOldBoxNotAFailure() async {
        let script = Script([.success(info(nil))])
        let store = BoxCapabilitiesStore(load: { try await script.next() })
        await store.refresh()
        XCTAssertEqual(store.state, .loaded(BoxCapabilities(ids: [])))
        XCTAssertEqual(store.has(.chatCards), false)
    }

    func testAFailedFirstReadIsUnknownNeverOldBox() async {
        let script = Script([.failure(MantaError.transport("offline"))])
        let store = BoxCapabilitiesStore(load: { try await script.next() })
        await store.refresh()
        XCTAssertEqual(store.state, .failed(lastLoaded: nil))
        XCTAssertNil(store.has(.chatCards))
        store.resetForBoxChange()
    }

    func testAFailedRefreshKeepsTheLastLoadedList() async {
        let script = Script([.success(info(["chat-cards-1"])), .failure(MantaError.transport("blip"))])
        let store = BoxCapabilitiesStore(load: { try await script.next() })
        await store.refresh()
        await store.refresh()
        XCTAssertEqual(store.state, .failed(lastLoaded: BoxCapabilities(ids: ["chat-cards-1"])))
        XCTAssertEqual(store.has(.chatCards), true)
        store.resetForBoxChange()
    }

    func testResetForgetsTheLastBox() async {
        let script = Script([.success(info(["chat-cards-1"]))])
        let store = BoxCapabilitiesStore(load: { try await script.next() })
        await store.refresh()
        store.resetForBoxChange()
        XCTAssertEqual(store.state, .loading)
        XCTAssertNil(store.has(.chatCards))
    }

    func testConcurrentRefreshesShareOneRequest() async {
        let script = Script([.success(info(["chat-cards-1"]))])
        let store = BoxCapabilitiesStore(load: { try await script.next() })
        async let a: Void = store.refresh()
        async let b: Void = store.refresh()
        _ = await (a, b)
        let calls = await script.calls
        XCTAssertEqual(calls, 1)
    }
}
