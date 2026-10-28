import SwiftUI
import UIKit

// ===========================================================================
// "Your box is upgrading" (OpenCode V2 cutover, slice C4).
//
// The iPhone's view of the box's upgrade (contract K3): overall progress, the
// steps with a status each, the current step's own bar and the ETA, and — on a
// failure — what went wrong and the disk numbers, with the desktop's actions
// (WS10 F19): Retry / Check again, Roll back (behind a confirm) and Copy
// details. Running and rolled-back states offer Copy details only. Every action
// reports its outcome under the buttons.
//
// It covers the whole app and is not dismissible: while a box migrates, every
// data route answers 503, so there is nothing behind it to reach. It leaves by
// itself when the box says it is done (`UpgradeStore.screen` becomes nil).
// Every value resolves through the generated tokens — no colour/size literal.
// ===========================================================================

struct UpgradeScreen: View {
    let model: UpgradeScreenModel
    let tokens: Tokens

    @EnvironmentObject private var upgradeStore: UpgradeStore
    @State private var confirmRollback = false
    @State private var copied = false

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

                    if model.kind == .failed { failureActions }
                    if model.kind == .running || model.kind == .rolledBack { copyDetailsRow }

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
        .onChange(of: model.details) { _, _ in copied = false }
        .confirmationDialog("Roll the box back?", isPresented: $confirmRollback, titleVisibility: .visible) {
            Button("Roll back", role: .destructive) {
                Task { await upgradeStore.rollback() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The box returns to the previous version with your original history, which the upgrade did not change. Conversations started since the upgrade will not appear in the previous version. You will then need to reinstall the previous desktop version.")
        }
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
            if model.nothingChanged {
                Text("Nothing was changed — your box is exactly as it was.")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
                    .accessibilityIdentifier("upgrade-nothing-changed")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Actions (WS10 F19)

    private var busy: Bool { model.retry.isPending || model.rollback.isPending }

    private var failureActions: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            HStack(spacing: Metrics.spacing.sp3) {
                Button {
                    Task { await upgradeStore.retry() }
                } label: {
                    HStack(spacing: Metrics.spacing.sp2) {
                        if model.retry.isPending { ProgressView().tint(tokens.onAccent) }
                        Text(retryTitle)
                    }
                    .font(.manta(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(tokens.onAccent)
                    .padding(.horizontal, Metrics.spacing.sp5)
                    .padding(.vertical, Metrics.spacing.sp3)
                    .background(tokens.accentSolid, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
                }
                .buttonStyle(.plain)
                .disabled(!model.canRetry || busy)
                .opacity(!model.canRetry || busy ? 0.4 : 1)
                .accessibilityIdentifier("upgrade-retry")

                if model.canRollback {
                    Button {
                        confirmRollback = true
                    } label: {
                        HStack(spacing: Metrics.spacing.sp2) {
                            if model.rollback.isPending { ProgressView().tint(tokens.danger) }
                            Text(model.rollback.isPending ? "Rolling back…" : "Roll back")
                        }
                        .font(.manta(size: Metrics.type.body, weight: .semibold))
                        .foregroundColor(tokens.danger)
                        .padding(.horizontal, Metrics.spacing.sp5)
                        .padding(.vertical, Metrics.spacing.sp3)
                        .overlay(
                            RoundedRectangle(cornerRadius: Metrics.radius.lg)
                                .stroke(tokens.danger.opacity(0.6), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .opacity(busy ? 0.4 : 1)
                    .accessibilityIdentifier("upgrade-rollback")
                }
            }

            outcomeLine(model.retry, okText: model.retryOkText)
            outcomeLine(model.rollback, okText: UpgradeScreenModel.rollbackOkText)

            if !model.canRetry, let reason = model.retryDisabledReason {
                Text(reason)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
                    .accessibilityIdentifier("upgrade-retry-disabled-reason")
            }

            copyDetailsRow
        }
    }

    private var retryTitle: String {
        guard model.retry.isPending else { return model.retryLabel }
        return model.retryLabel == "Retry" ? "Retrying…" : "Checking…"
    }

    @ViewBuilder
    private func outcomeLine(_ outcome: UpgradeActionOutcome, okText: String) -> some View {
        if let line = outcome.line(okText: okText) {
            Text(line)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(outcome.isError ? tokens.danger : tokens.ok)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("upgrade-outcome")
        }
    }

    private var copyDetailsRow: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            Button {
                UIPasteboard.general.string = model.details
                copied = true
            } label: {
                Text("Copy details")
                    .font(.manta(size: Metrics.type.small, weight: .medium))
                    .foregroundColor(tokens.accentTx)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("upgrade-copy-details")
            if copied {
                Text("Copied to the clipboard")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.ok)
                    .accessibilityIdentifier("upgrade-copied")
            }
        }
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
