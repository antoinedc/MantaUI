import AVFoundation
import Foundation

// ===========================================================================
// S5 — iOS voice capture (BET-597).
//
// A thin AVFoundation recorder. The recording, transcription AND command
// classification all live on the box (Groq via `voice:transcribe` /
// `voice:classify-command`) — the device's only job here is to capture the
// audio and hand the bytes over, exactly as the desktop does. This file owns
// the capture + the mic permission gate; it does NOT transcribe or classify.
//
// The mime is `audio/mp4`: iOS records AAC-in-.m4a via AVAudioRecorder, the
// only sane container on Apple platforms (matches the retired web client's
// `audio/mp4` fallback — the one thing Apple ships).
// ===========================================================================

@MainActor
final class VoiceRecorder: ObservableObject {

    enum Phase: Equatable {
        case idle
        case requesting       // waiting on mic permission / session start
        case recording
        case processing       // stop requested, bytes being handed to the box
        case error(String)
    }

    @Published private(set) var phase: Phase = .idle

    /// Min duration of a usable clip (seconds). Shorter presses are ignored
    /// as accidental taps, mirroring the desktop's too-short guard.
    static let minDuration: TimeInterval = 0.4
    static let maxDuration: TimeInterval = 60

    private var recorder: AVAudioRecorder?
    private var url: URL?
    private var startDate: Date?

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

    /// Begin capturing. Call `requestPermission()` first; start() is a no-op
    /// when recording is already in flight.
    func start() {
        guard phase != .recording else { return }
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
            recorder.isMeteringEnabled = false
            self.recorder = recorder
            self.url = fileURL
            self.startDate = Date()
            phase = .recording
            recorder.record(forDuration: Self.maxDuration)
        } catch {
            phase = .error("Couldn't start recording")
        }
    }

    /// Stop capturing and return the recorded bytes. `nil` when the clip was
    /// too short (accidental tap) or empty — the caller treats that as "no
    /// speech", NOT an error.
    func stop() -> Data? {
        let elapsed = startDate.map { Date().timeIntervalSince($0) } ?? 0
        recorder?.stop()
        deactivateSession()
        guard elapsed >= Self.minDuration else {
            discard()
            return nil
        }
        guard let url, let data = try? Data(contentsOf: url), !data.isEmpty else {
            discard()
            return nil
        }
        discard()
        phase = .idle
        return data
    }

    /// Cancel a capture (e.g. the user drags away before release).
    func cancel() {
        recorder?.stop()
        discard()
        deactivateSession()
        phase = .idle
    }

    /// Surface a transient error phase to the UI (caller supplies the reason).
    func fail(_ message: String) {
        phase = .error(message)
    }

    private func discard() {
        if let url { try? FileManager.default.removeItem(at: url) }
        recorder = nil
        url = nil
        startDate = nil
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
