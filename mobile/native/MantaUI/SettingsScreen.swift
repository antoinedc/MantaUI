import SwiftUI

// ===========================================================================
// S7 — settings screen (BET-599).
//
// Rendered ENTIRELY from the GENERATED `SettingsSchema` inventory (from
// src/shared/settingsSchema.ts) — there is no hand-written settings list in
// Swift, so adding a setting to the schema and re-running
// `npm run gen:swift-settings` surfaces it here with zero Swift edits.
//
//   - search (label + help) across every entry;
//   - "Modified" dot on a section containing a non-default value;
//   - per-section reset and a reset-all danger zone, both undoable;
//   - config-driven entries persist via the store's `config:update`; device-local
//     entries (configKey nil) stay on-device.
//
// Every colour, spacing, radius, size, weight and leading resolves through the
// GENERATED design tokens (`Tokens.scheme(_:)` / `Metrics`) — no literals.
// ===========================================================================

struct SettingsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var store = MantaSettingsStore()
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var confirmReset = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    private var inSearch: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            ZStack {
                tokens.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        searchField
                            .padding(.horizontal, Metrics.spacing.sp3)
                            .padding(.top, Metrics.spacing.sp2)
                            .padding(.bottom, Metrics.spacing.sp2)

                        if inSearch {
                            searchResults
                        } else {
                            sectionList
                            resetAllFooter
                        }
                    }
                    .padding(.bottom, Metrics.spacing.sp6)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundColor(tokens.accent)
                        .font(.manta(size: Metrics.type.body, weight: .semibold))
                }
            }
            .overlay(alignment: .bottom) { undoToast }
            .sheet(isPresented: $confirmReset) { resetAllSheet }
            .task { await store.load() }
        }
    }

    // MARK: - Search

    private var searchField: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "magnifyingglass")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
            TextField("Find a setting…", text: $query)
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx1)
                .autocorrectionDisabled()
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx4)
                }
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(query.isEmpty ? tokens.border : tokens.accent, lineWidth: 1)
        )
    }

    private var searchResults: some View {
        let hits = SettingsSchema.search(query)
        return VStack(alignment: .leading, spacing: 0) {
            Text(hits.count == 1 ? "1 match" : "\(hits.count) matches")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
            if hits.isEmpty {
                Text("No settings match. Try another term.")
                    .font(.manta(size: Metrics.type.body))
                    .foregroundColor(tokens.tx3)
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .padding(.vertical, Metrics.spacing.sp2)
            } else {
                ForEach(hits) { entry in
                    VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                        Text(sectionLabel(entry.section))
                            .font(.manta(size: Metrics.type.twoXS))
                            .foregroundColor(tokens.tx4)
                            .textCase(.uppercase)
                        field(for: entry)
                    }
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .padding(.vertical, Metrics.spacing.sp2)
                    .overlay(alignment: .bottom) { divider }
                }
            }
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(tokens.borderSubtle)
            .frame(height: 1)
    }

    // MARK: - Sections

    private var sectionList: some View {
        ForEach(SettingsSchema.sections) { section in
            sectionView(section)
        }
    }

    private func sectionView(_ section: SettingSection) -> some View {
        let entries = SettingsSchema.entries(in: section.id)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Metrics.spacing.sp2) {
                Text(section.label)
                    .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
                    .foregroundColor(tokens.tx2)
                    .textCase(.uppercase)
                if store.sectionModified(section.id) {
                    Circle()
                        .fill(tokens.accent)
                        .frame(width: Metrics.spacing.sp2, height: Metrics.spacing.sp2)
                        .accessibilityLabel("Modified")
                }
                Spacer()
                if hasResettableEntries(section.id) {
                    Button {
                        store.resetSection(section.id)
                    } label: {
                        Label("Reset", systemImage: "arrow.counterclockwise")
                            .font(.manta(size: Metrics.type.twoXS))
                            .labelStyle(.titleAndIcon)
                            .foregroundColor(tokens.tx3)
                    }
                    .accessibilityLabel("Reset \(section.label) to defaults")
                }
            }
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.top, Metrics.type.listGroupAbove)
            .padding(.bottom, Metrics.type.listGroupBelow)

            if entries.isEmpty {
                Text("No settings in this section yet.")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
                    .padding(.horizontal, Metrics.spacing.sp3)
            } else {
                ForEach(entries) { entry in
                    field(for: entry)
                    if entry.help.isEmpty == false, entry.control != .toggle {
                        Text(entry.help)
                            .font(.manta(size: Metrics.type.small))
                            .foregroundColor(tokens.tx3)
                            .padding(.horizontal, Metrics.spacing.sp3)
                    }
                    divider
                }
            }
        }
    }

    private func hasResettableEntries(_ sectionID: String) -> Bool {
        !SettingsSchema.entries(in: sectionID).filter { $0.configKey != nil }.isEmpty
    }

    private func sectionLabel(_ id: String) -> String {
        SettingsSchema.sections.first { $0.id == id }?.label ?? id
    }

    // MARK: - Field rendering

    @ViewBuilder
    private func field(for entry: SettingEntry) -> some View {
        switch entry.control {
        case .toggle:
            toggleRow(entry)
        case .segmented:
            segmentedRow(entry)
        case .password:
            passwordRow(entry)
        case .text:
            textRow(entry)
        case .path:
            labelRow(entry)
        case .custom:
            labelRow(entry)
        }
    }

    @ViewBuilder
    private func toggleRow(_ entry: SettingEntry) -> some View {
        let current = store.current(entry)
        HStack {
            Text(entry.label)
                .font(.manta(size: Metrics.type.body, weight: .medium))
                .foregroundColor(tokens.tx1)
            Spacer()
            Toggle("", isOn: Binding(
                get: { current == .bool(true) },
                set: { store.commit(entry, .bool($0)) }
            ))
            .labelsHidden()
            .tint(tokens.accent)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
    }

    @ViewBuilder
    private func segmentedRow(_ entry: SettingEntry) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text(entry.label)
                .font(.manta(size: Metrics.type.body, weight: .medium))
                .foregroundColor(tokens.tx1)
            let current = store.current(entry)
            HStack(spacing: Metrics.spacing.sp2) {
                ForEach(entry.options ?? [], id: \.value) { option in
                    let selected = selected(option.value, current: current, entry: entry)
                    Button {
                        store.commit(entry, .string(option.value))
                    } label: {
                        Text(option.label)
                            .font(.manta(size: Metrics.type.small))
                            .foregroundColor(selected ? tokens.onAccent : tokens.tx2)
                            .padding(.horizontal, Metrics.spacing.sp3)
                            .padding(.vertical, Metrics.spacing.sp2)
                            .background(
                                selected ? tokens.accentSolid : tokens.panel,
                                in: RoundedRectangle(cornerRadius: Metrics.radius.md)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: Metrics.radius.md)
                                    .stroke(selected ? tokens.accent : tokens.border, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(option.label)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
                Spacer()
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
    }

    private func selected(_ optionValue: String, current: SettingValue, entry: SettingEntry) -> Bool {
        switch current {
        case .string(let s): return s == optionValue
        case .number(let n): return n == (Double(optionValue) ?? -1)
        case .bool, .null: return false
        }
    }

    @ViewBuilder
    private func textRow(_ entry: SettingEntry) -> some View {
        CommitField(entry: entry, store: store, secure: false, tokens: tokens)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.vertical, Metrics.spacing.sp2)
    }

    @ViewBuilder
    private func passwordRow(_ entry: SettingEntry) -> some View {
        CommitField(entry: entry, store: store, secure: true, tokens: tokens)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.vertical, Metrics.spacing.sp2)
    }

    /// A non-interactive row for custom/path entries — shows the label + help so
    /// the schema entry is present, reachable and searchable without inventing a
    /// management UI beyond this stage's scope.
    @ViewBuilder
    private func labelRow(_ entry: SettingEntry) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            Text(entry.label)
                .font(.manta(size: Metrics.type.body, weight: .medium))
                .foregroundColor(tokens.tx1)
            if entry.help.isEmpty == false {
                Text(entry.help)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
    }

    // MARK: - Reset-all + undo

    private var resetAllFooter: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text("Reset all settings")
                .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
                .foregroundColor(tokens.tx2)
                .textCase(.uppercase)
            Text("Restore every setting to its default. This does not remove your box pairing or projects.")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
            Button {
                confirmReset = true
            } label: {
                Text("Reset all settings…")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.danger)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Metrics.spacing.sp3)
                    .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: Metrics.radius.md)
                            .stroke(tokens.danger.opacity(0.6), lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.top, Metrics.spacing.sp6)
    }

    private var resetAllSheet: some View {
        VStack(spacing: Metrics.spacing.sp3) {
            Image(systemName: "arrow.counterclockwise")
                .font(.system(size: Metrics.type.display))
                .foregroundColor(tokens.warn)
            Text("Reset all settings?")
                .font(.manta(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx1)
            Text("Every setting will return to its default. Your box pairing and projects are not affected. You can undo this right after.")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
                .multilineTextAlignment(.center)
            Button {
                confirmReset = false
                store.resetAll()
            } label: {
                Text("Reset")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Metrics.spacing.sp3)
                    .background(tokens.danger, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            }
            Button {
                confirmReset = false
            } label: {
                Text("Cancel")
                    .font(.manta(size: Metrics.type.small, weight: .medium))
                    .foregroundColor(tokens.tx2)
                    .padding(Metrics.spacing.sp2)
            }
        }
        .padding(Metrics.spacing.sp4)
        .presentationDetents([.medium])
    }

    @ViewBuilder
    private var undoToast: some View {
        if let message = store.undoMessage {
            HStack(spacing: Metrics.spacing.sp2) {
                Text(message)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx1)
                Spacer()
                Button("Undo") {
                    store.undoLastReset()
                }
                .font(.manta(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(tokens.accent)
            }
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.vertical, Metrics.spacing.sp2)
            .background(tokens.raised, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radius.lg)
                    .stroke(tokens.border, lineWidth: 1)
            )
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp3)
        }
    }
}

