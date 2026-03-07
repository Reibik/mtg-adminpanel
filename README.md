# 🔒 MTG AdminPanel

Веб-панель для управления MTProto прокси ([mtg v2](https://github.com/9seconds/mtg)) на нескольких серверах через SSH.

![Stack](https://img.shields.io/badge/Node.js-20-green) ![Docker](https://img.shields.io/badge/Docker-Compose-blue) ![SQLite](https://img.shields.io/badge/DB-SQLite-lightgrey) ![License](https://img.shields.io/badge/License-MIT-yellow)

## Возможности

- 🖥️ Управление несколькими нодами из одного интерфейса
- ➕ Добавление / удаление нод через веб (SSH пароль или ключ)
- 👥 Создание юзеров — каждый получает уникальную ссылку `tg://proxy`
- ⏸️ Остановка / запуск отдельных юзеров
- 📊 Дашборд с live-статусом всех нод
- 🔗 Копирование ссылки одним кликом
- 📋 Просмотр всех юзеров со всех нод в одной таблице

---

## Требования

- Ubuntu 20+ / Debian 11+
- Docker + Docker Compose
- На нодах: Docker, открытые порты 4433+ (TCP)

---

## Установка

### Вариант 1 — Простой (HTTP, без домена)

Подходит если нет домена и SSL не нужен.

```bash
# Клонируй репозиторий
git clone https://github.com/MaksimTMB/mtg-adminpanel.git
cd mtg-adminpanel

# Создай .env
cp .env.example .env
nano .env  # укажи свой AUTH_TOKEN

# Создай папки
mkdir -p data ssh_keys

# Запусти
docker compose up -d --build
```

Панель доступна на: `http://<IP_СЕРВЕРА>:3000`

---

### Вариант 2 — С доменом и SSL через Nginx (без NPM)

```bash
# Клонируй и настрой
git clone https://github.com/MaksimTMB/mtg-adminpanel.git
cd mtg-adminpanel
cp .env.example .env
nano .env  # укажи AUTH_TOKEN
mkdir -p data ssh_keys

# Установи Certbot
apt install -y certbot
certbot certonly --standalone -d proxy.yourdomain.com

# Установи Nginx
apt install -y nginx

# Создай конфиг
cat > /etc/nginx/sites-available/mtg-panel << 'EOF'
server {
    listen 80;
    server_name proxy.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name proxy.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/proxy.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/proxy.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF

ln -s /etc/nginx/sites-available/mtg-panel /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Запусти панель
docker compose up -d --build
```

Панель доступна на: `https://proxy.yourdomain.com`

---

### Вариант 3 — С Nginx Proxy Manager (NPM)

Если уже используешь NPM для управления доменами.

```bash
# Клонируй и настрой
git clone https://github.com/MaksimTMB/mtg-adminpanel.git
cd mtg-adminpanel
cp .env.example .env
nano .env  # укажи AUTH_TOKEN
mkdir -p data ssh_keys

# Запусти
docker compose up -d --build
```

В NPM добавь Proxy Host:

| Поле | Значение |
|------|----------|
| Domain Names | `proxy.yourdomain.com` |
| Scheme | `http` |
| Forward Hostname | IP сервера |
| Forward Port | `3000` |
| Force SSL | ✅ |
| SSL Certificate | Let's Encrypt |

---

## Настройка .env

```env
AUTH_TOKEN=your-secret-token   # токен для входа в панель
PORT=3000                      # порт панели
DATA_DIR=/data                 # путь к базе данных
```

---

## Добавление ноды

1. Открой панель → **Ноды** → **Добавить ноду**
2. Заполни:
   - **Название** — любое (Helsinki, Moscow...)
   - **Host / IP** — домен или IP ноды
   - **SSH User** — обычно `root`
   - **SSH Port** — обычно `22`
   - **Аутентификация** — пароль или SSH ключ
3. Нажми **Ping** — убедись что нода онлайн ✅
4. Перейди в **Управление** → **Добавить юзера**

### Требования к ноде

- Docker + Docker Compose установлены
- Открытые порты `4433+` (TCP) в файрволе / Security Group

---

## Структура проекта

```
mtg-adminpanel/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
├── README.md
├── backend/
│   ├── package.json
│   └── src/
│       ├── app.js      # Express API
│       ├── db.js       # SQLite
│       └── ssh.js      # SSH управление нодами
├── public/
│   └── index.html      # React SPA
├── data/               # SQLite БД (в .gitignore)
└── ssh_keys/           # SSH ключи (в .gitignore — не коммитить!)
```

---

## API

Все запросы требуют заголовок: `x-auth-token: <AUTH_TOKEN>`

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/nodes` | Список нод |
| POST | `/api/nodes` | Добавить ноду |
| PUT | `/api/nodes/:id` | Редактировать ноду |
| DELETE | `/api/nodes/:id` | Удалить ноду |
| GET | `/api/nodes/:id/check` | Ping ноды |
| GET | `/api/nodes/:id/users` | Список юзеров |
| POST | `/api/nodes/:id/users` | Добавить юзера |
| DELETE | `/api/nodes/:id/users/:name` | Удалить юзера |
| POST | `/api/nodes/:id/users/:name/stop` | Остановить |
| POST | `/api/nodes/:id/users/:name/start` | Запустить |
| GET | `/api/status` | Статус всех нод |

---

## Безопасность

- `data/` и `ssh_keys/` в `.gitignore` — никогда не попадут в репо
- `AUTH_TOKEN` хранится в `.env` — не коммитить
- Рекомендуется закрыть порт `3000` и использовать только через reverse proxy с SSL

---

## Лицензия

MIT © [MaksimTMB](https://github.com/MaksimTMB)
