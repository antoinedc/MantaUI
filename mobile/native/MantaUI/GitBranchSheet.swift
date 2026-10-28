import SwiftUI

// ===========================================================================
// WS05 Feature A — the branch / pull request sheet behind the chat's branch chip.
//
// No pull request yet → the ship gate (the box's `view.ship`: a sentence when
// there is nothing to ship, else the drafted title and a Create button). A pull
// request → its reviewers / threads / mergeability, Merge (the box's gate; asks to
// confirm and sends exactly the PR and head SHA shown when it was tapped), Review
// changes and Open on GitHub. The sheet cannot be closed while creating or merging.
// ===========================================================================

struct GitBranchSheet: View {
    @ObservedObject var store: GitForgeStore
    let cwd: String
    let sessionId: String
    let shipModel: OpencodeModelID?
    /// ChatScreen's ordinary branch (the forge branch is `store.state.branch`).
    let branchName: String
    /// nil in a read-only chat: the review screen offers no "Send to agent".
    let bridge: GitComposerBridge?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme
    /// The merge the user tapped, frozen: the dialog and the request are built
    /// from this value only.
    @State private var pendingMerge: GitMergeTarget?

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        NavigationStack {
            content
                // The merge outcome shows over BOTH states: after a merge the PR is
                // no longer open, so the sheet falls back to the ship view.
                .safeAreaInset(edge: .top) { mergeBanner }
                .navigationTitle(branchName)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            guard !store.isBusy else { return }
                            dismiss()
                        }
                        .disabled(store.isBusy)
                    }
                }
        }
        .interactiveDismissDisabled(store.isBusy)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { wantPreview() }
        .onDisappear { store.clearMergeMessage() }
        .onChange(of: store.state.branch) { _, _ in wantPreview() }
        .onChange(of: store.state.view?.ship.state) { _, _ in wantPreview() }
        .confirmationDialog(
            pendingMerge.map { "Merge #\($0.number) into \($0.base)?" } ?? "Merge?",
            isPresented: Binding(get: { pendingMerge != nil }, set: { if !$0 { pendingMerge = nil } }),
            titleVisibility: .visible,
            presenting: pendingMerge
        ) { target in
            Button("Merge") { Task { await store.merge(target) } }
            Button("Cancel", role: .cancel) { pendingMerge = nil }
        } message: { target in
            Text(target.title)
        }
    }

    @ViewBuilder
    private var mergeBanner: some View {
        if let message = store.mergeMessage {
            Label(message.text, systemImage: message.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .font(.manta(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(message.isError ? tokens.danger : tokens.ok)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Metrics.spacing.sp4)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(.bar)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }

    /// The draft title is only wanted in the no-PR / ready state.
    private func wantPreview() {
        guard store.state.pr == nil else { return }
        store.ensureShipPreview(model: shipModel, sessionId: sessionId)
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if let pr = store.state.pr, let view = store.state.view {
            prContent(pr, view)
        } else if let view = store.state.view {
            shipContent(view)
        } else {
            VStack(spacing: Metrics.spacing.sp2) {
                Text(ReviewCopy.updateBoxForPullRequests)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
                    .multilineTextAlignment(.center)
            }
            .padding(Metrics.spacing.sp4)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: Ship (no PR yet)

    @ViewBuilder
    private func shipContent(_ view: GitPullRequestView) -> some View {
        switch view.ship.state {
        case .ready:
            readyForm
        default:
            // detached / unknown / on-base / no-commits / anything new: the box's
            // sentence, and no action.
            List {
                Section {
                    VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                        Text(store.state.branch ?? branchName)
                            .font(.manta(size: Metrics.type.body, weight: .semibold))
                            .foregroundColor(tokens.tx1)
                        if let copy = view.ship.copy {
                            Text(copy)
                                .font(.manta(size: Metrics.type.small))
                                .foregroundColor(tokens.tx3)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
    }

    private var readyForm: some View {
        let head = store.state.branch ?? branchName
        var base = store.state.base ?? "—"
        var fileCount: Int?
        if case .ready(_, let preview) = store.shipPreview {
            base = preview.base.isEmpty ? base : preview.base
            fileCount = preview.fileCount
        }
        return List {
            Section {
                LabeledContent("From → To") { Text("\(head) → \(base)").lineLimit(2).multilineTextAlignment(.trailing) }
                if let fileCount {
                    LabeledContent("Changes", value: "\(fileCount) file\(fileCount == 1 ? "" : "s")")
                }
            }
            Section {
                titleRow
            } header: {
                Text("Title")
            } footer: {
                if case .loading = store.shipPreview { Text("Drafting title…") }
                if case .idle = store.shipPreview { Text("Drafting title…") }
            }
            Section {
                Button {
                    Task { await store.createPullRequest() }
                } label: {
                    HStack(spacing: Metrics.spacing.sp2) {
                        if store.shipBusy { ProgressView() }
                        Text(store.shipBusy ? "Creating…" : "Create pull request")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!store.shipPreview.canCreate(current: store.currentShipKey) || store.shipBusy)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            } footer: {
                Text("Pushes \(head) and opens a pull request into \(base). You can edit the title and description on GitHub.")
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private var titleRow: some View {
        switch store.shipPreview {
        case .ready(_, let preview):
            Text(preview.effectiveTitle)
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx1)
        case .failed(_, let message):
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text(message)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.danger)
                Button("Try again") { store.retryShipPreview() }
            }
        case .idle, .loading:
            Text("A drafted title for this pull request")
                .font(.manta(size: Metrics.type.body))
                .redacted(reason: .placeholder)
                .accessibilityLabel("Drafting title")
        }
    }

    // MARK: Pull request

    private func prContent(_ pr: GitPullRequest, _ view: GitPullRequestView) -> some View {
        List {
            if let number = store.justShipped {
                Section {
                    Label("Opened #\(number)", systemImage: "checkmark.circle.fill")
                        .foregroundColor(tokens.ok)
                }
            }
            Section {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    Text("#\(pr.number) \(pr.title)")
                        .font(.manta(size: Metrics.type.body, weight: .semibold))
                        .foregroundColor(tokens.tx1)
                        .lineLimit(2)
                    Text("\(pr.state) · \(pr.headRef) → \(pr.baseRef)")
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                }
            } footer: {
                if store.state.stale { Text("Showing last known state — GitHub didn't answer.") }
            }
            Section {
                LabeledContent("Reviewers", value: pr.reviewers.isEmpty ? "none" : pr.reviewers.joined(separator: ", "))
                LabeledContent("Unresolved threads", value: "\(pr.unresolvedThreads)")
                if let merge = view.merge {
                    LabeledContent("Mergeable") {
                        Text(merge.mergeable.text)
                            .foregroundColor(tint(merge.mergeable.tone))
                            .multilineTextAlignment(.trailing)
                    }
                }
            }
            Section {
                Button {
                    pendingMerge = store.mergeTarget()
                } label: {
                    HStack(spacing: Metrics.spacing.sp2) {
                        if store.mergeBusy { ProgressView() }
                        Text(store.mergeBusy ? "Merging…" : "Merge")
                    }
                }
                .disabled(store.mergeTarget() == nil || store.mergeBusy)
                NavigationLink {
                    ReviewScreen(
                        target: .cwd(cwd),
                        sessionId: sessionId,
                        title: "#\(pr.number) \(pr.title)",
                        prURL: pr.url,
                        onSendToAgent: bridge
                    )
                } label: {
                    Text("Review changes")
                }
                if let url = URL(string: pr.url), !pr.url.isEmpty {
                    Button { openURL(url) } label: {
                        Label("Open on GitHub", systemImage: "arrow.up.right")
                    }
                }
            } footer: {
                // iOS has no hover tooltips: the reason a disabled Merge is disabled is text.
                if let merge = view.merge, !merge.can, let reason = merge.reason {
                    Text("Can't merge yet: \(reason)")
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func tint(_ tone: GitTone) -> Color {
        switch tone {
        case .ok: return tokens.ok
        case .danger, .error: return tokens.danger
        case .warn, .running: return tokens.warn
        case .muted, .other: return tokens.tx4
        }
    }
}
