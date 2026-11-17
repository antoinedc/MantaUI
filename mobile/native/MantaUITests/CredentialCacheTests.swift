import XCTest
@testable import MantaUI

// ===========================================================================
// B4 [A half] (spec 2026-11-17): the Keychain item is cached in memory so a chat
// redraw no longer reads the Keychain on the main thread. The cache's rules
// (generation guard, set/invalidate) are tested on `CredentialCache` directly;
// one test goes through the real Keychain to prove two store instances stay
// coherent (the cache is process-wide on purpose).
// ===========================================================================

final class CredentialCacheTests: XCTestCase {

    private let alpha = MantaCredentials(serverUrl: "https://a.example", boxId: "a", boxToken: "token-a")
    private let beta = MantaCredentials(serverUrl: "https://b.example", boxId: "b", boxToken: "token-b")

    func testAFreshCacheKnowsNothing() {
        XCTAssertNil(CredentialCache().snapshot().entry)
    }

    func testAReadFillsTheCacheIncludingNotFound() {
        let cache = CredentialCache()
        let first = cache.snapshot()
        cache.fill(.credentials(alpha), ifGeneration: first.generation)
        XCTAssertEqual(cache.snapshot().entry, .credentials(alpha))

        let empty = CredentialCache()
        empty.fill(.absent, ifGeneration: empty.snapshot().generation)
        XCTAssertEqual(empty.snapshot().entry, .absent, "an unpaired phone must not hit the Keychain on every read")
    }

    func testAWriteReplacesTheEntryAndClearIsNotFound() {
        let cache = CredentialCache()
        cache.set(.credentials(alpha))
        cache.set(.credentials(beta))
        XCTAssertEqual(cache.snapshot().entry, .credentials(beta))
        cache.set(.absent)
        XCTAssertEqual(cache.snapshot().entry, .absent)
    }

    func testInvalidateForgetsSoTheNextReadGoesToTheKeychain() {
        let cache = CredentialCache()
        cache.set(.credentials(alpha))
        cache.invalidate()
        XCTAssertNil(cache.snapshot().entry)
    }

    /// A read that began before a save must not overwrite the saved value with the older answer.
    func testAReadThatRacedAWriteCannotStoreItsStaleAnswer() {
        let cache = CredentialCache()
        let readStarted = cache.snapshot()          // read #1 starts and sees the OLD item
        cache.set(.credentials(beta))               // a save lands meanwhile
        cache.fill(.credentials(alpha), ifGeneration: readStarted.generation) // read #1 finishes late
        XCTAssertEqual(cache.snapshot().entry, .credentials(beta))
    }

    func testAReadThatRacedAnInvalidationDoesNotRefillTheCache() {
        let cache = CredentialCache()
        let readStarted = cache.snapshot()
        cache.invalidate()
        cache.fill(.absent, ifGeneration: readStarted.generation)
        XCTAssertNil(cache.snapshot().entry)
    }

    /// Different instances share one cache: a delete through one is seen by `.shared`.
    func testInstancesStayCoherentThroughTheRealKeychain() throws {
        let writer = KeychainCredentialStore()
        let reader = KeychainCredentialStore.shared
        try writer.delete()
        XCTAssertNil(try reader.load())

        try writer.save(alpha)
        XCTAssertEqual(try reader.load(), alpha)
        XCTAssertEqual(reader.boxToken, "token-a")

        try writer.save(beta)
        XCTAssertEqual(reader.boxToken, "token-b", "a save updates the cache, no stale token")
        XCTAssertEqual(reader.serverURL?.absoluteString, "https://b.example")

        try writer.delete()
        XCTAssertNil(try reader.load(), "a delete clears the cache")
        XCTAssertNil(reader.boxToken)
    }

    override func tearDown() {
        try? KeychainCredentialStore().delete()
        super.tearDown()
    }
}
