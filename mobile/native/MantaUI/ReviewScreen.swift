import SwiftUI

// ===========================================================================
// WS05 Feature D — the review screen: a pull request's diff by file, the box's
// threads under their lines, your draft comments, line comments, replies, the
// verdict and Submit. Everything is the box's: the rows, the anchors and where
// each note belongs arrive in one `forge:diff` read (G10). The screen renders
// them and never re-derives a placement.
//
// "Send to agent" exists only with a `GitComposerBridge` — nil for a review opened
// from the inbox and in a read-only background-job chat.
// ===========================================================================

/// The line a comment is being written on.
struct ReviewCommentTarget: Identifiable, Equatable {
    var id: String { rowID }
    let rowID: String
    let anchor: GitAnchor
    let placement: GitPlacement
    let lineText: String
}

struct ReviewScreen: View {
    let target: GitRef
    /// The chat this review was opened from (nil for the inbox / standalone). Kept
    /// for call-site clarity; "Send to agent" is gated by `onSendToAgent`, not this.
    let sessionId: String?
    let title: String?
    let prURL: String?
    let onSendToAgent: GitComposerBridge?

    @StateObject private var store: ReviewStore
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme
    @State private var commentTarget: ReviewCommentTarget?
    @State private var replyTarget: GitThread?
    @State private var removalTarget: GitDraftComment?
    /// Files over 400 rows start collapsed; the ones the user opened.
    @State private var expandedFiles: Set<Int> = []

    private static let collapseThreshold = 400

    init(target: GitRef, sessionId: String?, title: String?, prURL: String?, onSendToAgent: GitComposerBridge?) {
        self.target = target
        self.sessionId = sessionId
        self.title = title
        self.prURL = prURL
        self.onSendToAgent = onSendToAgent
        _store = StateObject(wrappedValue: ReviewStore(target: target))
    }

    /// A review for the session's branch, resolved from the open sessions (C2
    /// `.review` route). No "Send to agent": there is no composer on this path.
    static func forSession(_ sessionID: String) -> some View {
        ReviewSessionResolver(sessionID: sessionID)
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }
    private var githubURL: URL? { prURL.flatMap { $0.isEmpty ? nil : URL(string: $0) } }

    var body: some View {
        content
            .navigationTitle("Review")
            .navigationSubtitle(title ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { menu }
            }
            .safeAreaInset(edge: .bottom) {
                if store.showsPendingBar { pendingBar }
            }
            .overlay(alignment: .top) { bannerView }
            .task { await store.load() }
            .sheet(item: $commentTarget) { line in
                ReviewCommentSheet(
                    line: line,
                    bridge: onSendToAgent,
                    onAdd: { text in await store.addComment(anchor: line.anchor, tapped: line.placement, body: text) },
                    onSent: { store.post(.ok("Added to your message — not sent yet")) }
                )
            }
            .sheet(item: $replyTarget) { thread in
                ReviewReplySheet(thread: thread) { text in
                    await store.reply(threadId: thread.id, body: text)
                }
            }
            .confirmationDialog(
                "Remove this comment?",
                isPresented: Binding(get: { removalTarget != nil }, set: { if !$0 { removalTarget = nil } }),
                titleVisibility: .visible,
                presenting: removalTarget
            ) { comment in
                Button("Remove comment", role: .destructive) { Task { await store.removeComment(id: comment.id) } }
                Button("Keep it", role: .cancel) { removalTarget = nil }
            } message: { comment in
                Text(comment.body)
            }
    }

    // MARK: Toolbar

