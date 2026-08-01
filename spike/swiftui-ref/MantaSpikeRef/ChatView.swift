import SwiftUI

// Screen 2 — chat transcript. Mirrors sub-issue 04 (BET-435) to the same values,
// from hardcoded sample data. Stock components only: ScrollView with
// .defaultScrollAnchor(.bottom), a native inline transparent title, glass
// header buttons and composer, ConcentricRectangle for the bubble's nested corners.

struct ChatView: View {
    let session: Session

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    private var t: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(session.messages) { message in
                    switch message.parts {
                    case .user(let text):
                        UserBubble(text: text, t: t)
                    case .assistant(let text):
                        AssistantText(text: text, t: t)
                    case .tool(let name, let running):
                        ToolRow(name: name, running: running, t: t)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 62)
            .padding(.bottom, 84)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .defaultScrollAnchor(.bottom)
        .background(t.canvas.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.automatic, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                CircularGlassButton(systemName: "chevron.left", t: t) {
                    dismiss()
                }
            }
            ToolbarItem(placement: .principal) {
                ChatTitle(session: session, t: t)
            }
            ToolbarItem(placement: .topBarTrailing) {
                CircularGlassButton(systemName: "ellipsis", t: t) {}
            }
        }
        .overlay(alignment: .bottom) {
            FloatingComposer(t: t)
        }
    }
}

// Line 1: session name 14.5px w600 -0.01em tx1, one line ellipsis.
// Line 2: 11px w500 tx4 of the form "running - 2m - 8%", "running" in accentTx
// when busy, whole line "idle" when not.
struct ChatTitle: View {
    let session: Session
    let t: Tokens

    var body: some View {
        VStack(spacing: 1) {
            Text(session.name)
                .font(.system(size: 14.5, weight: .semibold))
                .kerning(-0.145)
                .foregroundStyle(t.tx1)
                .lineLimit(1)
                .truncationMode(.tail)
            if session.status == .idle {
                Text("idle")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(t.tx4)
            } else {
                (Text("running").foregroundStyle(t.accentTx) + Text(" - 2m - 8%"))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(t.tx4)
            }
        }
    }
}

struct CircularGlassButton: View {
    let systemName: String
    let t: Tokens
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .glassEffect(.regular, in: Circle())
                    .frame(width: 38, height: 38)
                Image(systemName: systemName)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(t.tx2)
            }
        }
        .buttonStyle(.plain)
    }
}

// Right-aligned, accentSolid bg, onAccent 15px lh 1.5, pad 11v/15h, max width
// 82%, margin-bottom 22. Radii 22/22/6/22 (TL/TR/BR/BL) — ConcentricRectangle.
struct UserBubble: View {
    let text: String
    let t: Tokens

    var body: some View {
        HStack {
            Spacer(minLength: 0)
            Text(text)
                .font(.system(size: 15, weight: .regular))
                .lineSpacing(15 * 0.5)
                .foregroundStyle(t.onAccent)
                .padding(.vertical, 11)
                .padding(.horizontal, 15)
                .background(t.accentSolid, in: UnevenRoundedRectangle(cornerRadii: .init(topLeading: 22, bottomLeading: 22, bottomTrailing: 6, topTrailing: 22)))
                .padding(.bottom, 22)
        }
        .containerRelativeFrame(.horizontal, alignment: .trailing) { length, _ in length * 0.82 }
    }
}

// Full width, tx1 15px lh 1.6 margin-bottom 12, plain text.
struct AssistantText: View {
    let text: String
    let t: Tokens

    var body: some View {
        Text(text)
            .font(.system(size: 15, weight: .regular))
            .lineSpacing(15 * 0.6)
            .foregroundStyle(t.tx1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 12)
    }
}

// fill bg, radius 12, pad 11v/13h, mb 12, monospace 12.5 tx2, leading 12px icon:
// Check in ok when completed, Circle in accentTx while running.
struct ToolRow: View {
    let name: String
    let running: Bool
    let t: Tokens

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: running ? "circle" : "checkmark")
                .font(.system(size: 12))
                .foregroundStyle(running ? t.accentTx : t.ok)
            Text(name)
                .font(.system(size: 12.5, weight: .medium, design: .monospaced))
                .foregroundStyle(t.tx2)
                .lineLimit(1)
        }
        .padding(.vertical, 11)
        .padding(.horizontal, 13)
        .background(t.fill)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.bottom, 12)
    }
}

// Floating composer — GlassView equivalent, decorative, does not send.
struct FloatingComposer: View {
    let t: Tokens

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "paperclip")
                .font(.system(size: 20))
                .foregroundStyle(t.tx3)
            Text("Message")
                .font(.system(size: 16))
                .foregroundStyle(t.tx3)
            Spacer()
            Image(systemName: "mic")
                .font(.system(size: 20))
                .foregroundStyle(t.tx3)
            ZStack {
                Circle()
                    .fill(t.accentSolid)
                    .frame(width: 40, height: 40)
                Image(systemName: "paperplane")
                    .font(.system(size: 20))
                    .foregroundStyle(t.onAccent)
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 56)
        .background { Capsule().glassEffect(.regular) }
        .padding(.horizontal, 14)
        .padding(.bottom, 12)
    }
}