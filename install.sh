#!/bin/bash
cd /tmp
set +H

# ============================================================
#  ST VILLAGE PROXY — Install Script v2.0
#  Обёртка для deploy.sh — полная установка на VPS
# ============================================================

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

INSTALL_DIR="/opt/mtg-adminpanel"

if [ "$EUID" -ne 0 ]; then
    echo -e "\033[0;31m  ✗ Запусти от root: sudo bash install.sh\033[0m"
    exit 1
fi

# If deploy.sh exists locally, run it
if [ -f "$INSTALL_DIR/deploy.sh" ]; then
    exec bash "$INSTALL_DIR/deploy.sh"
fi

# Otherwise clone first, then run
echo -e "\033[0;36m  ▶\033[0m Загрузка ST VILLAGE PROXY..."
apt-get update -qq \
  -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold" \
  > /dev/null 2>&1

apt-get install -y -qq \
  -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold" \
  git curl > /dev/null 2>&1

if [ ! -d "$INSTALL_DIR" ]; then
    git clone -q https://github.com/Reibik/-mtg-adminpanel.git "$INSTALL_DIR"
fi

if [ -f "$INSTALL_DIR/deploy.sh" ]; then
    exec bash "$INSTALL_DIR/deploy.sh"
else
    echo -e "\033[0;31m  ✗ Не удалось загрузить deploy.sh\033[0m"
    exit 1
fi
