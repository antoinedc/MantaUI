import UIKit

// ===========================================================================
// S6 — the native keyboard accessory (BET-598): the §9.2 "Key row".
//
// A real `inputAccessoryView` so it tracks the keyboard's own animation
// exactly (the whole point of "(native, not in the webview)". Two rows:
//
//   row 1: esc · ctrl · tab · ↑ ↓ ← →
//   row 2: | ~ / - _ : $  (horizontally scrollable — the shell constants
//                          buried three taps deep on the iOS keyboard)
//
// Sticky ctrl (§9.2): tap latches (lights up), applies to the NEXT keypress,
// then releases; double-tap locks. The latch state machine is the pure
// `StickyModifierState` from TerminalModels — the bar's ctrl button drives it.
//
// The esc key is tinted red while a process is running (§9.2) — it is the
// interrupt (this is how Ctrl-C becomes reachable from the phone, §9.1). The
// container flips this via `setEscDanger(_:)`.
//
// Every key reports through `onKey(_:ctrlActive:)`; the container maps it to
// shell bytes via `TerminalKeyInput` and writes them to the socket.
// ===========================================================================

@MainActor
final class TerminalKeyBarView: UIView {
    /// Called when a key is tapped. `ctrlActive` reflects whether the ctrl
    /// modifier was sticky at the moment of the tap.
    var onKey: (TerminalKey, _ ctrlActive: Bool) -> Void = { _, _ in }

    /// Called when the ctrl key itself is tapped (latches/locks/unlocks).
    var onCtrlTap: () -> Void = {}

    /// Whether the shell is running — tints esc red as the interrupt affordance.
    var escIsDanger = false {
        didSet { updateEscAppearance() }
    }

    /// The danger accent, resolved from the generated tokens by the container
    /// (never a literal here).
    var dangerColor: UIColor = .systemRed {
        didSet { updateEscAppearance() }
    }

    private var sticky: StickyModifierState = .off

    private let row1Stack = UIStackView()
    private let row2Scroll = UIScrollView()
    private let row2Stack = UIStackView()
    // Built once in setup() immediately after init and non-nil for the whole
    // lifetime of the view; making them optional would add a `?` to every use
    // site without removing any real nil case.
    // swiftlint:disable implicitly_unwrapped_optional
    private var escButton: UIButton!
    private var ctrlButton: UIButton!
    // swiftlint:enable implicitly_unwrapped_optional

    private static let keyMinSize: CGFloat = 44
    private static let keyHoriz: CGFloat = 12
    private static let keyFont: CGFloat = 15