    private var menu: some View {
        Menu {
            if let url = githubURL {
                Button { openURL(url) } label: { Label("Open on GitHub", systemImage: "arrow.up.right") }
            }
            Button { Task { await store.load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("More")
    }

    // MARK: States

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ProgressView("Loading diff…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .error(let message):
            stateMessage(message, actions: { retryButton })
        case .boxTooOld:
            stateMessage(ReviewCopy.updateBoxForReview, actions: { openOnGitHubButton })
        case .parseFailed(let message):
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                    staleNote
                    stateMessage(message, actions: {
                        retryButton
                        openOnGitHubButton
                    })
                    .frame(maxWidth: .infinity)
                    otherComments
                }
            }
            .refreshable { await store.load() }
        case .empty:
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                    staleNote
                    stateMessage("No diff.", actions: { EmptyView() })
                        .frame(maxWidth: .infinity)
                    otherComments
                }
            }
            .refreshable { await store.load() }
        case .loaded:
            diffBody
        }
    }

    private func stateMessage<Actions: View>(_ text: String, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(spacing: Metrics.spacing.sp3) {
            Text(text)
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx3)
                .multilineTextAlignment(.center)
            HStack(spacing: Metrics.spacing.sp2) { actions() }
        }
        .padding(Metrics.spacing.sp4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var retryButton: some View {
        Button("Try again") { Task { await store.load() } }
            .buttonStyle(.borderedProminent)
    }

    @ViewBuilder
    private var openOnGitHubButton: some View {
        if let url = githubURL {
            Button { openURL(url) } label: { Label("Open on GitHub", systemImage: "arrow.up.right") }
                .buttonStyle(.bordered)
        }
    }

    // MARK: Diff

    private var diffBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                staleNote
                otherComments
                ForEach(Array(store.files.enumerated()), id: \.offset) { fileIndex, file in
                    Section {
                        fileBody(file, fileIndex: fileIndex)
                    } header: {
                        fileHeader(file)
                    }
                }
            }
        }
        .refreshable { await store.load() }
    }

    /// The forge didn't answer the last read: what is shown is the last known diff.
    @ViewBuilder
    private var staleNote: some View {
        if store.diffIsStale {
            Text("Showing last known diff — GitHub didn't answer.")
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.tx4)
                .padding(Metrics.spacing.sp3)
        }
    }

    /// Notes the box could not place on a line ("Other comments").
    @ViewBuilder
    private var otherComments: some View {
        if store.notes.hasUnplaced {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text("Other comments")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx2)
                ForEach(store.notes.unplacedThreads) { threadCard($0) }
                ForEach(store.notes.unplacedDrafts) { draftCard($0) }
            }
            .padding(Metrics.spacing.sp3)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func fileHeader(_ file: GitDiffFile) -> some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Text(file.path)
                .font(.manta(size: Metrics.type.xs, weight: .semibold, design: .monospaced))
                .foregroundColor(tokens.tx2)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
            Text("+\(file.added) −\(file.removed)")
                .font(.manta(size: Metrics.type.xs, design: .monospaced))
                .foregroundColor(tokens.tx4)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.panel)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// The Section's content, emitted flat (no wrapping stack) so the enclosing
    /// `LazyVStack` builds rows lazily — a 3,000-line file is not built in one pass.
    @ViewBuilder
    private func fileBody(_ file: GitDiffFile, fileIndex: Int) -> some View {
        ForEach(store.notes.fileThreads[fileIndex] ?? []) { threadCard($0).padding(Metrics.spacing.sp3) }
        ForEach(store.notes.fileDrafts[fileIndex] ?? []) { draftCard($0).padding(Metrics.spacing.sp3) }
        if file.truncated {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text("Too large to show here (\(file.rowCount) lines)")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
                if let url = githubURL {
                    Button { openURL(url) } label: { Label("Open on GitHub", systemImage: "arrow.up.right") }
                        .buttonStyle(.bordered)
                }
            }
            .padding(Metrics.spacing.sp3)
        } else if file.rows.count > Self.collapseThreshold && !expandedFiles.contains(fileIndex) {
            Button {
                expandedFiles.insert(fileIndex)
            } label: {
                Text("Show \(file.rows.count) lines")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Metrics.spacing.sp3)
            }
            .buttonStyle(.bordered)
            .padding(Metrics.spacing.sp3)
        } else {
            ForEach(Array(file.rows.enumerated()), id: \.offset) { rowIndex, row in
                let rowID = ReviewNoteIndex.rowID(file: fileIndex, row: rowIndex)
                rowView(row, rowID: rowID, placement: .row(file: fileIndex, row: rowIndex))
                ForEach(store.notes.rowThreads[rowID] ?? []) { threadCard($0).padding(Metrics.spacing.sp3) }
                ForEach(store.notes.rowDrafts[rowID] ?? []) { draftCard($0).padding(Metrics.spacing.sp3) }
            }
        }
    }

    // MARK: Rows

    @ViewBuilder
    private func rowView(_ row: GitDiffRow, rowID: String, placement: GitPlacement) -> some View {
        if let anchor = row.anchor {
            Button {
                commentTarget = ReviewCommentTarget(rowID: rowID, anchor: anchor, placement: placement, lineText: row.text)
            } label: {
                rowBody(row)
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button {
                    commentTarget = ReviewCommentTarget(rowID: rowID, anchor: anchor, placement: placement, lineText: row.text)
                } label: {
                    Label("Comment on this line", systemImage: "text.bubble")
                }
            }
            .accessibilityLabel(rowAccessibility(row))
            .accessibilityHint("Comment on this line")
        } else {
            rowBody(row)
        }
    }

    private func rowBody(_ row: GitDiffRow) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Text(row.oldLine.map(String.init) ?? "")
                .frame(width: 34, alignment: .trailing)
            Text(row.newLine.map(String.init) ?? "")
                .frame(width: 34, alignment: .trailing)
            Text(marker(row.kind) + row.text)
                .padding(.leading, Metrics.spacing.sp2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.manta(size: Metrics.type.twoXS, design: .monospaced))
        .foregroundColor(row.kind == .hunk ? tokens.tx4 : tokens.tx2)
        .padding(.vertical, 1)
        .background(background(row.kind))
    }

    private func marker(_ kind: GitRowKind) -> String {
        switch kind {
        case .added: return "+ "
        case .removed: return "− "
        case .context: return "  "
        case .hunk, .other: return ""
        }
    }

    private func background(_ kind: GitRowKind) -> Color {
        switch kind {
        case .added: return tokens.ok.opacity(0.14)
        case .removed: return tokens.danger.opacity(0.14)
        case .hunk: return tokens.fill
        case .context, .other: return .clear
        }
    }

    private func rowAccessibility(_ row: GitDiffRow) -> String {
        switch row.kind {
        case .added: return "Added line \(row.newLine ?? 0): \(row.text)"
        case .removed: return "Removed line \(row.oldLine ?? 0): \(row.text)"
        case .context: return "Line \(row.newLine ?? 0): \(row.text)"
        case .hunk, .other: return row.text
        }
    }

    // MARK: Notes

    private func threadCard(_ thread: GitThread) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text(thread.attribution)
                .font(.manta(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(tokens.tx3)
            ForEach(Array(thread.comments.enumerated()), id: \.offset) { _, comment in
                VStack(alignment: .leading, spacing: 2) {
                    if !comment.author.isEmpty {
                        HStack(spacing: Metrics.spacing.sp2) {
                            Text(comment.author)
                                .font(.manta(size: Metrics.type.xs, weight: .semibold))
                            if let when = Self.relativeTime(comment.createdAt) {
                                Text(when).font(.manta(size: Metrics.type.xs)).foregroundColor(tokens.tx4)
                            }
                        }
                        .foregroundColor(tokens.tx2)
                    }
                    Text(comment.body)
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx1)
                        .textSelection(.enabled)
                }
            }
            Button("Reply") { replyTarget = thread }
                .font(.manta(size: Metrics.type.xs, weight: .semibold))
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(Metrics.spacing.sp3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Metrics.radius.md).fill(tokens.card))
        .overlay(RoundedRectangle(cornerRadius: Metrics.radius.md).stroke(tokens.borderSubtle, lineWidth: 1))
    }

    private func draftCard(_ comment: GitDraftComment) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text("You · draft")
                .font(.manta(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(tokens.accentTx)
            Text(comment.body)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx1)
                .textSelection(.enabled)
            if store.sentToAgent.contains(comment.id) {
                Text("↳ added to your message · not yet published")
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
            }
            if let failure = store.noteErrors[comment.id] {
                Text(failure)
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.danger)
            }
            HStack(spacing: Metrics.spacing.sp2) {
                if let bridge = onSendToAgent, !store.sentToAgent.contains(comment.id) {
                    Button("Send to agent") { send(comment, via: bridge) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
                Button("Remove", role: .destructive) { removalTarget = comment }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
            .font(.manta(size: Metrics.type.xs, weight: .semibold))
        }
        .padding(Metrics.spacing.sp3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Metrics.radius.md).fill(tokens.accentSoft.opacity(0.35)))
        .overlay(RoundedRectangle(cornerRadius: Metrics.radius.md).stroke(tokens.accent.opacity(0.4), lineWidth: 1))
        .contextMenu {
            Button(role: .destructive) { removalTarget = comment } label: {
                Label("Remove comment", systemImage: "trash")
            }
        }
    }

    private func send(_ comment: GitDraftComment, via bridge: GitComposerBridge) {
        let result = bridge.insert(comment.body)
        if let failure = result.failureMessage {
            store.post(.error(failure))
        } else {
            store.markSentToAgent(id: comment.id)
            store.post(.ok("Added to your message — not sent yet"))
        }
    }

    // Built once: a formatter per comment per render is wasted work on a long review.
    private static let isoFormatter = ISO8601DateFormatter()
    private static let relativeFormatter = RelativeDateTimeFormatter()

    private static func relativeTime(_ iso: String?) -> String? {
        guard let iso, let date = isoFormatter.date(from: iso) else { return nil }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    // MARK: Pending bar

    private var pendingBar: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            if store.draft?.stale == true {
                Label(ReviewCopy.staleDraftWarning, systemImage: "exclamationmark.triangle.fill")
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.warn)
            }
            Text("\(ReviewCopy.pendingLabel(store.pendingCount)) not yet published")
                .font(.manta(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(tokens.tx1)
            Picker("Verdict", selection: Binding<GitVerdict?>(
                get: { store.draft?.verdict },
                set: { verdict in Task { await store.setVerdict(verdict) } }
            )) {
                ForEach(GitVerdict.allCases) { verdict in
                    Text(verdict.title).tag(Optional(verdict))
                }
            }
            .pickerStyle(.segmented)
            Button {
                Task { await store.submit() }
            } label: {
                HStack(spacing: Metrics.spacing.sp2) {
                    if store.submitting { ProgressView() }
                    Text(store.submitting ? "Submitting…" : "Submit review")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(store.submitting)
        }
        .padding(Metrics.spacing.sp3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }

    // MARK: Banner

    @ViewBuilder
    private var bannerView: some View {
        if let banner = store.banner {
            Text(banner.text)
                .font(.manta(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(banner.isError ? tokens.danger : tokens.ok)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(Capsule().fill(tokens.card))
                .overlay(Capsule().stroke(tokens.borderSubtle, lineWidth: 1))
                .padding(.top, Metrics.spacing.sp2)
                .onTapGesture { store.clearBanner() }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Dismiss")
                .task(id: banner) {
                    guard !banner.isError else { return }
                    try? await Task.sleep(nanoseconds: 4_000_000_000)
                    if !Task.isCancelled { store.clearBanner() }
                }
        }
    }
}

// MARK: - Sheets

/// "Comment on this line": a draft comment, or straight to the chat's composer.
struct ReviewCommentSheet: View {
    let line: ReviewCommentTarget
    let bridge: GitComposerBridge?
    /// Add to the review; returns the message to show on failure (nil = added).
    let onAdd: (String) async -> String?
    let onSent: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var text = ""
    @State private var error: String?
    @State private var busy = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }
    private var blank: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(line.anchor.path):\(line.anchor.line)")
                        .font(.manta(size: Metrics.type.xs, weight: .semibold, design: .monospaced))
                        .foregroundColor(tokens.tx3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(line.lineText)
                        .font(.manta(size: Metrics.type.xs, design: .monospaced))
                        .foregroundColor(tokens.tx2)
                        .lineLimit(3)
                }
                .padding(Metrics.spacing.sp2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Metrics.radius.sm).fill(tokens.inset))

                TextEditor(text: $text)
                    .font(.manta(size: Metrics.type.body))
                    .frame(minHeight: 90)
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty {
                            Text("Comment on this line…")
                                .font(.manta(size: Metrics.type.body))
                                .foregroundColor(tokens.tx4)
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                    }

                if let error {
                    Text(error)
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.danger)
                }

                HStack(spacing: Metrics.spacing.sp2) {
                    if let bridge {
                        Button("Send to agent") { sendToAgent(bridge) }
                            .buttonStyle(.borderedProminent)
                            .disabled(blank || busy)
                    }
                    addButton
                }
                Spacer(minLength: 0)
            }
            .padding(Metrics.spacing.sp4)
            .navigationTitle("Comment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
            }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(busy)
    }

    /// "Add to review" — the only action when there is no composer to send to.
    @ViewBuilder
    private var addButton: some View {
        let button = Button {
            add()
        } label: {
            if busy { ProgressView() } else { Text("Add to review") }
        }
        .disabled(blank || busy)
        if bridge == nil {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }

    private func sendToAgent(_ bridge: GitComposerBridge) {
        let result = bridge.insert(text.trimmingCharacters(in: .whitespacesAndNewlines))
        if let failure = result.failureMessage {
            error = failure
        } else {
            onSent()
            dismiss()
        }
    }

    private func add() {
        busy = true
        error = nil
        Task {
            let failure = await onAdd(text)
            busy = false
            if let failure {
                error = failure
            } else {
                dismiss()
            }
        }
    }
}

