import XCTest
@testable import MantaUI

// ===========================================================================
// WS04 §6 — the clone flow's pure logic (Linux-eligible).
// ===========================================================================

final class CloneFromGitHubTests: XCTestCase {

    private func repo(_ name: String, owner: String, desc: String? = nil) -> GitHubRepo {
        GitHubRepo(name: name, fullName: "\(owner)/\(name)", owner: owner, description: desc)
    }

    // MARK: error kind

    func testDestinationBeatsPermission() {
        // A destination problem must never be blamed on the token, even when the
        // text also says "permission denied".
        XCTAssertEqual(CloneErrorKind.classify("fatal: destination path 'x' already exists and is not an empty directory. permission denied"), .destination)
        XCTAssertEqual(CloneErrorKind.classify("could not create leading directories of '/a/b'"), .destination)
    }

    func testRepositoryNotFoundIsPermission() {
        XCTAssertEqual(CloneErrorKind.classify("remote: Repository not found."), .permission)
        XCTAssertEqual(CloneErrorKind.classify("fatal: could not read Username for 'https://github.com'"), .permission)
        XCTAssertEqual(CloneErrorKind.classify("error: 403"), .permission)
    }

    func testNoSpaceIsDisk() {
        XCTAssertEqual(CloneErrorKind.classify("write error: No space left on device"), .disk)
    }

    func testResolveHostIsNetwork() {
        XCTAssertEqual(CloneErrorKind.classify("fatal: unable to access: Could not resolve host: github.com"), .network)
    }

    func testGarbageIsUnknown() {
        XCTAssertEqual(CloneErrorKind.classify("¯\\_(ツ)_/¯"), .unknown)
        XCTAssertEqual(CloneErrorKind.classify(""), .unknown)
    }

    // MARK: copy

    func testFailureCopy() {
        XCTAssertEqual(CloneFailureCopy.message(kind: .permission, raw: "x"), "permission denied. The token may not have access to this repository.")
        XCTAssertEqual(CloneFailureCopy.message(kind: .disk, raw: "x"), "not enough disk space in the clone location.")
        XCTAssertEqual(CloneFailureCopy.message(kind: .network, raw: "x"), "a network error prevented the clone.")
        // The destination text is the server's, shown verbatim.
        XCTAssertEqual(CloneFailureCopy.message(kind: .destination, raw: "/a already exists and isn't empty."), "/a already exists and isn't empty.")
        XCTAssertEqual(CloneFailureCopy.message(kind: .unknown, raw: "boom"), "boom")
    }

    func testRepoListErrorMessages() {
        XCTAssertEqual(RepoListError.message(code: "not_connected"), "GitHub isn't connected. Go back and sign in again.")
        XCTAssertEqual(RepoListError.message(code: "rejected"), "GitHub isn't connected. Go back and sign in again.")
        XCTAssertEqual(RepoListError.message(code: "rate_limited"), "GitHub's rate limit is used up. Try again in a few minutes.")
        XCTAssertTrue(RepoListError.message(code: "forbidden").contains("SSO"))
        XCTAssertEqual(RepoListError.message(code: "network"), "Couldn't reach GitHub from your server. Check its connection and try again.")
        XCTAssertEqual(RepoListError.message(code: "some raw exception"), "Couldn't list your repositories from GitHub.")
        XCTAssertEqual(RepoListError.message(code: nil), "Couldn't list your repositories from GitHub.")
    }

    func testOnlyRejectedAndNotConnectedNeedSignIn() {
        XCTAssertTrue(RepoListError.needsSignIn(code: "rejected"))
        XCTAssertTrue(RepoListError.needsSignIn(code: "not_connected"))
        XCTAssertFalse(RepoListError.needsSignIn(code: "network"))
        XCTAssertFalse(RepoListError.needsSignIn(code: nil))
    }

    // MARK: picker

    func testFilterOwnerAndQueryAreCaseInsensitive() {
        let repos = [repo("Api", owner: "acme"), repo("web", owner: "acme"), repo("api-tools", owner: "me")]
        XCTAssertEqual(ClonePicker.filter(repos: repos, owner: nil, query: "API").map(\.name), ["Api", "api-tools"])
        XCTAssertEqual(ClonePicker.filter(repos: repos, owner: "acme", query: "api").map(\.name), ["Api"])
        XCTAssertEqual(ClonePicker.filter(repos: repos, owner: "me", query: "").map(\.name), ["api-tools"])
        XCTAssertEqual(ClonePicker.filter(repos: repos, owner: nil, query: "acme/we").map(\.name), ["web"])
        XCTAssertEqual(ClonePicker.filter(repos: repos, owner: nil, query: "nothing"), [])
    }

