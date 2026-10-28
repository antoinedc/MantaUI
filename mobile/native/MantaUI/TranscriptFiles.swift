import SwiftUI
import QuickLook

// ===========================================================================
// WS01 F1 — the files attached to a user message, drawn as chips above the
// prompt (desktop `MessageRow` shows inert chips; iOS adds tap-to-open through
// QuickLook), plus the QuickLook presentation both this row and the media card
// use.
// ===========================================================================

extension View {
    /// Present a staged local file in QuickLook. The system sheet carries the
    /// share button (Save Image / Save to Files) and its own Done button, so no
    /// separate Download control is needed.
    func transcriptQuickLook(_ url: Binding<URL?>) -> some View {
        quickLookPreview(url)
    }
}

struct TranscriptUserFilesRow: View {
    let files: TranscriptUserFiles
    let tokens: Tokens

    @State private var stagingPartID: String?
    @State private var preview: URL?
    @State private var notice: String?
    @State private var noticeToken = 0

    var body: some View {
        VStack(alignment: .trailing, spacing: Metrics.spacing.sp1) {
            TranscriptFlowLayout(spacing: Metrics.spacing.sp1) {
                ForEach(files.refs, id: \.partID) { ref in
                    chip(ref)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            if let notice {
                Text(notice)
                    .font(.manta(size: Metrics.type.twoXS))
                    .foregroundColor(tokens.danger)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .transcriptQuickLook($preview)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transcript-user-files")
    }

    @ViewBuilder
    private func chip(_ ref: TranscriptFileRef) -> some View {
        let staging = stagingPartID == ref.partID
        let label = HStack(spacing: Metrics.spacing.sp1) {
            if staging {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: "paperclip")
                    .font(.system(size: Metrics.type.xs))
            }
            Text(ref.filename)
                .font(.manta(size: Metrics.type.xs, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .foregroundColor(tokens.tx3)
        .padding(.horizontal, Metrics.spacing.sp2)
        .frame(maxWidth: 260, minHeight: 36)
        .background(tokens.fill, in: RoundedRectangle(cornerRadius: Metrics.radius.xs))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.xs)
                .stroke(tokens.border, lineWidth: Metrics.spacing.spPx)
        )
        if case .none = ref.source {
            // Nothing to open: plain text, not a button that does nothing.
            label.accessibilityLabel("Attached file \(ref.filename)")
        } else {
            Button { open(ref) } label: { label.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .disabled(stagingPartID != nil)
                .accessibilityLabel("Attached file \(ref.filename)")
                .accessibilityHint("Opens the file")
        }
    }

    private func open(_ ref: TranscriptFileRef) {
        guard stagingPartID == nil else { return }
        stagingPartID = ref.partID
        Task {
            defer { stagingPartID = nil }
            do {
                preview = try await TranscriptFileStager.shared.localURL(
                    for: ref.source,
                    sizeHint: nil,
                    filename: ref.filename
                )
            } catch is CancellationError {
                // The staging cache was reset (a different box was paired): there
                // is nothing to show and nothing wrong — no change.
            } catch let failure as TranscriptFileFailure {
                if case .tooLarge = failure {
                    show("\(ref.filename) is too large to preview")
                } else {
                    show("Couldn\u{2019}t open \(ref.filename)")
                }
            } catch {
                show("Couldn\u{2019}t open \(ref.filename)")
            }
        }
    }

    /// An inline line under the row that clears itself after 4 s.
    private func show(_ message: String) {
        notice = message
        noticeToken += 1
        let token = noticeToken
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if token == noticeToken { notice = nil }
        }
    }
}

/// A wrapping, trailing-aligned row layout for the chips.
struct TranscriptFlowLayout: Layout {
    var spacing: CGFloat

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(maxWidth: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if needed > maxWidth, !current.indices.isEmpty {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let laidOut = rows(maxWidth: proposal.width ?? .infinity, subviews: subviews)
        let height = laidOut.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, laidOut.count - 1))
        let width = laidOut.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(maxWidth: bounds.width, subviews: subviews) {
            var x = bounds.maxX - row.width
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }
}
