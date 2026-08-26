import SwiftUI
import UIKit

// ===========================================================================
// WidgetCard.swift — the inline widget card (`.mk-ios-live` conformance).
//
// A widget card is NOT a new component: it is the existing ToolCard shell
// (a header ribbon + an OutputWell-style body) — exactly how the desktop's
// MediaBody/WidgetBody render. The only genuinely new things here are what
// goes inside the well (a WKWebView instead of an <img>) and the four
// lifecycle states the meta slot names: live / snapshot / placeholder /
// stopped. Naming the state in the meta slot is required — without it a
// dimmed bitmap of a chart and a working chart look identical and people tap
// a picture expecting it to respond.
//
// Every state occupies the IDENTICAL reserved box (size from the declared
// width/height/aspectRatio — never measured from content), so nothing reflows
// when a widget activates, dies or restores.
//
// The card reads liveness from the box-wide `WidgetLiveStore` via the SwiftUI
// environment. A read-only surface (subagent drill-in, capture fixture) leaves
// the store unset and renders the inert placeholder.
// ===========================================================================

/// The four lifecycle states, named in the card's meta slot.
enum WidgetState: Equatable {
    case live
    case snapshot
    case placeholder
    case stopped

    var label: String {
        switch self {
        case .live: return "live"
        case .snapshot: return "snapshot"
        case .placeholder: return "placeholder"
        case .stopped: return "stopped"
        }
    }
}

/// The environment-provided entry point. Wires the live store when present,
/// else falls back to the inert placeholder (no live wiring, no webview).
struct WidgetCardView: View {
    @Environment(\.widgetLiveStore) private var liveStore
    let ref: WidgetRef
    let tokens: Tokens

    var body: some View {
        if let liveStore {
            LiveWidgetCard(store: liveStore, ref: ref, tokens: tokens)
        } else {
            InertWidgetCard(ref: ref, tokens: tokens)
        }
    }
}

/// The live, store-wired card. Holds the tap / expand behaviour and the expand
/// sheet; reports on-screen edges to the store so the live window's
/// screen-protection rule holds.
@MainActor
struct LiveWidgetCard: View {
    @ObservedObject var store: WidgetLiveStore
    let ref: WidgetRef
    let tokens: Tokens
    @State private var showSheet = false

    private var state: WidgetState {
        // Stopped first (the process is gone — never present a dead chart as
        // live), then live, then the captured snapshot, then placeholder.
        if store.isStopped(ref.id) { return .stopped }
        if store.isLive(ref.id) { return .live }
        if store.snapshot(for: ref.id) != nil { return .snapshot }
        return .placeholder
    }

    var body: some View {
        WidgetCardChrome(
            ref: ref,
            tokens: tokens,
            state: state,
            onActivate: {
                store.clearStopped(ref.id)
                store.activate(ref.id)
            },
            onExpand: {
                // The sheet is the only place a widget takes full interaction;
                // presenting it activates the widget like any other tap (it
                // counts against the live cap).
                store.activate(ref.id)
                showSheet = true
            },
            content: {
                switch state {
                case .live:
                    WidgetLiveWebView(ref: ref, liveStore: store, onReady: { _ in })
                case .snapshot:
                    WidgetDormantSurface(
                        ref: ref, tokens: tokens, state: .snapshot,
                        snapshot: store.snapshot(for: ref.id),
                        onActivate: { store.activate(ref.id) }
                    )
                case .placeholder:
                    WidgetDormantSurface(
                        ref: ref, tokens: tokens, state: .placeholder,
                        snapshot: nil,
                        onActivate: { store.activate(ref.id) }
                    )
                case .stopped:
                    WidgetDormantSurface(
                        ref: ref, tokens: tokens, state: .stopped,
                        snapshot: nil,
                        onActivate: {
                            store.clearStopped(ref.id)
                            store.activate(ref.id)
                        }
                    )
                }
            }
        )
        .onAppear { store.setOnScreen(ref.id, true) }
        .onDisappear { store.setOnScreen(ref.id, false) }
        .sheet(isPresented: $showSheet) {
            WidgetExpandSheet(ref: ref, tokens: tokens, liveStore: store)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("widget-card")
    }
}

/// A read-only surface's widget card: the same shell, forever in the
/// placeholder state with no live wiring and no actions.
struct InertWidgetCard: View {
    let ref: WidgetRef
    let tokens: Tokens

