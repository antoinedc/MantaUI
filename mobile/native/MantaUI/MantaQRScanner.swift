@preconcurrency import AVFoundation
import SwiftUI
import UIKit

// ===========================================================================
// BET-702 — in-app QR scanner for the S2 pairing entry screen.
//
// AVCaptureMetadataOutput with `.qr` metadata — deliberately NOT
// `DataScannerViewController` and no added dependency (AVCapture is the
// decision). The scanner is a full-screen sheet with its own Cancel button.
//
// Responsibilities are split:
//   • MantaQRScannerViewController — owns the AVCaptureSession + preview, and
//     reports raw decoded strings + camera-permission state. It does NOT parse.
//   • MantaQRScannerSheet — the SwiftUI shell: renders the camera, the Cancel
//     button, a transient "Not a Manta pairing code" hint for a non-payload QR,
//     and an inline permission-denied hint pointing at the manual code entry.
//     It feeds a decoded string through the EXISTING MantaPairing.parsePairPayload
//     and only a parsed payload is handed to the onboarding flow.
// ===========================================================================

final class MantaQRScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    var onPermissionDenied: (() -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureAndStart()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.configureAndStart()
                    } else {
                        self?.onPermissionDenied?()
                    }
                }
            }
        default:
            // Denied / restricted — no camera feed; the sheet surfaces the
            // "type the code instead" hint.
            onPermissionDenied?()
        }
    }

    private func configureAndStart() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            onPermissionDenied?()
            return
        }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { onPermissionDenied?(); return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { onPermissionDenied?(); return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        } catch {
            onPermissionDenied?()
            return
        }
        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        let bounds = view.bounds
        let wasEmpty = bounds.isEmpty
        previewLayer.frame = bounds
        view.layer.insertSublayer(previewLayer, at: 0)
        self.previewLayer = previewLayer
        guard !wasEmpty else { return }
        // startRunning() blocks; run it off the main thread. Capture the session
        // so the background closure doesn't cross into main-actor isolation.
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    // MARK: - AVCaptureMetadataOutputObjectsDelegate
    // The metadata delegate is a nonisolated protocol requirement. The queue is
    // `.main`, so the callback genuinely runs on the main actor — assume it.
    // The non-Sendable AV objects stay in this nonisolated scope; only the
    // Sendable String crosses to the main actor.

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        for obj in metadataObjects {
            if let readable = obj as? AVMetadataMachineReadableCodeObject,
               readable.type == .qr,
               let value = readable.stringValue {
                MainActor.assumeIsolated {
                    onScan?(value)
                }
            }
        }
    }
}

struct MantaQRScannerView: UIViewControllerRepresentable {
    var onScan: (String) -> Void
    var onPermissionDenied: () -> Void

    func makeUIViewController(context: Context) -> MantaQRScannerViewController {
        let vc = MantaQRScannerViewController()
        vc.onScan = onScan
        vc.onPermissionDenied = onPermissionDenied
        return vc
    }

    func updateUIViewController(_ vc: MantaQRScannerViewController, context: Context) {
        // Re-sync the closures on every render so a late-started capture session
        // (permission resolved after an initial `make`) reports back to the
        // CURRENT handler, not the one captured at creation time.
        vc.onScan = onScan
        vc.onPermissionDenied = onPermissionDenied
    }
}

/// Reference-backed scanner state. The AVCapture delegate callbacks are handed
/// closures that mutate THIS shared instance (not a value-copied `@State`),
/// which is what lets the sheet re-render from a backgrounded representable.
@MainActor
final class MantaQRScannerModel: ObservableObject {
    @Published var permissionDenied = false
    @Published var nonMantaHint = false
}

struct MantaQRScannerSheet: View {
    var tokens: Tokens
    /// Invoked with a parsed Manta pairing payload (never a non-payload scan).
    var onPayload: (MantaPairing.PairPayload) -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = MantaQRScannerModel()
    @State private var hideHintTask: Task<Void, Never>?

    var body: some View {
        ZStack {
            MantaQRScannerView(
                onScan: handleScan,
                onPermissionDenied: { model.permissionDenied = true }
            )
            .ignoresSafeArea()

            VStack {
                HStack {
                    Spacer()
                    Button("Cancel") { dismiss() }
                        .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.semibold)))
                        .foregroundColor(tokens.onAccent)
                        .padding(.horizontal, Metrics.spacing.sp4)
                        .padding(.vertical, Metrics.spacing.sp2)
                        .background(tokens.inset, in: Capsule())
                }
                .padding(Metrics.spacing.sp4)
                Spacer()
                if model.permissionDenied {
                    Text("Camera access is off — enter the code by hand instead.")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx2)
                        .padding(Metrics.spacing.sp4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(tokens.card, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
                        .overlay(
                            RoundedRectangle(cornerRadius: Metrics.radius.lg)
                                .stroke(tokens.border, lineWidth: Metrics.spacing.spPx)
                        )
                        .padding(.horizontal, Metrics.spacing.sp6)
                        .padding(.bottom, Metrics.spacing.sp8)
                        .accessibilityIdentifier("scanner-permission-hint")
                } else if model.nonMantaHint {
                    Text("Not a Manta pairing code")
                        .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                        .foregroundColor(tokens.tx1)
                        .padding(.horizontal, Metrics.spacing.sp4)
                        .padding(.vertical, Metrics.spacing.sp3)
                        .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
                        .accessibilityIdentifier("scanner-nonmanta-hint")
                        .padding(.bottom, Metrics.spacing.sp8)
                }
            }
        }
    }

    private func handleScan(_ value: String) {
        if let payload = MantaPairing.parsePairPayload(value) {
            // Dismiss the sheet, then hand the payload to the flow — the same
            // receive path a deep link uses. Deferred so the sheet is fully
            // gone before the flow's phase advances.
            dismiss()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                onPayload(payload)
            }
        } else {
            // Not a Manta payload — keep scanning, show a transient hint.
            model.nonMantaHint = true
            hideHintTask?.cancel()
            hideHintTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if !Task.isCancelled { model.nonMantaHint = false }
            }
        }
    }
}
