import SwiftUI

// ===========================================================================
// WS10 F17 — Linked devices. The phones and computers that can reach this box,
// this phone first, with last-active and a one-tap Revoke on every row that is
// neither this phone ("To sign this phone out, use Remove server") nor the box's
// shared main pairing (the desktop's — managed from the desktop). Revoking
// removes the device's access at once; it does NOT stop notifications the box
// already sends — the confirm says so rather than promising otherwise.
// ===========================================================================

@MainActor
final class BoxDevicesStore: ObservableObject {

    enum Load: Equatable {
        case loading
        case loaded([BoxDevice])
        case failed(String)
    }

    struct Dependencies: Sendable {
        var devices: @Sendable () async throws -> BoxDevicesResponse
        var revoke: @Sendable (String) async -> (status: Int?, transportError: Bool)

        static func live() -> Dependencies {
            let rest = BoxRESTClient.live()
            return Dependencies(
                devices: { try await rest.devices() },
                revoke: { await rest.revokeDevice(id: $0) }
            )
        }
    }

    @Published private(set) var load: Load = .loading
    /// The result of the last revoke, shown under the list.
    @Published private(set) var notice: (text: String, isError: Bool)?
    /// Device ids with a revoke in flight.
    @Published private(set) var revoking: Set<String> = []

    private let deps: Dependencies

    init(dependencies: Dependencies = .live()) {
        self.deps = dependencies
    }

    func refresh() async {
        do {
            let response = try await deps.devices()
            load = .loaded(BoxDevices.sorted(response.devices))
        } catch {
            load = .failed("Couldn't load linked devices. \(SettingsError.message(error))")
        }
    }

    func revoke(_ device: BoxDevice) async {
        guard BoxDevices.canRevoke(device), !revoking.contains(device.deviceID) else { return }
        revoking.insert(device.deviceID)
        notice = nil
        let answer = await deps.revoke(device.deviceID)
        switch BoxDevices.revokeOutcome(status: answer.status, transportError: answer.transportError) {
        case .revoked:
            if case .loaded(let devices) = load {
                load = .loaded(devices.filter { $0.deviceID != device.deviceID })
            }
            notice = ("Revoked \(device.name).", false)
        case .alreadyRemoved:
            await refresh()
            notice = ("That device was already removed.", false)
        case .failed(let reason):
            notice = ("Couldn't revoke \(device.name). \(reason)", true)
        }
        revoking.remove(device.deviceID)
    }
}

struct BoxDevicesScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var store = BoxDevicesStore()
    @State private var pendingRevoke: BoxDevice?

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        SettingsSubScreen(title: "Linked devices") {
            switch store.load {
            case .loading:
                MantaLoader(caption: "Loading devices…", tokens: tokens, size: .inline)
            case .failed(let message):
                SettingsLoadFailure(message: message) { Task { await store.refresh() } }
            case .loaded(let devices):
                list(devices)
            }
            if let notice = store.notice {
                SettingsStatusLine(text: notice.text, isError: notice.isError, identifier: "box-devices-notice")
            }
        }
        .task { await store.refresh() }
        .refreshable { await store.refresh() }
        .confirmationDialog(
            pendingRevoke.map { "Revoke \($0.name)?" } ?? "Revoke device?",
            isPresented: Binding(get: { pendingRevoke != nil }, set: { if !$0 { pendingRevoke = nil } }),
            titleVisibility: .visible,
            presenting: pendingRevoke
        ) { device in
            Button("Revoke", role: .destructive) {
                Task { await store.revoke(device) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("It's signed out right away and needs a new pairing code to come back. It may still receive notifications from this box until notifications are turned off on that device.")
        }
    }

    @ViewBuilder
    private func list(_ devices: [BoxDevice]) -> some View {
        if devices.isEmpty {
            Text("No linked devices.")
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx3)
        }
        ForEach(devices) { device in
            row(device)
        }
    }

    private func row(_ device: BoxDevice) -> some View {
        SettingsPanel {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                HStack(spacing: Metrics.spacing.sp2) {
                    Text(device.name)
                        .font(.manta(size: Metrics.type.body, weight: .medium))
                        .foregroundColor(tokens.tx1)
                    if device.current { badge("This phone") }
                    if device.primary { badge("Main pairing") }
                    Spacer()
                    if store.revoking.contains(device.deviceID) { ProgressView().tint(tokens.accent) }
                }
                Text(detail(device))
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
                if device.current {
                    hint("To sign this phone out, use Remove server.")
                } else if device.primary {
                    hint("The main pairing is shared with your desktop — manage it from the desktop.")
                } else {
                    Button(role: .destructive) {
                        pendingRevoke = device
                    } label: {
                        Text("Revoke")
                            .font(.manta(size: Metrics.type.small, weight: .semibold))
                            .foregroundColor(tokens.danger)
                    }
                    .buttonStyle(.plain)
                    .disabled(store.revoking.contains(device.deviceID))
                    .accessibilityIdentifier("box-device-revoke-\(device.deviceID)")
                }
            }
        }
        .contextMenu {
            if BoxDevices.canRevoke(device) {
                Button("Revoke", role: .destructive) { pendingRevoke = device }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("box-device-\(device.deviceID)")
    }

    private func detail(_ device: BoxDevice) -> String {
        var parts: [String] = []
        if let active = BoxDevices.lastActiveText(lastSeen: device.lastSeen, now: Date()) {
            parts.append("Last active \(active)")
        }
        if let created = device.createdAt {
            let date = Date(timeIntervalSince1970: created / 1000)
            parts.append("Linked \(date.formatted(date: .abbreviated, time: .omitted))")
        }
        return parts.joined(separator: " · ")
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
            .foregroundColor(tokens.accentTx)
            .padding(.horizontal, Metrics.spacing.sp2)
            .padding(.vertical, Metrics.spacing.spPx)
            .background(tokens.accentSoft, in: Capsule())
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.manta(size: Metrics.type.small))
            .foregroundColor(tokens.tx4)
            .fixedSize(horizontal: false, vertical: true)
    }
}
