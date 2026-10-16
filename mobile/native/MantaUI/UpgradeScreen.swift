import SwiftUI

// ===========================================================================
// "Your box is upgrading" (OpenCode V2 cutover, slice C4).
//
// The iPhone's READ-ONLY view of the box's upgrade (contract K3): overall
// progress, the steps with a status each, the current step's own bar and the
// ETA, and — on a failure — what went wrong and the disk numbers. There are
// deliberately NO buttons: Retry / Roll back live on the desktop, and a control
// that cannot act from here would be a lie. The failed state says where to act.
//
// It covers the whole app and is not dismissible: while a box migrates, every
// data route answers 503, so there is nothing behind it to reach. It leaves by
// itself when the box says it is done (`UpgradeStore.screen` becomes nil).
// Every value resolves through the generated tokens — no colour/size literal.
// ===========================================================================

struct UpgradeScreen: View {
    let model: UpgradeScreenModel
    let tokens: Tokens

    var body: some View {
        ZStack {
            tokens.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp5) {
                    VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                        Text(model.title)
                            .font(.manta(size: Metrics.type.display, weight: .semibold))
                            .foregroundColor(tokens.tx1)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("upgrade-title")
                        Text(model.message)
                            .font(.manta(size: Metrics.type.body))
                            .foregroundColor(tokens.tx3)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if model.kind == .failed { failureBlock }
                    if model.kind == .waiting { waitingBlock }
                    if let overall = model.overall, model.kind == .running { overallBlock(overall) }
                    if !model.steps.isEmpty { stepsBlock }

                    if let hint = model.hint {
                        Text(hint)
                            .font(.manta(size: Metrics.type.small))
                            .foregroundColor(tokens.tx3)
                            .accessibilityIdentifier("upgrade-hint")
                    }
                }
                .padding(Metrics.spacing.sp5)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("upgrade-screen")
    }

    // MARK: - Pieces

    private var waitingBlock: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            ProgressView().tint(tokens.accent)
            Text("Waiting for the box…")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
        }
    }

    private func overallBlock(_ overall: Double) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            ProgressView(value: overall)
                .tint(tokens.accent)
                .accessibilityLabel("Overall upgrade progress")
                .accessibilityValue("\(Int((overall * 100).rounded())) percent")
            HStack {
                Text("\(Int((overall * 100).rounded()))% complete")
                Spacer()
                if let eta = model.eta { Text(eta) }
            }
            .font(.manta(size: Metrics.type.small))
            .foregroundColor(tokens.tx3)
        }
    }

    private var failureBlock: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            if let disk = model.disk {
                Text(UpgradePresentation.sentence(disk))
                    .font(.manta(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(tokens.danger)
                    .accessibilityIdentifier("upgrade-disk")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var stepsBlock: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            ForEach(model.steps) { step in
                stepRow(step)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Upgrade steps")
    }

    private func stepRow(_ step: UpgradeStep) -> some View {
        HStack(alignment: .top, spacing: Metrics.spacing.sp3) {
            stepGlyph(step.status)
                .frame(width: Metrics.spacing.sp5, alignment: .center)
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                Text(step.label)
                    .font(.manta(size: Metrics.type.body))
                    .foregroundColor(stepTextColor(step.status))
                if step.status == .running {
                    // The CURRENT step's own bar: determinate when the box reports
                    // numerator/denominator, an indeterminate spinner otherwise.
                    if let fraction = UpgradePresentation.fraction(step) {
                        ProgressView(value: fraction)
                            .tint(tokens.accent)
                            .accessibilityLabel("\(step.label) progress")
                            .accessibilityValue("\(Int((fraction * 100).rounded())) percent")
                    } else {
                        ProgressView().tint(tokens.accent)
                    }
                    if let caption = step.progress?.label {
                        Text(caption)
                            .font(.manta(size: Metrics.type.xs))
                            .foregroundColor(tokens.tx3)
                    }
                }
                if step.status == .failed, let error = step.error {
                    Text(error)
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.danger)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("upgrade-step-\(step.id)")
    }

    @ViewBuilder
    private func stepGlyph(_ status: UpgradeStepStatus) -> some View {
        switch status {
        case .done:
            Image(systemName: "checkmark").foregroundColor(tokens.ok)
        case .running:
            Image(systemName: "circle.dotted").foregroundColor(tokens.accent)
        case .failed:
            Image(systemName: "xmark").foregroundColor(tokens.danger)
        case .pending:
            Image(systemName: "circle").foregroundColor(tokens.tx4)
        }
    }

    private func stepTextColor(_ status: UpgradeStepStatus) -> Color {
        switch status {
        case .pending: return tokens.tx4
        case .failed: return tokens.danger
        case .running, .done: return tokens.tx1
        }
    }
}
