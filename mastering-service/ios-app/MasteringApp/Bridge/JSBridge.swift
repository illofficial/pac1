import Foundation
import WebKit

/// Контракт сообщений от страницы (frontend/app.js) к нативной стороне.
/// Всё зеркалит to то, что шлёт app.js через
/// window.webkit.messageHandlers.nativeBridge.postMessage(...).
@MainActor
protocol JSBridgeDelegate: AnyObject {
    func jsBridgeDidRequestPaywall()
    func jsBridgeDidRequestDownload(urlString: String, filename: String)
}

final class JSBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "nativeBridge"

    weak var delegate: JSBridgeDelegate?

    // WKScriptMessageHandler гарантированно вызывается на главном потоке
    // (см. документацию WebKit), но сам метод не изолирован на @MainActor
    // статически - поэтому явно прыгаем в Task { @MainActor in ... }, чтобы
    // безопасно звать делегата без предупреждений Swift concurrency.
    func userContentController(_ userContentController: WKUserContentController,
                                didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        Task { @MainActor in
            switch type {
            case "show_paywall":
                delegate?.jsBridgeDidRequestPaywall()
            case "download":
                guard let urlString = body["url"] as? String else { return }
                let filename = (body["filename"] as? String) ?? "master.wav"
                delegate?.jsBridgeDidRequestDownload(urlString: urlString, filename: filename)
            default:
                break
            }
        }
    }
}
