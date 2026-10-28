import XCTest
@testable import MantaUI

// WS10 F14 / F15 / F17 — adding a device (the QR link, the manual address, the
// countdown), the linked-devices list, and removing THIS phone. Pure,
// Foundation-only: also runs under `./verify.sh`.

final class SettingsBoxTests: XCTestCase {

    private let box = "0123abcd0123abcd0123abcd0123abcd"

    // MARK: - Universal link

    func testUniversalLinkWithoutAServerOverride() {
        XCTAssertEqual(BoxPairing.universalLink(boxId: box, code: "123456", serverUrl: nil),
                       "https://app.mantaui.com/m?box=\(box)&code=123456")
        XCTAssertEqual(BoxPairing.universalLink(boxId: box, code: "123456", serverUrl: ""),
                       "https://app.mantaui.com/m?box=\(box)&code=123456")
    }

    func testUniversalLinkEncodesTheServerLikeEncodeURIComponent() {
        XCTAssertEqual(
            BoxPairing.universalLink(boxId: box, code: "123456", serverUrl: "http://100.64.0.9:8787"),
            "https://app.mantaui.com/m?box=\(box)&code=123456&server=http%3A%2F%2F100.64.0.9%3A8787")
    }

    func testUniversalLinkRoundTripsThroughTheParser() throws {
        let plain = BoxPairing.universalLink(boxId: box, code: "654321", serverUrl: nil)
        XCTAssertEqual(MantaPairing.parsePairPayload(plain),
                       MantaPairing.PairPayload(boxId: box, code: "654321", serverUrl: nil))

        for server in ["http://100.64.0.9:8787", "https://box.tail1234.ts.net", "http://192.168.1.20:8787/manta"] {
            let link = BoxPairing.universalLink(boxId: box, code: "654321", serverUrl: server)
            XCTAssertEqual(MantaPairing.parsePairPayload(link),
                           MantaPairing.PairPayload(boxId: box, code: "654321", serverUrl: server), server)
        }
    }

    // MARK: - QR server override

    func testQRServerOverride() {
        let direct = "https://\(box).boxes.mantaui.com"
        // Same as the box's own public host → no override.
        XCTAssertNil(BoxPairing.qrServerOverride(boxId: box, configured: direct))
        XCTAssertNil(BoxPairing.qrServerOverride(boxId: box, configured: direct + "/"))
        // A custom PUBLIC domain stays out (the parser refuses a public `server=`).
        XCTAssertNil(BoxPairing.qrServerOverride(boxId: box, configured: "https://manta.example.com"))
        // Private / tailnet addresses ride along.
        XCTAssertEqual(BoxPairing.qrServerOverride(boxId: box, configured: "http://100.64.0.9:8787"), "http://100.64.0.9:8787")
        XCTAssertEqual(BoxPairing.qrServerOverride(boxId: box, configured: "http://box.tail1234.ts.net:8787/"), "http://box.tail1234.ts.net:8787")
        // Nothing configured.
        XCTAssertNil(BoxPairing.qrServerOverride(boxId: box, configured: nil))
        XCTAssertNil(BoxPairing.qrServerOverride(boxId: box, configured: "  "))
    }

    // MARK: - Manual address

    func testManualAddressIsTheAddressThisPhoneReachesTheBoxAt() {
        XCTAssertEqual(BoxPairing.manualAddress(boxId: box, connectedServerUrl: "http://100.64.0.9:8787"), "http://100.64.0.9:8787")
        XCTAssertEqual(BoxPairing.manualAddress(boxId: box, connectedServerUrl: "http://100.64.0.9:8787/"), "http://100.64.0.9:8787")
        XCTAssertEqual(BoxPairing.manualAddress(boxId: box, connectedServerUrl: "https://\(box).boxes.mantaui.com/"),
                       "https://\(box).boxes.mantaui.com")
    }

    func testManualAddressFallsBackToThePublicHost() {
        XCTAssertEqual(BoxPairing.manualAddress(boxId: box, connectedServerUrl: nil), "https://\(box).boxes.mantaui.com")
        XCTAssertEqual(BoxPairing.manualAddress(boxId: box, connectedServerUrl: ""), "https://\(box).boxes.mantaui.com")
        XCTAssertNil(BoxPairing.manualAddress(boxId: "not-a-box-id", connectedServerUrl: nil))
    }

