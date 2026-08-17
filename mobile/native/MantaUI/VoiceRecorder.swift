import AVFoundation
import Combine
import Foundation

// ===========================================================================
// Voice capture (BET-1027) — the metering recorder built around the pure
// gesture machine (`VoiceGesture.swift`) and the shared waveform maths
// (`Waveform.swift`).
//
// The recording AND transcription live on the box (Groq via `voice:transcribe`)
// — the device's only job here is to capture the audio, sample its amplitude
// into the shared peak contract, and hand the bytes over, exactly as the
// desktop does. This file owns the capture + the mic permission gate + the
// amplitude metering; it does NOT transcribe.
//
// The mime is `audio/mp4`: iOS records AAC-in-.m4a via AVAudioRecorder, the
// only sane container on Apple platforms.
//
// This is the testable FOUNDATION for the sibling recording-UI and voice-notes
// tickets; it ships no UI of its own.
// ===========================================================================

@MainActor
final class VoiceRecorder: ObservableObject {

    /// The result of a finished take: the audio bytes, its (pause-excluded)
    /// duration in ms, and the stored waveform peaks (`0...255`, at most
    /// `VOICE_MAX_STORED_PEAKS`). Never bare bytes.
    struct Take {
        let data: Data
        let durationMs: Int
        let peaks: [UInt8]
    }

    /// The current gesture phase (the machine's own `VoicePhase`), so the
    /// recording UI can render held/locked/paused/cancelling surfaces.
    @Published private(set) var phase: VoicePhase = .idle

    /// The live meter tail — the last `VOICE_LIVE_WINDOW_BARS` linear samples,
    /// `0...1`. NOT renormalised (see `Waveform.normalizeForDisplay` doc — the
    /// live meter pins its ceiling at 1.0 on purpose).
    @Published private(set) var livePeaks: [Double] = []

    /// The stored peak set for the note — `downsamplePeaks` at
    /// `VOICE_MAX_STORED_PEAKS` (`0...255`, max per bucket, never mean).
    @Published private(set) var storedPeaks: [UInt8] = []

    /// Elapsed recording time in ms, with paused time excluded (decision #5).
    @Published private(set) var durationMs: Int = 0

    /// Whether capture is actively running (the take is live on the mic).
    var isRecording: Bool {
        phase == .recordingHeld || phase == .recordingLocked
    }

    /// The haptic the machine just asked the UI to play (arm / lock /
    /// cancelArmed / send). The recorder computes it from the machine's output
    /// but never plays it — the VIEW plays the haptic it describes, so the view
    /// chooses nothing on its own (BET-1028: "Fire the haptics the machine
    /// asks for; the view chooses no haptics itself"). Cleared by
    /// `consumeHaptic()` once fired.
    @Published private(set) var haptic: VoiceHaptic?

    /// Last non-phase error surfaced to the UI (e.g. a denied permission).
    @Published private(set) var lastError: String?

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var meterTimer: Timer?

    // Timekeeping (decision #5: paused time never counts toward the cap).
    private var segmentStart: Date?
    private var accumulatedMs: Int = 0

    // Peaks (one linear sample every VOICE_SAMPLE_INTERVAL_MS).
    private var peakBuf: [Double] = []
    private var lastLinearLevel: Double = 0

    // The cap auto-sends (decision #6); the take is parked here until stop().
    private var pendingTake: Take?

    // Guards: a stop arriving twice must not double-fire; pause must not double.
    private var stopRequested = false

    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?

    // MARK: - Permission

