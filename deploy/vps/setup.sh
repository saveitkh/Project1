#!/usr/bin/env bash
# One-shot setup on a fresh Ubuntu/Debian VPS. Run as root from this folder:
#   bash setup.sh
# Re-running it is safe: it only installs what's missing, then rebuilds.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env -- fill in the values (nano .env), then run: bash setup.sh"
  exit 1
fi

# No domain given: fall back to sslip.io, which maps 1-2-3-4.sslip.io to 1.2.3.4.
if ! grep -qE '^DOMAIN=.+' .env; then
  ip=$(curl -fsS https://api.ipify.org)
  sed -i "s|^DOMAIN=.*|DOMAIN=${ip//./-}.sslip.io|" .env
fi
domain=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
if ! grep -qE '^PUBLIC_URL=.+' .env; then
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${domain}|" .env
fi

if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 80/tcp && ufw allow 443/tcp
fi

docker compose --env-file .env up -d --build
echo
echo "Bot is starting at https://${domain}  (logs: docker compose logs -f app)"
