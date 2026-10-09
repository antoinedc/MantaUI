import SwiftUI

// ===========================================================================
// Multi-account & seats, phase 3 — Settings → Accounts.
//
// Providers → accounts → seats. Each seat shows its label, email, plan, 5h and
// weekly meters, how many conversations are on it, whether it is the box's live
// login, and its sign-in state. With two or more seats a provider gets a
// Manual / Automatic switch; in manual mode a seat can be made the one every
// conversation uses. Seats can be renamed, and removed — the live one too (the box
// switches to another seat first); a provider's only seat stays.
//
// Every control does something and SAYS so: a success or a specific failure
// lands in the feedback banner (`AccountsFeedbackBanner`). There is no "add a
// seat" button on purpose — the sign-in that adds one runs a CLI/OAuth flow the
// phone has no way to host — so that entry is plain text pointing at the
// desktop, never a control that does nothing.
//
// The screen has no navigation stack of its own: it is pushed from Settings and
// from the usage sheet, each of which owns one.
// ===========================================================================

/// A rename the user asked for, held while its name prompt is up.
struct SeatRenameRequest: Identifiable, Equatable {
    let provider: String
    let target: AccountsStore.RenameTarget
    let targetId: String
    let current: String

    var id: String { "\(provider):\(target.rawValue):\(targetId)" }
    var noun: String { target == .account ? "account" : "seat" }
}

/// A removal waiting on its confirmation.
struct SeatRemoveRequest: Equatable {
    let provider: String
    let seat: AccountsSeat
    /// For the live seat: the seat the box switches to (named in the confirmation).
    let replacement: AccountsSeat?
}

/// A switch to a seat of ANOTHER account, waiting on its confirmation (it makes
/// every conversation re-send its history once).
struct SeatSwitchRequest: Identifiable, Equatable {
    let provider: String
    let seat: AccountsSeat

    var id: String { "\(provider):\(seat.id)" }
}

enum SeatSwitchFlow {
    /// Make `seat` the one every conversation uses — confirming first only when
    /// it is in a different account than the seat in use now. Shared by the
    /// Accounts screen and the usage sheet so both behave (and word it) the same.
    @MainActor
    static func begin(provider: AccountsProvider, seat: AccountsSeat, store: AccountsStore, pending: Binding<SeatSwitchRequest?>) {
        if AccountsSelectors.needsResendConfirmation(provider, switchingTo: seat.id) {
            pending.wrappedValue = SeatSwitchRequest(provider: provider.provider, seat: seat)
        } else {
            Task { await store.useSeat(provider: provider.provider, seat: seat) }
        }
    }
}

extension View {
    /// The confirmation for a cross-account seat switch.
    func seatSwitchAlert(_ pending: Binding<SeatSwitchRequest?>, store: AccountsStore) -> some View {
        alert(
            AccountsCopy.resendTitle,
            isPresented: Binding(
                get: { pending.wrappedValue != nil },
                set: { if !$0 { pending.wrappedValue = nil } }
            ),
            presenting: pending.wrappedValue
        ) { request in
            Button(AccountsCopy.resendConfirm) {
                pending.wrappedValue = nil
                Task { await store.useSeat(provider: request.provider, seat: request.seat) }
            }
            Button("Cancel", role: .cancel) { pending.wrappedValue = nil }
        } message: { request in
            Text("Use \(request.seat.label.isEmpty ? "this seat" : request.seat.label) for every conversation? \(AccountsCopy.resendMessage)")
        }
    }
}

// MARK: - Screen

struct AccountsScreen: View {
    @ObservedObject var store: AccountsStore
    /// A provider to show first (tapped through from "Other subscriptions").
    var focusProvider: String? = nil
    /// True when this screen is the only thing keeping the store reading (the
    /// Settings entry). False when an owner — the chat — already runs it.
    var ownsLifecycle = false

    @Environment(\.colorScheme) private var colorScheme
    @State private var renaming: SeatRenameRequest?
    @State private var renameDraft = ""
    @State private var removeTarget: SeatRemoveRequest?
    @State private var confirmRemove = false
    @State private var pendingSwitch: SeatSwitchRequest?

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    private var removeTitle: String {
        let label = removeTarget?.seat.label ?? ""
        return "Remove \(label.isEmpty ? "this seat" : label)?"
    }

