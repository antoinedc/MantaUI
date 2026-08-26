import Foundation

// ===========================================================================
// WidgetModels.swift — inline-widget models + pure live-window logic.
//
// A widget is a model-authored, sandboxed HTML document announced to the
// clients on the `/events` bus as ONE kind (`widget`) with an `action`
// discriminator (only `show` today), carrying the served URL plus the same
// reserved-box dimension fields the media kind uses. The box spine
// (src/server/widgets.mjs) is the single source of the payload shape; this
// file holds the device-side mirror and the pure rules the live window is
// built on.
//
// ROW IDENTITY: a widget's stable identity is its `id` from the bus event —
// never an index and never a UUID minted at render time. Liveness is a
// property of the widget in a `@MainActor` store (WidgetLiveStore), NOT of the
// transcript cell, so a cell that scrolls away and back does not flicker a
// widget in and out of the live set. This file only contains the value-type
// decision maker; the store owns the state.
// ===========================================================================

/// The wallet-card reference carried by a `.file` transcript block's `.widget`
/// attachment kind. Equatable + Sendable so it flows through the pure block
/// mapping unchanged, and its `id` is the deterministic row identity.
struct WidgetRef: Equatable, Identifiable, Sendable {
    let id: String
    /// The served `https://<box>/widgets/<id>` URL. Could be nil on a partial
    /// frame; the live webview then falls back to the `manta-widget://<id>`
    /// URL derived from the id alone.
    let url: String?
    let title: String?
    /// Reserved-box dimensions taken from the bus payload. `width`/`height` in
    /// points, `aspectRatio` unitless. Height is never measured from content.
    let width: Double?
    let height: Double?
    let aspectRatio: Double?
    let sessionId: String?
    let messageId: String?

    init(id: String, url: String?, title: String?, width: Double?, height: Double?,
         aspectRatio: Double?, sessionId: String?, messageId: String?) {
        self.id = id
        self.url = url
        self.title = title
        self.width = width
        self.height = height
        self.aspectRatio = aspectRatio
        self.sessionId = sessionId
        self.messageId = messageId
    }
}

/// The wire payload of a `kind: "widget"` frame, mirroring exactly what
/// src/server/widgets.mjs publishes (id, url, title, width, height,
/// aspectRatio, sessionId, messageId — lowercase `d` routing fields, the
/// BET-1328 shared contract). Optional fields tolerate a partial frame.
struct WidgetPayload: Codable, Equatable, Sendable {
    var action: String
    var id: String?
    var url: String?
    var title: String?
    var width: Double?
    var height: Double?
    var aspectRatio: Double?
    var sessionId: String?
    var messageId: String?
}

// MARK: - The live window (pure)

/// The pure eviction decision for the widget live set.
///
/// All four rules of the design (see the issue) are test cases here:
///   1. Cap: at most `maxLive` widgets are live, box-wide, including tap-
///      activated ones.
///   2. Grant, don't recompute: a widget goes live on arrival and keeps it
///      until it is BOTH off-screen AND out of the newest-2. Nothing ever goes
///      dead while it is on screen.
///   3. A session open (a single `arriving` id) activates only the newest —
///      one web content process on open.
///   4. A memory warning drops the whole set to zero — that is a store action
///      (the store clears `live` out-of-band), not this function.
///
/// `existing` (ordered, oldest first) and `onScreen` are pure inputs; the
/// function neither stores nor derives liveness from the cell. The single
/// entry point the store funnels every mutation through, so the cap and the
/// screen protection cannot be bypassed by a call site.
enum WidgetLiveWindow {
    static let maxLive = 2

    static func resolve(existing: [String], arriving: String?, onScreen: Set<String>) -> [String] {
        var live = existing
        // Rule 2 + 3 grant: a single arriving widget goes live (the newest).
        if let arriving, !arriving.isEmpty, !live.contains(arriving) {
            live.append(arriving)
        }
        // Rule 1 builds the cap out of rule 2's eviction test: keep the newest
        // `maxLive` (they are live because they are new), plus anything on
        // screen (rule 2's "never torn out from under a finger" — the only
        // thing that may hold the set above the cap). Evict the rest, oldest
        // first, preserving arrival order.
        let newestLive = Set(live.suffix(maxLive))
        return live.filter { newestLive.contains($0) || onScreen.contains($0) }
    }
}

// MARK: - Reserved box (pure)

/// The canonical display height of a widget's reserved box, derived from the
/// _declared_ width/height/aspectRatio in the bus payload — never from
/// measured content, and never via a resize message. Every state (live,
/// snapshot, placeholder, stopped) occupies this SAME box so nothing reflows
/// when a widget activates, dies or restores. `availableWidth` is the row
/// width before the `maxWidth` cap (the `--inline-max-w` token) is applied.
enum WidgetMetrics {
    /// A pragmatic floor/fallback when a widget declares none of the height
    /// dimensions (keeps a placeholder from collapsing to a hairline).
    static let defaultHeight: CGFloat = 120

    static func height(ref: WidgetRef, availableWidth: CGFloat, maxWidth: CGFloat) -> CGFloat {
        let width = min(max(availableWidth, 0), maxWidth)
        if let h = ref.height, h > 0 { return h }
        if let ratio = ref.aspectRatio, ratio > 0 { return width / ratio }
        if let w = ref.width, w > 0 { return w }
        return defaultHeight
    }
}