// MARK: - Commit-on-blur field

/// A SwiftUI text/password field that keeps a local draft and commits to the
/// store on submit or blur (matching the retired implementation's commit-on-blur
/// credential/text fields). Re-syncs from the store only while not focused, so a
/// draft is never stomped mid-edit.
private struct CommitField: View {
    let entry: SettingEntry
    @ObservedObject var store: MantaSettingsStore
    let secure: Bool
    let tokens: Tokens

    @State private var draft = ""
    @FocusState private var focused: Bool
    @State private var savedAt: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            Text(entry.label)
                .font(.manta(size: Metrics.type.body, weight: .medium))
                .foregroundColor(tokens.tx1)
            Group {
                if secure {
                    SecureField(entry.placeholder ?? "", text: $draft)
                } else {
                    TextField(entry.placeholder ?? "", text: $draft)
                }
            }
            .font(.manta(size: Metrics.type.body))
            .foregroundColor(tokens.tx1)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.vertical, Metrics.spacing.sp2)
            .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radius.md)
                    .stroke(focused ? tokens.accent : tokens.border, lineWidth: 1)
            )
            .focused($focused)
            .onSubmit { commit() }
            .onChange(of: focused) { _, isFocused in
                if isFocused {
                    draft = textValue(current)
                } else {
                    commit()
                }
            }
            if let savedAt {
                Text("Saved \(savedAt.formatted(date: .omitted, time: .standard))")
                    .font(.manta(size: Metrics.type.twoXS))
                    .foregroundColor(tokens.ok)
            }
        }
        .onAppear { draft = textValue(current) }
        .onChange(of: current) { _, new in
            if !focused { draft = textValue(new) }
        }
    }

    private var current: SettingValue {
        store.current(entry)
    }

    private func textValue(_ value: SettingValue) -> String {
        if case .string(let s) = value { return s }
        return value.displayText
    }

    private func commit() {
        let trimmed = draft
        if trimmed != textValue(current) {
            store.commit(entry, .string(trimmed))
            if entry.commitOnBlur { savedAt = Date() }
        }
    }
}
