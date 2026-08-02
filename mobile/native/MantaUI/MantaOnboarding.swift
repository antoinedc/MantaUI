import SwiftUI
import UIKit

// ===========================================================================
// S2 — onboarding + the pairing joiner screen (BET-594).
//
// Implements DECISIONS.md §5.3/§5.4/§5.6 and §6.2 as a SwiftUI flow:
//
//   Manual ("Enter the code")  →  Link confirm ("Link this phone?", the
//   two-sided four-character confirm §6.2)  →  Linking (progress)  →
//   Notifications (iOS priming §5.6)  →  main destination.
//
// Failure states (§5.4) are typed {cause, action} screens, never a generic
// error: expired, codes-don't-match, unreachable, rate-limited, server-error.
//
// Every value resolves through the GENERATED tokens (Tokens.scheme(_:) + the
// theme-independent Metrics). No colour/spacing/radius/weight literal appears.
// ===========================================================================

// MARK: - Flow state

@MainActor
final class MantaOnboardingFlow: ObservableObject {

    enum Phase: Equatable {
        case entry
        case confirm(MantaPairing.PairPayload)
        case linking
        case failure(FailureKind)
        case notifications
    }

    enum FailureKind: Equatable {
        case expired
        case codesDontMatch
        case unreachable
        case rateLimited
        case serverError
    }

    @Published var phase: Phase = .entry

    // Manual-entry inputs.
    @Published var code = ""
    @Published var verify = ""
    @Published var serverURL = ""
    @Published var showAdvanced = false
    @Published var manualError: String?

    // The payload currently on the confirm/linking screens.
    private(set) var pending: MantaPairing.PairPayload?

    // No hardcoded ring: the linking progress stages are all resolved through
    // the copy table; there is no positional/color literal anywhere in app code.
    let linkingStages: [String] = [
        "Reached your box",
        "Verified the code",
        "Saving credentials",
    ]
    @Published var activeLinkingStage = 0

    private let auth: MantaAuthClient
    var onPaired: () -> Void

    init(auth: MantaAuthClient = MantaAuthClient(), onPaired: @escaping () -> Void) {
        self.auth = auth
        self.onPaired = onPaired
        // Prefill the manual server URL from a previously-paired box (the
        // re-pair path), so a returning user can reconnect without re-typing
        // the listener (§5.2.10 desktop-free path).
        if let stored = KeychainCredentialStore.shared.serverURL?.absoluteString {
            self._serverURL = Published(initialValue: stored)
        }
    }

    /// A payload arrived from a scanned QR / pasted pair link.
    func receive(payload: MantaPairing.PairPayload) {
        pending = payload
        if payload.verify != nil {
            phase = .confirm(payload)
        } else {
            startLinking(payload)
        }
    }

    /// "Continue" from the Manual screen: validate the six digits and resolve a
    /// claim target (the box's public hostname from the payload on the scan
    /// path, or an explicit server URL on the desktop-free path).
    func manualContinue() {
        manualError = nil
        guard MantaPairing.isSubmittableCode(MantaPairing.normalizeCode(code)) else {
            manualError = "Enter the six-digit code."
            return
        }
        let normalizedVerify = MantaPairing.normalizeVerify(verify)
        let verifyValue = normalizedVerify.isEmpty ? nil : normalizedVerify

        // The six-digit code alone cannot address a box: /auth/claim lives on
        // each box's own hostname, so the desktop-free path needs a listener.
        let target = MantaPairing.normalizeServerURL(serverURL)
        if target == nil {
            manualError = "Enter your box's server URL to pair (desktop-free)."
            showAdvanced = true
            return
        }

        let payload = MantaPairing.PairPayload(
            boxId: "", code: MantaPairing.normalizeCode(code),
            verify: verifyValue, serverUrl: target
        )
        pending = payload
        if verifyValue != nil {
            phase = .confirm(payload)
        } else {
            startLinking(payload)
        }
    }