    func testOwnersAreSortedAndUnique() {
        let repos = [repo("a", owner: "zed"), repo("b", owner: "acme"), repo("c", owner: "zed"), repo("d", owner: "")]
        XCTAssertEqual(ClonePicker.owners(repos), ["acme", "zed"])
    }

    func testDestStripsTrailingSlashes() {
        XCTAssertEqual(ClonePicker.dest(root: "/home/u/projects/", name: "api"), "/home/u/projects/api")
        XCTAssertEqual(ClonePicker.dest(root: "/home/u/projects///", name: "api"), "/home/u/projects/api")
        XCTAssertEqual(ClonePicker.dest(root: "/r", name: "api"), "/r/api")
    }

    func testBytesUseTheFileCountStyle() {
        // Pinned: ByteCountFormatter `.file` (decimal units), what Files shows.
        XCTAssertEqual(CloneProgressCopy.bytes(0), "Zero KB")
        // The decimal separator follows the device region ("1.5" / "1,5").
        XCTAssertTrue(["1.5 MB", "1,5 MB"].contains(CloneProgressCopy.bytes(1_500_000)))
        XCTAssertEqual(CloneProgressCopy.bytes(-5), "Zero KB")
    }

    func testHeadline() {
        XCTAssertEqual(CloneProgressCopy.headline(name: "api", percent: 42.4, bytes: 1_500_000),
                       "Cloning api · 42% · \(CloneProgressCopy.bytes(1_500_000))")
        XCTAssertEqual(CloneProgressCopy.headline(name: "api", percent: 250, bytes: 0), "Cloning api · 100% · Zero KB")
    }

    // MARK: decoders

    func testCloneStatusNullDecodesAsNil() throws {
        // `forge:clone-status` answers `null` once the box forgot the job; the
        // client's `call` turns the envelope's null into nil, and a snapshot decodes.
        let json = #"{"id":"c1","name":"api","url":"u","dest":"/r/api","percent":12.5,"bytes":2048,"done":false,"ok":false,"cancelled":false}"#
        let status = try JSONDecoder().decode(CloneJobStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.percent, 12.5)
        XCTAssertFalse(status.done)
        XCTAssertNil(status.error)
        let failed = try JSONDecoder().decode(CloneJobStatus.self, from: Data(#"{"id":"c1","done":true,"ok":false,"error":"boom"}"#.utf8))
        XCTAssertTrue(failed.done)
        XCTAssertEqual(failed.error, "boom")
        XCTAssertThrowsError(try JSONDecoder().decode(CloneJobStatus.self, from: Data("null".utf8)))
    }

    func testRepoListDecodesError() throws {
        let list = try JSONDecoder().decode(GitHubRepoList.self, from: Data(#"{"repos":[],"stale":false,"error":"rate_limited"}"#.utf8))
        XCTAssertEqual(list.error, "rate_limited")
        XCTAssertEqual(list.repos, [])
        let ok = try JSONDecoder().decode(GitHubRepoList.self, from: Data("""
        {"repos":[{"name":"api","fullName":"acme/api","owner":"acme","description":null,"pushedAt":1730000000000,"defaultBranch":"main","cloneUrl":"https://github.com/acme/api.git","url":"https://github.com/acme/api"},{"bad":1}],"stale":true,"error":null}
        """.utf8))
        XCTAssertEqual(ok.repos.map(\.fullName), ["acme/api"])
        XCTAssertTrue(ok.stale)
        XCTAssertNil(ok.error)
        XCTAssertNil(ok.repos[0].description)
    }

    func testCloneStartResultShapes() throws {
        XCTAssertEqual(try JSONDecoder().decode(CloneStartResult.self, from: Data(#"{"id":"c1"}"#.utf8)).id, "c1")
        let refused = try JSONDecoder().decode(CloneStartResult.self, from: Data(#"{"error":"dest_not_empty","message":"/a isn't empty."}"#.utf8))
        XCTAssertNil(refused.id)
        XCTAssertEqual(refused.message, "/a isn't empty.")
    }
}
