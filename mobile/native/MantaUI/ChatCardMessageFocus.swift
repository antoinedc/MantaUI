import SwiftUI

// ===========================================================================
// WS02 F10 — the highlight of the message a `.message` route jumped to.
//
// `ChatSessionStore.focusedRowID` reaches the transcript cells through the
// environment (the cell's `body` is nonisolated and cannot hold a store). The
// cell draws it (mount M-02-1, `TranscriptRow.swift`).
// ===========================================================================

private struct TranscriptHighlightedRowIDKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    /// The id of the transcript row to highlight, or nil.
    var transcriptHighlightedRowID: String? {
        get { self[TranscriptHighlightedRowIDKey.self] }
        set { self[TranscriptHighlightedRowIDKey.self] = newValue }
    }
}
