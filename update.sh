#!/bin/bash
cd /tmp

# ============================================================
#  ST VILLAGE PROXY — Quick Update Script v2.0
#  Обновление кода и пересборка контейнера (без потери данных)
# ============================================================

export DEBIAN_FRONTEND=noninteractive

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

INSTALL_DIR="/opt/mtg-adminpanel"
LOG_FILE="/tmp/stvillage-update.log"

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}  ✗ Запусти от root: sudo bash update.sh${NC}"
    exit 1
fi

if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "${RED}  ✗ Не найдена установка в $INSTALL_DIR${NC}"
    echo -e "${DIM}  Используйте deploy.sh для первичной установки${NC}"
    exit 1
fi

> "$LOG_FILE"

echo ""
echo -e "  ${BOLD}⚡ ST VILLAGE PROXY — Обновление${NC}"
echo -e "  ${DIM}──────────────────────────────────────────────────${NC}"
echo ""

OLD_VER=$(docker exec mtg-panel node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")
echo -e "  ${DIM}Текущая версия: v${OLD_VER}${NC}"
echo ""

# Pull code
if [ -d "$INSTALL_DIR/.git" ]; then
    echo -ne "  ${CYAN}▶${NC} Получение обновлений из git... "
    cd "$INSTALL_DIR"
    GIT_OUT=$(git pull --ff-only 2>&1)
    GIT_RC=$?
    if [ $GIT_RC -eq 0 ]; then
        if echo "$GIT_OUT" | grep -q "Already up to date"; then
            echo -e "${GREEN}✓${NC} ${DIM}(уже актуально)${NC}"
        else
            echo -e "${GREEN}✓${NC}"
            echo -e "  ${DIM}$(echo "$GIT_OUT" | tail -2)${NC}"
        fi
    else
        echo -e "${RED}✗${NC}"
        echo -e "  ${DIM}$GIT_OUT${NC}"
        echo -e "  ${YELLOW}!${NC} Попробуем продолжить со сборкой..."
    fi
else
    echo -e "  ${YELLOW}!${NC} Не git-репозиторий — пропуск git pull"
fi

# Stop
echo -ne "  ${CYAN}▶${NC} Остановка контейнера... "
docker compose -f "$INSTALL_DIR/docker-compose.yml" down >> "$LOG_FILE" 2>&1
echo -e "${GREEN}✓${NC}"

# Rebuild with live progress
echo -ne "  ${CYAN}▶${NC} Сборка Docker-образа "
cd "$INSTALL_DIR"
docker compose build --no-cache >> "$LOG_FILE" 2>&1 &
BUILD_PID=$!
ELAPSED=0
while kill -0 "$BUILD_PID" 2>/dev/null; do
    sleep 2
    ELAPSED=$((ELAPSED + 2))
    echo -ne "."
done
wait "$BUILD_PID"
BUILD_RC=$?

if [ $BUILD_RC -eq 0 ]; then
    echo -e " ${GREEN}✓${NC} ${DIM}(${ELAPSED}s)${NC}"
else
    echo -e " ${RED}✗${NC}"
    echo ""
    echo -e "  ${RED}Ошибка сборки! Последние строки:${NC}"
    tail -15 "$LOG_FILE"
    echo ""
    echo -e "  ${DIM}Полный лог: $LOG_FILE${NC}"
    exit 1
fi

# Start
echo -ne "  ${CYAN}▶${NC} Запуск контейнера... "
docker compose -f "$INSTALL_DIR/docker-compose.yml" up -d >> "$LOG_FILE" 2>&1
echo -e "${GREEN}✓${NC}"

# Wait for healthy
echo -ne "  ${CYAN}▶${NC} Ожидание запуска "
HEALTHY=false
PORT=$(grep -oP 'PORT=\K[0-9]+' "$INSTALL_DIR/.env" 2>/dev/null || echo "3000")
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

if [ "$HEALTHY" = true ] || docker ps --format '{{.Names}}' | grep -q mtg-panel; then
    NEW_VER=$(docker exec mtg-panel node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")
    echo ""
    echo -e "  ${GREEN}╔═══════════════════════════════════════════╗${NC}"
    echo -e "  ${GREEN}║      ✓  Обновление завершено!             ║${NC}"
    echo -e "  ${GREEN}╚═══════════════════════════════════════════╝${NC}"
    echo ""
    if [ "$OLD_VER" != "$NEW_VER" ]; then
        echo -e "  ${DIM}Версия: v${OLD_VER} → ${NC}${BOLD}v${NEW_VER}${NC}"
    else
        echo -e "  ${DIM}Версия: v${NEW_VER}${NC}"
    fi
    echo -e "  ${DIM}$(docker ps --filter name=mtg-panel --format 'Status: {{.Status}}')${NC}"
    echo ""
    echo -e "  ${DIM}docker logs mtg-panel -f  — логи${NC}"
else
    echo ""
    echo -e "  ${RED}✗ Контейнер не запустился!${NC}"
    echo ""
    docker logs mtg-panel --tail 20 2>&1
    echo ""
    echo -e "  ${DIM}Лог: $LOG_FILE${NC}"
    exit 1
fi
echo ""
