import Foundation

// ===========================================================================
// C3 — composer insertion, pure half (WS03).
//
// What the composer's text/attachments become when another feature (quote,
// "send failures to the agent", "edit last", attach artifact, a new-session
// draft) puts something into it. Foundation-only so it runs under `verify.sh`;
// `ComposerTextController` is the observable wrapper that owns the draft.
// ===========================================================================

enum ComposerInsertMode: Equatable, Sendable {
    /// Existing draft + one blank line + text (just the text when the draft is blank).
    case append
    /// The whole draft becomes the text.
    case replace
    /// The raw selection is turned into a one-line blockquote and PREPENDED.
    case quote
}

enum ComposerInsertion {
    /// The new draft, or nil when the insertion is rejected (blank input, or the
    /// quote builder found nothing usable). `quoteBlock` is injected so this file
    /// stays Foundation-only; the controller passes `QuoteText.buildQuoteBlock`.
    static func insert(
        _ text: String,
        into draft: String,
        mode: ComposerInsertMode,
        quoteBlock: (String) -> String?
    ) -> String? {
        switch mode {
        case .append:
            guard !isBlank(text) else { return nil }
            return HandoffComposerCarry.appendBelow(draft, text)
        case .replace:
            guard !isBlank(text) else { return nil }
            return text
        case .quote:
            guard let block = quoteBlock(text) else { return nil }
            return block + draft
        }
    }

    enum AttachRejection: Equatable, Sendable {
        case notAbsolute
        case duplicate
        case readOnly
    }

    /// nil = the attachment may be added.
    static func checkAttach(
        remotePath: String,
        existing: [ComposerAttachment],
        acceptsInput: Bool
    ) -> AttachRejection? {
        guard acceptsInput else { return .readOnly }
        guard remotePath.hasPrefix("/") else { return .notAbsolute }
        if existing.contains(where: { $0.remotePath == remotePath }) { return .duplicate }
        return nil
    }

    /// A READY chip (its `remotePath` is set, so it goes straight through Send).
    static func makeChip(remotePath: String, displayName: String, mime: String) -> ComposerAttachment {
        ComposerAttachment(
            filename: displayName,
            mime: mime,
            remotePath: remotePath,
            isImage: mime.hasPrefix("image/")
        )
    }

    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
