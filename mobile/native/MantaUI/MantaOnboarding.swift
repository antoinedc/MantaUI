import SwiftUI
import UIKit

// ===========================================================================
// S2 — onboarding + the pairing joiner screen (BET-594).
//
// Implements DECISIONS.md §5.3/§5.4/§5.6 as a SwiftUI flow:
//
//   Scan / pairing link  →  "Link this phone?" confirm  →  Linking (progress)  →
//   Notifications (iOS priming §5.6)  →  main destination.
//   Manual ("Enter the code" + Server address) skips the confirm: the user typed
//   the code themselves, so there is nothing to second-guess.
//
// Failure states (§5.4) are typed {cause, action} screens, never a generic
// error: rejected, unreachable, rate-limited, server-error, save-failed.
//
// Every value resolves through the GENERATED tokens (Tokens.scheme(_:) + the
// theme-independent Metrics). No colour/spacing/radius/size/weight literal
// appears — the display/confirm/OTP sizes resolve through the generated
// Metrics.type.{display,confirm,otp} tokens (BET-594).
// ===========================================================================

// MARK: - Flow state

@MainActor
final class MantaOnboardingFlow: ObservableObject {

    enum Phase: Equatable {
        case entry
        /// A scanned / linked payload is staged and waits for "Link this phone".
        case confirm
        /// "This isn't my box" — the warning screen (DECISIONS §5.4, adapted).
        case notMine
        case linking
        case failure(FailureKind)
        case notifications
    }

    enum FailureKind: Equatable {
        case rejected
        case unreachable
        case rateLimited
        case serverError
        case saveFailed
    }

    @Published var phase: Phase = .entry

    // Manual-entry inputs. `showManual` collapses the manual fields behind the
    // "Manual Setup" disclosure (BET-1308 — the entry screen is camera-first).
    // `serverURL` is the one "Server address" field (WS10 F21): a Server ID, a
    // host or a full URL — `MantaPairing.resolveManualTarget` decides which.
    @Published var code = ""
    @Published var serverURL = ""
    @Published var showManual = false
    @Published var manualError: String?

    /// In-flight claim guards (BET-1308). A successful QR decode delivers the
    /// same code on every frame, and a pairing code is single-use — so a claim
    /// must never be concurrent with another, and a stale claim's result must
    /// never overwrite a newer one. `claimInFlight` stops a second claim from
    /// starting while one is running; `claimGeneration` drops any result that
    /// arrives for a claim that is no longer the latest.
    private var claimInFlight = false
    private var claimGeneration = 0

    // The payload currently on the linking screen.
    private(set) var pending: MantaPairing.PairPayload?
    // Credentials returned by a SUCCESSFUL claim, held so a Keychain-save
    // retry can re-attempt ONLY the save (never re-claim a burned code).
    private var savedCredentials: MantaCredentials?

    /// True while the flow is re-pairing a PAIRED device onto a new box (the
    /// BET-702 "Switch box?" path). A successful claim then completes
    /// immediately (skip the notifications priming — the device is already a
    /// Manta client) and `onPaired` is responsible for resetting local state.
    var isSwitching = false

    private let auth: MantaAuthClient
    var onPaired: () -> Void

    init(auth: MantaAuthClient = MantaAuthClient(), onPaired: @escaping () -> Void) {
        self.auth = auth
        self.onPaired = onPaired
        // Prefill the manual Server address from a previously-paired box (the
        // re-pair path), so a returning user can reconnect without re-typing it
        // (§5.2.10 desktop-free path).
        if let keychain = try? KeychainCredentialStore.shared.load() {
            self._serverURL = Published(initialValue: keychain.serverUrl)
        }
    }

    /// A payload arrived from a scanned QR / pasted pair link. It is STAGED, not
    /// claimed: the user must confirm "Link this phone?" first (a link is a
    /// stranger-controllable input — DECISIONS §5.2.2). The exception is a
    /// switch the paired "Switch server?" sheet already confirmed. The camera
    /// delivers the same payload on every frame, so anything arriving while a
    /// payload is already staged or linking is ignored.
    func receive(payload: MantaPairing.PairPayload) {
        if phase == .confirm || phase == .linking { return }
        pending = payload
        if isSwitching {
            startLinking(payload)
        } else {
            phase = .confirm
        }
    }

