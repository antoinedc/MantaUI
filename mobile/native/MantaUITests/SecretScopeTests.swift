import XCTest
@testable import MantaUI

// ===========================================================================
// WS07 F7b — the add-secret form's scope: "shared" (default, desktop parity)
// sends no session id; "project" and "session" do. Pure — runs under `verify.sh`.
// ===========================================================================

final class SecretScopeTests: XCTestCase {

    private func json(_ input: SecretInput) throws -> [String: Any] {
        let data = try JSONEncoder().encode(input)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testSharedScopeOmitsTheSessionID() throws {
        let input = SecretScopeOption.input(key: "GITHUB_PAT", value: "v", scope: .shared, sessionId: "ses_1", hint: nil)
        let object = try json(input)
        XCTAssertEqual(object["scope"] as? String, "shared")
        XCTAssertNil(object["sessionID"], "a shared secret carries no session id")
        XCTAssertEqual(object["key"] as? String, "GITHUB_PAT")
        XCTAssertEqual(object["value"] as? String, "v")
        XCTAssertNil(object["hint"])
    }

    func testProjectAndSessionScopesSendTheSessionID() throws {
        for scope in [SecretScopeOption.project, .session] {
            let object = try json(SecretScopeOption.input(key: "K", value: "v", scope: scope, sessionId: "ses_1", hint: "note"))
            XCTAssertEqual(object["scope"] as? String, scope.wireScope)
            XCTAssertEqual(object["sessionID"] as? String, "ses_1", "\(scope)")
            XCTAssertEqual(object["hint"] as? String, "note")
        }
    }

    func testABlankHintIsOmitted() throws {
        let object = try json(SecretScopeOption.input(key: "K", value: "v", scope: .session, sessionId: "s", hint: "   "))
        XCTAssertNil(object["hint"])
    }

    func testOptionsAndTitles() {
        XCTAssertEqual(SecretScopeOption.allCases, [.shared, .project, .session])
        XCTAssertEqual(SecretScopeOption.shared.title, "Shared — every session")
        XCTAssertEqual(SecretScopeOption.project.title, "This project")
        XCTAssertEqual(SecretScopeOption.session.title, "This session")
        XCTAssertEqual(SecretScopeOption.shared.wireScope, "shared")
    }

    func testBadges() {
        func meta(_ scope: String?, project: String? = nil) -> SecretMeta {
            SecretMeta(id: "i", key: "K", scope: scope, sessionID: nil, project: project, hint: nil, hasValue: true)
        }
        XCTAssertEqual(SecretScopeOption.badge(meta("shared")), "shared")
        XCTAssertEqual(SecretScopeOption.badge(meta("project", project: "manta")), "project:manta")
        XCTAssertEqual(SecretScopeOption.badge(meta("project")), "project:?")
        XCTAssertEqual(SecretScopeOption.badge(meta("session")), "session")
        XCTAssertEqual(SecretScopeOption.badge(meta(nil)), "session")
    }
}
