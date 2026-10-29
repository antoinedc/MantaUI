import Foundation

// ===========================================================================
// WS10 F8–F12 — pure helpers behind the Extensions screens (plugins list,
// forge, skill registries, references, CLI launch options). Foundation-only
// ([pkg], D19). Each is a port of a desktop rule so the two clients can never
// disagree:
//   ExtensionsFormat      Settings.tsx `formatTimeout` + the plugin row text
//   ExtensionsRegistries  Settings.tsx onAddRegistry / onRemoveRegistry
//   ExtensionsReferences  settingsSchema.ts `validateReferenceAlias` /
//                         `classifyReferenceTarget` + the add payload
// (The GitHub row's secondary line and the launcher option values are the BOX's
// now — `forge:status.secondary`, `launchers:list` `value` — WS11 D3.)
// ===========================================================================

enum ExtensionsFormat {

    /// "5s" / "30m" — a plugin's timeout.
    static func timeout(ms: Double) -> String {
        if ms < 1000 { return "\(Int(ms))ms" }
        if ms < 60_000 { return "\(Int((ms / 1000).rounded()))s" }
        return "\(Int((ms / 60_000).rounded()))m"
    }

    /// "3 steps · 30s" (singular for one step; the timeout is omitted when the
    /// plugin declares none).
    static func stepsLine(stepCount: Int, timeoutMs: Double?) -> String {
        let steps = "\(stepCount) step\(stepCount == 1 ? "" : "s")"
        guard let timeoutMs else { return steps }
        return "\(steps) · \(timeout(ms: timeoutMs))"
    }

    /// "Inputs: id=\"default\", other" — each input id, with its default when it
    /// declares one (JSON-formatted like the desktop's `JSON.stringify`). Nil when
    /// the plugin takes no inputs.
    static func inputsLine(_ inputs: [PluginRegistryInput]) -> String? {
        guard !inputs.isEmpty else { return nil }
        let parts = inputs.map { input -> String in
            guard let value = input.default else { return input.id }
            return "\(input.id)=\(jsonText(value))"
        }
        return "Inputs: " + parts.joined(separator: ", ")
    }

    /// `JSON.stringify` for the handful of shapes a plugin default can be.
    static func jsonText(_ value: JSONValue) -> String {
        switch value {
        case .string(let s):
            guard let data = try? JSONEncoder().encode(s), let text = String(data: data, encoding: .utf8) else {
                return "\"\(s)\""
            }
            return text
        case .number(let n):
            return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b):
            return b ? "true" : "false"
        case .null:
            return "null"
        case .array(let items):
            return "[" + items.map(jsonText).joined(separator: ",") + "]"
        case .object(let object):
            let body = object.keys.sorted().map { key -> String in
                "\(jsonText(.string(key))):\(jsonText(object[key] ?? .null))"
            }
            return "{" + body.joined(separator: ",") + "}"
        }
    }

    /// "5 rules" / "1 rule" — `ruleCount` absent counts as 0.
    static func ruleCountText(_ count: Int?) -> String {
        let n = count ?? 0
        return "\(n) rule\(count == 1 ? "" : "s")"
    }
}

enum ExtensionsRegistries {

    /// The list with `url` appended; nil when it is blank or already there (the
    /// desktop ignores both silently — iOS tells the user why instead).
    static func add(_ url: String, to list: [String]) -> [String]? {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !list.contains(trimmed) else { return nil }
        return list + [trimmed]
    }

    static func remove(_ url: String, from list: [String]) -> [String] {
        list.filter { $0 != url }
    }
}

enum ExtensionsReferences {

    enum Kind: Equatable, Sendable {
        case path
        case repository
    }

    static let aliasRequired = "Alias is required."
    static let aliasInvalid = "Alias can't contain spaces, slashes, backticks, or commas."
    static let targetRequired = "Enter a local path or a repository."

    /// opencode forbids `/`, whitespace, backticks and commas in aliases (they
    /// would break @-mention parsing). Returns a user-facing error, or nil.
    static func validateAlias(_ alias: String) -> String? {
        let a = alias.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty { return aliasRequired }
        let forbidden = CharacterSet(charactersIn: "/` ,").union(.whitespacesAndNewlines)
        if a.unicodeScalars.contains(where: { forbidden.contains($0) }) { return aliasInvalid }
        return nil
    }

    /// Classify the combined "path or repository" field. A value that clearly
    /// looks like a local path (leading `/`, `./`, `../`, `~/`) is a path; git
    /// URLs, scp-style and bare `owner/repo` are repositories; everything else
    /// defaults to a path.
    static func classifyTarget(_ target: String) -> Kind {
        let t = target.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return .path }
        if t.hasPrefix("/") || t.hasPrefix("./") || t.hasPrefix("../") || t.hasPrefix("~/") { return .path }
        if t.contains("://") || t.hasPrefix("git@") || t.hasSuffix(".git")
            || t.range(of: #"^[^/\s]+:[^\s]+$"#, options: .regularExpression) != nil {
            return .repository
        }
        if t.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil {
            return .repository
        }
        return .path
    }

    /// One `upsert` entry for `opencode:set-references`: `{alias, path|repository,
    /// description?}` (description omitted when blank).
    static func upsertPayload(alias: String, target: String, description: String) -> [String: String] {
        let a = alias.trimmingCharacters(in: .whitespacesAndNewlines)
        let t = target.trimmingCharacters(in: .whitespacesAndNewlines)
        let d = description.trimmingCharacters(in: .whitespacesAndNewlines)
        var out: [String: String] = ["alias": a]
        out[classifyTarget(t) == .repository ? "repository" : "path"] = t
        if !d.isEmpty { out["description"] = d }
        return out
    }

    /// "@name → path" or "@name → repo (branch)" — plain fields so this stays
    /// independent of WS03's `OpencodeReferenceInfo`.
    static func displayTarget(name: String, path: String?, repository: String?, branch: String?) -> String {
        let target: String
        if let path {
            target = path
        } else if let repository {
            target = branch.map { $0.isEmpty ? repository : "\(repository) (\($0))" } ?? repository
        } else {
            target = ""
        }
        return "@\(name) → \(target)"
    }
}
