import Foundation

/// Общие константы приложения. Единственное, что почти наверняка нужно
/// поменять перед первым запуском - baseURL (см. backend/README.md про
/// деплой) и productIDs (создаются в App Store Connect - см. ios-app/README.md).
enum Config {
    /// Публичный адрес задеплоенного бэкенда. WKWebView на реальном
    /// устройстве не сможет достучаться до localhost твоего компьютера -
    /// нужен настоящий HTTPS-адрес.
    static let baseURL = URL(string: "https://mastering.example.com")!

    /// ID продуктов из App Store Connect -> Features -> In-App Purchases.
    /// Один автопродлеваемый тариф "Pro" на первое время - достаточно.
    static let productIDs = ["com.example.masteringapp.pro.monthly"]
}
