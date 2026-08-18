import Foundation

// Split out of MantaAPIClient.swift so the Foundation-only MantaStreamModels
// (which throws these errors) can compile on Linux — MantaAPIClient itself
// needs FoundationNetworking and stays out of the SwiftPM package.

enum MantaError: Error, Equatable {
    case authRequired
    case server(String)
    case transport(String)
    /// A voice clip was stored but its transcription failed (HTTP 409). The
    /// recorder must be KEPT — the caller surfaces a Retry against the id.
    case storedButUntranscribed(noteID: String)
}
