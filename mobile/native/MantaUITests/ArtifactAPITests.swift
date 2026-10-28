import XCTest
@testable import MantaUI

// ===========================================================================
// WS07 — the wire the artifacts / webhooks cards send, and the credential rule
// for remote files. Mac-only (`MantaAPIClient` needs the Keychain store and is not
// in the Linux SwiftPM package); run through `ios-mantaui` `test-unit`.
// ===========================================================================

final class ArtifactAPITests: XCTestCase {

    private var box: URL { URL(string: "https://box.example") ?? URL(fileURLWithPath: "/") }

    private func body(_ request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testWebhookListRequest() throws {
        let request = try MantaAPIClient.makeRequest(serverURL: box, channel: "webhook:list", args: ["ses_1"], token: "t")
        XCTAssertEqual(request.url?.path, "/rpc/webhook:list")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(try body(request)["args"] as? [String], ["ses_1"])
    }

    func testWebhookDeleteRequest() throws {
        let request = try MantaAPIClient.makeRequest(serverURL: box, channel: "webhook:delete", args: ["ab12cd34"], token: "t")
        XCTAssertEqual(request.url?.path, "/rpc/webhook:delete")
        XCTAssertEqual(try body(request)["args"] as? [String], ["ab12cd34"])
    }

    func testArtifactsListSendsOneOptionsObject() throws {
        let request = try MantaAPIClient.makeRequest(serverURL: box, channel: "artifacts:list",
                                                     args: [["sessionId": "ses_1"]], token: "t")
        XCTAssertEqual(request.url?.path, "/rpc/artifacts:list")
        let args = try XCTUnwrap(try body(request)["args"] as? [[String: String]])
        XCTAssertEqual(args, [["sessionId": "ses_1"]])
    }

    /// The box token must never reach another origin: a remote file is fetched with
    /// no `Authorization` header and no cookies, on its own session.
    func testARemoteFileRequestCarriesNoCredentials() throws {
        let url = try XCTUnwrap(URL(string: "https://cdn.example.com/a.png"))
        let request = ArtifactBytes.remoteRequest(for: url)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        XCTAssertFalse(request.httpShouldHandleCookies)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.timeoutInterval, 30)
        XCTAssertEqual(request.url, url)
    }

    func testBytesLoaderRoutesEachSource() async throws {
        let api = MantaAPIClient(serverURL: box, tokenProvider: { nil })
        let data = try await ArtifactBytes.load(.dataURI("data:text/plain;base64,aGVsbG8="), api: api).get()
        XCTAssertEqual(data, Data("hello".utf8))

        let bad = await ArtifactBytes.load(.dataURI("data:image/png;base64,@@@"), api: api)
        XCTAssertEqual(bad, .failure(.badDataURI))

        let unsupported = await ArtifactBytes.load(.unsupported, api: api)
        XCTAssertEqual(unsupported, .failure(.missing))

        let remoteURL = try XCTUnwrap(URL(string: "https://cdn.example.com/a.png"))
        let remote = await ArtifactBytes.load(.remote(remoteURL), api: api,
                                              remote: { _ in .failure(.remote(host: "cdn.example.com")) })
        XCTAssertEqual(remote, .failure(.remote(host: "cdn.example.com")))
    }
}
