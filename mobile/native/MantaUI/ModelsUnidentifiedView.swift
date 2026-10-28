import SwiftUI
import Combine

// ===========================================================================
// WS09 F4 — "Models we couldn't identify". The rows, help lines, available
// actions and the declaration itself are the box's (`models:unidentified`,
// `models:declare`); the phone renders them, runs the catalogue typeahead (M12,
// KEEP-CLIENT) and sends the editor's form as typed.
// ===========================================================================

/// Which row the identify editor is open for (pre-selected to the box's match when it has one).
struct ModelsIdentifyTarget: Identifiable, Equatable {
    let key: String
    let label: String
    let catalogId: String?
    var id: String { key }
}

@MainActor
final class ModelsUnidentifiedStore: ObservableObject {
    enum Phase: Equatable {
        case loading
        case loaded(UnidentifiedList)
        case updateYourBox
        case failed(String)
    }

    enum CatalogPhase: Equatable {
        case idle
        case loading
        case loaded([ModelsCatalogEntryWire])
        case failed(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var busyKey: String?
    /// The box's confirmation / refusal for the last action (saved auto-clears).
    @Published private(set) var feedback: ModelsStore.Feedback?
    @Published var editor: ModelsIdentifyTarget?
    @Published private(set) var catalogPhase: CatalogPhase = .idle

    private let api: MantaAPIClient
    private let catalog: ChatModelCatalog
    private var cancellables: Set<AnyCancellable> = []
    private var feedbackSeq = 0
    private var started = false

    init(api: MantaAPIClient = .live(), catalog: ChatModelCatalog = .shared) {
        self.api = api
        self.catalog = catalog
    }

    func start() {
        guard !started else { return }
        started = true
        catalog.modelsUpdates
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in Task { await self?.refresh() } }
            .store(in: &cancellables)
        Task { await refresh() }
    }

    func stop() {
        cancellables.removeAll()
        started = false
    }

    func refresh() async {
        do {
            phase = .loaded(try await api.modelsUnidentified())
        } catch {
            if BoxCapabilities.isUnknownChannel(error) {
                phase = .updateYourBox
            } else if case .loaded = phase {
                // Keep the rows already shown.
            } else {
                phase = .failed(ModelsCapability.reason(error))
            }
        }
    }

    /// The catalogue behind the editor's typeahead, loaded on first use.
    func loadCatalogIfNeeded() async {
        if case .loaded = catalogPhase { return }
        catalogPhase = .loading
        do {
            let reply = try await api.modelCatalog()
            catalogPhase = .loaded(reply.entries)
        } catch {
            catalogPhase = .failed(ModelsCapability.reason(error))
        }
    }

    /// Confirm / candidate pick: `models:declare {key, catalogId}`.
    func declare(key: String, catalogId: String) async {
        _ = await run(key: key, showFieldErrors: true) { [api] in try await api.modelsDeclare(key: key, catalogId: catalogId) }
    }

    /// The editor's Save. Returns the box's reply so the form can show a `field`
    /// error under that field; nil when the call itself failed.
    func declare(key: String, form: ModelsDeclareForm) async -> ModelsDeclareReply? {
        await run(key: key) { [api] in try await api.modelsDeclare(key: key, form: form) }
    }

    func dismissFeedback() {
        feedbackSeq += 1
        feedback = nil
    }

    /// `showFieldErrors`: Confirm / pick have no form to put a `field` error under,
    /// so their refusal goes to the feedback bar; the editor shows it under the field.
    private func run(key: String, showFieldErrors: Bool = false,
                     _ call: @escaping () async throws -> ModelsDeclareReply) async -> ModelsDeclareReply? {
        guard busyKey == nil else { return nil }
        busyKey = key
        dismissFeedback()
        defer { busyKey = nil }
        do {
            let reply = try await call()
            if reply.ok {
                if let list = reply.list { phase = .loaded(list) } else { await refresh() }
                catalog.reload()
                show(.saved(reply.message))
            } else if reply.field == nil || showFieldErrors {
                show(.failed(reply.message))
            }
            return reply
        } catch {
            if BoxCapabilities.isUnknownChannel(error) {
                phase = .updateYourBox
            } else {
                // The write may have landed: say so rather than "nothing changed".
                show(.failed("Couldn't confirm the save — pull to refresh. (\(ModelsCapability.reason(error)))"))
            }
            return nil
        }
    }

