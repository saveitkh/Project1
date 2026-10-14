#!/usr/bin/env bash
# Deploy / update the Khmer Dubber studio + VoxCPM2 + HTTPS on this VPS.
# Run as root on the VPS, or from your own computer:
#   ssh root@184.174.38.113 'bash -s' < scripts/deploy_vps.sh
# Safe to run again for every update.
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
[ "$MEM_GB" -lt 8 ] && warn "VoxCPM2 on CPU needs ~8 GB RAM; with ${MEM_GB} GB it may be killed (the studio then falls back to the plain Khmer AI voice)."
[ "$DISK_GB" -lt 20 ] && warn "Less than 20 GB free: the images + VoxCPM2 model need ~15 GB."
if [ "$MEM_GB" -lt 8 ] && ! swapon --show | grep -q .; then
  say "Adding an 8 GB swap file so the model can load"
  fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
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
[ -f .env.studio ] || { cp .env.studio.example .env.studio; warn "Created .env.studio — fill GEMINI_API_KEY and STUDIO_ADMIN_PASSWORD, then run this script again."; }
set_env() { # key value file — add or replace
  if grep -q "^$1=" "$3"; then sed -i "s|^$1=.*|$1=$2|" "$3"; else echo "$1=$2" >> "$3"; fi
}
grep -q '^STUDIO_HOST=' .env || set_env STUDIO_HOST dub.184-174-38-113.sslip.io .env
grep -q '^BOT_HOST=' .env || set_env BOT_HOST bot.184-174-38-113.sslip.io .env
set_env STUDIO_GIT_REF "$STUDIO_REF" .env
grep -q '^VOXCPM_API_KEY=.\+' .env || set_env VOXCPM_API_KEY "$(openssl rand -hex 24)" .env
if ! grep -q '^STUDIO_ADMIN_PASSWORD=.\+' .env.studio; then
  warn "STUDIO_ADMIN_PASSWORD is empty in $APP_DIR/.env.studio — the studio refuses to start without it."
  exit 1
fi

say "Firewall"
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80 >/dev/null; ufw allow 443 >/dev/null; fi
if ss -tlnp | grep -E ':(80|443) ' | grep -vq docker; then
  warn "Something other than Docker listens on port 80/443:"; ss -tlnp | grep -E ':(80|443) '
fi

say "Build (first time 20-40 min: PyTorch, Demucs, VoxCPM2)"
docker compose build --pull studio voxcpm
docker compose up -d studio voxcpm caddy

say "Status"
docker compose ps
HOST=$(grep '^STUDIO_HOST=' .env | cut -d= -f2)
for i in $(seq 1 30); do
  if docker compose exec -T studio curl -fs http://127.0.0.1:3000/api/system/version >/dev/null 2>&1; then
    echo "Studio: up → https://${HOST}/"; break
  fi
  sleep 5
done
echo "VoxCPM2: downloading/loading the model can take 10-30 minutes the first time."
echo "         Follow it with: docker compose -f $APP_DIR/docker-compose.yml logs -f voxcpm"
echo "Bot: set DUBBING_STUDIO_URL=https://${HOST}/ where the bot runs (Railway → Variables)."