    /// "Link this phone" on the confirm screen.
    func confirmLink() {
        guard phase == .confirm, let payload = pending else { return }
        startLinking(payload)
    }

    /// "This isn't my box" on the confirm screen. Nothing is claimed.
    func rejectPending() {
        guard phase == .confirm else { return }
        phase = .notMine
    }

    /// "Let me look again" on the warning screen: back to the confirm.
    func reviewAgain() {
        guard phase == .notMine, pending != nil else {
            backToEntry()
            return
        }
        phase = .confirm
    }

    /// What the manual Server address field says is wrong, or nil (empty is not
    /// an error — Continue is simply disabled).
    var serverAddressError: String? {
        guard !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        if case .invalid(let reason) = MantaPairing.resolveManualTarget(serverURL) { return reason }
        return nil
    }

    /// Continue needs the six digits AND a server address that resolves.
    var canContinueManually: Bool {
        guard MantaPairing.isSubmittableCode(MantaPairing.normalizeCode(code)) else { return false }
        if case .ok = MantaPairing.resolveManualTarget(serverURL) { return true }
        return false
    }

    /// "Continue" from the Manual screen: validate the six digits and resolve the
    /// claim target from the one Server address field. The user typed the code
    /// themselves, so this claims directly (no confirm).
    func manualContinue() {
        manualError = nil
        guard MantaPairing.isSubmittableCode(MantaPairing.normalizeCode(code)) else {
            manualError = "Enter the six-digit code."
            return
        }
        switch MantaPairing.resolveManualTarget(serverURL) {
        case .invalid(let reason):
            manualError = reason
        case .ok(let serverUrl, let boxId):
            let payload = MantaPairing.PairPayload(
                boxId: boxId,
                code: MantaPairing.normalizeCode(code),
                serverUrl: serverUrl
            )
            pending = payload
            startLinking(payload)
        }
    }

    /// Retry a claim (from any failure screen that recovered a payload).
    func retry() {
        if let payload = pending {
            startLinking(payload)
        } else {
            phase = .entry
        }
    }

    /// Retry ONLY the Keychain save after a successful claim whose save failed
    /// — never re-claim a burned code (the credentials are already held).
    func retrySave() {
        guard let credentials = savedCredentials else {
            phase = .entry
            return
        }
        do {
            try KeychainCredentialStore.shared.save(credentials)
            phase = .notifications
        } catch {
            phase = .failure(.saveFailed)
        }
    }

    /// Leave a failure state back to manual entry.
    func backToEntry() {
        phase = .entry
        pending = nil
    }

    /// Seed the flow into a deterministic phase for the capture harness
    /// (`MANTA_SCENE=onboarding-<screen>`). Uses a synthetic payload — the
    /// screens are measured, never touched by a real claim.
    func prepare(onboardingScene name: String) {
        let box = "0123abcd0123abcd0123abcd0123abcd"
        let suffix = name.hasPrefix("onboarding-") ? String(name.dropFirst("onboarding-".count)) : name
        switch suffix {
        case "linking":
            pending = MantaPairing.PairPayload(boxId: box, code: "123456", serverUrl: nil)
            phase = .linking
        case "confirm":
            pending = MantaPairing.PairPayload(boxId: box, code: "123456", serverUrl: nil)
            phase = .confirm
        case "not-mine":
            pending = MantaPairing.PairPayload(boxId: box, code: "123456", serverUrl: nil)
            phase = .notMine
        case "notifications":
            phase = .notifications
        case "failure-rejected":
            phase = .failure(.rejected)
        case "failure-unreachable":
            phase = .failure(.unreachable)
        case "failure-ratelimited":
            phase = .failure(.rateLimited)
        case "failure-save":
            phase = .failure(.saveFailed)
        default:
            phase = .entry
        }
    }

