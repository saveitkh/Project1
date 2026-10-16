# ដាក់ Khmer Dubber + VoxCPM2 លើ VPS ហើយបើកពី Bot Telegram

ពេលដាក់រួច Bot នឹងមានប៊ូតុង **«🎬 បញ្ចូលសំឡេងខ្មែរ (AI Dubbing)»** (និង `/dubbing`)។ ចុចហើយកម្មវិធីនឹងបើក **ក្នុង Telegram ផ្ទាល់** (Mini App) ហើយ Login ដោយស្វ័យប្រវត្តិ។

```
Telegram ──► Bot (repo នេះ) ──Mini App──► https://dub.184-174-38-113.sslip.io
                                              │
              VPS 184.174.38.113 ── Caddy (HTTPS) ──► studio (Docker) ──► voxcpm (VoxCPM2 2.0.3, CPU)
```

- **studio** — កម្មវិធីទូរស័ព្ទ + Backend (Build ពី `saveitkh/BarameyDabber`)
- **voxcpm** — ម៉ាស៊ីនក្លូនសំឡេង VoxCPM2 ដំណើរការលើ VPS ផ្ទាល់ (CPU) ជាមួយធនាគារសំឡេងខ្មែរ ៥ សំឡេង។ មិនបើកចេញ Internet ទេ (studio តែប៉ុណ្ណោះហៅវាបាន)
- **caddy** — HTTPS ឥតគិតថ្លៃតាម `sslip.io` (មិនចាំបាច់ទិញ Domain)

---

## ដាក់ដោយពាក្យបញ្ជាតែមួយ

ពីកុំព្យូទ័ររបស់អ្នក (ក្នុង folder repo នេះ)៖

```bash
ssh -o ServerAliveInterval=30 root@184.174.38.113 'bash -s' < scripts/deploy_vps.sh
```

Script នេះ៖ ពិនិត្យ RAM/Disk (បន្ថែម swap 8GB បើ RAM តិច) → ដំឡើង Docker → ទាញ code → កំណត់ `.env` → Build → ដំណើរការ studio + voxcpm + caddy។

**លើកដំបូង** Script នឹងបង្កើត `/root/Project1/.env.studio` ហើយឈប់។ ចូល VPS ហើយបំពេញ៖

```bash
ssh root@184.174.38.113
nano /root/Project1/.env.studio   # GEMINI_API_KEY, STUDIO_TELEGRAM_ADMIN_IDS=<Telegram ID របស់អ្នក> (គ្មានពាក្យសម្ងាត់ទៀតទេ)
nano /root/Project1/.env          # TELEGRAM_LOGIN_BOT_TOKEN= (Token Bot ដដែល)
```

បន្ទាប់មករត់ Script ម្ដងទៀត។ Build លើកដំបូង ២០–៤០ នាទី។ VoxCPM2 ទាញម៉ូដែល (~5GB) ហើយផ្ទុក ១០–៣០ នាទីទៀត — ពេលនោះ App បង្ហាញ "VoxCPM2 …" ហើយប្រើសំឡេងខ្មែរ AI ធម្មតាជំនួសសិន។

```bash
docker compose -f /root/Project1/docker-compose.yml logs -f voxcpm   # រង់ចាំ "✅ VoxCPM2 ready on CPU"
```

## ភ្ជាប់ប៊ូតុងក្នុង Bot

ក្នុង Environment របស់ Bot (Railway → Service → Variables)៖

```
DUBBING_STUDIO_URL=https://dub.184-174-38-113.sslip.io/
```

→ Redeploy → ក្នុង Bot ចុច /start ម្ដងទៀត។

⚠️ ចង់ដំណើរការ Bot លើ VPS នេះដែរ (`docker compose --profile bot up -d --build`) បាន **លុះត្រាតែបិទ Bot នៅលើ Railway សិន** — Bot ពីរប្រជែង Telegram session គ្នា។

## Bot ថ្មី «Khmer Dubber» (ជំនួសប៊ូតុងក្នុង Bot ចាស់)

Bot តូចមួយដាច់ដោយឡែក (`src/dubberBot.js`)៖ `/start` → សារស្វាគមន៍ខ្មែរ + ប៊ូតុង **🎬 បើក Khmer Dubber** + «របៀបប្រើ» ហើយមានប៊ូតុង Menu «🎬 Dubber» ក្នុង chat។ វាកំណត់ឈ្មោះ/ការពិពណ៌នា/Commands ដោយខ្លួនឯងពេលចាប់ផ្ដើម។

