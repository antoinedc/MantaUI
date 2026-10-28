import SwiftUI

/// The static "Update your box to use this" note, with a "Box updates" shortcut into
/// Settings (WS11 D1). Shown where a surface needs a capability the connected box
/// does not advertise — never a dead control.
struct UpdateBoxNote: View {
    static let text = "Update your box to use this"

    @EnvironmentObject private var navigator: MantaNavigator

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Self.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button("Box updates") {
                navigator.open(.settings(section: "updates"))
            }
            .font(.footnote)
        }
        .accessibilityElement(children: .combine)
    }
}
