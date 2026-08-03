import SwiftUI

// ===========================================================================
// Native Confirm action sheet (BET-628).
//
// The spec (DECISIONS.md:709-715) requires the destructive confirmation to be a
// NATIVE action sheet — never a web dialog — with the destructive item at the
// top and "Cancel detached at the bottom".
//
// On iOS 26 this cannot be produced by a system primitive: `confirmationDialog`
// and `UIAlertController(.actionSheet)` both render a compact, tap-outside-
// dismiss card that carries no separate Cancel (verified on-device, iPhone 17
// Pro / iOS 26.5). So this presents a compact native SwiftUI bottom sheet that
// renders the required layout exactly — destructive "Clear session" first, then
// a separated Cancel at the bottom. It is native (plain SwiftUI), never a web
// dialog, and keeps the visible Cancel the spec demands.
// ===========================================================================

/// A compact bottom-sheet confirmation styled as an action sheet: a destructive
/// item at the top, then a separated Cancel at the bottom.
struct ConfirmActionSheet: View {
    var title: String
    var message: String?
    var destructiveTitle: String
    var destructiveAction: () -> Void
    var cancelTitle: String = "Cancel"

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(.primary)
                if let message {
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 10)

            Button {
                dismiss()
                destructiveAction()
            } label: {
                Text(destructiveTitle)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Divider()

            Button {
                dismiss()
            } label: {
                Text(cancelTitle)
                    .font(.body)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .presentationDetents([.height(240)])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
        .presentationBackground(.regularMaterial)
    }
}

extension View {
    /// Presents a native confirm action sheet (destructive item first, a
    /// separated Cancel at the bottom) over the current screen. The sheet is
    /// attached to its own background node so it can present while the overflow
    /// sheet is already up.
    func confirmActionSheet(
        isPresented: Binding<Bool>,
        title: String,
        message: String? = nil,
        destructiveTitle: String,
        destructiveAction: @escaping () -> Void,
        cancelTitle: String = "Cancel"
    ) -> some View {
        background(
            Color.clear
                .sheet(isPresented: isPresented) {
                    ConfirmActionSheet(
                        title: title,
                        message: message,
                        destructiveTitle: destructiveTitle,
                        destructiveAction: destructiveAction,
                        cancelTitle: cancelTitle
                    )
                }
        )
    }
}
