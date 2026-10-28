import SwiftUI

// ===========================================================================
// WS04 §8 — "Uncommitted changes in this worktree". Shaped like
// `ConfirmActionSheet` (compact bottom sheet, destructive item first, a
// separated Cancel). One prompt is shown at a time; answering resolves exactly
// that prompt and the next one presents.
// ===========================================================================

struct SessionWorktreePromptSheet: View {
    let prompt: SessionWorktreePrompt
    let onDecision: (SessionWorktreeAnswer) -> Void

    var body: some View {
        let copy = SessionCloseCopy.dirtyWorktree(path: prompt.worktreePath)
        VStack(spacing: 0) {
            VStack(spacing: 6) {
                Text(copy.title)
                    .font(.headline)
                Text(copy.body)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 16)

            Divider()
            Button(role: .destructive) {
                onDecision(.remove)
            } label: {
                Text("Remove worktree")
                    .font(.body)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Divider()
            Button {
                onDecision(.keep)
            } label: {
                Text("Keep worktree")
                    .font(.body)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Divider()
            Button {
                onDecision(.cancel)
            } label: {
                Text("Cancel")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .presentationDetents([.height(330)])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
        .presentationBackground(.regularMaterial)
        .interactiveDismissDisabled()
    }
}