    var body: some View {
        WidgetCardChrome(
            ref: ref,
            tokens: tokens,
            state: .placeholder,
            onActivate: {},
            onExpand: {},
            content: {
                WidgetDormantSurface(
                    ref: ref, tokens: tokens, state: .placeholder,
                    snapshot: nil, onActivate: {}
                )
            }
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("widget-card")
    }
}

// MARK: - The chrome (header + body)

/// The ToolCard-style shell: header ribbon (status dot, name, arg, state meta,
/// iOS-only expand button) above the reserved body box. `maxWidth` capped at
/// the `--inline-max-w` token so the widget's reading width matches every other
/// inline embed.
struct WidgetCardChrome<Body: View>: View {
    let ref: WidgetRef
    let tokens: Tokens
    let state: WidgetState
    let onActivate: () -> Void
    let onExpand: () -> Void
    @ViewBuilder var content: () -> Body

    var body: some View {
        VStack(spacing: 0) {
            header
            bodyContent
        }
        .background(tokens.panel)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: 1)
        )
        .frame(maxWidth: Metrics.type.inlineMaxW)
    }

    private var bodyContent: some View {
        content()
            .frame(maxWidth: .infinity)
            .background(tokens.inset)
            .overlay(alignment: .top) {
                Rectangle().fill(tokens.borderSubtle).frame(height: 1)
            }
    }

    private var header: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Circle()
                .fill(dotColor)
                .frame(width: Metrics.type.stepDot, height: Metrics.type.stepDot)
            Text("Widget")
                .font(.manta(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(tokens.tx1)
            Text(ref.title ?? "Widget")
                .font(.manta(size: Metrics.type.twoXS))
                .foregroundColor(tokens.tx3)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            // The meta slot names the state — required, not cosmetic.
            Text(state.label)
                .font(.manta(size: Metrics.type.twoXS))
                .foregroundColor(tokens.tx4)
            // iOS-only expand affordance (desktop widgets have no sheet).
            Button(action: onExpand) {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(tokens.tx3)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Expand widget")
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
    }

    private var dotColor: Color {
        switch state {
        case .live: return tokens.accent
        case .stopped: return tokens.danger
        case .snapshot, .placeholder: return tokens.tx4
        }
    }
}

// MARK: - Reserved box + dormant states

/// The reserved box: identical size for every state, so nothing reflows. The
/// width caps at `--inline-max-w`; the height comes from the widget's declared
/// width/height/aspectRatio (or a fixed default), never from rendered content.
struct WidgetBox<Content: View>: View {
    let ref: WidgetRef
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .frame(maxWidth: Metrics.type.inlineMaxW)
            .modifier(WidgetBoxSizeModifier(ref: ref))
    }
}

/// Applies the declared-size height (or aspectRatio) to the box.
private struct WidgetBoxSizeModifier: ViewModifier {
    let ref: WidgetRef

    func body(content: Content) -> some View {
        if let h = ref.height, h > 0 {
            content.frame(height: h)
        } else if let ratio = ref.aspectRatio, ratio > 0 {
            content.aspectRatio(ratio, contentMode: .fit)
        } else if let w = ref.width, w > 0 {
            content.frame(height: w)
        } else {
            content.frame(height: WidgetMetrics.defaultHeight)
        }
    }
}

/// A dormant state (placeholder / snapshot / stopped) filling the reserved box,
/// with its "tap to [activate|load|reload]" chip centered.
struct WidgetDormantSurface: View {
    let ref: WidgetRef
    let tokens: Tokens
    let state: WidgetState
    let snapshot: UIImage?
    let onActivate: () -> Void

