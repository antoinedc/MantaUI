import Foundation

// ===========================================================================
// WS10 F15 / F17 — linked devices and "Remove server". Pure logic, Foundation
// only ([pkg], D19):
//
//   - `BoxDevice` / `BoxDevicesResponse`  the `GET /auth/devices` payload
//     (tolerant: an older box has no `current`);
//   - `BoxDevices`        sorting, who may be revoked, "last active" wording;
//   - `BoxRemoval`        which request signs THIS phone out, what its answer
//     means, and the warning the user must see;
//   - `BoxRemovalFlow`    the Remove-server state machine. The root transition
//     happens only AFTER the Keychain delete succeeded and any warning was
//     acknowledged, so a relaunch never resurrects a "removed" pairing and the
//     warning is never lost.
//
// A phone must NEVER call `DELETE /auth/revoke` without a `device_id`: with no
// target the box treats it as a whole-box reset and drops EVERY device.
// ===========================================================================

extension Notification.Name {
    /// Posted by the Remove-server flow once this phone's credentials are gone.
    /// `MantaAppRoot` returns to onboarding (mount M-10-2).
    static let mantaBoxRemoved = Notification.Name("manta.boxRemoved")
}

// MARK: - Wire

struct BoxDevice: Decodable, Equatable, Sendable, Identifiable {
    var deviceID: String
    var name: String
    /// Epoch milliseconds.
    var lastSeen: Double?
    /// Epoch milliseconds.
    var createdAt: Double?
    /// The box's own shared pairing (the desktop's) — never revocable from here.
    var primary: Bool
    /// The device making this request. False everywhere on an older box.
    var current: Bool

    var id: String { deviceID }

    init(deviceID: String, name: String = "device", lastSeen: Double? = nil, createdAt: Double? = nil,
         primary: Bool = false, current: Bool = false) {
        self.deviceID = deviceID
        self.name = name
        self.lastSeen = lastSeen
        self.createdAt = createdAt
        self.primary = primary
        self.current = current
    }

    private enum CodingKeys: String, CodingKey {
        case deviceID = "device_id", name, lastSeen = "last_seen", createdAt = "created_at", primary, current
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deviceID = try c.decode(String.self, forKey: .deviceID)
        let rawName = ((try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil) ?? ""
        name = rawName.isEmpty ? "device" : rawName
        lastSeen = (try? c.decodeIfPresent(Double.self, forKey: .lastSeen)) ?? nil
        createdAt = (try? c.decodeIfPresent(Double.self, forKey: .createdAt)) ?? nil
        primary = ((try? c.decodeIfPresent(Bool.self, forKey: .primary)) ?? nil) ?? false
        current = ((try? c.decodeIfPresent(Bool.self, forKey: .current)) ?? nil) ?? false
    }
}

struct BoxDevicesResponse: Decodable, Equatable, Sendable {
    var boxID: String?
    var devices: [BoxDevice]

    init(boxID: String? = nil, devices: [BoxDevice]) {
        self.boxID = boxID
        self.devices = devices
    }

    private enum CodingKeys: String, CodingKey { case boxID = "box_id", devices }

    private struct LossyDevice: Decodable {
        let device: BoxDevice?
        init(from decoder: Decoder) throws { device = try? BoxDevice(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        boxID = (try? c.decodeIfPresent(String.self, forKey: .boxID)) ?? nil
        devices = (try c.decode([LossyDevice].self, forKey: .devices)).compactMap(\.device)
    }
}

// MARK: - Linked-devices list

enum BoxDevices {