    /// The acceptance case: on a Tailscale box a second phone pairs using only the
    /// Code and Server address this screen shows.
    func testTheShownAddressIsExactlyWhatManualSetupAccepts() {
        let shown = BoxPairing.manualAddress(boxId: box, connectedServerUrl: "http://100.64.0.9:8787/")
        XCTAssertEqual(MantaPairing.resolveManualTarget(shown ?? ""), .ok(serverUrl: "http://100.64.0.9:8787", boxId: ""))
    }

    // MARK: - Expiry + countdown

    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    func testShouldRefreshIsInclusiveAtTheEdge() {
        XCTAssertFalse(BoxPairing.shouldRefresh(expiresAt: t0, now: t0.addingTimeInterval(-0.001)))
        XCTAssertTrue(BoxPairing.shouldRefresh(expiresAt: t0, now: t0))
        XCTAssertTrue(BoxPairing.shouldRefresh(expiresAt: t0, now: t0.addingTimeInterval(1)))
    }

    func testCountdownText() {
        let fresh = BoxPairing.countdown(expiresAt: t0.addingTimeInterval(281.4), now: t0)
        XCTAssertEqual(fresh.text, "Expires in 4:41")
        XCTAssertFalse(fresh.low)
        XCTAssertFalse(fresh.expired)
    }

    func testCountdownIsLowUnderAMinute() {
        let low = BoxPairing.countdown(expiresAt: t0.addingTimeInterval(59.9), now: t0)
        XCTAssertEqual(low.text, "Expires in 0:59")
        XCTAssertTrue(low.low)
        let exactlyAMinute = BoxPairing.countdown(expiresAt: t0.addingTimeInterval(60), now: t0)
        XCTAssertEqual(exactlyAMinute.text, "Expires in 1:00")
        XCTAssertFalse(exactlyAMinute.low)
        XCTAssertEqual(BoxPairing.countdown(expiresAt: t0.addingTimeInterval(65), now: t0).text, "Expires in 1:05")
    }

    func testCountdownExpired() {
        let gone = BoxPairing.countdown(expiresAt: t0, now: t0.addingTimeInterval(5))
        XCTAssertEqual(gone.text, "Expired. Generate a new code.")
        XCTAssertTrue(gone.expired)
        XCTAssertTrue(BoxPairing.countdown(expiresAt: t0, now: t0).expired)
    }

    func testParseExpiresAtWithAndWithoutFractionalSeconds() throws {
        let plain = try XCTUnwrap(BoxPairing.parseExpiresAt("2026-10-28T12:00:00Z"))
        let fractional = try XCTUnwrap(BoxPairing.parseExpiresAt("2026-10-28T12:00:00.500Z"))
        XCTAssertEqual(fractional.timeIntervalSince(plain), 0.5, accuracy: 0.001)
        XCTAssertNil(BoxPairing.parseExpiresAt("not a date"))
        XCTAssertNil(BoxPairing.parseExpiresAt(""))
    }

