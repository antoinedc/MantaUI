import SwiftUI
import UIKit

// Dynamic Type support (BET-751).
//
// The app draws reading text at design-token sizes (`Metrics.type.*`).
// `.font(.system(size:))` never scales, so on their own those sizes ignore the
// user's accessibility font-size preference. Every READING surface builds its
// font through `Font.manta(size:weight:design:)`, which keeps the design
// system's relative sizes but scales the base by the user's current
// content-size category (Settings → Accessibility → Display & Text Size) via
// `UIFontMetrics`. Icon and fixed-size-button CHROME deliberately stays on
// `.system(size:)` — scaling a glyph inside a fixed 38pt circle would clip it.
//
// The call sites keep reading `Metrics.type.*` as the base size, so a metric's
// name stays meaningful; only the font constructor changes.
extension Font {
    static func manta(
        size: CGFloat,
        weight: Font.Weight = .regular,
        design: Font.Design = .default
    ) -> Font {
        .system(
            size: MantaDynamicType.scaled(size),
            weight: weight,
            design: design
        )
    }
}

/// The Dynamic-Type-scaled form of a design-token base size. Reading surfaces
/// use this for derived geometry (line spacing, editor heights) so those scale
/// in lock-step with the text they accompany.
enum MantaDynamicType {
    static func scaled(_ size: CGFloat) -> CGFloat {
        UIFontMetrics.default.scaledValue(for: size)
    }
}
