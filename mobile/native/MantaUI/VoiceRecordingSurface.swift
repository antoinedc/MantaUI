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
// Both surfaces REPLACE the composer box in place (same outer padding), reuse
// the composer's shared `BoxChrome` glass, and derive every colour/spacing from
// the tokens. No hex, no new token, no second glass recipe.
// ===========================================================================

/// The live, scrolling waveform bar row. Takes peaks ALREADY bucketed to
/// `0...1` (newest at the trailing edge) by the caller. It deliberately does
/// NOT call `Waveform.normalizeForDisplay` — the live meter pins its ceiling
/// at 1.0 on purpose (see the `Waveform` doc), and renormalising a scrolling
/// window would make every previously-drawn bar jump each time a new loudest
/// sample arrives.
struct VoiceLiveWaveform: View {
    let peaks: [Double]
    let tokens: Tokens

    var body: some View {
        let barWidth = Metrics.spacing.spPx * 2
        let barGap = Metrics.spacing.spPx * 2
        let maxBarHeight = Metrics.spacing.sp5
        HStack(alignment: .center, spacing: barGap) {
            ForEach(Array(peaks.enumerated()), id: \.offset) { index, peak in
                let p = min(1, max(0, peak))
                RoundedRectangle(cornerRadius: Metrics.radius.full, style: .continuous)
                    .fill(tokens.accentTx.opacity(0.9))
                    .frame(width: barWidth, height: max(barWidth, maxBarHeight * p))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .frame(height: maxBarHeight)
        .clipped()
        .accessibilityLabel("Live audio waveform")
    }
}

// MARK: - Surface A · Recording — held

/// The finger-down held surface: record dot + timer + the "‹ slide to cancel"
/// hint, with the lock lane floating to the right. Renders while
/// `recorder.phase == .recordingHeld` and hosts the ongoing hold gesture
/// (slide up → lock, slide left → cancel, release → send).
struct VoiceRecordingHeldView: View {
    @ObservedObject var recorder: VoiceRecorder
    let isRTL: Bool
    let tokens: Tokens
    var onTake: (VoiceRecorder.Take) -> Void = { _ in }

    @State private var translation: CGSize = .zero
    @State private var dragStart: Date?

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
            HStack(alignment: .center, spacing: Metrics.spacing.sp2) {
                AccessoryDot(danger: tokens.danger)
                timer
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
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    if dragStart == nil { dragStart = Date() }
                    translation = value.translation
                    recorder.drag(dx: value.translation.width, dy: value.translation.height, isRTL: isRTL)
                }
                .onEnded { _ in
                    withAnimation(.smooth(duration: 0.22)) { translation = .zero }
                    finishHoldRelease()
                }
        )
    }

    // MARK: records

    /// The tabular mono-digit elapsed clock.
    private var timer: some View {
        Text(Waveform.formatClock(recorder.durationMs))
            .font(.manta(size: Metrics.type.body, weight: .semibold).monospacedDigit())
            .foregroundColor(tokens.tx1)
            .accessibilityHidden(true)
    }

    /// The "‹ slide to cancel" hint — translates with the drag and fades toward
    /// 0 as the cancel threshold is approached. Once the take is actually in
    /// the cancelling phase it flips to a solid danger "release to cancel" —
    /// still on the same held surface so the drag gesture stays mounted.
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
    /// threshold is approached.
    private func lockLane(lockProgress: Double, isCancelling: Bool) -> some View {
        VStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "chevron.up")
                .font(.system(size: Metrics.type.xs, weight: .bold))
                .foregroundColor(tokens.tx2)
            Image(systemName: "lock")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(lockGlyphColor(progress: lockProgress))
            mic
        }
        .frame(width: Metrics.spacing.spPx * 46)
        .padding(.vertical, Metrics.spacing.sp3)
        .background(tokens.raised.opacity(0.9), in: Capsule())
        .overlay(Capsule().stroke(tokens.borderSubtle, lineWidth: 1))
        .accessibilityIdentifier("voice-lock-lane")
    }

    private func lockGlyphColor(progress: Double) -> Color {
        // Fade tx3 → accentTx as the lock threshold is approached.
        let p = progress
        if p >= 1 { return tokens.accentTx }
        // Linear interpolation between the two token colours.
        return interpolate(from: tokens.tx3, to: tokens.accentTx, t: p)
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

    /// Colour-lerp — both args are token colours, no raw component math.
    private func interpolate(from a: Color, to b: Color, t: Double) -> Color {
        guard t > 0 else { return tokens.tx3 }
        guard t < 1 else { return tokens.accentTx }
        let uiA = UIColor(a), uiB = UIColor(b)
        var ra: CGFloat = 0; var ga: CGFloat = 0; var ba: CGFloat = 0; var aa: CGFloat = 0
        var rb: CGFloat = 0; var gb: CGFloat = 0; var bb: CGFloat = 0; var ab: CGFloat = 0
        uiA.getRed(&ra, green: &ga, blue: &ba, alpha: &aa)
        uiB.getRed(&rb, green: &gb, blue: &bb, alpha: &ab)
        let tt = CGFloat(t)
        return Color(
            .sRGB,
            red: ra + (rb - ra) * tt,
            green: ga + (gb - ga) * tt,
            blue: ba + (bb - ba) * tt,
            opacity: aa + (ab - aa) * tt
        )
    }

    // MARK: release

    /// Map the end of a hold to the machine. `VoiceGesture` owns every branch;
    /// we only pick the INPUT for the gesture that just ended.
    private func finishHoldRelease() {
        let heldMs = dragStart.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
        dragStart = nil
        switch recorder.phase {
        case .cancelling:
            // sliding left then release → discard.
            recorder.stop()
        case .recordingLocked:
            // already locked — release is a no-op; the bar owns the take now.
            break
        case .recordingHeld:
            if heldMs < Int(Waveform.Constants.tapHoldMs) {
                // A tap while held toggles ON → fingers-free locked bar.
                onTakeFrom(recorder.tapToggle())
            } else {
                // A hold + release → send.
                onTakeFrom(recorder.stop())
            }
        default:
            break
        }
    }

    private func onTakeFrom(_ take: VoiceRecorder.Take?) {
        if let take { onTake(take) }
    }
}

