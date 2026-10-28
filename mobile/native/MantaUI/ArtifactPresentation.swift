import Foundation

// ===========================================================================
// WS07 — what the artifacts card keeps on the client. The LIST is derived by the
// box (`artifacts:list`); everything here is presentation or gesture logic:
// device-timezone day grouping, a per-keystroke search filter, which actions a
// row may offer, how a href's bytes are fetched, staging/attach failure copy,
// and the relative expiry LABEL (the expiry STATE comes from the box).
// Pure (Foundation only) so it runs under `verify.sh`.
// ===========================================================================

// MARK: - Expiry label

enum ArtifactExpiryLabel {
    /// "no expiry" / "expired" / "expires in 5h" / "expires in 3d". Only the
    /// wording is computed here, against the device clock; the tone comes from
    /// the box's `expiry.state`. A `live`/`soon` row whose time has passed on
    /// this device since the last poll reads "expired" until the next poll.
    static func text(_ expiry: ArtifactExpiry, now: Date) -> String {
        switch expiry.state {
        case .never: return "no expiry"
        case .expired: return "expired"
        case .live, .soon, .unknown:
            guard let expiresAt = expiry.expiresAt else { return "no expiry" }
            let remaining = expiresAt / 1000.0 - now.timeIntervalSince1970
            if remaining <= 0 { return "expired" }
            let hours = remaining / 3600
            if hours < 48 { return "expires in \(max(1, Int(hours.rounded(.down))))h" }
            return "expires in \(Int((remaining / 86400).rounded(.down)))d"
        }
    }
}

// MARK: - Row text

enum ArtifactFormat {
    /// "62 KB" / "14 KB" for bytes, or nil when the size is unknown.
    static func byteCount(_ bytes: Int?) -> String? {
        guard let bytes else { return nil }
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// "just now" / "4m ago" / "1h ago" / "2d ago" relative to `now`.
    static func relativeAge(_ date: Date?, now: Date) -> String? {
        guard let date else { return nil }
        let seconds = Int(max(0, now.timeIntervalSince(date)))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        if seconds < 86400 { return "\(seconds / 3600)h ago" }
        return "\(seconds / 86400)d ago"
    }

    /// `"62 KB · from the agent · 4m ago"`, omitting what does not apply. The
    /// expiry capsule owns expiry, so this line never mentions it.
    static func secondaryLine(_ item: ArtifactItem, now: Date) -> String {
        var parts: [String] = []
        if let size = byteCount(item.size) { parts.append(size) }
        parts.append(item.origin == .user ? "you attached" : "from the agent")
        if item.at > 0, let age = relativeAge(item.date, now: now) { parts.append(age) }
        return parts.joined(separator: " · ")
    }

    /// "3 steps" / "1 step" / "plan".
    static func planSubline(steps: Int) -> String {
        steps > 0 ? "\(steps) \(steps == 1 ? "step" : "steps")" : "plan"
    }
}

// MARK: - Day grouping (device timezone)

enum ArtifactDayGrouping {
    static func dayIndex(_ date: Date, calendar: Calendar = .current) -> Int {
        let start = calendar.startOfDay(for: date)
        return calendar.ordinality(of: .day, in: .era, for: start) ?? 0
    }

    /// Newest first, grouped by calendar day: Today / Yesterday / "Tue 3 Nov".
    static func grouped(_ items: [ArtifactItem], now: Date,
                        calendar: Calendar = .current) -> [(label: String, items: [ArtifactItem])] {
        let today = dayIndex(now, calendar: calendar)
        let sorted = items.sorted { $0.at > $1.at }
        var groups: [(label: String, items: [ArtifactItem])] = []
        var lastDay: Int?
        for item in sorted {
            let day = dayIndex(item.date, calendar: calendar)
            if day == lastDay, !groups.isEmpty {
                groups[groups.count - 1].items.append(item)
            } else {
                groups.append((label(day, today: today, at: item.date, calendar: calendar), [item]))
                lastDay = day
            }
        }
        return groups
    }