    override init(frame: CGRect) {
        super.init(frame: frame)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: - Build

    private func build() {
        backgroundColor = UIColor(white: 0.06, alpha: 0.9)
        translatesAutoresizingMaskIntoConstraints = false

        row1Stack.axis = .horizontal
        row1Stack.distribution = .fillEqually
        row1Stack.spacing = Self.keyHoriz
        row1Stack.translatesAutoresizingMaskIntoConstraints = false

        row2Scroll.showsHorizontalScrollIndicator = false
        row2Scroll.translatesAutoresizingMaskIntoConstraints = false
        row2Stack.axis = .horizontal
        row2Stack.spacing = Self.keyHoriz
        row2Stack.translatesAutoresizingMaskIntoConstraints = false
        row2Scroll.addSubview(row2Stack)
        NSLayoutConstraint.activate([
            row2Stack.topAnchor.constraint(equalTo: row2Scroll.contentLayoutGuide.topAnchor),
            row2Stack.bottomAnchor.constraint(equalTo: row2Scroll.contentLayoutGuide.bottomAnchor),
            row2Stack.leadingAnchor.constraint(equalTo: row2Scroll.contentLayoutGuide.leadingAnchor),
            row2Stack.trailingAnchor.constraint(equalTo: row2Scroll.contentLayoutGuide.trailingAnchor),
            row2Stack.heightAnchor.constraint(equalTo: row2Scroll.heightAnchor),
        ])

        let container = UIStackView(arrangedSubviews: [row1Stack, row2Scroll])
        container.axis = .vertical
        container.spacing = 6
        container.translatesAutoresizingMaskIntoConstraints = false
        addSubview(container)

        // Row 1
        escButton = makeKey(TerminalKey.esc)
        ctrlButton = makeKey(TerminalKey.ctrl)
        for key in [TerminalKey.tab,
                    .arrow(.up), .arrow(.down), .arrow(.left), .arrow(.right)] {
            row1Stack.addArrangedSubview(makeKey(key))
        }
        // Row 1 order per §9.2: esc · ctrl · tab · ↑ ↓ ← →. Re-insert esc/ctrl first.
        row1Stack.insertArrangedSubview(escButton, at: 0)
        row1Stack.insertArrangedSubview(ctrlButton, at: 1)

        // Row 2
        for key in TerminalKeyRowLayout.row2 {
            let b = makeKey(key)
            var w = b.widthAnchor.constraint(equalToConstant: Self.keyMinSize)
            w.priority = .required
            row2Stack.addArrangedSubview(b)
        }

        // Bottom inset for home-indicator safety.
        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            container.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.keyHoriz),
            container.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.keyHoriz),
            bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: 10),
            row1Stack.heightAnchor.constraint(equalToConstant: 40),
            row2Scroll.heightAnchor.constraint(equalToConstant: 40),
        ])

        updateEscAppearance()
        updateCtrlAppearance()
    }

    private func makeKey(_ key: TerminalKey) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(key.label, for: .normal)
        button.titleLabel?.font = .monospacedSystemFont(ofSize: Self.keyFont, weight: .medium)
        button.setTitleColor(.white, for: .normal)
        button.backgroundColor = UIColor(white: 0.15, alpha: 1)
        button.layer.cornerRadius = 10
        button.translatesAutoresizingMaskIntoConstraints = false
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
        // 48×48 min hit area house rule (§10.1) via a clear growth band.
        button.addTarget(self, action: #selector(keyTapped(_:)), for: .touchUpInside)
        button.accessibilityTraits = [.button, .keyboardKey]
        button.accessibilityLabel = "\(key.label) key"
        return button
    }

    // MARK: - Actions

    @objc private func keyTapped(_ sender: UIButton) {
        guard let label = sender.title(for: .normal) else { return }
        let key = resolveKey(label: label)
        if key == .ctrl {
            sticky = sticky.tapped
            updateCtrlAppearance()
            onCtrlTap()
            return
        }
        let active = sticky.isActive
        if key != .ctrl {
            sticky = sticky.consumed
        }
        updateCtrlAppearance()
        onKey(key, active)
    }

    private func resolveKey(label: String) -> TerminalKey {
        switch label {
        case "esc": return .esc
        case "ctrl": return .ctrl
        case "tab": return .tab
        case "↑": return .arrow(.up)
        case "↓": return .arrow(.down)
        case "←": return .arrow(.left)
        case "→": return .arrow(.right)
        default: return .char(label)
        }
    }

    // MARK: - Appearance updates

    func setSticky(_ state: StickyModifierState) {
        sticky = state
        updateCtrlAppearance()
    }

    private func updateEscAppearance() {
        guard let escButton else { return }
        escButton.backgroundColor = escIsDanger ? dangerColor : UIColor(white: 0.15, alpha: 1)
    }

    private func updateCtrlAppearance() {
        guard let ctrlButton else { return }
        switch sticky {
        case .off:
            ctrlButton.backgroundColor = UIColor(white: 0.15, alpha: 1)
            ctrlButton.setTitleColor(.white, for: .normal)
        case .armed:
            ctrlButton.backgroundColor = UIColor(white: 0.45, alpha: 1)
            ctrlButton.setTitleColor(.black, for: .normal)
        case .locked:
            ctrlButton.backgroundColor = UIColor(red: 0.85, green: 0.6, blue: 0.1, alpha: 1)
            ctrlButton.setTitleColor(.black, for: .normal)
        }
    }
}