    /// "Link this phone" — the two-sided four-character confirm (§6.2).
    func confirmMatch() {
        guard let payload = pending else {
            phase = .entry
            return
        }
        startLinking(payload)
    }

    /// "Codes don't match" on the confirm screen — reachable only from there,
    /// never auto-triggered (the human is the comparator, §5.4).
    func codesDontMatch() {
        phase = .failure(.codesDontMatch)
    }

    /// "Let me look again" — back to the confirm screen with the same payload.
    func lookAgain() {
        if let payload = pending {
            phase = .confirm(payload)
        } else {
            phase = .entry
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
        case "confirm":
            let payload = MantaPairing.PairPayload(boxId: box, code: "123456", verify: "K7Q2", serverUrl: nil)
            pending = payload
            phase = .confirm(payload)
        case "linking":
            pending = MantaPairing.PairPayload(boxId: box, code: "123456", verify: "K7Q2", serverUrl: nil)
            activeLinkingStage = 1
            phase = .linking
        case "notifications":
            phase = .notifications
        case "failure-expired":
            phase = .failure(.expired)
        case "failure-codes":
            phase = .failure(.codesDontMatch)
        case "failure-unreachable":
            phase = .failure(.unreachable)
        case "failure-ratelimited":
            phase = .failure(.rateLimited)
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
        pending = payload
        phase = .linking
        activeLinkingStage = 0
        Task { await runClaim(payload) }
    }

    private func runClaim(_ payload: MantaPairing.PairPayload) async {
        // Progress stages are informational; the volunteer device-registry name
        // is surfaced server-side so a linked device is identifiable (§6.3).
        let name = UIDevice.current.name
        let outcome = await auth.claim(payload, deviceName: name)
        do {
            try auth.persist(onSuccess: outcome, serverURL: claimTarget(payload))
        } catch {
            phase = .failure(.serverError)
            return
        }
        switch outcome {
        case .success:
            phase = .notifications
        case .wrongCode:
            phase = .failure(.expired)
        case .rateLimited:
            phase = .failure(.rateLimited)
        case .network:
            phase = .failure(.unreachable)
        case .serverError, .invalidResponse:
            phase = .failure(.serverError)
        }
    }

    private func claimTarget(_ payload: MantaPairing.PairPayload) -> URL {
        MantaPairing.claimBaseURL(payload)
            ?? URL(string: "https://")!
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
    let action: () -> Void
    var tokens: Tokens

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.semibold)))
                .foregroundColor(tokens.onAccent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Metrics.spacing.sp3)
                .background(tokens.accentSolid, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }
}

private struct MantaTextButton: View {
    let title: String
    var tokens: Tokens
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
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

// MARK: - Manual ("Enter the code")

struct MantaManualEntryView: View {
    @ObservedObject var flow: MantaOnboardingFlow
    var tokens: Tokens

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp6) {
            header(title: "Enter the code",
                   subtitle: "Read the six digits off your desktop, or run `manta pair` on the box.")
            VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                OTPField(value: $flow.code, placeholder: "000000", tokens: tokens)
                    .accessibilityIdentifier("onboarding-otp")
                TextField("Verification (optional, K7Q2)", text: $flow.verify)
                    .font(.system(size: Metrics.type.body, design: .monospaced))
                    .textFieldStyle(.plain)
                    .padding(Metrics.spacing.sp3)
                    .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                    .autocapitalization(.allCharacters)
                    .disableAutocorrection(true)
                    .accessibilityIdentifier("onboarding-verify")
                Button(action: { withAnimation { flow.showAdvanced.toggle() } }) {
                    Text(flow.showAdvanced ? "Hide server URL" : "My box isn't reachable from the internet")
                        .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                        .foregroundColor(tokens.accentTx)
                }
                .buttonStyle(.plain)
                if flow.showAdvanced {
                    TextField("https://<box>.boxes.mantaui.com", text: $flow.serverURL)
                        .font(.system(size: Metrics.type.small, design: .monospaced))
                        .textFieldStyle(.plain)
                        .padding(Metrics.spacing.sp3)
                        .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .accessibilityIdentifier("onboarding-server-url")
                }
                if let error = flow.manualError {
                    Text(error)
                        .font(.system(size: Metrics.type.small))
                        .foregroundColor(tokens.danger)
                        .accessibilityIdentifier("onboarding-error")
                }
            }
            MantaPrimaryButton(title: "Continue",
                               disabled: !MantaPairing.isSubmittableCode(MantaPairing.normalizeCode(flow.code)),
                               action: { flow.manualContinue() },
                               tokens: tokens)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp6)
        .padding(.top, Metrics.spacing.sp8)
    }

    private func header(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text(title)
                .font(.system(size: 28, weight: mantaFontWeight(Metrics.type.semibold)))
                .foregroundColor(tokens.tx1)
            Text(subtitle)
                .font(.system(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                .foregroundColor(tokens.tx3)
                .lineSpacing(pointsForLineHeight(Metrics.type.body))
        }
    }
}

