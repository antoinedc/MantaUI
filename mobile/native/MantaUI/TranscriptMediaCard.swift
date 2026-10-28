import SwiftUI
import UIKit
import AVFoundation
import ImageIO

// ===========================================================================
// WS01 F1 — the card for an image or video the agent showed
// (`media_begin` / `media_show`).
//
// The reserved box is sized ONLY from `entry.reserved` (the geometry the begin
// declared, or the show measured), never from the state or the loaded file: the
// pending placeholder, the loading spinner, the finished picture and the failure
// label all draw inside the same box, so the transcript never jumps. The picture
// is letterboxed (`scaledToFit`) in it. A video shows a first-frame poster and
// plays only after a tap (QuickLook) — never autoplay.
//
// The box is an aspect-ratio view with a max width, rather than a measured
// width: `TranscriptMediaGeometry.maxWidth` is `min(520, 480 × aspect)`, which is
// exactly `box()`'s rule (cap the width, and shrink it when the height would pass
// 480), so no GeometryReader — and no first-layout height change — is needed.
// ===========================================================================

struct TranscriptMediaCardView: View {
    let entry: TranscriptMediaEntry
    let tokens: Tokens

    private enum Load {
        case idle
        case loading
        case ready(URL, UIImage?)
        case failed
        case tooLarge(Int64)
    }

    @State private var load: Load = .idle
    @State private var attempt = 0
    @State private var preview: URL?
    /// The column width the card was laid out in (see `box`).
    @State private var measuredWidth: CGFloat?
    @Environment(\.displayScale) private var displayScale

    private var aspect: Double { TranscriptMediaGeometry.aspect(entry.reserved) }
    private var maxBoxWidth: Double { TranscriptMediaGeometry.maxWidth(entry.reserved) }
    private var kindName: String { entry.kind == .video ? "Video" : "Image" }
    private var displayName: String {
        if let title = entry.title, !title.isEmpty { return title }
        if let path = entry.path, !path.isEmpty { return (path as NSString).lastPathComponent }
        return kindName.lowercased()
    }

