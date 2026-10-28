import SwiftUI

// ===========================================================================
// WS04 §1 — the one rename sheet: list rows, the chat overflow ("Rename
// session") and a project's group header all use it. Stock `Form`; the save is
// awaited and a rejection stays on screen with the box's reason.
// ===========================================================================

struct SessionRenameSheet: View {
    let title: String
    let initialName: String
    /// Returns nil on success, or the message to show. Receives the trimmed name.
    let onSave: (String) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(title: String, initialName: String, onSave: @escaping (String) async -> String?) {
        self.title = title
        self.initialName = initialName
        self.onSave = onSave
        _name = State(initialValue: initialName)
    }

    private var validated: String? {
        SessionRenameLogic.validated(name, current: initialName)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(save)
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save", action: save)
                            .disabled(validated == nil)
                    }
                }
            }
            .disabled(saving)
            .onChange(of: name) { _, _ in error = nil }
        }
        .onAppear { focused = true }
    }

    private func save() {
        guard !saving, let value = validated else { return }
        saving = true
        error = nil
        Task {
            let failure = await onSave(value)
            saving = false
            if let failure {
                error = failure
            } else {
                dismiss()
            }
        }
    }
}
