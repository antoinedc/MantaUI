import Foundation

// ===========================================================================
// VoiceNote.swift — the stored-voice-note model (BET-1029).
//
// Mirrors `VoiceNoteRecord` (src/shared/types.ts:2165-2177): a dictated clip
// stored on the box together with its transcript, duration, waveform peaks and
// TTL. The audio is swept on a TTL while the transcript + peaks are kept
// forever, which is why `audioAvailable` is a first-class field —
// `audioAvailable == false` renders a dimmed, non-interactive player.
//
// On the JSON wire the server stores `peaks` as a base64 string; decode that to
// `[UInt8]` at the boundary so components read the byte array directly (same
// convention as the desktop's `voiceListNotes` transport seam).
// ===========================================================================

struct VoiceNote: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let sessionId: String
    let transcript: String
    let mime: String
    let durationMs: Int
    /// Waveform peaks, `0...255`, at most `Waveform.Constants.maxStoredPeaks`.
    let peaks: [UInt8]
    /// Epoch milliseconds the note was recorded.
    let createdAt: Int
    /// Epoch milliseconds the audio expires (nil = never).
    let expiresAt: Int?
    let audioAvailable: Bool

    enum CodingKeys: String, CodingKey {
        case id, sessionId, transcript, mime, durationMs, peaks, createdAt, expiresAt, audioAvailable
    }

    init(id: String, sessionId: String, transcript: String, mime: String,
         durationMs: Int, peaks: [UInt8], createdAt: Int, expiresAt: Int?,
         audioAvailable: Bool) {
        self.id = id
        self.sessionId = sessionId
        self.transcript = transcript
        self.mime = mime
        self.durationMs = durationMs
        self.peaks = peaks
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.audioAvailable = audioAvailable
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        transcript = try c.decodeIfPresent(String.self, forKey: .transcript) ?? ""
        mime = try c.decodeIfPresent(String.self, forKey: .mime) ?? "audio/mp4"
        durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs) ?? 0
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
        expiresAt = try c.decodeIfPresent(Int.self, forKey: .expiresAt)
        audioAvailable = try c.decodeIfPresent(Bool.self, forKey: .audioAvailable) ?? true
        if let b64 = try c.decodeIfPresent(String.self, forKey: .peaks),
           let data = Data(base64Encoded: b64) {
            peaks = [UInt8](data)
        } else {
            peaks = []
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(transcript, forKey: .transcript)
        try c.encode(mime, forKey: .mime)
        try c.encode(durationMs, forKey: .durationMs)
        try c.encode(Data(peaks).base64EncodedString(), forKey: .peaks)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(expiresAt, forKey: .expiresAt)
        try c.encode(audioAvailable, forKey: .audioAvailable)
    }
}
