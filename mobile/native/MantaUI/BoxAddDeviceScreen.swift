import SwiftUI
import UIKit

// ===========================================================================
// WS10 F14 — "Add a device": a QR + a six-digit code another phone or a computer
// can pair with. The code is minted by the box (`auth:pair`, in-process, so it
// works over this phone's authenticated /rpc), expires, and is replaced on its
// own while the screen is open. Everything needed to type it by hand is shown
// too — the code, the SERVER ADDRESS this phone reaches the box at (on a
// Tailscale box the Server ID's public host does not exist, so the address is
// what makes a second phone pair), and the Server ID.
// ===========================================================================

@MainActor
final class BoxAddDeviceStore: ObservableObject {

    struct Code: Equatable {
        var pairingCode: String
        var boxId: String
        var expiresAt: Date
        /// What the QR encodes.
        var link: String
        /// What a second device types into "Server address".
        var manualAddress: String?
    }

    enum State: Equatable {
        case minting
        case ready(Code)
        case failed(String)
    }

    struct Dependencies: Sendable {
        var mint: @Sendable () async throws -> AuthPairResult
        var connectedServerURL: @Sendable () -> String?

        static func live() -> Dependencies {
            let api = MantaAPIClient.live()
            return Dependencies(
                mint: { try await api.authPair() },
                connectedServerURL: { KeychainCredentialStore.shared.serverURL?.absoluteString }
            )
        }
    }

    @Published private(set) var state: State = .minting
    /// True while ANY mint is in flight (the first, a manual refresh, a rotation).
    @Published private(set) var minting = false

    private let deps: Dependencies
    private let now: @Sendable () -> Date
    private var rotation: Task<Void, Never>?
    /// Set when the screen goes away, so an in-flight mint cannot re-arm rotation.
    private var stopped = false

    init(dependencies: Dependencies = .live(), now: @escaping @Sendable () -> Date = { Date() }) {
        self.deps = dependencies
        self.now = now
    }

    /// The screen appeared: mint a code and keep it fresh.
    func start() async {
        stopped = false
        await mint()
    }

    /// Mint a code. One mint in flight at a time.
    func mint() async {
        guard !minting else { return }
        minting = true
        defer { minting = false }
        do {
            let result = try await deps.mint()
            guard result.ok else {
                state = .failed(Self.failure(result.error ?? "unknown error"))
                return
            }
            guard let code = result.pairingCode, let boxId = result.boxId, let expiresAt = result.expiresAt else {
                state = .failed(Self.failure("The box sent a pairing code this app couldn't read."))
                return
            }
            let connected = deps.connectedServerURL()
            let override = BoxPairing.qrServerOverride(boxId: boxId, configured: connected)
            state = .ready(Code(
                pairingCode: code,
                boxId: boxId,
                expiresAt: expiresAt,
                link: BoxPairing.universalLink(boxId: boxId, code: code, serverUrl: override),
                manualAddress: BoxPairing.manualAddress(boxId: boxId, connectedServerUrl: connected)
            ))
            if !stopped { scheduleRotation(at: expiresAt) }
        } catch {
            state = .failed(Self.failure(SettingsError.message(error)))
        }
    }

    /// Back from the background: a code that expired meanwhile is replaced now.
    func rotateIfExpired() async {
        if case .ready(let code) = state, BoxPairing.shouldRefresh(expiresAt: code.expiresAt, now: now()) {
            await mint()
        }
    }

    func stop() {
        stopped = true
        rotation?.cancel()
        rotation = nil
    }

    private func scheduleRotation(at expiresAt: Date) {
        rotation?.cancel()
        let delay = max(0, expiresAt.timeIntervalSince(now()))
        rotation = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.mint()
        }
    }

    private static func failure(_ reason: String) -> String {
        "Couldn't create a pairing code. \(reason)"
    }
}

struct BoxAddDeviceScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = BoxAddDeviceStore()
    @State private var copied = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        SettingsSubScreen(title: "Add a device") {
            Text("Point the other phone's camera at this code, or open Manta on it and scan. It refreshes on its own every five minutes.")
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx3)
                .fixedSize(horizontal: false, vertical: true)

            switch store.state {
            case .minting:
                MantaLoader(caption: "Creating a code…", tokens: tokens, size: .inline)
            case .failed(let message):
                SettingsLoadFailure(message: message) { Task { await store.mint() } }
            case .ready(let code):
                ready(code)
            }

            Text("Prefer to type it? On the other device open Manual Setup and type the six digits and the server address above.")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task { await store.start() }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            store.stop()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.rotateIfExpired() } }
        }
    }

    @ViewBuilder
    private func ready(_ code: BoxAddDeviceStore.Code) -> some View {
        BoxPairingQR(text: code.link)
            .frame(maxWidth: 280)
            .frame(maxWidth: .infinity)

        SettingsPanel {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                field("Code") {
                    Text(code.pairingCode)
                        .font(.manta(size: Metrics.type.display, weight: .semibold, design: .monospaced))
                        .foregroundColor(tokens.tx1)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("box-pairing-code")
                }
                if let address = code.manualAddress {
                    field("Server address") {
                        HStack(alignment: .firstTextBaseline) {
                            Text(address)
                                .font(.manta(size: Metrics.type.small, design: .monospaced))
                                .foregroundColor(tokens.tx1)
                                .textSelection(.enabled)
                                .accessibilityIdentifier("box-pairing-address")
                            Spacer(minLength: Metrics.spacing.sp2)
                            Button(copied ? "Copied" : "Copy") { copy(address) }
                                .font(.manta(size: Metrics.type.small, weight: .semibold))
                                .foregroundColor(tokens.accentTx)
                                .accessibilityIdentifier("box-pairing-copy-address")
                        }
                    }
                }
                field("Server ID") {
                    Text(code.boxId)
                        .font(.manta(size: Metrics.type.small, design: .monospaced))
                        .foregroundColor(tokens.tx1)
                        .textSelection(.enabled)
                }
            }
        }

        HStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let countdown = BoxPairing.countdown(expiresAt: code.expiresAt, now: context.date)
                Text(countdown.text)
                    .font(.manta(size: Metrics.type.small, weight: .medium))
                    .foregroundColor(countdown.low ? tokens.danger : tokens.tx3)
                    .accessibilityIdentifier("box-pairing-countdown")
            }
            Spacer()
            Button {
                Task { await store.mint() }
            } label: {
                Text(store.minting ? "Refreshing…" : "Refresh code")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
            }
            .buttonStyle(.plain)
            .disabled(store.minting)
            .accessibilityIdentifier("box-pairing-refresh")
        }
    }

    private func field<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            Text(label)
                .font(.manta(size: Metrics.type.twoXS))
                .foregroundColor(tokens.tx4)
                .textCase(.uppercase)
            value()
        }
    }

    private func copy(_ text: String) {
        UIPasteboard.general.string = text
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}
