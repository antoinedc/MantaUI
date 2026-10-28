import SwiftUI

// ===========================================================================
// WS05 Feature E — the work inbox sheet (opened from the session list's tray
// button): issues assigned to you, PRs awaiting your review, your PRs with red
// checks — most recent first, deduplicated by the box.
//
// A row opens an action dialog: Start a session (hands a prefilled draft to the
// create sheet — nothing is created until Create), Open review (PRs), Delegate in
// the background (asks which chat to run under) and Open on GitHub.
// ===========================================================================

private struct InboxReviewRoute: Hashable {
    let repoKey: String
    let number: Int
    let title: String
    let url: String
}

private struct InboxParentChoice: Identifiable {
    let item: WorkInboxItem
    let candidates: [WorkInboxSession]
    var id: String { item.id }
}

struct InboxWorkScreen: View {
    let onClose: () -> Void

    @StateObject private var store = InboxWorkStore()
    @EnvironmentObject private var navigator: MantaNavigator
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme
    @State private var query = ""
    @State private var path = NavigationPath()
    @State private var actionItem: WorkInboxItem?
    @State private var parentChoice: InboxParentChoice?
    @State private var connecting = false
    /// Ticks so the age column keeps moving.
    @State private var now = Date()
    /// Built once with the view (not in `body`, which would re-subscribe on every render).
    private let ageTicker = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    private var tokens: Tokens { Tokens.scheme(colorScheme) }
    private var visible: [WorkInboxItem] { WorkInbox.filter(store.items, query: query) }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("Inbox")
                .navigationBarTitleDisplayMode(.inline)
                .navigationSubtitle(subtitle)
                .searchable(text: $query, prompt: "Filter inbox…")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { onClose() }
                    }
                }
                .navigationDestination(for: InboxReviewRoute.self) { route in
                    ReviewScreen(
                        target: .pr(repoKey: route.repoKey, number: route.number),
                        sessionId: nil,
                        title: route.title,
                        prURL: route.url,
                        onSendToAgent: nil
                    )
                }
        }
        .task { await store.load() }
        .onReceive(ageTicker) { now = $0 }
        .overlay(alignment: .bottom) { feedback }
        .confirmationDialog(
            actionItem.map { "\($0.identifier ?? "") \($0.title)" } ?? "",
            isPresented: Binding(get: { actionItem != nil }, set: { if !$0 { actionItem = nil } }),
            titleVisibility: .visible,
            presenting: actionItem
        ) { item in
            actions(for: item)
            Button("Cancel", role: .cancel) { actionItem = nil }
        }
        .confirmationDialog(
            "Run under which session?",
            isPresented: Binding(get: { parentChoice != nil }, set: { if !$0 { parentChoice = nil } }),
            titleVisibility: .visible,
            presenting: parentChoice
        ) { choice in
            ForEach(choice.candidates, id: \.sessionID) { session in
                Button(session.name) { Task { await store.delegate(choice.item, under: session) } }
            }
            Button("Cancel", role: .cancel) { parentChoice = nil }
        }
        .sheet(isPresented: $connecting) {
            NavigationStack {
                GitHubDeviceSignInView(
                    onConnected: {
                        connecting = false
                        Task { await store.load() }
                    },
                    onCancel: { connecting = false }
                )
            }
        }
    }

    private var subtitle: String {
        store.phase == .loaded && !store.items.isEmpty ? "\(store.items.count)" : ""
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ProgressView("Loading inbox…").frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notConnected:
            message(WorkInbox.notConnectedMessage) {
                Button("Connect GitHub") { connecting = true }
                    .buttonStyle(.borderedProminent)
            }
        case .failed(let text):
            message(text) {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .loaded:
            if store.boxNeedsUpdate {
                message(WorkInbox.updateBoxMessage) { EmptyView() }
            } else if store.items.isEmpty {
                message(WorkInbox.emptyMessage) { EmptyView() }
            } else if visible.isEmpty {
                message(WorkInbox.noMatchMessage(query.trimmingCharacters(in: .whitespacesAndNewlines))) { EmptyView() }
            } else {
                list
            }
        }
    }

    private func message<Extra: View>(_ text: String, @ViewBuilder extra: () -> Extra) -> some View {
        VStack(spacing: Metrics.spacing.sp3) {
            Text(text)
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx3)
                .multilineTextAlignment(.center)
            extra()
        }
        .padding(Metrics.spacing.sp4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        List {
            if store.stale {
                Text("Showing the last known inbox — GitHub didn't answer.")
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
            }
            ForEach(visible) { item in
                Button { actionItem = item } label: { row(item) }
                    .buttonStyle(.plain)
                    .contextMenu { actions(for: item) }
            }
        }
        .listStyle(.plain)
        .refreshable { await store.load() }
    }

    private func row(_ item: WorkInboxItem) -> some View {
        HStack(alignment: .top, spacing: Metrics.spacing.sp3) {
            Image(systemName: symbol(item.tone))
                .foregroundColor(color(item.tone))
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(item.identifier ?? "") \(item.title)")
                    .font(.manta(size: Metrics.type.body))
                    .foregroundColor(tokens.tx1)
                    .lineLimit(2)
                if let secondary = item.secondary {
                    Text(secondary)
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Text(WorkInbox.formatAge(ms: item.updatedAt, now: now))
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.tx4)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows actions")
    }

    // Symbol AND colour: never colour alone.
    private func symbol(_ tone: GitTone) -> String {
        switch tone {
        case .danger, .error: return "xmark.circle.fill"
        case .warn, .running: return "eye.circle.fill"
        case .ok, .muted, .other: return "circle"
        }
    }

    private func color(_ tone: GitTone) -> Color {
        switch tone {
        case .danger, .error: return tokens.danger
        case .warn, .running: return tokens.warn
        case .ok: return tokens.ok
        case .muted, .other: return tokens.tx4
        }
    }

    // MARK: Actions

    @ViewBuilder
    private func actions(for item: WorkInboxItem) -> some View {
        Button("Start a session") { start(item) }
        if item.isPullRequest {
            Button("Open review") {
                path.append(InboxReviewRoute(
                    repoKey: item.repoKey, number: item.number,
                    title: "\(item.identifier ?? "") \(item.title)", url: item.url
                ))
            }
        }
        if item.localPath != nil, !store.chatSessions.isEmpty {
            Button("Delegate in background") { delegate(item) }
        }
        if let url = URL(string: item.url), !item.url.isEmpty {
            Button("Open on GitHub") { openURL(url) }
        }
    }

    private func start(_ item: WorkInboxItem) {
        guard let draft = store.startSessionDraft(for: item) else { return }
        // Don't close the inbox here: the session list dismisses it itself, waits for
        // the dismissal to finish, then presents the create sheet. Closing it first
        // makes it skip that wait and UIKit refuses the second presentation.
        navigator.startNewSession(draft)
    }

    private func delegate(_ item: WorkInboxItem) {
        let candidates = store.parentCandidates(for: item)
        guard !candidates.isEmpty else {
            store.actionError = "Open a chat session first — a background job nests under its parent session."
            return
        }
        // The action dialog is still dismissing; UIKit refuses a second presentation
        // until it has finished.
        Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            parentChoice = InboxParentChoice(item: item, candidates: candidates)
        }
    }

    // MARK: Feedback

    @ViewBuilder
    private var feedback: some View {
        if let text = store.actionError ?? store.actionNotice {
            let isError = store.actionError != nil
            Text(text)
                .font(.manta(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(isError ? tokens.danger : tokens.ok)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Metrics.spacing.sp4)
                .padding(.vertical, Metrics.spacing.sp3)
                .background(Capsule().fill(tokens.card))
                .overlay(Capsule().stroke(tokens.borderSubtle, lineWidth: 1))
                .padding(.bottom, Metrics.spacing.sp4)
                .onTapGesture {
                    store.actionError = nil
                    store.actionNotice = nil
                }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Dismiss")
                .task(id: text) {
                    guard !isError else { return }
                    try? await Task.sleep(nanoseconds: 4_000_000_000)
                    if !Task.isCancelled { store.actionNotice = nil }
                }
        }
    }
}
