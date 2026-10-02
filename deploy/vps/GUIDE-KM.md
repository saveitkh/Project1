# មគ្គុទ្ទេសក៍ប្រើ VPS — SaveIt Bot

ឯកសារនេះពន្យល់ពីរបៀបចូល VPS, update bot, ពិនិត្យថាដំណើរការត្រឹមត្រូវ, និងរបៀបអាន error។

---

## 1. ដឹងថាខ្លួនឯងកំពុងនៅកន្លែងណា

មុនវាយពាក្យបញ្ជាណាមួយ **មើល prompt** (អក្សរនៅខាងឆ្វេង cursor) ជានិច្ច៖

| Prompt ដែលឃើញ | បងនៅទីណា | អាចវាយអ្វីបាន |
|---|---|---|
| `PS C:\Users\BDC>` | **កុំព្យូទ័រ Windows** របស់បង | តែ `ssh ...` ប៉ុណ្ណោះ |
| `root@vmi3599122:~#` | **VPS** (folder ផ្ទះ) | ពាក្យបញ្ជា Linux ទាំងអស់ |
| `root@vmi3599122:~/Project1/deploy/vps#` | **VPS** ក្នុង folder bot | `bash update.sh`, `bash check.sh`, … |
| អេក្រង់មាន `GNU nano` នៅខាងលើ | កំពុងកែឯកសារ | វាយអត្ថបទ · `Ctrl+O` Enter រក្សាទុក · `Ctrl+X` ចេញ |

> ⚠️ បើឃើញ `PS C:\...>` មានន័យថា SSH ដាច់ហើយ — ពាក្យបញ្ជា Linux នឹងមិនដំណើរការទេ។ ត្រូវ ssh ចូលម្ដងទៀត។

---

## 2. ចូល VPS

បើក **Windows PowerShell** (មិនមែន x86) រួចវាយ៖

```
ssh -o ServerAliveInterval=30 root@184.174.38.113
```

- `-o ServerAliveInterval=30` ជួយកុំឲ្យ SSH ដាច់ពេលកំពុង build យូរ។
- ពេលសួរ password វាយហើយចុច Enter (អក្សរ **មិនបង្ហាញ** ពេលវាយ ជារឿងធម្មតា)។

បន្ទាប់ពីចូលបាន ចូល folder bot៖

```
cd ~/Project1/deploy/vps
```

### ✂️ ការ Copy / Paste

- **Paste**៖ ចុចកណ្ដុរខាងស្ដាំ (right-click) ក្នុងបង្អួច PowerShell
- បើ paste ហើយឃើញ `^[[200~` ឬ `~` នៅខាងមុខ/ក្រោយពាក្យបញ្ជា — វាយពាក្យនេះ **ម្ដងគត់** ដើម្បីដោះស្រាយជាអចិន្ត្រៃយ៍៖
  ```
  echo "set enable-bracketed-paste off" >> ~/.inputrc
  ```
  រួច `exit` ហើយ ssh ចូលម្ដងទៀត។
- **Paste តែមួយបន្ទាត់ម្ដង** ហើយមើលលទ្ធផលសិន មុនបន្តបន្ទាត់ក្រោយ។

---

## 3. ពាក្យបញ្ជាប្រចាំថ្ងៃ (នៅក្នុង `~/Project1/deploy/vps`)

| ចង់ធ្វើអ្វី | វាយ |
|---|---|
| **Update** កូដថ្មី + build + ពិនិត្យ (ប្រើញឹកញាប់បំផុត) | `bash update.sh` |
| **ពិនិត្យ** ថា bot ដំណើរការត្រឹមត្រូវឬទេ | `bash check.sh` |
| មើល **log** ផ្ទាល់ (ចុច `Ctrl+C` ដើម្បីឈប់មើល — bot មិនបិទទេ) | `docker compose logs -f app` |
| មើល log 100 បន្ទាត់ចុងក្រោយ | `docker compose logs --tail 100 app` |
| មើលស្ថានភាព container | `docker compose ps` |
| **Restart** bot (ក្រោយកែ `.env`) | `docker compose up -d` |
| កែ **.env** (key, តម្លៃ) | `nano .env` |
| បិទ bot | `docker compose down` |
| បើក bot វិញ | `docker compose up -d` |

