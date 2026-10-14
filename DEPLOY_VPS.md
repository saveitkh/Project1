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
nano /root/Project1/.env.studio   # GEMINI_API_KEY, STUDIO_ADMIN_PASSWORD (ពាក្យសម្ងាត់វែងៗ), STUDIO_TELEGRAM_ADMIN_IDS
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

## Update

រត់ពាក្យបញ្ជា `ssh … 'bash -s' < scripts/deploy_vps.sh` ដដែល។ វីដេអូ គណនី និងសំឡេងក្នុងធនាគាររក្សាក្នុង Docker volumes មិនបាត់ទេ។ ពេល branch ត្រូវបាន merge ចូល `main` សូមដាក់ `STUDIO_REF=main REPO_BRANCH=main` មុនពាក្យបញ្ជា។

## VoxCPM2

| | |
|---|---|
| ល្បឿន | CPU យឺត (ប្រហែល ១០–៦០ វិនាទី/ឃ្លា អាស្រ័យលើ CPU)។ វីដេអូបង្កើតនៅខាងក្រោយ — បិទ App បាន ហើយមើលក្នុងផ្ទាំង "វីដេអូ" ពេលក្រោយ |
| RAM | ត្រូវការ ~8GB (ឬ swap)។ បើ voxcpm ត្រូវបានសម្លាប់ដោយខ្វះ RAM, studio ប្រើសំឡេងខ្មែរ AI ធម្មតាជំនួស |
| លឿនជាងដោយ GPU | បើក `voxcpm_server/VoxCPM2_Khmer_5Voices_Colab.ipynb` (BarameyDabber) លើ Colab T4 → ដាក់ `VOXCPM_URL=https://….trycloudflare.com` ក្នុង `.env` → `docker compose up -d studio` |
| គុណភាព/ល្បឿន | `VOXCPM_TIMESTEPS=10` ក្នុង `.env` (ច្រើន = ច្បាស់ជាង តែយឺត) |
| ធនាគារសំឡេង | Admin បន្ថែម/លុបសំឡេងក្នុងផ្ទាំង **សំឡេង** នៃ App (ឈ្មោះ `ភេទ-អាយុ-លេខ` ឧ. `male-old-1`) |

## សុវត្ថិភាព

- **ប្ដូរពាក្យសម្ងាត់ root របស់ VPS** បន្ទាប់ពីដាក់រួច (`passwd`) ហើយប្រើ SSH key ជំនួសពាក្យសម្ងាត់ល្អជាង។
- `STUDIO_ADMIN_PASSWORD` ត្រូវវែង និងមិនប្រើកន្លែងផ្សេង។
- **១ គណនី = ១ ឧបករណ៍**៖ Login ក្នុង Telegram នឹងចាកចេញពី Browser ផ្សេង។
