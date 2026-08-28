# Apple root-сертификаты

`subscriptions.py` проверяет подпись Apple на каждой покупке через
`SignedDataVerifier` из официальной `app-store-server-library`. Для этого
ей нужны корневые сертификаты Apple (файлы `.cer`) - положи их в эту папку.

## Откуда взять

Страница Apple: https://www.apple.com/certificateauthority/

Скачай оттуда все текущие Apple Root Certificate Authority сертификаты
(на момент написания это как минимум `AppleRootCA-G3.cer`) и сохрани их
в этой папке как есть, в бинарном `.cer`-формате - код сам подхватит все
файлы `*.cer` отсюда при первом запросе на верификацию.

## Проверка

После того как файлы на месте:

```bash
cd backend
python3 -c "from subscriptions import _load_root_certificates as f; print(len(f()), 'сертификат(ов) найдено')"
```

Без сертификатов в этой папке `verify_and_apply(...)` откажет с понятной
ошибкой вместо того, чтобы молча доверять непроверенным данным от клиента.