    /// Request mic permission the first time it is pressed. Returns true only
    /// when granted. Must be called before `start()`.
    func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }

    // MARK: - Capture lifecycle

    /// Begin capturing. Call `requestPermission()` first; start() is a no-op
    /// when a take is already in flight.
    func start() {
        guard phase == .idle else { return }

        // Recording starts on PRESS (decision #4); the machine arms the take.
        let (nextPhase, effect) = VoiceGesture.transition(
            currentPhase: phase, input: .press, elapsedMs: 0)
        phase = nextPhase
        publishHaptic(effect)
        beginCapture()
    }

    /// Begin the audio capture after the machine has armed a take. Shared by
    /// the press-start (`start()`) and the first tap of the tap-toggle path.
    private func beginCapture() {
        stopRequested = false
        pendingTake = nil
        accumulatedMs = 0
        segmentStart = Date()
        durationMs = 0
        peakBuf = []
        lastLinearLevel = 0

        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)

            let recorder = try AVAudioRecorder(url: fileURL, settings: settings)
            // Metering is REQUIRED for the waveform — no amplitude data otherwise.
            recorder.isMeteringEnabled = true
            self.recorder = recorder
            self.fileURL = fileURL
            recorder.record()

            observeSessionNotifications()
            startMetering()
        } catch {
            lastError = "Couldn't start recording"
            reset()
        }
    }

    /// End capturing and hand back the finished take. Returns `nil` for a
    /// too-short press (an accidental tap — silent, decision #7) or a
    /// cancelled/discarded take. The caller treats `nil` as "no speech", NOT
    /// an error.
    @discardableResult
    func stop() -> Take? {
        guard !stopRequested else { return nil }
        stopRequested = true
        defer { stopRequested = false }

        // The cap may have auto-sent mid-take (decision #6) — return that.
        if let take = pendingTake {
            pendingTake = nil
            reset()
            return take
        }

        let elapsed = currentElapsedMs()
        let (_next, effect) = VoiceGesture.transition(
            currentPhase: phase, input: .release, elapsedMs: elapsed)
        publishHaptic(effect)

        switch effect {
        case .send:
            return finalizeTake()
        default:
            // Too short (silent mis-tap) or cancelled/discarded.
            reset()
            return nil
        }
    }

    /// The shared tail of every send path: stop capture, deactivate the audio
    /// session, read the file, reset, and return the take. `nil` only when the
    /// file is empty/missing (treated as "no speech", not an error).
    private func finalizeTake() -> Take? {
        recorder?.stop()
        deactivateSession()
        guard let url = fileURL,
              let data = try? Data(contentsOf: url), !data.isEmpty else {
            reset()
            return nil
        }
        let take = Take(data: data, durationMs: currentElapsedMs(), peaks: storedPeaks)
        publishHaptic(.send)
        reset()
        return take
    }

    /// Feed a drag translation from the held surface to the machine (BET-1028
    /// slide-to-cancel / slide-up-to-lock). Only meaningful while the take is
    /// held or cancelling; locked takes ignore drags. Returns the effect so the
    /// view can play the haptic the machine asked for.
    @discardableResult
    func drag(dx: Double, dy: Double, isRTL: Bool = false) -> VoiceEffect {
        guard phase == .recordingHeld || phase == .cancelling else { return .none }
        let (next, effect) = VoiceGesture.transition(
            currentPhase: phase, input: .drag(dx: dx, dy: dy),
            elapsedMs: currentElapsedMs(), isRTL: isRTL)
        phase = next
        publishHaptic(effect)
        return effect
    }

    /// The tap-toggle path (decision #5): a tap ON starts a hands-free,
    /// finger-up take (→ `.recordingLocked`); a tap while a take is live sends
    /// it (toggle OFF). Feed the machine's `.tapToggle`; returns the finished
    /// take only when the tap ends the take.
    @discardableResult
    func tapToggle() -> Take? {
        if phase == .idle {
            // Tap #1: start a finger-up take into the held surface.
            let (next, effect) = VoiceGesture.transition(
                currentPhase: .idle, input: .tapToggle, elapsedMs: 0)
            phase = next
            publishHaptic(effect)
            beginCapture()
            return nil
        }
        let (next, effect) = VoiceGesture.transition(
            currentPhase: phase, input: .tapToggle, elapsedMs: currentElapsedMs())
        publishHaptic(effect)
        if next == .idle {
            // Tap #2: "a second tap stops" — stop and send.
            return finalizeTake()
        }
        phase = next
        return nil
    }

    /// Locked-bar send: feed the machine's `.tapSend` and return the take.
    @discardableResult
    func sendLockedTake() -> Take? {
        guard phase == .recordingLocked || phase == .paused else { return nil }
        let (next, effect) = VoiceGesture.transition(
            currentPhase: phase, input: .tapSend, elapsedMs: currentElapsedMs())
        publishHaptic(effect)
        guard next == .idle else { return nil }
        return finalizeTake()
    }

    /// Locked-bar discard: feed the machine's `.tapDiscard` and reset. Returns
    /// whether the take was actually discarded (false when no live take).
    @discardableResult
    func discardLockedTake() -> Bool {
        guard phase == .recordingLocked || phase == .paused else { return false }
        let (next, _effect) = VoiceGesture.transition(
            currentPhase: phase, input: .tapDiscard, elapsedMs: currentElapsedMs())
        guard next == .idle else { return false }
        reset()
        return true
    }

    /// Clear the published haptic after the view has played it, so a later
    /// identical haptic still fires its `.onChange`.
    func consumeHaptic() {
        haptic = nil
    }

    /// Pause an active locked take (the sibling locked-bar UI). Paused time is
    /// frozen out of the elapsed clock (decision #5).
    func pause() {
        guard phase == .recordingLocked else { return }
        let (nextPhase, _) = VoiceGesture.transition(
            currentPhase: phase, input: .tapPause, elapsedMs: currentElapsedMs())
        guard nextPhase == .paused else { return }
        accumulatedMs = currentElapsedMs()
        segmentStart = nil
        phase = .paused
    }

    /// Resume a paused take, re-basing the time origin so the paused interval
    /// never counts toward the cap.
    func resume() {
        guard phase == .paused else { return }
        let (nextPhase, _) = VoiceGesture.transition(
            currentPhase: phase, input: .tapResume, elapsedMs: currentElapsedMs())
        guard nextPhase == .recordingLocked else { return }
        segmentStart = Date()
        phase = .recordingLocked
    }

    /// Surface a transient error to the UI (caller supplies the reason). Does
    /// not alter the gesture phase — take state is owned by the machine.
    func fail(_ message: String) {
        lastError = message
    }

    /// Publish the machine's haptic intent (arm / lock / cancelArmed / send).
    /// The recorder never plays a haptic — the view does, from the value the
    /// machine produced.
    private func publishHaptic(_ effect: VoiceEffect) {
        switch effect {
        case .haptic(let h): haptic = h
        case .send: haptic = .send
        case .none, .discard: break
        }
    }

    // MARK: - Metering

    private func currentElapsedMs() -> Int {
        if let start = segmentStart {
            return accumulatedMs + Int(Date().timeIntervalSince(start) * 1000)
        }
        return accumulatedMs
    }

    private func startMetering() {
        meterTimer?.invalidate()
        let timer = Timer(timeInterval: Double(Waveform.Constants.sampleIntervalMs) / 1000.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.meterTick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        meterTimer = timer
    }

    private func meterTick() {
        // Paused or idle: no accumulation (paused time never counts).
        guard segmentStart != nil else { return }
        updateMeters()
        let elapsed = currentElapsedMs()
        durationMs = elapsed
        appendPeak(lastLinearLevel)

        // Let the machine observe elapsed time so the hard cap auto-sends.
        let (_next, effect) = VoiceGesture.transition(
            currentPhase: phase, input: .tick, elapsedMs: elapsed)
        if effect == .send {
            autoFinishOnCap(elapsed: elapsed)
        }
    }

    private func updateMeters() {
        guard let recorder, recorder.isRecording else { return }
        recorder.updateMeters()
        let peakDB = Double(recorder.peakPower(forChannel: 0))
        lastLinearLevel = min(1, max(0, pow(10, peakDB / 20)))
    }

    private func appendPeak(_ level: Double) {
        peakBuf.append(level)
        livePeaks = Array(peakBuf.suffix(Waveform.Constants.liveWindowBars))
        storedPeaks = Waveform.downsamplePeaks(peakBuf, max: Waveform.Constants.maxStoredPeaks)
    }

    /// Decision #6: reaching the cap SENDS the take — it is parked so the next
    /// `stop()` hands it back; it is never discarded.
    private func autoFinishOnCap(elapsed: Int) {
        guard let url = fileURL,
              let data = try? Data(contentsOf: url), !data.isEmpty else {
            reset()
            return
        }
        pendingTake = Take(data: data, durationMs: elapsed, peaks: storedPeaks)
        reset()
    }

    // MARK: - Session interruption / route change

    private func observeSessionNotifications() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.handleInterruption() }
        }
        routeChangeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.handleInterruption() }
        }
    }

    /// A device interruption or route change ends the take through the
    /// machine's `interrupted` input (→ discard) — it is never transcribed.
    private func handleInterruption() {
        guard phase != .idle else { return }
        let (_next, _effect) = VoiceGesture.transition(
            currentPhase: phase, input: .interrupted, elapsedMs: currentElapsedMs())
        reset()
    }

    // MARK: - Teardown

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func reset() {
        meterTimer?.invalidate()
        meterTimer = nil
        if let obs = interruptionObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = routeChangeObserver { NotificationCenter.default.removeObserver(obs) }
        interruptionObserver = nil
        routeChangeObserver = nil
        recorder?.stop()
        recorder = nil
        if let url = fileURL { try? FileManager.default.removeItem(at: url) }
        fileURL = nil
        segmentStart = nil
        accumulatedMs = 0
        durationMs = 0
        peakBuf = []
        livePeaks = []
        storedPeaks = []
        lastLinearLevel = 0
        haptic = nil
        phase = .idle
    }
}
