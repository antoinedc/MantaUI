import SwiftUI
import UIKit
import UserNotifications

// ===========================================================================
// WS10 F22 — the quiet "Notifications are off" reminder at the top of Settings
// (DECISIONS §5.6: denying notifications never gates anything; the only
// difference is this dismissible card). Shown while the status is denied or was
// never answered and the user has not dismissed it. The dismissal clears itself
// when notifications become authorized, so a FUTURE denial shows it again.
// Re-read when the screen appears and whenever the app returns to the
// foreground (the user may have just flipped it in iOS Settings).
// ===========================================================================

struct SettingsNotificationReminder: View {
    static let dismissedKey = "manta.settings.notifReminderDismissed"

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var status: ReminderAuthStatus = .authorized
    @State private var dismissed = UserDefaults.standard.bool(forKey: SettingsNotificationReminder.dismissedKey)
    @State private var problem: String?

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        Group {
            if NotificationReminder.shouldShow(status: status, dismissed: dismissed) {
                card
            }
        }
        .task { await refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refresh() } }
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    Text("Notifications are off")
                        .font(.manta(size: Metrics.type.body, weight: .semibold))
                        .foregroundColor(tokens.tx1)
                    Text("You won't hear when an agent needs permission, asks a question, or finishes.")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx4)
                        .padding(Metrics.spacing.sp2)
                }
                .accessibilityLabel("Dismiss")
                .accessibilityIdentifier("notif-reminder-dismiss")
            }
            if let action = NotificationReminder.action(status: status) {
                Button {
                    Task { await perform(action) }
                } label: {
                    Text(action == .openSettings ? "Turn on in Settings" : "Turn on notifications")
                        .font(.manta(size: Metrics.type.small, weight: .semibold))
                        .foregroundColor(tokens.accentTx)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("notif-reminder-action")
            }
            if let problem {
                Text(problem)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Metrics.spacing.sp3)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.border, lineWidth: 1)
        )
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("notif-reminder")
    }

    private func dismiss() {
        dismissed = true
        UserDefaults.standard.set(true, forKey: Self.dismissedKey)
    }

    private func refresh() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let current = Self.map(settings.authorizationStatus)
        status = current
        let stored = NotificationReminder.dismissalAfter(status: current, dismissed: dismissed)
        if stored != dismissed {
            dismissed = stored
            UserDefaults.standard.set(stored, forKey: Self.dismissedKey)
        }
    }

    private func perform(_ action: NotificationReminder.Action) async {
        problem = nil
        switch action {
        case .openSettings:
            guard let url = URL(string: UIApplication.openNotificationSettingsURLString),
                  await UIApplication.shared.open(url) else {
                problem = "Couldn't open Settings. Open the Settings app, then Manta → Notifications."
                return
            }
        case .request:
            do {
                _ = try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound, .badge])
                MantaPushService.applyRegistrationState()
            } catch {
                problem = "Couldn't ask for notification permission. \(error.localizedDescription)"
            }
            await refresh()
        }
    }

    private static func map(_ status: UNAuthorizationStatus) -> ReminderAuthStatus {
        switch status {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .authorized: return .authorized
        case .provisional: return .provisional
        case .ephemeral: return .ephemeral
        @unknown default: return .authorized
        }
    }
}