    var body: some View {
        List {
            content
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Accounts")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
        .overlay(alignment: .bottom) { AccountsFeedbackBanner(store: store, tokens: tokens) }
        .onAppear {
            if ownsLifecycle {
                store.start()
            } else {
                Task { await store.refresh() }
            }
        }
        .onDisappear {
            if ownsLifecycle { store.stop() }
        }
        .alert(
            "Rename \(renaming?.noun ?? "seat")",
            isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
            presenting: renaming
        ) { request in
            TextField("Name", text: $renameDraft)
            Button("Save") {
                Task {
                    await store.rename(provider: request.provider, target: request.target,
                                       id: request.targetId, to: renameDraft, current: request.current)
                }
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        } message: { request in
            Text("Names are 1–40 characters. Currently “\(request.current)”.")
        }
        .seatSwitchAlert($pendingSwitch, store: store)
        .confirmActionSheet(
            isPresented: $confirmRemove,
            title: removeTitle,
            message: AccountsCopy.removeConfirmMessage(replacement: removeTarget?.replacement),
            destructiveTitle: "Remove seat",
            destructiveAction: {
                // Read the target at the moment of the tap, not when the sheet
                // was armed: dismissing the sheet must not have cleared it.
                if let target = removeTarget {
                    Task { await store.removeSeat(provider: target.provider, seat: target.seat, replacement: target.replacement) }
                }
            }
        )
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if store.providers.isEmpty {
            switch store.phase {
            case .idle, .loading:
                Section {
                    HStack(spacing: Metrics.spacing.sp2) {
                        ProgressView()
                        Text("Loading accounts…").foregroundStyle(.secondary)
                    }
                }
            case .failed(let reason):
                Section {
                    VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                        Text(reason == AccountsCopy.staleBox ? reason : AccountsCopy.failure("load accounts", reason: reason))
                            .foregroundColor(tokens.danger)
                        Button("Try again") { Task { await store.refresh() } }
                            .buttonStyle(.bordered)
                    }
                }
            case .loaded:
                Section {
                    Text(AccountsCopy.noSeats).foregroundStyle(.secondary)
                }
            }
        } else {
            if let reason = store.refreshError {
                Section {
                    Text("Couldn't refresh — showing the last reading. \(reason)")
                        .font(.footnote)
                        .foregroundColor(tokens.warn)
                }
            }
            ForEach(AccountsSelectors.ordered(store.providers, focus: focusProvider)) { provider in
                providerSection(provider)
            }
        }
    }

    // MARK: - Provider

    private func providerSection(_ provider: AccountsProvider) -> some View {
        Section {
            if AccountsSelectors.hasChoice(provider) {
                modeControl(provider)
            }
            ForEach(provider.accounts) { account in
                accountRows(account, provider: provider)
            }
        } header: {
            Text(AccountsSelectors.providerName(provider.provider))
        } footer: {
            providerFooter(provider)
        }
    }

    private func providerFooter(_ provider: AccountsProvider) -> some View {
        Text(AccountsCopy.addSeatOnDesktop)
    }

    private func modeControl(_ provider: AccountsProvider) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Picker("Mode", selection: Binding(
                get: { provider.mode },
                set: { newMode in
                    guard newMode != provider.mode else { return }
                    Task { await store.setMode(provider: provider.provider, to: newMode) }
                }
            )) {
                Text("Automatic").tag(AccountsMode.auto)
                Text("Manual").tag(AccountsMode.manual)
            }
            .pickerStyle(.segmented)
            .disabled(store.acting)
            Text(provider.mode == .auto
                 ? "New conversations start on the least-loaded seat."
                 : "Every conversation uses the seat you pick.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if !provider.routingActive {
                Text(AccountsCopy.routingInactive)
                    .font(.footnote)
                    .foregroundColor(tokens.warn)
            }
        }
    }

    // MARK: - Account + seats

    @ViewBuilder
    private func accountRows(_ account: AccountsAccount, provider: AccountsProvider) -> some View {
        if account.seats.count != 1 {
            accountHeader(account, provider: provider)
        }
        ForEach(account.seats) { seat in
            seatRow(seat, account: account, provider: provider)
        }
    }

    private func accountHeader(_ account: AccountsAccount, provider: AccountsProvider) -> some View {
        HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
            VStack(alignment: .leading, spacing: 2) {
                Text(account.label.isEmpty ? "Account" : account.label)
                    .font(.subheadline.weight(.semibold))
                let detail = [account.orgName, account.plan].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                if !detail.isEmpty {
                    Text(detail).font(.footnote).foregroundStyle(.secondary)
                }
                if account.seats.isEmpty {
                    Text("No seats in this account").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            Menu {
                Button("Rename account…", systemImage: "pencil") {
                    beginRename(SeatRenameRequest(provider: provider.provider, target: .account,
                                                  targetId: account.id, current: account.label))
                }
            } label: {
                Image(systemName: "ellipsis.circle").font(.title3)
            }
            .disabled(store.acting)
            .accessibilityLabel("Account actions")
        }
    }

    private func seatRow(_ seat: AccountsSeat, account: AccountsAccount, provider: AccountsProvider) -> some View {
        let single = account.seats.count == 1
        let title = single
            ? Self.firstNonEmpty(account.label, seat.label, seat.email, "Seat")
            : Self.firstNonEmpty(seat.label, seat.email, "Seat")
        let action = AccountsSelectors.rowAction(seat, in: provider)
        let next = AccountsSelectors.isNextSeat(seat, in: provider)
        return VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Metrics.spacing.sp1) {
                        Text(title)
                            .font(.body.weight(.semibold))
                            .lineLimit(1)
                        if seat.live { badge("Live", color: tokens.accent) }
                        if let status = AccountsSelectors.statusText(seat.status) { badge(status, color: tokens.warn) }
                        if next { badge("next", color: tokens.info) }
                    }
                    if let subtitle = AccountsSelectors.seatSubtitle(seat, plan: single ? account.plan : nil) {
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                seatMenu(seat, account: account, provider: provider, single: single)
            }
            seatMeters(seat)
            HStack(spacing: Metrics.spacing.sp2) {
                if let chats = AccountsSelectors.conversationsText(seat.conversations) {
                    Text(chats).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                switch action {
                case .use:
                    Button("Use this seat") {
                        SeatSwitchFlow.begin(provider: provider, seat: seat, store: store, pending: $pendingSwitch)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(store.acting)
                case .inUse:
                    Label("In use", systemImage: "checkmark.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(tokens.accent)
                case .fix, .readOnly:
                    EmptyView()
                }
            }
            if action == .fix {
                Text("Sign in to this seat again from the MantaUI desktop app (Settings → Accounts).")
                    .font(.caption)
                    .foregroundColor(tokens.warn)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func seatMeters(_ seat: AccountsSeat) -> some View {
        let rows = AccountsSelectors.windowRows(seat).filter { !$0.inactive }
        if rows.isEmpty {
            Text("No usage reading yet")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                ForEach(rows) { row in
                    SeatMeterBar(title: row.title, window: row.window, tokens: tokens)
                }
                if let hint = AccountsSelectors.resetHintWindow(seat), let resetsAt = hint.resetsAt {
                    Text("resets \(UsageMeters.formatReset(Date(timeIntervalSince1970: resetsAt / 1000), now: Date()))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func seatMenu(_ seat: AccountsSeat, account: AccountsAccount, provider: AccountsProvider, single: Bool) -> some View {
        Menu {
            Button(single ? "Rename account…" : "Rename seat…", systemImage: "pencil") {
                if single {
                    beginRename(SeatRenameRequest(provider: provider.provider, target: .account,
                                                  targetId: account.id, current: account.label))
                } else {
                    beginRename(SeatRenameRequest(provider: provider.provider, target: .seat,
                                                  targetId: seat.id, current: seat.label))
                }
            }
            // Removing the live seat is allowed: the box switches to another
            // seat first. The provider's only seat stays — disabled, with the
            // reason in the item's own title.
            let blocked = AccountsSelectors.removeBlockReason(provider, seat: seat)
            let menuTitle = blocked.map { "Remove seat — \($0)" } ?? "Remove seat…"
            Button(menuTitle, systemImage: "trash", role: .destructive) {
                let replacement = seat.live ? AccountsSelectors.liveSeatReplacement(provider, removing: seat.id) : nil
                removeTarget = SeatRemoveRequest(provider: provider.provider, seat: seat, replacement: replacement)
                confirmRemove = true
            }
            .disabled(blocked != nil)
        } label: {
            Image(systemName: "ellipsis.circle").font(.title3)
        }
        .disabled(store.acting)
        .accessibilityLabel("Seat actions")
    }

    private func beginRename(_ request: SeatRenameRequest) {
        renameDraft = request.current
        renaming = request
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
    }

    private static func firstNonEmpty(_ values: String?...) -> String {
        for value in values {
            if let value, !value.isEmpty { return value }
        }
        return ""
    }
}

// MARK: - Shared pieces

/// One compact meter line: title · bar · percentage. Used by the Accounts
/// screen's seat rows and the usage sheet's other-seat rows.
struct SeatMeterBar: View {
    let title: String
    let window: UsageWindow
    let tokens: Tokens
    var inactive = false

    var body: some View {
        let tint = inactive ? tokens.tx4 : MeterRing.tint(UsageMeters.band(window.pct), tokens)
        HStack(spacing: Metrics.spacing.sp2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: 72, alignment: .leading)
            Gauge(value: UsageMeters.clamp(window.pct.isFinite ? window.pct : 0), in: 0...100) { EmptyView() }
                .gaugeStyle(.accessoryLinearCapacity)
                .tint(tint)
                .frame(height: 5)
            Text(AccountsSelectors.percent(window.pct))
                .font(.caption.weight(.semibold))
                .foregroundColor(tint)
                .frame(width: 44, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title) \(AccountsSelectors.percent(window.pct))")
    }
}

/// The outcome of the last accounts action, pinned over the screen: green-ish
/// for a success, red for a failure, dismissable, self-clearing.
struct AccountsFeedbackBanner: View {
    @ObservedObject var store: AccountsStore
    let tokens: Tokens

    var body: some View {
        if let feedback = store.feedback {
            HStack(spacing: Metrics.spacing.sp2) {
                Image(systemName: feedback.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundColor(feedback.isError ? tokens.danger : tokens.ok)
                Text(feedback.text)
                    .font(.footnote)
                    .foregroundColor(tokens.tx1)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button {
                    store.dismissFeedback(id: feedback.id)
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(tokens.tx4)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.vertical, Metrics.spacing.sp2)
            .background(tokens.raised, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radius.lg)
                    .stroke(feedback.isError ? tokens.danger.opacity(0.6) : tokens.border, lineWidth: 1)
            )
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp3)
            .transition(.opacity)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("accounts-feedback")
        }
    }
}
