import XCTest
@testable import MantaUI

// URLProtocol hook so the asynchronous claim client can be exercised against a
// deterministic, in-process HTTP response without a live box (this is the
// native analog of the web client's fetch-level claim tests; see
// src/shared/claim.test.ts + src/server/index.mjs /auth/claim).
final class MockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class MantaAuthClientTests: XCTestCase {
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

    private func makeClient() -> MantaAuthClient {
        MantaAuthClient(session: makeSession())
    }

    private static func readBody(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    func testClaimPostsCodeToAuthClaimEndpoint() async throws {
        var captured: URLRequest?
        var capturedBody: [String: Any]?
        MockURLProtocol.handler = { request in
            captured = request
            // URLSession moves a request's body into httpBodyStream before it
            // reaches the protocol; drain the stream to read it.
            let bodyData = Self.readBody(of: request)
            capturedBody = try? JSONSerialization.jsonObject(with: bodyData) as? [String: Any]
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let body = ["box_token": self.box, "box_id": self.box]
            let data = try JSONSerialization.data(withJSONObject: body)
            return (response, data)
        }
        let client = makeClient()
        let outcome = await client.claim(serverURL: URL(string: "https://\(box).boxes.mantaui.com")!, code: "123456", verify: "K7Q2", deviceName: "My iPhone")
        guard case .success = outcome else { return XCTFail("expected success") }

        XCTAssertEqual(captured?.url?.path, "/auth/claim")
        XCTAssertEqual(captured?.httpMethod, "POST")
        XCTAssertEqual(captured?.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(capturedBody?["pairing_code"] as? String, "123456")
        XCTAssertEqual(capturedBody?["verify"] as? String, "K7Q2")
        XCTAssertEqual(capturedBody?["name"] as? String, "My iPhone")
    }

    func testClaimSuccessPersistsCredentialsToKeychain() async throws {
        MockURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let body = ["box_token": self.box, "box_id": self.box, "device_id": "dev_1"]
            let data = try! JSONSerialization.data(withJSONObject: body)
            return (response, data)
        }
        let client = makeClient()
        let outcome = await client.claim(serverURL: URL(string: "https://\(box).boxes.mantaui.com")!, code: "123456", verify: nil)
        XCTAssertEqual(MantaPairing.classifyClaim(status: 200, body: ["box_token": box, "box_id": box, "device_id": "dev_1"]), outcome)

        try client.persist(onSuccess: outcome, serverURL: URL(string: "https://\(box).boxes.mantaui.com")!)
        let stored = try KeychainCredentialStore.shared.load()
        XCTAssertEqual(stored?.boxToken, box)
        XCTAssertEqual(stored?.boxId, box)
        XCTAssertEqual(stored?.serverUrl, "https://\(box).boxes.mantaui.com")
    }

    func testClaimWrongCodeDoesNotPersist() async throws {
        MockURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!
            return (response, Data("{\"error\":\"no\"}".utf8))
        }
        let client = makeClient()
        let outcome = await client.claim(serverURL: URL(string: "https://\(box).boxes.mantaui.com")!, code: "111111", verify: nil)
        XCTAssertEqual(outcome, .wrongCode)

        try client.persist(onSuccess: outcome, serverURL: URL(string: "https://\(box).boxes.mantaui.com")!)
        XCTAssertNil(try KeychainCredentialStore.shared.load())
    }

    func testClaimNetworkFailureClassifiesUnreachable() async throws {
        MockURLProtocol.handler = { _ in
            throw URLError(.notConnectedToInternet)
        }
        let client = makeClient()
        let outcome = await client.claim(serverURL: URL(string: "https://\(box).boxes.mantaui.com")!, code: "123456", verify: nil)
        XCTAssertEqual(outcome, .network)
    }
}
