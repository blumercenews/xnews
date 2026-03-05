const Anthropic = require("@anthropic-ai/sdk");
const { TwitterApi } = require("twitter-api-v2");
const Parser = require("rss-parser");
const fs = require("fs");
const path = require("path");

// ─── Config ────────────────────────────────────────────────────────────────
const SEEN_FILE = path.join(__dirname, "seen.json");
const MAX_TWEETS_PER_RUN = 3; // max tweets per GitHub Actions run
const MIN_SCORE = 7; // Claude score threshold (1-10)

// ─── RSS Feeds ─────────────────────────────────────────────────────────────
const FEEDS = [
  // Macro / TradFi
  { url: "https://feeds.reuters.com/reuters/businessNews", category: "MACRO" },
  { url: "https://feeds.reuters.com/reuters/USNewsOnline", category: "MACRO" },
  { url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", category: "MACRO" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", category: "MACRO" },
  { url: "https://feeds.bloomberg.com/markets/news.rss", category: "MACRO" },
  { url: "https://finance.yahoo.com/news/rssindex", category: "MACRO" },
  // Crypto
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", category: "CRYPTO" },
  { url: "https://cointelegraph.com/rss", category: "CRYPTO" },
  { url: "https://www.theblock.co/rss.xml", category: "CRYPTO" },
  { url: "https://decrypt.co/feed", category: "CRYPTO" },
  { url: "https://bitcoinmagazine.com/.rss/full/", category: "CRYPTO" },
];

// ─── Clients ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const twitter = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const parser = new Parser({ timeout: 10000 });

// ─── Seen Articles Store ───────────────────────────────────────────────────
function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
      // Only keep last 500 to prevent file bloat
      if (data.length > 500) data.splice(0, data.length - 500);
      return new Set(data);
    }
  } catch (e) {}
  return new Set();
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]), "utf8");
}

// ─── Fetch All Feeds ───────────────────────────────────────────────────────
async function fetchArticles() {
  const articles = [];
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // last 2 hours only

  for (const feed of FEEDS) {
    try {
      const result = await parser.parseURL(feed.url);
      for (const item of result.items || []) {
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
        if (pubDate < cutoff) continue;
        articles.push({
          title: item.title || "",
          summary: item.contentSnippet || item.content || "",
          link: item.link || "",
          pubDate,
          category: feed.category,
          id: item.guid || item.link || item.title,
        });
      }
    } catch (e) {
      console.log(`⚠️  Feed failed: ${feed.url} — ${e.message}`);
    }
  }

  // Sort newest first
  return articles.sort((a, b) => b.pubDate - a.pubDate);
}

// ─── Claude: Score + Write Tweet ──────────────────────────────────────────
async function evaluateAndWrite(article) {
  const prompt = `You are a financial news editor for a Twitter account styled like Walter Bloomberg, Tier10k, and ZoomerField — fast, punchy, zero fluff, crypto-native but macro-aware. Our audience is traders, crypto investors, and macro watchers.

ARTICLE:
Title: ${article.title}
Summary: ${article.summary.slice(0, 400)}
Category: ${article.category}

TASK:
1. Score this article 1-10 for how MAJOR it is to our audience. Only 7+ gets tweeted.
   Major = Fed decisions, CPI/NFP/GDP prints, BTC/ETH big price moves, exchange hacks, regulatory actions, bank failures, major protocol upgrades, geopolitical market shocks, earnings beats/misses from mega caps.
   NOT major = opinion pieces, minor altcoin news, rehashed old news, minor company updates.

2. If score >= 7, write a tweet in our style:
   - Max 240 chars
   - Lead with the most important number or fact
   - Use 🚨 for breaking/major, 📊 for macro data, ⚡ for crypto
   - NO hashtags (they look amateur)
   - NO "breaking:" text prefix — the emoji does that job
   - Numbers and % front and center
   - 1-2 sentences max, punchy
   - End with source in parens e.g. (Reuters) (CoinDesk) (WSJ)

Examples of our style:
"🚨 Fed holds rates at 5.25-5.5% for 6th straight meeting. Powell: 'Not appropriate to cut until we have greater confidence inflation is moving toward 2%' (Fed)"
"📊 US CPI: 3.1% YoY (Est: 3.2%) Core CPI: 3.9% YoY (Est: 4.0%) — softer than expected across the board (BLS)"
"⚡ BTC breaks $100K for first time. $1.9T market cap. Over $800M shorts liquidated in last hour (Coinglass)"
"🚨 SEC approves spot Ethereum ETFs. BlackRock, Fidelity, Grayscale all greenlit. Trading begins tomorrow (SEC)"

Respond ONLY in this exact JSON format, nothing else:
{"score": <number>, "tweet": "<tweet text or empty string if score < 7>"}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    console.log(`⚠️  Claude error: ${e.message}`);
    return { score: 0, tweet: "" };
  }
}

// ─── Post Tweet ────────────────────────────────────────────────────────────
async function postTweet(text) {
  try {
    const { data } = await twitter.v2.tweet(text);
    console.log(`✅ Tweeted [${data.id}]: ${text.slice(0, 80)}...`);
    return true;
  } catch (e) {
    console.log(`❌ Tweet failed: ${e.message}`);
    return false;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 NewsBot starting — ${new Date().toISOString()}`);

  const seen = loadSeen();
  const articles = await fetchArticles();
  console.log(`📰 Found ${articles.length} recent articles`);

  let tweeted = 0;

  for (const article of articles) {
    if (tweeted >= MAX_TWEETS_PER_RUN) break;
    if (!article.id || seen.has(article.id)) continue;

    seen.add(article.id);
    console.log(`\n🔍 Evaluating: ${article.title.slice(0, 80)}`);

    const result = await evaluateAndWrite(article);
    console.log(`   Score: ${result.score}/10`);

    if (result.score >= MIN_SCORE && result.tweet) {
      console.log(`   Tweet: ${result.tweet}`);

      if (process.env.DRY_RUN === "true") {
        console.log(`   [DRY RUN — not posting]`);
      } else {
        const posted = await postTweet(result.tweet);
        if (posted) tweeted++;
        // Rate limit safety: wait 3s between tweets
        if (tweeted < MAX_TWEETS_PER_RUN) await sleep(3000);
      }
    }

    // Save after each to prevent re-processing if job crashes
    saveSeen(seen);
  }

  console.log(`\n✅ Done. Tweeted ${tweeted} post(s) this run.\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("💥 Fatal error:", e);
  process.exit(1);
});