/// "Reply" on a thread: posts at once.
struct ReviewReplySheet: View {
    let thread: GitThread
    /// Returns the message to show on failure (nil = posted).
    let onReply: (String) async -> String?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var text = ""
    @State private var error: String?
    @State private var busy = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }
    private var blank: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                Text(thread.attribution)
                    .font(.manta(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(tokens.tx3)
                TextEditor(text: $text)
                    .font(.manta(size: Metrics.type.body))
                    .frame(minHeight: 90)
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty {
                            Text("Reply…")
                                .font(.manta(size: Metrics.type.body))
                                .foregroundColor(tokens.tx4)
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                    }
                if let error {
                    Text(error)
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.danger)
                }
                Button {
                    reply()
                } label: {
                    if busy { ProgressView().frame(maxWidth: .infinity) } else { Text("Reply").frame(maxWidth: .infinity) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(blank || busy)
                Spacer(minLength: 0)
            }
            .padding(Metrics.spacing.sp4)
            .navigationTitle("Reply")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
            }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(busy)
    }

    private func reply() {
        busy = true
        error = nil
        Task {
            let failure = await onReply(text)
            busy = false
            if let failure {
                error = failure
            } else {
                dismiss()
            }
        }
    }
}

// MARK: - Session resolver

/// Resolves a session id to its working directory (C2 `.review`), or says the
/// session is gone.
private struct ReviewSessionResolver: View {
    let sessionID: String
    @EnvironmentObject private var sessionStore: SessionListStore

    var body: some View {
        if let cwd = GitSessionLookup.cwd(for: sessionID, in: sessionStore.projects) {
            ReviewScreen(target: .cwd(cwd), sessionId: sessionID, title: nil, prURL: nil, onSendToAgent: nil)
        } else {
            ContentUnavailableView(
                "That session is no longer open",
                systemImage: "questionmark.folder",
                description: Text("Open the pull request from its chat instead.")
            )
        }
    }
}
