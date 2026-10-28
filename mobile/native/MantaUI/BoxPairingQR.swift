import SwiftUI
import CoreImage.CIFilterBuiltins
import UIKit

// ===========================================================================
// WS10 F14 — the pairing QR, drawn natively with CoreImage (no third-party
// code). Error-correction level "M", scaled with nearest-neighbour so the
// modules stay crisp, on a white tile with a quiet zone — a camera needs the
// contrast regardless of the app's theme.
// ===========================================================================

struct BoxPairingQR: View {
    let text: String

    var body: some View {
        Group {
            if let image = Self.render(text) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .accessibilityLabel("Pairing QR code")
            } else {
                Text("Couldn't draw the QR code. Use the code and address below instead.")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(.black)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(Metrics.spacing.sp3)
        .background(Color.white, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .accessibilityIdentifier("box-pairing-qr")
    }

    /// The QR for `text`, or nil when CoreImage cannot produce one.
    static func render(_ text: String, scale: CGFloat = 10) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
