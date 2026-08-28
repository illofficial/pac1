import SwiftUI
import UIKit

/// Системный share sheet - им пользователь сохраняет скачанный WAV в Files,
/// AirDrop, отправляет в другое приложение и т.п. WKWebView сам по себе не
/// умеет надёжно сохранять файлы с сервера, поэтому скачивание идёт через
/// AppCoordinator.jsBridgeDidRequestDownload, а не через <a download>.
struct ActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