// MARK: - Surface C · Recording — locked

/// The hands-free locked surface: head row (record dot, timer, live waveform),
/// optional remaining-time line, and the discard / pause / send bar. Renders
/// while the machine is `.recordingLocked` or `.paused`. Tapping the surface
/// (away from a button) is the tap-toggle OFF — it stops and sends.
struct VoiceRecordingLockedView: View {
    @ObservedObject var recorder: VoiceRecorder
    let tokens: Tokens
    var onTake: (VoiceRecorder.Take) -> Void = { _ in }
    var onDiscarded: () -> Void = {}

    private let buttonSize = Metrics.type.chatHeaderBtn

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            // Head row: record dot + timer + live waveform (right-aligned).
            HStack(alignment: .center, spacing: Metrics.spacing.sp2) {
                VoiceRecordingHeldView.AccessoryDot(danger: tokens.danger)
                timer
                Spacer(minLength: Metrics.spacing.sp2)
                VoiceLiveWaveform(peaks: recorder.livePeaks, tokens: tokens)
                    .frame(maxWidth: .infinity)
            }

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
        .onTapGesture {
            // Tap-toggle OFF: a second tap stops and sends.
            onTakeFrom(recorder.tapToggle())
        }
        // One accessibility element for the surface; the bar's three buttons
        // remain separate interactive elements (they carry their own ids).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice-recording-locked")
    }

    private var remaining: Int {
        max(0, Waveform.Constants.maxDurationMs - recorder.durationMs)
    }

    private var timer: some View {
        Text(Waveform.formatClock(recorder.durationMs))
            .font(.manta(size: Metrics.type.body, weight: .semibold).monospacedDigit())
            .foregroundColor(tokens.tx1)
            .accessibilityHidden(true)
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

// MARK: - Dispatcher

/// Renders whichever surface the machine's `VoicePhase` asks for, and owns the
/// phase→VoiceOver announcements + haptic playback the machine requests. This
/// is the single surface ComposerView swaps in for the input box.
struct VoiceRecordingSurface: View {
    @ObservedObject var recorder: VoiceRecorder
    let isRTL: Bool
    var onTake: (VoiceRecorder.Take) -> Void = { _ in }

    private var tokens: Tokens { Tokens.scheme(environment) }
    @Environment(\.colorScheme) private var environment

    @State private var lastAnnounced: VoicePhase?

    var body: some View {
        // The shared BoxChrome glass — applied ONCE here so each surface uses
        // exactly the same modifier (no second glass recipe anywhere).
        Group {
            switch recorder.phase {
            case .recordingHeld, .cancelling:
                // `.cancelling` renders through the held surface too so its
                // drag gesture stays mounted (swapping it away mid-drag would
                // cancel the gesture and lose the release→discard).
                VoiceRecordingHeldView(recorder: recorder, isRTL: isRTL, tokens: tokens, onTake: onTake)
            case .recordingLocked, .paused:
                VoiceRecordingLockedView(recorder: recorder, tokens: tokens, onTake: onTake, onDiscarded: { announceDiscard() })
            default:
                EmptyView()
            }
        }
        .modifier(BoxChrome(cornerRadius: Metrics.radius.xl, stroke: tokens.borderSubtle, tint: tokens.panel.opacity(0.35)))
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

    private func announceDiscard() {
        UIAccessibility.post(notification: .announcement, argument: "Recording discarded")
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

extension VoiceRecordingHeldView {
    /// The pulsing record dot, shared with the locked surface's head row.
    struct AccessoryDot: View {
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
}
