# ដាក់ Dubbing Studio លើ VPS ហើយបើកពី Bot Telegram

ពេលដាក់រួច Bot នឹងមានប៊ូតុង **«🎬 បញ្ចូលសំឡេងខ្មែរ (AI Dubbing)»** (និង `/dubbing`)។ ចុចហើយ Studio នឹងបើក **ក្នុង Telegram ផ្ទាល់** (Mini App) ទាំងលើទូរស័ព្ទ និងកុំព្យូទ័រ។

```
Telegram ──► Bot (repo នេះ) ──ប៊ូតុង Mini App──► https://dub.184-174-38-113.sslip.io
                                                    │
                          VPS 184.174.38.113 ── Caddy (HTTPS) ──► Dubbing Studio (Docker)
```

- **HTTPS ឥតគិតថ្លៃ**៖ Telegram បើកតែ Mini App ដែលជា https ប៉ុណ្ណោះ។ ឈ្មោះ `*.184-174-38-113.sslip.io` ចង្អុលទៅ IP របស់ VPS ដោយខ្លួនឯង ហើយ Caddy យកវិញ្ញាបនបត្រ HTTPS ឲ្យដោយស្វ័យប្រវត្ត។ មិនចាំបាច់ទិញ Domain ទេ (មាន Domain ផ្ទាល់ខ្លួនក៏ប្ដូរបាន)។
- **Studio** ត្រូវបាន Build ផ្ទាល់ពី GitHub repo `saveitkh/BarameyDabber`។

---

## ១. ចូល VPS

```bash
ssh root@184.174.38.113
```

## ២. ពិនិត្យថា Port 80/443 ទំនេរ

```bash
ss -tlnp | grep -E ':80 |:443 '
```

បើមាន nginx/apache កំពុងប្រើ Port ទាំងនេះ សូមបញ្ឈប់វាសិន (`systemctl stop nginx`) ឬប្រាប់ខ្ញុំ ដើម្បីរៀបចំជាមួយគ្នា។

## ៣. ដំឡើង Docker (បើមិនទាន់មាន)

```bash
command -v docker || curl -fsSL https://get.docker.com | sh
```

## ៤. ទាញ repo នេះ ហើយកំណត់

```bash
git clone https://github.com/saveitkh/Project1.git
cd Project1

cp .env.studio.example .env.studio
nano .env.studio        # ដាក់ GEMINI_API_KEY និង STUDIO_ADMIN_PASSWORD (ពាក្យសម្ងាត់ថ្មី វែងៗ)

cat .env.vps.example >> .env     # បន្ថែម STUDIO_HOST / BOT_HOST / STUDIO_GIT_REF
```

## ៥. ដំណើរការ Studio

```bash
ufw allow 80; ufw allow 443        # បើក Firewall (បើប្រើ ufw)
docker compose up -d --build
docker compose logs -f studio      # រង់ចាំឃើញ "Application startup complete"
```

ការ Build លើកដំបូងចំណាយពេល ១០–២០ នាទី (ទាញយក PyTorch, Demucs)។

សាក៖ បើក **https://dub.184-174-38-113.sslip.io** → Login ដោយ `cm5722254@gmail.com` + `STUDIO_ADMIN_PASSWORD`។

## ៦. ភ្ជាប់ប៊ូតុងក្នុង Bot

ដាក់ក្នុង Environment របស់ Bot (កន្លែងដែល Bot កំពុងដំណើរការ)៖

```
DUBBING_STUDIO_URL=https://dub.184-174-38-113.sslip.io/
```

- **Bot នៅលើ Railway**៖ Railway → Service → Variables → បន្ថែមខាងលើ → Redeploy។
- **ចង់ដំណើរការ Bot លើ VPS នេះដែរ**៖ ដាក់ការកំណត់ Bot ទាំងអស់ក្នុង `.env` ហើយ៖
  ```bash
  docker compose --profile bot up -d --build
  ```
  ⚠️ ធ្វើបែបនេះបាន **លុះត្រាតែបិទ Bot នៅលើ Railway ជាមុន**។ Bot ពីរដំណើរការព្រមគ្នា នឹងប្រជែង Telegram session និង Webhook ហើយ Telegram អាចបិទ session ចោល។

បន្ទាប់មក ក្នុង Bot ចុច /start ម្តងទៀត ដើម្បីឃើញប៊ូតុងថ្មី។

## ៦ក. Login ស្វ័យប្រវត្តតាម Telegram

នៅពេលបើក Studio ពី Bot (ប៊ូតុង «🎬 បញ្ចូលសំឡេងខ្មែរ» → «🎬 បើក Dubbing Studio») Studio នឹង **Login ដោយខ្លួនឯង** ជាមួយគណនី Telegram ដោយមិនបាច់វាយពាក្យសម្ងាត់ទេ។ ចូលលើកដំបូង គណនីនឹងត្រូវបង្កើតដោយស្វ័យប្រវត្ត។

ការកំណត់៖
- ក្នុង `.env`៖ `TELEGRAM_LOGIN_BOT_TOKEN=` (Token របស់ Bot ដដែល)
- ក្នុង `.env.studio`៖ `STUDIO_TELEGRAM_ADMIN_IDS=` (Telegram ID របស់អ្នក ដើម្បីបានសិទ្ធិ Admin។ រកមើល ID តាម @userinfobot)
- ចង់អនុញ្ញាតតែគណនីដែលមានស្រាប់ៗ៖ `STUDIO_TELEGRAM_SIGNUP=0`

បន្ទាប់ពីកែ៖ `docker compose up -d`

## ៧. Update

```bash
cd Project1 && git pull
docker compose build --no-cache studio && docker compose up -d
```

ពេល Studio branch ត្រូវបាន merge ចូល `main` រួច សូមដាក់ `STUDIO_GIT_REF=main` ក្នុង `.env`។

## ចំណាំ

- **១ គណនី = ១ ឧបករណ៍**៖ Login ក្នុង Telegram នឹងចាកចេញពី Browser ផ្សេង។
- **បន្ថែមអ្នកប្រើ Studio**៖ ដាក់ `STUDIO_ALLOW_REGISTER=1` ក្នុង `.env.studio` → `docker compose up -d` → ឲ្យគេចុះឈ្មោះ → ដាក់ `0` វិញ។
- VPS គ្មាន GPU៖ ការក្លូនសំឡេង VoxCPM2 ប្រើ Link ពី Colab ដដែល។
- វីដេអូ និងគណនីរបស់ Studio ត្រូវបានរក្សាក្នុង Docker volumes (`studio_data`, `studio_outputs`…) មិនបាត់ពេល Update ទេ។