    private static func label(_ day: Int, today: Int, at: Date, calendar: Calendar) -> String {
        if day == today { return "Today" }
        if day == today - 1 { return "Yesterday" }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = calendar.locale ?? .current
        formatter.dateFormat = "EEE d MMM"
        return formatter.string(from: at)
    }
}

// MARK: - Search (per keystroke, over the box's list)

enum ArtifactSearch {
    /// Case-insensitive substring match of the trimmed query on label OR href.
    /// An empty / whitespace-only query returns the list unchanged.
    static func filter(_ items: [ArtifactItem], query: String) -> [ArtifactItem] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return items }
        return items.filter { $0.label.lowercased().contains(q) || $0.href.lowercased().contains(q) }
    }

    /// Per-kind match counts for the segment badges while a query is active.
    static func counts(_ items: [ArtifactItem], query: String) -> ArtifactCountsWire {
        var counts = ArtifactCountsWire()
        for item in filter(items, query: query) {
            switch item.kind {
            case .link: counts.link += 1
            case .image: counts.image += 1
            case .file: counts.file += 1
            case .plan: counts.plan += 1
            case .unknown: break
            }
        }
        return counts
    }

    static func isActive(_ query: String) -> Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - Empty states

enum ArtifactEmptyCopy {
    static func big(_ kind: ArtifactKind) -> String {
        switch kind {
        case .link: return "No links yet"
        case .image: return "No images yet"
        case .plan: return "No plans yet"
        case .file, .unknown: return "No files yet"
        }
    }

    /// The OTHER segments' counts, e.g. "2 links, 0 images, 3 files".
    static func sub(_ kind: ArtifactKind, _ counts: ArtifactCountsWire) -> String {
        switch kind {
        case .link: return "\(counts.image) images, \(counts.file) files, \(counts.plan) plans"
        case .image: return "\(counts.link) links, \(counts.file) files, \(counts.plan) plans"
        case .plan: return "\(counts.link) links, \(counts.image) images, \(counts.file) files"
        case .file, .unknown: return "\(counts.link) links, \(counts.image) images, \(counts.plan) plans"
        }
    }
}

// MARK: - Which actions a row offers (a control that cannot act is not drawn)

enum ArtifactActions {
    /// Jump to message: needs a handler AND an owning message.
    static func canJump(hasHandler: Bool, messageId: String?) -> Bool {
        guard hasHandler, let messageId else { return false }
        return !messageId.isEmpty
    }

    /// Attach to message: files and images only, and only where a composer exists,
    /// currently accepts input, and the upload has a project to go to.
    static func canAttach(kind: ArtifactKind, hasComposer: Bool, acceptsInput: Bool, hasProject: Bool) -> Bool {
        (kind == .file || kind == .image) && hasComposer && acceptsInput && hasProject
    }

    /// "Open plan file": only when the box knows the session folder.
    static func canOpenPlanFile(_ item: ArtifactItem) -> Bool {
        item.kind == .plan && item.plan?.fileAvailable == true
    }
}

// MARK: - Byte source routing (preview, Share and Attach)

enum ArtifactByteSource: Equatable, Sendable {
    case dataURI(String)   // href starts with "data:" (case-insensitive)
    case remote(URL)       // scheme http / https, host non-empty
    case boxPath(String)   // absolute path ("/…" or "~/…")
    case unsupported       // anything else (relative path, other scheme, empty)

    static func classify(_ href: String) -> ArtifactByteSource {
        let lower = href.lowercased()
        if lower.hasPrefix("data:") { return .dataURI(href) }
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            if let url = URL(string: href), let host = url.host, !host.isEmpty { return .remote(url) }
            return .unsupported
        }
        if href.hasPrefix("/") || href.hasPrefix("~/") { return .boxPath(href) }
        return .unsupported
    }
}

enum ArtifactDataURI {
    /// Decode `data:[mime][;base64],payload`. base64 when flagged, otherwise
    /// percent-decoded UTF-8. nil for a malformed URI (no comma, bad payload).
    static func decode(_ href: String) -> Data? {
        guard href.lowercased().hasPrefix("data:"), let comma = href.firstIndex(of: ",") else { return nil }
        let metaStart = href.index(href.startIndex, offsetBy: 5)
        guard metaStart <= comma else { return nil }
        let meta = href[metaStart..<comma].lowercased()
        let payload = String(href[href.index(after: comma)...])
        if meta.contains(";base64") {
            // Strict: a garbled payload must read as damaged, not decode to an empty file.
            return Data(base64Encoded: payload.filter { !$0.isWhitespace })
        }
        return payload.removingPercentEncoding?.data(using: .utf8)
    }
}

