import XCTest
@testable import MantaUI

final class ModelsBoxBindingTests: XCTestCase {
    private func creds(_ url: String = "https://a.example.com", box: String = "boxA", token: String = "tokA") -> ModelsBoxCredentials {
        ModelsBoxCredentials(serverUrl: url, boxId: box, boxToken: token)
    }

    func testNilCredentialsAreUnpaired() {
        XCTAssertEqual(ModelsBoxBinding.resolve(current: nil, credentials: nil), .unpaired)
    }

    func testEmptyTokenOrUnparseableURLAreUnpaired() {
        XCTAssertEqual(ModelsBoxBinding.resolve(current: nil, credentials: creds(token: "")), .unpaired)
        XCTAssertEqual(ModelsBoxBinding.resolve(current: nil, credentials: creds("")), .unpaired)
        XCTAssertEqual(ModelsBoxBinding.resolve(current: nil, credentials: creds("not a url")), .unpaired)
    }

    func testFirstPairingRebindsAndMarksBoxChanged() throws {
        guard case .rebind(let b, let changed) = ModelsBoxBinding.resolve(current: nil, credentials: creds()) else {
            return XCTFail("expected rebind")
        }
        XCTAssertTrue(changed)
        XCTAssertEqual(b.boxKey, "boxA")
        XCTAssertEqual(b.serverURL.host, "a.example.com")
        XCTAssertEqual(b.token, "tokA")
    }

    func testSameSnapshotIsSame() throws {
        guard case .rebind(let b, _) = ModelsBoxBinding.resolve(current: nil, credentials: creds()) else { return XCTFail() }
        XCTAssertEqual(ModelsBoxBinding.resolve(current: b, credentials: creds()), .same)
    }

    func testRotatedTokenOnTheSameBoxRebindsWithoutAReset() throws {
        guard case .rebind(let b, _) = ModelsBoxBinding.resolve(current: nil, credentials: creds()) else { return XCTFail() }
        guard case .rebind(let next, let changed) = ModelsBoxBinding.resolve(current: b, credentials: creds(token: "tokNEW")) else {
            return XCTFail("expected rebind")
        }
        XCTAssertFalse(changed)
        XCTAssertEqual(next.token, "tokNEW")
    }

    func testAnotherBoxRebindsAndMarksBoxChanged() throws {
        guard case .rebind(let b, _) = ModelsBoxBinding.resolve(current: nil, credentials: creds()) else { return XCTFail() }
        guard case .rebind(let next, let changed) = ModelsBoxBinding.resolve(current: b, credentials: creds("https://b.example.com", box: "boxB", token: "tokB")) else {
            return XCTFail("expected rebind")
        }
        XCTAssertTrue(changed)
        XCTAssertEqual(next.serverURL.host, "b.example.com")
        XCTAssertEqual(next.token, "tokB", "URL and token always come from the same snapshot")
    }

    func testEmptyBoxIdFallsBackToTheURLAsKey() throws {
        guard case .rebind(let b, _) = ModelsBoxBinding.resolve(current: nil, credentials: creds(box: "")) else { return XCTFail() }
        XCTAssertEqual(b.boxKey, "https://a.example.com")
    }
}