    /// "Continue" on the Notifications screen → request iOS notification
    /// authorization, then land on the main destination. Denying lands on the
    /// session list exactly as accepting does (§5.6 — no functionality gated on
    /// the permission).
    func notificationsContinue() {
        Task {
            await requestNotificationAuthorization()
            onPaired()
        }
    }

    // MARK: - Linking

    private func startLinking(_ payload: MantaPairing.PairPayload) {
        // A duplicate payload (the scanner delivers the same code on many
        // frames) must never start a second concurrent claim — only the first
        // claim of a batch runs.
        guard !claimInFlight else { return }
        pending = payload
        phase = .linking
        claimInFlight = true
        claimGeneration += 1
        let generation = claimGeneration
        Task { await runClaim(payload, generation: generation) }
    }

    /// Runs a claim for `payload` at `generation`. Internal (not private) so
    /// the staleness-guard unit test can drive a stale generation's result and
    /// assert its `phase`/`savedCredentials` writes are dropped. In production
    /// it is only ever invoked by `startLinking` with the current generation.
    func runClaim(_ payload: MantaPairing.PairPayload, generation: Int) async {
        defer { finishClaim(generation) }
        // The volunteer device-registry name is surfaced server-side so a
        // linked device is identifiable (§6.3).
        let name = UIDevice.current.name
        // claimBaseURL is the same resolution MantaAuthClient.claim performs; a
        // nil base can never produce a .success outcome, so failing here is the
        // same classification arriving one step earlier — and it removes the
        // need for a placeholder URL that could never be a real claim target.
        guard let serverURL = MantaPairing.claimBaseURL(payload) else {
            if self.currentGeneration(generation) {
                phase = .failure(.serverError)
            }
            return
        }
        let outcome = await auth.claim(payload, deviceName: name)
        switch outcome {
        case .success(let boxToken, let boxId, _):
            guard self.currentGeneration(generation) else { return }
            let credentials = MantaCredentials(
                serverUrl: serverURL.absoluteString,
                boxId: boxId,
                boxToken: boxToken
            )
            savedCredentials = credentials
            do {
                try KeychainCredentialStore.shared.save(credentials)
                guard self.currentGeneration(generation) else { return }
                if isSwitching {
                    // Re-pair onto a new box: the old device is already a
                    // Manta client — skip the notifications primer and hand off
                    // so `onPaired` resets the session list + event stream.
                    onPaired()
                } else {
                    phase = .notifications
                }
            } catch {
                guard self.currentGeneration(generation) else { return }
                phase = .failure(.saveFailed)
            }
        case .wrongCode:
            if self.currentGeneration(generation) {
                phase = .failure(.rejected)
            }
        case .rateLimited:
            if self.currentGeneration(generation) {
                phase = .failure(.rateLimited)
            }
        case .network:
            if self.currentGeneration(generation) {
                phase = .failure(.unreachable)
            }
        case .serverError, .invalidResponse:
            if self.currentGeneration(generation) {
                phase = .failure(.serverError)
            }
        }
    }

    /// True when `generation` is still the latest claim — i.e. no newer claim
    /// has started since this one did. Guards every `phase` / `savedCredentials`
    /// write so a stale claim's result can never overwrite a newer one.
    private func currentGeneration(_ generation: Int) -> Bool {
        generation == claimGeneration
    }

    /// Release the in-flight guard for `generation`, but ONLY if it is still
    /// the current claim — a stale claim finishing must not clear the newer
    /// claim's in-flight flag. Mirrored as a `defer` in `runClaim` so every
    /// exit path settles it.
    private func finishClaim(_ generation: Int) {
        guard generation == claimGeneration else { return }
        claimInFlight = false
    }

    private func requestNotificationAuthorization() async {
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }
}

// MARK: - Shared UI atoms (all resolved through generated tokens)

private struct MantaPrimaryButton: View {
    let title: String
    let disabled: Bool
    var identifier: String?
    let action: () -> Void
    var tokens: Tokens

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.semibold)))
                .foregroundColor(tokens.onAccent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Metrics.spacing.sp3)
                .background(tokens.accentSolid, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
        .modifier(IdentifierModifier(identifier))
    }
}

