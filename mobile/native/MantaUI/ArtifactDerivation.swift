import Foundation

// ===========================================================================
// BET-822 — pure artifact derivation, ported from the desktop's
// src/renderer/artifacts.ts `deriveArtifacts` (line-for-line, so the two
// surfaces cannot drift — the desktop unit tests are the oracle).
//
// The iOS artifacts card is fed from FOUR sources, exactly as the desktop:
//   1. `file` parts in the transcript — where every file the user attaches lands
//   2. URLs found in USER text parts
//   3. pages published by serve_page, filtered to this session
//   4. the agent's outbox (send_file), filtered to this session
//
// The merge, dedupe and ordering live HERE (testable, no SwiftUI), not in the
// card. The card only renders whatever `derive` returns.
// ===========================================================================

enum ArtifactKind: Hashable, Equatable, Sendable {
    case link, image, file
}

/// Where an artifact came from. Drives the row's provenance line ("you
/// attached" / "from the agent") — richer than the desktop's two-state origin
/// because a published page and an agent-pushed file render the same
/// "from the agent" but are conceptually distinct sources.
enum ArtifactOrigin: Equatable, Sendable {
    case userAttached   // a file part in a user message
    case agentPushed    // an outbox row (send_file)
    case publishedPage  // a serve_page row
    case link           // a URL pasted in a user message
}

struct Artifact: Identifiable, Equatable, Sendable {
    /// Stable: the part id (suffixed `.0`/`.1`/… when a text part yields many
    /// links), or `outbox:<path>` / `page:<subdomain>`. Deterministic, so ids
    /// survive re-derivation.
    let id: String
    let kind: ArtifactKind
    let label: String        // filename, page subdomain, or URL host+path
    let href: String         // absolute box path, `data:` URI, or remote URL
    let mime: String?
    let bytes: Int?
    let origin: ArtifactOrigin
    let at: Date?
    let expiresAt: Date?     // hosted pages + outbox rows; nil otherwise
}

