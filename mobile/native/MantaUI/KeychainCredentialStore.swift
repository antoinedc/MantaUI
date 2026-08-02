import Foundation
import Security

struct MantaCredentials: Codable, Equatable, Sendable {
    var serverUrl: String
    var boxId: String
    var boxToken: String
}

enum KeychainError: Error, Equatable {
    case status(OSStatus)
    case invalidData
}

struct KeychainCredentialStore: Sendable {
    static let shared = KeychainCredentialStore()

    private let service = "com.antoinedc.mantaui"
    private let account = "box-credentials"

    var boxToken: String? { (try? load())?.boxToken }
    var boxId: String? { (try? load())?.boxId }
    var serverURL: URL? { (try? load()).flatMap { URL(string: $0.serverUrl) } }

    func load() throws -> MantaCredentials? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainError.status(status)
        }
        guard let data = item as? Data else {
            throw KeychainError.invalidData
        }
        return try JSONDecoder().decode(MantaCredentials.self, from: data)
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
                throw KeychainError.status(status)
            }
        } else if lookup == errSecItemNotFound {
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(query as CFDictionary, nil)
            guard status == errSecSuccess else {
                throw KeychainError.status(status)
            }
        } else {
            throw KeychainError.status(lookup)
        }
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.status(status)
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
