import XCTest
@testable import MantaUI

final class MantaPairingTests: XCTestCase {

    // MARK: - Pairing code (claim.mjs)

    func testNormalizeCodeStripsNonDigitsAndClampsToSix() {
        XCTAssertEqual(MantaPairing.normalizeCode("abc"), "")
        XCTAssertEqual(MantaPairing.normalizeCode("12 34 56"), "123456")
        XCTAssertEqual(MantaPairing.normalizeCode("1234567890"), "123456")
        XCTAssertEqual(MantaPairing.normalizeCode(""), "")
    }

    func testIsSubmittableCodeExactlySixDigits() {
        XCTAssertTrue(MantaPairing.isSubmittableCode("123456"))
        XCTAssertFalse(MantaPairing.isSubmittableCode("12345"))
        XCTAssertFalse(MantaPairing.isSubmittableCode("1234567"))
        XCTAssertFalse(MantaPairing.isSubmittableCode("abcdef"))
        XCTAssertFalse(MantaPairing.isSubmittableCode(""))
    }

    // MARK: - Two-sided confirm (pairPayload.ts)

    func testNormalizeVerifyFoldsCaseAndStripsWhitespace() {
        XCTAssertEqual(MantaPairing.normalizeVerify("K7 Q2"), "K7Q2")
        XCTAssertEqual(MantaPairing.normalizeVerify("k7 q2"), "K7Q2")
        XCTAssertEqual(MantaPairing.normalizeVerify("K7Q2"), "K7Q2")
        XCTAssertEqual(MantaPairing.normalizeVerify("  k 7 q 2 "), "K7Q2")
    }

    func testIsValidVerify() {
        XCTAssertTrue(MantaPairing.isValidVerify("K7Q2"))
        XCTAssertTrue(MantaPairing.isValidVerify("k7q2"))
        XCTAssertFalse(MantaPairing.isValidVerify("K7"))
        XCTAssertFalse(MantaPairing.isValidVerify("K7Q22"))
    }

    // MARK: - Box id + server URL (setupLogic.ts / transport.mjs)

    func testIsValidBoxIdRequires32Hex() {
        XCTAssertTrue(MantaPairing.isValidBoxId("0123abcd0123abcd0123abcd0123abcd"))
        XCTAssertFalse(MantaPairing.isValidBoxId("short"))
        XCTAssertFalse(MantaPairing.isValidBoxId(String(repeating: "g", count: 32)))
        XCTAssertFalse(MantaPairing.isValidBoxId(""))
    }

    func testBoxDirectURL() {
        let url = MantaPairing.boxDirectURL("0123abcd0123abcd0123abcd0123abcd")
        XCTAssertEqual(url?.absoluteString, "https://0123abcd0123abcd0123abcd0123abcd.boxes.mantaui.com")
        XCTAssertNil(MantaPairing.boxDirectURL("bad"))
    }

    func testNormalizeServerURL() {
        XCTAssertEqual(MantaPairing.normalizeServerURL(" https://100.64.0.1:8787/ "), "https://100.64.0.1:8787")
        XCTAssertEqual(MantaPairing.normalizeServerURL("http://10.0.0.5"), "http://10.0.0.5")
        XCTAssertNil(MantaPairing.normalizeServerURL("100.64.0.1:8787")) // no scheme
        XCTAssertNil(MantaPairing.normalizeServerURL("ftp://host"))
        XCTAssertNil(MantaPairing.normalizeServerURL(""))
    }

    func testIsPrivateServerURL() {
        XCTAssertTrue(MantaPairing.isPrivateServerURL("http://localhost:8787"))
        XCTAssertTrue(MantaPairing.isPrivateServerURL("http://127.0.0.1:8787"))
        XCTAssertTrue(MantaPairing.isPrivateServerURL("http://10.1.2.3:8787"))
        XCTAssertTrue(MantaPairing.isPrivateServerURL("http://172.16.0.1:8787"))
        XCTAssertTrue(MantaPairing.isPrivateServerURL("http://192.168.1.5:8787"))
        XCTAssertTrue(MantaPairing.isPrivateServerURL("http://100.70.0.1:8787"))
        XCTAssertTrue(MantaPairing.isPrivateServerURL("http://foo.ts.net:8787"))
        XCTAssertFalse(MantaPairing.isPrivateServerURL("https://8.8.8.8"))
        XCTAssertFalse(MantaPairing.isPrivateServerURL("https://mantaui.com"))
        XCTAssertFalse(MantaPairing.isPrivateServerURL(nil))
    }

    // MARK: - Pair payload parser (pairPayload.ts parsePairPayload)

    private let box = "0123abcd0123abcd0123abcd0123abcd"

    func testParsesCustomSchemeBoxPayload() {
        let raw = "manta://pair?box=\(box)&code=123456&verify=K7Q2"
        let payload = MantaPairing.parsePairPayload(raw)
        XCTAssertEqual(payload?.boxId, box)
        XCTAssertEqual(payload?.code, "123456")
        XCTAssertEqual(payload?.verify, "K7Q2")
        XCTAssertNil(payload?.serverUrl)
    }

