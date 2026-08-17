import AVFoundation
import SwiftUI

// ===========================================================================
// VoiceNotePlayer.swift — the voice-note player + row (BET-1029).
//
// The transcript is a `UICollectionView` (MessagingUI `TiledView`) that
// recycles cells, so a player OWNED by a row would be destroyed the moment the
// row scrolls out of view — cutting playback mid-sentence. Playback is
// therefore owned ABOVE the list: one `VoicePlaybackEngine` per conversation,
// injected into the transcript via `Environment` and read by each row
// (`VoiceNotePlayerRow` via `@EnvironmentObject`). The same rule as desktop's
// `VoiceNote.tsx` (engine in `VoicePlaybackProvider`, not the row).
//
// The engine holds ONE `AVAudioPlayer`, fetches a clip lazily on first play and
// caches it per note id; only one note plays at a time.
//
// An expired note (audio swept on its TTL while transcript + peaks survive)
// renders honestly: a dimmed, dashed, non-interactive shape with a
// "· expired" suffix — never a play button that does nothing. Mirrors
// `VoiceNote.tsx` (`audioAvailable == false`).
// ===========================================================================

/// Conversation-scoped playback engine. One per open conversation, owned above
/// the transcript list so scrolling never interrupts playback and only one
/// note plays at a time.
@MainActor
final class VoicePlaybackEngine: ObservableObject {
    @Published private(set) var activeNoteID: String?
    @Published private(set) var isPlaying = false
    @Published private(set) var currentMs = 0

    private let api: MantaAPIClient
    private var player: AVAudioPlayer?
    private var ticker: Task<Void, Never>?
    private var audioCache: [String: Data] = [:]
    private var speed: Double = 1.0

    private static let speeds: [Double] = [1.0, 1.25, 1.5, 2.0]

    init(api: MantaAPIClient) {
        self.api = api
    }

    deinit {
        ticker?.cancel()
    }

    // MARK: - Row-facing state

    /// Whether this note is the one currently loaded.
    func isCurrent(_ note: VoiceNote) -> Bool { activeNoteID == note.id }

    /// The played fraction `0...1` for the active note; nil when another (or no)
    /// note is loaded (every bar renders neutral).
    func progress(note: VoiceNote) -> Double? {
        guard activeNoteID == note.id, note.durationMs > 0 else { return nil }
        return min(1, Double(currentMs) / Double(note.durationMs))
    }

    /// The clock to show: REMAINING while the note is loaded/playing, total
    /// when idle.
    func clockMs(note: VoiceNote) -> Int {
        guard activeNoteID == note.id else { return note.durationMs }
        return max(0, note.durationMs - currentMs)
    }

    /// The speed chip label ("1×", "1.25×", …).
    func speedLabel() -> String { "\(String(format: "%g", speed))×" }

    // MARK: - Actions

    /// Play/pause the given note. A tap on the active playing note pauses it;
    /// any other note is fetched (if needed) and starts playing.
    func toggle(_ note: VoiceNote) async {
        if activeNoteID == note.id, isPlaying {
            pause()
            return
        }
        await play(note)
    }

    /// Seek to a played fraction `0...1` (the waveform is tappable).
    func seek(note: VoiceNote, fraction: Double) {
        guard activeNoteID == note.id, let player else { return }
        let t = player.duration * Double(fraction)
        player.currentTime = t
        currentMs = Int(t * 1000)
    }

    /// Cycle the playback rate for the loaded clip.
    func cycleSpeed() {
        let index = VoicePlaybackEngine.speeds.firstIndex(of: speed) ?? 0
        speed = VoicePlaybackEngine.speeds[(index + 1) % VoicePlaybackEngine.speeds.count]
        if let player { player.rate = Float(speed) }
    }

    /// Re-run transcription for a stored-but-untranscribed note; returns the
    /// refreshed note (with its transcript) when the retry succeeded.
    func retry(_ noteID: String) async -> VoiceNote? {
        try? await api.retryVoiceNote(id: noteID)
    }

