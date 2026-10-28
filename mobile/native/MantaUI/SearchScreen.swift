import SwiftUI

// ===========================================================================
// WS06 — conversation search. A sheet that searches the full history of every
// chat on the box with ONE server query and renders the box's answer: the box
// resolves the scope, groups the hits and labels each group (server-first,
// D23/D24). This view builds no scope and composes no titles.
//
// Jump: tapping a hit closes the sheet, then opens that message through the
// app-wide router (`MantaNavigator.open(.message)`); the chat screen owns the
// scroll + highlight (WS02), the root handler opens another conversation (WS04).
// ===========================================================================

struct SearchScreen: View {
    let primarySessionId: String?
    let seed: String

    @StateObject private var store: SearchStore
    @EnvironmentObject private var navigator: MantaNavigator
    @EnvironmentObject private var sessionStore: SessionListStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @FocusState private var searchFocused: Bool
    @State private var seeded = false
    @State private var pendingJump: TranscriptHit?
    @State private var notice: String?
    @State private var noticeTask: Task<Void, Never>?

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    /// - Parameters:
    ///   - primarySessionId: the open conversation (searched first, headed "This
    ///     conversation"); nil from the session list — no conversation is favoured.
    ///   - seed: query to place in the field and search immediately.
    ///   - search: injected request runner; nil uses the live box.
    init(primarySessionId: String?, seed: String = "", search: SearchFunction? = nil) {
        self.primarySessionId = primarySessionId
        self.seed = seed
        let run: SearchFunction = search ?? { request in
            try await MantaAPIClient.live().searchMessages(request)
        }
        _store = StateObject(wrappedValue: SearchStore(primarySessionId: primarySessionId, search: run))
    }

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .safeAreaInset(edge: .top, spacing: 0) { noticeBanner }
                .navigationTitle("Search conversations")
                .navigationBarTitleDisplayMode(.inline)
                .searchable(
                    text: $store.query,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: SearchCopy.placeholder
                )
                .searchFocused($searchFocused)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onAppear {
            guard !seeded else { return }
            seeded = true
            if SearchCopy.isActive(seed) {
                store.query = seed
            }
            searchFocused = true
        }
        .onDisappear {
            store.dismissed()
            noticeTask?.cancel()
            // Navigate only after the sheet has fully gone, so the push is not
            // dropped mid-dismiss.
            if let hit = pendingJump {
                pendingJump = nil
                navigator.open(.message(sessionID: hit.sessionId, messageID: hit.messageId))
            }
        }
    }

    // MARK: - States

    @ViewBuilder
    private var content: some View {
        let state = store.state
        switch state.phase {
        case .idle:
            ContentUnavailableView {
                Label(SearchCopy.idleTitle(hasPrimary: primarySessionId != nil), systemImage: "magnifyingglass")
            } description: {
                Text(SearchCopy.idleDescription)
            }
            .accessibilityIdentifier("search-idle")
        case .loading where state.groups.isEmpty:
            VStack(spacing: Metrics.spacing.sp3) {
                ProgressView()
                Text(SearchCopy.loadingMessage)
                    .font(.footnote)
                    .foregroundStyle(tokens.tx3)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("search-loading")
        case .loading:
            resultsList(state, searching: true)
        case .results:
            resultsList(state, searching: false)
        case .empty:
            ContentUnavailableView {
                Label("No matches for “\(SearchCopy.normalized(store.query))”", systemImage: "magnifyingglass")
            } description: {
                if state.truncated {
                    Text(SearchCopy.truncatedNote)
                }
            }
            .accessibilityIdentifier("search-empty")
        case .unsupported:
            ContentUnavailableView {
                Label(SearchCopy.unsupportedMessage, systemImage: "exclamationmark.triangle")
            }
            .accessibilityIdentifier("search-unsupported")
        case .boxTooOld:
            ContentUnavailableView {
                Label(SearchCopy.boxTooOldMessage, systemImage: "arrow.down.circle")
            }
            .accessibilityIdentifier("search-box-too-old")
        case .failed(let reason):
            ContentUnavailableView {
                Label(SearchCopy.failedMessage(reason), systemImage: "exclamationmark.triangle")
            } actions: {
                Button("Try again") { store.retry() }
                    .buttonStyle(.bordered)
            }
            .accessibilityIdentifier("search-failed")
        }
    }

    // MARK: - Results

    private func resultsList(_ state: SearchQueryState, searching: Bool) -> some View {
        let firstOtherID = state.groups.first(where: { !$0.isCurrent })?.id
        let hasOthers = firstOtherID != nil
        return List {
            ForEach(state.groups) { group in
                Section {
                    ForEach(group.hits, id: \.messageId) { hit in
                        hitRow(hit)
                    }
                } header: {
                    groupHeader(group, showsDivider: group.id == firstOtherID)
                }
            }
            if searching {
                Section {
                    Text(SearchCopy.searchingOthers)
                        .font(.footnote)
                        .foregroundStyle(tokens.tx4)
                        .accessibilityIdentifier("search-searching-others")
                } header: {
                    if !hasOthers { dividerHeader }
                }
            }
            if state.totalHits > 0 {
                Section {
                    VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                        Text(SearchCopy.footer(total: state.totalHits, conversations: state.groups.count))
                        if state.truncated {
                            Text(SearchCopy.truncatedNote)
                        }
                    }
                    .font(.footnote)
                    .foregroundStyle(tokens.tx4)
                    .accessibilityIdentifier("search-footer")
                }
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("search-results")
    }

    private var dividerHeader: some View {
        Text(SearchCopy.otherConversations)
            .font(.footnote)
            .foregroundStyle(tokens.tx4)
            .textCase(nil)
    }

    private func groupHeader(_ group: TranscriptHitGroup, showsDivider: Bool) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            if showsDivider { dividerHeader }
            HStack(spacing: Metrics.spacing.sp2) {
                Text(SearchCopy.sectionTitle(group))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(group.isCurrent ? tokens.tx2 : tokens.tx3)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                Text(group.isCurrent ? SearchCopy.currentCount(group.hits.count) : "\(group.hits.count)")
                    .font(.manta(size: Metrics.type.twoXS, weight: .medium, design: .monospaced))
                    .foregroundStyle(tokens.tx4)
            }
        }
        .textCase(nil)
    }

    private func hitRow(_ hit: TranscriptHit) -> some View {
        let age = Self.age(of: hit)
        return Button {
            open(hit)
        } label: {
            HStack(alignment: .top, spacing: Metrics.spacing.sp3) {
                Text(hit.isUser ? "›" : "✳")
                    .font(.system(size: Metrics.type.body, weight: .semibold))
                    .foregroundStyle(hit.isUser ? tokens.accent : tokens.tx4)
                    .frame(width: Metrics.spacing.sp5)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    Text(Self.snippet(hit, tokens: tokens))
                        .font(.system(size: Metrics.type.small))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(hit.isUser ? "you" : "assistant")
                        .font(.caption)
                        .foregroundStyle(tokens.tx4)
                }
                Spacer(minLength: 0)
                if let age {
                    Text(age)
                        .font(.manta(size: Metrics.type.twoXS, weight: .regular, design: .monospaced))
                        .foregroundStyle(tokens.tx4)
                }
            }
            .frame(minHeight: 44, alignment: .top)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.accessibilityLabel(hit, age: age))
        .accessibilityHint("Opens this message")
        .accessibilityIdentifier("search-hit-\(hit.messageId)")
    }

    // MARK: - Jump

    private func open(_ hit: TranscriptHit) {
        let reachable = SearchJump.isReachable(sessionId: hit.sessionId) { sid in
            sessionStore.window(forSessionID: sid) != nil
        }
        guard reachable else {
            showNotice(SearchCopy.jumpUnreachable)
            return
        }
        SessionHaptics.fire(.selection, enabled: sessionStore.hapticsEnabled)
        pendingJump = hit
        dismiss()
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let notice {
            Text(notice)
                .font(.footnote)
                .foregroundStyle(tokens.warn)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Metrics.spacing.sp4)
                .padding(.vertical, Metrics.spacing.sp3)
                .background(tokens.panel)
                .accessibilityIdentifier("search-notice")
                .transition(.opacity)
        }
    }

    private func showNotice(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task {
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
            notice = nil
        }
    }

    // MARK: - Presentation helpers

    private static func age(of hit: TranscriptHit) -> String? {
        guard let created = hit.timeCreated else { return nil }
        return SessionTimerFormat.age(Date().timeIntervalSince1970 - created / 1000)
    }

    /// `pre` + highlighted `match` + `post`.
    private static func snippet(_ hit: TranscriptHit, tokens: Tokens) -> AttributedString {
        var pre = AttributedString(hit.pre)
        pre.foregroundColor = tokens.tx2
        var match = AttributedString(hit.match)
        match.foregroundColor = tokens.accentTx
        match.backgroundColor = tokens.accentSoft
        match.font = .system(size: Metrics.type.small, weight: .semibold)
        var post = AttributedString(hit.post)
        post.foregroundColor = tokens.tx2
        return pre + match + post
    }

    private static func accessibilityLabel(_ hit: TranscriptHit, age: String?) -> String {
        let who = hit.isUser ? "you" : "assistant"
        let text = hit.pre + hit.match + hit.post
        return age.map { "\(who): \(text), \($0)" } ?? "\(who): \(text)"
    }
}
