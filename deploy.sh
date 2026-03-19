#!/bin/bash
cd /tmp
set +H

# ============================================================
#  ST VILLAGE PROXY — Deploy Script v3.0
#  Полная установка на VPS: Docker + Nginx + SSL + Firewall
#  Использование: curl -sL <url>/deploy.sh | sudo bash
# ============================================================

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

INSTALL_DIR="/opt/mtg-adminpanel"
REPO_URL="https://github.com/Reibik/-mtg-adminpanel.git"
SERVICE_NAME="stvillage-proxy"
NGINX_CONF="stvillage-proxy"
LOG_FILE="/tmp/stvillage-deploy.log"

# ── Helpers ──────────────────────────────────────────────────
print_header() {
    clear
    echo ""
    echo -e "${CYAN}  ╔═══════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}  ║${NC}  ${BOLD}⚡ ST VILLAGE PROXY${NC}  ${DIM}— Deploy Script v3.0${NC}            ${CYAN}║${NC}"
    echo -e "${CYAN}  ║${NC}  ${DIM}Панель управления + клиентский сайт + админка${NC}      ${CYAN}║${NC}"
    echo -e "${CYAN}  ╚═══════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_step()    { echo -e "  ${CYAN}▶${NC} $1"; }
print_ok()      { echo -e "  ${GREEN}✓${NC} $1"; }
print_error()   { echo -e "  ${RED}✗${NC} $1"; }
print_warn()    { echo -e "  ${YELLOW}!${NC} $1"; }
print_info()    { echo -e "  ${DIM}$1${NC}"; }
divider()       { echo -e "  ${DIM}──────────────────────────────────────────────────${NC}"; }

ask() {
    local prompt="$1" default="$2" var_name="$3"
    if [ -n "$default" ]; then
        echo -ne "  ${WHITE}${prompt}${NC} ${DIM}[${default}]${NC}: "
    else
        echo -ne "  ${WHITE}${prompt}${NC}: "
    fi
    IFS= read -r _val < /dev/tty
    _val="${_val:-$default}"
    eval "$var_name=\$_val"
}

ask_required() {
    local prompt="$1" var_name="$2" min_len="${3:-1}"
    while true; do
        echo -ne "  ${WHITE}${prompt}${NC}: "
        IFS= read -r _val < /dev/tty
        if [ ${#_val} -ge "$min_len" ]; then
            eval "$var_name=\$_val"
            return
        fi
        print_warn "Минимум $min_len символов"
    done
}

ask_secret() {
    local prompt="$1" var_name="$2"
    echo -ne "  ${WHITE}${prompt}${NC}: "
    IFS= read -r -s _val < /dev/tty
    echo ""
    eval "$var_name=\$_val"
}

# Выполняет команду с live-прогрессом (точки каждые 2 сек)
run_live() {
    local msg="$1"; shift
    echo -ne "  ${CYAN}▶${NC} $msg "
    "$@" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    local elapsed=0
    while kill -0 "$pid" 2>/dev/null; do
        sleep 2
        elapsed=$((elapsed + 2))
        echo -ne "."
    done
    wait "$pid"
    local rc=$?
    if [ $rc -eq 0 ]; then
        echo -e " ${GREEN}✓${NC} ${DIM}(${elapsed}s)${NC}"
    else
        echo -e " ${RED}✗${NC} ${DIM}(код $rc, лог: $LOG_FILE)${NC}"
    fi
    return $rc
}

# Выполняет команду тихо (для быстрых операций)
run_quiet() {
    local msg="$1"; shift
    echo -ne "  ${CYAN}⠋${NC} $msg"
    "$@" >> "$LOG_FILE" 2>&1
    local rc=$?
    echo -ne "\r"
    if [ $rc -eq 0 ]; then
        print_ok "$msg"
    else
        print_error "$msg (код $rc, лог: $LOG_FILE)"
    fi
    return $rc
}

# ── Root check ───────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}  ✗ Запусти от root: sudo bash deploy.sh${NC}"
    exit 1
fi

> "$LOG_FILE"
print_header

# ── Detect update mode ───────────────────────────────────────
UPDATE_MODE=false
if [ -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    echo -e "  ${MAGENTA}Обнаружена существующая установка!${NC}"
    echo ""
    echo -e "  ${CYAN}[1]${NC} Обновить (пересобрать без потери данных и настроек)"
    echo -e "  ${CYAN}[2]${NC} Переустановить полностью (все настройки заново)"
    echo -ne "  ${WHITE}Выбор${NC} ${DIM}[1]${NC}: "
    IFS= read -r UPD_CHOICE < /dev/tty
    UPD_CHOICE=${UPD_CHOICE:-1}
    echo ""

    if [ "$UPD_CHOICE" == "1" ]; then
        UPDATE_MODE=true
    fi
fi

# ══════════════════════════════════════════════════════════════
#  UPDATE MODE — Quick rebuild
# ══════════════════════════════════════════════════════════════
if [ "$UPDATE_MODE" = true ]; then
    print_step "Обновление ST VILLAGE PROXY..."
    divider

    cd "$INSTALL_DIR"

    # Pull latest code
    if [ -d "$INSTALL_DIR/.git" ]; then
        run_quiet "Получение обновлений из git..." git -C "$INSTALL_DIR" pull --ff-only
    else
        print_warn "Не git-репозиторий — пропускаем git pull"
    fi

    # Stop
    print_step "Остановка контейнера..."
    docker compose down >> "$LOG_FILE" 2>&1
    print_ok "Остановлен"

    # Rebuild with live progress
    run_live "Сборка Docker-образа" docker compose build --no-cache
    if [ $? -ne 0 ]; then
        print_error "Ошибка сборки! Последние строки лога:"
        tail -15 "$LOG_FILE"
        exit 1
    fi

    # Start
    run_quiet "Запуск контейнера..." docker compose up -d

    # Wait for healthy
    print_step "Ожидание запуска..."
    HEALTHY=false
    for i in $(seq 1 30); do
        if docker ps --format '{{.Names}}' 2>/dev/null | grep -q mtg-panel; then
            PORT=$(grep -oP 'PORT=\K[0-9]+' "$INSTALL_DIR/.env" 2>/dev/null || echo "3000")
            HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/api/version" 2>/dev/null)
            if [ "$HTTP_CODE" = "200" ]; then
                HEALTHY=true
                break
            fi
        fi
        sleep 1
        echo -ne "."
    done
    echo ""

    if [ "$HEALTHY" = true ] || docker ps --format '{{.Names}}' | grep -q mtg-panel; then
        echo ""
        echo -e "  ${GREEN}╔═══════════════════════════════════════════╗${NC}"
        echo -e "  ${GREEN}║      ✓  Обновление завершено!             ║${NC}"
        echo -e "  ${GREEN}╚═══════════════════════════════════════════╝${NC}"
        echo ""
        VERSION=$(docker exec mtg-panel node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")
        print_info "Версия: $VERSION"
        print_info "Контейнер: $(docker ps --filter name=mtg-panel --format '{{.Status}}')"
        echo ""
        print_info "docker logs mtg-panel -f  — логи"
        echo ""
    else
        print_error "Контейнер не запустился!"
        echo ""
        docker logs mtg-panel --tail 20 2>&1
        print_info "Диагностика: docker logs mtg-panel"
        exit 1
    fi
    exit 0
fi

# ══════════════════════════════════════════════════════════════
#  FULL INSTALL MODE
# ══════════════════════════════════════════════════════════════

echo -e "  ${BOLD}1/6  Параметры${NC}"
divider

# ── Auth Token ───────────────────────────────────────────────
ask_required "Токен авторизации (пароль админ-панели)" AUTH_TOKEN 6

# ── Port ─────────────────────────────────────────────────────
ask "Порт приложения" "3000" PORT

# ── JWT Secret ───────────────────────────────────────────────
JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -d '\n/')
print_info "JWT Secret: сгенерирован"

echo ""

# ── YooKassa ─────────────────────────────────────────────────
echo -e "  ${BOLD}Платежи — YooKassa${NC} ${DIM}(пропустите если не нужно)${NC}"
ask "  Shop ID" "" YOOKASSA_SHOP_ID
ask "  Secret Key" "" YOOKASSA_SECRET_KEY

echo ""

# ── SMTP ─────────────────────────────────────────────────────
echo -e "  ${BOLD}Почта — SMTP${NC} ${DIM}(пропустите если не нужно)${NC}"
ask "  Host" "smtp.mail.ru" SMTP_HOST
ask "  Port" "465" SMTP_PORT
ask "  User" "" SMTP_USER
if [ -n "$SMTP_USER" ]; then
    ask_secret "  Password" SMTP_PASS
    ask "  From (email отправителя)" "$SMTP_USER" SMTP_FROM
else
    SMTP_PASS=""
    SMTP_FROM=""
fi

echo ""

# ── Telegram ─────────────────────────────────────────────────
echo -e "  ${BOLD}Telegram Bot${NC} ${DIM}(пропустите если не нужно)${NC}"
ask "  Bot Token" "" TELEGRAM_BOT_TOKEN
TELEGRAM_BOT_USERNAME=""
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    ask "  Bot Username (без @)" "" TELEGRAM_BOT_USERNAME
fi

echo ""

# ── Domain / SSL ─────────────────────────────────────────────
echo -e "  ${BOLD}Домен и SSL${NC}"
echo -e "  ${CYAN}[1]${NC} Только HTTP  ${DIM}(http://IP:$PORT)${NC}"
echo -e "  ${CYAN}[2]${NC} Nginx + Let's Encrypt SSL  ${DIM}(https://domain.com)${NC}"
echo -ne "  ${WHITE}Выбор${NC} ${DIM}[1]${NC}: "
IFS= read -r SSL_CHOICE < /dev/tty
SSL_CHOICE=${SSL_CHOICE:-1}

DOMAIN=""
CERT_EMAIL=""
if [ "$SSL_CHOICE" == "2" ]; then
    ask "  Домен (proxy.example.com)" "" DOMAIN
    ask "  Email (для SSL-сертификата)" "" CERT_EMAIL
    SITE_URL="https://$DOMAIN"
else
    SERVER_IP=$(curl -sf -4 --connect-timeout 5 --max-time 10 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    SITE_URL="http://$SERVER_IP:$PORT"
fi

# ── Webhook URL ──────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Webhook URL${NC} ${DIM}(для уведомлений YooKassa, обычно = Site URL)${NC}"
ask "  Webhook URL" "$SITE_URL" WEBHOOK_URL

# ── Confirmation ─────────────────────────────────────────────
echo ""
divider
echo -e "  ${BOLD}Параметры установки:${NC}"
echo ""
echo -e "  Директория:    ${CYAN}$INSTALL_DIR${NC}"
echo -e "  Порт:          ${CYAN}$PORT${NC}"
echo -e "  Site URL:      ${CYAN}$SITE_URL${NC}"
[ -n "$DOMAIN" ]             && echo -e "  Домен + SSL:   ${CYAN}$DOMAIN${NC}"
[ -n "$YOOKASSA_SHOP_ID" ]   && echo -e "  YooKassa:      ${CYAN}$YOOKASSA_SHOP_ID${NC}"
[ -n "$SMTP_HOST" ]          && echo -e "  SMTP:          ${CYAN}$SMTP_USER@$SMTP_HOST:$SMTP_PORT${NC}"
[ -n "$TELEGRAM_BOT_TOKEN" ] && echo -e "  Telegram Bot:  ${CYAN}@${TELEGRAM_BOT_USERNAME:-настроен}${NC}"
echo ""
divider
echo ""
echo -ne "  ${WHITE}Начать установку? (y/N)${NC}: "
IFS= read -r CONFIRM < /dev/tty
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo -e "  ${DIM}Отменено.${NC}"
    exit 0
fi

echo ""
echo -e "  ${BOLD}2/6  Подготовка системы${NC}"
divider

# ── System update ────────────────────────────────────────────
run_live "Обновление пакетов" apt-get update -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"
run_live "Установка зависимостей" apt-get install -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" curl wget git unzip ca-certificates gnupg lsb-release

# ── Docker ───────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}3/6  Docker${NC}"
divider

if ! command -v docker &> /dev/null; then
    run_live "Установка Docker (может занять 1-2 мин)" bash -c "curl -fsSL https://get.docker.com | sh"
    systemctl enable docker >> "$LOG_FILE" 2>&1
    systemctl start docker >> "$LOG_FILE" 2>&1
    if command -v docker &> /dev/null; then
        print_ok "Docker установлен — $(docker --version | awk '{print $3}' | tr -d ',')"
    else
        print_error "Docker не установился! Проверьте лог: $LOG_FILE"
        exit 1
    fi
else
    print_ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"
fi

if ! docker compose version &> /dev/null; then
    print_error "docker compose не найден!"
    print_info "Установите: apt install docker-compose-plugin"
    exit 1
fi

# ── Clone / Pull ─────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}4/6  Код приложения${NC}"
divider

if [ -d "$INSTALL_DIR/.git" ]; then
    run_quiet "Обновление репозитория..." git -C "$INSTALL_DIR" pull --ff-only
elif [ -d "$INSTALL_DIR" ]; then
    print_warn "$INSTALL_DIR существует, но не git-репо — переустанавливаем"
    # Preserve data if exists
    if [ -d "$INSTALL_DIR/data" ]; then
        cp -a "$INSTALL_DIR/data" /tmp/_mtg_data_backup 2>/dev/null
        print_info "Бэкап /data сохранён в /tmp/_mtg_data_backup"
    fi
    rm -rf "$INSTALL_DIR"
    run_quiet "Клонирование репозитория..." git clone -q "$REPO_URL" "$INSTALL_DIR"
    # Restore data
    if [ -d "/tmp/_mtg_data_backup" ]; then
        mv /tmp/_mtg_data_backup "$INSTALL_DIR/data"
        print_ok "Данные восстановлены из бэкапа"
    fi
else
    run_quiet "Клонирование репозитория..." git clone -q "$REPO_URL" "$INSTALL_DIR"
fi

# ── .env + dirs ──────────────────────────────────────────────
print_step "Создание конфигурации..."
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/ssh_keys"

cat > "$INSTALL_DIR/.env" << ENVEOF
# ST VILLAGE PROXY — Configuration
# Generated: $(date '+%Y-%m-%d %H:%M:%S')

AUTH_TOKEN=$AUTH_TOKEN
PORT=$PORT
DATA_DIR=/data
JWT_SECRET=$JWT_SECRET

# YooKassa
YOOKASSA_SHOP_ID=$YOOKASSA_SHOP_ID
YOOKASSA_SECRET_KEY=$YOOKASSA_SECRET_KEY

# SMTP
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
SMTP_FROM=$SMTP_FROM

# Telegram
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_BOT_USERNAME=$TELEGRAM_BOT_USERNAME

# URLs
SITE_URL=$SITE_URL
ENVEOF

chmod 600 "$INSTALL_DIR/.env"
print_ok "Конфигурация: $INSTALL_DIR/.env"

# ── Build & Launch ───────────────────────────────────────────
echo ""
echo -e "  ${BOLD}5/6  Сборка и запуск${NC}"
divider

cd "$INSTALL_DIR"
docker compose down >> "$LOG_FILE" 2>&1

run_live "Сборка Docker-образа (1-3 мин)" docker compose build
if [ $? -ne 0 ]; then
    print_error "Ошибка сборки! Последние строки:"
    echo ""
    tail -20 "$LOG_FILE"
    echo ""
    print_info "Полный лог: $LOG_FILE"
    exit 1
fi

run_quiet "Запуск контейнера..." docker compose up -d

# ── Health check with retry ──────────────────────────────────
print_step "Ожидание запуска..."
HEALTHY=false
for i in $(seq 1 30); do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q mtg-panel; then
        HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/api/version" 2>/dev/null)
        if [ "$HTTP_CODE" = "200" ]; then
            HEALTHY=true
            break
        fi
    fi
    sleep 1
    echo -ne "."
done
echo ""

if [ "$HEALTHY" = true ]; then
    print_ok "API отвечает (HTTP 200)"
elif docker ps --format '{{.Names}}' | grep -q mtg-panel; then
    print_warn "Контейнер запущен, но API ещё не готов — подождите 10-15 сек"
else
    print_error "Контейнер не запустился!"
    echo ""
    docker logs mtg-panel --tail 20 2>&1
    exit 1
fi

# ── Nginx + SSL ──────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}6/6  Nginx + SSL${NC}"
divider

if [ "$SSL_CHOICE" == "2" ] && [ -n "$DOMAIN" ]; then

    run_live "Установка Nginx + Certbot" apt-get install -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" nginx certbot python3-certbot-nginx

    # Stop nginx temporarily if running
    systemctl stop nginx >> "$LOG_FILE" 2>&1

    # Temp config for certbot standalone
    cat > "/etc/nginx/sites-available/$NGINX_CONF" << NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 200 'ok'; add_header Content-Type text/plain; }
}
NGINX

    ln -sf "/etc/nginx/sites-available/$NGINX_CONF" /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
    systemctl start nginx >> "$LOG_FILE" 2>&1

    run_live "Получение SSL-сертификата для $DOMAIN" certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --email "$CERT_EMAIL" --agree-tos --non-interactive

    if [ $? -eq 0 ]; then
        print_ok "SSL-сертификат получен"

        # Production Nginx config
        cat > "/etc/nginx/sites-available/$NGINX_CONF" << NGINX
# ST VILLAGE PROXY — Nginx config
# Auto-generated by deploy.sh

server {
    listen 80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-XSS-Protection "1; mode=block" always;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
NGINX

        nginx -t >> "$LOG_FILE" 2>&1
        if [ $? -eq 0 ]; then
            systemctl reload nginx
            print_ok "Nginx настроен с SSL"
        else
            print_error "Ошибка конфигурации Nginx"
            nginx -t
        fi

        # Auto-renew cron
        if ! crontab -l 2>/dev/null | grep -q certbot; then
            (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -
            print_ok "Автообновление SSL (cron)"
        fi

    else
        print_warn "Не удалось получить SSL"
        print_info "Убедитесь, что домен $DOMAIN указывает на IP этого сервера"
        print_info "Подробности: $LOG_FILE"
    fi

else
    print_info "SSL пропущен (выбран HTTP-режим)"
fi

# ── Firewall ─────────────────────────────────────────────────
if command -v ufw &> /dev/null; then
    print_step "Настройка firewall (ufw)..."
    ufw allow 22/tcp >> "$LOG_FILE" 2>&1
    ufw allow 80/tcp >> "$LOG_FILE" 2>&1
    if [ "$SSL_CHOICE" == "2" ]; then
        ufw allow 443/tcp >> "$LOG_FILE" 2>&1
    else
        ufw allow "$PORT/tcp" >> "$LOG_FILE" 2>&1
    fi
    ufw --force enable >> "$LOG_FILE" 2>&1
    print_ok "Firewall настроен"
fi

# ── Systemd service ──────────────────────────────────────────
print_step "Настройка автозапуска..."

for old_svc in mtg-proxy mtg-adminpanel; do
    if [ -f "/etc/systemd/system/${old_svc}.service" ]; then
        systemctl disable "$old_svc" >> "$LOG_FILE" 2>&1
        rm -f "/etc/systemd/system/${old_svc}.service"
    fi
done

cat > "/etc/systemd/system/${SERVICE_NAME}.service" << SVCEOF
[Unit]
Description=ST VILLAGE PROXY
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
ExecReload=/usr/bin/docker compose up -d --build

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" -q
print_ok "Systemd-сервис: $SERVICE_NAME"

# ── Summary ──────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "  ${GREEN}║${NC}  ${BOLD}✓  ST VILLAGE PROXY — установлен!${NC}                    ${GREEN}║${NC}"
echo -e "  ${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

if [ -n "$DOMAIN" ]; then
    echo -e "  🌐 Сайт:      ${CYAN}https://$DOMAIN${NC}"
    echo -e "  🔧 Админка:   ${CYAN}https://$DOMAIN/admin${NC}"
else
    echo -e "  🌐 Сайт:      ${CYAN}http://$SERVER_IP:$PORT${NC}"
    echo -e "  🔧 Админка:   ${CYAN}http://$SERVER_IP:$PORT/admin${NC}"
fi
echo -e "  🔐 Токен:     ${CYAN}$AUTH_TOKEN${NC}"

VERSION=$(docker exec mtg-panel node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")
echo -e "  📦 Версия:    ${CYAN}$VERSION${NC}"
echo ""

divider
echo ""
echo -e "  ${BOLD}Управление:${NC}"
echo ""
echo -e "  ${DIM}docker logs mtg-panel -f${NC}            — логи в реальном времени"
echo -e "  ${DIM}docker restart mtg-panel${NC}             — перезапуск"
echo -e "  ${DIM}docker exec -it mtg-panel sh${NC}         — войти в контейнер"
echo -e "  ${DIM}cd $INSTALL_DIR && bash update.sh${NC}    — обновление"
echo -e "  ${DIM}systemctl status $SERVICE_NAME${NC}   — статус сервиса"
echo -e "  ${DIM}nano $INSTALL_DIR/.env${NC}              — редактировать настройки"
echo ""
echo -e "  ${DIM}Лог установки: $LOG_FILE${NC}"
echo ""
