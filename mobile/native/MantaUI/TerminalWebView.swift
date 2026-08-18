import SwiftUI
import WebKit
import UIKit
import Combine

// ===========================================================================
// S6 — the native terminal container (BET-598).
//
// Composes the pieces §9.2 calls for:
//   • the WKWebView hosting xterm.js (`TerminalContainerController`),
//   • the native key-row accessory (`TerminalKeyBarView`, attached to a
//     hidden `TerminalInputField` so it is a REAL inputAccessoryView and
//     tracks the keyboard's own animation — the one thing a webview can't do),
//   • the floating glass bar when the keyboard is closed,
//   • pinch-to-zoom → font size (persisted per device) with an announce,
//   • selection/copy + paste from bar, key row AND the hardware keyboard,
//   • hardware-keyboard pass-through including modifiers (the key row hides
//     automatically because an accessory never shows with a hardware keyboard),
//   • the native WebSocket to `/pty` (`TerminalSocket`), with reconnect so
//     returning to the foreground re-attaches without losing scrollback.
//
// The socket is native-owned; the webview never opens one.
// ===========================================================================

// MARK: - Hidden input field (drives the accessory + hardware keyboard)

@MainActor
final class TerminalInputField: UITextField, UITextFieldDelegate {
    var onInput: (String) -> Void = { _ in }
    var onCopy: () -> Void = {}
    var onPaste: () -> Void = {}
    var onSelectAll: () -> Void = {}

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        autocorrectionType = .no
        autocapitalizationType = .none
        smartQuotesType = .no
        smartDashesType = .no
        smartInsertDeleteType = .no
        spellCheckingType = .no
        keyboardType = .asciiCapable
        returnKeyType = .done
        // Keep the keyboard open affordance even for a zero-size field.
        isHidden = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func textField(_ textField: UITextField,
                   shouldChangeCharactersIn range: NSRange,
                   replacementString string: String) -> Bool {
        if string.isEmpty, range.length > 0 {
            onInput("\u{7f}")   // backspace / delete
        } else if string.count == 1 {
            onInput(string)
        }
        // Never surface the field's own text — we only forward the bytes.
        return false
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        onInput("\r")
        return false
    }

    // MARK: - Hardware keyboard (modifiers + navigation)

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for press in presses {
            guard let key = press.key else { continue }
            let flags = key.modifierFlags
            let chars = key.charactersIgnoringModifiers ?? ""
            let ch = chars.first
            if let ch {
                if flags.contains(.control) {
                    let seq = TerminalKeyInput.bytes(for: .char(String(ch)), ctrl: true)
                    onInput(seq)
                    handled = true
                } else if flags.contains(.command) {
                    switch ch.lowercased() {
                    case "c": onCopy()
                    case "v": onPaste()
                    case "a": onSelectAll()
                    default: break
                    }
                    handled = true
                } else {
                    onInput(String(ch))
                    handled = true
                }
            } else if let seq = Self.specialSequence(for: key.keyCode) {
                onInput(seq)
                handled = true
            }
        }
        if handled { return }
        super.pressesBegan(presses, with: event)
    }

    private static func specialSequence(for keyCode: UIKeyboardHIDUsage) -> String? {
        switch keyCode {
        case .keyboardReturn: return "\r"
        case .keyboardTab: return "\t"
        case .keyboardEscape: return "\u{1b}"
        case .keyboardRightArrow: return "\u{1b}[C"
        case .keyboardLeftArrow: return "\u{1b}[D"
        case .keyboardDownArrow: return "\u{1b}[B"
        case .keyboardUpArrow: return "\u{1b}[A"
        case .keyboardDeleteOrBackspace: return "\u{7f}"
        default: return nil
        }
    }
}

// MARK: - Floating glass bar (keyboard closed)

@MainActor
final class TerminalFloatingBarView: UIView {
    var onInterrupt: () -> Void = {}
    var onPaste: () -> Void = {}
    var onShowKeyboard: () -> Void = {}
    var onDictateBegan: () -> Void = {}
    var onDictateEnded: () -> Void = {}

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = UIColor(white: 0.12, alpha: 0.85)
        layer.cornerRadius = 22
        layer.cornerCurve = .continuous

        let interrupt = makeButton("interrupt", symbol: "stop.fill", danger: true)
        let paste = makeButton("paste", symbol: "doc.on.clipboard", danger: false)
        let keyboard = makeButton("keyboard", symbol: "keyboard", danger: false)
        let dictate = makeButton("dictate", symbol: "mic.fill", danger: false)

