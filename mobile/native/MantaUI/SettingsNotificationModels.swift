import Foundation

// ===========================================================================
// WS10 F22 — the quiet "Notifications are off" reminder in Settings
// (DECISIONS §5.6: denying notifications must never gate anything; the only
// difference is a dismissible reminder). Pure rules, Foundation-only ([pkg]);
// the status is a local enum so tests need no UserNotifications.
// ===========================================================================

enum ReminderAuthStatus: Equatable, Sendable {
    case notDetermined, denied, authorized, provisional, ephemeral
}

enum NotificationReminder {
    enum Action: Equatable, Sendable {
        /// Notifications were refused: only iOS Settings can change that.
        case openSettings
        /// The question was never asked: ask it now.
        case request
    }

    /// Shown while notifications are off (denied) or were never answered, and the
    /// user has not dismissed it.
    static func shouldShow(status: ReminderAuthStatus, dismissed: Bool) -> Bool {
        switch status {
        case .denied, .notDetermined: return !dismissed
        case .authorized, .provisional, .ephemeral: return false
        }
    }

    /// What the card's button does; nil when there is no card.
    static func action(status: ReminderAuthStatus) -> Action? {
        switch status {
        case .denied: return .openSettings
        case .notDetermined: return .request
        case .authorized, .provisional, .ephemeral: return nil
        }
    }

    /// The dismissal flag to store after re-reading the status: an authorized
    /// status clears it, so a FUTURE denial shows the reminder again.
    static func dismissalAfter(status: ReminderAuthStatus, dismissed: Bool) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: return false
        case .denied, .notDetermined: return dismissed
        }
    }
}