    func testParsesTokenSpellingAndNoVerify() {
        let raw = "manta://pair?box=\(box)&token=654321"
        let payload = MantaPairing.parsePairPayload(raw)
        XCTAssertEqual(payload?.code, "654321")
        XCTAssertNil(payload?.verify)
    }

    func testParsesDeferredDeeplinkHttpsForm() {
        let raw = "https://app.mantaui.com/m/abc?box=\(box)&code=111222"
        let payload = MantaPairing.parsePairPayload(raw)
        XCTAssertEqual(payload?.boxId, box)
        XCTAssertEqual(payload?.code, "111222")
    }

    func testParsesPrivateServerParam() {
        let raw = "manta://pair?box=\(box)&code=123456&server=http%3A%2F%2F100.64.0.9%3A8787"
        let payload = MantaPairing.parsePairPayload(raw)
        XCTAssertEqual(payload?.serverUrl, "http://100.64.0.9:8787")
    }

    func testRejectsPublicServerParam() {
        let raw = "manta://pair?box=\(box)&code=123456&server=https%3A%2F%2Fevil.example.com"
        XCTAssertNil(MantaPairing.parsePairPayload(raw))
    }

    func testRejectsMalformedInput() {
        XCTAssertNil(MantaPairing.parsePairPayload(""))
        XCTAssertNil(MantaPairing.parsePairPayload("not a url"))
        XCTAssertNil(MantaPairing.parsePairPayload("https://app.mantaui.com/other?box=\(box)&code=123456"))
        XCTAssertNil(MantaPairing.parsePairPayload("manta://pair?code=123456"))          // missing box
        XCTAssertNil(MantaPairing.parsePairPayload("manta://pair?box=\(box)&code=65432")) // 5-digit (clamped? no)
    }

    func testRejectsSevenDigitRawCode() {
        // 6 after clamp but 7 raw digits must be rejected (claim.mjs guard).
        let raw = "manta://pair?box=\(box)&code=1234567"
        XCTAssertNil(MantaPairing.parsePairPayload(raw))
    }

    func testRejectsMalformedVerifyInLink() {
        let raw = "manta://pair?box=\(box)&code=123456&verify=K7"
        XCTAssertNil(MantaPairing.parsePairPayload(raw))
    }

    func testParseEnforcesConfiguredScheme() {
        let raw = "manta-staging://pair?box=\(box)&code=123456"
        XCTAssertNil(MantaPairing.parsePairPayload(raw, scheme: "manta"))
        XCTAssertNotNil(MantaPairing.parsePairPayload(raw, scheme: "manta-staging"))
    }

    func testCodeInPayloadIsNormalizedFromDashSpacing() {
        let raw = "manta://pair?box=\(box)&code=123-456"
        XCTAssertEqual(MantaPairing.parsePairPayload(raw)?.code, "123456")
    }

    // MARK: - Claim classification (claim.mjs classifyClaimResult)

    func testClassifySuccess() {
        let body: [String: Any] = [
            "box_token": box,
            "box_id": box,
            "device_id": "dev_1",
        ]
        let outcome = MantaPairing.classifyClaim(status: 200, body: body)
        guard case .success(let token, let id, let device) = outcome else {
            return XCTFail("expected success")
        }
        XCTAssertEqual(token, box)
        XCTAssertEqual(id, box)
        XCTAssertEqual(device, "dev_1")
    }

    func testClassifyWrongCodeFor400And403() {
        for status in [400, 403] {
            XCTAssertEqual(MantaPairing.classifyClaim(status: status, body: ["error": "bad"]), .wrongCode)
        }
    }

    func testClassifyRateLimited() {
        XCTAssertEqual(MantaPairing.classifyClaim(status: 429, body: ["error": "rate limited"]), .rateLimited)
    }

    func testClassifyServerError() {
        for status in [500, 502, 503] {
            XCTAssertEqual(MantaPairing.classifyClaim(status: status, body: nil), .serverError)
        }
        XCTAssertEqual(MantaPairing.classifyClaim(status: 404, body: nil), .serverError)
    }

    func testClassifyRejectsMalformed200() {
        XCTAssertEqual(MantaPairing.classifyClaim(status: 200, body: nil), .invalidResponse)
        XCTAssertEqual(MantaPairing.classifyClaim(status: 200, body: ["box_token": "short"]), .invalidResponse)
        XCTAssertEqual(MantaPairing.classifyClaim(status: 200, body: ["box_token": box, "box_id": "bad"]), .invalidResponse)
    }

    func testClaimBaseURLLikesServerOverride() {
        let payload = MantaPairing.PairPayload(boxId: box, code: "123456", verify: nil, serverUrl: "http://100.64.0.9:8787")
        XCTAssertEqual(MantaPairing.claimBaseURL(payload)?.absoluteString, "http://100.64.0.9:8787")
        let derived = MantaPairing.PairPayload(boxId: box, code: "123456", verify: nil, serverUrl: nil)
        XCTAssertEqual(MantaPairing.claimBaseURL(derived)?.absoluteString, "https://\(box).boxes.mantaui.com")
    }
}
