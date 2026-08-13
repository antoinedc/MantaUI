import Foundation
import UniformTypeIdentifiers

// ===========================================================================
// S5 — voice pure logic (BET-597).
//
// Two jobs, both device-side PRESENTATION of box-produced results (§17):
//   1. Interpret the box's `voice:classify-command` reply into a typed
//      `VoiceAction` the composer/router can dispatch. The classifier runs on
//      the box; this is only a faithful mapping of its wire reply.
//   2. Attachment MIME detection (which extension → which `mime` tag to send
//      to `POST /api/upload` + `opencode:prompt`), so the box can decide
//      FilePart-vs-path the way the desktop does.
// All pure; unit-tested in MantaUITests.
// ===========================================================================

/// The recorder's capture mode: dictate inserts transcribed text at the caret;
/// command routes it through the box classifier to perform an action.
enum VoiceMode: Equatable {
    case dictate
    case command
}

/// A typed voice command (the classifier's kinds, mapped to Swift). Undecided
/// / LLM-degraded input becomes `unknown`.
enum VoiceAction: Equatable {
    case submit(text: String)
    case append(text: String)
    case clear
    case compact
    case fork
    case abort
    case help
    case toggleTrust
    case allowOnce
    case allowAlways
    case reject
    case answer(choice: String)
    case model(query: String)
    case switchWindow(index: Int)
    case newSession
    case openSettings
    case unknown(transcript: String)
}

/// A human hint for a voice action the composer/store chose not to perform
/// (app-level or navigation actions out of the chat surface). Honest wording —
/// never a fabricated success.
enum ChatVoiceHint {
    static func text(for action: VoiceAction) -> String {
        switch action {
        case .clear: return "“Clear” isn't available in this chat yet"
        case .compact: return "Compacted to free context"
        case .fork: return "Forking isn't available in this chat yet"
        case .help: return "Try “submit…”, “abort”, or “answer…”"
        case .toggleTrust: return "Trust mode can't be toggled right now"
        case .newSession: return "New-session isn't available in this chat"
        case .openSettings: return "Settings isn't available in this chat"
        case .switchWindow: return "Switch-window isn't available in this chat"
        default: return "Done"
        }
    }
}

enum ChatVoice {

    /// Map the box's `voice:classify-command` reply onto a typed action.
    /// Kind is lowercased for the match; the current synonym for "submit on a
    /// relayed {kind,text}" is also tolerated.
    static func parse(_ r: VoiceClassifyResult) -> VoiceAction {
        switch r.kind?.lowercased() {
        case "submit": return .submit(text: r.text ?? "")
        case "append": return .append(text: r.text ?? "")
        case "clear": return .clear
        case "compact": return .compact
        case "fork": return .fork
        case "abort": return .abort
        case "help": return .help
        case "toggle-trust", "toggle_trust": return .toggleTrust
        case "allow-once", "allow_once": return .allowOnce
        case "allow-always", "allow_always": return .allowAlways
        case "reject": return .reject
        case "answer": return .answer(choice: r.choice ?? "")
        case "model": return .model(query: r.query ?? "")
        case "switch-window", "switch_window": return .switchWindow(index: r.index ?? 1)
        case "new-session", "new_session": return .newSession
        case "open-settings", "open_settings": return .openSettings
        default:
            return .unknown(transcript: r.transcript ?? r.text ?? "")
        }
    }

    /// The `answer` choice as a bare lowercase word (for "yes"/"no" cores);
    /// otherwise `nil` so the caller treats it as an option label / free text.
    static func choiceToken(_ choice: String) -> String? {
        switch choice.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "yes", "yep", "ok", "okay", "sure": return "yes"
        case "no", "nope", "nay": return "no"
        default: return nil
        }
    }

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
