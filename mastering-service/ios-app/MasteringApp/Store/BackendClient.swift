import Foundation

struct SubscriptionStatus: Decodable {
    let entitled: Bool
    let max_duration_seconds: Int
    let daily_limit: Int
    let used_today: Int
}

enum BackendError: LocalizedError {
    case server(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .server(let message): return message
        case .invalidResponse: return "Некорректный ответ сервера"
        }
    }
}

/// Тонкий клиент только для того, что нужно нативной стороне: подтвердить
/// покупку и узнать текущий статус подписки. Основной поток (ссылка ->
/// обработка -> скачивание) целиком живёт в вебе (frontend/app.js) - тут
/// дублировать его не нужно.
final class BackendClient {
    static let shared = BackendClient()
    private init() {}

    func verifySubscription(signedTransactionInfo: String) async throws {
        var request = URLRequest(url: Config.baseURL.appendingPathComponent("api/subscription/verify"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = [
            "device_id": DeviceIdentity.current(),
            "signed_transaction_info": signedTransactionInfo,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BackendError.invalidResponse }
        guard (200...299).contains(http.statusCode) else {
            let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["detail"] as? String
            throw BackendError.server(detail ?? "Сервер отклонил подписку (\(http.statusCode))")
        }
    }

    func subscriptionStatus() async throws -> SubscriptionStatus {
        var request = URLRequest(url: Config.baseURL.appendingPathComponent("api/subscription/status"))
        request.setValue(DeviceIdentity.current(), forHTTPHeaderField: "X-Device-Id")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw BackendError.invalidResponse
        }
        return try JSONDecoder().decode(SubscriptionStatus.self, from: data)
    }
}
