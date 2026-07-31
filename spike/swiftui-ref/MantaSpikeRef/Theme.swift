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
            return Tokens(
                canvas: Color("#FAF9F7"), panel: Color("#F2F0EC"), card: Color("#FFFFFF"),
                raised: Color("#EAE7E1"), inset: Color("#F5F3EF"),
                borderSubtle: Color("#E8E4DD"), border: Color("#DAD5CC"), borderStrong: Color("#857C6E"),
                tx1: Color("#1A1815"), tx2: Color("#48433C"), tx3: Color("#665F55"), tx4: Color("#8A8275"),
                accent: Color("#2E6BFF"), accentTx: Color("#1F55D6"), accentSolid: Color("#1F55D6"), onAccent: Color("#FFFFFF"),
                ok: Color("#0A7A53"), warn: Color("#8A5A08"), danger: Color("#BE2F3C"), info: Color("#0B6E85"),
                fill: Color(red: 26/255, green: 24/255, blue: 21/255, opacity: 0.035),
                fillActive: Color(red: 26/255, green: 24/255, blue: 21/255, opacity: 0.09)
            )
        case .dark:
            return Tokens(
                canvas: Color("#0B1020"), panel: Color("#0F1526"), card: Color("#151C33"),
                raised: Color("#1C2440"), inset: Color("#070B16"),
                borderSubtle: Color("#222C49"), border: Color("#33406B"), borderStrong: Color("#5E6C9B"),
                tx1: Color("#F2F5FA"), tx2: Color("#BDC7DB"), tx3: Color("#939FB8"), tx4: Color("#6B7690"),
                accent: Color("#5A88FF"), accentTx: Color("#7BA0FF"), accentSolid: Color("#5A88FF"), onAccent: Color("#0B1020"),
                ok: Color("#3DD9A4"), warn: Color("#F0A934"), danger: Color("#FF6B7A"), info: Color("#49D7F5"),
                fill: Color(red: 1, green: 1, blue: 1, opacity: 0.04),
                fillActive: Color(red: 1, green: 1, blue: 1, opacity: 0.10)
            )
        @unknown default:
            return .scheme(.dark)
        }
    }
}

extension Color {
    init(_ hex: String, opacity: Double = 1) {
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