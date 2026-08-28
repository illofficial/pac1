import SwiftUI

struct ContentView: View {
    @StateObject private var storeManager = StoreManager()
    @StateObject private var coordinator = AppCoordinator()

    var body: some View {
        ZStack {
            WebViewContainer(coordinator: coordinator)
                .ignoresSafeArea()

            if coordinator.isDownloading {
                ProgressView("Готовим файл…")
                    .padding()
                    .background(.ultraThinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }

            if let error = coordinator.loadError {
                VStack(spacing: 12) {
                    Text("Не удалось загрузить сервис")
                        .font(.headline)
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Повторить") {
                        coordinator.loadError = nil
                        coordinator.webView?.reload()
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding()
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .padding()
            }
        }
        .alert(
            "Ошибка скачивания",
            isPresented: Binding(
                get: { coordinator.downloadError != nil },
                set: { if !$0 { coordinator.downloadError = nil } }
            )
        ) {
            Button("Ок", role: .cancel) {}
        } message: {
            Text(coordinator.downloadError ?? "")
        }
        .sheet(isPresented: $coordinator.showPaywall) {
            PaywallView(store: storeManager)
        }
        .sheet(
            isPresented: Binding(
                get: { coordinator.shareURL != nil },
                set: { if !$0 { coordinator.shareURL = nil } }
            )
        ) {
            if let url = coordinator.shareURL {
                ActivityView(activityItems: [url])
            }
        }
        .onChange(of: storeManager.isEntitled) { entitled in
            if entitled {
                coordinator.showPaywall = false
                coordinator.notifyEntitlementUpdated()
            }
        }
    }
}
