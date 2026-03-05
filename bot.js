const Anthropic = require("@anthropic-ai/sdk");
const { TwitterApi } = require("twitter-api-v2");
const Parser = require("rss-parser");
const fs = require("fs");
const path = require("path");

// ─── Config ────────────────────────────────────────────────────────────────
const SEEN_FILE = path.join(__dirname, "seen.json");
const MAX_TWEETS_PER_RUN = 2;   // max tweets per run
const MAX_EVALUATIONS = 12;     // max articles sent to Claude per run (cost control)
const MIN_SCORE = 7;            // Claude score threshold (1-10)

// ─── Pre-filter keywords (skip obviously minor articles before hitting Claude)
const SKIP_KEYWORDS = [
  "jim cramer", "top 10 things to watch", "should you hold", "best stocks",
  "stock of the day", "analyst says buy", "price target", "ratings change",
  "here's why", "why investors", "portfolio update", "fund increased",
  "al pacino", "celebrity", "opinion:", "sponsored", "thinks bitcoin",
  "predicts bitcoin", "thinks btc", "predicts btc", "thinks eth",
  "could reach", "might hit", "could hit", "price prediction",
  "top picks", "stocks to watch", "5 reasons", "10 reasons",
  "everything you need to know", "explained", "what is"
];

const MAJOR_KEYWORDS = [
  "fed ", "federal reserve", "cpi", "inflation", "gdp", "nfp", "jobs report",
  "interest rate", "powell", "rate cut", "rate hike", "recession",
  "bitcoin", "btc", "ethereum", "eth", "crypto", "sec ", "etf",
  "bank fail", "collapse", "hack", "exploit", "drain", "stolen",
  "sanctions", "tariff", "trade war",
  "earnings", "beats", "misses", "revenue", "billion", "trillion",
  "breaking", "emergency", "crisis", "war", "geopolit",
  "raises $", "funding round", "series a", "series b", "series c",
  "acqui", "merger", "ipo", "license", "ban", "approved", "rejected",
  "regulation", "congress", "senate", "legislation", "bill passed",
  "stablecoin", "depeg", "defi", "protocol", "outage", "down",
  "nation", "country", "government", "treasury", "reserve"
];

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

   MAJOR (7+) examples:
   - Fed decisions, CPI/NFP/GDP prints, interest rate moves
   - Major exchange hacks or exploits ($10M+)
   - Big funding rounds ($100M+) for crypto or fintech
   - Regulatory actions: SEC, CFTC, government crypto bills, bans, approvals
   - Spot ETF approvals or rejections
   - Major protocol upgrades or chain outages
   - Bank failures or major financial institution collapses
   - Geopolitical events moving markets
   - Mega cap earnings beats/misses (Apple, Tesla, Nvidia etc)
   - Stablecoin depegs or major DeFi exploits
   - Nation-state Bitcoin adoption or bans
   - Major corporate treasury Bitcoin purchases

   NOT MAJOR (skip these):
   - Price predictions and opinions ("Saylor thinks BTC hits 80k")
   - Analyst ratings changes or price targets
   - Minor altcoin news
   - Opinion pieces or editorials
   - Rehashed old news
   - Minor company updates
   - Celebrity crypto takes
   - "Top stocks to watch" type content

2. If score >= 7, write a tweet in our style:
   - EVERYTHING IN CAPITALS
   - Max 240 chars total
   - Lead with the most important number or fact
   - Use 🚨 for major news, 📊 for macro data, ⚡ for crypto
   - NO hashtags
   - NO paragraphs — one or two punchy lines max
   - NO source attribution at the end
   - Numbers and % front and center

   For score 9-10 (truly massive news) use this format:
   "[ BREAKING ]

   YOUR CAPS TWEET HERE"

   For score 7-8 use normal format:
   "🚨 YOUR CAPS TWEET HERE"

Examples of our style:
"🚨 FED HOLDS RATES AT 5.25-5.5% FOR 6TH STRAIGHT MEETING. POWELL: NOT APPROPRIATE TO CUT UNTIL GREATER CONFIDENCE ON INFLATION"
"📊 US CPI: 3.1% YOY (EST: 3.2%) CORE CPI: 3.9% YOY (EST: 4.0%) — SOFTER THAN EXPECTED ACROSS THE BOARD"
"⚡ COINBASE SECURES FULL EU CRYPTO LICENCE. FIRST MAJOR US EXCHANGE APPROVED UNDER MICA FRAMEWORK"
"⚡ $340M EXPLOIT HIT PROTOCOL X. FUNDS DRAINED VIA REENTRANCY ATTACK. TEAM HAS PAUSED CONTRACTS"
"[ BREAKING ]

SEC APPROVES SPOT ETHEREUM ETFS. BLACKROCK, FIDELITY, GRAYSCALE ALL GREENLIT. TRADING BEGINS TOMORROW"

Respond ONLY in this exact JSON format, nothing else:
{"score": <number>, "tweet": "<tweet text or empty string if score < 7>"}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
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
  let evaluated = 0;

  for (const article of articles) {
    if (tweeted >= MAX_TWEETS_PER_RUN) break;
    if (evaluated >= MAX_EVALUATIONS) break;
    if (!article.id || seen.has(article.id)) continue;

    // Pre-filter: skip obvious junk without hitting Claude
    const titleLower = article.title.toLowerCase();
    if (SKIP_KEYWORDS.some(k => titleLower.includes(k))) {
      seen.add(article.id);
      saveSeen(seen);
      continue;
    }

    // Pre-filter: only send to Claude if it looks potentially major
    const hasMajorKeyword = MAJOR_KEYWORDS.some(k => titleLower.includes(k));
    if (!hasMajorKeyword) {
      seen.add(article.id);
      saveSeen(seen);
      continue;
    }

    seen.add(article.id);
    evaluated++;
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
