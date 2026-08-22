import XCTest
@testable import MantaUI

// BET-1308 — the onboarding flow's claim-deduplication guards. Reuses the
// existing MockURLProtocol harness from MantaAuthClientTests so there is one
// HTTP stub for the whole suite.
@MainActor
final class MantaOnboardingFlowTests: XCTestCase {
    private let box = "0123abcd0123abcd0123abcd0123abcd"

    override func tearDown() {
        try? KeychainCredentialStore().delete()
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func makeFlow() -> MantaOnboardingFlow {
        MantaOnboardingFlow(auth: MantaAuthClient(session: makeSession()), onPaired: {})
    }

    private func payload() -> MantaPairing.PairPayload {
        MantaPairing.PairPayload(boxId: box, code: "123456", serverUrl: nil)
    }

    /// The claim task runs on the main actor; polling with sleeps yields it the
    /// CPU to progress until the flow leaves the `.linking` phase.
    private func awaitSettled(_ flow: MantaOnboardingFlow, timeout: TimeInterval = 5) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if flow.phase != .linking { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return flow.phase != .linking
    }

    func testDuplicatePayloadFiresExactlyOneClaim() async throws {
        var requestCount = 0
        MockURLProtocol.handler = { request in
            requestCount += 1
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let body: [String: Any] = ["box_token": self.box, "box_id": self.box, "device_id": "dev_1"]
            let data = try! JSONSerialization.data(withJSONObject: body)
            return (response, data)
        }
        let flow = makeFlow()
        let payload = payload()
        // A successful QR decode can deliver the same payload on many frames;
        // only the first claim of the batch may run.
        flow.receive(payload: payload)
        flow.receive(payload: payload)
        flow.receive(payload: payload)
        _ = await awaitSettled(flow)
        XCTAssertEqual(flow.phase, .notifications)
        XCTAssertEqual(requestCount, 1, "exactly one /auth/claim request for a duplicate payload batch")
    }

    func testSecondPayload403DoesNotOverwriteSuccess() async throws {
        var requestCount = 0
        MockURLProtocol.handler = { request in
            requestCount += 1
            if requestCount == 1 {
                let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                let body: [String: Any] = ["box_token": self.box, "box_id": self.box, "device_id": "dev_1"]
                let data = try! JSONSerialization.data(withJSONObject: body)
                return (response, data)
            }
            // A single-use code burns on the first claim and 403s every later
            // attempt — that must never clobber the successful claim.
            let response = HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!
            return (response, Data("{\"error\":\"no\"}".utf8))
        }
        let flow = makeFlow()
        let payload = payload()
        flow.receive(payload: payload)
        flow.receive(payload: payload)
        _ = await awaitSettled(flow)
        XCTAssertEqual(flow.phase, .notifications, "a duplicate's 403 must not overwrite a successful claim")
        XCTAssertFalse(isRejected(flow))
        XCTAssertEqual(requestCount, 1, "the in-flight guard drops the duplicate, so its 403 is never sent")
    }

    private func isRejected(_ flow: MantaOnboardingFlow) -> Bool {
        if case .failure(.rejected) = flow.phase { return true }
        return false
    }
}
