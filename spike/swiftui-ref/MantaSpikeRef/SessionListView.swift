import SwiftUI

// Screen 1 — session list. Mirrors sub-issue 03 (BET-434) to the same values,
// from hardcoded sample data. Stock components only.
//
// - NavigationStack supplies a real large title.
// - .toolbarBackground left at its default so iOS supplies the Liquid Glass
//   material and the scroll-edge effect.
// - .glassEffect() for the floating capsule bar.

struct SessionListView: View {
    @Environment(\.colorScheme) private var colorScheme
    private var t: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(Sample.groups.enumerated()), id: \.offset) { _, group in
                    SessionGroupHeader(title: group.project, t: t)
                    ForEach(group.sessions) { session in
                        SessionRow(session: session, t: t)
                    }
                }
            }
            .padding(.horizontal, 12)
        }
        .background(t.canvas.ignoresSafeArea())
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.large)
        .navigationDestination(for: Session.self) { session in
            ChatView(session: session)
        }
        .overlay(alignment: .bottom) {
            FloatingSearchBar(t: t)
        }
    }
}

struct SessionGroupHeader: View {
    let title: String
    let t: Tokens

    var body: some View {
        Text(title)
            .font(.system(size: 15, weight: .semibold))
            .kerning(-0.225)
            .foregroundStyle(t.tx2)
            .padding(.top, 22)
            .padding(.bottom, 6)
            .padding(.leading, 12)
    }
}

struct SessionRow: View {
    let session: Session
    let t: Tokens

    var body: some View {
        NavigationLink(value: session) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.name)
                        .font(.system(size: 15.5, weight: .medium))
                        .kerning(-0.155)
                        .foregroundStyle(t.tx1)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let subtitle = session.subtitle {
                        Text(subtitle)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(t.tx4)
                    }
                }
                Spacer(minLength: 8)
                Text(session.timer)
                    .font(.system(size: 11, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(t.tx4)
            }
            .frame(minHeight: 62)
            .padding(.horizontal, 12)
            .background(session.mostRecent ? t.fill : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.bottom, 2)
        }
        .buttonStyle(.plain)
    }
}

struct FloatingSearchBar: View {
    let t: Tokens

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 20))
                .foregroundStyle(t.tx3)
            Text("Search")
                .font(.system(size: 16))
                .foregroundStyle(t.tx3)
            Spacer()
            ZStack {
                Circle()
                    .fill(t.accentSolid)
                    .frame(width: 40, height: 40)
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(t.onAccent)
            }
        }
        .padding(.horizontal, 18)
        .frame(height: 56)
        .background { Capsule().glassEffect(.regular) }
        .padding(.horizontal, 14)
        .padding(.bottom, 12)
    }
}