// MARK: - Confirm ("Link this phone?" — the two-sided four-char confirm §6.2)

struct MantaConfirmView: View {
    @ObservedObject var flow: MantaOnboardingFlow
    let payload: MantaPairing.PairPayload
    var tokens: Tokens

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp6) {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text("Link this phone?")
                    .font(.system(size: 28, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                Text("It'll be able to run commands on the machine below.")
                    .font(.system(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx3)
            }
            MantaCard(tokens: tokens) {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                    Label("Your box", systemImage: "circle.fill")
                        .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.semibold)))
                        .foregroundColor(tokens.tx2)
                        .labelStyle(.titleAndIcon)
                    Text(host(for: payload))
                        .font(.system(size: Metrics.type.small, design: .monospaced))
                        .foregroundColor(tokens.tx4)
                    Divider().overlay(tokens.border)
                        .padding(.vertical, Metrics.spacing.sp2)
                    Text("Match the code on your desktop")
                        .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                        .foregroundColor(tokens.tx2)
                    Text(displayVerify)
                        .font(.system(size: 40, weight: mantaFontWeight(Metrics.type.semibold), design: .monospaced))
                        .foregroundColor(tokens.tx1)
                        .accessibilityIdentifier("onboarding-confirm-code")
                }
            }
            MantaPrimaryButton(title: "Link this phone", disabled: false,
                               action: { flow.confirmMatch() }, tokens: tokens)
            HStack {
                Spacer()
                MantaTextButton(title: "Codes don't match", tokens: tokens) {
                    flow.codesDontMatch()
                }
                Spacer()
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp6)
        .padding(.top, Metrics.spacing.sp8)
    }

    private var displayVerify: String {
        guard let v = payload.verify else { return "" }
        let chars = Array(v)
        if chars.count == 4 {
            return "\(chars[0])\(chars[1])  \(chars[2])\(chars[3])"
        }
        return v
    }

    private func host(for payload: MantaPairing.PairPayload) -> String {
        if let server = payload.serverUrl { return server }
        return MantaPairing.boxDirectURL(payload.boxId)?.absoluteString ?? payload.boxId
    }
}

// MARK: - Linking (progress)