    private func show(_ next: ModelsStore.Feedback) {
        feedbackSeq += 1
        feedback = next
        guard case .saved = next else { return }
        let seq = feedbackSeq
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, self.feedbackSeq == seq else { return }
            self.feedback = nil
        }
    }
}

// MARK: - Section

struct ModelsUnidentifiedSection: View {
    @ObservedObject var store: ModelsUnidentifiedStore

    var body: some View {
        switch store.phase {
        case .loading:
            EmptyView()
        case .updateYourBox:
            Section("Models we couldn't identify") {
                Text(ModelsCapability.updateYourBox).foregroundStyle(.secondary)
            }
        case .failed(let message):
            Section("Models we couldn't identify") {
                Text("Couldn't check your models — \(message)").foregroundStyle(.secondary)
                Button("Retry") { Task { await store.refresh() } }
            }
        case .loaded(let list):
            if !list.supported {
                Section("Models we couldn't identify") {
                    Text(list.intro).font(.footnote).foregroundStyle(.secondary)
                    if let unavailable = list.unavailableText {
                        Text(unavailable).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            } else if !list.rows.isEmpty {
                Section {
                    Text(list.intro).font(.footnote).foregroundStyle(.secondary)
                    ForEach(list.rows) { row in
                        UnidentifiedRowView(row: row, store: store)
                    }
                    Text(list.footer).font(.footnote).foregroundStyle(.secondary)
                } header: {
                    Text("Models we couldn't identify")
                }
            }
        }
    }
}

private struct UnidentifiedRowView: View {
    let row: UnidentifiedRowWire
    @ObservedObject var store: ModelsUnidentifiedStore

    private var busy: Bool { store.busyKey == row.key }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text(row.label).font(.callout.monospaced()).lineLimit(2)
            Text(row.help).font(.footnote).foregroundStyle(.secondary)
            HStack(spacing: Metrics.spacing.sp3) {
                if busy {
                    ProgressView()
                } else {
                    ForEach(row.actions, id: \.self) { action in actionView(action) }
                }
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, Metrics.spacing.sp1)
    }

    @ViewBuilder
    private func actionView(_ action: String) -> some View {
        switch action {
        case "confirm":
            if let catalogId = row.catalogId {
                Button("Confirm") { Task { await store.declare(key: row.key, catalogId: catalogId) } }
                    .disabled(store.busyKey != nil)
            }
        case "change":
            Button("Change") { open() }.disabled(store.busyKey != nil)
        case "identify":
            Button("Identify") { open() }.disabled(store.busyKey != nil)
        case "pick":
            if row.chips == true {
                Menu("Which one?") {
                    ForEach(row.candidates) { candidate in
                        Button(candidate.name) { Task { await store.declare(key: row.key, catalogId: candidate.id) } }
                    }
                }
                .disabled(store.busyKey != nil)
            } else {
                Button("Identify") { open() }.disabled(store.busyKey != nil)
            }
        default:
            EmptyView()
        }
    }

    private func open() {
        store.editor = ModelsIdentifyTarget(key: row.key, label: row.label, catalogId: row.catalogId)
    }
}

// MARK: - Editor

struct ModelsIdentifyForm: View {
    @ObservedObject var store: ModelsUnidentifiedStore
    let target: ModelsIdentifyTarget
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var query = ""
    @State private var selected: ModelsCatalogEntryWire?
    @State private var priceMode: String?
    @State private var costIn = ""
    @State private var costOut = ""
    @State private var caching = "none"
    @State private var reads = true
    @State private var writes = true
    @State private var fieldError: (field: String, message: String)?
    @State private var preselected = false
    @State private var saveError: String?

    private var entries: [ModelsCatalogEntryWire] {
        if case .loaded(let all) = store.catalogPhase { return all }
        return []
    }

    private var canSave: Bool {
        ModelsIdentifySearch.canSave(selected: selected, priceMode: priceMode, costIn: costIn, costOut: costOut)
    }

