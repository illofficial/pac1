# 111C — iOS-обёртка (Swift + WKWebView + StoreKit 2)

WKWebView-обёртка вокруг задеплоенного сайта (`mastering-service/backend` +
`frontend`) с нативным paywall на StoreKit 2. Веб-страница отправляет
нативной стороне два типа сообщений через JS-мост: «покажи paywall» и
«скачай файл» (WKWebView сам не умеет надёжно скачивать файлы — вместо
этого нативный код скачивает WAV и показывает системный share sheet).

**Это исходники для проекта, который нужно создать в Xcode — не готовый
`.xcodeproj`.** Я не могу собрать и прогнать это в Xcode из своей среды
(там нет iOS SDK и вообще macOS), поэтому весь код написан по официальному
API StoreKit 2/WebKit максимально аккуратно, но первую сборку стоит сделать
внимательно и решить, если Xcode что-то подсветит.

## 1. Создать проект

1. Xcode → File → New → Project → iOS → App.
2. Interface: **SwiftUI**, Language: **Swift**.
3. Bundle Identifier — запомни, он понадобится в App Store Connect и в
   `subscriptions.py` (`APP_BUNDLE_ID`) на бэкенде.
4. Deployment target — iOS 16 или новее (StoreKit 2 требует минимум iOS 15,
   но 16 безопаснее для использованных API).
5. Удали дефолтные `ContentView.swift` / `ЁName}App.swift`, которые создаёт
   Xcode, и добавь в проект все файлы из `MasteringApp/` (Add Files to
   "…", сохраняя структуру папок `Bridge/`, `Web/`, `Store/`, `Paywall/`).
6. Добавь `Mastering.storekit` в проект (просто перетащить в навигатор).

## 2. Настроить StoreKit-тестирование (без App Store Connect)

1. Product → Scheme → Edit Scheme → Run → Options → StoreKit Configuration
   → выбери `Mastering.storekit`.
2. Теперь можно тестировать покупки прямо в симуляторе/на устройстве без
   реального Apple ID и без ожидания ревью — StoreKit подставляет
   тестовые транзакции.
3. Открой `Mastering.storekit` в Xcode (двойной клик) и в UI редактора
   можешь подправить цену/название — это удобнее, чем руками редактировать
   JSON.

## 3. Указать реальный адрес бэкенда

В `Config.swift`:

```swift
static let baseURL = URL(string: "https://mastering.example.com")!
```

Замени на настоящий адрес после деплоя (см. `backend/README.md`). Без
HTTPS-адреса, доступного из интернета, WKWebView на реальном устройстве
ничего не загрузит.

Если тестируешь с бэкендом без HTTPS (например, `http://192.168.x.x:8000`
в локальной сети) — добавь в `Info.plist` исключение App Transport
Security для этого конкретного адреса (не `NSAllowsArbitraryLoads` целиком
- это Apple не любит на ревью):

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSExceptionDomains</key>
    <dict>
        <key>192.168.x.x</key>
        <dict>
            <key>NSExceptionAllowsInsecureHTTPLoads</key>
            <true/>
        </dict>
    </dict>
</dict>
```

## 4. App Store Connect: создать приложение и подписку

Аккаунт разработчика уже есть, приложение ещё нет — вот шаги:

1. **Создать приложение**: App Store Connect → Apps → "+" → New App.
   Bundle ID — тот же, что выбрал в Xcode на шаге 1.
2. Как только приложение создано, у него появится числовой **Apple ID
   приложения** (App Information → Apple ID) — это значение пойдёт в
   переменную окружения `APP_APPLE_ID` на бэкенде (`subscriptions.py`).
3. **Создать подписку**: приложение → Features (или Monetization, в
   зависимости от версии интерфейса) → In-App Purchases / Subscriptions →
   Create Subscription Group ("Pro") → внутри группы создать
   Auto-Renewable Subscription с Product ID, СОВПАДАЮЩИМ с тем, что в
   `Config.productIDs` (`com.example.masteringapp.pro.monthly`).
   Заполнить цену, локализацию (название/описание), Review Information
   (скриншот paywall).
4. Первая версия подписки отправляется на ревью ВМЕСТЕ с первой сборкой
   приложения — по отдельности Apple подписку не рассматривает.

## 5. Настроить бэкенд под реальную проверку подписи

На сервере (переменные окружения перед запуском `uvicorn`):

```bash
export APP_BUNDLE_ID="com.example.masteringapp"   # bundle id из шага 1
export APP_APPLE_ID="1234567890"                   # Apple ID приложения из шага 2
export APP_ENV="production"                          # "sandbox" по умолчанию, для TestFlight/локальных тестов
```

И положить Apple root-сертификаты в `backend/certs/` — см.
`backend/certs/README.md`. Без них `/api/subscription/verify` осознанно
отказывает с понятной ошибкой вместо того, чтобы доверять клиенту вслепую.

## 6. Про guideline 3.1.1 (важно)

Всё в этом проекте уже устроено так, чтобы соответствовать требованию
Apple: оплата идёт ТОЛЬКО через StoreKit 2 (`StoreManager.purchase`), а не
через веб-чекаут внутри WKWebView. Бэкенд активирует Pro только после
проверки подписи Apple на транзакции (`subscriptions.py`). Это должно
пройти ревью при условии, что в самом приложении (не только в вебе) нет
альтернативных путей оплаты и ссылок "оформить подписку на сайте".

## 7. Что стоит доделать перед реальным релизом

- **Restore Purchases уже есть** (кнопка в paywall), но подписка всё ещё
  привязана к `device_id` в Keychain, а не к аккаунту пользователя — при
  смене телефона понадобится Restore Purchases, чтобы её вернуть. Для
  многоустройственного сценария (веб + приложение под одним аккаунтом)
  нужна отдельная система логина - сейчас её здесь нет.
- **App Store Server Notifications V2** - сейчас бэкенд узнаёт о подписке
  только когда приложение само присылает транзакцию. Если пользователь
  отменит подписку или не продлит её, бэкенд об этом не узнает, пока
  клиент не спросит `/api/subscription/status` заново, а expires_at не
  истечёт сам по себе (это ОК - is_entitled() уже проверяет expires_at) -
  но для точного и мгновенного обновления (например, чтобы сразу показать
  "подписка отменена") стоит подключить вебхуки Apple.
- **Скриншоты и Review Notes для ревьюера** - подготовь тестовый Sandbox
  Apple ID и объясни ревьюеру, как получить доступ к платной функции
  (Apple требует показать paywall при ревью).
- Иконка приложения, launch screen, экран онбординга - в этом проекте не
  затронуты, чистый WebView + paywall.