    // MARK: - Playback plumbing

    private func play(_ note: VoiceNote) async {
        stopCurrent()
        activeNoteID = note.id

        let data: Data
        if let cached = audioCache[note.id] {
            data = cached
        } else {
            do {
                data = try await api.voiceNoteAudio(id: note.id)
                audioCache[note.id] = data
            } catch {
                activeNoteID = nil
                return
            }
        }

        do {
            let player = try AVAudioPlayer(data: data)
            player.enableRate = true
            player.rate = Float(speed)
            self.player = player
            player.prepareToPlay()
            player.play()
            isPlaying = true
            currentMs = 0
            startTicker(note: note)
        } catch {
            activeNoteID = nil
            isPlaying = false
        }
    }

    private func startTicker(note: VoiceNote) {
        ticker?.cancel()
        ticker = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard let self, let player = self.player, !Task.isCancelled else { return }
                if player.isPlaying {
                    self.currentMs = Int(player.currentTime * 1000)
                } else if self.isPlaying {
                    // Natural completion (or a route interruption ended it).
                    self.currentMs = note.durationMs
                    self.stopCurrent()
                }
            }
        }
    }

    private func pause() {
        player?.pause()
        isPlaying = false
    }

    private func stopCurrent() {
        ticker?.cancel()
        ticker = nil
        player?.stop()
        player = nil
        isPlaying = false
        currentMs = 0
    }
}

// MARK: - Voice-bars waveform

/// The one width-derived bar-row view, shared by the stored/playback waveform
/// and the LIVE meter. Bars are `2px` wide with `2px` gaps; the bar COUNT is
/// derived from the available width via `GeometryReader` and the peaks are
/// bucketed down to it with the shared `Waveform.bucketPeaks`. The `Style`
/// expresses the two callers' differences (see `Style` below); everything
/// else — the width-derived bar count, `barWidth`, `barGap`, `maxHeight`,
/// `barHeight`, the `RoundedRectangle` radius — is identical for both.
struct VoiceBarsView: View {
    enum Style {
        /// A finished note: peaks are normalised so the loudest bar is full
        /// height, bars run leading→trailing, and `progress` colours the played
        /// prefix `accentTx` against `tx4`.
        case stored
        /// The live meter: NOT normalised (the ceiling is pinned at 1.0 on
        /// purpose — see `Waveform.normalizeForDisplay`), newest sample at the
        /// TRAILING edge, every bar `accentTx` at 0.9 opacity.
        case live
    }

    let peaks: [UInt8]
    let progress: Double?
    let tokens: Tokens
    let style: Style
    let onSeek: ((Double) -> Void)?

    private var maxHeight: CGFloat { Metrics.spacing.sp5 + Metrics.spacing.spPx * 2 }
    private var barWidth: CGFloat { Metrics.spacing.spPx * 2 }
    private var barGap: CGFloat { Metrics.spacing.spPx * 2 }

    var body: some View {
        GeometryReader { geo in
            let slot = barWidth + barGap
            let barCount = max(1, Int(geo.size.width / slot))
            let bucketed = Waveform.bucketPeaks(peaks, bars: barCount)
            let values = style == .stored ? Waveform.normalizeForDisplay(bucketed) : bucketed
            let alignment: Alignment = style == .stored ? .leading : .trailing
            HStack(alignment: .center, spacing: barGap) {
                ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                    let played = index < barCount && (progress ?? 0) > Double(index) / Double(barCount)
                    RoundedRectangle(cornerRadius: Metrics.radius.xs, style: .continuous)
                        .fill(fillStyle(played: played))
                        .frame(width: barWidth, height: barHeight(value))
                }
                if values.isEmpty {
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
            .contentShape(Rectangle())
            .gesture(onSeek.map { _ in tapSeek(width: geo.size.width) })
        }
        .frame(height: maxHeight)
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }

    private func fillStyle(played: Bool) -> Color {
        switch style {
        case .stored:
            return played ? tokens.accentTx : tokens.tx4
        case .live:
            return tokens.accentTx.opacity(0.9)
        }
    }

    private func barHeight(_ value: Double) -> CGFloat {
        let base = barWidth
        return max(base, min(maxHeight, base + value * (maxHeight - base)))
    }

    private func tapSeek(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onEnded { value in
                guard width > 0, let onSeek else { return }
                onSeek(min(1, max(0, value.location.x / width)))
            }
    }
}

// MARK: - The row

/// The voice-note player row, rendered directly under the user band it belongs
/// to. Reads playback progress from the conversation-scoped engine.
struct VoiceNotePlayerRow: View {
    let note: VoiceNote
    let tokens: Tokens
    @EnvironmentObject private var player: VoicePlaybackEngine

