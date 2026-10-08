import SwiftUI

// ===========================================================================
// BET-824 — the two meter sheets + the shared band ring.
//
// Each meter's control opens the sheet for the thing it represents — never a
// combined sheet: a context strip that opened a plan sheet would put a
// "Compact" button in front of someone who tapped a quota indicator. The
// context sheet is one subject (this conversation + its two remedies); the
// usage sheet is the other (the plan, whose only remedy is time, so it offers
// no action).
// ===========================================================================

/// The partially-filled band-coloured ring used by the composer dot, the
/// usage-sheet rows and the weekly banner. 13pt / 2.5pt stroke by default;
/// the filled fraction matches the meter's percentage drawn over a muted
/// track. Colour + fraction only — no number, no label, ever.
struct MeterRing: View {
    /// 0-100. Clamped: a provider can report over 100.
    let pct: Double
    let color: Color
    var diameter: CGFloat = 13
    var lineWidth: CGFloat = 2.5
    /// The muted full-circle track drawn underneath the filled fraction.
    let track: Color

    var body: some View {
        let clamped = UsageMeters.clamp(pct)
        // At/over 100 the fraction would be a full ring identical to 99% —
        // so it becomes a solid disc instead. That state must be unmistakable.
        if UsageMeters.isFull(clamped) {
            Circle()
                .fill(color)
                .frame(width: diameter, height: diameter)
        } else {
            ZStack {
                Circle()
                    .stroke(track, lineWidth: lineWidth)
                Circle()
                    .trim(from: 0, to: clamped / 100)
                    .stroke(color, lineWidth: lineWidth)
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: diameter, height: diameter)
        }
    }

    static func tint(_ band: MeterBand, _ tokens: Tokens) -> Color {
        switch band {
        case .ok: return tokens.ok
        case .warn: return tokens.warn
        case .danger: return tokens.danger
        }
    }
}

// MARK: - Context sheet

/// The sheet behind the context strip: this conversation's fill, the segmented
/// breakdown the box already sends, the stale-cache warning, and the two
/// remedies that actually apply (compact / clear). Nothing about the
/// subscription appears here.
struct ContextSheet: View {
    let context: StreamContextPayload
    let cache: StreamCachePayload?
    let limit: Double?
    let modelName: String
    let bandColor: Color
    let tokens: Tokens
    let onCompact: () -> Void
    let onClear: () -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var confirmingClear = false
    @State private var confirmingCompact = false

