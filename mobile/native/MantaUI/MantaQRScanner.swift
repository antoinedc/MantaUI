@preconcurrency import AVFoundation
import SwiftUI
import UIKit

// ===========================================================================
// BET-702 / BET-1308 — in-app QR scanner for the S2 pairing entry screen.
//
// AVCaptureMetadataOutput with `.qr` metadata — deliberately NOT
// `DataScannerViewController` and no added dependency (AVCapture is the
// decision). The scanner is an EMBEDDED panel on the entry screen (the
// full-screen sheet with a Cancel button is gone).
//
// Responsibilities are split:
//   • MantaQRScannerViewController — owns the AVCaptureSession + preview, and
//     reports raw decoded strings + one of three camera states. It does NOT
//     parse and holds no scan latch (BET-1308 moved the "already decoded a
//     payload" latch into the panel so a non-Manta QR never kills the scan).
//   • MantaCameraPanel — the SwiftUI shell: a fixed-size QR preview that also
//     renders an identical-size "Camera access is off" panel when the camera
//     is unavailable. It parses a decoded string through the EXISTING
//     MantaPairing.parsePairPayload, hands only a parsed payload to the
//     onboarding flow, and latches + stops the scanner once it produces one.
// ===========================================================================

final class MantaQRScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    var onState: ((MantaQRScannerModel.CameraState) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didConfigure = false
    private var didStart = false
    /// True once a Manta payload has been decoded (set by the panel). The
    /// camera must never restart after this.
    var didProducePayload = false

    override func viewDidLoad() {
        super.viewDidLoad()
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            onState?(.live)
            configureAndStart()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.onState?(.live)
                        self?.configureAndStart()
                    } else {
                        // Denied — one shared unavailable panel for every
                        // non-live state; no separate denied wording.
                        self?.onState?(.unavailable)
                    }
                }
            }
        default:
            // Denied / restricted / no camera device — one shared panel.
            onState?(.unavailable)
        }
    }

    /// Stop the capture session (the panel calls this once a payload has been
    /// produced so no further frames are processed). startRunning()/stopRunning()
    /// block, so both are dispatched off the main thread; the session is
    /// captured so the closure doesn't cross into main-actor isolation.
    func stopScanning() {
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async {
            if session.isRunning { session.stopRunning() }
        }
    }

    private func configureAndStart() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            onState?(.unavailable)
            return
        }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { onState?(.unavailable); return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { onState?(.unavailable); return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        } catch {
            onState?(.unavailable)
            return
        }
        didConfigure = true
        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        previewLayer.frame = view.bounds
        view.layer.insertSublayer(previewLayer, at: 0)
        self.previewLayer = previewLayer
        tryStartIfSized()
    }

    /// startRunning() blocks, so it is kicked off on a background queue — but
    /// only once the view actually has a size. An embedded SwiftUI container
    /// frequently lays out at zero first, so the guard `!view.bounds.isEmpty`
    /// is re-checked from `viewDidLayoutSubviews`; a `didStart` flag makes sure
    /// we start at most once.
    private func tryStartIfSized() {
        guard !didStart, didConfigure, !view.bounds.isEmpty else { return }
        didStart = true
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }
    }

    // MARK: - Lifecycle

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
        tryStartIfSized()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // A camera left running behind a pushed screen is a battery and privacy
        // problem; one we stopped on disappear must restart on the way back —
        // unless the panel has already produced a payload for good.
        guard didConfigure, didStart, !didProducePayload else { return }
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async {
            if !session.isRunning { session.startRunning() }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopScanning()
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
    var onState: (MantaQRScannerModel.CameraState) -> Void
    @ObservedObject var model: MantaQRScannerModel

    func makeUIViewController(context: Context) -> MantaQRScannerViewController {
        let vc = MantaQRScannerViewController()
        vc.onScan = onScan
        vc.onState = onState
        return vc
    }

    func updateUIViewController(_ vc: MantaQRScannerViewController, context: Context) {
        // Re-sync the closures on every render so a late-started capture session
        // (permission resolved after an initial `make`) reports back to the
        // CURRENT handler, not the one captured at creation time.
        vc.onScan = onScan
        vc.onState = onState
        // The panel latches here: once a payload has been produced, ask the
        // scanner to stop so no further frames are delivered.
        if model.hasProducedPayload {
            vc.didProducePayload = true
            vc.stopScanning()
        }
    }
}

/// Reference-backed scanner state. The AVCapture delegate callbacks are handed
/// closures that mutate THIS shared instance (not a value-copied `@State`),
/// which is what lets the panel re-render from a backgrounded representable.
@MainActor
final class MantaQRScannerModel: ObservableObject {
    enum CameraState {
        case pending
        case live
        case unavailable
    }

    @Published var camera: CameraState = .pending
    /// Set once the panel has parsed a Manta payload; further scans are ignored
    /// and the scanner is asked to stop.
    @Published var hasProducedPayload = false
}

/// A fixed-size QR camera panel, always present on the pairing entry screen.
/// The same frame is used for both live-camera and camera-unavailable states,
/// so the panel never resizes when permission is missing.
struct MantaCameraPanel: View {
    var tokens: Tokens
    var onPayload: (MantaPairing.PairPayload) -> Void

    @StateObject private var model = MantaQRScannerModel()

    var body: some View {
        Group {
            switch model.camera {
            case .pending, .live:
                MantaQRScannerView(
                    onScan: handleScan,
                    onState: { model.camera = $0 },
                    model: model
                )
            case .unavailable:
                unavailablePanel
            }
        }
        .frame(height: 240)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.lg)
                .stroke(tokens.border, lineWidth: Metrics.spacing.spPx)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding-camera-panel")
    }

    /// The exact-size stand-in for a missing / denied camera.
    private var unavailablePanel: some View {
        VStack(spacing: Metrics.spacing.sp3) {
            Image(systemName: "camera.fill")
                .font(.system(size: Metrics.type.body))
                .foregroundColor(tokens.tx4)
            Text("Camera access is off")
                .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                .foregroundColor(tokens.tx1)
            Text("Turn it on to scan the code from your desktop, or use Manual Setup below.")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
                .multilineTextAlignment(.center)
            Button("Open Settings") {
                openSettings()
            }
            .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.semibold)))
            .foregroundColor(tokens.onAccent)
            .padding(.horizontal, Metrics.spacing.sp4)
            .padding(.vertical, Metrics.spacing.sp2)
            .background(tokens.accentSolid, in: Capsule())
            .accessibilityIdentifier("onboarding-open-settings")
        }
        .padding(Metrics.spacing.sp4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(tokens.inset)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding-camera-denied")
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }

    /// Feed a decoded string through the existing parser; only a parsed Manta
    /// payload is handed to the flow. A non-Manta QR is silently ignored and
    /// keeps scanning (the latch below only latches on a parsed payload, so
    /// scanning a random QR first can never permanently kill the scanner).
    private func handleScan(_ value: String) {
        guard !model.hasProducedPayload else { return }
        if let payload = MantaPairing.parsePairPayload(value) {
            model.hasProducedPayload = true
            onPayload(payload)
        }
    }
}