    var body: some View {
        WidgetBox(ref: ref) { bodyContent }
            .contentShape(Rectangle())
            .onTapGesture { onActivate() }
            .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private var bodyContent: some View {
        ZStack {
            switch state {
            case .snapshot:
                if let snapshot {
                    // The captured bitmap, dimmed by the shared dormant-opacity
                    // token (both clients dim identically) + desaturated.
                    Image(uiImage: snapshot)
                        .resizable()
                        .scaledToFill()
                        .opacity(Metrics.type.widgetDormantOpacity)
                        .saturation(0.6)
                        .clipped()
                } else {
                    placeholderContent
                }
            case .placeholder:
                placeholderContent
            case .stopped:
                stoppedContent
            case .live:
                EmptyView()
            }
        }
        .overlay { chip }
        .clipped()
    }

    private var placeholderContent: some View {
        GeometryReader { geo in
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                skeletonBar(fraction: 0.42, width: geo.size.width)
                skeletonBar(fraction: 0.78, width: geo.size.width)
                skeletonBar(fraction: 0.61, width: geo.size.width)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }

    private var stoppedContent: some View {
        VStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(tokens.warn)
            Text("Widget stopped while the app was in the background.")
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.tx3)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
    }

    private func skeletonBar(fraction: CGFloat, width: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: Metrics.radius.full)
            .fill(tokens.fillActive)
            .frame(width: max(width * fraction, 20), height: Metrics.spacing.sp2)
    }

    @ViewBuilder
    private var chip: some View {
        if !chipText.isEmpty {
            WidgetChip(text: chipText, tokens: tokens)
        }
    }

    private var chipText: String {
        switch state {
        case .placeholder: return "Tap to load"
        case .snapshot: return "Tap to activate"
        case .stopped: return "Tap to reload"
        case .live: return ""
        }
    }

    private var accessibilityLabel: String {
        "Widget, \(state.label)"
    }
}

/// The pill that names the tap affordance on a dormant widget.
struct WidgetChip: View {
    let text: String
    let tokens: Tokens

    var body: some View {
        HStack(spacing: Metrics.spacing.sp1) {
            Image(systemName: "play.fill")
                .font(.system(size: 9))
            Text(text)
                .font(.manta(size: Metrics.type.xs, weight: .medium))
        }
        .foregroundColor(tokens.tx1)
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp1)
        .background(tokens.panel)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(tokens.borderStrong, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.25), radius: Metrics.spacing.sp2)
        .allowsHitTesting(false)
    }
}

// MARK: - Expand sheet (.mk-ios-sheet)

/// The full-screen sheet — the ONLY place a widget scrolls or takes real
/// interaction. It counts against the live cap like any other live widget (the
/// presenting card activates it). Its webview re-uses the same hardened
/// configuration but with scrolling enabled and it occupies the whole sheet,
/// not a fixed declared-size frame.
struct WidgetExpandSheet: View {
    let ref: WidgetRef
    let tokens: Tokens
    @ObservedObject var liveStore: WidgetLiveStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Metrics.spacing.sp2) {
                Text(ref.title ?? "Widget")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(tokens.tx3)
                        .frame(width: 28, height: 28)
                        .background(tokens.fill, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close widget")
            }
            .padding(.horizontal, Metrics.spacing.sp4)
            .padding(.vertical, Metrics.spacing.sp3)

            WidgetExpandWebView(ref: ref, liveStore: liveStore)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(tokens.inset)

            Text("sandboxed · no network · scrollable here")
                .font(.manta(size: Metrics.type.twoXS))
                .foregroundColor(tokens.tx4)
                .padding(.vertical, Metrics.spacing.sp4)
        }
        .background(tokens.panel.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("widget-sheet")
    }
}
