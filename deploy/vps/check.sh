#!/usr/bin/env bash
# Health check for the bot on this VPS:  bash check.sh
# Prints ✅ / ❌ for each check (in Khmer) and, for a ❌, the command that
# shows why. Read-only: it never restarts or changes anything.
set -u
cd "$(dirname "$0")"

ok=0
bad=0
pass() { echo "✅ $1"; ok=$((ok + 1)); }
fail() {
  echo "❌ $1"
  [ -n "${2:-}" ] && echo "   👉 $2"
  bad=$((bad + 1))
}
warn() { echo "⚠️  $1"; [ -n "${2:-}" ] && echo "   👉 $2"; }
env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-; }

echo "━━━━━━ SaveIt bot · ពិនិត្យសុខភាព ━━━━━━"

# 1. .env has what the bot can't start without.
if [ ! -f .env ]; then
  fail "រកមិនឃើញឯកសារ .env" "bash setup.sh"
else
  missing=""
  for k in TELEGRAM_LOGIN_BOT_TOKEN TELEGRAM_API_ID TELEGRAM_API_HASH SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
    [ -z "$(env_get "$k")" ] && missing="$missing $k"
  done
  if [ -z "$missing" ]; then pass ".env មានតម្លៃចាំបាច់គ្រប់"; else fail ".env ខ្វះ:$missing" "nano .env   រួច   bash update.sh"; fi
  [ -z "$(env_get OPENROUTER_API_KEY)" ] && warn "OPENROUTER_API_KEY ទទេ — គ្មាន Claude / ChatGPT / Gemini Pro / Grok / DeepSeek"
  [ -z "$(env_get GEMINI_API_KEY)" ] && warn "GEMINI_API_KEY ទទេ — គ្មាន 🆓 Gemini Free"
  [ -z "$(env_get ELEVENLABS_API_KEY)" ] && warn "ELEVENLABS_API_KEY ទទេ — គ្មានប៊ូតុង 🎵 បង្កើតចម្រៀង"
fi

# 2. Both containers up, and the app not crash-looping.
for svc in app caddy; do
  state=$(docker compose ps --all --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1 == s { print $2 }')
  if [ "$state" = "running" ]; then
    pass "container $svc កំពុងដំណើរការ"
  else
    fail "container $svc: ${state:-មិនមាន}" "docker compose logs --tail 50 $svc"
  fi
done
app_id=$(docker compose ps -q app 2>/dev/null)
if [ -n "$app_id" ]; then
  restarts=$(docker inspect -f '{{.RestartCount}}' "$app_id" 2>/dev/null || echo 0)
  if [ "${restarts:-0}" -gt 0 ]; then
    warn "app បាន restart ${restarts} ដង (គាំងហើយចាប់ផ្ដើមឡើងវិញ)" "docker compose logs --tail 80 app"
  fi
fi

# 3. The app answers inside its container.
if docker compose exec -T app node -e "fetch('http://localhost:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  pass "app ឆ្លើយតប (/health)"
else
  fail "app មិនឆ្លើយតប" "docker compose logs --tail 80 app"
fi

# 4. Reachable from the internet over HTTPS (what Telegram needs).
domain=$(env_get DOMAIN)
if [ -z "$domain" ]; then
  fail "DOMAIN ទទេក្នុង .env" "bash setup.sh"
elif curl -fsS -m 15 "https://$domain/health" >/dev/null 2>&1; then
  pass "https://$domain ចូលបានពីខាងក្រៅ"
else
  fail "https://$domain ចូលមិនបាន (HTTPS/Caddy)" "docker compose logs --tail 50 caddy"
fi

# 5. Telegram's own view of the webhook: where it points, and its last error.
token=$(env_get TELEGRAM_LOGIN_BOT_TOKEN)
if [ -n "$token" ]; then
  info=$(curl -fsS -m 15 "https://api.telegram.org/bot$token/getWebhookInfo" 2>/dev/null)
  if [ -z "$info" ]; then
    fail "សួរ Telegram មិនបាន (token ខុស ឬគ្មាន internet)" "ពិនិត្យ TELEGRAM_LOGIN_BOT_TOKEN ក្នុង .env"
  else
    echo "$info" | python3 -c '
import json, sys, time
r = json.load(sys.stdin).get("result", {})
url = r.get("url") or "(គ្មាន)"
pending = r.get("pending_update_count", 0)
err = r.get("last_error_message")
when = r.get("last_error_date") or 0
recent = err and time.time() - when < 15 * 60
print(("❌" if not r.get("url") else "✅") + " Webhook → " + url)
if pending > 20:
    print("⚠️  សារកំពុងរង់ចាំ " + str(pending) + " — bot ឆ្លើយយឺត ឬគាំង")
if recent:
    print("❌ Telegram error ថ្មីៗ: " + err)
    print("   👉 docker compose logs --tail 80 app")
elif err:
    print("ℹ️  error ចាស់ (លើស 15 នាទីមុន): " + err)
'
  fi
fi

# 6. Errors in the last 30 minutes of the app's log. Flood waits are
#    Telegram's normal rate limiting, not a fault, so they're left out.
errors=$(docker compose logs --since 30m app 2>/dev/null | grep -iE "error|failed|crash|unhandled|must be set" | grep -viE "flood wait" | tail -8)
if [ -z "$errors" ]; then
  pass "គ្មាន error ក្នុង log 30 នាទីចុងក្រោយ"
else
  warn "error ក្នុង log 30 នាទីចុងក្រោយ (៨ បន្ទាត់ចុងក្រោយ):"
  echo "$errors" | sed 's/^/      /' | cut -c1-200
fi

# 7. Disk and memory.
disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "${disk:-0}" -ge 90 ]; then
  fail "ថាសពេញ ${disk}%" "docker builder prune -af && docker image prune -af"
else
  pass "ថាសប្រើ ${disk}%"
fi
mem=$(free -m | awk '/^Mem:/ { printf "%d", $7 }')
[ -n "$mem" ] && [ "$mem" -lt 300 ] && warn "RAM នៅសល់តិច (${mem}MB)" "docker compose restart app"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$bad" -eq 0 ]; then
  echo "🎉 ល្អទាំងអស់ ($ok ចំណុច) — bot ដំណើរការត្រឹមត្រូវ"
else
  echo "🔧 មានបញ្ហា $bad ចំណុច — ធ្វើតាម 👉 ខាងលើ ឬមើល GUIDE-KM.md"
fi
