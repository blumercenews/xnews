# 🤖 Crypto & Macro NewsBot

An AI-powered Twitter/X news bot styled like Walter Bloomberg, Tier10k, and ZoomerField.
Posts major crypto and macro headlines automatically — filtered and written by Claude AI.

---

## What It Does

- Pulls from 11 RSS feeds (Reuters, WSJ, CNBC, CoinDesk, CoinTelegraph, The Block, Decrypt + more)
- Claude scores every article 1–10 for importance to a crypto/macro audience
- Only 7+ scores get tweeted (no noise, no keyword spam)
- Claude rewrites each article as a punchy, on-brand tweet
- Runs every 30 minutes via GitHub Actions (free)
- Never tweets the same article twice

---

## Tweet Style

```
🚨 Fed holds rates at 5.25-5.5% for 6th straight meeting. Powell: 'not appropriate to cut until greater confidence on inflation' (Fed)

📊 US CPI: 3.1% YoY (Est: 3.2%) Core: 3.9% (Est: 4.0%) — softer across the board (BLS)

⚡ BTC breaks $100K. $1.9T market cap. $800M shorts liquidated in past hour (Coinglass)
```

---

## Setup (15 minutes total)

### Step 1: Clone or create a GitHub repo

Go to github.com → New Repository → name it `newsbot` → Private → Create

Then on your Mac, open Terminal:
```bash
mkdir newsbot && cd newsbot
git init
git remote add origin https://github.com/YOURUSERNAME/newsbot.git
```

Copy all these files into that folder.

### Step 2: Add your API keys as GitHub Secrets

Go to your GitHub repo → Settings → Secrets and variables → Actions → New repository secret

Add these 5 secrets one by one:

| Secret Name | Where to get it |
|-------------|-----------------|
| `TWITTER_API_KEY` | developer.x.com → Your App → Keys and Tokens |
| `TWITTER_API_SECRET` | Same place |
| `TWITTER_ACCESS_TOKEN` | Same place (generate if not shown) |
| `TWITTER_ACCESS_SECRET` | Same place |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |

### Step 3: Push to GitHub

```bash
git add .
git commit -m "Initial bot setup"
git push -u origin main
```

### Step 4: Enable GitHub Actions

Go to your repo → Actions tab → Click "I understand my workflows, go ahead and enable them"

That's it. The bot will now run every 30 minutes automatically.

---

## Test It First (Dry Run)

Before going live, test locally without posting:

```bash
npm install
cp .env.example .env
# Fill in your keys in .env file
npm run dry
```

You'll see what Claude scores each article and what tweet it would post — without actually posting.

---

## Manual Trigger

To run the bot right now without waiting 30 mins:
GitHub repo → Actions → NewsBot → Run workflow → Run workflow

---

## Customisation

**Change how often it runs:**
Edit `.github/workflows/bot.yml` — change the cron schedule.
`"*/30 * * * *"` = every 30 mins
`"*/15 * * * *"` = every 15 mins
`"0 * * * *"` = every hour

**Change tweet threshold:**
In `bot.js`, change `MIN_SCORE` from `7` to `8` for stricter filtering, `6` for more tweets.

**Change max tweets per run:**
In `bot.js`, change `MAX_TWEETS_PER_RUN` from `3` to whatever you want.
Remember: free tier = 500 tweets/month total.

**Add/remove RSS feeds:**
Edit the `FEEDS` array in `bot.js`.

---

## Cost Estimate

| Item | Cost |
|------|------|
| GitHub Actions | Free |
| Twitter/X Free Tier | Free (500 posts/month) |
| Claude API | ~$1–3/month at 8 tweets/day |

---

## Troubleshooting

**Bot ran but no tweets posted:**
- Check Actions log for errors
- Most likely: article scores all under 7 (normal if slow news day)
- Try manual trigger after a market event

**Twitter auth error:**
- Make sure app permissions are set to "Read and Write" in developer.x.com
- Regenerate Access Token and Secret after changing permissions

**Rate limit error:**
- You've hit 500 tweets for the month on the free tier
- Either wait for reset or upgrade to Basic ($200/mo)