// MARK: - Staging / attach failures (never silent)

enum ArtifactStagingError: Error, Equatable, Sendable {
    case missing               // box file gone / 403 / 404 / unsupported href
    case badDataURI
    case remote(host: String)  // remote URL non-2xx or network error
    case write                 // writing the temp file failed

    /// Preview failure copy.
    static func message(_ error: ArtifactStagingError, name: String) -> String {
        switch error {
        case .missing: return "Couldn't open \(name) — it may no longer be on the box."
        case .badDataURI: return "Couldn't open \(name) — the file data is damaged."
        case .remote(let host): return "Couldn't download \(name) from \(host)."
        case .write: return "Couldn't prepare \(name) for preview."
        }
    }
}

enum ArtifactStaging {
    /// The extension QuickLook needs to recognise a type: the label's, else the
    /// href's last path segment's ("" when neither is a clean extension). A
    /// plan's label is a title, so its `.md` comes from the href.
    static func fileExtension(label: String, href: String) -> String {
        let fromLabel = cleanExtension(of: label)
        if !fromLabel.isEmpty { return fromLabel }
        return cleanExtension(of: href)
    }

    private static func cleanExtension(of name: String) -> String {
        let last: Substring
        if let slash = name.lastIndex(of: "/") {
            last = name[name.index(after: slash)...]
        } else {
            last = Substring(name)
        }
        guard let dot = last.lastIndex(of: ".") else { return "" }
        let ext = last[last.index(after: dot)...]
        guard !ext.isEmpty, ext.count <= 8, ext.allSatisfy({ $0.isLetter || $0.isNumber }) else { return "" }
        return "." + ext
    }

    /// A short, filesystem-safe temp name keyed by the row id (re-staging the same
    /// id overwrites in place): `manta-qp-<readable prefix>-<hash><ext>`.
    static func tempFileName(id: String, label: String, href: String) -> String {
        let safe = String(id
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
            .prefix(48))
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in id.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return "manta-qp-\(safe)-\(String(hash, radix: 16))\(fileExtension(label: label, href: href))"
    }
}

enum ArtifactAttach {
    static let readOnlyMessage = "This chat is read-only."

    /// The uploaded copy's filename: the label if it has an extension, else the
    /// label plus the href's extension.
    static func filename(for item: ArtifactItem) -> String {
        let label = item.label.isEmpty ? (item.href as NSString).lastPathComponent : item.label
        let hasExtension = !(label as NSString).pathExtension.isEmpty
        if hasExtension { return label }
        return label + ArtifactStaging.fileExtension(label: label, href: item.href)
    }

    /// Composer rejection copy (WS03's `lastAttachRejection`).
    static func rejectionMessage(_ rejection: ComposerInsertion.AttachRejection?, name: String) -> String {
        switch rejection {
        case .duplicate: return "Already attached"
        case .readOnly: return readOnlyMessage
        case .notAbsolute, nil: return "Couldn't attach \(name)."
        }
    }

    static func stagingFailureMessage(_ error: ArtifactStagingError, name: String) -> String {
        let reason: String
        switch error {
        case .missing: reason = "it may no longer be on the box."
        case .badDataURI: reason = "the file data is damaged."
        case .remote(let host): reason = "couldn't download it from \(host)."
        case .write: reason = "couldn't prepare it."
        }
        return "Couldn't attach \(name) — \(reason)"
    }

    static func uploadFailureMessage(name: String) -> String {
        "Couldn't attach \(name) — the upload to the box failed."
    }
}

// MARK: - Plan page

enum ArtifactPlanCopy {
    static let openFailed = "Couldn't open the plan page."
    static let otherSession = "Another conversation's page uses this address."

    /// The banner text for a plan whose page can't be opened.
    static func openFailure(_ plan: ArtifactPlanInfo?) -> String {
        if plan?.pageUrlReason == "other-session" { return "\(openFailed) \(otherSession)" }
        return openFailed
    }
}
