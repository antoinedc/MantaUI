import Foundation
import UniformTypeIdentifiers

// ===========================================================================
// S5 — voice pure logic (BET-597). The iOS client is dictation-only: hold the
// mic, release, the transcript is inserted at the caret. The only remaining
// device-side presentation job is attachment MIME detection (which extension →
// which `mime` tag to send to `POST /api/upload` + `opencode:prompt`), so the
// box can decide FilePart-vs-path the way the desktop does. All pure;
// unit-tested in MantaUITests.
// ===========================================================================

enum ChatVoice {

    // MARK: - Attachment MIME detection

    /// Resolve a file's MIME type from its extension via the system registry,
    /// defaulting to `application/octet-stream` for unknowns (a file with no
    /// declared type is still attachable — the box treats unknown mimes as
    /// plain-file block attachments).
    static func mime(forFilename filename: String) -> String {
        let ext = (filename as NSString).pathExtension
        guard !ext.isEmpty,
              let type = UTType(filenameExtension: ext.lowercased()),
              let mime = type.preferredMIMEType, !mime.isEmpty else {
            return "application/octet-stream"
        }
        return mime
    }

    /// The short textual label for a mic-attached file (chips row) — the
    /// basename, truncated to a bounded length for the chip.
    static func chipLabel(forFilename filename: String) -> String {
        let name = (filename as NSString).lastPathComponent
        return name.count <= 28 ? name : String(name.prefix(25)) + "…"
    }

    /// Best-effort MIME detection for a photo's bytes, so the box can decide
    /// FilePart-vs-path the way the desktop does (`image/*` → FilePart).
    /// Sniffs the leading magic bytes (JPEG / PNG); anything else defaults to
    /// `image/jpeg` (PhotosPicker hands back a re-encoded image the user
    /// picked; the exact codec is rarely observable without that sniff).
    static func mime(forImageData data: Data) -> String {
        let bytes = [UInt8](data.prefix(8))
        if bytes.count >= 3, bytes[0] == 0xFF, bytes[1] == 0xD8, bytes[2] == 0xFF {
            return "image/jpeg"
        }
        if bytes.count >= 8,
           bytes[0] == 0x89, bytes[1] == 0x50, bytes[2] == 0x4E, bytes[3] == 0x47,
           bytes[4] == 0x0D, bytes[5] == 0x0A, bytes[6] == 0x1A, bytes[7] == 0x0A {
            return "image/png"
        }
        return "image/jpeg"
    }
}
