#!/usr/bin/env bash
# Asks a few questions, writes .env.studio / .env, and starts the dubbing studio.
# Usage (on the VPS, inside this folder):   bash setup-studio.sh
set -euo pipefail
cd "$(dirname "$0")"

IP=$(curl -fs --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
STUDIO_HOST="dub.${IP//./-}.sslip.io"

# Replace or add KEY=value in a file without touching the other lines
set_kv() {
  local file=$1 key=$2 value=$3
  touch "$file"
  grep -v "^${key}=" "$file" > "$file.tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$file.tmp"
  mv "$file.tmp" "$file"
}
get_kv() { grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2- || true; }

echo
echo "=== ការរៀបចំ Dubbing Studio ==="
echo "(Paste ដោយចុច Mouse ខាងស្ដាំ រួចចុច Enter)"
echo

read -rp "1) Gemini API Key (AQ... ឬ AIza...): " GEMINI
GEMINI=$(printf '%s' "$GEMINI" | tr -d '[:space:]"'"'")
[ -n "$GEMINI" ] || { echo "ត្រូវការ Gemini Key — សូមដំណើរការម្តងទៀត"; exit 1; }

read -rp "2) Telegram ID របស់អ្នក ដើម្បីបានសិទ្ធិ Admin (លេខ, Enter = រំលង): " TGID
TGID=$(printf '%s' "$TGID" | tr -cd '0-9,')

BOT_TOKEN=$(get_kv .env TELEGRAM_LOGIN_BOT_TOKEN)
if [ -z "$BOT_TOKEN" ]; then
  read -rp "3) Token របស់ Bot សម្រាប់ Login ស្វ័យប្រវត្ត (Enter = រំលង): " BOT_TOKEN
  BOT_TOKEN=$(printf '%s' "$BOT_TOKEN" | tr -d '[:space:]"'"'")
fi

ADMIN_PW=$(get_kv .env.studio STUDIO_ADMIN_PASSWORD)
if [ -z "$ADMIN_PW" ]; then
  ADMIN_PW="Dub-$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
fi

# .env.studio is rewritten cleanly (fixes any stray characters typed into it earlier)
cat > .env.studio <<EOF
GEMINI_API_KEY=$GEMINI
STUDIO_ADMIN_PASSWORD=$ADMIN_PW
STUDIO_ALLOW_REGISTER=0
STUDIO_TELEGRAM_ADMIN_IDS=$TGID
STUDIO_TELEGRAM_SIGNUP=1
EOF
chmod 600 .env.studio

# .env keeps the bot's own settings; only these lines are set
set_kv .env STUDIO_HOST "$STUDIO_HOST"
set_kv .env BOT_HOST "bot.${IP//./-}.sslip.io"
REF=$(get_kv .env STUDIO_GIT_REF)
set_kv .env STUDIO_GIT_REF "${REF:-claude/affectionate-noether-yvzenh}"
[ -z "$BOT_TOKEN" ] || set_kv .env TELEGRAM_LOGIN_BOT_TOKEN "$BOT_TOKEN"
chmod 600 .env

echo
echo "✅ បានរក្សាទុកការកំណត់"
echo "   Studio:          https://$STUDIO_HOST"
echo "   Admin login:     cm5722254@gmail.com"
echo "   Admin password:  $ADMIN_PW   ← សូមកត់ទុក"
echo

# Ports 80/443 must be free for the HTTPS proxy (unless it is ours already)
BUSY=$(ss -tlnp 2>/dev/null | grep -E ':(80|443)\s' | grep -v docker-proxy || true)
if [ -n "$BUSY" ]; then
  echo "⚠️  Port 80/443 កំពុងត្រូវបានប្រើដោយកម្មវិធីផ្សេង៖"
  echo "$BUSY"
  echo "   សូមផ្ញើរូបនេះទៅ Claude មុននឹងបន្ត។"
  exit 1
fi

read -rp "ចាប់ផ្ដើម Studio ឥឡូវ? (y/n): " GO
if [ "$GO" = "y" ] || [ "$GO" = "Y" ]; then
  command -v ufw >/dev/null && ufw status | grep -q active && { ufw allow 80 >/dev/null; ufw allow 443 >/dev/null; }
  docker compose up -d --build
  echo
  echo "✅ កំពុងដំណើរការ — លើកដំបូងរង់ចាំ ១០–២០ នាទី រួចបើក https://$STUDIO_HOST"
  echo "   មើល Log: docker compose logs -f studio"
fi
