import SwiftUI
import WebKit
import UIKit

// ===========================================================================
// WidgetWebView.swift — the widget webview + its hardened configuration.
//
// The app's ONLY other WKWebView (`TerminalWebView`) is a TRUSTED-content
// webview and is deliberately NOT a template here: a widget is UNTRUSTED,
// model-authored HTML, so its webview gets its own configuration with no
// script-message handlers, a navigation policy gate, an assigned UI delegate,
// a non-persistent data store and no access to the terminal's shared store.
//
// The widget loads from `manta-widget://<id>` via a WKURLSchemeHandler — NOT
// `loadHTMLString` (which would not carry the response's CSP header) and NOT
// `loadFileURL` (a file:// origin would grant local read access). The scheme
// handler fetches the widget's bytes from the box's auth-exempt
// `GET /widgets/<id>` and returns them as an HTTPURLResponse carrying the
// box's Content-Security-Policy header through unchanged — the SAME policy
// that applies on the desktop client.
//
// The box token never goes near this webview: no URL query, no header. A
// widget's own scripts can read `document.location`; nothing authenticating
// the user is ever placed where they could reach it.
// ===========================================================================

/// WKURLSchemeTask is a main-thread-bound class that the compiler does not
/// treat as Sendable. The URLSession fetch completes off-main, so this thin
/// box lets the task cross to the fetch's completion handler. It wraps a
/// main-thread-only object and is touched ONLY on the main actor (every
/// mutating call lands inside a `MainActor.run`), so the `@unchecked
/// Sendable` claim is sound.
private final class WidgetSchemeTaskBox: @unchecked Sendable {
    let task: WKURLSchemeTask
    init(_ task: WKURLSchemeTask) { self.task = task }
}

/// Serves `manta-widget://<id>` by fetching `GET <server>/widgets/<id>`
/// (auth-exempt by design — an iframe/webview cannot send an Authorization
/// header, and the id is 256 bits of unguessable entropy) and replaying the
/// bytes with the box's CSP header preserved.
@MainActor
final class WidgetSchemeHandler: NSObject, WKURLSchemeHandler {
    let serverURL: URL?

    init(serverURL: URL?) {
        self.serverURL = serverURL
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let box = WidgetSchemeTaskBox(urlSchemeTask)
        guard let server = serverURL,
              let requestURL = urlSchemeTask.request.url,
              let id = requestURL.host, !id.isEmpty,
              let target = Self.widgetURL(server: server, id: id) else {
            fail(urlSchemeTask, box: box)
            return
        }
        Task { @MainActor in
            let result = await Self.fetch(target)
            self.deliver(result, url: requestURL, box: box)
        }
    }

    /// Fail a malformed scheme request without fabricating a URL (the request
    /// against the __box__ is what needs the real id; a bad one just errors).
    private func fail(_ task: WKURLSchemeTask, box: WidgetSchemeTaskBox) {
        if let url = task.request.url {
            deliver(.failure(MantaError.transport("bad widget request")), url: url, box: box)
        } else {
            box.task.didFailWithError(self.boxed(MantaError.transport("bad widget request")))
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // A one-shot fetch; there is nothing to cancel on stop.
    }

    /// The auth-exempt box URL for a widget id, used both to fetch the HTML
    /// and (as a fallback when the payload carried no `url`) as the served URL.
    static func widgetURL(server: URL?, id: String) -> URL? {
        guard let server else { return nil }
        var comps = URLComponents(url: server, resolvingAgainstBaseURL: false)
        comps?.path = "/widgets/\(id)"
        comps?.query = nil
        return comps?.url
    }

    private static func fetch(_ url: URL) async -> Result<(Data, Int, String?), Error> {
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let http = response as? HTTPURLResponse
            let csp = http?.value(forHTTPHeaderField: "Content-Security-Policy")
            return .success((data, http?.statusCode ?? 200, csp))
        } catch {
            return .failure(error)
        }
    }

    /// Replay the fetch onto the scheme task on the main actor. The CSP header
    /// from the box passes through UNCHANGED — that is what applies the same
    /// sandbox policy on both clients.
    private func deliver(_ result: Result<(Data, Int, String?), Error>, url: URL, box: WidgetSchemeTaskBox) {
        switch result {
        case .failure(let error):
            box.task.didFailWithError(self.boxed(error))
        case .success(let (data, statusCode, csp)):
            var headers: [String: String] = [:]
            headers["Content-Type"] = "text/html; charset=utf-8"
            if let csp, !csp.isEmpty {
                headers["Content-Security-Policy"] = csp
            }
            guard let response = HTTPURLResponse(
                url: url,
                statusCode: statusCode,
                httpVersion: nil,
                headerFields: headers
            ) else {
                box.task.didFailWithError(self.boxed(MantaError.transport("widget response")))
                return
            }
            box.task.didReceive(response)
            box.task.didReceive(data)
            box.task.didFinish()
        }
    }