    func testTheWireExpiryIsEpochMilliseconds() throws {
        // What `auth:pair` really sends: a number, not an ISO string.
        let result = try JSONDecoder().decode(
            AuthPairResult.self,
            from: Data(#"{"ok":true,"pairingCode":"123456","boxId":"\#(box)","expiresAt":1700000300000}"#.utf8))
        XCTAssertEqual(result.expiresAt, Date(timeIntervalSince1970: 1_700_000_300))
        XCTAssertEqual(result.pairingCode, "123456")
    }

    func testAnISOExpiryAndAFailureAlsoDecode() throws {
        let iso = try JSONDecoder().decode(
            AuthPairResult.self,
            from: Data(#"{"ok":true,"pairingCode":"1","boxId":"b","expiresAt":"2026-10-28T12:00:00.000Z"}"#.utf8))
        XCTAssertNotNil(iso.expiresAt)
        let failure = try JSONDecoder().decode(AuthPairResult.self, from: Data(#"{"ok":false,"error":"nope"}"#.utf8))
        XCTAssertFalse(failure.ok)
        XCTAssertEqual(failure.error, "nope")
        XCTAssertNil(failure.expiresAt)
    }

    // MARK: - Linked devices

    private func device(_ id: String, name: String = "d", lastSeen: Double? = nil, createdAt: Double? = nil,
                        primary: Bool = false, current: Bool = false) -> BoxDevice {
        BoxDevice(deviceID: id, name: name, lastSeen: lastSeen, createdAt: createdAt, primary: primary, current: current)
    }

    func testSortPutsThisPhoneFirstThenMostRecentlyActive() {
        let list = [
            device("old", lastSeen: 1_000),
            device("never"),
            device("me", lastSeen: 500, current: true),
            device("new", lastSeen: 9_000),
        ]
        XCTAssertEqual(BoxDevices.sorted(list).map(\.deviceID), ["me", "new", "old", "never"])
    }

    func testSortIsStableForTies() {
        let list = [device("a", lastSeen: 5), device("b", lastSeen: 5), device("c", lastSeen: 5)]
        XCTAssertEqual(BoxDevices.sorted(list).map(\.deviceID), ["a", "b", "c"])
    }

    func testCanRevokeExcludesThisPhoneAndThePrimaryPairing() {
        XCTAssertFalse(BoxDevices.canRevoke(device("me", current: true)))
        XCTAssertFalse(BoxDevices.canRevoke(device("desktop", primary: true)))
        XCTAssertTrue(BoxDevices.canRevoke(device("other")))
    }

    func testLastActiveText() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        func text(_ secondsAgo: Double) -> String? {
            BoxDevices.lastActiveText(lastSeen: (now.timeIntervalSince1970 - secondsAgo) * 1000, now: now)
        }
        XCTAssertEqual(text(0), "just now")
        XCTAssertEqual(text(59), "just now")
        XCTAssertEqual(text(60), "1 min ago")
        XCTAssertEqual(text(3599), "59 min ago")
        XCTAssertEqual(text(3600), "1 h ago")
        XCTAssertEqual(text(86_399), "23 h ago")
        XCTAssertEqual(text(86_400 * 3), "3 d ago")
        XCTAssertNil(BoxDevices.lastActiveText(lastSeen: nil, now: now))
    }

    func testDevicesResponseDecodesWithAndWithoutCurrent() throws {
        let withCurrent = #"""
        {"box_id":"b","devices":[
          {"device_id":"d1","name":"iPhone","last_seen":1700000000000,"created_at":1690000000000,"primary":false,"current":true},
          {"device_id":"d2","name":"desktop","last_seen":1700000001000,"created_at":1680000000000,"primary":true,"current":false}]}
        """#
        let r = try JSONDecoder().decode(BoxDevicesResponse.self, from: Data(withCurrent.utf8))
        XCTAssertEqual(r.boxID, "b")
        XCTAssertEqual(r.devices.map(\.deviceID), ["d1", "d2"])
        XCTAssertTrue(r.devices[0].current)
        XCTAssertTrue(r.devices[1].primary)
        XCTAssertEqual(r.devices[0].lastSeen, 1_700_000_000_000)

        // An older box has no `current` anywhere.
        let old = #"{"box_id":"b","devices":[{"device_id":"d1","name":"iPhone","last_seen":1,"created_at":2,"primary":false}]}"#
        let o = try JSONDecoder().decode(BoxDevicesResponse.self, from: Data(old.utf8))
        XCTAssertFalse(o.devices[0].current)
    }

    func testDevicesResponseSurvivesAMalformedRowAndAMissingName() throws {
        let json = #"{"devices":[{"name":"no id"},{"device_id":"d1"}]}"#
        let r = try JSONDecoder().decode(BoxDevicesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.devices.map(\.deviceID), ["d1"])
        XCTAssertEqual(r.devices[0].name, "device")
    }

    func testRevokeOutcome() {
        XCTAssertEqual(BoxDevices.revokeOutcome(status: 200, transportError: false), .revoked)
        XCTAssertEqual(BoxDevices.revokeOutcome(status: 404, transportError: false), .alreadyRemoved)
        XCTAssertEqual(BoxDevices.revokeOutcome(status: 429, transportError: false), .failed("HTTP 429"))
        XCTAssertEqual(BoxDevices.revokeOutcome(status: 500, transportError: false), .failed("HTTP 500"))
        XCTAssertEqual(BoxDevices.revokeOutcome(status: 401, transportError: false),
                       .failed("Sign in again — this phone's pairing was revoked."))
        XCTAssertEqual(BoxDevices.revokeOutcome(status: nil, transportError: true), .failed("The box didn't answer."))
    }

    // MARK: - Removing this phone: plan + classify + message

    func testPlanRevokesOnlyThisPhonesOwnDevice() {
        let list = [device("desktop", primary: true), device("me", current: true), device("other")]
        XCTAssertEqual(BoxRemoval.plan(devices: list), .revoke(deviceID: "me"))
    }

    func testPlanNeverRevokesTheSharedPairing() {
        let list = [device("desktop", primary: true, current: true), device("other")]
        XCTAssertEqual(BoxRemoval.plan(devices: list), .sharedPairing)
    }

    func testPlanWithNoCurrentRowHasNoTarget() {
        XCTAssertEqual(BoxRemoval.plan(devices: [device("a"), device("b", primary: true)]), .unknownDevice)
        XCTAssertEqual(BoxRemoval.plan(devices: []), .unknownDevice)
    }

    func testClassify() {
        XCTAssertEqual(BoxRemoval.classify(status: 200, transportError: false), .revoked)
        XCTAssertEqual(BoxRemoval.classify(status: 401, transportError: false), .alreadySignedOut)
        XCTAssertEqual(BoxRemoval.classify(status: 404, transportError: false), .alreadySignedOut)
        XCTAssertEqual(BoxRemoval.classify(status: 429, transportError: false), .unreachable("HTTP 429"))
        XCTAssertEqual(BoxRemoval.classify(status: 503, transportError: false), .unreachable("HTTP 503"))
        XCTAssertEqual(BoxRemoval.classify(status: nil, transportError: true), .unreachable("no connection"))
    }

    func testMessageIsNilWhenTheBoxDefinitelySignedThisPhoneOut() {
        XCTAssertNil(BoxRemoval.message(.revoked))
        XCTAssertNil(BoxRemoval.message(.alreadySignedOut))
    }

    func testMessageForTheOtherOutcomes() {
        let couldntConfirm = "Removed from this phone. The box couldn't confirm it signed this phone out, so it may still list it — revoke it from Linked devices on another device."
        XCTAssertEqual(BoxRemoval.message(.unreachable("x")), couldntConfirm)
        XCTAssertEqual(BoxRemoval.message(.unknownDevice), couldntConfirm)
        XCTAssertEqual(BoxRemoval.message(.sharedPairing),
                       "Removed from this phone. This phone shared the desktop's pairing, so the box keeps it — remove it from the desktop if you want it revoked.")
    }

    func testNoMessageEverPromisesNotificationsStop() {
        let all: [RemoteRevokeResult] = [.unreachable("x"), .unknownDevice, .sharedPairing]
        for remote in all {
            let text = (BoxRemoval.message(remote) ?? "").lowercased()
            XCTAssertFalse(text.contains("notification"), "\(remote)")
        }
    }

    // MARK: - Removal flow

    private func run(_ events: [BoxRemovalEvent], from start: BoxRemovalState = .idle) -> BoxRemovalState {
        events.reduce(start) { BoxRemovalFlow.reduce($0, $1) }
    }

    func testTapThenConfirmRevokes() {
        XCTAssertEqual(run([.tapRemove]), .confirming)
        XCTAssertEqual(run([.tapRemove, .confirm]), .revoking)
    }

    func testCancellingTheConfirmReturnsToIdle() {
        XCTAssertEqual(run([.tapRemove, .cancel]), .idle)
    }

    func testRemoteResultMovesToTheLocalDelete() {
        XCTAssertEqual(run([.tapRemove, .confirm, .remoteFinished(.revoked)]), .deletingLocal(.revoked))
        XCTAssertEqual(run([.tapRemove, .confirm, .remoteFinished(.unreachable("x"))]), .deletingLocal(.unreachable("x")))
    }

    func testARevokedRemoteLeavesDirectlyOnceTheLocalDeleteSucceeds() {
        XCTAssertEqual(run([.tapRemove, .confirm, .remoteFinished(.revoked), .localDeleted]), .leaving)
        // A dead token (401) is also "signed out": no warning.
        XCTAssertEqual(run([.tapRemove, .confirm, .remoteFinished(.alreadySignedOut), .localDeleted]), .leaving)
    }

    func testAnUnconfirmedRemoteWarnsBeforeLeaving() {
        let warned = run([.tapRemove, .confirm, .remoteFinished(.unreachable("x")), .localDeleted])
        guard case .warning(let message) = warned else { return XCTFail("expected a warning, got \(warned)") }
        XCTAssertEqual(message, BoxRemoval.message(.unreachable("x")))
        XCTAssertEqual(BoxRemovalFlow.reduce(warned, .acknowledge), .leaving)
    }

    func testTheSharedPairingWarnsToo() {
        let warned = run([.tapRemove, .confirm, .remoteFinished(.sharedPairing), .localDeleted])
        XCTAssertEqual(warned, .warning(BoxRemoval.message(.sharedPairing) ?? ""))
    }

    func testAKeychainFailureKeepsTheAppPairedAndRetriesOnlyTheLocalDelete() {
        let failed = run([.tapRemove, .confirm, .remoteFinished(.revoked), .localDeleteFailed("Keychain error -25244")])
        XCTAssertEqual(failed, .localDeleteFailed(.revoked, "Keychain error -25244"))
        // Retry goes straight back to the local delete — NOT through `.revoking`.
        let retry = BoxRemovalFlow.reduce(failed, .retryLocal)
        XCTAssertEqual(retry, .deletingLocal(.revoked))
        XCTAssertEqual(BoxRemovalFlow.reduce(retry, .localDeleted), .leaving)
        // Cancel leaves the app paired.
        XCTAssertEqual(BoxRemovalFlow.reduce(failed, .cancel), .idle)
    }

    func testTheRemoteResultSurvivesARetryAndStillWarns() {
        let state = run([.tapRemove, .confirm, .remoteFinished(.unknownDevice), .localDeleteFailed("e"), .retryLocal, .localDeleted])
        XCTAssertEqual(state, .warning(BoxRemoval.message(.unknownDevice) ?? ""))
    }

    /// `leaving` — the root transition — is unreachable until the local delete
    /// succeeded and any warning was acknowledged.
    func testLeavingIsUnreachableEarly() {
        XCTAssertEqual(run([.acknowledge]), .idle)
        XCTAssertEqual(run([.localDeleted]), .idle)
        XCTAssertEqual(run([.tapRemove, .localDeleted]), .confirming)
        XCTAssertEqual(run([.tapRemove, .confirm, .localDeleted]), .revoking)
        XCTAssertEqual(run([.tapRemove, .confirm, .acknowledge]), .revoking)
        XCTAssertEqual(run([.tapRemove, .confirm, .remoteFinished(.revoked), .acknowledge]), .deletingLocal(.revoked))
        let warning = run([.tapRemove, .confirm, .remoteFinished(.sharedPairing), .localDeleted])
        XCTAssertEqual(BoxRemovalFlow.reduce(warning, .localDeleted), warning)
        XCTAssertEqual(BoxRemovalFlow.reduce(warning, .cancel), warning, "the warning must be acknowledged, not cancelled")
        XCTAssertEqual(BoxRemovalFlow.reduce(.leaving, .tapRemove), .leaving, "terminal")
    }

    func testNoSecondRemoteRevokeCanBeStartedMidFlow() {
        for mid in [BoxRemovalState.revoking, .deletingLocal(.revoked), .localDeleteFailed(.revoked, "e"), .warning("w")] {
            XCTAssertEqual(BoxRemovalFlow.reduce(mid, .confirm), mid)
            XCTAssertEqual(BoxRemovalFlow.reduce(mid, .tapRemove), mid)
        }
    }
}

// MARK: - Manual "Server address" + "Link this phone?" summary (WS10 F20 / F21)

/// Pure and Foundation-only, so it lives here ([pkg], runs under `./verify.sh`)
/// rather than in `MantaPairingTests.swift`, whose router tests need UIKit-side code.
final class MantaPairingManualTargetTests: XCTestCase {

    private let id = "0123abcd0123abcd0123abcd0123abcd"
    private var idURL: String { "https://\(id).boxes.mantaui.com" }

    private func isInvalid(_ raw: String, file: StaticString = #filePath, line: UInt = #line) {
        if case .invalid = MantaPairing.resolveManualTarget(raw) { return }
        XCTFail("expected \"\(raw)\" to be invalid, got \(MantaPairing.resolveManualTarget(raw))", file: file, line: line)
    }

    // The exact table from the spec (F21 T10).

    func testEmptyIsInvalidWithTheGuidance() {
        let guidance = "Enter your server address — the Server ID or address shown under Add a phone."
        XCTAssertEqual(MantaPairing.resolveManualTarget(""), .invalid(guidance))
        XCTAssertEqual(MantaPairing.resolveManualTarget("   "), .invalid(guidance))
    }

    func testAServerIDResolvesToThePublicHost() {
        XCTAssertEqual(MantaPairing.resolveManualTarget("0123ABCD0123abcd0123abcd0123abcd"), .ok(serverUrl: idURL, boxId: id))
        XCTAssertEqual(MantaPairing.resolveManualTarget("  \(id)  "), .ok(serverUrl: idURL, boxId: id))
    }

    func testThePublicHostnameResolvesToTheSameBox() {
        XCTAssertEqual(MantaPairing.resolveManualTarget("\(id).boxes.mantaui.com"), .ok(serverUrl: idURL, boxId: id))
    }

    func testABareTailnetAddressGetsHTTPS() {
        XCTAssertEqual(MantaPairing.resolveManualTarget("100.64.0.9:8787"), .ok(serverUrl: "https://100.64.0.9:8787", boxId: ""))
    }

    func testExplicitHTTPIsKeptForPrivateHosts() {
        XCTAssertEqual(MantaPairing.resolveManualTarget("http://100.64.0.9:8787/"), .ok(serverUrl: "http://100.64.0.9:8787", boxId: ""))
        XCTAssertEqual(MantaPairing.resolveManualTarget("http://box.tail1234.ts.net:8787"),
                       .ok(serverUrl: "http://box.tail1234.ts.net:8787", boxId: ""))
        XCTAssertEqual(MantaPairing.resolveManualTarget("http://192.168.1.20:8787"), .ok(serverUrl: "http://192.168.1.20:8787", boxId: ""))
    }

    func testHostIsLowercasedAndTheSubPathKeptWithoutItsTrailingSlash() {
        XCTAssertEqual(MantaPairing.resolveManualTarget("https://Box.Example.com/manta/"),
                       .ok(serverUrl: "https://box.example.com/manta", boxId: ""))
    }

    func testPublicHTTPIsRefused() {
        XCTAssertEqual(MantaPairing.resolveManualTarget("http://example.com"),
                       .invalid("Use https:// for an address reachable from the internet."))
    }

    func testOtherSchemesAreRefused() {
        XCTAssertEqual(MantaPairing.resolveManualTarget("ftp://example.com"), .invalid("Use an https:// address."))
    }

    func testCredentialsQueryAndFragmentAreRefused() {
        isInvalid("https://user:pw@example.com")
        isInvalid("https://example.com?x=1")
        isInvalid("https://example.com#f")
    }

    func testBadHostsAreRefused() {
        isInvalid("https://")
        isInvalid("https://.example.com")
        isInvalid("https://a..b")
        isInvalid("https://exa_mple.com")
        isInvalid("https://example.com.")
    }

    func testPortsOutOfRangeAreRefused() {
        isInvalid("https://example.com:0")
        isInvalid("https://example.com:70000")
    }

    func testInteriorWhitespaceIsRefused() {
        XCTAssertEqual(MantaPairing.resolveManualTarget("my box"), .invalid("A server address can't contain spaces."))
    }

    func testTheBoxIDIsRecoveredFromAPublicHostURLOnly() {
        XCTAssertEqual(MantaPairing.resolveManualTarget(idURL), .ok(serverUrl: idURL, boxId: id))
        XCTAssertEqual(MantaPairing.resolveManualTarget("https://other.example.com"), .ok(serverUrl: "https://other.example.com", boxId: ""))
    }

    // MARK: - confirmSummary

    func testConfirmSummaryShowsTheHostAndTheFirstEightOfTheServerID() {
        let derived = MantaPairing.confirmSummary(MantaPairing.PairPayload(boxId: id, code: "123456", serverUrl: nil))
        XCTAssertEqual(derived.host, "\(id).boxes.mantaui.com")
        XCTAssertEqual(derived.idPrefix, "0123abcd")
    }

    func testConfirmSummaryForAPrivateServerShowsHostAndPort() {
        let s = MantaPairing.confirmSummary(MantaPairing.PairPayload(boxId: id, code: "123456", serverUrl: "http://100.64.0.9:8787"))
        XCTAssertEqual(s.host, "100.64.0.9:8787")
        XCTAssertEqual(s.idPrefix, "0123abcd")
    }

    func testConfirmSummaryOmitsThePrefixWhenThereIsNoBoxID() {
        let s = MantaPairing.confirmSummary(MantaPairing.PairPayload(boxId: "", code: "123456", serverUrl: "https://example.com"))
        XCTAssertEqual(s.host, "example.com")
        XCTAssertNil(s.idPrefix)
    }
}
