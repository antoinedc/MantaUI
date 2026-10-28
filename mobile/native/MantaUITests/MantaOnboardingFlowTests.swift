import XCTest
@testable import MantaUI

// BET-1308 — the onboarding flow's claim-deduplication guards. Reuses the
// existing MockURLProtocol harness from MantaAuthClientTests so there is one
// HTTP stub for the whole suite.
//
// WS10 F20/F21: a scanned / linked payload is STAGED for "Link this phone?" and
// claims only after `confirmLink()`; the manual path (the user typed the code)
// claims directly from the one "Server address" field.
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
        flow.confirmLink()
        flow.receive(payload: payload) // …and frames arriving while linking are ignored too
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
        flow.confirmLink()
        _ = await awaitSettled(flow)
        XCTAssertEqual(flow.phase, .notifications, "a duplicate's 403 must not overwrite a successful claim")
        XCTAssertFalse(isRejected(flow))
        XCTAssertEqual(requestCount, 1, "the in-flight guard drops the duplicate, so its 403 is never sent")
    }

    /// BET-1309 — lock in the `claimGeneration` staleness guard directly. The
    /// `claimInFlight` guard serialises claims, so the genuine out-of-order
    /// interleave is unreachable through `receive` alone; drain it by driving
    /// `runClaim` with a stale generation and asserting its write is dropped.
    func testStaleClaimResultDoesNotOverwriteNewerClaim() async throws {
        var requestCount = 0
        let success: ([String: Any]) -> (HTTPURLResponse, Data) = { body in
            let response = HTTPURLResponse(url: URL(string: "https://claim")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, try! JSONSerialization.data(withJSONObject: body))
        }
        MockURLProtocol.handler = { request in
            requestCount += 1
            return success(["box_token": self.box, "box_id": self.box, "device_id": "dev_1"])
        }
        let flow = makeFlow()
        let payload = payload()

        // Two sequential claims advance `claimGeneration` to 2; the newest wins.
        flow.receive(payload: payload)
        flow.confirmLink()
        _ = await awaitSettled(flow)
        flow.receive(payload: payload)
        flow.confirmLink()
        _ = await awaitSettled(flow)
        XCTAssertEqual(flow.phase, .notifications, "the newest claim succeeded")

        // A stale result for the ORIGINAL (generation 1) claim arrives now. It
        // reaches the network and classifies as .wrongCode, but because its
        // generation is no longer current it must NOT write .failure(.rejected).
        MockURLProtocol.handler = { request in
            requestCount += 1
            let response = HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!
            return (response, Data("{\"error\":\"no\"}".utf8))
        }
        await flow.runClaim(payload, generation: 1)

        XCTAssertEqual(requestCount, 3, "the stale claim's request really ran — only its write was suppressed")
        XCTAssertEqual(flow.phase, .notifications, "a stale claim result must not overwrite a newer claim")
        XCTAssertFalse(isRejected(flow))
    }

    private func isRejected(_ flow: MantaOnboardingFlow) -> Bool {
        if case .failure(.rejected) = flow.phase { return true }
        return false
    }

    // MARK: - "Link this phone?" (WS10 F20)

    private func stubSuccess(_ counter: @escaping () -> Void = {}) {
        MockURLProtocol.handler = { request in
            counter()
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let body: [String: Any] = ["box_token": self.box, "box_id": self.box, "device_id": "dev_1"]
            return (response, try! JSONSerialization.data(withJSONObject: body))
        }
    }

    func testAScannedPayloadIsStagedNotClaimed() async throws {
        var requestCount = 0
        stubSuccess { requestCount += 1 }
        let flow = makeFlow()
        flow.receive(payload: payload())
        XCTAssertEqual(flow.phase, .confirm)
        XCTAssertEqual(flow.pending, payload())
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(requestCount, 0, "nothing is claimed before the user confirms")
        XCTAssertEqual(flow.phase, .confirm)
    }

    func testADuplicatePayloadWhileConfirmingIsIgnored() {
        let flow = makeFlow()
        let first = payload()
        flow.receive(payload: first)
        flow.receive(payload: MantaPairing.PairPayload(boxId: box, code: "999999", serverUrl: nil))
        XCTAssertEqual(flow.pending, first, "the staged payload is not replaced by a later frame")
    }

    func testConfirmLinkStartsTheClaim() async {
        var requestCount = 0
        stubSuccess { requestCount += 1 }
        let flow = makeFlow()
        flow.receive(payload: payload())
        flow.confirmLink()
        XCTAssertEqual(flow.phase, .linking)
        _ = await awaitSettled(flow)
        XCTAssertEqual(flow.phase, .notifications)
        XCTAssertEqual(requestCount, 1)
    }

    func testConfirmLinkOutsideTheConfirmDoesNothing() {
        let flow = makeFlow()
        flow.confirmLink()
        XCTAssertEqual(flow.phase, .entry)
    }

    func testAConfirmedSwitchSkipsTheConfirm() async {
        var paired = 0
        MockURLProtocol.handler = nil
        stubSuccess()
        let flow = MantaOnboardingFlow(auth: MantaAuthClient(session: makeSession()), onPaired: { paired += 1 })
        flow.isSwitching = true // the paired "Switch server?" sheet already confirmed
        flow.receive(payload: payload())
        XCTAssertEqual(flow.phase, .linking)
        _ = await awaitSettled(flow)
        XCTAssertEqual(paired, 1)
    }

    func testThisIsntMyBoxNeverClaims() async throws {
        var requestCount = 0
        stubSuccess { requestCount += 1 }
        let flow = makeFlow()
        flow.receive(payload: payload())
        flow.rejectPending()
        XCTAssertEqual(flow.phase, .notMine)
        flow.confirmLink() // not reachable from here
        XCTAssertEqual(flow.phase, .notMine)
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(requestCount, 0)

        // "Let me look again" returns to the confirm with the same payload.
        flow.reviewAgain()
        XCTAssertEqual(flow.phase, .confirm)
        XCTAssertEqual(flow.pending, payload())

        // "Cancel" clears the payload and returns to the entry screen.
        flow.rejectPending()
        flow.backToEntry()
        XCTAssertEqual(flow.phase, .entry)
        XCTAssertNil(flow.pending)
        XCTAssertEqual(requestCount, 0)
    }

    // MARK: - Manual "Server address" (WS10 F21)

    func testManualContinueWithCodeAndAServerAddressSkipsTheConfirm() async {
        var requestCount = 0
        var claimedHost: String?
        MockURLProtocol.handler = { request in
            requestCount += 1
            claimedHost = request.url?.host
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let body: [String: Any] = ["box_token": self.box, "box_id": self.box, "device_id": "dev_1"]
            return (response, try! JSONSerialization.data(withJSONObject: body))
        }
        let flow = makeFlow()
        flow.code = "123456"
        flow.serverURL = "100.64.0.9:8787"
        XCTAssertTrue(flow.canContinueManually)
        flow.manualContinue()
        XCTAssertEqual(flow.phase, .linking, "typed codes claim directly")
        _ = await awaitSettled(flow)
        XCTAssertEqual(flow.phase, .notifications)
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(claimedHost, "100.64.0.9")
    }

    func testManualContinueWithAServerIDClaimsOnThePublicHost() async {
        var claimedHost: String?
        MockURLProtocol.handler = { request in
            claimedHost = request.url?.host
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let body: [String: Any] = ["box_token": self.box, "box_id": self.box, "device_id": "dev_1"]
            return (response, try! JSONSerialization.data(withJSONObject: body))
        }
        let flow = makeFlow()
        flow.code = "123456"
        flow.serverURL = box.uppercased()
        flow.manualContinue()
        _ = await awaitSettled(flow)
        XCTAssertEqual(claimedHost, "\(box).boxes.mantaui.com")
    }

    func testAnInvalidAddressShowsItsReasonAndDoesNotLink() {
        let flow = makeFlow()
        flow.code = "123456"
        flow.serverURL = "my box"
        XCTAssertFalse(flow.canContinueManually)
        XCTAssertEqual(flow.serverAddressError, "A server address can't contain spaces.")
        flow.manualContinue()
        XCTAssertEqual(flow.manualError, "A server address can't contain spaces.")
        XCTAssertEqual(flow.phase, .entry)
    }

    func testContinueNeedsSixDigitsAndAResolvableAddress() {
        let flow = makeFlow()
        flow.serverURL = "https://example.com"
        flow.code = "12345"
        XCTAssertFalse(flow.canContinueManually)
        flow.code = "123456"
        XCTAssertTrue(flow.canContinueManually)
        flow.serverURL = ""
        XCTAssertFalse(flow.canContinueManually)
        XCTAssertNil(flow.serverAddressError, "an empty field is not an error — Continue is just disabled")
        flow.serverURL = "http://example.com"
        XCTAssertFalse(flow.canContinueManually)
        XCTAssertEqual(flow.serverAddressError, "Use https:// for an address reachable from the internet.")
    }

    func testManualContinueWithoutSixDigitsAsksForThem() {
        let flow = makeFlow()
        flow.code = "12"
        flow.serverURL = "https://example.com"
        flow.manualContinue()
        XCTAssertEqual(flow.manualError, "Enter the six-digit code.")
        XCTAssertEqual(flow.phase, .entry)
    }
}
