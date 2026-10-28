import Foundation

// ===========================================================================
// WS04 §6 — the clone flow's pure logic, ported from `chatUtils.ts:4198-4289`
// and `CloneFromGitHub.tsx`. Foundation-only (D19).
// ===========================================================================

/// The distinguished cause of a failed clone. Only `permission` is actionable by
/// the user (token scope, or an organisation that hasn't approved the token).
enum CloneErrorKind: Equatable, Sendable {
    case permission, disk, network, destination, unknown

    /// Classifies `git clone` stderr. Order matters (port of `cloneErrorKind`):
    /// a destination problem must never be blamed on the GitHub token, so it is
    /// checked first; GitHub's "could not read Username" / "Repository not
    /// found" for a private repo is really an authorisation problem.
    static func classify(_ stderr: String) -> CloneErrorKind {
        let s = stderr.lowercased()
        func matches(_ pattern: String) -> Bool {
            s.range(of: pattern, options: .regularExpression) != nil
        }
        if matches("could not create leading directories|destination path .* already exists|not an empty directory") {
            return .destination
        }
        if matches("permission to .* denied|permission denied|could not read (username|password)|authentication failed|not authorized|repository not found|\\b403\\b|check that you have the correct access rights") {
            return .permission
        }
        if matches("no space left on device|disk (is )?full|insufficient|write error: no space|enospc") {
            return .disk
        }
        if matches("could not resolve host|connection (timed out|refused|reset)|network is unreachable|failed to connect|unable to access|temporary failure in name resolution|ssl|tls") {
            return .network
        }
        return .unknown
    }
}

enum CloneFailureCopy {
    /// The sentence under "Clone failed". `destination` shows the server's own
    /// text verbatim (it names the folder, never the token).
    static func message(kind: CloneErrorKind, raw: String) -> String {
        switch kind {
        case .permission: return "permission denied. The token may not have access to this repository."
        case .disk: return "not enough disk space in the clone location."
        case .network: return "a network error prevented the clone."
        case .destination: return raw.isEmpty ? "the destination folder can't be used." : raw
        case .unknown: return raw.isEmpty ? "the clone failed." : raw
        }
    }
}

enum RepoListError {
    /// One mapping for a failed repository listing, so the picker never renders
    /// a server code verbatim (port of `repoListErrorMessage`).
    static func message(code: String?) -> String {
        switch code {
        case "not_connected", "rejected":
            return "GitHub isn't connected. Go back and sign in again."
        case "rate_limited":
            return "GitHub's rate limit is used up. Try again in a few minutes."
        case "forbidden":
            return "GitHub refused this request. If the repositories belong to an organisation, it may require SSO authorisation for your sign-in."
        case "network":
            return "Couldn't reach GitHub from your server. Check its connection and try again."
        default:
            return "Couldn't list your repositories from GitHub."
        }
    }

    /// The box cleared (or never had) the credential: go back to sign-in.
    static func needsSignIn(code: String?) -> Bool {
        code == "rejected" || code == "not_connected"
    }
}

enum ClonePicker {
    /// The owners to filter by, sorted, without blanks or duplicates.
    static func owners(_ repos: [GitHubRepo]) -> [String] {
        Array(Set(repos.map(\.owner).filter { !$0.isEmpty })).sorted()
    }

    /// Owner AND query, case-insensitive, matching the full name or the name.
    /// `owner` nil = all owners.
    static func filter(repos: [GitHubRepo], owner: String?, query: String) -> [GitHubRepo] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return repos.filter { repo in
            if let owner, !owner.isEmpty, repo.owner != owner { return false }
            if q.isEmpty { return true }
            return repo.fullName.lowercased().contains(q) || repo.name.lowercased().contains(q)
        }
    }

    /// `<root>/<name>` with trailing slashes on the root dropped.
    static func dest(root: String, name: String) -> String {
        var trimmed = root
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return "\(trimmed)/\(name)"
    }
}

enum CloneProgressCopy {
    /// Human file size ("1.5 MB"). `ByteCountFormatter` `.file` style — the unit
    /// the user sees in Files and Finder.
    static func bytes(_ count: Double) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(max(0, count)))
    }

    /// "Cloning api · 42% · 1.5 MB".
    static func headline(name: String, percent: Double, bytes: Double) -> String {
        "Cloning \(name) · \(Int(max(0, min(100, percent)).rounded()))% · \(Self.bytes(bytes))"
    }
}

/// Repeated clone polling is bounded: the box times a clone out at 120 s, and
/// the client gives up a little after.
enum CloneTiming {
    static let pollInterval: TimeInterval = 0.5
    static let timeout: TimeInterval = 130
    /// Consecutive failed status reads before the clone UI gives up.
    static let maxConsecutiveThrows = 3
}
