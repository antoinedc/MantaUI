import Foundation
import Security
import Synchronization

struct MantaCredentials: Codable, Equatable, Sendable {
    var serverUrl: String
    var boxId: String
    var boxToken: String
}

enum KeychainError: Error, Equatable {
    case status(OSStatus)
    case invalidData
}

/// What the process last learned about the Keychain item: the stored
/// credentials, or that there are none. Never holds a failed read.
enum CredentialCacheEntry: Equatable, Sendable {
    case credentials(MantaCredentials)
    case absent
}

/// In-memory copy of the Keychain item. Every chat redraw used to read the
/// Keychain on the main thread; with this, only the first read per launch (and
/// the first after a failed read) does.
///
/// A write bumps `generation`, and a read that started before the write cannot
/// store its (older) answer afterwards: `fill` only lands if the generation is
/// the one the read began with. Thread-safe by `Mutex`, so no `@unchecked`.
final class CredentialCache: Sendable {
    private struct State: Sendable {
        var entry: CredentialCacheEntry?
        var generation = 0
    }

    private let state = Mutex(State())

    /// The cached entry (nil = never read / invalidated) and the generation to hand back to `fill`.
    func snapshot() -> (entry: CredentialCacheEntry?, generation: Int) {
        state.withLock { ($0.entry, $0.generation) }
    }

    /// Store the result of a read, unless a write landed since `generation` was taken.
    func fill(_ entry: CredentialCacheEntry, ifGeneration generation: Int) {
        state.withLock { state in
            guard state.generation == generation else { return }
            state.entry = entry
        }
    }

    /// A save or delete succeeded: the cache now equals the Keychain.
    func set(_ entry: CredentialCacheEntry) {
        state.withLock { state in
            state.generation += 1
            state.entry = entry
        }
    }

    /// Forget everything (the next read goes to the Keychain).
    func invalidate() {
        state.withLock { state in
            state.generation += 1
            state.entry = nil
        }
    }
}

struct KeychainCredentialStore: Sendable {
    static let shared = KeychainCredentialStore()

    /// One cache for the whole process, not one per instance: the Keychain item
    /// is process-global, and tests (and any future caller) build their own
    /// `KeychainCredentialStore()` next to `.shared`. Per-instance caches would
    /// disagree with each other after a save/delete through another instance.
    private static let cache = CredentialCache()

    private let service = "com.antoinedc.mantaui"
    private let account = "box-credentials"

    var boxToken: String? { (try? load())?.boxToken }
    var boxId: String? { (try? load())?.boxId }
    var serverURL: URL? { (try? load()).flatMap { URL(string: $0.serverUrl) } }

    func load() throws -> MantaCredentials? {
        let cache = Self.cache
        let (cached, generation) = cache.snapshot()
        switch cached {
        case .credentials(let credentials): return credentials
        case .absent: return nil
        case nil: break
        }

        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            cache.fill(.absent, ifGeneration: generation)
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainError.status(status)
        }
        guard let data = item as? Data else {
            throw KeychainError.invalidData
        }
        let credentials = try JSONDecoder().decode(MantaCredentials.self, from: data)
        cache.fill(.credentials(credentials), ifGeneration: generation)
        return credentials
    }

    func save(_ credentials: MantaCredentials) throws {
        let data = try JSONEncoder().encode(credentials)
        var query = baseQuery()
        var item: CFTypeRef?
        let lookup = SecItemCopyMatching(query as CFDictionary, &item)
        if lookup == errSecSuccess {
            let update: [String: Any] = [kSecValueData as String: data]
            let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
            guard status == errSecSuccess else {
                Self.cache.invalidate()
                throw KeychainError.status(status)
            }
        } else if lookup == errSecItemNotFound {
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(query as CFDictionary, nil)
            guard status == errSecSuccess else {
                Self.cache.invalidate()
                throw KeychainError.status(status)
            }
        } else {
            Self.cache.invalidate()
            throw KeychainError.status(lookup)
        }
        Self.cache.set(.credentials(credentials))
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            Self.cache.invalidate()
            throw KeychainError.status(status)
        }
        Self.cache.set(.absent)
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
