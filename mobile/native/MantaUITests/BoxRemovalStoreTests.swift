import XCTest
@testable import MantaUI

// WS10 F15 — the Remove-server I/O ORDER, not just the reducer: revoke ONLY this
// phone → delete the Keychain credentials → show any warning → only then leave.
// A Keychain failure retries ONLY the local delete. App-target only (the store
// is @MainActor / Combine); run through the Mac `test-unit`.

/// Records every call; locked because the dependency closures are @Sendable.
private final class RemovalRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _devices = 0, _revokes: [String] = [], _deletes = 0
    var devicesResult: Result<BoxDevicesResponse, Error>
    var revokeResult: (status: Int?, transportError: Bool) = (200, false)
    var deleteFailures = 0

    init(devices: Result<BoxDevicesResponse, Error>) { devicesResult = devices }

    var devicesCalls: Int { lock.lock(); defer { lock.unlock() }; return _devices }
    var revokes: [String] { lock.lock(); defer { lock.unlock() }; return _revokes }
    var deletes: Int { lock.lock(); defer { lock.unlock() }; return _deletes }

    func devices() throws -> BoxDevicesResponse {
        lock.lock(); _devices += 1; let r = devicesResult; lock.unlock()
        return try r.get()
    }
    func revoke(_ id: String) -> (status: Int?, transportError: Bool) {
        lock.lock(); _revokes.append(id); let r = revokeResult; lock.unlock()
        return r
    }
    func delete() throws {
        lock.lock(); _deletes += 1; let fail = deleteFailures > 0; if fail { deleteFailures -= 1 }; lock.unlock()
        if fail { throw KeychainError.status(-25244) }
    }
}

/// Counts the root-transition announcement (a @MainActor closure is Sendable, so
/// it cannot mutate a captured local).
@MainActor
private final class Announcements { var count = 0 }

@MainActor
final class BoxRemovalStoreTests: XCTestCase {

    private func me() -> BoxDevicesResponse {
        BoxDevicesResponse(devices: [
            BoxDevice(deviceID: "desktop", primary: true),
            BoxDevice(deviceID: "me", current: true),
        ])
    }

    private func makeStore(_ rec: RemovalRecorder, announced: @escaping @MainActor () -> Void) -> BoxRemovalStore {
        BoxRemovalStore(
            dependencies: .init(
                devices: { try rec.devices() },
                revoke: { rec.revoke($0) },
                deleteCredentials: { try rec.delete() }),
            announceRemoved: announced)
    }

    private func eventually(_ message: String, _ condition: @MainActor () -> Bool) async {
        let deadline = Date().addingTimeInterval(2)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(condition(), message)
    }

    func testAnUnconfirmedRevokeWarnsAndLeavesOnlyAfterAcknowledge() async {
        let rec = RemovalRecorder(devices: .success(me()))
        rec.revokeResult = (503, false)
        let announced = Announcements()
        let store = makeStore(rec) { announced.count += 1 }

        store.begin()
        store.confirm()
        await eventually("reaches the warning") {
            if case .warning = store.state { return true } else { return false }
        }
        XCTAssertEqual(rec.revokes, ["me"], "only this phone's own id is revoked")
        XCTAssertEqual(rec.deletes, 1)
        XCTAssertEqual(announced.count, 0, "the app must not leave while the warning is unacknowledged")

        store.acknowledge()
        XCTAssertEqual(store.state, .leaving)
        XCTAssertEqual(announced.count, 1)
        store.acknowledge()
        XCTAssertEqual(announced.count, 1, "announced exactly once")
    }

    func testAKeychainFailureRetriesOnlyTheLocalDelete() async {
        let rec = RemovalRecorder(devices: .success(me()))
        rec.deleteFailures = 1
        let announced = Announcements()
        let store = makeStore(rec) { announced.count += 1 }

        store.begin()
        store.confirm()
        await eventually("local delete fails") {
            if case .localDeleteFailed = store.state { return true } else { return false }
        }
        XCTAssertEqual(announced.count, 0)
        XCTAssertEqual(rec.deletes, 1)

        store.retryLocal()
        XCTAssertEqual(rec.deletes, 2, "the delete is attempted again")
        XCTAssertEqual(rec.devicesCalls, 1, "the device list is not re-read")
        XCTAssertEqual(rec.revokes, ["me"], "the remote revoke is never repeated")
        XCTAssertEqual(store.state, .leaving, "a revoked remote needs no warning")
        XCTAssertEqual(announced.count, 1)
    }

    func testADeadTokenSkipsTheRevokeAndLeavesDirectly() async {
        let rec = RemovalRecorder(devices: .failure(MantaError.authRequired))
        let announced = Announcements()
        let store = makeStore(rec) { announced.count += 1 }

        store.begin()
        store.confirm()
        await eventually("leaves") { store.state == .leaving }
        XCTAssertTrue(rec.revokes.isEmpty)
        XCTAssertEqual(rec.deletes, 1)
        XCTAssertEqual(announced.count, 1)
    }

    func testABlankOwnIdIsNeverRevoked() async {
        let blank = BoxDevicesResponse(devices: [BoxDevice(deviceID: "", current: true)])
        let rec = RemovalRecorder(devices: .success(blank))
        let store = makeStore(rec) {}

        store.begin()
        store.confirm()
        await eventually("warns (no safe target)") {
            if case .warning = store.state { return true } else { return false }
        }
        XCTAssertTrue(rec.revokes.isEmpty, "an empty device_id would reset the whole box")
        XCTAssertEqual(rec.deletes, 1)
    }

    func testCancellingTheConfirmChangesNothing() {
        let rec = RemovalRecorder(devices: .success(me()))
        let store = makeStore(rec) {}
        store.begin()
        store.cancel()
        XCTAssertEqual(store.state, .idle)
        XCTAssertEqual(rec.devicesCalls, 0)
        XCTAssertEqual(rec.deletes, 0)
    }
}