> 💡 **មិនចាំបាច់** វាយ `npm install` ដោយខ្លួនឯងទេ។ វាត្រូវបានធ្វើ **ដោយស្វ័យប្រវត្តិ** នៅក្នុង Docker ពេល `bash update.sh` (ជំហាន `[5/8] RUN npm install`)។

### បើ SSH ដាច់ញឹកញាប់ពេល Build

Run ឲ្យវាដំណើរការបន្តទោះ SSH ដាច់៖

```
nohup bash update.sh > update.log 2>&1 &
```

រួចមើលដំណើរការ (ឬ ssh ចូលវិញ ហើយមើលម្ដងទៀតក៏បាន)៖

```
tail -f update.log
```

---

## 4. អាន `bash check.sh`

ឧទាហរណ៍ពេល **ល្អ**៖

```
━━━━━━ SaveIt bot · ពិនិត្យសុខភាព ━━━━━━
✅ .env មានតម្លៃចាំបាច់គ្រប់
✅ container app កំពុងដំណើរការ
✅ container caddy កំពុងដំណើរការ
✅ app ឆ្លើយតប (/health)
✅ https://184-174-38-113.sslip.io ចូលបានពីខាងក្រៅ
✅ Webhook → https://184-174-38-113.sslip.io/api/telegram-bot/webhook
✅ គ្មាន error ក្នុង log 30 នាទីចុងក្រោយ
✅ ថាសប្រើ 12%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 ល្អទាំងអស់ (8 ចំណុច) — bot ដំណើរការត្រឹមត្រូវ
```

- **✅** = ត្រឹមត្រូវ
- **⚠️** = គួរដឹង តែ bot នៅដំណើរការ
- **❌** = មានបញ្ហា — ធ្វើតាមបន្ទាត់ **👉** ខាងក្រោមវា

---

## 5. អាន Output ពេល Build (`bash update.sh`)

### ✅ សញ្ញាជោគជ័យ

```
=> CACHED [2/8] RUN apt-get update ...      ← CACHED = ប្រើពីលើកមុន (លឿន) ល្អ
=> [5/8] RUN npm install --omit=dev         ← កំពុងដំឡើង package
=> exporting to image
 ✔ Image vps-app              Built          ← build រួច
 ✔ Container vps-app-1        Started        ← bot ចាប់ផ្ដើម
 ✔ Container vps-caddy-1      Started        ← HTTPS ចាប់ផ្ដើម
```

ក្នុង log (`docker compose logs app`) ពេល bot ចាប់ផ្ដើមត្រឹមត្រូវ៖

```
Userbot service listening on http://localhost:8000
Telegram bot webhook set to https://.../api/telegram-bot/webhook
```

### ❌ សញ្ញាបញ្ហា

បន្ទាត់ពណ៌ **ក្រហម**, ពាក្យ `ERROR`, `failed`, `exit code`, ឬ `Error:` ។

---

## 6. តារាង Error ទូទៅ និងវិធីដោះស្រាយ

### នៅលើ Windows / SSH

| Error ដែលឃើញ | មានន័យថា | ដោះស្រាយ |
|---|---|---|
| `The token '&&' is not a valid statement separator` | វាយក្នុង Windows មិនមែន VPS | ssh ចូល VPS សិន |
| `'ssh' is not recognized` | បើក PowerShell (x86) | បើក Windows PowerShell ធម្មតា ឬ Terminal |
| `Permission denied, please try again` | Password ខុស | វាយដោយដៃ យឺតៗ · ពិនិត្យ Caps Lock |
| `client_loop: send disconnect: Connection reset` | SSH ដាច់ (bot **នៅដំណើរការ** ធម្មតា) | ssh ចូលវិញ · ប្រើ `-o ServerAliveInterval=30` |
| `apt-get: command not found` ជាមួយ `^[[200~` | Paste មានតួអក្សរលាក់ | មើលផ្នែក ✂️ Copy/Paste ខាងលើ |
| `' is not a git command` ឬ `^M` | Paste មាន Enter លាក់ | វាយពាក្យបញ្ជាដោយដៃ |
| `Command 'Bot' not found` | បាន paste អត្ថបទពន្យល់ មិនមែនពាក្យបញ្ជា | paste តែអ្វីដែលនៅក្នុងប្រអប់ code |

