# Running on a VPS

```bash
ssh root@<vps-ip>
apt-get update && apt-get install -y git
git clone -b ccr-a1134081-gew17l https://github.com/saveitkh/Project1.git
cd Project1/deploy/vps
bash setup.sh        # first run creates .env and stops
nano .env            # paste the values from Railway -> backend -> Variables
bash setup.sh        # builds and starts; prints the bot's https address
```

The app sets the Telegram webhook to `PUBLIC_URL` on startup, so once it's
up the bot answers from the VPS. Stop the Railway service so the two don't
fight over the webhook.

- Update after a new push (pull, rebuild, then health check): `bash update.sh`
- Is it working? `bash check.sh` — ✅/❌ per check, with the fix for each ❌
- Logs: `docker compose logs -f app`
- Restart: `docker compose restart app`

Step-by-step guide in Khmer, including how to read build output and a
table of common errors: [GUIDE-KM.md](GUIDE-KM.md)