    var body: some View {
        NavigationStack {
            Form {
                modelSection
                priceSection
                cachingSection
                if let saveError {
                    Section { Text(saveError).font(.footnote).foregroundStyle(.red) }
                }
            }
            // The editor covers the list, so the box's refusal / a thrown save is
            // drawn here, where the user pressed Save.
            .safeAreaInset(edge: .bottom) {
                ModelsFeedbackBar(feedback: store.feedback, tokens: Tokens.scheme(colorScheme),
                                  retry: { Task { await store.refresh() } },
                                  dismiss: { store.dismissFeedback() })
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search the catalogue…")
            .navigationTitle("Identify")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if store.busyKey == target.key {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }.disabled(!canSave || store.busyKey != nil)
                    }
                }
            }
            .task {
                await store.loadCatalogIfNeeded()
                preselect()
            }
        }
        .presentationDetents([.large])
    }

    // MARK: Sections

    @ViewBuilder
    private var modelSection: some View {
        Section {
            Text(target.label).font(.callout.monospaced())
            switch store.catalogPhase {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                Text("Couldn't load the catalogue — \(message)").foregroundStyle(.secondary)
                Button("Retry") { Task { await store.loadCatalogIfNeeded(); preselect() } }
            case .loaded:
                let shown = ModelsIdentifySearch.filter(entries: entries, query: query)
                if shown.isEmpty { Text("No matches").foregroundStyle(.secondary) }
                ForEach(shown) { entry in
                    Button {
                        selected = entry
                        fieldError = nil
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.name ?? entry.id).foregroundStyle(.primary)
                                Text(entry.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if selected?.id == entry.id { Image(systemName: "checkmark") }
                        }
                    }
                }
            }
            if let error = fieldError, error.field == "catalogId" {
                Text(error.message).font(.footnote).foregroundStyle(.red)
            }
        } header: {
            Text("Which model is this?")
        } footer: {
            if let description = selected?.description, !description.isEmpty { Text(description) }
        }
    }

    private var priceSection: some View {
        Section {
            Picker("Costs here", selection: Binding(get: { priceMode ?? "" }, set: { priceMode = $0.isEmpty ? nil : $0 })) {
                Text("—").tag("")
                Text("Free").tag("free")
                Text("Custom").tag("custom")
            }
            .pickerStyle(.segmented)
            if priceMode == "custom" {
                TextField("In, $ per 1M tokens", text: $costIn).keyboardType(.decimalPad)
                TextField("Out, $ per 1M tokens", text: $costOut).keyboardType(.decimalPad)
            }
            if let error = fieldError, error.field == "price" {
                Text(error.message).font(.footnote).foregroundStyle(.red)
            }
        } header: {
            Text("Costs here")
        } footer: {
            Text("Choose Free, or enter at least one price.")
        }
    }

    private var cachingSection: some View {
        Section("Caching") {
            Picker("Caching", selection: $caching) {
                Text("None").tag("none")
                Text("Custom").tag("custom")
            }
            .pickerStyle(.segmented)
            if caching == "custom" {
                Toggle("Reads", isOn: $reads)
                Toggle("Writes", isOn: $writes)
            }
        }
    }

    // MARK: Actions

    private func preselect() {
        guard !preselected, selected == nil, let id = target.catalogId else { return }
        if let entry = entries.first(where: { $0.id == id }) {
            selected = entry
            preselected = true
        }
    }

    private func save() async {
        guard let selected else { return }
        fieldError = nil
        saveError = nil
        let form = ModelsDeclareForm(catalogId: selected.id, price: priceMode, costIn: costIn, costOut: costOut,
                                     caching: caching, reads: reads, writes: writes)
        guard let reply = await store.declare(key: target.key, form: form) else {
            // A thrown save already put its sentence in the bar; an older box or a
            // refused call has none, so the form says it itself.
            if store.feedback == nil { saveError = "Couldn't confirm the save — close this and pull to refresh." }
            return
        }
        if reply.ok {
            dismiss()
        } else if let field = reply.field {
            fieldError = (field, reply.message)
        }
    }
}
