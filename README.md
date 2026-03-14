# MTG AdminPanel

Веб-панель для управления MTProto прокси (ninесекунд/mtg:2) через SSH.

## Установка
`bash
bash <(curl -fsSL https://raw.githubusercontent.com/MaksimTMB/mtg-adminpanel/main/install.sh)
`

## Обновление
`bash
bash <(curl -fsSL https://raw.githubusercontent.com/MaksimTMB/mtg-adminpanel/main/update.sh)
`

## Возможности
- Управление нодами по SSH (пароль или ключ)
- Клиенты: создание, stop/start, QR-коды, трафик
- Страница клиентов сгруппирована по нодам
- Мониторинг: статус нод каждые 20 сек
- Версии MTG на нодах + docker pull из веба
- Чекер обновлений панели через GitHub API
- 2FA TOTP (Google Authenticator)
- Адаптивный интерфейс

## Changelog
### v1.6.0
- Редизайн UI: Geist шрифт, Lucide Icons
- Клиенты сгруппированы по нодам с трафиком
- Модальное окно версий и обновлений
- Авто-проверка SSH статуса каждые 20 сек

### v1.5.0
- Синхронизация клиентов, 2FA, QR-коды