    var body: some View {
        if note.audioAvailable {
            readyRow
        } else {
            expiredRow
        }
    }

    private var discDiameter: CGFloat { Metrics.spacing.sp6 + Metrics.spacing.sp1 }

    /// The playable row: disc toggle, waveform, clock, speed chip.
    private var readyRow: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Button {
                Task { await player.toggle(note) }
            } label: {
                Image(systemName: (player.isCurrent(note) && player.isPlaying) ? "pause.fill" : "play.fill")
                    .font(.system(size: Metrics.type.twoXS, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.onAccent)
                    .frame(width: discDiameter, height: discDiameter)
                    .background(tokens.accentSolid, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Voice note, \(Waveform.formatClock(note.durationMs))")

            VoiceBarsView(
                peaks: note.peaks,
                progress: player.progress(note: note),
                tokens: tokens,
                style: .stored,
                onSeek: { player.seek(note: note, fraction: $0) }
            )

            Text(Waveform.formatClock(player.clockMs(note: note)))
                .font(.manta(size: Metrics.type.twoXS, weight: mantaFontWeight(Metrics.type.semibold)))
                .foregroundColor(tokens.tx4)
                .monospacedDigit()

            Button {
                player.cycleSpeed()
            } label: {
                Text(player.speedLabel())
                    .font(.manta(size: Metrics.type.twoXS, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.accentTx)
                    .padding(.vertical, Metrics.spacing.sp1)
                    .padding(.horizontal, Metrics.spacing.sp1)
                    .background(tokens.accentSoft, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Playback speed")
        }
        .padding(.vertical, Metrics.spacing.sp2)
        .padding(.horizontal, Metrics.spacing.sp3)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice-note")
    }

    /// The swept (expired) row: dimmed, dashed, no play button, not interactive.
    private var expiredRow: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Circle()
                .fill(tokens.borderSubtle)
                .frame(width: discDiameter, height: discDiameter)

            VoiceBarsView(peaks: note.peaks, progress: nil, tokens: tokens, style: .stored, onSeek: nil)

            Text("\(Waveform.formatClock(note.durationMs)) · expired")
                .font(.manta(size: Metrics.type.twoXS, weight: mantaFontWeight(Metrics.type.semibold)))
                .foregroundColor(tokens.tx4)
                .monospacedDigit()
        }
        .padding(.vertical, Metrics.spacing.sp2)
        .padding(.horizontal, Metrics.spacing.sp3)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle,
                        style: StrokeStyle(lineWidth: Metrics.spacing.spPx,
                                           dash: [Metrics.spacing.sp2, Metrics.spacing.sp2]))
        }
        .opacity(0.45)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Voice note, expired")
        .accessibilityIdentifier("voice-note")
    }
}

// MARK: - Pending voice-note row

/// The not-yet-real row shown in the composer while a take uploads +
/// transcribes, and the Retry affordance when transcription failed (the 409
/// path). The recording is KEPT — a stored-but-untranscribed note is offered a
/// Retry, never discarded (BET-1029 decision #3).
struct VoiceNotePendingRow: View {
    let peaks: [UInt8]
    let durationMs: Int
    /// Non-nil once the upload resolved to a stored-but-untranscribed note —
    /// surfaces a Retry against its id.
    let error: String?
    let tokens: Tokens
    let onRetry: (() -> Void)?