    private func boxed(_ error: Error) -> NSError {
        if case MantaError.server(let message) = error {
            return NSError(domain: "manta.widget", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
        return error as NSError
    }
}

// MARK: - The widget host controller

/// Owns a single widget WKWebView with the hardened, untrusted-content
/// configuration. Lifecycle: created when the widget goes live, loaded from
/// `manta-widget://<id>`, and (for the inline card) reports process-termination
/// back to the live store so the card can fall back to the labelled `stopped`
/// state instead of a blank white rectangle.
@MainActor
final class WidgetWebViewController: UIViewController {
    let ref: WidgetRef
    /// The box-wide live store, used to mark the widget `stopped` when the web
    /// content process dies. Nil on read-only surfaces where nothing should
    /// mutate shared live state.
    let liveStore: WidgetLiveStore?
    private(set) var webView: WKWebView?
    /// Inline (transcript) webviews disable their own scrolling so they never
    /// fight the transcript's pan; the expand sheet is the one place a widget
    /// scrolls, and re-creates its controller with `scrollEnabled = true`.
    private let scrollEnabled: Bool

    init(ref: WidgetRef, liveStore: WidgetLiveStore?, scrollEnabled: Bool = false) {
        self.ref = ref
        self.liveStore = liveStore
        self.scrollEnabled = scrollEnabled
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let config = WKWebViewConfiguration()
        // Never the default persistent store, never shared with the terminal.
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(
            WidgetSchemeHandler(serverURL: KeychainCredentialStore.shared.serverURL),
            forURLScheme: "manta-widget"
        )
        // Deliberately NO WKUserContentController: every script-message handler
        // is a hole in the boundary, and this design needs none (height comes
        // from the declared dimensions, not from JS).

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.scrollView.isScrollEnabled = scrollEnabled
        webView.isOpaque = false
        webView.backgroundColor = .clear
        self.webView = webView
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let url = URL(string: "manta-widget://\(ref.id)") {
            webView?.load(URLRequest(url: url))
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // The widget is going dormant (evicted / scrolled out). Capture its
        // rendered bitmap at this moment so the card can show the labelled
        // `snapshot` state instead of leaving a live webview around. Inline
        // webviews only — the expand sheet's full-screen copy must not
        // overwrite the inline snapshot when it dismisses.
        guard !scrollEnabled else { return }
        captureSnapshot { [weak self] image in
            self?.liveStore?.captureSnapshot(id: self?.ref.id ?? "", image: image)
        }
    }

    /// Capture the webview's rendered bitmap (dormancy). Best-effort: if the
    /// capture fails or the process already died, the caller falls back to the
    /// placeholder state (the documented behaviour).
    func captureSnapshot(_ completion: @escaping (UIImage) -> Void) {
        webView?.takeSnapshot(with: nil) { image, _ in
            if let image { completion(image) }
        }
    }
}

// MARK: - Navigation policy gate

extension WidgetWebViewController: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // Allow only the initial `manta-widget://` load; `.cancel` every
        // subsequent navigation so the widget can never replace itself (or
        // navigate the frame) with a page of its choosing.
        if navigationAction.request.url?.scheme == "manta-widget",
           navigationAction.navigationType == .other {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The DEFAULT failure is a blank white rectangle (the most common way
        // embedded webviews look broken). Fall back to the labelled `stopped`
        // state instead — never leave a blank box on screen.
        liveStore?.markStopped(ref.id)
    }
}

// MARK: - UI delegate (deny modal chrome + window.open)

extension WidgetWebViewController: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        nil // deny window.open
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable () -> Void
    ) {
        completionHandler() // dismiss / no-op — no native-looking modal
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
    ) {
        completionHandler(false)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (String?) -> Void
    ) {
        completionHandler(nil)
    }
}

// MARK: - SwiftUI representable

/// Hosts an inline (live) widget webview. `onReady` hands back the underlying
/// controller so the card can capture a snapshot at the moment of eviction.
struct WidgetLiveWebView: UIViewControllerRepresentable {
    let ref: WidgetRef
    let liveStore: WidgetLiveStore?
    let onReady: (WidgetWebViewController) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onReady: onReady)
    }

    func makeUIViewController(context: Context) -> WidgetWebViewController {
        let controller = WidgetWebViewController(ref: ref, liveStore: liveStore)
        context.coordinator.onReady(controller)
        return controller
    }

    func updateUIViewController(_ uiViewController: WidgetWebViewController, context: Context) {}

    final class Coordinator {
        let onReady: (WidgetWebViewController) -> Void
        init(onReady: @escaping (WidgetWebViewController) -> Void) { self.onReady = onReady }
    }
}

/// The expand-sheet webview — the ONE place a widget scrolls. Same hardened
/// configuration, but with scrolling enabled and sized to fill the sheet.
struct WidgetExpandWebView: UIViewControllerRepresentable {
    let ref: WidgetRef
    let liveStore: WidgetLiveStore?

    func makeUIViewController(context: Context) -> WidgetWebViewController {
        WidgetWebViewController(ref: ref, liveStore: liveStore, scrollEnabled: true)
    }

    func updateUIViewController(_ uiViewController: WidgetWebViewController, context: Context) {}
}
