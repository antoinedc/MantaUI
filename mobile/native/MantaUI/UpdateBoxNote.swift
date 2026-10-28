import SwiftUI

/// The static "Update your box to use this" note, with a "Box updates" shortcut into
/// Settings (WS11 D1). Shown where a surface needs a capability the connected box
/// does not advertise — never a dead control.
struct UpdateBoxNote: View {
    static let text = "Update your box to use this"

    /// false where Settings is unreachable (the blocking upgrade screen covers the app):
    /// a link there would be a dead control, so only the note is shown.
    var showsLink = true

    @EnvironmentObject private var navigator: MantaNavigator

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Self.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if showsLink {
                Button("Box updates") {
                    navigator.open(.settings(section: "updates"))
                }
                .font(.footnote)
            }
        }
        .accessibilityElement(children: .contain)
    }
}
