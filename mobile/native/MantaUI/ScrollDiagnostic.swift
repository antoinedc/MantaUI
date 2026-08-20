import Foundation
import UIKit

/// BET-1211 — DEBUG-only scroll probe for the subagent drill-in bug.
///
/// The parent and child transcripts share one `TranscriptListView` / `TiledView`
/// with byte-identical `TiledScrollPosition` config, yet the child has been
/// reported "completely locked" while the parent scrolls. `probe(tag:)` answers
/// WHICH view actually receives a touch in the middle of the transcript
/// (win.hitTest), dumps every scroll view's live state (isScrollEnabled,
/// contentSize vs frame, pan recogniser), and tests whether the biggest one can
/// move when the code asks.
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

    private static func line(_ s: String) {
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

    private static func allScrollViews(_ v: UIView) -> [UIScrollView] {
        var out: [UIScrollView] = []
        if let s = v as? UIScrollView { out.append(s) }
        for sub in v.subviews { out += allScrollViews(sub) }
        return out
    }

    static func probe(tag: String) {
        line("=== probe[\(tag)] \(Date()) ===")
        guard let win = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).flatMap({ $0.windows })
            .first(where: { $0.isKeyWindow }) else {
            line("[\(tag)] no key window")
            return
        }

        // (a) WHO receives a touch in the middle of the transcript?
        let p = CGPoint(x: win.bounds.midX, y: win.bounds.midY)
        let hit = win.hitTest(p, with: nil)
        line("[\(tag)] hit=\(hit.map { String(describing: type(of: $0)) } ?? "nil") at \(Int(p.x)),\(Int(p.y))")

        var chain: [String] = []
        var v: UIView? = hit
        var depth = 0
        while let cur = v, depth < 25 {
            chain.append("\(type(of: cur))(ui=\(cur.isUserInteractionEnabled),a=\(cur.alpha),h=\(cur.isHidden),f=\(Int(cur.frame.width))x\(Int(cur.frame.height)))")
            v = cur.superview
            depth += 1
        }
        line("[\(tag)] chain=\(chain.joined(separator: " < "))")

        // (b) every scroll view's live state
        for s in allScrollViews(win) {
            line("[\(tag)] sv=\(type(of: s)) enabled=\(s.isScrollEnabled) ui=\(s.isUserInteractionEnabled) frame=\(Int(s.frame.width))x\(Int(s.frame.height)) content=\(Int(s.contentSize.width))x\(Int(s.contentSize.height)) off=\(Int(s.contentOffset.y)) adj=\(s.adjustedContentInset) panEnabled=\(s.panGestureRecognizer.isEnabled) grs=\(s.gestureRecognizers?.map { String(describing: type(of: $0)) } ?? [])")
        }

        // (c) can the tallest scroll view move when the CODE asks?
        if let s = allScrollViews(win).max(by: { $0.contentSize.height < $1.contentSize.height }) {
            let before = s.contentOffset.y
            s.setContentOffset(CGPoint(x: 0, y: max(0, before - 400)), animated: false)
            let after = s.contentOffset.y
            line("[\(tag)] setOffset \(before) -> \(after)")
            // restore
            s.setContentOffset(CGPoint(x: 0, y: before), animated: false)
        }
    }
}
#endif
