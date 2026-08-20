import Foundation
import UIKit

/// BET-1257 — DEBUG-only scroll probe for the subagent drill-in bug.
///
/// The parent and child transcripts share one `TranscriptListView` / `TiledView`
/// with byte-identical `TiledScrollPosition` config, yet the child has been
/// reported "completely locked" while the parent scrolls. `probe(tag:)` answers
/// WHICH view actually receives a touch in the middle of the transcript
/// (win.hitTest) and — the number that decides whether a finger can move it —
/// the **scrollable range** of every scroll view:
///
///     min   = -adjustedContentInset.top
///     max   =  contentSize.height + adjustedContentInset.bottom - frame.height
///     range =  max - min
///
/// A range ≈ 0 (or ≪ the content it shows) means there is nothing for a finger
/// to drag; a healthy range (thousands of points) means geometry is fine and a
/// real pan is needed to discriminate (BET-1257 §6).
///
/// The old BET-1211 probe's `setContentOffset` read-back is deliberately GONE:
/// `setContentOffset` does not clamp to the scrollable range, so reading the
/// offset back on the next line echoes what was just written — a tautology that
/// returned "healthy" on a scroll view with zero range. It measured nothing.
///
/// All output goes to `Documents/scroll-diagnostic.log` in the app sandbox, so
/// a simulator run can be diagnosed without a screenshot or a held-open
/// terminal:
///   cat "$(xcrun simctl get_app_container booted <bundle> data)/Documents/scroll-diagnostic.log"
///
/// Stateless per call; compiled out entirely in Release (no mutable global
/// state).
#if DEBUG
@MainActor
enum ScrollDiagnostic {
    private static var url: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("scroll-diagnostic.log")
    }

    /// Append a line to the shared diagnostic log (also used by PanProbe).
    static func write(_ s: String) {
        let text = s + "\n"
        guard let data = text.data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: url) {
            defer { try? h.close() }
            try? h.seekToEnd()
            try? h.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }

    /// The key window, or nil.
    static func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
            .first(where: { $0.isKeyWindow })
    }

    /// Every scroll view under `v`, deepest first.
    static func allScrollViews(_ v: UIView) -> [UIScrollView] {
        var out: [UIScrollView] = []
        if let s = v as? UIScrollView { out.append(s) }
        for sub in v.subviews { out += allScrollViews(sub) }
        return out
    }

    static func probe(tag: String) {
        write("=== probe[\(tag)] \(Date()) ===")
        guard let win = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).flatMap({ $0.windows })
            .first(where: { $0.isKeyWindow }) else {
            write("[\(tag)] no key window")
            return
        }

        // (a) WHO receives a touch in the middle of the transcript?
        let p = CGPoint(x: win.bounds.midX, y: win.bounds.midY)
        let hit = win.hitTest(p, with: nil)
        write("[\(tag)] hit=\(hit.map { String(describing: type(of: $0)) } ?? "nil") at \(Int(p.x)),\(Int(p.y))")

        var chain: [String] = []
        var v: UIView? = hit
        var depth = 0
        while let cur = v, depth < 25 {
            chain.append("\(type(of: cur))(ui=\(cur.isUserInteractionEnabled),a=\(cur.alpha),h=\(cur.isHidden),f=\(Int(cur.frame.width))x\(Int(cur.frame.height)))")
            v = cur.superview
            depth += 1
        }
        write("[\(tag)] chain=\(chain.joined(separator: " < "))")

        // (b) every scroll view's live state + its scrollable range
        for s in allScrollViews(win) {
            let min = -s.adjustedContentInset.top
            let max = s.contentSize.height + s.adjustedContentInset.bottom - s.frame.height
            let range = max - min
            write("[\(tag)] sv=\(type(of: s)) enabled=\(s.isScrollEnabled) ui=\(s.isUserInteractionEnabled) frame=\(Int(s.frame.width))x\(Int(s.frame.height)) content=\(Int(s.contentSize.width))x\(Int(s.contentSize.height)) off=\(s.contentOffset.y) adj=\(s.adjustedContentInset) min=\(Int(min)) max=\(Int(max)) range=\(Int(range)) panEnabled=\(s.panGestureRecognizer.isEnabled) grs=\(s.gestureRecognizers?.map { String(describing: type(of: $0)) } ?? [])")
        }
    }
}

/// BET-1257 §6 — DEBUG-only pan + offset recorder (Branch B: the geometry is
/// healthy, so only a real pan discriminates). Attaches an ADDITIVE target to
/// the existing scroll pan recogniser (it steals nothing) and a KVO observer on
/// `contentOffset`, both writing to `scroll-diagnostic.log`:
///
///     pan state=State tx=N ty=N v=(vx,vy) touches=N
///     off=<contentOffset.y>
///
/// Trace rows tell you WHERE a drag dies (§6 table):
///   • no `pan` lines at all (parent emits them) → touches never reach the
///     recogniser → hit-testing / touch delivery on the pushed screen.
///   • `pan` Began→Changed with translation, no `off=` → recogniser fires but
///     the scroll view refuses → clamping.
///   • `pan` Began then immediately Cancelled/Failed → another recogniser won.
///   • `pan` + `off=` both change, screen still frozen → rendering.
/// Retained in the shared singleton so the recorder survives the call that
/// starts it. One recorder at a time.
@MainActor
final class PanProbe {
    static let shared = PanProbe()
    private weak var scrollView: UIScrollView?
    private var observation: NSKeyValueObservation?
    private var tag = ""

    private init() {}

    /// Stop any previous recorder, then begin recording the tallest scroll view
    /// in the key window (the transcript). Tag prefixes every line.
    func start(tag: String) {
        stop()
        self.tag = tag
        ScrollDiagnostic.write("=== pan[\(tag)] \(Date()) ===")
        guard let win = ScrollDiagnostic.keyWindow(),
              let sv = ScrollDiagnostic.allScrollViews(win).max(by: { $0.contentSize.height < $1.contentSize.height }) else {
            ScrollDiagnostic.write("[\(tag)] no tall scroll view to record")
            return
        }
        scrollView = sv
        sv.panGestureRecognizer.addTarget(self, action: #selector(onPan(_:)))
        observation = sv.observe(\.contentOffset, options: [.new]) { [weak self] sv, _ in
            self?.off(sv.contentOffset.y)
        }
    }

    func stop() {
        if let sv = scrollView {
            sv.panGestureRecognizer.removeTarget(self, action: #selector(onPan(_:)))
        }
        observation?.invalidate()
        observation = nil
        scrollView = nil
        tag = ""
    }

    private func off(_ y: CGFloat) {
        ScrollDiagnostic.write("[\(tag)] off=\(Int(y))")
    }

    @objc private func onPan(_ gr: UIPanGestureRecognizer) {
        guard let sv = gr.view else { return }
        let t = gr.translation(in: sv)
        let v = gr.velocity(in: sv)
        ScrollDiagnostic.write("[\(tag)] pan state=\(gr.state.rawValue) tx=\(Int(t.x)) ty=\(Int(t.y)) v=(\(Int(v.x)),\(Int(v.y))) touches=\(gr.numberOfTouches)")
    }
}
#endif