enum ArtifactDerivation {
    // https?://… up to the first whitespace, `>` or `<` — mirrors the desktop's
    // URL_RE exactly.
    // The pattern is a compile-time literal: this can only throw if the literal
    // itself is malformed, which any test run catches immediately.
    // swiftlint:disable:next force_try
    private static let urlRegex = try! NSRegularExpression(pattern: #"https?://[^\s<>]+"#)

    // Extension → MIME for agent-pushed files (src/renderer/artifacts.ts
    // EXT_MIME). Kept deliberately small — add a type only when a pushed
    // artifact needs it. Unlisted extensions fall back to nil (`kind` then
    // degrades to `.file`, and QuickLook sniffs the actual bytes).
    private static let extMime: [String: String] = [
        ".csv": "text/csv",
        ".tsv": "text/tab-separated-values",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".json": "application/json",
        ".pdf": "application/pdf",
        ".html": "text/html",
        ".htm": "text/html",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
    ]

    static func derive(messages: [OpencodeMessage],
                       pages: [ServedPageMeta],
                       sessionId: String,
                       outbox: [OutboxFile]) -> [Artifact] {
        var out: [Artifact] = []

        for message in messages {
            let isUser = message.info.role == .user
            for part in message.parts {
                if part.type == "file" {
                    out.append(fileArtifact(message: message, part: part))
                    continue
                }
                // Only USER text parts contribute links; every other part type
                // (tool, patch, step-start, step-finish, reasoning, snapshot,
                // agent) is explicitly excluded, as are parts flagged synthetic
                // or ignored.
                guard part.type == "text", isUser,
                      !(part.synthetic ?? false),
                      !(part.ignored ?? false) else { continue }
                let matches = Self.urls(in: part.text ?? "")
                for (index, url) in matches.enumerated() {
                    // A single text part can yield many links. Each gets a
                    // stable id — the part id suffixed with the URL index when
                    // the part emits more than one — so ids never collide and
                    // stay stable across re-derivation.
                    let id = matches.count > 1 ? "\(part.id).\(index)" : part.id
                    if let artifact = linkArtifact(message: message, part: part, url: url, id: id) {
                        out.append(artifact)
                    }
                }
            }
        }

        for page in pages where page.sessionID == sessionId {
            out.append(pageArtifact(page))
        }

        for row in outbox where row.sessionID == sessionId {
            out.append(outboxArtifact(row))
        }

        return dedupe(out).sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
    }

    // MARK: - Per-source derivation (mirrors src/renderer/artifacts.ts)

    /// A `file` part. The wire shape (src/server/opencode.mjs) is
    /// `{type:"file", mime, url:"file://<abs>", filename?, size?}` — the extra
    /// dict carries `mime`/`url`/`filename`/`size`. A user-message file part is
    /// `userAttached`, anything else is `agentPushed` (matching the desktop's
    /// role test).
    private static func fileArtifact(message: OpencodeMessage, part: OpencodePart) -> Artifact {
        let url = Self.string(part, "url") ?? ""
        let mime = Self.string(part, "mime")
        let kind: ArtifactKind = (mime?.hasPrefix("image/") ?? false) ? .image : .file
        let pathOnly = url.hasPrefix("file://") ? String(url.dropFirst("file://".count)) : url
        let filename = Self.string(part, "filename")
        let label = filename ?? Self.lastPathSegment(pathOnly)
        return Artifact(
            id: part.id,
            kind: kind,
            label: label.isEmpty ? Self.lastPathSegment(pathOnly) : label,
            href: pathOnly,
            mime: mime,
            bytes: Self.number(part, "size").map(Int.init),
            origin: message.info.role == .user ? .userAttached : .agentPushed,
            at: Self.date(message.info.time?.created),
            expiresAt: nil)
    }

    /// A URL found in a user text part. Only http(s) URLs that parse become
    /// links; anything else is dropped (the desktop's `new URL` try/catch).
    private static func linkArtifact(message: OpencodeMessage, part: OpencodePart,
                                     url: String, id: String) -> Artifact? {
        guard let parsed = URL(string: url),
              let scheme = parsed.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        let host = parsed.host ?? ""
        let label = (host + parsed.path).replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        return Artifact(
            id: id,
            kind: .link,
            label: label.isEmpty ? host : label,
            href: parsed.absoluteString,
            mime: nil,
            bytes: nil,
            origin: .link,
            at: Self.date(message.info.time?.created),
            expiresAt: nil)
    }

    /// A published serve-page row (kind `.link`, origin `.publishedPage`).
    private static func pageArtifact(_ page: ServedPageMeta) -> Artifact {
        Artifact(id: "page:" + page.subdomain,
                 kind: .link,
                 label: page.subdomain,
                 href: page.url,
                 mime: nil,
                 bytes: nil,
                 origin: .publishedPage,
                 at: Self.date(page.createdAt),
                 expiresAt: Self.date(page.expiresAt))
    }

    /// An agent-pushed outbox row. Classified image/file from its extension's
    /// known MIME. `expiresAt` is its mailbox TTL.
    private static func outboxArtifact(_ row: OutboxFile) -> Artifact {
        let ext = (row.name as NSString).pathExtension
        let dotExt = ext.isEmpty ? "" : "." + ext.lowercased()
        let mime = extMime[dotExt]
        return Artifact(id: "outbox:" + row.path,
                        kind: (mime?.hasPrefix("image/") ?? false) ? .image : .file,
                        label: row.name,
                        href: row.path,
                        mime: mime,
                        bytes: row.size,
                        origin: .agentPushed,
                        at: Self.date(row.mtime),
                        expiresAt: Self.date(row.expiresAt))
    }

    /// Dedupe on the lowercased href: keep the artifact with the greatest `at`
    /// (on a tie, the first encountered). A transcript file part, an outbox row
    /// and a page can all point at related paths — this collapses them to one
    /// row, newest winning, exactly like the desktop.
    private static func dedupe(_ items: [Artifact]) -> [Artifact] {
        var byKey: [String: Artifact] = [:]
        for item in items {
            let key = item.href.lowercased()
            if let existing = byKey[key] {
                if (item.at ?? .distantPast) > (existing.at ?? .distantPast) {
                    byKey[key] = item
                }
            } else {
                byKey[key] = item
            }
        }
        return Array(byKey.values)
    }

    // MARK: - Extraction helpers

    private static func urls(in text: String) -> [String] {
        let ns = text as NSString
        let range = NSRange(location: 0, length: ns.length)
        return urlRegex.matches(in: text, range: range).map {
            ns.substring(with: $0.range)
        }
    }

    private static func string(_ part: OpencodePart, _ key: String) -> String? {
        guard case .string(let value)? = part.extra[key] else { return nil }
        return value
    }

    private static func number(_ part: OpencodePart, _ key: String) -> Double? {
        guard case .number(let value)? = part.extra[key] else { return nil }
        return value
    }

    private static func date(_ ms: Double?) -> Date? {
        guard let ms else { return nil }
        return Date(timeIntervalSince1970: ms / 1000.0)
    }

    private static func lastPathSegment(_ s: String) -> String {
        guard let slash = s.lastIndex(of: "/") else { return s }
        return String(s[s.index(after: slash)...])
    }
}

// MARK: - Row-presentation helpers (pure, so the card stays a thin renderer)

extension Artifact {
    /// The human provenance phrase for a row's secondary line.
    var provenanceLabel: String {
        switch origin {
        case .userAttached, .link: return "you attached"
        case .agentPushed, .publishedPage: return "from the agent"
        }
    }
}

enum ArtifactFormat {
    /// "62 KB" / "14 KB" for bytes, or nil when the size is unknown (links).
    static func byteCount(_ bytes: Int?) -> String? {
        guard let bytes else { return nil }
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// "4m ago" / "22m ago" / "1h ago" / "2d ago" relative to `now`.
    static func relativeAge(_ date: Date?, now: Date) -> String? {
        guard var delta = date?.timeIntervalSince(now) else { return nil }
        delta = max(0, delta)
        let seconds = Int(delta)
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        if seconds < 86400 { return "\(seconds / 3600)h ago" }
        return "\(seconds / 86400)d ago"
    }

    /// "expires in 6d" / "expires in 3h" — shown ONLY when the file actually
    /// expires within 48h, replacing the age. Beyond that, or with no expiry,
    /// returns the age instead. Mirrors the desktop's 48h expiry chip rule.
    static func ageOrExpiry(_ artifact: Artifact, now: Date) -> String? {
        if let expiry = artifact.expiresAt {
            let remaining = expiry.timeIntervalSince(now)
            if remaining > 0 && remaining <= 48 * 3600 {
                let hours = Int(ceil(remaining / 3600))
                if hours < 24 { return "expires in \(hours)h" }
                let days = Int(ceil(remaining / 86400))
                return "expires in \(days)d"
            }
        }
        return relativeAge(artifact.at, now: now)
    }

    /// The secondary line: `"62 KB · from the agent · 4m ago"`, omitting any
    /// component that doesn't apply (a link has no size, a hosted page may have
    /// no expiry).
    static func secondaryLine(_ artifact: Artifact, now: Date) -> String {
        var parts: [String] = []
        if let size = byteCount(artifact.bytes) { parts.append(size) }
        parts.append(artifact.provenanceLabel)
        if let tail = ageOrExpiry(artifact, now: now) { parts.append(tail) }
        return parts.joined(separator: " · ")
    }
}

enum ArtifactCounts {
    static func of(_ items: [Artifact]) -> (link: Int, image: Int, file: Int) {
        var link = 0, image = 0, file = 0
        for item in items {
            switch item.kind {
            case .link: link += 1
            case .image: image += 1
            case .file: file += 1
            }
        }
        return (link, image, file)
    }
}

/// Day grouping for the list's section headers — Today / Yesterday / a date —
/// newest first, matching the desktop's `groupByDay` (same calendar-day
/// semantics, so a day boundary never splits an artifact from its siblings).
enum ArtifactDayGrouping {
    static func dayIndex(_ date: Date, calendar: Calendar = .current) -> Int {
        let start = calendar.startOfDay(for: date)
        return calendar.ordinality(of: .day, in: .era, for: start) ?? 0
    }

    static func grouped(_ items: [Artifact], now: Date) -> [(label: String, items: [Artifact])] {
        let today = dayIndex(now)
        let sorted = items.sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
        var groups: [(label: String, items: [Artifact])] = []
        var lastDay: Int?
        for item in sorted {
            let day = item.at.map { dayIndex($0) }
            if day == lastDay, !groups.isEmpty {
                groups[groups.count - 1].items.append(item)
            } else {
                groups.append((label(day, today: today, at: item.at), [item]))
                lastDay = day
            }
        }
        return groups
    }

    private static func label(_ day: Int?, today: Int, at: Date?) -> String {
        guard let day, let at else { return "Earlier" }
        if day == today { return "Today" }
        if day == today - 1 { return "Yesterday" }
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE d MMM"
        return formatter.string(from: at)
    }
}