        interrupt.addTarget(self, action: #selector(tapInterrupt), for: .touchUpInside)
        paste.addTarget(self, action: #selector(tapPaste), for: .touchUpInside)
        keyboard.addTarget(self, action: #selector(tapKeyboard), for: .touchUpInside)

        // Dictate is hold-to-record.
        let long = UILongPressGestureRecognizer(target: self, action: #selector(dictateGesture(_:)))
        long.minimumPressDuration = 0.15
        dictate.addGestureRecognizer(long)

        let stack = UIStackView(arrangedSubviews: [interrupt, paste, keyboard, dictate])
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            bottomAnchor.constraint(equalTo: stack.bottomAnchor, constant: 8),
            stack.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private func makeButton(_ label: String, symbol: String, danger: Bool) -> UIButton {
        let b = UIButton(type: .system)
        var config = UIButton.Configuration.gray()
        config.image = UIImage(systemName: symbol)
        config.title = label
        config.imagePadding = 6
        config.baseForegroundColor = danger ? UIColor(red: 1, green: 0.4, blue: 0.4, alpha: 1) : .white
        config.background.backgroundColor = UIColor(white: 0.22, alpha: 1)
        config.cornerStyle = .medium
        b.configuration = config
        b.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
        b.translatesAutoresizingMaskIntoConstraints = false
        b.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        b.accessibilityLabel = label
        return b
    }

    @objc private func tapInterrupt() { onInterrupt() }
    @objc private func tapPaste() { onPaste() }
    @objc private func tapKeyboard() { onShowKeyboard() }

    @objc private func dictateGesture(_ g: UILongPressGestureRecognizer) {
        switch g.state {
        case .began: onDictateBegan()
        case .ended, .cancelled, .failed: onDictateEnded()
        default: break
        }
    }
}

// MARK: - Container controller

@MainActor
final class TerminalContainerController: UIViewController {
    let state: TerminalSessionState
    let projectName: String
    let windowName: String
    /// The tmux session / window this terminal belongs to.
    let sessionName: String
    private let windowIndex: Int
    private let defaultCwd: String

    /// The session's danger (red) accent, resolved from the generated tokens
    /// by the SwiftUI chrome — never a literal here.
    let dangerColor: UIColor
    private var cancellables = Set<AnyCancellable>()

    // Built once in setup() immediately after init and non-nil for the whole
    // lifetime of the view; making them optional would add a `?` to every use
    // site without removing any real nil case.
    // swiftlint:disable implicitly_unwrapped_optional
    private var webView: WKWebView!
    private var inputField: TerminalInputField!
    private var keyBar: TerminalKeyBarView!
    private var floatingBar: TerminalFloatingBarView!
    // swiftlint:enable implicitly_unwrapped_optional
    private var socket: TerminalSocket?
    private let api = MantaAPIClient.live()

    private var recorder: VoiceRecorder?
    private var dictateAvailable = false

    private var baseFont: Double = TerminalSessionState.storedFontSize()
    private var activePinchScale: CGFloat = 1

    init(state: TerminalSessionState, sessionName: String, windowIndex: Int, windowName: String, projectName: String, defaultCwd: String, danger: UIColor) {
        self.state = state
        self.sessionName = sessionName
        self.windowIndex = windowIndex
        self.windowName = windowName
        self.projectName = projectName
        self.defaultCwd = defaultCwd
        self.dangerColor = danger
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        view = UIView()
        view.backgroundColor = .black

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(WeakScriptMessageHandler(self), name: "manta")
        config.userContentController = controller
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.navigationDelegate = self
        webView.isUserInteractionEnabled = true
        view.addSubview(webView)

        // Pinch-to-zoom → font size (§9.2), persisted per device.
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        pinch.delegate = self
        webView.addGestureRecognizer(pinch)

        inputField = TerminalInputField(frame: .zero)
        keyBar = TerminalKeyBarView()
        inputField.inputAccessoryView = keyBar
        view.addSubview(inputField)

        // Hidden 1x1 field to anchor the keyboard + accessory.
        inputField.frame = CGRect(x: -10, y: 0, width: 1, height: 1)

        floatingBar = TerminalFloatingBarView()
        view.addSubview(floatingBar)

        wireCallbacks()
        layout()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        loadPage()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Do NOT raise the keyboard on entry: it covers half the terminal
        // before the user has read a single line, and the floating bar exists
        // precisely to offer the keyboard on demand (its ⌨ button calls
        // becomeFirstResponder), as does a tap on the terminal surface.
        floatingBar.isHidden = false
        socket?.reconnectNow()
        Task { await fetchDictateAvailability() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        socket?.close()
    }

    private func fetchDictateAvailability() async {
        guard !dictateAvailable else { return }
        // §5 S5 rule: the mic affordance is hidden when no Groq key is
        // configured. Best-effort read via the existing config RPC.
        if let config = try? await api.configGet(),
           let groq = ChatJSON.string(config["groqApiKey"]),
           !groq.isEmpty {
            dictateAvailable = true
        }
    }

    private func wireCallbacks() {
        inputField.onInput = { [weak self] text in
            self?.sendToShell(text)
        }
        inputField.onCopy = { [weak self] in self?.copySelection() }
        inputField.onPaste = { [weak self] in self?.paste() }
        inputField.onSelectAll = { [weak self] in self?.selectAllForCopy() }

        keyBar.onKey = { [weak self] key, ctrl in
            guard let self else { return }
            let bytes = TerminalKeyInput.bytes(for: key, ctrl: ctrl)
            self.sendToShell(bytes)
        }

        floatingBar.onInterrupt = { [weak self] in self?.sendToShell("\u{03}") }
        floatingBar.onPaste = { [weak self] in self?.paste() }
        floatingBar.onShowKeyboard = { [weak self] in self?.inputField.becomeFirstResponder() }

        // Tap the surface to type — the keyboard is no longer raised on entry,
        // so this is the second way in besides the bar's keyboard button.
        // `cancelsTouchesInView = false` keeps xterm's own selection working.
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleSurfaceTap))
        tap.cancelsTouchesInView = false
        webView.addGestureRecognizer(tap)
        floatingBar.onDictateBegan = { [weak self] in self?.dictateBegan() }
        floatingBar.onDictateEnded = { [weak self] in self?.dictateEnded() }

        // esc tints red while a process is running (§9.2). The SwiftUI chrome
        // derives `isRunning` from the session list store; the controller maps
        // it onto the accessory.
        state.$isRunning
            .receive(on: DispatchQueue.main)
            .sink { [weak self] running in self?.keyBar.escIsDanger = running }
            .store(in: &cancellables)
        keyBar.escIsDanger = state.isRunning

        NotificationCenter.default.addObserver(self,
            selector: #selector(keyboardWillChange(_:)),
            name: UIResponder.keyboardWillShowNotification, object: nil)
        NotificationCenter.default.addObserver(self,
            selector: #selector(keyboardWillChange(_:)),
            name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    private func layout() {
        webView.translatesAutoresizingMaskIntoConstraints = false
        floatingBar.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            floatingBar.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            floatingBar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
        ])
        floatingBar.isHidden = true
    }

    // MARK: - Page load + font

    private func loadPage() {
        // The folder reference keeps `terminal/` in the bundle; the root
        // fallback covers a build where the resources were flattened, because
        // the failure mode is invisible — a black webview with no terminal and
        // no error on screen.
        let url = Bundle.main.url(forResource: "terminal", withExtension: "html", subdirectory: "terminal")
            ?? Bundle.main.url(forResource: "terminal", withExtension: "html")
        guard let url else {
            state.connectionLabel = "terminal bundle missing"
            assertionFailure("terminal.html is not in the app bundle — check the Copy Bundle Resources phase")
            return
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func webViewDidFinish(_ wv: WKWebView) {
        let font = TerminalSessionState.storedFontSize()
        wv.evaluateJavaScript("window.__manta.setFontSize(\(font)); window.__manta.fit();") { [weak self] _, _ in
            self?.connectSocket()
        }
    }

    @objc private func handleSurfaceTap() {
        guard !inputField.isFirstResponder else { return }
        inputField.becomeFirstResponder()
    }

    // MARK: - Pinch to zoom (font size, §9.2)

    @objc private func handlePinch(_ g: UIPinchGestureRecognizer) {
        switch g.state {
        case .began:
            activePinchScale = 1
            baseFont = TerminalSessionState.storedFontSize()
        case .changed:
            let scale = g.scale / activePinchScale
            activePinchScale = g.scale
            let target = TerminalZoom.clamped(baseFont * Double(scale))
            webView.evaluateJavaScript("window.__manta.setFontSize(\(target))", completionHandler: nil)
        case .ended, .cancelled, .failed:
            let target = TerminalZoom.clamped(baseFont * Double(g.scale))
            TerminalSessionState.store(fontSize: target)
            let announced = Int(target.rounded())
            UIAccessibility.post(notification: .announcement, argument: "Terminal font \(announced)")
        default:
            break
        }
    }

    // MARK: - Socket

    private func sessionKey() -> String {
        // Stable per (session,window) so reconnect reuses/re-attaches.
        "\(sessionName):\(windowIndex)"
    }

    private func connectSocket() {
        let serverURL = KeychainCredentialStore.shared.serverURL ?? URL(string: "https://127.0.0.1")!
        let token = KeychainCredentialStore.shared.boxToken
        let key = sessionKey()
        let cols = 80
        let rows = 24
        let socket = TerminalSocket(serverURL: serverURL, sessionKey: key, token: token, cwd: defaultCwd, cols: cols, rows: rows) { [weak self] _ in
            // state transition — nothing to do beyond re-fit on reconnect
        } onData: { [weak self] data in
            self?.writeToWebview(data)
        }
        self.socket = socket
        socket.connect()
        state.connectionLabel = "connecting"
    }

    private func writeToWebview(_ data: Data) {
        let b64 = data.base64EncodedString()
        webView.evaluateJavaScript("window.__manta.write('\(b64)')", completionHandler: nil)
    }

    private func sendToShell(_ text: String) {
        socket?.sendInput(text)
    }

    // MARK: - Geometry

    private func applyGeometry(_ cols: Int, _ rows: Int) {
        state.geometryText = TerminalGeometry.format(cols: cols, rows: rows)
        socket?.resize(cols: cols, rows: rows)
    }

    // MARK: - Selection / paste / dictate

    private func copySelection() {
        webView.evaluateJavaScript("window.__manta.getSelection()") { [weak self] result, _ in
            guard let text = result as? String, !text.isEmpty else { return }
            TerminalSelection.copy(text)
        }
    }

    private func selectAllForCopy() {
        webView.evaluateJavaScript("window.__manta.selectAllText(); window.__manta.getSelection()") { [weak self] result, _ in
            guard let text = result as? String, !text.isEmpty else { return }
            TerminalSelection.copy(text)
        }
    }

    private func paste() {
        guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
        sendToShell(text)
    }

    private func dictateBegan() {
        guard dictateAvailable else { return }
        let rec = (recorder ?? VoiceRecorder())
        recorder = rec
        Task {
            let granted = await rec.requestPermission()
            if granted { rec.start() }
        }
    }

    private func dictateEnded() {
        guard let rec = recorder, let take = rec.stop() else { return }
        Task { @MainActor [weak self] in
            if let text = try? await self?.api.voiceTranscribe(data: take.data, mime: "audio/mp4"), !text.isEmpty {
                self?.sendToShell(text)
            }
        }
    }

    // MARK: - Keyboard visibility

    @objc private func keyboardWillChange(_ note: Notification) {
        let hidden = note.name == UIResponder.keyboardWillHideNotification
        state.keyboardVisible = !hidden
        if !hidden {
            floatingBar.isHidden = true
        } else {
            floatingBar.isHidden = false
        }
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "manta")
        NotificationCenter.default.removeObserver(self)
    }
}

// MARK: - Bridge (JS → native) + navigation + pinch

extension TerminalContainerController: WKScriptMessageHandler, WKNavigationDelegate, UIGestureRecognizerDelegate {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "manta", let body = message.body as? [String: Any] else { return }
        switch body["type"] as? String {
        case "data":
            if let s = body["data"] as? String { sendToShell(s) }
        case "geometry":
            if let cols = body["cols"] as? Int, let rows = body["rows"] as? Int {
                applyGeometry(cols, rows)
            }
        case "selection":
            if let text = body["text"] as? String, !text.isEmpty {
                state.selectedText = text
                TerminalSelection.copy(text)
            }
        default:
            break
        }
    }

    // Apple's WKNavigationDelegate signature — changing the `!` silently
    // un-conforms and the callback stops firing.
    // swiftlint:disable:next implicitly_unwrapped_optional
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webViewDidFinish(webView)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }
}

// MARK: - SwiftUI representable

struct TerminalContainerView: UIViewControllerRepresentable {
    let state: TerminalSessionState
    let sessionName: String
    let windowIndex: Int
    let windowName: String
    let projectName: String
    let defaultCwd: String
    /// The danger accent resolved from the generated tokens.
    let danger: UIColor

    func makeUIViewController(context: Context) -> TerminalContainerController {
        TerminalContainerController(
            state: state,
            sessionName: sessionName,
            windowIndex: windowIndex,
            windowName: windowName,
            projectName: projectName,
            defaultCwd: defaultCwd,
            danger: danger
        )
    }

    func updateUIViewController(_ uiViewController: TerminalContainerController, context: Context) {
        // The controller owns its socket; nothing to push from SwiftUI here.
    }
}

/// WKUserContentController retains its message handler STRONGLY, which would
/// cycle controller → controller-VC → webView → controller and leak a
/// WKWebView per terminal visit. The proxy holds the real handler weakly so
/// the view controller can deallocate; its deinit then detaches the handler.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var delegate: WKScriptMessageHandler?
    init(_ delegate: WKScriptMessageHandler) { self.delegate = delegate }
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}
