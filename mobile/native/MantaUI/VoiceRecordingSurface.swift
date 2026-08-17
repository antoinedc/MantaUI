import SwiftUI
import UIKit

// ===========================================================================
// BET-1028 — the WhatsApp-style recording surfaces.
//
// The view layer over the pure gesture machine (`VoiceGesture.swift`) and the
// metering recorder (`VoiceRecorder.swift`, BET-1027). It renders the machine's
// `VoicePhase` and sends INPUTS (press / drag / release / tap) to it; it owns
// NO transition logic — every `if` deciding what recording should do next lives
// in `VoiceGesture.swift`. The only branch here is which SURFACE to draw for
// the phase the machine reports.
//
// These surfaces are PURELY PRESENTATIONAL (BET-1051, decision #4): they render
// props and call callbacks, and contain no gesture of their own. The ONE drag
// gesture in the whole voice feature lives on the mic button in ComposerView —
// the only view guaranteed to exist when the touch begins — and feeds the
// machine directly. The held surface is drawn as an OVERLAY on the composer box
// while a finger is down (so the mic button underneath keeps the touch alive for
// the whole continuous gesture), and the locked bar REPLACES the box once the
// take is hands-free.
//
// Both surfaces reuse the composer's shared `BoxChrome` glass (applied as the
// LAST modifier in each `body`), and derive every colour/spacing from the
// tokens. No hex, no new token, no second glass recipe.
// ===========================================================================

// MARK: - Surface A · Recording — held

/// The finger-down held surface: record dot + timer + the "‹ slide to cancel"
/// hint, with the lock lane floating to the right. Drawn as an OVERLAY on the
/// composer box while `recorder.phase == .recordingHeld` (or `.cancelling`), so
/// the mic button underneath stays alive for the whole continuous gesture. It
/// has NO gesture of its own — `translation` (fed from the mic's drag) drives
/// the hint shift and the lock-glyph brightening, and it never decides what the
/// take should do next.
struct VoiceRecordingHeldView: View {
    @ObservedObject var recorder: VoiceRecorder
    let translation: CGSize
    let isRTL: Bool
    let tokens: Tokens

    /// The enlarged mic in the lane — 38 (chatHeaderBtn) + 8 (sp2) = 46, derived,
    /// never hardcoded. The glyph sits on the accent at the composer's body size.
    private var micDiameter: CGFloat { Metrics.type.chatHeaderBtn + Metrics.spacing.sp2 }
    private var micGlyphSize: CGFloat { Metrics.type.body }

    var body: some View {
        let lockP = VoiceGesture.lockProgress(dy: translation.height)
        let cancelP = VoiceGesture.cancelProgress(dx: translation.width, isRTL: isRTL)
        let isCancelling = recorder.phase == .cancelling
        let hintShift = cancelP * (micDiameter + Metrics.spacing.sp3)

        ZStack(alignment: .bottomTrailing) {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                VoiceTakeHeadline(recorder: recorder, tokens: tokens)
                cancelHint(progress: cancelP, shift: hintShift, isRTL: isRTL, isCancelling: isCancelling)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            lockLane(lockProgress: lockP, isCancelling: isCancelling)
                .padding(.trailing, Metrics.spacing.sp3)
                .padding(.bottom, Metrics.spacing.sp2)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp3)
        .contentShape(Rectangle())
        // One accessibility element for the whole held surface (children stay
        // individually reachable), so `voice-recording-held` resolves to a
        // single element instead of propagating to every child in the AX tree.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice-recording-held")
        .modifier(BoxChrome(cornerRadius: Metrics.radius.xl, stroke: tokens.borderSubtle, tint: tokens.panel.opacity(0.35)))
    }

    // MARK: records