    /// This phone first, then the most recently active.
    static func sorted(_ devices: [BoxDevice]) -> [BoxDevice] {
        devices.enumerated().sorted { a, b in
            if a.element.current != b.element.current { return a.element.current }
            let l = a.element.lastSeen ?? -1
            let r = b.element.lastSeen ?? -1
            if l != r { return l > r }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// The current phone signs out through "Remove server"; the primary row is the
    /// desktop's shared pairing, managed from the desktop. Everything else may be
    /// revoked. (An older box has no `current`: revoke stays offered on every
    /// non-primary row and the user tells by name.)
    static func canRevoke(_ device: BoxDevice) -> Bool {
        !device.current && !device.primary && isRevocableID(device.deviceID)
    }

    /// An id the box can be asked to revoke. An empty or blank id must never
    /// reach `DELETE /auth/revoke`: with no `device_id` the box resets the WHOLE
    /// identity and signs every device out.
    static func isRevocableID(_ id: String) -> Bool {
        !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    enum RevokeOutcome: Equatable, Sendable {
        case revoked
        /// 404 — someone else already removed it.
        case alreadyRemoved
        /// Anything else, with the reason to show after "Couldn't revoke <name>."
        case failed(String)
    }

    /// What the answer to revoking ANOTHER device means (the list screen; the
    /// Remove-server flow classifies its own call with `BoxRemoval.classify`).
    static func revokeOutcome(status: Int?, transportError: Bool) -> RevokeOutcome {
        if transportError { return .failed("The box didn't answer.") }
        guard let status else { return .failed("The box didn't answer.") }
        switch status {
        case 200: return .revoked
        case 404: return .alreadyRemoved
        case 401: return .failed("Sign in again — this phone's pairing was revoked.")
        default: return .failed("HTTP \(status)")
        }
    }

    /// "just now" under a minute, then "N min ago" / "N h ago" / "N d ago".
    /// nil when the box never reported a time.
    static func lastActiveText(lastSeen: Double?, now: Date) -> String? {
        guard let lastSeen else { return nil }
        let seconds = Int(now.timeIntervalSince1970 - lastSeen / 1000)
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60) min ago" }
        if seconds < 86_400 { return "\(seconds / 3600) h ago" }
        return "\(seconds / 86_400) d ago"
    }
}

// MARK: - Removing this phone

enum RemovalPlan: Equatable, Sendable {
    /// Revoke exactly this device id.
    case revoke(deviceID: String)
    /// This phone holds the box's shared (primary) pairing: revoking it would sign
    /// the desktop out too, so the phone only forgets the box locally.
    case sharedPairing
    /// No row is marked `current` (an older box): there is no safe target.
    case unknownDevice
}

enum RemoteRevokeResult: Equatable, Sendable {
    case revoked
    /// The token was already dead (401, or 404 "device not found").
    case alreadySignedOut
    case sharedPairing
    case unknownDevice
    /// Transport failure, 429 or 5xx — the box could not confirm.
    case unreachable(String)
}

enum BoxRemoval {

    static func plan(devices: [BoxDevice]) -> RemovalPlan {
        guard let me = devices.first(where: \.current) else { return .unknownDevice }
        if me.primary { return .sharedPairing }
        // A blank own id has no safe target (see `isRevocableID`).
        return BoxDevices.isRevocableID(me.deviceID) ? .revoke(deviceID: me.deviceID) : .unknownDevice
    }

    /// What the `DELETE /auth/revoke?device_id=` answer means.
    static func classify(status: Int?, transportError: Bool) -> RemoteRevokeResult {
        if transportError { return .unreachable("no connection") }
        guard let status else { return .unreachable("no answer") }
        switch status {
        case 200: return .revoked
        case 401, 404: return .alreadySignedOut
        default: return .unreachable("HTTP \(status)")
        }
    }

    /// The warning to show after a successful local delete; nil when the box
    /// definitely signed this phone out. Says only what is true: it never
    /// promises notifications stop (the box keeps every stored push token).
    static func message(_ remote: RemoteRevokeResult) -> String? {
        switch remote {
        case .revoked, .alreadySignedOut:
            return nil
        case .unreachable, .unknownDevice:
            return "Removed from this phone. The box couldn't confirm it signed this phone out, so it may still list it — revoke it from Linked devices on another device."
        case .sharedPairing:
            return "Removed from this phone. This phone shared the desktop's pairing, so the box keeps it — remove it from the desktop if you want it revoked."
        }
    }
}

enum BoxRemovalState: Equatable, Sendable {
    case idle
    case confirming
    case revoking
    /// Remote step finished (whatever its result); the Keychain delete is next.
    case deletingLocal(RemoteRevokeResult)
    /// The Keychain delete threw. The app stays paired; "Try again" repeats ONLY
    /// the local delete.
    case localDeleteFailed(RemoteRevokeResult, String)
    /// The local delete succeeded but the remote step did not revoke: the user
    /// must acknowledge before the app leaves.
    case warning(String)
    /// Terminal: post `.mantaBoxRemoved`.
    case leaving
}

enum BoxRemovalEvent: Equatable, Sendable {
    /// "Remove server" tapped.
    case tapRemove
    /// "Remove" confirmed in the dialog.
    case confirm
    case cancel
    case remoteFinished(RemoteRevokeResult)
    case localDeleted
    case localDeleteFailed(String)
    case retryLocal
    case acknowledge
}

enum BoxRemovalFlow {

    static func reduce(_ state: BoxRemovalState, _ event: BoxRemovalEvent) -> BoxRemovalState {
        switch (state, event) {
        case (.idle, .tapRemove):
            return .confirming
        case (.confirming, .confirm):
            return .revoking
        case (.confirming, .cancel):
            return .idle

        case (.revoking, .remoteFinished(let remote)):
            return .deletingLocal(remote)

        case (.deletingLocal(let remote), .localDeleted):
            if let warning = BoxRemoval.message(remote) { return .warning(warning) }
            return .leaving
        case (.deletingLocal(let remote), .localDeleteFailed(let error)):
            return .localDeleteFailed(remote, error)

        // Repeats ONLY the local delete — the remote result is carried, never re-run.
        case (.localDeleteFailed(let remote, _), .retryLocal):
            return .deletingLocal(remote)
        case (.localDeleteFailed, .cancel):
            return .idle

        case (.warning, .acknowledge):
            return .leaving

        default:
            return state
        }
    }
}
