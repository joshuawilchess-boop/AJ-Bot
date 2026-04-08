# Deploy AJ to Railway — Step by Step

## What you need (you already have these):
- Telegram bot token (from BotFather)
- Anthropic API key
- Railway account

---

## Step 1 — Push code to GitHub

1. Go to github.com → New repository → name it `aj-bot` → Create
2. On your Mac, open Terminal and run:

```bash
cd ~/Desktop
# drag the aj-bot folder here first, then:
cd aj-bot
git init
git add .
git commit -m "AJ bot initial deploy"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/aj-bot.git
git push -u origin main
```

---

## Step 2 — Deploy on Railway

1. Go to railway.app → New Project → Deploy from GitHub repo
2. Select your `aj-bot` repo
3. Railway will auto-detect it's a Node.js app

---

## Step 3 — Add your environment variables

In Railway dashboard → your project → Variables tab, add these 3:

| Variable | Value |
|---|---|
| TELEGRAM_TOKEN | your token from BotFather |
| ANTHROPIC_API_KEY | your Anthropic key |
| WEBHOOK_URL | (leave blank for now — fill in after deploy) |

Click Deploy.

---

## Step 4 — Get your Railway URL and set WEBHOOK_URL

1. After deploy, Railway gives you a URL like: `https://aj-bot-production-xxxx.up.railway.app`
2. Copy that URL
3. Go back to Variables → update WEBHOOK_URL to that URL
4. Railway will auto-redeploy

---

## Step 5 — Test AJ

1. Open Telegram
2. Search for your bot by username (e.g. @AJ_YourName_bot)
3. Send `/start`
4. AJ should reply instantly

---

## AJ's built-in commands:
- `/start` — Wake AJ up
- `/status` — Quick status of all 3 businesses
- `/clear` — Clear conversation memory (fresh start)
- Anything else — AJ responds as your business agent

---

## Troubleshooting

**AJ not responding?**
- Check Railway logs (Deployments tab → View Logs)
- Make sure all 3 environment variables are set
- Make sure WEBHOOK_URL matches your Railway domain exactly (no trailing slash)

**Getting errors in logs?**
- Double-check your TELEGRAM_TOKEN — copy it fresh from BotFather
- Double-check your ANTHROPIC_API_KEY has credits

---

## Cost
- Railway: Free tier ($5 free credits/month — enough for personal use)
- Anthropic API: ~$0.01–0.05 per conversation (very cheap)
- Telegram: Free forever
