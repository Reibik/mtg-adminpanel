#!/bin/bash
# MTG Agent v2.0 installer / updater
# Usage: bash install-agent.sh [AGENT_TOKEN] [AGENT_PORT]
set -e

TOKEN="${1:-mtg-agent-secret}"
PORT="${2:-8081}"
INSTALL_DIR="/opt/mtg-agent"
RAW="https://raw.githubusercontent.com/Reibik/mtg-adminpanel/main/mtg-agent"

echo "==> MTG Agent v2.0 install/update..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo "==> Downloading agent files..."
curl -fsSL "$RAW/main.py"            -o main.py
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml

printf "AGENT_TOKEN=%s\nAGENT_PORT=%s\n" "$TOKEN" "$PORT" > .env

echo "==> Stopping old agent..."
docker compose down 2>/dev/null || true

echo "==> Starting agent on port ${PORT}..."
docker compose up -d

echo ""
echo "==> ✅ MTG Agent v2.0 installed!"
echo "==> Agent will be ready in ~30s (installing dependencies)"
echo ""
echo "==> Endpoints:"
echo "    Health:  curl -s http://localhost:${PORT}/health"
echo "    Metrics: curl -s -H 'x-agent-token: ${TOKEN}' http://localhost:${PORT}/metrics"
echo "    System:  curl -s -H 'x-agent-token: ${TOKEN}' http://localhost:${PORT}/system"
echo ""
echo "==> Check status: docker logs -f mtg-agent"