/// Applies an optional accessibility identifier to a button without the
/// call-site boilerplate of a conditional modifier. The manual submit button
/// carries `onboarding-submit`; every other use passes `nil`.
private struct IdentifierModifier: ViewModifier {
    let identifier: String?
    init(_ identifier: String?) { self.identifier = identifier }

    func body(content: Content) -> some View {
        if let identifier {
            content.accessibilityIdentifier(identifier)
        } else {
            content
        }
    }
}

private struct MantaTextButton: View {
    let title: String
    var tokens: Tokens
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                .foregroundColor(tokens.accentTx)
        }
        .buttonStyle(.plain)
        .padding(.vertical, Metrics.spacing.sp2)
        .contentShape(Rectangle())
    }
}

private struct MantaCard<Content: View>: View {
    var tokens: Tokens
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(Metrics.spacing.sp4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tokens.card, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radius.lg)
                    .stroke(tokens.border, lineWidth: Metrics.spacing.spPx)
            )
    }
}

// MARK: - Manual (camera-first entry)

struct MantaManualEntryView: View {
    @ObservedObject var flow: MantaOnboardingFlow
    var tokens: Tokens

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp6) {
            // The embedded camera panel is always present. A decoded Manta
            // payload routes through the SAME `flow.receive` path as a deep
            // link — it is staged for the "Link this phone?" confirm, never
            // claimed straight away.
            MantaCameraPanel(tokens: tokens) { payload in
                flow.receive(payload: payload)
            }
            manualDisclosure
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp6)
        .padding(.top, Metrics.spacing.sp8)
    }

    @ViewBuilder
    private var manualDisclosure: some View {
        // "Manual Setup" — collapsed by default. Expands to: the pairing code,
        // the one "Server address" field, then the submit button.
        Button(action: { withAnimation { flow.showManual.toggle() } }) {
            Text("Manual Setup")
                .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                .foregroundColor(tokens.accentTx)
        }
        .buttonStyle(.plain)
        .padding(.vertical, Metrics.spacing.sp2)
        .contentShape(Rectangle())
        .accessibilityIdentifier("onboarding-manual-toggle")

        if flow.showManual {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                    Text("Pairing code")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx4)
                    OTPField(value: $flow.code, placeholder: "000000", tokens: tokens)
                        .accessibilityIdentifier("onboarding-otp")
                }

                // A six-digit code cannot address a box by itself, so the box is
                // named by ONE field: its Server ID, host or URL. (There is no
                // code→box lookup — see WS10 F21.)
                VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                    Text("Server address")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx4)
                    TextField("Server ID or address", text: $flow.serverURL)
                        .font(.manta(size: Metrics.type.small, design: .monospaced))
                        .textFieldStyle(.plain)
                        .padding(Metrics.spacing.sp3)
                        .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("onboarding-server-url")
                    if let problem = flow.serverAddressError {
                        Text(problem)
                            .font(.manta(size: Metrics.type.small))
                            .foregroundColor(tokens.danger)
                            .accessibilityIdentifier("onboarding-server-address-error")
                    }
                    Text("On your desktop: Settings → Box → Add a phone shows the Server ID. On another phone: Settings → Box → Add a device shows the server address. Or run `manta pair` on the box.")
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let error = flow.manualError {
                    Text(error)
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.danger)
                        .accessibilityIdentifier("onboarding-error")
                }
                MantaPrimaryButton(title: "Continue",
                                   disabled: !flow.canContinueManually,
                                   identifier: "onboarding-submit",
                                   action: { flow.manualContinue() },
                                   tokens: tokens)
            }
        }
    }
}

// MARK: - "Link this phone?" (scan / link confirm, WS10 F20)

struct MantaLinkConfirmView: View {
    @ObservedObject var flow: MantaOnboardingFlow
    var tokens: Tokens

