import Foundation
import Security

/// Стабильный идентификатор устройства для лимитов бесплатного тарифа и
/// привязки подписки на бэкенде (см. backend/subscriptions.py). Хранится в
/// Keychain, а не UserDefaults, потому что Keychain (с правильным
/// accessible-классом) переживает переустановку приложения - UserDefaults
/// нет. Это НЕ замена нормальной авторизации по аккаунту: если пользователь
/// сменит телефон, подписка "потеряется" до Restore Purchases - см.
/// ios-app/README.md, что нужно для полноценного мульти-девайсного аккаунта.
enum DeviceIdentity {
    private static let service = "com.example.masteringapp.device"
    private static let account = "device_id"

    static func current() -> String {
        if let existing = read() {
            return existing
        }
        let fresh = UUID().uuidString
        save(fresh)
        return fresh
    }

    private static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func save(_ value: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // На случай гонки/повторной записи - удаляем перед вставкой, а не апдейтим.
        SecItemDelete(query as CFDictionary)

        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attributes as CFDictionary, nil)
    }
}