    /// The "‹ slide to cancel" hint — translates with the drag and fades toward
    /// 0 as the cancel threshold is approached. Once the take is actually in
    /// the cancelling phase it flips to a solid danger "release to cancel".
    @ViewBuilder
    private func cancelHint(progress: Double, shift: CGFloat, isRTL: Bool, isCancelling: Bool) -> some View {
        let text = isCancelling ? "release to cancel" : "‹ slide to cancel"
        let color = isCancelling ? tokens.danger : tokens.tx3
        let opacity = isCancelling ? 1.0 : 0.85 * (1 - progress)
        HStack {
            if isRTL { Spacer(minLength: 0) }
            Text(text)
                .font(.manta(size: Metrics.type.small, weight: isCancelling ? mantaFontWeight(Metrics.type.semibold) : .regular))
                .foregroundColor(color)
                .opacity(opacity)
                .offset(x: isRTL ? -shift : shift)
                .animation(.smooth(duration: 0.05), value: shift)
            if !isRTL { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }

    // MARK: lock lane

    /// The floating lock lane — chevron, lock glyph, enlarged mic — appearing
    /// only while held. The lock glyph brightens to `accentTx` as the lock
    /// threshold is approached (a pure crossfade of the two tokens).
    private func lockLane(lockProgress: Double, isCancelling: Bool) -> some View {
        VStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "chevron.up")
                .font(.system(size: Metrics.type.xs, weight: .bold))
                .foregroundColor(tokens.tx2)
            Image(systemName: "lock")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
                .overlay {
                    Image(systemName: "lock")
                        .font(.system(size: Metrics.type.small))
                        .foregroundColor(tokens.accentTx)
                        .opacity(lockProgress)
                }
            mic
        }
        .frame(width: Metrics.spacing.spPx * 46)
        .padding(.vertical, Metrics.spacing.sp3)
        .background(tokens.raised.opacity(0.9), in: Capsule())
        .overlay(Capsule().stroke(tokens.borderSubtle, lineWidth: 1))
        .accessibilityIdentifier("voice-lock-lane")
    }

    private var mic: some View {
        ZStack {
            Circle()
                .fill(tokens.accentSolid)
                .frame(width: micDiameter, height: micDiameter)
                .overlay(
                    Circle()
                        .stroke(tokens.accent.opacity(0.14), lineWidth: 8)
                )
            Image(systemName: "mic.fill")
                .font(.system(size: micGlyphSize, weight: .semibold))
                .foregroundColor(tokens.onAccent)
        }
        .frame(width: micDiameter, height: micDiameter)
        .contentShape(Rectangle())
    }
}

// MARK: - Surface C · Recording — locked

/// The hands-free locked surface: head row (record dot, timer, live waveform),
/// optional remaining-time line, and the discard / pause / send bar. Replaces
/// the composer box while the machine is `.recordingLocked` or `.paused`. The
/// only interactive elements are the three bar buttons — a tap on the surface's
/// background does nothing (decision #6, BET-1051: no tap-anywhere-to-send).
struct VoiceRecordingLockedView: View {
    @ObservedObject var recorder: VoiceRecorder
    let tokens: Tokens
    var onTake: (VoiceRecorder.Take) -> Void = { _ in }
    var onDiscarded: () -> Void = {}

    private let buttonSize = Metrics.type.chatHeaderBtn

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            // Head row: record dot + elapsed clock + live waveform (shared with
            // the held surface so there is ONE live-meter call site).
            VoiceTakeHeadline(recorder: recorder, tokens: tokens)

            // Remaining-time line — only inside the warn window.
            if remaining < Waveform.Constants.warnRemainingMs {
                Text(Waveform.formatClock(remaining) + " left")
                    .font(.manta(size: Metrics.type.twoXS))
                    .foregroundColor(tokens.warn)
            }

            // Discard / pause / send bar.
            HStack(spacing: Metrics.spacing.sp6) {
                discardButton
                Spacer(minLength: 0)
                pauseButton
                Spacer(minLength: 0)
                sendButton
            }
            .padding(.horizontal, Metrics.spacing.sp2)