```bash
cd /root/Project1
nano .env     # DUBBER_BOT_TOKEN=<token> និង TELEGRAM_LOGIN_BOT_TOKEN=<token ដដែល>
docker compose up -d studio                      # ឲ្យ Studio ទទួលស្គាល់ token ថ្មី
docker compose --profile dubber-bot up -d --build dubber-bot
docker compose logs -f dubber-bot                # ឃើញ "@<username> ready"
```

**Emoji Studio ក្នុង bot ដដែល** (មិនត្រូវការការកំណត់បន្ថែម)៖
- ផ្ញើ **រូប · GIF · វីដេអូ · Sticker** → ចូលកញ្ចប់ Emoji ផ្ទាល់ខ្លួន (`t.me/addemoji/…`) + ទទួលឯកសារគ្រប់ទម្រង់ (PNG 512 ថ្លា, WebP, PNG 100, WebM 100, GIF)។
- `/coding` → ឈុត 26 icon **Coding & Terminal** (`>_` `{ }` `</>` bug, git, ✓ ✗, API, SQL…) ជា ៤ ធៀម (Terminal / Neon / Dracula / Light) ជាកញ្ចប់ Emoji + **ZIP** សម្រាប់ប្រើក្នុង project ផ្សេង (README, Discord, Slack)។
- `/badge npm run dev` (ឬ `/badge dracula git push`) → Badge ស្ទីល Terminal ពីអក្សរ។
- ប្រើ Emoji ក្នុងសារ ត្រូវការ Telegram Premium របស់អ្នកប្រើ; ឯកសារ PNG/GIF ប្រើបានគ្រប់ទីកន្លែង។ ត្រូវមាន `ffmpeg` (មានក្នុង Docker image រួចហើយ)។

- **Logo**៖ ក្នុង @BotFather → `/setuserpic` → ជ្រើស Bot → ផ្ញើរូប (`public/app_logo.png` ក្នុង BarameyDabber)។
- ចង់បានប៊ូតុង «ជំនួយ»៖ ដាក់ `DUBBER_SUPPORT_URL=https://t.me/<username>` ក្នុង `.env`។
- Menu របស់ Bot: **🎬 Khmer Dubber**, **🧾 គ្រប់គ្រងអាជីវកម្ម** (បើក App KH Invoice ជា Mini App), 🎨 Emoji Maker, 📖 របៀបប្រើ។ ដាក់ Link App អាជីវកម្មក្នុង `.env`៖ `DUBBER_BUSINESS_URL=https://<domain របស់ bot ចាស់>/invoice/` (ទទេ = ប៊ូតុងនោះប្រាប់ថា «មិនទាន់បើក»)។
- Logo បង្វិលមួយជុំ (MP4) ផ្ញើពេល `/start` — ឯកសារ `assets/brand/telescripts-spin.mp4`។
- Bot ម្នាក់ប្រើ token តែមួយ — កុំដំណើរការ `dubber-bot` ពីរកន្លែងព្រមគ្នា។
- Studio ទទួល Login ពី Bot ទាំង `DUBBER_BOT_TOKEN` និង `TELEGRAM_LOGIN_BOT_TOKEN`។ បើអេក្រង់ Login ថា «Token របស់ Server (Bot ID …) មិនដូច Bot ដែលបើក» មានន័យថា `DUBBER_BOT_TOKEN` ក្នុង `.env` ទទេ ឬខុស — ដាក់ token របស់ Bot ដែលអ្នកបើកកម្មវិធីពីវា រួច `docker compose up -d --force-recreate studio`។
- បើបង្ហាញ `token revoked` មានន័យថា token ត្រូវបាន /revoke — ដាក់ token ថ្មី ហើយ restart។

## គម្រោង (Plans) & ការបង់ប្រាក់ KHQR