    /// Restarts the load when the entry becomes ready, its file changes, or the
    /// user taps Try again.
    private var taskID: String {
        "\(entry.state == .ready ? "ready" : "other")|\(entry.path ?? "")|\(attempt)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            header
            box
            statusLine
        }
        .frame(maxWidth: Metrics.type.inlineMaxW, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: taskID) { await loadFile() }
        .transcriptQuickLook($preview)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transcript-media-card")
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: entry.kind == .video ? "video" : "photo")
                .font(.system(size: Metrics.type.xs))
                .foregroundColor(entry.state == .failed ? tokens.danger : tokens.tx3)
                .accessibilityHidden(true)
            Text(kindName)
                .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.semibold)))
                .foregroundColor(tokens.tx1)
            if let title = entry.title, !title.isEmpty {
                Text(title)
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx3)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: The reserved box

    /// The box is sized by `TranscriptMediaGeometry.box(_:availableWidth:)` from
    /// the measured column width, so every state draws at exactly the same size.
    /// Until the first measurement lands, an aspect-ratio view with the same max
    /// width stands in (same shape, so no visible step).
    @ViewBuilder
    private var box: some View {
        let frame = measuredWidth.map { TranscriptMediaGeometry.box(entry.reserved, availableWidth: Double($0)) }
        Group {
            if let frame {
                Color.clear.frame(width: CGFloat(frame.width), height: CGFloat(frame.height))
            } else {
                Color.clear
                    .aspectRatio(CGFloat(aspect), contentMode: .fit)
                    .frame(maxWidth: CGFloat(maxBoxWidth))
            }
        }
        .overlay { boxContent }
        .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.border, lineWidth: Metrics.spacing.spPx)
        )
        .clipShape(RoundedRectangle(cornerRadius: Metrics.radius.md))
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            if width > 0, measuredWidth != width { measuredWidth = width }
        }
    }

    @ViewBuilder
    private var boxContent: some View {
        switch entry.state {
        case .pending:
            pendingTiles
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Generating \(kindName.lowercased())")
        case .failed:
            label("\u{26A0} The media failed to generate")
        case .ready:
            readyContent
        }
    }

    /// One spinner, or up to four numbered tiles in two columns (+N more).
    @ViewBuilder
    private var pendingTiles: some View {
        let grid = TranscriptMediaGeometry.grid(count: entry.count)
        if grid.tiles <= 1 {
            ProgressView()
        } else {
            ZStack(alignment: .bottomTrailing) {
                Grid(horizontalSpacing: Metrics.spacing.sp1, verticalSpacing: Metrics.spacing.sp1) {
                    ForEach(Array(stride(from: 0, to: grid.tiles, by: 2)), id: \.self) { start in
                        GridRow {
                            tile(number: start + 1)
                            if start + 1 < grid.tiles {
                                tile(number: start + 2)
                            } else {
                                Color.clear
                            }
                        }
                    }
                }
                .padding(Metrics.spacing.sp2)
                if grid.more > 0 {
                    Text("+\(grid.more) more")
                        .font(.manta(size: Metrics.type.twoXS))
                        .foregroundColor(tokens.tx3)
                        .padding(Metrics.spacing.sp2)
                }
            }
        }
    }

    private func tile(number: Int) -> some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: Metrics.radius.xs).fill(tokens.fill)
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            Text("\(number)")
                .font(.manta(size: Metrics.type.twoXS))
                .foregroundColor(tokens.tx4)
                .padding(Metrics.spacing.sp1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var readyContent: some View {
        switch load {
        case .idle, .loading:
            ProgressView()
        case .ready(let url, let image):
            Button { preview = url } label: {
                ZStack {
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                    } else {
                        Image(systemName: entry.kind == .video ? "video" : "photo")
                            .font(.system(size: 28))
                            .foregroundColor(tokens.tx4)
                    }
                    if entry.kind == .video {
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 44))
                            .foregroundColor(.white)
                            .shadow(radius: 4)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(kindName): \(displayName)")
            .accessibilityHint(entry.kind == .video ? "Plays the video" : "Opens the full image")
        case .failed:
            VStack(spacing: Metrics.spacing.sp2) {
                label("\u{26A0} Couldn\u{2019}t load this media")
                Button("Try again") {
                    load = .idle
                    attempt += 1
                }
                .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                .foregroundColor(tokens.accent)
                .frame(minHeight: 44)
            }
        case .tooLarge(let bytes):
            label("\u{26A0} Too large to preview here (\(Self.sizeLabel(bytes)))")
        }
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(.manta(size: Metrics.type.small))
            .foregroundColor(entry.state == .failed ? tokens.danger : tokens.tx3)
            .multilineTextAlignment(.center)
            .padding(Metrics.spacing.sp2)
    }

    // MARK: Status line

    /// Below the box. It has the same height in EVERY state, so the pending →
    /// ready change cannot move the rows under it.
    private var statusLine: some View {
        HStack(spacing: Metrics.spacing.sp1) {
            if entry.state == .pending {
                Text("Generating \(kindName.lowercased())")
                    .foregroundColor(tokens.tx3)
                if let began = entry.beganAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(TranscriptTurnFormat.duration(ms: max(0, context.date.timeIntervalSince(began) * 1000)))
                            .monospacedDigit()
                            .foregroundColor(tokens.tx3)
                    }
                }
                Text("\u{00B7} this usually takes a few seconds")
                    .foregroundColor(tokens.tx4)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .font(.manta(size: Metrics.type.twoXS))
        .frame(height: 16)
    }

    // MARK: Loading

    private func loadFile() async {
        guard entry.state == .ready, let path = entry.path else {
            load = .idle
            return
        }
        load = .loading
        do {
            let url = try await TranscriptFileStager.shared.localURL(
                for: .boxPath(path),
                sizeHint: entry.size,
                filename: nil
            )
            let poster = await TranscriptMediaThumbnail.make(
                url: url,
                kind: entry.kind,
                maxPixel: CGFloat(TranscriptMediaGeometry.inlineMaxWidth) * displayScale
            )
            guard !Task.isCancelled else { return }
            load = .ready(url, poster)
        } catch is CancellationError {
            // The view went away or the cache was reset: no change. A re-appearing
            // card restarts this task.
            return
        } catch let failure as TranscriptFileFailure {
            if case .tooLarge(let bytes) = failure {
                load = .tooLarge(bytes)
            } else {
                load = .failed
            }
        } catch {
            load = .failed
        }
    }

    private static func sizeLabel(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

/// Builds the picture a card draws: a downsampled image (ImageIO reads only what
/// it needs — the full bitmap is never decoded into a cell) or a video's first
/// frame. Runs off the main actor; nil when the file cannot be drawn (an SVG, an
/// unreadable video), in which case the card shows a tappable tile and
/// QuickLook still opens it.
enum TranscriptMediaThumbnail {
    nonisolated static func make(url: URL, kind: TranscriptMediaKind, maxPixel: CGFloat) async -> sending UIImage? {
        switch kind {
        case .image: return downsampledImage(url: url, maxPixel: maxPixel)
        case .video: return await videoPoster(url: url, maxPixel: maxPixel)
        }
    }

    nonisolated private static func downsampledImage(url: URL, maxPixel: CGFloat) -> UIImage? {
        let sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions as CFDictionary) else { return nil }
        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    nonisolated private static func videoPoster(url: URL, maxPixel: CGFloat) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxPixel, height: maxPixel)
        guard let result = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: result.image)
    }
}