    private var discDiameter: CGFloat { Metrics.spacing.sp6 + Metrics.spacing.sp1 }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            HStack(spacing: Metrics.spacing.sp2) {
                Circle()
                    .fill(tokens.borderStrong)
                    .frame(width: discDiameter, height: discDiameter)

                VoiceBarsView(peaks: peaks, progress: nil, tokens: tokens, style: .stored, onSeek: nil)

                Text(Waveform.formatClock(durationMs))
                    .font(.manta(size: Metrics.type.twoXS, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx4)
                    .monospacedDigit()
            }
            .opacity(0.6)

            if let error {
                HStack(spacing: Metrics.spacing.sp2) {
                    Text(error)
                        .font(.manta(size: Metrics.type.xs, design: .monospaced))
                        .foregroundColor(tokens.danger)
                    if let onRetry {
                        Button(action: onRetry) {
                            Text("Retry")
                                .font(.manta(size: Metrics.type.twoXS, weight: mantaFontWeight(Metrics.type.semibold)))
                                .foregroundColor(tokens.tx2)
                                .padding(.vertical, Metrics.spacing.sp1)
                                .padding(.horizontal, Metrics.spacing.sp2)
                                .background(tokens.inset, in: Capsule())
                                .overlay {
                                    Capsule().stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Retry transcription")
                    }
                }
            } else {
                HStack(spacing: Metrics.spacing.sp1) {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(tokens.accentTx)
                    Text("transcribing…")
                        .font(.manta(size: Metrics.type.xs, design: .monospaced))
                        .foregroundColor(tokens.accentTx)
                }
            }
        }
        .padding(.vertical, Metrics.spacing.sp2)
        .padding(.horizontal, Metrics.spacing.sp3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        }
    }
}

// MARK: - Capture-harness scene

/// Harness-only capture scene (BET-1050), elected via `MANTA_SCENE=voice-note-
/// stored` — never rendered in normal app use. Shows the real
/// `VoiceNotePlayerRow` for a finished note, i.e. the `.stored` waveform path
/// (normalised, leading-aligned, seekable via `onSeek`), evidenced on-device
/// with no live box.
struct VoiceNoteStoredCaptureScene: View {
    @StateObject private var engine: VoicePlaybackEngine

    init() {
        _engine = StateObject(wrappedValue: VoicePlaybackEngine(
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!)))
    }

    @Environment(\.colorScheme) private var colorScheme
    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    /// A finished note whose peaks spell a normalised stored waveform.
    private var note: VoiceNote {
        VoiceNote(
            id: "fixture-n1",
            sessionId: "s1",
            transcript: "This is a finished voice note rendered from stored peaks.",
            mime: "audio/mp4",
            durationMs: 12800,
            peaks: fixturePeaks,
            createdAt: 0,
            expiresAt: nil,
            audioAvailable: true
        )
    }

    /// Deterministic stored peaks (`0...255`) shaped like a waveform.
    private var fixturePeaks: [UInt8] {
        var out = [UInt8]()
        out.reserveCapacity(Waveform.Constants.maxStoredPeaks)
        for i in 0..<Waveform.Constants.maxStoredPeaks {
            let phase = Double(i) / Double(Waveform.Constants.maxStoredPeaks) * .pi * 4
            let envelope = 0.3 + 0.7 * abs(sin(phase))
            out.append(Waveform.quantizePeak(envelope))
        }
        return out
    }

    var body: some View {
        tokens.canvas
            .ignoresSafeArea()
            .overlay(alignment: .bottom) {
                VoiceNotePlayerRow(note: note, tokens: tokens)
                    .environmentObject(engine)
                    .padding(Metrics.spacing.sp3)
                    .padding(.bottom, Metrics.spacing.sp6)
            }
    }
}
