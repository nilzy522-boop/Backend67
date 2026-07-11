# FunTime Proxy

Кэширующая прослойка между [FunTime API](https://api.funtime.su/) и вашим Minecraft-модом.

- Опрашивает FunTime API с заданной частотой (по умолчанию 100 запросов/мин)
- Кэширует шахты, ивенты и список серверов
- Отдаёт данные моду мгновенно, без обращения к FunTime на каждый запрос
- Токен FunTime и все настройки задаются через веб админ-панель
- API открыто для всех пользователей мода (авторизация по HWID планируется позже), от спама защищает лимит запросов по IP
- **Без зависимостей** — только Node.js 18+, `npm install` не нужен

---

## Быстрый старт

```bash
node server.js
```

Токен FunTime уже предустановлен — сервер начинает собирать данные сразу после запуска.

Админка: `http://ваш-ip:8080/admin` — там можно сменить токен, частоту опроса,
тип ивентов, лимит по IP и пароль админки.

Порт можно сменить через переменную окружения: `PORT=9000 node server.js`

---

## API для мода

Все запросы — обычные GET без авторизации.

| Метод | Описание |
|---|---|
| `GET /api/mines` | Шахты по всем серверам |
| `GET /api/mines?server=anarchy101` | Шахты конкретного сервера |
| `GET /api/events` | Ивенты по всем серверам |
| `GET /api/events?server=anarchy101` | Ивенты конкретного сервера |
| `GET /api/servers` | Список серверов |
| `GET /api/status` | Статус: свежесть кэша, последняя ошибка |

Пример ответа `/api/mines?server=anarchy101`:

```json
{
  "success": true,
  "updatedAt": 1752241234567,
  "servers": {
    "anarchy101": [
      {
        "server-ru-name": "Анархия-101",
        "mine-name": "mine_1",
        "mine-rarity": "default",
        "next-mine-rarity": "mythical",
        "reset-seconds-left": 420
      }
    ]
  }
}
```

Код ошибки `429` — превышен лимит запросов с одного IP (по умолчанию 120/мин, настраивается в админке).

Авторизация пользователей сейчас отключена. В коде (`server.js`) оставлена отметка
`TODO: здесь позже будет проверка HWID` — туда позже вставляется проверка HWID.

---

## Как это работает

Сервер крутит задачи по кругу с интервалом `60000 / requestsPerMinute` мс:

1. `/servers-info` — актуальный список серверов
2. `/mines-info?server-types=all` — все шахты одним запросом
3. `/events-info` — ивенты чанками по 30 серверов (ограничение FunTime API)

При ответе `402 Limitation requests by token` опрос ставится на паузу 10 секунд.
Если 402 появляется часто (смотрите `lastError` в `/api/status`) — уменьшите
«Запросов в минуту» в админке. У шахт есть таймер `reset-seconds-left`, так что
обновление раз в 2–5 секунд более чем достаточно.

---

## Подключение в моде

Готовый класс: [`mod-example/FunTimeProxyClient.java`](mod-example/FunTimeProxyClient.java)
(использует Gson, который уже есть в Minecraft).

```java
FunTimeProxyClient api = new FunTimeProxyClient("http://ваш-ip:8080");

api.getMinesAsync("anarchy101").thenAccept(json -> {
    // вызывается в фоновом потоке — не трогайте игровые объекты напрямую,
    // перекидывайте результат в игровой поток через client.execute(...)
});
```

---

## Запуск на VPS в фоне (systemd)

Создайте `/etc/systemd/system/funtime-proxy.service`:

```ini
[Unit]
Description=FunTime Proxy
After=network.target

[Service]
WorkingDirectory=/opt/funtime-proxy
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now funtime-proxy
```

---

## Безопасность

- Токен FunTime и пароль админки предустановлены в коде — перед релизом смените их через админку
- В идеале закройте `/admin` от внешнего мира (фаервол/nginx только с вашего IP)
- Если стоите за nginx/Cloudflare — IP клиента берётся из `X-Forwarded-For`
- Файл `config.json` содержит токен и пароли — не коммитьте его в git и не раздавайте вместе с модом
