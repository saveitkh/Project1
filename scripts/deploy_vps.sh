#!/usr/bin/env bash
# Deploy / update the Khmer Dubber studio (+ VoxCPM2 when the machine has the RAM) + HTTPS.
# Works on any Ubuntu VPS (AWS Lightsail, Contabo, ...). On the VPS:
#   curl -fsSL https://raw.githubusercontent.com/saveitkh/Project1/claude/admiring-curie-90hbte/scripts/deploy_vps.sh | sudo bash
# Safe to run again for every update. The https address is made from the VPS's public IP
# (dub.<ip-with-dashes>.sslip.io) unless STUDIO_HOST is already set in .env.
# WITH_VOXCPM=1 forces the CPU VoxCPM2 even under 8 GB RAM (it will be slow and may be killed).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/saveitkh/Project1.git}"
REPO_BRANCH="${REPO_BRANCH:-claude/admiring-curie-90hbte}"
APP_DIR="${APP_DIR:-/root/Project1}"
STUDIO_REF="${STUDIO_REF:-claude/admiring-curie-90hbte}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

say "Machine"
CPUS=$(nproc)
MEM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
echo "CPU: ${CPUS} | RAM: ${MEM_GB} GB | free disk: ${DISK_GB} GB"
# VoxCPM2 (voice cloning on the CPU) needs ~8 GB RAM. Smaller machines run the studio with
# the AI voices only ("AI (លឿន)": Gemini, no cloning), which need no extra RAM.
WITH_VOXCPM="${WITH_VOXCPM:-$([ "$MEM_GB" -ge 7 ] && echo 1 || echo 0)}"
if [ "$WITH_VOXCPM" = "1" ]; then
  echo "VoxCPM2: yes"
else
  warn "VoxCPM2: skipped (${MEM_GB} GB RAM) — use the \"AI (លឿន)\" voices, or a Colab GPU link in Admin → VoxCPM2."
fi
[ "$DISK_GB" -lt 15 ] && warn "Less than 15 GB free disk."
SWAP_GB=$([ "$WITH_VOXCPM" = "1" ] && echo 8 || echo 4)
if [ "$MEM_GB" -lt 8 ] && ! swapon --show | grep -q .; then
  say "Adding a ${SWAP_GB} GB swap file (building PyTorch needs the room)"
  fallocate -l "${SWAP_GB}G" /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Docker"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
docker compose version >/dev/null

say "Code (${REPO_BRANCH})"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$REPO_BRANCH"
  git -C "$APP_DIR" checkout -q "$REPO_BRANCH" 2>/dev/null || git -C "$APP_DIR" checkout -q -b "$REPO_BRANCH" "origin/$REPO_BRANCH"
  # Never discard edits made on the VPS: stop and say so instead
  git -C "$APP_DIR" merge -q --ff-only "origin/$REPO_BRANCH" || { warn "Local changes in $APP_DIR block the update — commit or stash them, then rerun."; exit 1; }
else
  git clone -q -b "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

say "Settings"
touch .env
[ -f .env.studio ] || { cp .env.studio.example .env.studio; warn "Created .env.studio — fill GEMINI_API_KEY and STUDIO_TELEGRAM_ADMIN_IDS, then run this script again."; }
set_env() { # key value file — add or replace
  if grep -q "^$1=" "$3"; then sed -i "s|^$1=.*|$1=$2|" "$3"; else echo "$1=$2" >> "$3"; fi
}
PUBLIC_IP="$(curl -4 -fs --max-time 5 https://checkip.amazonaws.com || curl -4 -fs --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
PUBLIC_IP="$(echo "$PUBLIC_IP" | tr -d '[:space:]')"
DASHED="${PUBLIC_IP//./-}"
grep -q '^STUDIO_HOST=' .env || set_env STUDIO_HOST "dub.${DASHED}.sslip.io" .env
grep -q '^BOT_HOST=' .env || set_env BOT_HOST "bot.${DASHED}.sslip.io" .env
case "$(grep '^STUDIO_HOST=' .env | cut -d= -f2)" in
  *sslip.io) [ -n "$DASHED" ] && ! grep -q "^STUDIO_HOST=.*${DASHED}" .env && \
    warn "STUDIO_HOST in .env points at another IP than this VPS (${PUBLIC_IP}) — fix it: STUDIO_HOST=dub.${DASHED}.sslip.io" ;;
esac
set_env STUDIO_GIT_REF "$STUDIO_REF" .env
grep -q '^VOXCPM_API_KEY=.\+' .env || set_env VOXCPM_API_KEY "$(openssl rand -hex 24)" .env
if ! grep -q '^STUDIO_TELEGRAM_ADMIN_IDS=.\+' .env.studio; then
  warn "STUDIO_TELEGRAM_ADMIN_IDS is empty in $APP_DIR/.env.studio — nobody will be admin. Put your Telegram id there (ask @userinfobot)."
fi
if grep -q '^STUDIO_PASSWORD_LOGIN=1' .env.studio && ! grep -q '^STUDIO_ADMIN_PASSWORD=.\+' .env.studio; then
  warn "STUDIO_PASSWORD_LOGIN=1 needs STUDIO_ADMIN_PASSWORD in $APP_DIR/.env.studio."; exit 1
fi
if ! grep -q '^DUBBER_BOT_TOKEN=.\+' .env && ! grep -q '^TELEGRAM_LOGIN_BOT_TOKEN=.\+' .env; then
  warn "No bot token in $APP_DIR/.env (DUBBER_BOT_TOKEN) — people cannot sign in."
fi

say "Firewall"
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80 >/dev/null; ufw allow 443 >/dev/null; fi
if ss -tlnp | grep -E ':(80|443) ' | grep -vq docker; then
  warn "Something other than Docker listens on port 80/443:"; ss -tlnp | grep -E ':(80|443) '
fi

if [ "$WITH_VOXCPM" = "1" ]; then
  say "Build (first time 20-40 min: PyTorch, Demucs, VoxCPM2)"
  docker compose build --pull studio voxcpm
  docker compose up -d studio voxcpm caddy
else
  say "Build (first time 15-25 min: PyTorch, Demucs)"
  docker compose build --pull studio
  docker compose up -d studio caddy
fi
if grep -q '^DUBBER_BOT_TOKEN=.\+' .env; then
  say "Telegram bot"
  docker compose --profile dubber-bot up -d --build dubber-bot
fi

say "Status"
docker compose ps
HOST=$(grep '^STUDIO_HOST=' .env | cut -d= -f2)
for i in $(seq 1 30); do
  if docker compose exec -T studio curl -fs http://127.0.0.1:3000/api/system/version >/dev/null 2>&1; then
    echo "Studio: up → https://${HOST}/"; break
  fi
  sleep 5
done
if [ "$WITH_VOXCPM" = "1" ]; then
  echo "VoxCPM2: downloading/loading the model can take 10-30 minutes the first time."
  echo "         Follow it with: docker compose -f $APP_DIR/docker-compose.yml logs -f voxcpm"
fi
echo "Bot: set DUBBING_STUDIO_URL=https://${HOST}/ where the bot runs (Railway → Variables)."
