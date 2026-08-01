import SwiftUI

// Design tokens transcribed verbatim from spike/rn-ios/tokens.ts (sub-issue 01 section 5).
// fill/fillActive are the literal rgba() values from the CSS tokens.

struct Tokens {
    let canvas: Color
    let panel: Color
    let card: Color
    let raised: Color
    let inset: Color
    let borderSubtle: Color
    let border: Color
    let borderStrong: Color
    let tx1: Color
    let tx2: Color
    let tx3: Color
    let tx4: Color
    let accent: Color
    let accentTx: Color
    let accentSolid: Color
    let onAccent: Color
    let ok: Color
    let warn: Color
    let danger: Color
    let info: Color
    let fill: Color
    let fillActive: Color

    static func scheme(_ scheme: ColorScheme) -> Tokens {
        switch scheme {
        case .light:
            return lightTokens
        case .dark:
            return darkTokens
        @unknown default:
            return darkTokens
        }
    }

    // Light + dark token sets, transcribing spike/rn-ios/tokens.ts verbatim. Split
    // each scheme into a standalone returning function so the type checker resolves
    // the ~17 Color sub-expressions as distinct statements instead of one call that
    // exceeds its type-check budget (the compiler's own "break up the expression"
    // guidance).
    private static var lightTokens: Tokens {
        let canvas: Color = Color(hex: "#FAF9F7")
        let panel: Color = Color(hex: "#F2F0EC")
        let card: Color = Color(hex: "#FFFFFF")
        let raised: Color = Color(hex: "#EAE7E1")
        let inset: Color = Color(hex: "#F5F3EF")
        let borderSubtle: Color = Color(hex: "#E8E4DD")
        let border: Color = Color(hex: "#DAD5CC")
        let borderStrong: Color = Color(hex: "#857C6E")
        let tx1: Color = Color(hex: "#1A1815")
        let tx2: Color = Color(hex: "#48433C")
        let tx3: Color = Color(hex: "#665F55")
        let tx4: Color = Color(hex: "#8A8275")
        let accent: Color = Color(hex: "#2E6BFF")
        let accentTx: Color = Color(hex: "#1F55D6")
        let accentSolid: Color = Color(hex: "#1F55D6")
        let onAccent: Color = Color(hex: "#FFFFFF")
        let ok: Color = Color(hex: "#0A7A53")
        let warn: Color = Color(hex: "#8A5A08")
        let danger: Color = Color(hex: "#BE2F3C")
        let info: Color = Color(hex: "#0B6E85")
        let fill: Color = Color(red: 26/255, green: 24/255, blue: 21/255, opacity: 0.035)
        let fillActive: Color = Color(red: 26/255, green: 24/255, blue: 21/255, opacity: 0.09)
        return Tokens(
            canvas: canvas, panel: panel, card: card,
            raised: raised, inset: inset,
            borderSubtle: borderSubtle, border: border, borderStrong: borderStrong,
            tx1: tx1, tx2: tx2, tx3: tx3, tx4: tx4,
            accent: accent, accentTx: accentTx, accentSolid: accentSolid, onAccent: onAccent,
            ok: ok, warn: warn, danger: danger, info: info,
            fill: fill, fillActive: fillActive
        )
    }

    private static var darkTokens: Tokens {
        let canvas: Color = Color(hex: "#0B1020")
        let panel: Color = Color(hex: "#0F1526")
        let card: Color = Color(hex: "#151C33")
        let raised: Color = Color(hex: "#1C2440")
        let inset: Color = Color(hex: "#070B16")
        let borderSubtle: Color = Color(hex: "#222C49")
        let border: Color = Color(hex: "#33406B")
        let borderStrong: Color = Color(hex: "#5E6C9B")
        let tx1: Color = Color(hex: "#F2F5FA")
        let tx2: Color = Color(hex: "#BDC7DB")
        let tx3: Color = Color(hex: "#939FB8")
        let tx4: Color = Color(hex: "#6B7690")
        let accent: Color = Color(hex: "#5A88FF")
        let accentTx: Color = Color(hex: "#7BA0FF")
        let accentSolid: Color = Color(hex: "#5A88FF")
        let onAccent: Color = Color(hex: "#0B1020")
        let ok: Color = Color(hex: "#3DD9A4")
        let warn: Color = Color(hex: "#F0A934")
        let danger: Color = Color(hex: "#FF6B7A")
        let info: Color = Color(hex: "#49D7F5")
        let fill: Color = Color(red: 1, green: 1, blue: 1, opacity: 0.04)
        let fillActive: Color = Color(red: 1, green: 1, blue: 1, opacity: 0.10)
        return Tokens(
            canvas: canvas, panel: panel, card: card,
            raised: raised, inset: inset,
            borderSubtle: borderSubtle, border: border, borderStrong: borderStrong,
            tx1: tx1, tx2: tx2, tx3: tx3, tx4: tx4,
            accent: accent, accentTx: accentTx, accentSolid: accentSolid, onAccent: onAccent,
            ok: ok, warn: warn, danger: danger, info: info,
            fill: fill, fillActive: fillActive
        )
    }
}

extension Color {
    init(hex: String, opacity: Double = 1) {
        var hexSanitized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        hexSanitized = hexSanitized.hasPrefix("#") ? String(hexSanitized.dropFirst()) : hexSanitized
        var r: UInt64 = 0, g: UInt64 = 0, b: UInt64 = 0
        var int: UInt64 = 0
        Scanner(string: hexSanitized).scanHexInt64(&int)
        let length = hexSanitized.count
        if length == 6 {
            r = (int >> 16) & 0xFF
            g = (int >> 8) & 0xFF
            b = int & 0xFF
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: opacity
        )
    }
}