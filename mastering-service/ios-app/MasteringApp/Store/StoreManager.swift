import Foundation
import StoreKit

/// Обёртка над StoreKit 2. Источник правды по факту доступа - бэкенд
/// (subscriptions.py), а не локальный isEntitled: StoreKit проверяет
/// подпись Apple локально, но именно ответ /api/subscription/verify
/// решает, откроется ли доступ, потому что бэкенд и должен применять лимиты.
@MainActor
final class StoreManager: ObservableObject {
    @Published private(set) var products: [Product] = []
    @Published private(set) var isEntitled = false
    @Published private(set) var isLoadingProducts = false
    @Published var lastError: String?

    private var updatesTask: Task<Void, Never>?

    init() {
        updatesTask = listenForTransactionUpdates()
        Task {
            await loadProducts()
            await refreshEntitlement()
        }
    }

    deinit {
        updatesTask?.cancel()
    }

    func loadProducts() async {
        isLoadingProducts = true
        defer { isLoadingProducts = false }
        do {
            products = try await Product.products(for: Config.productIDs)
        } catch {
            lastError = "Не удалось загрузить тарифы: \(error.localizedDescription)"
        }
    }

    func purchase(_ product: Product) async {
        lastError = nil
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                await handle(verification: verification)
            case .userCancelled:
                break
            case .pending:
                lastError = "Покупка ожидает подтверждения (например, Ask to Buy)."
            @unknown default:
                break
            }
        } catch {
            lastError = "Покупка не удалась: \(error.localizedDescription)"
        }
    }

    func restorePurchases() async {
        do {
            try await AppStore.sync()
            await refreshEntitlement()
        } catch {
            lastError = "Не удалось восстановить покупки: \(error.localizedDescription)"
        }
    }

    func refreshEntitlement() async {
        if let status = try? await BackendClient.shared.subscriptionStatus() {
            isEntitled = status.entitled
        }
    }

    // MARK: - Private

    private func listenForTransactionUpdates() -> Task<Void, Never> {
        Task.detached { [weak self] in
            for await update in Transaction.updates {
                await self?.handle(verification: update)
            }
        }
    }

    private func handle(verification: VerificationResult<Transaction>) async {
        switch verification {
        case .verified(let transaction):
            do {
                try await BackendClient.shared.verifySubscription(signedTransactionInfo: verification.jwsRepresentation)
                isEntitled = true
                await transaction.finish()
            } catch {
                // Не финишируем транзакцию - StoreKit повторно отдаст её через
                // Transaction.updates при следующей попытке/запуске, так что
                // временный сбой сети на бэкенде не "теряет" покупку.
                lastError = "Сервер не подтвердил подписку: \(error.localizedDescription)"
            }
        case .unverified(_, let error):
            lastError = "StoreKit не смог локально подтвердить транзакцию: \(error.localizedDescription)"
        }
    }
}
