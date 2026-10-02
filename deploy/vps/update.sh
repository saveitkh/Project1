#!/usr/bin/env bash
# Pull the newest code, rebuild and restart the bot, then health-check it:
#   bash update.sh
# Safe to run again after a failure or a dropped SSH connection -- Docker
# reuses every build step that already finished.
set -euo pipefail
cd "$(dirname "$0")"

echo "⬇️  ទាញកូដថ្មីពី GitHub…"
git -C ../.. pull --ff-only

echo "🔨 Build និង restart (លើកដំបូងអាចយូរ 3–5 នាទី; ក្រោយមកលឿន)…"
docker compose --env-file .env up -d --build

echo "⏳ រង់ចាំ bot ចាប់ផ្ដើម 20 វិនាទី…"
sleep 20
bash check.sh
