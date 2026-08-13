import UIKit
import UserNotifications

// ===========================================================================
// S8 — APNs push (BET-600).
//
// The app delegate + the push service own remote-notification registration and
// routing. It is deliberately a thin extension over what the box already
// exposes (`POST /push/register-apns { token }`, src/server/index.mjs + the
// /rpc/push:register-apns channel):
//
//   • Registration is opt-in at the S2 onboarding priming screen (§5.6) and is
//     never a gate — denial still lands in the session list. `applyRegistrationState`
//     re-registers on launch so a rotated device token is re-handed to the box.
//   • The device token is handed to the box over the existing endpoint; there
//     is no client-side suppression (the box's router owns that, deliberately —
//     iOS revokes a subscription whose delivered push shows nothing).
//   • Foreground presentation is banner+list+sound (the box's router decides
//     *whether* a push fires; we only present it).
//   • A tap routes to the session that fired it via MantaPushRouter, so the
//     user lands on the session, not the list.
// ===========================================================================

@MainActor
final class MantaAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Self.registerNotificationCategories()
        MantaPushService.applyRegistrationState()
        return true
    }

    private static func registerNotificationCategories() {
        let permission = UNNotificationCategory(
            identifier: "MANTA_PERMISSION",
            actions: [
                // No .foreground option: the reply runs in the background without
                // opening the app — that is the entire point of the feature.
                UNNotificationAction(identifier: "allow-once", title: "Allow once"),
                UNNotificationAction(identifier: "allow-always", title: "Always allow"),
                UNNotificationAction(identifier: "deny", title: "Deny", options: [.destructive]),
            ],
            intentIdentifiers: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([permission])
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        MantaPushService.deviceTokenDidArrive(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        MantaPushService.registrationFailed(error)
    }

    // Universal link (apple-app-site-association / Associated Domains). Feeds
    // the pairing payload to the onboarding flow. Handles the cold-start case
    // (launched by the OS from a link) — warm launches also arrive here AND via
    // SwiftUI's onOpenURL; both stage into MantaPairingRouter, which is
    // idempotent for identical payloads.
    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL else {
            return false
        }
        return MantaPairingRouter.route(url)
    }

    // MARK: - UNUserNotificationCenterDelegate

    // Foreground presentation: the box's router decides whether to push; we
    // just decide how to show the ones that arrive.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let sessionID = notification.request.content.userInfo["sessionId"] as? String
        // UNUserNotificationCenter invokes its delegate on the main thread, so
        // the (MainActor-isolated) visible-session bookkeeping is readable here
        // directly — keeping completionHandler in the synchronous nonisolated
        // frame avoids escaping a `sending` parameter into a Task.
        let visible = MainActor.assumeIsolated { MantaPushRouter.shared.visibleSessionID }
        if let sessionID, !sessionID.isEmpty, sessionID == visible {
            completionHandler([.list])
        } else {
            completionHandler([.banner, .list, .sound])
        }
    }

    // Tap → deep-link to the session that fired the notification. The APNs
    // envelope carries the opencode sessionId at the top level of the payload
    // (server push.mjs → gateway apns.mjs `buildApnsPayload`).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let sessionID = userInfo["sessionId"] as? String
        let requestID = userInfo["requestId"] as? String
        let reply: PermissionReply?
        switch response.actionIdentifier {
        case "allow-once": reply = .once
        case "allow-always": reply = .always
        case "deny": reply = .reject
        default: reply = nil
        }
        if let reply, let requestID, !requestID.isEmpty {
            // Background reply — the app is NOT foregrounded. completionHandler
            // must run after the network call so iOS keeps us alive for it. The
            // handler is `sending`/non-Sendable, so a @Sendable Task can't
            // capture it directly — box it (UNUserNotificationCenter handlers
            // are safe to call from any thread, which is what the box does).
            let done = NotificationCompletionHandler(completionHandler)
            Task {
                try? await MantaAPIClient.live().permissionReply(
                    requestId: requestID, reply: reply, sessionId: sessionID)
                done.run()
            }
            return
        }
        if let sessionID, !sessionID.isEmpty {
            Task { @MainActor in
                MantaPushRouter.shared.open(sessionID: sessionID)
            }
        }
        completionHandler()
    }
}

// MARK: - Registration service

/// The registration half of APNs on the native client. Pure call-through to
/// the paired box's `/push/register-apns`; never blocks the UI.
@MainActor
enum MantaPushService {

    /// Re-assert APNs registration if the user has already authorized. Called
    /// on launch (token / auth rotation) and can be re-invoked after pairing.
    static func applyRegistrationState() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            Task { @MainActor in
                switch status {
                case .authorized, .provisional, .ephemeral:
                    UIApplication.shared.registerForRemoteNotifications()
                default:
                    break
                }
            }
        }
    }

    /// Explicitly request APNs registration — the S8 side of the S2 priming
    /// screen's "Continue" (§5.6): credentials now exist, so we can hand the
    /// token to the box.
    static func registerAfterPairing() {
        Task { @MainActor in
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    static func deviceTokenDidArrive(_ token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        guard !hex.isEmpty else { return }
        register(hex)
    }

    static func registrationFailed(_ error: Error) {
        // Non-fatal: remote notifications are an enhancement, never a gate. A
        // box that never gets a token simply receives no push until the next
        // successful registration (e.g. a foreground launch).
        NSLog("[push] APNs registration failed: %@", String(describing: error))
    }

    private static func register(_ token: String) {
        let client = MantaAPIClient.live()
        guard KeychainCredentialStore.shared.serverURL != nil,
              KeychainCredentialStore.shared.boxToken != nil else {
            return
        }
        Task {
            // 3 attempts, 5s then 30s apart — a box that is down longer gets the
            // token on the next foreground (applyRegistrationState re-runs there).
            for delay in [0.0, 5.0, 30.0] {
                if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
                if (try? await client.registerApnsToken(token)) != nil { return }
            }
            NSLog("[push] APNs token registration failed after 3 attempts")
        }
    }
}

/// UNUserNotificationCenter's completion handlers are safe to call from any
/// thread, but they're typed as `sending` (non-Sendable), so a @Sendable Task
/// can't capture one directly. Box it so the background permission reply can
/// invoke the handler after its network call. The annotation is needed only
/// because the handler's type is non-Sendable by protocol fiat, not by meaning.
private final class NotificationCompletionHandler: @unchecked Sendable {
    let run: () -> Void
    init(_ run: @escaping () -> Void) { self.run = run }
}
