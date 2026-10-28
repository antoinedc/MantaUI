import Foundation

// ===========================================================================
// Composer wire types + pure submission logic (WS03).
//
// Foundation-only on purpose so it compiles and is unit-tested under
// `verify.sh`. Holds:
//  * `ComposerAttachment` — the attachment chip (moved verbatim out of
//    ComposerView.swift so the settle logic below can be tested);
//  * the three wire types the composer decodes (`opencode:commands`,
//    `opencode:references`, `opencode:run-command`);
//  * `ComposerSubmission` / `ComposerSubmissionSettle` — what a submit snapshots
//    and how the draft is cleaned up once the box has ACCEPTED it. Nothing is
//    ever cleared before acceptance, and only what was actually submitted is
//    removed (a chip added, or text typed, while the request was in flight
//    survives).
// ===========================================================================

struct ComposerAttachment: Identifiable, Equatable {
    let id = UUID()
    let filename: String
    var mime: String
    /// Set once the upload completes; nil while the attachment is still being
    /// read + uploaded. A chip with a nil path renders a loading spinner.
    var remotePath: String?
    let isImage: Bool

    /// True until the upload finishes — the chip is a placeholder.
    var isUploading: Bool { remotePath == nil }
}

// MARK: - Wire types

/// One entry of `opencode:commands`: an opencode command or skill. Extra keys
/// (`agent`, `model`, `template`, …) are ignored.
struct OpencodeCommandInfo: Decodable, Equatable, Sendable {
    var name: String
    var description: String?
    /// `"command"` / `"project"` / `"global"` / `"skill"`.
    var source: String?
    var argumentHint: String?
    /// `true` = the command always runs in the background (F3).
    var background: Bool?

    var isSkill: Bool { source == "skill" }
}

/// One entry of `opencode:references` — a configured `@alias`.
struct OpencodeReferenceInfo: Decodable, Equatable, Sendable {
    var name: String
    var path: String?
    var repository: String?
    var branch: String?
    var description: String?
    var hidden: Bool?
}

/// The result of `opencode:run-command`: `{ jobId }` for a Manta-wrapped
/// background run, `null` (→ no value) for everything else. Decoding is
/// tolerant: a command accepted by the box must never read as a failure because
/// the body wasn't the object shape this expected.
struct RunCommandResult: Decodable, Equatable, Sendable {
    var jobId: String?

    init(jobId: String? = nil) {
        self.jobId = jobId
    }

    private enum CodingKeys: String, CodingKey { case jobId }

    init(from decoder: Decoder) throws {
        if let container = try? decoder.container(keyedBy: CodingKeys.self) {
            jobId = try? container.decode(String.self, forKey: .jobId)
        } else {
            jobId = nil
        }
    }
}

// MARK: - Typeahead rows

/// One row of the `@` popup (references, files, agents, or a status line).
struct MentionRow: Equatable, Identifiable, Sendable {
    enum Kind: Equatable, Sendable {
        case reference, file, agent
        /// A non-selectable status line ("Searching…"); `tappable` ones retry.
        case status(tappable: Bool)
    }

    let id: String
    let kind: Kind
    /// What follows the `@` when the row is chosen (an alias, a path, an agent name).
    let insertText: String
    let title: String
    let subtitle: String
    let systemImage: String

    init(id: String, kind: Kind, insertText: String, title: String, subtitle: String, systemImage: String = "doc") {
        self.id = id
        self.kind = kind
        self.insertText = insertText
        self.title = title
        self.subtitle = subtitle
        self.systemImage = systemImage
    }
}

/// The "Run in background" toggle's state for a typed `/command` (F3).
struct BackgroundToggleState: Equatable, Sendable {
    let name: String
    /// An always-background command: the toggle is on and cannot be turned off.
    let locked: Bool
}

// MARK: - Submission snapshot + settle

/// Snapshot taken synchronously at submit, before any await.
struct ComposerSubmission: Equatable, Sendable {
    /// The raw draft at submit.
    let text: String
    /// READY chips that were sent.
    let attachmentIDs: Set<UUID>
    let agentNames: [String]
    /// "Run in background" was on for this submit.
    var background: Bool = false
}

enum ComposerSubmissionSettle {
    /// After the box ACCEPTED a message/command: drop only the submitted chips;
    /// clear text + agent selections only if the draft is still exactly the
    /// submitted text.
    static func accepted(
        _ submission: ComposerSubmission,
        text: String,
        attachments: [ComposerAttachment],
        agentNames: [String]
    ) -> (text: String, attachments: [ComposerAttachment], agentNames: [String]) {
        let remaining = attachments.filter { !submission.attachmentIDs.contains($0.id) }
        if text == submission.text {
            return ("", remaining, [])
        }
        return (text, remaining, agentNames)
    }

    /// After a LOCAL built-in (/compact, /fork, confirmed /clear) was triggered:
    /// nothing was sent, so chips and agent selections are never touched; only
    /// the typed command text is consumed, and only if the draft is still
    /// exactly the submitted text.
    static func localAction(_ submission: ComposerSubmission, text: String) -> String {
        text == submission.text ? "" : text
    }
}

// MARK: - Error copy

enum ComposerErrorCopy {
    /// The text the box/transport gave, for a hint — never a raw `Error` dump.
    static func message(for error: Error) -> String {
        switch error {
        case MantaError.server(let message): return message
        case MantaError.transport(let message): return message
        case MantaError.authRequired: return "sign in again"
        default: return error.localizedDescription
        }
    }
}
