import XCTest
import Combine
@testable import MantaUI

// WS10 F18 — the Updates screen's store wiring: the connection subscription is
// stable and idempotent (a replayed value must never publish, or the screen
// re-renders, re-subscribes and loops), an update never starts without a known
// starting version, and a CLI update waits for an in-flight check. App-target
// only (@MainActor / Combine); run through the Mac `test-unit`.

private final class UpdatesFake: @unchecked Sendable {
    private let lock = NSLock()
    private var _applies = 0, _versionReads = 0, _checks = 0
    var versionResult: Result<ServerVersionInfo, Error> = .success(ServerVersionInfo(version: "0.0.39"))
    var checkGate: CheckedContinuation<Void, Never>?
    var gateChecks = false

    var applies: Int { lock.lock(); defer { lock.unlock() }; return _applies }
    var versionReads: Int { lock.lock(); defer { lock.unlock() }; return _versionReads }
    var checks: Int { lock.lock(); defer { lock.unlock() }; return _checks }

    func setVersion(_ r: Result<ServerVersionInfo, Error>) { lock.lock(); versionResult = r; lock.unlock() }
    func setGate(_ on: Bool) { lock.lock(); gateChecks = on; lock.unlock() }

    func version() throws -> ServerVersionInfo {
        lock.lock(); _versionReads += 1; let r = versionResult; lock.unlock()
        return try r.get()
    }
    func apply() -> RawRPCResponse {
        lock.lock(); _applies += 1; lock.unlock()
        return RawRPCResponse(status: 200, body: Data(#"{"result":{"ok":true}}"#.utf8))
    }
    private func recordCheck() -> Bool {
        lock.lock(); defer { lock.unlock() }
        _checks += 1
        return gateChecks
    }
    func check() async throws -> ServerUpdateCheck {
        if recordCheck() {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                lock.lock(); checkGate = c; lock.unlock()
            }
        }
        return ServerUpdateCheck(
            available: true, version: "0.0.40",
            view: ServerUpdateView(targets: [UpdateTargetView(id: "server", label: "Manta Server", tone: "action", text: "Update available", hasUpdate: true, versionText: "0.0.39 → 0.0.40")]))
    }
    func openGate() {
        lock.lock(); let c = checkGate; checkGate = nil; lock.unlock()
        c?.resume()
    }
    var gateIsWaiting: Bool { lock.lock(); defer { lock.unlock() }; return checkGate != nil }
}

@MainActor
private final class Flag { var value = false }

@MainActor
final class SettingsUpdatesStoreTests: XCTestCase {

    private func makeStore(_ fake: UpdatesFake) -> SettingsUpdatesStore {
        SettingsUpdatesStore(
            dependencies: .init(
                version: { try fake.version() },
                check: { try await fake.check() },
                cliUpdate: { _ in CliUpdateResult(ok: true) },
                apply: { fake.apply() }),
            tickInterval: .seconds(3600))
    }

    private func eventually(_ message: String, _ condition: @MainActor () -> Bool) async {
        let deadline = Date().addingTimeInterval(2)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(condition(), message)
    }

    // MARK: - Connection subscription (blocking finding 1)

    func testARepeatedConnectionValueNeverPublishes() async {
        let fake = UpdatesFake()
        let store = makeStore(fake)
        var emissions = 0
        let sub = store.objectWillChange.sink { emissions += 1 }
        defer { sub.cancel() }

        // The flow starts "connected": a replay of `true` changes nothing.
        store.connectionChanged(connected: true)
        store.connectionChanged(connected: true)
        XCTAssertEqual(emissions, 0)
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(fake.versionReads, 0, "no version read starts when no update is in flight")

        store.connectionChanged(connected: false)
        XCTAssertEqual(emissions, 1)
        store.connectionChanged(connected: false)
        XCTAssertEqual(emissions, 1)
    }

    func testBindingTwiceKeepsOneSubscription() async {
        let fake = UpdatesFake()
        let store = makeStore(fake)
        let subject = PassthroughSubject<Bool, Never>()
        var emissions = 0
        let sub = store.objectWillChange.sink { emissions += 1 }
        defer { sub.cancel() }

        store.bind(connection: subject.eraseToAnyPublisher())
        store.bind(connection: subject.eraseToAnyPublisher())
        subject.send(false)
        await eventually("the edge is applied") { !store.flow.connected }
        XCTAssertEqual(emissions, 1, "one subscription → one publish")
        subject.send(false)
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(emissions, 1)
    }

    // MARK: - Unknown starting version (finding 6)

    func testAnUpdateWithAnUnreadableVersionFailsWithoutApplying() async {
        let fake = UpdatesFake()
        fake.setVersion(.failure(MantaError.transport("down")))
        let store = makeStore(fake)

        store.requestServerUpdate()
        store.confirmServerUpdate()
        await store.settledStart()

        XCTAssertEqual(store.flow.phase, .failed(SettingsUpdatesStore.unknownVersionMessage))
        XCTAssertEqual(fake.applies, 0, "nothing is applied without a starting version")
        XCTAssertFalse(store.startingUpdate)
    }

    func testAMissingVersionIsReadBeforeTheUpdateStarts() async {
        let fake = UpdatesFake()
        let store = makeStore(fake)
        XCTAssertNil(store.serverVersion)

        store.requestServerUpdate()
        store.confirmServerUpdate()
        await store.settledStart()
        await eventually("apply ran") { fake.applies == 1 }

        XCTAssertEqual(store.serverVersion, "0.0.39")
        XCTAssertEqual(store.flow.fromVersion, "0.0.39")
    }

    func testTheDialogDismissalCannotCancelAnUpdateThatIsStarting() async {
        let fake = UpdatesFake()
        let store = makeStore(fake)
        store.requestServerUpdate()
        store.confirmServerUpdate()
        // The confirmation dialog dismisses right after its button action.
        store.cancelServerUpdate()
        await store.settledStart()
        await eventually("apply ran") { fake.applies == 1 }
        XCTAssertNotEqual(store.flow.phase, .idle)
    }

    // MARK: - CLI update waits for a running check (finding 14)

    func testACheckCalledWhileOneRunsAwaitsIt() async {
        let fake = UpdatesFake()
        fake.setGate(true)
        let store = makeStore(fake)

        let first = Task { await store.check() }
        await eventually("first check reached the gate") { fake.gateIsWaiting }

        let secondDone = Flag()
        let second = Task { await store.check(); secondDone.value = true }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(secondDone.value, "the second caller waits for the in-flight check")
        XCTAssertEqual(fake.checks, 1, "…and does not start another")

        fake.openGate()
        await first.value
        await second.value
        XCTAssertTrue(secondDone.value)
        XCTAssertFalse(store.checking)
        XCTAssertEqual(store.targets.first?.versionText, "0.0.39 → 0.0.40")
    }
}
