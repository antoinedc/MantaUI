import SwiftUI
import MessagingUI

// ===========================================================================
// Auto-handoff — the iOS surfaces (spec 2026-10-26-auto-handoff §3, §9, §10).
//
//   HandoffRecordCard       the card: header + state badge, markdown body that
//                           collapses past ~12 lines, Copy / Clear & start /
//                           Start in new session / Edit first / Retry
//   HandoffToolCardView     the same card for an agent's `handoff` tool part
//   HandoffPinnedCards      server-path cards + the armed "carried-over context"
//                           block, pinned above the composer
//   HandoffNoticeRow        "Continued from …" at the top of a successor
//   HandoffModeRow          the auto / suggest / off control (overflow sheet)
//   HandoffPreviousSection  "Previous sessions" (overflow sheet)
//   PreviousSessionScreen   a predecessor opened read-only, with a
//                           "Back to current" bar in place of the composer
//
// All decisions (badge, which buttons are enabled, collapse, pinning) come from
// `HandoffCardLogic` (pure, tested); this file only draws. Every control either
// does its thing and shows it, fails with a message, or is not drawn.
// ===========================================================================

// MARK: - The card

struct HandoffRecordCard: View {
    @ObservedObject var store: HandoffStore
    let record: HandoffRecord
    let tokens: Tokens

    private var busy: Bool { store.busyIDs.contains(record.id) }