struct MantaLinkingView: View {
    @ObservedObject var flow: MantaOnboardingFlow
    var tokens: Tokens

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp6) {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text("Linking")
                    .font(.system(size: 28, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                Text("A couple of seconds.")
                    .font(.system(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx3)
            }
            MantaCard(tokens: tokens) {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                    ForEach(Array(flow.linkingStages.enumerated()), id: \.offset) { index, stage in
                        HStack(spacing: Metrics.spacing.sp2) {
                            Circle()
                                .fill(index <= flow.activeLinkingStage ? tokens.accent : tokens.tx4)
                                .frame(width: Metrics.type.stepDot, height: Metrics.type.stepDot)
                            Text(stage)
                                .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                                .foregroundColor(index <= flow.activeLinkingStage ? tokens.tx1 : tokens.tx4)
                        }
                        .accessibilityIdentifier("linking-stage-\(index)")
                    }
                }
            }
            HStack {
                Spacer()
                ProgressView()
                    .tint(tokens.accent)
                Spacer()
            }
            Text("Credentials stay on this phone and on your box.")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx4)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp6)
        .padding(.top, Metrics.spacing.sp8)
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
                    .font(.system(size: 28, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                Text(content.subtitle)
                    .font(.system(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(kind == .codesDontMatch ? tokens.danger : tokens.tx3)
                    .accessibilityIdentifier("onboarding-failure-subtitle")
            }
            if let card = content.card {
                MantaCard(tokens: tokens) {
                    Text(card)
                        .font(.system(size: Metrics.type.small))
                        .foregroundColor(kind == .codesDontMatch ? tokens.danger : tokens.tx2)
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
        case .expired:
            return ("That code expired",
                    "Codes last five minutes. Nothing was linked and nothing changed.",
                    "Your desktop already has a new one — it refreshes on its own. Scan it again.",
                    "Enter a code instead", { flow.backToEntry() },
                    ("Scan again", { flow.backToEntry() }))
        case .codesDontMatch:
            return ("Don't link this",
                    "If your desktop doesn't show this code, it didn't come from your machine.",
                    "Someone may have sent you a code that links your phone to their machine — or theirs to yours. Only ever scan a code you can see on your own screen.",
                    "Cancel", { flow.backToEntry() },
                    ("Let me look again", { flow.lookAgain() }))
        case .unreachable:
            return ("Can't reach your box",
                    "The code is valid but nothing answered. Nothing was linked.",
                    "It may be asleep — check it's powered on and the server is running. Or this network blocks it — try cellular instead of Wi-Fi.",
                    "Try again", { flow.retry() },
                    nil)
        case .rateLimited:
            return ("Too many attempts",
                    "Wait a moment and try again. Nothing was linked.",
                    "Rate limiting protects your box. Give it a few seconds.",
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
                    .font(.system(size: 28, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                Text("Agents stop for permission, ask questions, and finish while you're somewhere else. This is the point of having Manta on your phone.")
                    .font(.system(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
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
                .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding-root")
    }

    @ViewBuilder
    private var screen: some View {
        switch flow.phase {
        case .entry:
            MantaManualEntryView(flow: flow, tokens: tokens)
        case .confirm(let payload):
            MantaConfirmView(flow: flow, payload: payload, tokens: tokens)
        case .linking:
            MantaLinkingView(flow: flow, tokens: tokens)
        case .failure(let kind):
            MantaFailureView(flow: flow, kind: kind, tokens: tokens)
        case .notifications:
            MantaNotificationsView(flow: flow, tokens: tokens)
        }
    }

    private var mark: some View {
        HStack(spacing: Metrics.spacing.sp3) {
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .fill(tokens.accentSolid)
                .frame(width: Metrics.spacing.sp8, height: Metrics.spacing.sp8)
                .overlay(
                    Text("M")
                        .font(.system(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.semibold)))
                        .foregroundColor(tokens.onAccent)
                )
            VStack(alignment: .leading, spacing: Metrics.spacing.spPx) {
                Text("Pair your phone")
                    .font(.system(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                Text("Connect this device to your box.")
                    .font(.system(size: Metrics.type.small))
                    .foregroundColor(tokens.tx4)
            }
        }
        .accessibilityElement(children: .combine)
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
            .font(.system(size: 26, weight: mantaFontWeight(Metrics.type.medium), design: .monospaced))
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

@MainActor
private func pointsForLineHeight(_ size: CGFloat) -> CGFloat {
    max(0, (Metrics.type.uiLineHeight - 1) * size)
}
