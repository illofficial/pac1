import SwiftUI
import WebKit

struct WebViewContainer: UIViewRepresentable {
    @ObservedObject var coordinator: AppCoordinator

    func makeCoordinator() -> NavCoordinator {
        NavCoordinator(appCoordinator: coordinator)
    }

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()

        // Отдаём странице стабильный device_id ДО того, как выполнится
        // любой её код - app.js читает window.DEVICE_ID синхронно при старте
        // (см. frontend/app.js -> getDeviceId()).
        let deviceIdScript = WKUserScript(
            source: "window.DEVICE_ID = \"\(DeviceIdentity.current())\";",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(deviceIdScript)
        contentController.add(context.coordinator.jsBridge, name: JSBridge.handlerName)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black

        coordinator.webView = webView
        webView.load(URLRequest(url: Config.baseURL))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class NavCoordinator: NSObject, WKNavigationDelegate {
        let jsBridge = JSBridge()
        let appCoordinator: AppCoordinator

        init(appCoordinator: AppCoordinator) {
            self.appCoordinator = appCoordinator
            super.init()
            jsBridge.delegate = appCoordinator
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            appCoordinator.loadError = nil
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            appCoordinator.loadError = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            appCoordinator.loadError = error.localizedDescription
        }
    }
}
