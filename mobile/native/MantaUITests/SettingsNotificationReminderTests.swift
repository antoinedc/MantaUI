import XCTest
@testable import MantaUI

// WS10 F22 — the "Notifications are off" reminder rules. Pure, Foundation-only.

final class SettingsNotificationReminderTests: XCTestCase {

    func testShownWhenDeniedOrUnansweredAndNotDismissed() {
        XCTAssertTrue(NotificationReminder.shouldShow(status: .denied, dismissed: false))
        XCTAssertTrue(NotificationReminder.shouldShow(status: .notDetermined, dismissed: false))
    }

    func testHiddenOnceDismissed() {
        XCTAssertFalse(NotificationReminder.shouldShow(status: .denied, dismissed: true))
        XCTAssertFalse(NotificationReminder.shouldShow(status: .notDetermined, dismissed: true))
    }

    func testNeverShownWhenAuthorizedInAnyForm() {
        for status in [ReminderAuthStatus.authorized, .provisional, .ephemeral] {
            XCTAssertFalse(NotificationReminder.shouldShow(status: status, dismissed: false), "\(status)")
            XCTAssertFalse(NotificationReminder.shouldShow(status: status, dismissed: true), "\(status)")
        }
    }

    func testActionDependsOnWhetherTheQuestionWasEverAsked() {
        XCTAssertEqual(NotificationReminder.action(status: .denied), .openSettings)
        XCTAssertEqual(NotificationReminder.action(status: .notDetermined), .request)
        XCTAssertNil(NotificationReminder.action(status: .authorized))
        XCTAssertNil(NotificationReminder.action(status: .provisional))
        XCTAssertNil(NotificationReminder.action(status: .ephemeral))
    }

    func testDismissalClearsWhenAuthorizedSoAFutureDenialShowsAgain() {
        XCTAssertFalse(NotificationReminder.dismissalAfter(status: .authorized, dismissed: true))
        XCTAssertFalse(NotificationReminder.dismissalAfter(status: .provisional, dismissed: true))
        XCTAssertFalse(NotificationReminder.dismissalAfter(status: .ephemeral, dismissed: true))
        // Still off → the choice stands.
        XCTAssertTrue(NotificationReminder.dismissalAfter(status: .denied, dismissed: true))
        XCTAssertFalse(NotificationReminder.dismissalAfter(status: .denied, dismissed: false))
        XCTAssertTrue(NotificationReminder.dismissalAfter(status: .notDetermined, dismissed: true))
    }

    func testDenyDismissAuthorizeDenyShowsAgain() {
        var dismissed = false
        // Denied → shown → user dismisses.
        XCTAssertTrue(NotificationReminder.shouldShow(status: .denied, dismissed: dismissed))
        dismissed = true
        XCTAssertFalse(NotificationReminder.shouldShow(status: .denied, dismissed: dismissed))
        // Later authorized → flag cleared.
        dismissed = NotificationReminder.dismissalAfter(status: .authorized, dismissed: dismissed)
        XCTAssertFalse(dismissed)
        // Denied again → the reminder is back.
        XCTAssertTrue(NotificationReminder.shouldShow(status: .denied, dismissed: dismissed))
    }
}
