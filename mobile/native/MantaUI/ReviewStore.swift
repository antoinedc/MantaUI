import Combine
import Foundation
import os

// ===========================================================================
// WS05 Feature D — the review screen's store. ONE read (`forge:diff`) returns the
// rows, the placed threads and the reconciled draft; every mutation reconciles
// the draft BY COMMENT ID (`ReviewDraftMerge`) and refetches only when that rule
// asks. A failed user action says why (the box's `message`) and keeps what the
// user typed.
// ===========================================================================

struct ReviewClient: Sendable {
    var diff: @Sendable (_ ref: GitRef) async throws -> GitDiffResult
    var draftComment: @Sendable (_ ref: GitRef, _ op: GitDraftOp) async throws -> GitDraftCommentResult
    var draftSubmit: @Sendable (_ ref: GitRef, _ verdict: GitVerdict?) async throws -> GitDraftSubmitResult
    var threadReply: @Sendable (_ ref: GitRef, _ threadId: String, _ body: String) async throws -> GitThreadReplyResult

    static func live(_ api: MantaAPIClient = MantaAPIClient.live()) -> ReviewClient {
        ReviewClient(
            diff: { try await api.forgeDiff($0) },
            draftComment: { try await api.forgeDraftComment($0, op: $1) },
            draftSubmit: { try await api.forgeDraftSubmit($0, verdict: $1) },
            threadReply: { try await api.forgeThreadReply($0, threadId: $1, body: $2) }
        )
    }
}

/// What the screen shows. Precedence, first match wins (the box's S.2 rule):
/// loading → error → parse failure → no diff → the diff. `boxTooOld` is a box
/// without the structured diff.
enum ReviewPhase: Equatable, Sendable {
    case loading
    case error(String)
    case parseFailed(String)
    case empty
    case boxTooOld
    case loaded
}

@MainActor
final class ReviewStore: ObservableObject {
    let target: GitRef

    @Published private(set) var phase: ReviewPhase = .loading
    @Published private(set) var files: [GitDiffFile] = []
    @Published private(set) var threads: [GitThread] = []
    @Published private(set) var draft: GitPlacedDraft?
    /// The forge did not answer: the diff shown is the last known.
    @Published private(set) var diffIsStale = false
    @Published private(set) var notes = ReviewNoteIndex(threads: [], draft: nil)
    @Published private(set) var submitting = false
    @Published private(set) var banner: GitBanner?
    /// Draft comments the user already put into the chat composer.
    @Published private(set) var sentToAgent: Set<String> = []

    private let client: ReviewClient
    private static let log = Logger(subsystem: "com.antoinedc.mantaui", category: "review")

    init(target: GitRef, client: ReviewClient = .live()) {
        self.target = target
        self.client = client
    }

    var pendingCount: Int { draft?.comments.count ?? 0 }

    /// The pending bar shows whenever there is a draft comment to publish.
    var showsPendingBar: Bool {
        switch phase {
        case .loaded, .parseFailed, .empty: return pendingCount > 0
        case .loading, .error, .boxTooOld: return false
        }
    }

    func clearBanner() { banner = nil }

    /// A confirmation or error the screen raises itself (e.g. "Added to your
    /// message").
    func post(_ banner: GitBanner) { self.banner = banner }

    // MARK: Load

    /// Initial load / Try again / pull to refresh. Content already on screen is
    /// kept while a refresh runs.
    func load() async {
        switch phase {
        case .error, .boxTooOld: phase = .loading
        case .loading, .parseFailed, .empty, .loaded: break
        }
        do {
            apply(try await client.diff(target))
        } catch {
            if case .loading = phase {
                phase = .error(GitForgeText.describe(error))
            } else {
                banner = .error(GitForgeText.describe(error))
            }
        }
    }

    /// The one refetch a draft merge may ask for. A failure is shown but never
    /// masks the action that triggered it.
    private func reload() async {
        do {
            apply(try await client.diff(target))
        } catch {
            banner = .error("Couldn't refresh the review. " + GitForgeText.describe(error))
        }
    }