Admin កំណត់អ្វីៗទាំងអស់ក្នុង App (ការកំណត់ → Admin)៖
- **គម្រោង & តម្លៃ**៖ Free (VoxCPM2 សាកល្បង ៥ វីដេអូ + សំឡេង AI), Pro $3/ខែ, Pro Plus $5/ខែ, Unlimited $30/ឆ្នាំ — កែតម្លៃ ថ្ងៃ ការពិពណ៌នា និងដែនកំណត់បាន។
- **KHQR ទទួលប្រាក់**៖ បង្កើត QR ដែលមានចំនួនទឹកប្រាក់ក្នុង App ធនាគារ (ABA/ACLEDA…) → Copy → បិទភ្ជាប់ (១ ឬ ២ ធនាគារ)។ ប៊ូតុង «សាកមើល $1» ឲ្យស្កេនពិនិត្យមុន។
- **ការបញ្ជាទិញ**៖ សមាជិកបង់ ហើយផ្ញើ Receipt → Admin ទទួលសារ Telegram → ចុច «បញ្ជាក់»។ ដាក់ `BAKONG_API_TOKEN` ក្នុង `.env.studio` ដើម្បីបញ្ជាក់ដោយស្វ័យប្រវត្តិ។
- **សំឡេង PRO**៖ ផ្ទាំង «សំឡេង» → ចុចផ្កាយលើសំឡេង (ឬបន្ថែមសំឡេងថ្មីជា PRO)។ សំឡេង PRO ប្រើបានតែតាមដែនកំណត់នៃគម្រោង។

## Update

រត់ពាក្យបញ្ជា `ssh … 'bash -s' < scripts/deploy_vps.sh` ដដែល។ វីដេអូ គណនី និងសំឡេងក្នុងធនាគាររក្សាក្នុង Docker volumes មិនបាត់ទេ។ ពេល branch ត្រូវបាន merge ចូល `main` សូមដាក់ `STUDIO_REF=main REPO_BRANCH=main` មុនពាក្យបញ្ជា។

## VoxCPM2

| | |
|---|---|
| ល្បឿន | CPU យឺត (ប្រហែល ១០–៦០ វិនាទី/ឃ្លា អាស្រ័យលើ CPU)។ វីដេអូបង្កើតនៅខាងក្រោយ — បិទ App បាន ហើយមើលក្នុងផ្ទាំង "វីដេអូ" ពេលក្រោយ |
| RAM | ត្រូវការ ~8GB (ឬ swap)។ បើ voxcpm ត្រូវបានសម្លាប់ដោយខ្វះ RAM, studio ប្រើសំឡេងខ្មែរ AI ធម្មតាជំនួស |
| លឿនជាងដោយ GPU | ប្រើ `voxcpm_server/VoxCPM2_Colab_Server.ipynb` (BarameyDabber) លើ Colab GPU → ដាក់ `VOXCPM_URL=https://….trycloudflare.com` និង `VOXCPM_API_KEY=<កូដសម្ងាត់ដូចគ្នា>` ក្នុង `.env` → `docker compose up -d studio` (មើលជំហានពេញក្នុងចម្លើយ ឬ README) |
| គុណភាព/ល្បឿន | `VOXCPM_TIMESTEPS=10` ក្នុង `.env` (ច្រើន = ច្បាស់ជាង តែយឺត) |
| ធនាគារសំឡេង | Admin បន្ថែម/លុបសំឡេងក្នុងផ្ទាំង **សំឡេង** នៃ App (ឈ្មោះ `ភេទ-អាយុ-លេខ` ឧ. `male-old-1`) |

## សុវត្ថិភាព

- **ប្ដូរពាក្យសម្ងាត់ root របស់ VPS** បន្ទាប់ពីដាក់រួច (`passwd`) ហើយប្រើ SSH key ជំនួសពាក្យសម្ងាត់ល្អជាង។
- **ចូលតាម Telegram តែប៉ុណ្ណោះ** — គ្មានទំព័រពាក្យសម្ងាត់ទេ។ Admin = Telegram ID ក្នុង `STUDIO_TELEGRAM_ADMIN_IDS` (ដក ID ចេញ → បាត់សិទ្ធិពេល Login ក្រោយ)។ ទិន្នន័យ Login ត្រូវផ្ទៀងផ្ទាត់ដោយ HMAC ជាមួយ token របស់ bot។
- **១ គណនី = ១ ឧបករណ៍**៖ Login ក្នុង Telegram នឹងចាកចេញពី Browser ផ្សេង។
