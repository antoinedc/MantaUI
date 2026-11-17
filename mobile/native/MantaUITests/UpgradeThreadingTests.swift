import XCTest
@testable import MantaUI

// ===========================================================================
// A1 (spec 2026-11-17): `.mantaBoxUpgrading` is posted from URLSession threads.
// `UpgradeStore` is @MainActor, and under Swift 6 a Combine sink closure of a
// main-actor type TRAPS (EXC_BREAKPOINT) when it runs on another thread — the
// Crashlytics crash "closure #4 in UpgradeStore.bind(eventStore:)". These tests
// post from a background queue: the old code died on the first one.
//
// Mac-only (Combine + main-actor stores); run through `ios-mantaui` `test-unit`.
// ===========================================================================

private final class UpgradeThreadingStream: MantaEventStreamControl {
    var onState: ((MantaConnectionState) -> Void)?
    var onMessage: ((String) -> Void)?
    var onReconnect: (() -> Void)?
    var onConfigError: ((Error) -> Void)?
    var hasConnectedOnce = false
    var currentState: MantaConnectionState = .idle

    func ensure() {}
    func markReconnectAndEnsure() {}
    func retryNow() {}
    func forceReconnect() {}
    func close(reason: String) {}
}

@MainActor
final class UpgradeThreadingTests: XCTestCase {

    private func boundStore() -> UpgradeStore {
        let events = MantaEventStore(stream: UpgradeThreadingStream(), tokenProvider: { nil }, serverProvider: { nil })
        // Reads fail (a box that cannot answer yet): only the refusal itself raises the screen.
        let store = UpgradeStore(
            fetch: { throw MantaError.transport("down") },
            pollInterval: .seconds(30),
            act: { _ in UpgradeActionResult(ok: false, error: "unused") }
        )
        store.bind(eventStore: events)
        return store
    }

    func testARefusalPostedFromABackgroundQueueRaisesTheWaitingScreen() async {
        let store = boundStore()
        XCTAssertNil(store.screen)

        DispatchQueue.global().async {
            NotificationCenter.default.post(name: .mantaBoxUpgrading, object: nil)
        }

        let raised = await eventually { store.screen?.kind == .waiting }
        XCTAssertTrue(raised, "a refusal posted off the main thread must reach the store without trapping")
    }

    func testTheNoticeHelperIsSafeFromAnyThread() async {
        let store = boundStore()

        DispatchQueue.global().async {
            UpgradeRefusalNotice.post()
        }

        let raised = await eventually { store.screen?.kind == .waiting }
        XCTAssertTrue(raised)
    }

    func testManyConcurrentBackgroundPostsAreAllSurvived() async {
        let store = boundStore()
        for _ in 0..<50 {
            DispatchQueue.global().async {
                UpgradeRefusalNotice.post()
                NotificationCenter.default.post(name: .mantaBoxUpgrading, object: nil)
            }
        }
        let raised = await eventually { store.screen?.kind == .waiting }
        XCTAssertTrue(raised)
    }
}
