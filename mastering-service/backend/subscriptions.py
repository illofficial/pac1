"""
subscriptions.py - подписка/paywall на стороне бэкенда.

Источник правды - Apple. iOS-приложение после успешной покупки в StoreKit 2
присылает сюда подписанную транзакцию (Transaction.jwsRepresentation), а
бэкенд проверяет её ПОДПИСЬ официальной библиотекой Apple
(app-store-server-library), а не просто декодирует payload без проверки -
это принципиально: без проверки подписи любой может подделать себе
подписку одним POST-запросом со своим device_id.

Настройка перед реальным использованием:
  1. app-store-server-library уже в requirements.txt.
  2. Скачать Apple root-сертификаты и положить .cer файлы в backend/certs/
     - см. certs/README.md.
  3. Задать переменные окружения APP_BUNDLE_ID (Bundle Identifier из Xcode/
     App Store Connect) и APP_APPLE_ID (числовой Apple ID приложения,
     появляется после создания приложения в App Store Connect).
  4. На проде выставить APP_ENV=production (по умолчанию - sandbox, для
     тестовых покупок через StoreKit Testing/TestFlight).

Тарифы прототипа:
  - Free: 1 трек/день, до 3 минут исходника.
  - Pro (подписка): до 30 треков/день, до 10 минут исходника.
  Числа - отправная точка, не результат расчётов юнит-экономики; поменяй
  под реальные затраты (минута обработки + YouTube-риск, см. README).
"""
import glob
import os
import time
from dataclasses import dataclass
from threading import Lock
from typing import Dict, Optional

from appstoreserverlibrary.models.Environment import Environment
from appstoreserverlibrary.signed_data_verifier import SignedDataVerifier, VerificationException

BUNDLE_ID = os.environ.get("APP_BUNDLE_ID", "com.example.masteringapp")
APP_APPLE_ID = os.environ.get("APP_APPLE_ID")  # заполнить после создания приложения в App Store Connect
APPLE_ENVIRONMENT = (
    Environment.PRODUCTION if os.environ.get("APP_ENV", "sandbox") == "production" else Environment.SANDBOX
)

CERTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs")

FREE_MAX_DURATION_SECONDS = 3 * 60
FREE_DAILY_LIMIT = 1
PRO_MAX_DURATION_SECONDS = 10 * 60
PRO_DAILY_LIMIT = 30


def _load_root_certificates() -> list:
    certs = []
    for path in glob.glob(os.path.join(CERTS_DIR, "*.cer")):
        with open(path, "rb") as f:
            certs.append(f.read())
    return certs


_verifier: Optional[SignedDataVerifier] = None


def _get_verifier() -> SignedDataVerifier:
    global _verifier
    if _verifier is None:
        root_certs = _load_root_certificates()
        if not root_certs:
            raise RuntimeError(
                "Apple root-сертификаты не найдены в backend/certs/ - см. certs/README.md. "
                "Без них проверка подписи покупки невозможна, поэтому фейлимся громко, а не тихо доверяем клиенту."
            )
        _verifier = SignedDataVerifier(
            root_certificates=root_certs,
            enable_online_checks=(APPLE_ENVIRONMENT == Environment.PRODUCTION),
            environment=APPLE_ENVIRONMENT,
            bundle_id=BUNDLE_ID,
            app_apple_id=int(APP_APPLE_ID) if APP_APPLE_ID else None,
        )
    return _verifier


@dataclass
class Entitlement:
    product_id: str
    original_transaction_id: str
    expires_at: float  # unix seconds


class TransactionVerificationError(Exception):
    """Не удалось проверить подпись транзакции Apple (невалидна, просрочена,
    отозвана, не для этого bundle_id и т.п.). Сообщение готово для показа
    как есть - не должно попасть напрямую пользователю без контекста."""


class EntitlementStore:
    """
    In-memory хранилище активных подписок по device_id + счётчик дневного
    использования. В проде это должна быть база данных, а device_id -
    дополниться нормальным account-based auth (см. README): подписка,
    привязанная только к устройству, "теряется" при смене телефона до тех
    пор, пока пользователь не нажмёт Restore Purchases.
    """

    def __init__(self) -> None:
        self._entitlements: Dict[str, Entitlement] = {}
        self._usage: Dict[str, Dict[str, int]] = {}  # device_id -> {"YYYY-MM-DD": count}
        self._lock = Lock()

    def apply_verified_transaction(self, device_id: str, product_id: str,
                                    original_transaction_id: str,
                                    expires_at_ms: Optional[int]) -> Entitlement:
        expires_at = (expires_at_ms / 1000.0) if expires_at_ms else 0.0
        ent = Entitlement(product_id=product_id,
                           original_transaction_id=original_transaction_id,
                           expires_at=expires_at)
        with self._lock:
            self._entitlements[device_id] = ent
        return ent

    def is_entitled(self, device_id: str) -> bool:
        with self._lock:
            ent = self._entitlements.get(device_id)
        return ent is not None and ent.expires_at > time.time()

    def record_usage(self, device_id: str) -> None:
        today = time.strftime("%Y-%m-%d")
        with self._lock:
            day_map = self._usage.setdefault(device_id, {})
            day_map[today] = day_map.get(today, 0) + 1

    def usage_today(self, device_id: str) -> int:
        today = time.strftime("%Y-%m-%d")
        with self._lock:
            return self._usage.get(device_id, {}).get(today, 0)

    def limits_for(self, device_id: str) -> dict:
        entitled = self.is_entitled(device_id)
        return {
            "entitled": entitled,
            "max_duration_seconds": PRO_MAX_DURATION_SECONDS if entitled else FREE_MAX_DURATION_SECONDS,
            "daily_limit": PRO_DAILY_LIMIT if entitled else FREE_DAILY_LIMIT,
            "used_today": self.usage_today(device_id),
        }


def verify_and_apply(store: EntitlementStore, device_id: str, signed_transaction_info: str) -> Entitlement:
    """
    Проверяет подпись Apple на signedTransactionInfo (JWS-строка из
    StoreKit 2 - Transaction.jwsRepresentation на устройстве) и, если
    подпись валидна, записывает/обновляет подписку в EntitlementStore.
    """
    try:
        payload = _get_verifier().verify_and_decode_signed_transaction(signed_transaction_info)
    except VerificationException as exc:
        raise TransactionVerificationError(f"Не удалось проверить транзакцию: {exc}") from exc

    if payload.revocationDate is not None:
        raise TransactionVerificationError("Транзакция отозвана (возврат средств)")

    return store.apply_verified_transaction(
        device_id=device_id,
        product_id=payload.productId or "unknown",
        original_transaction_id=payload.originalTransactionId or payload.transactionId or "unknown",
        expires_at_ms=payload.expiresDate,
    )
