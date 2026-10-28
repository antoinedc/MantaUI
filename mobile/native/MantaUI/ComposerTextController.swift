import SwiftUI
import Combine

// ===========================================================================
// C3 — the composer's text + attachment owner, and the one API other features
// use to put something into it (WS03).
//
// ChatScreen owns one per open chat (`@StateObject`) and binds ComposerView to
// `text` / `attachments`. Quote, "send failures to the agent", "edit last",
// attach-artifact and the new-session draft all go through `insert` / `attach` /
// `apply` instead of touching the draft directly.
//
// CONTRACT: `insert` and `attach` return `false` when they changed NOTHING
// (blank input, nothing quotable, read-only chat, relative path, duplicate).
// Every caller must surface that — never ignore the Bool. Suggested copy:
//   insert            → "Couldn't add that to the message"
//   attach .duplicate → "Already attached"
//   attach .readOnly  → "This chat is read-only"
//   attach .notAbsolute → "Couldn't attach that file"
// Pure rules live in `ComposerInsertion` (unit-tested under verify.sh).
// ===========================================================================

@MainActor
final class ComposerTextController: ObservableObject {
    @Published var text: String
    @Published var attachments: [ComposerAttachment]
    /// false only while the chat is a background job (kept in sync by the chat
    /// screen); `insert` / `attach` then return false. `.resolving` and
    /// `.allowed` both keep it true — typing and inserting stay possible while
    /// the session is being checked; sending is gated separately.
    @Published var acceptsInput = true
    /// Bumped on every successful insert/attach; ChatScreen focuses the field on change.
    @Published private(set) var focusRequest = 0
    /// Set by the seeding init when some draft attachments were rejected; the
    /// chat screen shows it once on appear (`consumeSeedNotice`).
    @Published private(set) var seedNotice: String?
    /// Why the last `attach` returned false (nil after a success) — for callers' copy.
    private(set) var lastAttachRejection: ComposerInsertion.AttachRejection?

    init(text: String = "", attachments: [ComposerAttachment] = [], draft: NewSessionDraft? = nil) {
        self.text = text
        self.attachments = attachments
        if let draft {
            let rejected = apply(draft)
            if rejected > 0 {
                seedNotice = rejected == 1
                    ? "1 attachment couldn't be carried over"
                    : "\(rejected) attachments couldn't be carried over"
            }
        }
    }

    /// The seeding notice, once: returns it and clears it.
    func consumeSeedNotice() -> String? {
        let notice = seedNotice
        seedNotice = nil
        return notice
    }

    @discardableResult
    func insert(text newText: String, mode: ComposerInsertMode) -> Bool {
        guard acceptsInput else { return false }
        guard let updated = ComposerInsertion.insert(
            newText, into: text, mode: mode, quoteBlock: QuoteText.buildQuoteBlock
        ) else { return false }
        text = updated
        focusRequest += 1
        return true
    }

    /// Add an already-uploaded file as a READY chip (it is sent with the next Send).
    @discardableResult
    func attach(remotePath: String, displayName: String, mime: String?) -> Bool {
        if let rejection = ComposerInsertion.checkAttach(
            remotePath: remotePath, existing: attachments, acceptsInput: acceptsInput
        ) {
            lastAttachRejection = rejection
            return false
        }
        let pathName = (remotePath as NSString).lastPathComponent
        let name = displayName.isEmpty ? pathName : displayName
        let resolvedMime: String
        if let mime, !mime.isEmpty {
            resolvedMime = mime
        } else {
            let hasExtension = !(name as NSString).pathExtension.isEmpty
            resolvedMime = ChatVoice.mime(forFilename: hasExtension ? name : pathName)
        }
        attachments.append(ComposerInsertion.makeChip(remotePath: remotePath, displayName: name, mime: resolvedMime))
        lastAttachRejection = nil
        focusRequest += 1
        return true
    }

    // MARK: - New-session draft (F7)

    /// The current draft as a `NewSessionDraft`: its text plus the READY chips
    /// (an upload still in flight cannot follow). `worktreeBranch` and
    /// `linkedIssueURL` are left for the producer to set.
    func newSessionDraft(cwd: String?) -> NewSessionDraft {
        let ready = attachments.compactMap { chip -> NewSessionDraftAttachment? in
            guard let remotePath = chip.remotePath else { return nil }
            return NewSessionDraftAttachment(remotePath: remotePath, displayName: chip.filename, mime: chip.mime)
        }
        return NewSessionDraft(cwd: cwd, text: text, attachments: ready)
    }

    /// Put a draft into this composer: its text appended below whatever is
    /// already typed, each attachment through `attach` (so each is validated).
    /// Returns how many attachments were rejected. `cwd`, `worktreeBranch` and
    /// `linkedIssueURL` belong to the create sheet and are ignored here.
    @discardableResult
    func apply(_ draft: NewSessionDraft) -> Int {
        if !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            insert(text: draft.text, mode: .append)
        }
        var rejected = 0
        for attachment in draft.attachments {
            if !attach(remotePath: attachment.remotePath, displayName: attachment.displayName, mime: attachment.mime) {
                rejected += 1
            }
        }
        return rejected
    }
}

// MARK: - Environment

private struct ComposerControllerKey: EnvironmentKey {
    static let defaultValue: ComposerTextController? = nil
}

extension EnvironmentValues {
    /// The open chat's composer controller. nil on read-only surfaces (a subagent
    /// screen, previous-session view): callers render their insert/attach
    /// control only when this is non-nil — no dead controls.
    var composerController: ComposerTextController? {
        get { self[ComposerControllerKey.self] }
        set { self[ComposerControllerKey.self] = newValue }
    }
}
