import XCTest
@testable import MantaUI

final class BoxCapabilitiesTests: XCTestCase {

    func testDecodeWithCapabilities() throws {
        let data = #"{"version":"1.2.3","minClient":"0.0.1","opencodeVersion":"2.0.30","capabilities":["chat-cards-1","cache-stale-at-1","some-future-9"]}"#.data(using: .utf8)!
        let info = try JSONDecoder().decode(ServerVersionInfo.self, from: data)
        let caps = BoxCapabilities.decode(version: info)
        XCTAssertTrue(caps.has(.chatCards))
        XCTAssertTrue(caps.has(.cacheStaleAt))
        XCTAssertFalse(caps.has(.devicesView))
        XCTAssertEqual(caps.ids.count, 3, "an id this build does not know is kept but never read")
    }

    func testAnOldBoxWithoutTheFieldIsTheEmptySetNotAFailure() throws {
        let data = #"{"version":"0.0.30"}"#.data(using: .utf8)!
        let info = try JSONDecoder().decode(ServerVersionInfo.self, from: data)
        XCTAssertNil(info.capabilities)
        let caps = BoxCapabilities.decode(version: info)
        XCTAssertTrue(caps.ids.isEmpty)
        for c in BoxCapability.allCases { XCTAssertFalse(caps.has(c)) }
    }

    func testEveryIdMatchesTheWireFormat() {
        for c in BoxCapability.allCases {
            XCTAssertNotNil(c.rawValue.range(of: #"^[a-z0-9-]+-\d+$"#, options: .regularExpression), c.rawValue)
        }
        XCTAssertEqual(Set(BoxCapability.allCases.map(\.rawValue)).count, BoxCapability.allCases.count)
    }

    func testUnknownChannelClassifier() {
        XCTAssertTrue(BoxCapabilities.isUnknownChannel(MantaError.server("unknown rpc channel: models:table")))
        XCTAssertTrue(BoxCapabilities.isUnknownChannel(MantaError.server("unknown rpc channel: artifacts:list")))
        XCTAssertFalse(BoxCapabilities.isUnknownChannel(MantaError.server("boom")))
        XCTAssertFalse(BoxCapabilities.isUnknownChannel(MantaError.transport("unknown rpc channel: x")))
        XCTAssertFalse(BoxCapabilities.isUnknownChannel(MantaError.authRequired))
    }

    func testStateKnownList() {
        let caps = BoxCapabilities(ids: ["chat-cards-1"])
        XCTAssertNil(BoxCapabilitiesState.loading.known)
        XCTAssertEqual(BoxCapabilitiesState.loaded(caps).known, caps)
        XCTAssertEqual(BoxCapabilitiesState.failed(lastLoaded: caps).known, caps, "a failed refresh keeps the last good list")
        XCTAssertNil(BoxCapabilitiesState.failed(lastLoaded: nil).known, "a failure is never an old box")
    }

    func testRetryDelaySchedule() {
        XCTAssertEqual((0..<6).map { BoxCapabilitiesRetry.delay(attempt: $0) }, [1, 2, 5, 10, 10, 10])
        XCTAssertEqual(BoxCapabilitiesRetry.delay(attempt: -3), 1)
    }
}