### នៅលើ VPS / Bot

| Error ក្នុង log | មានន័យថា | ដោះស្រាយ |
|---|---|---|
| `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set` | `.env` ខ្វះ key Supabase | `nano .env` បំពេញ → `docker compose up -d` |
| `401` / `Unauthorized` (OpenRouter) | `OPENROUTER_API_KEY` ខុស | ដាក់ key ត្រឹមត្រូវ → `docker compose up -d` |
| `402` / `Insufficient credits` (OpenRouter) | លុយក្នុង OpenRouter អស់ | បញ្ចូលលុយនៅ openrouter.ai |
| `ElevenLabs 401` | `ELEVENLABS_API_KEY` ខុស | ដាក់ key ត្រឹមត្រូវ |
| `ElevenLabs 402` / `quota` | Plan ElevenLabs អស់ credit | បង់ / upgrade plan |
| `flood wait 16s … waiting it out` | Telegram ឲ្យរង់ចាំ — **ធម្មតា** | មិនចាំបាច់ធ្វើអ្វីទេ |
| `CHANNEL_INVALID` | Channel ទុកវីដេអូមិនត្រឹមត្រូវ | forward សារពី channel ទុកវីដេអូមក bot ក្នុង chat admin |
| `Wrong response from the webhook: 502` | Telegram ទាក់ទង bot មិនបាន (app គាំង) | `docker compose logs --tail 80 app` |
| `no space left on device` | ថាសពេញ | `docker builder prune -af && docker image prune -af` |
| `port is already allocated` (80/443) | កម្មវិធីផ្សេងប្រើ port | `docker ps` មើល · បិទកម្មវិធីនោះ |
| Caddy: `could not get certificate` | HTTPS មិនទាន់ទទួល cert | រង់ចាំ 1–2 នាទី · ពិនិត្យថា port 80/443 បើក |

---

## 7. ក្រោយ Update — ពាក្យបញ្ជាក្នុង Telegram (chat admin)

| ពាក្យបញ្ជា | ប្រើធ្វើអ្វី |
|---|---|
| `/makeemoji` | បង្កើត pack logo ឡើងវិញ (ក្រោយបន្ថែម logo ថ្មី) — ត្រូវការ Telegram Premium |
| `/aimodels` | មើល model AI ប៊ូតុងនីមួយៗ + តម្លៃ |
| `/setprices` | មើល/កែតម្លៃ Credit · ឧ. `/setprices premium=4 song=30` |
| `/aigive <user id> <ចំនួន>` | បន្ថែម AI Credit ឲ្យអ្នកប្រើ |
| `/aicredit <user id>` | មើល Credit អ្នកប្រើ |
| `/stats` | ស្ថិតិ bot |

---

## 8. ច្បាប់សុវត្ថិភាព

- ❌ **កុំ** ផ្ញើ password, `.env`, ឬ API key ក្នុង chat ឬទៅនរណាម្នាក់
- ❌ **កុំ** commit `.env` ទៅ GitHub (វាត្រូវបានរារាំងដោយ `.gitignore` រួចហើយ)
- ✅ ប្ដូរ password VPS ញឹកញាប់៖ `passwd`
- ✅ មុនកែ `.env` អាច backup សិន៖ `cp .env .env.backup`

---

## 9. លំដាប់ពេលមានបញ្ហា

1. `bash check.sh` → មើល ❌
2. ធ្វើតាម 👉 របស់ ❌ នោះ
3. បើនៅតែមិនដឹង៖ `docker compose logs --tail 100 app` → ថតអេក្រង់ ផ្ញើឲ្យអ្នកជួយ
4. សាក restart៖ `docker compose up -d` (ឬ `bash update.sh`)
