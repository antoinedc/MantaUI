import Foundation

// ===========================================================================
// S6 — composer prompt history (BET-1305): keyboard-toolbar ↑/↓ recall.
//
// Desktop parity for `src/renderer/hooks/useInputHistory.ts` +
// `src/renderer/chatShared.tsx`. History is LOCAL ONLY: live-transcript user
// turns ++ UserDefaults persistence, keyed by the tmux session + window index
// (NOT the opencode sessionId — /clear swaps the sessionId, the window
// survives). Everything is pure except the UserDefaults reads/writes, and
// those are injected with a `.standard` default so tests pass a throwaway
// suite. No RPC, no server work.
// ===========================================================================

/// Persisted prompt history — mirrors desktop chatShared.tsx exactly (same
/// `HISTORY_MAX`, same key shape, same tolerant reads, same append rules).
enum PromptHistoryStore {
    static let historyMax = 200

    /// SAME string shape as desktop `historyKey()`.
    static func key(tmuxSession: String, windowIndex: Int) -> String {
        "manta:window:\(tmuxSession):\(windowIndex):history"
    }

    /// nil session or nil index → []. JSON array of strings under key();
    /// missing key / malformed / non-string elements → [] (tolerant).
    static func read(tmuxSession: String?, windowIndex: Int?, defaults: UserDefaults = .standard) -> [String] {
        guard let tmuxSession, let windowIndex else { return [] }
        guard let raw = defaults.string(forKey: key(tmuxSession: tmuxSession, windowIndex: windowIndex)),
              let data = raw.data(using: .utf8) else { return [] }
        guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
        return parsed.compactMap { $0 as? String }
    }

    /// Trim; no-op when session/index nil OR trimmed empty; skip when the
    /// stored list's LAST element equals the trimmed text (collapse
    /// consecutive duplicate); cap at historyMax keeping the newest.
    static func append(_ text: String, tmuxSession: String?, windowIndex: Int?, defaults: UserDefaults = .standard) {
        guard let tmuxSession, let windowIndex else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var list = read(tmuxSession: tmuxSession, windowIndex: windowIndex, defaults: defaults)
        guard list.last != trimmed else { return }
        list.append(trimmed)
        if list.count > historyMax {
            list = Array(list.suffix(historyMax))
        }
        if let data = try? JSONSerialization.data(withJSONObject: list) {
            defaults.set(String(data: data, encoding: .utf8), forKey: key(tmuxSession: tmuxSession, windowIndex: windowIndex))
        }
    }
}

/// Pure. persisted ++ transcript; drop empty strings; collapse CONSECUTIVE
/// duplicates (this handles the "last persisted == first transcript" seam).
func mergePromptHistory(persisted: [String], transcript: [String]) -> [String] {
    var out: [String] = []
    for item in persisted + transcript {
        if item.isEmpty { continue }
        if out.last == item { continue }
        out.append(item)
    }
    return out
}

/// Up/down navigation state machine — desktop `useInputHistory` parity. Pure.
struct ComposerHistoryNavigator {
    /// Chronological, freshest LAST.
    let entries: [String]
    /// nil = live draft (not cycling).
    private(set) var index: Int?
    private(set) var savedDraft = ""

    init(entries: [String]) {
        self.entries = entries
    }

    /// Returns text to put into the editor, or nil for a no-op.
    /// index == nil      → save currentDraft, jump to LAST entry, return it.
    /// index == 0        → stay at 0, return entries[0] again (desktop parity).
    /// otherwise         → index -= 1, return that entry.
    mutating func up(currentDraft: String) -> String? {
        guard !entries.isEmpty else { return nil }
        if let current = index {
            if current == 0 {
                return entries[0]
            }
            index = current - 1
            return entries[current - 1]
        } else {
            savedDraft = currentDraft
            index = entries.count - 1
            return entries[entries.count - 1]
        }
    }

    /// index == nil → nil (no-op). Past the newest entry → exit cycling
    /// (index = nil) and return savedDraft (draft restored). Otherwise
    /// index += 1 and return that entry.
    mutating func down() -> String? {
        guard let current = index else { return nil }
        if current + 1 >= entries.count {
            index = nil
            return savedDraft
        }
        index = current + 1
        return entries[current + 1]
    }

    /// Exit cycling (index = nil). Called when the user edits by typing.
    mutating func reset() {
        index = nil
    }
}
