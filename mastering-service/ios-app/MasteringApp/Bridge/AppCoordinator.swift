import Foundation
import WebKit

/// Единая точка состояния между WebView, paywall-шитом и скачиванием.
/// Сознательно один класс, а не несколько вложенных ObservableObject:
/// вложенные @Published-объекты не пробрасывают изменения наверх в SwiftUI
/// само по себе, а плодить лишние prox-подписки того не стоит.
@MainActor
final class AppCoordinator: ObservableObject, JSBridgeDelegate {
    @Published var showPaywall = false
    @Published var loadError: String?

    @Published var shareURL: URL?
    @Published var isDownloading = false
    @Published var downloadError: String?

    weak var webView: WKWebView?

    /// Зовётся после того, как бэкенд подтвердил подписку - страница сама
    /// решает, что делать (см. app.js: window.onEntitlementUpdated).
    func notifyEntitlementUpdated() {
        webView?.evaluateJavaScript("window.onEntitlementUpdated && window.onEntitlementUpdated();")
    }

    // MARK: - JSBridgeDelegate

    func jsBridgeDidRequestPaywall() {
        showPaywall = true
    }

    func jsBridgeDidRequestDownload(urlString: String, filename: String) {
        guard let remoteURL = URL(string: urlString) else {
            downloadError = "Некорректная ссылка на файл"
            return
        }
        isDownloading = true
        downloadError = nil

        Task {
            do {
                let (tempURL, _) = try await URLSession.shared.download(from: remoteURL)
                let destination = FileManager.default.temporaryDirectory
                    .appendingPathComponent(Self.sanitizeFilename(filename))
                try? FileManager.default.removeItem(at: destination)
                try FileManager.default.moveItem(at: tempURL, to: destination)
                shareURL = destination
            } catch {
                downloadError = "Не удалось скачать файл: \(error.localizedDescription)"
            }
            isDownloading = false
        }
    }

    private static func sanitizeFilename(_ name: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: " -_."))
        let cleaned = String(name.unicodeScalars.filter { allowed.contains($0) })
        return cleaned.isEmpty ? "master.wav" : cleaned
    }
}
