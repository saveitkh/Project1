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

OLD_GEMINI=$(get_kv .env.studio GEMINI_API_KEY)
OLD_TGID=$(get_kv .env.studio STUDIO_TELEGRAM_ADMIN_IDS)

echo
echo "=== Dubbing Studio setup ==="
echo "Paste = right mouse click, then press Enter"
echo

# Keep asking until the value really looks like a Gemini key
while true; do
  if [ -n "$OLD_GEMINI" ]; then
    read -rp "1) Gemini API key (Enter = keep current ${OLD_GEMINI:0:6}...): " GEMINI
    [ -n "$GEMINI" ] || GEMINI=$OLD_GEMINI
  else
    read -rp "1) Gemini API key (starts with AQ. or AIza): " GEMINI
  fi
  GEMINI=$(printf '%s' "$GEMINI" | tr -d '[:space:]"'"'")
  if [[ "$GEMINI" =~ ^(AQ\.|AIza)[A-Za-z0-9._-]{20,}$ ]]; then break; fi
  echo "   X This is not a Gemini key. Copy it from https://aistudio.google.com/apikey and try again."
done

while true; do
  read -rp "2) Your Telegram ID for admin, numbers only (Enter = ${OLD_TGID:-skip}): " TGID
  [ -n "$TGID" ] || TGID=$OLD_TGID
  TGID=$(printf '%s' "$TGID" | tr -d '[:space:]')
  if [[ -z "$TGID" || "$TGID" =~ ^[0-9]+(,[0-9]+)*$ ]]; then break; fi
  echo "   X Numbers only (get it from @userinfobot)."
done

BOT_TOKEN=$(get_kv .env TELEGRAM_LOGIN_BOT_TOKEN)
if [ -z "$BOT_TOKEN" ]; then
  while true; do
    read -rp "3) Bot token for auto login, like 123456:ABC... (Enter = skip): " BOT_TOKEN
    BOT_TOKEN=$(printf '%s' "$BOT_TOKEN" | tr -d '[:space:]"'"'")
    if [[ -z "$BOT_TOKEN" || "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then break; fi
    echo "   X This is not a bot token (get it from @BotFather)."
  done
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
echo "OK - settings saved"
echo "   Studio:          https://$STUDIO_HOST"
echo "   Admin login:     cm5722254@gmail.com"
echo "   Admin password:  $ADMIN_PW   <- write this down"
echo

# Ports 80/443 must be free for the HTTPS proxy (unless it is ours already)
BUSY=$(ss -tlnp 2>/dev/null | grep -E ':(80|443)\s' | grep -v docker-proxy || true)
if [ -n "$BUSY" ]; then
  echo "!! Port 80/443 is used by another program:"
  echo "$BUSY"
  echo "   Send a screenshot of this to Claude before continuing."
  exit 1
fi

read -rp "Start the Studio now? (y/n): " GO
if [ "$GO" = "y" ] || [ "$GO" = "Y" ]; then
  command -v ufw >/dev/null && ufw status | grep -q active && { ufw allow 80 >/dev/null; ufw allow 443 >/dev/null; }
  docker compose up -d --build
  echo
  echo "OK - building. First time takes 10-20 minutes, then open https://$STUDIO_HOST"
  echo "   Logs: docker compose logs -f studio"
fi