    var body: some View {
        let summary = flow.pending.map(MantaPairing.confirmSummary)
        VStack(alignment: .leading, spacing: Metrics.spacing.sp6) {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text("Link this phone?")
                    .font(.manta(size: Metrics.type.display, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                    .accessibilityAddTraits(.isHeader)
                Text("It'll be able to run commands on the machine below.")
                    .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx3)
            }
            MantaCard(tokens: tokens) {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                    HStack(spacing: Metrics.spacing.sp2) {
                        Circle()
                            .fill(tokens.ok)
                            .frame(width: Metrics.spacing.sp2, height: Metrics.spacing.sp2)
                        Text("Your box")
                            .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                            .foregroundColor(tokens.tx4)
                    }
                    Text(summary?.host ?? "")
                        .font(.manta(size: Metrics.type.body, design: .monospaced))
                        .foregroundColor(tokens.tx1)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("link-confirm-host")
                    if let prefix = summary?.idPrefix {
                        Rectangle()
                            .fill(tokens.borderSubtle)
                            .frame(height: Metrics.spacing.spPx)
                        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                            Text("Server ID starts with \(prefix)")
                                .font(.manta(size: Metrics.type.small, design: .monospaced))
                                .foregroundColor(tokens.tx1)
                                .accessibilityIdentifier("link-confirm-id-prefix")
                            Text("Check it matches Add a phone on your desktop.")
                                .font(.manta(size: Metrics.type.small))
                                .foregroundColor(tokens.tx3)
                        }
                    }
                }
            }
            MantaPrimaryButton(title: "Link this phone", disabled: false,
                               identifier: "link-confirm-link",
                               action: { flow.confirmLink() }, tokens: tokens)
            HStack {
                Spacer()
                MantaTextButton(title: "This isn't my box", tokens: tokens) { flow.rejectPending() }
                Spacer()
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp6)
        .padding(.top, Metrics.spacing.sp8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link-confirm")
    }
}

/// "This isn't my box": nothing is claimed; the user is warned what such a code
/// could mean.
struct MantaNotMineView: View {
    @ObservedObject var flow: MantaOnboardingFlow
    var tokens: Tokens

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp6) {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text("Don't link this")
                    .font(.manta(size: Metrics.type.display, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                    .accessibilityAddTraits(.isHeader)
                Text("If you didn't just open Add a phone on your own computer, this code didn't come from you.")
                    .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx3)
            }
            MantaCard(tokens: tokens) {
                Text("Someone may have sent you a code that links your phone to their machine — or theirs to yours. Only ever scan a code you can see on your own screen.")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.danger)
            }
            MantaPrimaryButton(title: "Cancel", disabled: false,
                               identifier: "not-mine-cancel",
                               action: { flow.backToEntry() }, tokens: tokens)
            HStack {
                Spacer()
                MantaTextButton(title: "Let me look again", tokens: tokens) { flow.reviewAgain() }
                Spacer()
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp6)
        .padding(.top, Metrics.spacing.sp8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("not-mine")
    }
}

// MARK: - Linking (full-screen loader)

struct MantaLinkingView: View {
    let flow: MantaOnboardingFlow
    var tokens: Tokens

