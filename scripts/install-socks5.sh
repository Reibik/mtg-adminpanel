#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Установка SOCKS5-прокси (dante-server) на VPS
# Для проксирования запросов к lknpd.nalog.ru
# ═══════════════════════════════════════════════════════════
set -e

# ── Настройки (можно менять) ──────────────────────────────
SOCKS_PORT="${SOCKS_PORT:-1080}"
SOCKS_USER="${SOCKS_USER:-npdproxy}"
SOCKS_PASS="${SOCKS_PASS:-$(openssl rand -base64 16)}"

# ── Цвета ─────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo -e "${CYAN}  Установка SOCKS5-прокси (dante-server)  ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo ""

# ── Проверка root ─────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo -e "${RED}Запустите скрипт от root: sudo bash install-socks5.sh${NC}"
  exit 1
fi

# ── Определяем внешний интерфейс и IP ─────────────────────
IFACE=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)
EXTERNAL_IP=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)

if [[ -z "$IFACE" || -z "$EXTERNAL_IP" ]]; then
  echo -e "${RED}Не удалось определить сетевой интерфейс.${NC}"
  echo "Укажите вручную: IFACE=eth0 bash install-socks5.sh"
  exit 1
fi

echo -e "${GREEN}Интерфейс:${NC} $IFACE"
echo -e "${GREEN}Внешний IP:${NC} $EXTERNAL_IP"
echo -e "${GREEN}Порт:${NC} $SOCKS_PORT"
echo ""

# ── Установка dante-server ────────────────────────────────
echo -e "${YELLOW}[1/5] Установка dante-server...${NC}"
apt-get update -qq
apt-get install -y -qq dante-server > /dev/null 2>&1
echo -e "${GREEN}  ✓ dante-server установлен${NC}"

# ── Создание пользователя для авторизации ─────────────────
echo -e "${YELLOW}[2/5] Создание пользователя ${SOCKS_USER}...${NC}"
if id "$SOCKS_USER" &>/dev/null; then
  echo "$SOCKS_USER:$SOCKS_PASS" | chpasswd
  echo -e "${GREEN}  ✓ Пароль обновлён${NC}"
else
  useradd -r -s /usr/sbin/nologin "$SOCKS_USER"
  echo "$SOCKS_USER:$SOCKS_PASS" | chpasswd
  echo -e "${GREEN}  ✓ Пользователь создан${NC}"
fi

# ── Конфигурация dante ────────────────────────────────────
echo -e "${YELLOW}[3/5] Настройка конфигурации...${NC}"

cat > /etc/danted.conf << CONF
# dante SOCKS5 proxy configuration
logoutput: syslog

# Входящие соединения
internal: 0.0.0.0 port = ${SOCKS_PORT}

# Исходящие соединения
external: ${IFACE}

# Метод аутентификации
socksmethod: username

# Запрет привязки и приёма (только connect)
client pass {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    log: error
}

# Разрешить подключения через SOCKS5 с авторизацией
socks pass {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    command: connect
    log: error
    socksmethod: username
}

# Заблокировать всё остальное
socks block {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    log: error
}
CONF

echo -e "${GREEN}  ✓ Конфигурация записана в /etc/danted.conf${NC}"

# ── Firewall ──────────────────────────────────────────────
echo -e "${YELLOW}[4/5] Настройка firewall...${NC}"
if command -v ufw &>/dev/null; then
  ufw allow "$SOCKS_PORT"/tcp > /dev/null 2>&1 || true
  echo -e "${GREEN}  ✓ UFW: порт ${SOCKS_PORT} открыт${NC}"
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port="${SOCKS_PORT}/tcp" > /dev/null 2>&1 || true
  firewall-cmd --reload > /dev/null 2>&1 || true
  echo -e "${GREEN}  ✓ firewalld: порт ${SOCKS_PORT} открыт${NC}"
else
  echo -e "${YELLOW}  ⚠ Firewall не обнаружен, убедитесь что порт ${SOCKS_PORT} открыт${NC}"
fi

# ── Запуск ────────────────────────────────────────────────
echo -e "${YELLOW}[5/5] Запуск сервиса...${NC}"
systemctl enable danted > /dev/null 2>&1
systemctl restart danted
sleep 1

if systemctl is-active --quiet danted; then
  echo -e "${GREEN}  ✓ danted запущен и работает${NC}"
else
  echo -e "${RED}  ✗ Ошибка запуска. Логи: journalctl -u danted -n 20${NC}"
  exit 1
fi

# ── Результат ─────────────────────────────────────────────
echo ""
echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  SOCKS5-прокси установлен!${NC}"
echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo ""
echo -e "  Адрес:      ${CYAN}${EXTERNAL_IP}:${SOCKS_PORT}${NC}"
echo -e "  Логин:      ${CYAN}${SOCKS_USER}${NC}"
echo -e "  Пароль:     ${CYAN}${SOCKS_PASS}${NC}"
echo ""
echo -e "  ${YELLOW}Строка для панели НПД:${NC}"
echo ""
echo -e "  ${GREEN}socks5://${SOCKS_USER}:${SOCKS_PASS}@${EXTERNAL_IP}:${SOCKS_PORT}${NC}"
echo ""
echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo -e "  Вставьте строку выше в поле «Прокси» в"
echo -e "  настройках НПД в админ-панели, затем"
echo -e "  нажмите «Тест» для проверки."
echo -e "${CYAN}═══════════════════════════════════════════${NC}"