            // Hint.
            Text("tap ❙❙ to pause · ➤ transcribes and sends")
                .font(.manta(size: Metrics.type.twoXS))
                .foregroundColor(tokens.tx4)
                .frame(maxWidth: .infinity)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .accessibilityHidden(true)
        }
        .padding(Metrics.spacing.sp3)
        .contentShape(Rectangle())
        // One accessibility element for the surface; the bar's three buttons
        // remain separate interactive elements (they carry their own ids).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice-recording-locked")
        .modifier(BoxChrome(cornerRadius: Metrics.radius.xl, stroke: tokens.borderSubtle, tint: tokens.panel.opacity(0.35)))
    }

    private var remaining: Int {
        max(0, Waveform.Constants.maxDurationMs - recorder.durationMs)
    }

    private var discardButton: some View {
        Button {
            if recorder.discardLockedTake() {
                onDiscarded()
            }
        } label: {
            Image(systemName: "trash")
                .font(.system(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(tokens.tx2)
                .frame(width: buttonSize, height: buttonSize)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Discard recording")
        .accessibilityIdentifier("voice-discard")
    }

    private var pauseButton: some View {
        Button {
            if recorder.phase == .paused {
                recorder.resume()
            } else {
                recorder.pause()
            }
        } label: {
            Image(systemName: recorder.phase == .paused ? "play.fill" : "pause.fill")
                .font(.system(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(tokens.danger)
                .frame(width: buttonSize, height: buttonSize)
                .overlay(Circle().stroke(tokens.danger, lineWidth: 2))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(recorder.phase == .paused ? "Resume recording" : "Pause recording")
        .accessibilityIdentifier("voice-pause")
    }

    private var sendButton: some View {
        Button {
            onTakeFrom(recorder.sendLockedTake())
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.onAccent)
                .frame(width: buttonSize, height: buttonSize)
                .background(AnyShapeStyle(tokens.accentSolid), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Send recording")
        .accessibilityIdentifier("voice-send")
    }

    private func onTakeFrom(_ take: VoiceRecorder.Take?) {
        if let take { onTake(take) }
    }
}

// MARK: - Feedback modifier

/// Applies the recording machine's VoiceOver announcements + haptic playback to
/// whatever view owns the recording UI. Applied ONCE to a persistent container
/// (the composer VStack in ComposerView), so `lastAnnounced` survives the
/// held-surface overlay ↔ locked-bar replacement without resetting on remount.
@MainActor
struct VoiceFeedback: ViewModifier {
    @ObservedObject var recorder: VoiceRecorder
    @State private var lastAnnounced: VoicePhase?

    func body(content: Content) -> some View {
        content
            .onAppear { lastAnnounced = recorder.phase }
            .onChange(of: recorder.phase) { _, newPhase in
                announce(previous: lastAnnounced, current: newPhase)
                lastAnnounced = newPhase
            }
            .onChange(of: recorder.haptic) { _, newValue in
                guard let haptic = newValue else { return }
                VoiceHapticPlayer.play(haptic)
                recorder.consumeHaptic()
            }
    }

    // MARK: VoiceOver announcements (decision #4)

    // Delivered as polite `UIAccessibility` announcements — the canonical live
    // region for a dialog-free state change. The timer is deliberately excluded.

    private func announce(previous: VoicePhase?, current: VoicePhase) {
        let message: String? = switch (previous, current) {
        case (.idle, .recordingHeld), (.idle, .recordingLocked): "Recording started"
        case (.recordingHeld, .recordingLocked): "Recording locked"
        case (.recordingLocked, .paused): "Recording paused"
        case (.paused, .recordingLocked): "Recording resumed"
        case (.cancelling, .idle): "Recording discarded"
        default: nil
        }
        if let message {
            UIAccessibility.post(notification: .announcement, argument: message)
        }
    }
}

/// Physical playback of a machine-requested haptic. The VIEW maps a machine
/// haptic to the strongest system feedback for it, but never decides WHEN one
/// fires — that is the machine's output.
@MainActor
enum VoiceHapticPlayer {
    static func play(_ haptic: VoiceHaptic) {
        switch haptic {
        case .arm:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .lock, .send:
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .cancelArmed:
            UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        }
    }
}

/// Record dot + elapsed clock + live meter — the head row shared by the held
/// and the locked surface, so there is ONE live-meter call site and ONE clock
/// rather than a copy per surface.
struct VoiceTakeHeadline: View {
    @ObservedObject var recorder: VoiceRecorder
    let tokens: Tokens

    var body: some View {
        HStack(alignment: .center, spacing: Metrics.spacing.sp2) {
            VoiceRecordDot(danger: tokens.danger)
            Text(Waveform.formatClock(recorder.durationMs))
                .font(.manta(size: Metrics.type.body, weight: .semibold).monospacedDigit())
                .foregroundColor(tokens.tx1)
            Spacer(minLength: Metrics.spacing.sp2)
            VoiceBarsView(peaks: recorder.livePeaks, progress: nil, tokens: tokens,
                          style: .live, onSeek: nil)
        }
        .accessibilityHidden(true)
    }
}

/// The pulsing record dot, shared by the held and locked surfaces.
struct VoiceRecordDot: View {
    let danger: Color
    @State private var pulse = false
    var body: some View {
        Circle()
            .fill(danger)
            .frame(width: Metrics.spacing.spPx * 11, height: Metrics.spacing.spPx * 11)
            .overlay(
                Circle()
                    .stroke(danger.opacity(0.16), lineWidth: 4)
            )
            .opacity(pulse ? 1 : 0.55)
            .animation(.smooth(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
            .onAppear { pulse = true }
            .accessibilityHidden(true)
    }
}
