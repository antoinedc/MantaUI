import SwiftUI

// ===========================================================================
// WS10 F13 — the Box section's status card. Replaces the dead "Server URL" text
// field (it wrote a key nothing ever read — the retired web client's override).
// Read-only: connection dot, the address this phone talks to, the server version
// and the opencode version. A failed version read simply omits those two lines.
// ===========================================================================

struct BoxStatusCard: View {
    let eventStore: MantaEventStore?

    var body: some View {
        if let eventStore {
            Live(eventStore: eventStore)
        } else {
            BoxStatusBody(connected: false)
        }
    }

    private struct Live: View {
        @ObservedObject var eventStore: MantaEventStore

        var body: some View {
            BoxStatusBody(connected: eventStore.connectionState.name == "connected")
        }
    }
}

private struct BoxStatusBody: View {
    @Environment(\.colorScheme) private var colorScheme
    let connected: Bool

    @State private var info: ServerVersionInfo?

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            HStack(spacing: Metrics.spacing.sp2) {
                Circle()
                    .fill(connected ? tokens.ok : tokens.tx4)
                    .frame(width: Metrics.spacing.sp2, height: Metrics.spacing.sp2)
                Text(connected ? "Connected" : "Reconnecting…")
                    .font(.manta(size: Metrics.type.body, weight: .medium))
                    .foregroundColor(tokens.tx1)
                    .accessibilityIdentifier("settings-box-connection")
            }
            row("Server URL", KeychainCredentialStore.shared.serverURL?.absoluteString ?? "", mono: true)
            if let version = info?.version {
                row("Server", "v\(version)", mono: false)
            }
            if let opencode = info?.opencodeVersion, !opencode.isEmpty {
                row("opencode", opencode, mono: false)
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { info = try? await MantaAPIClient.live().serverVersion() }
    }

    private func row(_ label: String, _ value: String, mono: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Metrics.spacing.sp3) {
            Text(label)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx4)
            Spacer(minLength: Metrics.spacing.sp3)
            Text(value)
                .font(.manta(size: Metrics.type.small, design: mono ? .monospaced : .default))
                .foregroundColor(tokens.tx1)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }
}