    private func apply(_ result: GitDiffResult) {
        if let error = result.error {
            files = []
            threads = []
            draft = nil
            notes = ReviewNoteIndex(threads: [], draft: nil)
            phase = .error(result.message ?? error)
            return
        }
        guard let incoming = result.files else {
            phase = .boxTooOld
            return
        }
        files = incoming
        threads = result.threads
        draft = result.draft
        diffIsStale = result.stale
        rebuildNotes()
        if result.parseFailed {
            phase = .parseFailed(result.message ?? ReviewCopy.parseFailedTitle)
        } else if incoming.isEmpty {
            phase = .empty
        } else {
            phase = .loaded
        }
    }

    private func rebuildNotes() {
        notes = ReviewNoteIndex(threads: threads, draft: draft)
    }

    // MARK: Draft comments

    /// Add a line comment to the review. Returns the message to show when it
    /// failed (the sheet stays open with the user's text), nil on success.
    func addComment(anchor: GitAnchor, tapped: GitPlacement, body: String) async -> String? {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "Write a comment first." }
        do {
            let op = GitDraftOp.add(path: anchor.path, line: anchor.line, side: anchor.side, body: text)
            switch try await client.draftComment(target, op) {
            case .ok(let response):
                await reconcile(response, tapped: tapped)
                return nil
            case .failed(let failure):
                return failure.display
            }
        } catch {
            return GitForgeText.describe(error)
        }
    }

    /// Remove a draft comment. Failure → the box's message in the banner, the
    /// card stays.
    func removeComment(id: String) async {
        do {
            switch try await client.draftComment(target, .delete(id: id)) {
            case .ok(let response):
                sentToAgent.remove(id)
                await reconcile(response, tapped: nil)
            case .failed(let failure):
                banner = .error(failure.display)
            }
        } catch {
            banner = .error(GitForgeText.describe(error))
        }
    }

    /// Choose the verdict — optimistic, reverted with a message when it fails.
    func setVerdict(_ verdict: GitVerdict?) async {
        guard var current = draft, current.verdict != verdict else { return }
        let previous = current
        current.verdict = verdict
        draft = current
        do {
            switch try await client.draftComment(target, .setVerdict(verdict)) {
            case .ok(let response):
                await reconcile(response, tapped: nil)
            case .failed(let failure):
                draft = previous
                banner = .error(failure.display)
            }
        } catch {
            draft = previous
            banner = .error(GitForgeText.describe(error))
        }
    }

    private func reconcile(_ response: GitDraft?, tapped: GitPlacement?) async {
        let merged = ReviewDraftMerge.merge(previous: draft, response: response, tapped: tapped)
        draft = merged.draft
        rebuildNotes()
        if merged.needsRefetch { await reload() }
    }

    /// The comment text went into the chat's composer; remember it so the card
    /// says so.
    func markSentToAgent(id: String) {
        sentToAgent.insert(id)
    }

    // MARK: Submit + reply

    /// Publish the draft as ONE review.
    func submit() async {
        guard !submitting, pendingCount > 0 else { return }
        submitting = true
        defer { submitting = false }
        do {
            switch try await client.draftSubmit(target, draft?.verdict) {
            case .ok:
                draft = nil
                sentToAgent = []
                rebuildNotes()
                banner = .ok("Review submitted")
                await reload()
            case .failed(let failure):
                banner = .error(failure.display)
            }
        } catch {
            banner = .error(GitForgeText.describe(error))
        }
    }

    /// Reply to a thread (posts at once). Returns the message to show when it
    /// failed, nil on success (the diff is refetched for the fresh threads).
    func reply(threadId: String, body: String) async -> String? {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "Write a reply first." }
        do {
            switch try await client.threadReply(target, threadId, text) {
            case .ok:
                await reload()
                return nil
            case .failed(let failure):
                return failure.display
            }
        } catch {
            return GitForgeText.describe(error)
        }
    }
}