    var body: some View {
        // The app's one loader, full-screen — not a card inside a ScrollView.
        // Rendered outside the root's ScrollView (see MantaOnboardingRoot).
        MantaLoader(caption: "Linking…", tokens: tokens, size: .screen)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Failure states (§5.4) — typed {cause, action} pairs

struct MantaFailureView: View {
    @ObservedObject var flow: MantaOnboardingFlow
    let kind: MantaOnboardingFlow.FailureKind
    var tokens: Tokens

    var body: some View {
        let content = spec(kind)
        VStack(alignment: .leading, spacing: Metrics.spacing.sp6) {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text(content.heading)
                    .font(.manta(size: Metrics.type.display, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                Text(content.subtitle)
                    .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx3)
                    .accessibilityIdentifier("onboarding-failure-subtitle")
            }
            if let card = content.card {
                MantaCard(tokens: tokens) {
                    Text(card)
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx2)
                        .accessibilityIdentifier("onboarding-failure-card")
                }
            }
            MantaPrimaryButton(title: content.primaryTitle, disabled: false,
                               action: content.primaryAction, tokens: tokens)
            if let secondary = content.secondary {
                HStack {
                    Spacer()
                    MantaTextButton(title: secondary.title, tokens: tokens, action: secondary.action)
                    Spacer()
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp6)
        .padding(.top, Metrics.spacing.sp8)
    }

    private func spec(_ kind: MantaOnboardingFlow.FailureKind) -> (heading: String, subtitle: String, card: String?, primaryTitle: String, primaryAction: () -> Void, secondary: (title: String, action: () -> Void)?) {
        switch kind {
        case .rejected:
            // The server returns one generic 403 for wrong AND expired codes
            // (anti-brute-force), so the client cannot distinguish either.
            return ("That code didn't work",
                    "It may have expired or been mistyped. Get a fresh code and try again.",
                    "Get a fresh code from your desktop — it refreshes on its own. Nothing was linked.",
                    "Enter a code instead", { flow.backToEntry() },
                    ("Scan again", { flow.backToEntry() }))
        case .saveFailed:
            // Claim succeeded but the Keychain write failed. Retry re-attempts
            // ONLY the save — the code is already burned, never re-claim.
            return ("Paired, but couldn't save to this phone",
                    "Your server accepted the code, but this phone couldn't store the connection yet.",
                    "Nothing is linked until the credentials save. Try saving again — don't enter a new code.",
                    "Try again", { flow.retrySave() },
                    ("Back", { flow.backToEntry() }))
        case .unreachable:
            return ("Can't reach your server",
                    "The code is valid but nothing answered. Nothing was linked.",
                    "It may be asleep — check it's powered on and the server is running. Or this network blocks it — try cellular instead of Wi-Fi.",
                    "Try again", { flow.retry() },
                    nil)
        case .rateLimited:
            return ("Too many attempts",
                    "Wait a moment and try again. Nothing was linked.",
                    "Rate limiting protects your server. Give it a few seconds.",
                    "Try again", { flow.retry() },
                    ("Back", { flow.backToEntry() }))
        case .serverError:
            return ("Something went wrong",
                    "The server had a problem. Nothing was linked.",
                    "Try again in a moment.",
                    "Try again", { flow.retry() },
                    ("Back", { flow.backToEntry() }))
        }
    }
}

// MARK: - Notifications (iOS priming §5.6)

struct MantaNotificationsView: View {
    @ObservedObject var flow: MantaOnboardingFlow
    var tokens: Tokens

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp6) {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text("Know when it needs you")
                    .font(.manta(size: Metrics.type.display, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                Text("Agents stop for permission, ask questions, and finish while you're somewhere else. This is the point of having Manta on your phone.")
                    .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx3)
            }
            MantaCard(tokens: tokens) {
                VStack(spacing: Metrics.spacing.sp3) {
                    row(icon: "exclamationmark.shield", tint: tokens.warn, text: "Permission needed to run a command")
                    row(icon: "exclamationmark.triangle", tint: tokens.accent, text: "A question is blocking the turn")
                    row(icon: "checkmark.circle", tint: tokens.ok, text: "A long turn finished")
                }
            }
            MantaPrimaryButton(title: "Continue", disabled: false,
                               action: { flow.notificationsContinue() }, tokens: tokens)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp6)
        .padding(.top, Metrics.spacing.sp8)
    }

    private func row(icon: String, tint: Color, text: String) -> some View {
        HStack(spacing: Metrics.spacing.sp3) {
            Image(systemName: icon)
                .font(.system(size: Metrics.type.body))
                .foregroundColor(tint)
                .frame(width: Metrics.spacing.sp6, height: Metrics.spacing.sp6)
            Text(text)
                .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                .foregroundColor(tokens.tx1)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Root container

struct MantaOnboardingRoot: View {
    @ObservedObject var flow: MantaOnboardingFlow
    var tokens: Tokens

    init(flow: MantaOnboardingFlow, tokens: Tokens) {
        self.flow = flow
        self.tokens = tokens
    }

    var body: some View {
        ZStack {
            tokens.canvas.ignoresSafeArea()
            if case .linking = flow.phase {
                // The loader is a full screen, not a card inside the scroll
                // shell — render it outside the ScrollView so it fills the
                // screen exactly like the other full-screen waits.
                MantaLinkingView(flow: flow, tokens: tokens)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        // One brand mark at the top of the first step (not every
                        // step — §5.2.6: no icon/badge atop every step header).
                        if case .entry = flow.phase {
                            mark
                                .padding(.top, Metrics.spacing.sp8)
                                .padding(.bottom, Metrics.spacing.sp6)
                        }
                        screen
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding-root")
    }

    @ViewBuilder
    private var screen: some View {
        switch flow.phase {
        case .entry:
            MantaManualEntryView(flow: flow, tokens: tokens)
        case .confirm:
            MantaLinkConfirmView(flow: flow, tokens: tokens)
        case .notMine:
            MantaNotMineView(flow: flow, tokens: tokens)
        case .linking:
            // Rendered outside the ScrollView above; kept here so the switch
            // stays exhaustive.
            MantaLinkingView(flow: flow, tokens: tokens)
        case .failure(let kind):
            MantaFailureView(flow: flow, kind: kind, tokens: tokens)
        case .notifications:
            MantaNotificationsView(flow: flow, tokens: tokens)
        }
    }

    private var mark: some View {
        HStack(spacing: Metrics.spacing.sp3) {
            // The REAL bundled logo, shared with MantaLoader — not a hand-drawn
            // letter tile (BET-1308).
            MantaLogoMark(size: Metrics.spacing.sp8)
            VStack(alignment: .leading, spacing: Metrics.spacing.spPx) {
                Text("Pair your phone")
                    .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                Text("Connect this device to your server.")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx4)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Paired re-pair confirmation (BET-702 "Switch box?")

/// Presenting view for a pairing link that arrives while the device is ALREADY
/// paired. Shows the current box vs. the new box and lets the user confirm the
/// re-pair (Switch) or back out (Cancel). On Switch the existing claim path
/// runs and, on success, replaces the Keychain credentials + resets local state.
struct MantaSwitchBoxSheet: View {
    var tokens: Tokens
    let currentHost: String
    let newHost: String
    let onCancel: () -> Void
    let onSwitch: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp6) {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text("Switch server?")
                    .font(.manta(size: Metrics.type.display, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                Text("A Manta pairing link arrived while you're connected to another server. Switching re-pairs this phone to the new one.")
                    .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx3)
            }
            MantaCard(tokens: tokens) {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                    hostRow(label: "Current server", host: currentHost)
                    hostRow(label: "New server", host: newHost)
                }
            }
            MantaPrimaryButton(title: "Switch", disabled: false,
                               action: onSwitch, tokens: tokens)
            HStack {
                Spacer()
                MantaTextButton(title: "Cancel", tokens: tokens) { onCancel() }
                Spacer()
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp6)
        .padding(.top, Metrics.spacing.sp6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("switch-box-sheet")
    }

    private func hostRow(label: String, host: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Metrics.spacing.sp3) {
            Text(label)
                .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                .foregroundColor(tokens.tx4)
            Spacer(minLength: Metrics.spacing.sp4)
            Text(host)
                .font(.manta(size: Metrics.type.small, design: .monospaced))
                .foregroundColor(tokens.tx1)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(label == "Current server" ? "switch-box-current" : "switch-box-new")
    }
}

// MARK: - Helpers

/// Six-cell OTP input: numeric-only, clamped to 6, medium archetype.
private struct OTPField: View {
    @Binding var value: String
    let placeholder: String
    var tokens: Tokens

    var body: some View {
        TextField(placeholder, text: $value)
            .font(.manta(size: Metrics.type.otp, weight: mantaFontWeight(Metrics.type.medium), design: .monospaced))
            .keyboardType(.numberPad)
            .multilineTextAlignment(.center)
            .tracking(Metrics.spacing.sp2)
            .padding(.vertical, Metrics.spacing.sp3)
            .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            .onChange(of: value) { _, newValue in
                value = MantaPairing.normalizeCode(newValue)
            }
    }
}