    var body: some View {
        let enabled = HandoffCardLogic.actionsEnabled(record) && !busy
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            header
            if record.state == .failed, let reason = record.reason {
                Text(reason)
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.danger)
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .accessibilityIdentifier("handoff-failure-reason")
            }
            if !record.text.isEmpty {
                bodyText
            }
            actions(enabled: enabled)
        }
        .padding(.vertical, Metrics.spacing.sp2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("handoff-card")
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Text("Handoff prompt")
                .font(.manta(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(tokens.tx1)
            Text("· \(HandoffCardLogic.sourceLabel(record))")
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.tx4)
                .lineLimit(1)
            Spacer(minLength: 0)
            badgeView
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .frame(minHeight: 28)
    }

    @ViewBuilder
    private var badgeView: some View {
        let badge = HandoffCardLogic.badge(for: record)
        let color = toneColor(badge.tone)
        if badge.opensSuccessor {
            Button { store.openSuccessor(record) } label: {
                HStack(spacing: Metrics.spacing.sp1) {
                    Text(badge.label)
                    Image(systemName: "chevron.right")
                }
                .font(.manta(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(color)
                .padding(.horizontal, Metrics.spacing.sp2)
                .padding(.vertical, Metrics.spacing.sp1)
                .background(color.opacity(0.12), in: Capsule())
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Started — open the new session")
            .accessibilityIdentifier("handoff-badge-open")
        } else {
            HStack(spacing: Metrics.spacing.sp1) {
                if badge.tone == .progress || busy { ProgressView().controlSize(.mini) }
                Text(badge.label)
            }
            .font(.manta(size: Metrics.type.xs, weight: .semibold))
            .foregroundColor(color)
            .padding(.horizontal, Metrics.spacing.sp2)
            .padding(.vertical, Metrics.spacing.sp1)
            .background(color.opacity(0.12), in: Capsule())
            .accessibilityIdentifier("handoff-badge")
        }
    }

    private func toneColor(_ tone: HandoffBadgeTone) -> Color {
        switch tone {
        case .neutral: return tokens.tx4
        case .progress: return tokens.warn
        case .ok: return tokens.ok
        case .danger: return tokens.danger
        }
    }

    // MARK: body

    private var bodyText: some View {
        let expanded = store.isExpanded(record.id)
        return VStack(alignment: .leading, spacing: 0) {
            MantaProse(text: HandoffCardLogic.visibleText(record.text, expanded: expanded), tokens: tokens)
            if HandoffCardLogic.isCollapsible(record.text) {
                Button { store.toggleExpanded(record.id) } label: {
                    Text(expanded ? "Show less" : "Show more")
                        .font(.manta(size: Metrics.type.xs, weight: .semibold))
                        .foregroundColor(tokens.accentTx)
                        .padding(.horizontal, Metrics.spacing.sp3)
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("handoff-toggle-body")
            }
        }
    }

    // MARK: actions

    @ViewBuilder
    private func actions(enabled: Bool) -> some View {
        if HandoffCardLogic.showsRetry(record) {
            HStack(spacing: Metrics.spacing.sp2) {
                pill("Retry", systemImage: "arrow.clockwise", filled: true, enabled: !busy, id: "handoff-retry") {
                    store.retry(record)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Metrics.spacing.sp3)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Metrics.spacing.sp2) {
                    pill("Clear & start", filled: true, enabled: enabled, id: "handoff-clear-start") {
                        store.start(record, how: .clear, disposition: .send)
                    }
                    pill("Start in new session", filled: false, enabled: enabled, id: "handoff-new-session") {
                        store.start(record, how: .newSession, disposition: .send)
                    }
                    Spacer(minLength: 0)
                }
                HStack(spacing: Metrics.spacing.sp2) {
                    pill(store.copiedID == record.id ? "Copied" : "Copy",
                         systemImage: store.copiedID == record.id ? "checkmark" : "doc.on.doc",
                         filled: false, enabled: enabled, id: "handoff-copy") {
                        store.copy(record)
                    }
                    Menu {
                        Button("Clear & edit here") { store.start(record, how: .clear, disposition: .draft) }
                        Button("Edit in a new session") { store.start(record, how: .newSession, disposition: .draft) }
                    } label: {
                        pillLabel("Edit first", systemImage: "square.and.pencil", filled: false, enabled: enabled)
                    }
                    .disabled(!enabled)
                    .accessibilityIdentifier("handoff-edit-first")
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, Metrics.spacing.sp3)
        }
    }

    private func pill(_ title: String, systemImage: String? = nil, filled: Bool, enabled: Bool, id: String,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            pillLabel(title, systemImage: systemImage, filled: filled, enabled: enabled)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityIdentifier(id)
    }

    private func pillLabel(_ title: String, systemImage: String? = nil, filled: Bool, enabled: Bool) -> some View {
        HStack(spacing: Metrics.spacing.sp1) {
            if let systemImage { Image(systemName: systemImage) }
            Text(title)
        }
        .font(.manta(size: Metrics.type.small, weight: .semibold))
        .foregroundColor(!enabled ? tokens.tx4 : (filled ? tokens.onAccent : tokens.accentTx))
        .lineLimit(1)
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .background(
            !enabled ? AnyShapeStyle(tokens.inset) : (filled ? AnyShapeStyle(tokens.accentSolid) : AnyShapeStyle(tokens.accentSoft)),
            in: Capsule()
        )
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

// MARK: - An agent's `handoff` tool part

/// The transcript row for a `handoff` tool part. With the chat's store (the
/// live surface) it draws the full card from the record the part's marker
/// names; a read-only surface has no store and draws the status line only — a
/// card whose buttons could not act is not drawn at all.
struct HandoffToolCardView: View {
    @Environment(\.handoffStore) private var store
    let ref: HandoffToolRef
    let tokens: Tokens

    var body: some View {
        if let store, let id = ref.handoffId {
            HandoffToolCardLive(store: store, id: id, tokens: tokens)
        } else {
            HandoffStatusLine(ref: ref, tokens: tokens)
        }
    }
}

private struct HandoffToolCardLive: View {
    @ObservedObject var store: HandoffStore
    let id: String
    let tokens: Tokens

    var body: some View {
        Group {
            if let record = store.records[id] {
                HandoffRecordCard(store: store, record: record, tokens: tokens)
            } else if store.expiredIDs.contains(id) {
                note(HandoffCardLogic.expiredCopy, systemImage: "clock.badge.xmark", color: tokens.tx4)
            } else if store.loadFailedIDs.contains(id) {
                Button { store.reload(id) } label: {
                    note("Couldn't load this handoff — tap to retry", systemImage: "arrow.clockwise", color: tokens.warn)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("handoff-reload")
            } else {
                note("Loading handoff…", systemImage: "arrow.down.circle", color: tokens.tx4)
            }
        }
        .task(id: id) { await store.ensure(id) }
    }

    private func note(_ text: String, systemImage: String, color: Color) -> some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: systemImage)
            Text(text)
            Spacer(minLength: 0)
        }
        .font(.manta(size: Metrics.type.xs))
        .foregroundColor(color)
        .padding(Metrics.spacing.sp3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 44)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .accessibilityIdentifier("handoff-card-note")
    }
}

/// The tool part with no record to draw: still running, errored, or on a
/// surface without a store.
private struct HandoffStatusLine: View {
    let ref: HandoffToolRef
    let tokens: Tokens

    private var text: String {
        switch ref.toolStatus {
        case "pending", "running": return "Preparing a handoff…"
        case "error": return ref.statusLine.isEmpty ? "The handoff couldn't be created" : ref.statusLine
        default: return ref.statusLine.isEmpty ? "Handoff prompt" : ref.statusLine
        }
    }

    var body: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: ref.toolStatus == "error" ? "exclamationmark.triangle" : "arrow.turn.down.right")
            Text(text)
                .lineLimit(3)
            Spacer(minLength: 0)
        }
        .font(.manta(size: Metrics.type.xs))
        .foregroundColor(ref.toolStatus == "error" ? tokens.danger : tokens.tx3)
        .padding(Metrics.spacing.sp3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .accessibilityIdentifier("handoff-status-line")
    }
}

// MARK: - Pinned above the composer

struct HandoffPinnedCards: View {
    @ObservedObject var store: HandoffStore
    let tokens: Tokens

    var body: some View {
        VStack(spacing: Metrics.spacing.sp3) {
            ForEach(store.pinned) { record in
                HandoffRecordCard(store: store, record: record, tokens: tokens)
            }
            if let preamble = store.armedPreamble {
                HandoffCarriedContextCard(store: store, text: preamble, tokens: tokens)
            }
        }
    }
}

/// The armed successor's held handoff text: delivered together with the next
/// message the chat accepts, so the user sees what is about to ride along.
struct HandoffCarriedContextCard: View {
    @ObservedObject var store: HandoffStore
    let text: String
    let tokens: Tokens

    private var key: String { "armed:" + store.sessionId }

    var body: some View {
        let expanded = store.isExpanded(key)
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Carried-over context")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                Text("Sent with the next message.")
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
            }
            .padding(.horizontal, Metrics.spacing.sp3)
            MantaProse(text: HandoffCardLogic.visibleText(text, expanded: expanded), tokens: tokens)
            if HandoffCardLogic.isCollapsible(text) {
                Button { store.toggleExpanded(key) } label: {
                    Text(expanded ? "Show less" : "Show more")
                        .font(.manta(size: Metrics.type.xs, weight: .semibold))
                        .foregroundColor(tokens.accentTx)
                        .padding(.horizontal, Metrics.spacing.sp3)
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, Metrics.spacing.sp2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("handoff-carried-context")
    }
}

// MARK: - Notice

struct HandoffNoticeRow: View {
    let notice: HandoffPrevious.Notice
    let tokens: Tokens
    let onView: () -> Void

    var body: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(tokens.tx4)
            Text(notice.text)
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.tx3)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            Button(action: onView) {
                Text("View previous")
                    .font(.manta(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("handoff-view-previous")
        }
        .frame(height: 28)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("handoff-notice")
    }
}

// MARK: - Overflow-sheet rows

/// The auto / suggest / off control. Hidden until the box has answered
/// `config:get` — a control with no value to show is not drawn.
struct HandoffModeRow: View {
    @ObservedObject var store: HandoffStore

    var body: some View {
        if let mode = store.mode {
            VStack(alignment: .leading, spacing: 6) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Handoff")
                    Text(mode.caption)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Picker("Handoff mode", selection: Binding(get: { mode }, set: { store.setMode($0) })) {
                    ForEach(HandoffMode.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("handoff-mode-picker")
                if let error = store.modeError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("handoff-mode-error")
                }
            }
            .accessibilityIdentifier("handoff-mode")
        }
    }
}

/// "Previous sessions": the predecessor chain plus a branch origin, newest first.
struct HandoffPreviousSection: View {
    @ObservedObject var store: HandoffStore
    let onOpen: (HandoffPreviousEntry) -> Void

    var body: some View {
        if !store.previous.isEmpty {
            Section("Previous sessions") {
                ForEach(store.previous) { entry in
                    Button { onOpen(entry) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(store.title(for: entry.sessionId))
                                    .lineLimit(1)
                                Text(entry.kind == .branchedFrom ? "Branched from" : "Handed off from")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("handoff-previous-row")
                }
            }
        }
    }
}

// MARK: - A previous session, read-only

/// A navigation value for opening a predecessor (or a branch origin) read-only.
struct PreviousSessionRoute: Hashable {
    let sessionId: String
    let title: String
}

/// A predecessor's transcript with no composer: a "Back to current" bar sits
/// where the composer is. Read-only by construction (a read-only store, inert
/// cards), and a session that no longer exists says so instead of showing a
/// blank screen.
struct PreviousSessionScreen: View {
    let route: PreviousSessionRoute
    let tokens: Tokens
    @Binding var path: NavigationPath
    @StateObject private var store: ChatSessionStore
    /// False until `start()` has run: the store reports `loading == false` before
    /// it has begun, which would flash the "nothing to show" state first.
    @State private var didStart = false
    @State private var scrollPosition = TiledScrollPosition(
        autoScrollsToBottomOnAppend: true,
        scrollsToBottomOnReplace: true
    )

    init(route: PreviousSessionRoute, eventStore: MantaEventStore, capabilities: BoxCapabilitiesStore, api: MantaAPIClient, tokens: Tokens, path: Binding<NavigationPath>) {
        self.route = route
        self.tokens = tokens
        self._path = path
        _store = StateObject(wrappedValue: ChatSessionStore(
            sessionId: route.sessionId,
            eventStore: eventStore,
            api: api,
            isReadOnly: true,
            capabilities: capabilities
        ))
    }

    var body: some View {
        content
            .background(tokens.canvas.ignoresSafeArea())
            .navigationTitle(route.title)
            .navigationBarTitleDisplayMode(.inline)
            .mantaNavigationBarBackground(tokens)
            .safeAreaInset(edge: .bottom, spacing: 0) { backBar }
            .onAppear {
                store.start()
                didStart = true
            }
            .onDisappear { store.stop() }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("previous-session-scene")
    }

    @ViewBuilder
    private var content: some View {
        if !didStart || store.loading {
            ChatLoadingSkeleton()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.loadFailed || store.rows.isEmpty {
            VStack(spacing: Metrics.spacing.sp2) {
                Image(systemName: "tray")
                    .font(.system(size: Metrics.type.display))
                    .foregroundColor(tokens.tx4)
                Text("Nothing to show")
                    .font(.manta(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                Text("This session was deleted, or the box can't be reached.")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx4)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, Metrics.spacing.sp3)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("previous-session-deleted")
        } else {
            TranscriptListView(
                store: store,
                tokens: tokens,
                bottomInset: 0,
                scrollPosition: $scrollPosition,
                onPointsFromBottom: nil,
                header: { Color.clear.frame(height: 0.5) }
            )
            .environment(\.transcriptCardActions, TranscriptCardActions.readOnly())
        }
    }

    private var backBar: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "lock")
                .font(.system(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(tokens.tx4)
            Text("Previous session — read-only")
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.tx3)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button {
                if !path.isEmpty { path.removeLast() }
            } label: {
                Text("Back to current")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.onAccent)
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .padding(.vertical, Metrics.spacing.sp2)
                    .background(tokens.accentSolid, in: Capsule())
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("handoff-back-to-current")
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .background(tokens.panel)
        .overlay(alignment: .top) {
            Rectangle().fill(tokens.borderSubtle).frame(height: Metrics.spacing.spPx)
        }
    }
}