    var body: some View {
        // A List, not a VStack: the list supplies the card backgrounds, the
        // insets and the platform text sizes. A fixed-height detent around a
        // centred VStack splits the leftover height into dead space above and
        // below the content.
        NavigationStack {
            List {
                Section(footer: staleLine) {
                    header
                    segmentedMeter
                }
                Section {
                    actionRow("Compact session", systemImage: "arrow.triangle.2.circlepath", onTap: { confirmingCompact = true })
                    actionRow("Clear session", systemImage: "plus.circle", onTap: { confirmingClear = true })
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Context")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .confirmActionSheet(isPresented: $confirmingClear, copy: SessionConfirmCopy.clear) {
            dismiss(); onClear()
        }
        .confirmActionSheet(isPresented: $confirmingCompact, copy: SessionConfirmCopy.compact) {
            dismiss(); onCompact()
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    /// Big percentage in the band colour + "824k of 1M · Opus 4.7"; for a
    /// model with no known max context, a "No max context info" line instead
    /// — never a fabricated % or `of <limit>`.
    @ViewBuilder
    private var header: some View {
        if context.hasLimit {
            HStack(alignment: .firstTextBaseline, spacing: Metrics.spacing.sp2) {
                Group {
                    Text("\(Int(context.pct.rounded()))")
                        .font(.system(size: Metrics.type.display, weight: .bold))
                    Text("%")
                        .font(.manta(size: Metrics.type.body, weight: .bold))
                }
                .foregroundColor(bandColor)
                Text("\(UsageMeters.formatTokens(context.totalInput)) of \(UsageMeters.formatTokens(limit)) · \(modelName)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: Metrics.spacing.sp2) {
                Text("No max context info for this model")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
    }

    /// The segmented meter: fresh input (accent), cache-written (warn),
    /// cache-read (info) — the box-computed per-segment percentages, whose
    /// sum is the overall fill. For the unknown state (no max context) only
    /// the fresh/written/cached token stats are shown, with no bar.
    private var segmentedMeter: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            if context.hasLimit {
                GeometryReader { geo in
                    let w = geo.size.width
                    HStack(spacing: 0) {
                        segment(tokens.accent, pct: segmentPct("fresh"), width: w)
                        segment(tokens.warn, pct: segmentPct("cacheWrite"), width: w)
                        segment(tokens.info, pct: segmentPct("cacheRead"), width: w)
                        Spacer(minLength: 0)
                    }
                    .frame(height: 8)
                    .background(tokens.fill, in: RoundedRectangle(cornerRadius: Metrics.radius.full))
                }
                .frame(height: 8)
            }
            HStack(spacing: Metrics.spacing.sp2) {
                legend("fresh", UsageMeters.formatTokens(context.freshInput), color: tokens.accent)
                legend("written", UsageMeters.formatTokens(context.cacheWrite), color: tokens.warn)
                legend("cached", UsageMeters.formatTokens(context.cacheRead), color: tokens.info)
                Spacer(minLength: 0)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }

    private func segment(_ color: Color, pct: Double, width: CGFloat) -> some View {
        Rectangle()
            .fill(color)
            .frame(width: max(0, width * (pct / 100)))
    }

    private func legend(_ label: String, _ tokensText: String, color: Color) -> some View {
        HStack(spacing: Metrics.spacing.sp1) {
            Text("■")
                .font(.system(size: Metrics.type.twoXS, weight: .bold))
                .foregroundColor(color)
            Text("\(label) \(tokensText)")
        }
    }

    private func segmentPct(_ kind: String) -> Double {
        context.segments.first { $0.kind == kind }?.pct ?? 0
    }

    /// "Idle 1h12m — the cache has gone cold. Clearing now saves re-billing
    /// 584k tokens." — driven by idleMs + staleTokens. The warn colour IS the
    /// warning, so it is kept; the font is the platform's footnote.
    @ViewBuilder
    private var staleLine: some View {
        if let cache, cache.isStale {
            Text("Idle \(idleText(cache.idleMs)) — the cache has gone cold. Clearing now saves re-billing \(UsageMeters.formatTokens(cache.staleTokens)) tokens.")
                .font(.footnote)
                .foregroundColor(tokens.warn)
        }
    }

    /// A plain row in the list's action section: compact the session, or clear
    /// it. Both arm a confirm sheet (sheet-on-sheet) rather than firing the
    /// destructive action directly — a blind tap must not reach the store. The
    /// list styles the row and the system tints the label.
    private func actionRow(_ title: String, systemImage: String, onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            Label(title, systemImage: systemImage)
        }
    }

    private func idleText(_ ms: Double) -> String {
        // Canonical compact timer form ("2h57m"/"57m"/"45s"), shared with the
        // running row and the desktop — pass ms/1000 since `compact` takes seconds.
        SessionTimerFormat.compact(ms / 1000)
    }
}

// MARK: - Usage sheet

/// Where the sheet's "Manage seats" / "Fix" / other-subscription rows go: the
/// Accounts screen, optionally with one provider shown first.
private struct AccountsDestination: Hashable, Identifiable {
    let focus: String?
    var id: String { focus ?? "" }
}

/// The sheet behind the usage dot.
///
/// One seat, one subscription: the plan, two windows, session first — no
/// actions, because the only remedy is time. With several seats (multi-account
/// phase 3, spec §7a) it becomes the conversation's seat: this conversation's
/// seat and its windows, a recent move, every other seat (with a "Use" in
/// manual mode and a "next" tag in automatic), the other subscriptions the box
/// has connected, and a way into Settings → Accounts.
struct UsageSheet: View {
    let snapshots: [UsageSnapshot]
    let lastFetch: Date?
    let tokens: Tokens
    @ObservedObject var accounts: AccountsStore

    @Environment(\.dismiss) private var dismiss
    @State private var destination: AccountsDestination?
    @State private var pendingSwitch: SeatSwitchRequest?

    private var conversation: ConversationSeat? { accounts.conversationSeat }

    /// Whether the multi-seat layout applies; otherwise the sheet is exactly
    /// what it was before seats existed.
    private var seatLayout: Bool { AccountsSelectors.usesSeatLayout(conversation) }

    /// The seat layout and the other-subscriptions list are longer than the
    /// single-snapshot sheet, so they may be pulled up; today's layout keeps its
    /// one fixed detent.
    private var detents: Set<PresentationDetent> {
        seatLayout || !otherSubscriptions.isEmpty ? [.medium, .large] : [.medium]
    }

    private var otherSubscriptions: [AccountsProvider] {
        AccountsSelectors.otherProviders(accounts.providers, than: conversation?.sessionSeat.provider)
    }

    var body: some View {
        // A List, not a VStack: the list supplies the card backgrounds, the
        // insets and the platform text sizes. A fixed-height detent around a
        // centred VStack splits the leftover height into dead space above and
        // below the content.
        NavigationStack {
            List {
                if seatLayout, let conversation, let provider = conversation.provider, let seat = conversation.seat {
                    seatSections(conversation, provider: provider, seat: seat)
                } else {
                    Section(footer: footer) {
                        if let session = UsageMeters.sessionWindow(snapshots) {
                            UsageWindowRow(window: session, tokens: tokens)
                        }
                        if let weekly = UsageMeters.weeklyWindow(snapshots) {
                            UsageWindowRow(window: weekly, tokens: tokens)
                        }
                    }
                }
                otherSubscriptionsSection
                if seatLayout {
                    Section(footer: Text("Updated \(Self.ago(accounts.lastFetch))")) {
                        Button("Manage seats") { destination = AccountsDestination(focus: nil) }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(seatLayout ? "Usage" : planTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(item: $destination) { target in
                AccountsScreen(store: accounts, focusProvider: target.focus, ownsLifecycle: false)
            }
            .overlay(alignment: .bottom) { AccountsFeedbackBanner(store: accounts, tokens: tokens) }
            .seatSwitchAlert($pendingSwitch, store: accounts)
            // Refreshed on open, like the Accounts screen: the seat list can
            // have changed since the chat last read it.
            .task { await accounts.refresh() }
        }
        .presentationDetents(detents)
        .presentationDragIndicator(.visible)
    }

    // MARK: - Multi-seat layout

    @ViewBuilder
    private func seatSections(_ conversation: ConversationSeat, provider: AccountsProvider, seat: AccountsSeat) -> some View {
        // 1 — provider + plan, and the mode chip (only with ≥ 2 seats, which
        // is the only time this layout is used).
        Section {
            HStack(spacing: Metrics.spacing.sp2) {
                Text(headerTitle(conversation, provider: provider))
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 0)
                Text(provider.mode == .auto ? "Automatic" : "Manual")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(tokens.fill, in: Capsule())
            }
        }

        // 2 + 3 — this conversation's seat, its windows, and a recent move.
        Section("This conversation") {
            HStack(spacing: Metrics.spacing.sp2) {
                Text(conversation.displayName)
                    .font(.body.weight(.semibold))
                if let status = AccountsSelectors.statusText(seat.status) {
                    Text(status)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(tokens.warn)
                }
            }
            let rows = AccountsSelectors.windowRows(seat)
            if rows.isEmpty {
                Text("No usage reading for this seat yet")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(rows) { row in
                UsageWindowRow(window: row.window, tokens: tokens, title: row.title, inactive: row.inactive)
            }
            if let line = AccountsSelectors.lastMoveLine(conversation.sessionSeat.lastMove, now: Date()) {
                Label(line, systemImage: "arrow.turn.up.right")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }

        // 4 — every other seat, grouped by account.
        ForEach(AccountsSelectors.otherSeatGroups(provider, excluding: seat.id)) { group in
            Section(group.heading.map { "Other seats · \($0)" } ?? "Other seats") {
                ForEach(group.seats) { other in
                    otherSeatRow(other, provider: provider)
                }
            }
        }
    }

    private func headerTitle(_ conversation: ConversationSeat, provider: AccountsProvider) -> String {
        let name = AccountsSelectors.providerName(provider.provider)
        let plan = conversation.account?.plan
            ?? snapshots.first { $0.provider == provider.provider }?.planLabel
        if let plan, !plan.isEmpty { return "\(name) · \(plan)" }
        return name
    }

    private func otherSeatRow(_ seat: AccountsSeat, provider: AccountsProvider) -> some View {
        let action = AccountsSelectors.rowAction(seat, in: provider)
        let windows = [UsageSnapshot(windows: seat.windows)]
        return VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            HStack(spacing: Metrics.spacing.sp2) {
                Text(seat.label.isEmpty ? (seat.email ?? "Seat") : seat.label)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                if AccountsSelectors.isNextSeat(seat, in: provider) {
                    Text("next")
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(tokens.info)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(tokens.info.opacity(0.15), in: Capsule())
                }
                if let status = AccountsSelectors.statusText(seat.status) {
                    Text(status)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(tokens.warn)
                }
                Spacer(minLength: 0)
                if seat.conversations > 0 {
                    Text("\(seat.conversations) chats")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                switch action {
                case .use:
                    Button("Use") {
                        SeatSwitchFlow.begin(provider: provider, seat: seat, store: accounts, pending: $pendingSwitch)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(accounts.acting)
                case .fix:
                    Button("Fix") { destination = AccountsDestination(focus: provider.provider) }
                        .buttonStyle(.borderless)
                case .inUse, .readOnly:
                    EmptyView()
                }
            }
            if action != .fix {
                if let session = UsageMeters.sessionWindow(windows) {
                    SeatMeterBar(title: AccountsSelectors.windowTitle(session), window: session, tokens: tokens)
                }
                if let weekly = UsageMeters.weeklyWindow(windows) {
                    SeatMeterBar(title: AccountsSelectors.windowTitle(weekly), window: weekly, tokens: tokens)
                }
                if let hint = AccountsSelectors.resetHintWindow(seat), let resetsAt = hint.resetsAt {
                    Text("resets \(UsageMeters.formatReset(Date(timeIntervalSince1970: resetsAt / 1000), now: Date()))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Other subscriptions

    @ViewBuilder
    private var otherSubscriptionsSection: some View {
        if !otherSubscriptions.isEmpty {
            Section("Other subscriptions") {
                ForEach(otherSubscriptions) { other in
                    Button { destination = AccountsDestination(focus: other.provider) } label: {
                        HStack {
                            Text(AccountsSelectors.otherSubscriptionLine(other))
                                .foregroundStyle(.primary)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Today's single-snapshot layout

    /// "2m ago" from a fetch stamp; "just now" when missing or fresh.
    private static func ago(_ date: Date?) -> String {
        guard let date else { return "just now" }
        let minutes = Int(Date().timeIntervalSince(date) / 60)
        if minutes < 1 { return "just now" }
        return "\(minutes)m ago"
    }

    /// The sheet's title — the provider whose snapshot the sheet shows,
    /// mapped the same way the desktop dial names providers (claude →
    /// "Claude", codex → "OpenAI", kimi → "Kimi", else capitalised id).
    private var planTitle: String {
        UsageMeters.providerLabel(primarySnapshot?.provider)
    }

    /// The snapshot that drives the sheet — the one holding the primary (dot)
    /// window, falling back to the first snapshot when none does.
    private var primarySnapshot: UsageSnapshot? {
        snapshots.first { $0.windows.contains { $0.kind == "session" } } ?? snapshots.first
    }

    /// "Updated 2m ago · the dot tracks 5h." The window the dot actually tracks
    /// is the session (primary, first) window — named from its own `label`, so
    /// the footer never asserts a fixed 5-hour window.
    private var footer: Text {
        let windowLabel = UsageMeters.sessionWindow(snapshots)?.label ?? ""
        return Text("Updated \(Self.ago(lastFetch)) · the dot tracks \(windowLabel).")
    }
}

/// One window row in the usage sheet: band ring, the server's window `label`,
/// percentage, meter, and the reset countdown/date. The list draws the row's
/// surface, so there is no hand-rolled card here. A window the provider says is
/// not in force (`inactive`) is drawn greyed and says so instead of raising
/// alarm colours.
private struct UsageWindowRow: View {
    let window: UsageWindow
    let tokens: Tokens
    /// Overrides the window's own `label` (the seat layout titles scoped
    /// weeklies "Weekly · Fable").
    var title: String? = nil
    var inactive = false

    var body: some View {
        let band = UsageMeters.band(window.pct)
        let tint = inactive ? tokens.tx4 : MeterRing.tint(band, tokens)
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            HStack(spacing: Metrics.spacing.sp1) {
                MeterRing(pct: window.pct, color: tint, diameter: 11, lineWidth: 2.5, track: tokens.borderSubtle)
                Text(title ?? window.label ?? "")
                    .font(.body)
                Spacer(minLength: 0)
                if inactive {
                    Text("not active")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    Text("\(Int(window.pct.rounded()))%")
                        .font(.body.weight(.semibold))
                        .foregroundColor(tint)
                }
            }
            Gauge(value: window.pct, in: 0...100) { EmptyView() }
                .gaugeStyle(.accessoryLinearCapacity)
                .tint(tint)
                .frame(height: 5)
            if !inactive, let resetsAt = window.resetsAt {
                Text("resets \(UsageMeters.formatReset(Date(timeIntervalSince1970: resetsAt / 1000), now: Date()))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .opacity(inactive ? 0.6 : 1)
    }
}
