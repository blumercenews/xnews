const Anthropic = require("@anthropic-ai/sdk");
const { TwitterApi } = require("twitter-api-v2");
const Parser = require("rss-parser");
const fs = require("fs");
const path = require("path");

// ─── Config ────────────────────────────────────────────────────────────────
const SEEN_FILE = path.join(__dirname, "seen.json");
const MAX_TWEETS_PER_RUN = 2;   // max tweets per run
const MAX_EVALUATIONS = 12;     // max articles sent to Claude per run (cost control)
const MIN_SCORE = 7;            // threshold — 7+ posts, 9-10 gets BREAKING

// ─── Pre-filter keywords (skip obviously minor articles before hitting Claude)
const SKIP_KEYWORDS = [
  // Noise/opinion
  "jim cramer", "top 10 things to watch", "should you hold", "best stocks",
  "stock of the day", "analyst says buy", "price target", "ratings change",
  "here's why", "why investors", "portfolio update", "fund increased",
  "celebrity", "opinion:", "sponsored", "thinks bitcoin",
  "predicts bitcoin", "thinks btc", "predicts btc", "thinks eth",
  "could reach", "might hit", "could hit", "price prediction",
  "top picks", "stocks to watch", "5 reasons", "10 reasons",
  "everything you need to know", "what is", "how to",
  "best crypto", "top altcoins", "gems", "hidden gem",
  "technical analysis", "chart pattern", "support level",
  // Anticipation/preview tweets — no actual data, just noise
  "awaiting print", "awaiting data", "print incoming", "incoming friday",
  "ahead of", "preview:", "what to expect", "markets pricing in",
  "expected to show", "due friday", "due tomorrow", "due later",
  "analysts expect", "consensus expects", "whisper number",
  "australia", "australian", "rba ", "reserve bank of australia",
  "canada", "canadian", "bank of canada",
  "new zealand", "rbnz",
  "india", "rbi ", "reserve bank of india",
  "brazil", "brazil central bank",
  "mexico", "banxico",
  "south korea", "bank of korea",
  "indonesia", "bank indonesia",
  "turkey", "tcmb",
  "south africa", "sarb ",
  "singapore", "mas ",
  "sweden", "riksbank",
  "norway", "norges bank",
  "denmark", "swiss national bank",
];

const MAJOR_KEYWORDS = [
  // Macro data
  "fed ", "federal reserve", "cpi", "inflation", "gdp", "nfp", "jobs report",
  "interest rate", "powell", "rate cut", "rate hike", "recession",
  "ism ", "pmi", "retail sales", "jobless claims", "unemployment",
  "fomc", "balance sheet", "quantitative", "yield curve", "treasury",
  // Crypto core
  "bitcoin", "btc", "ethereum", "eth", "crypto", "blockchain",
  "sec ", "etf", "stablecoin", "depeg", "defi", "protocol",
  // Crypto exchanges & projects
  "coinbase", "binance", "kraken", "okx", "bybit", "hyperliquid",
  "uniswap", "aave", "maker", "compound", "solana", "avalanche",
  "chainlink", "arbitrum", "optimism", "base ", "polygon",
  // Bad stuff
  "hack", "exploit", "drain", "stolen", "breach", "attack",
  "bank fail", "collapse", "bankrupt", "insolvency",
  "outage", "down ", "halted",
  // Regulatory
  "sanctions", "tariff", "trade war",
  "regulation", "congress", "senate", "legislation", "bill passed",
  "lawsuit", "charges", "indicted", "arrested", "fraud",
  "ban", "approved", "rejected", "ruling",
  // Mega cap earnings & major moves
  "nvidia", "nvda", "apple", "aapl", "tesla", "tsla",
  "microsoft", "msft", "google", "alphabet", "meta ", "amazon",
  "jpmorgan", "goldman", "blackrock", "fidelity",
  "earnings", "beats", "misses", "revenue", "guidance",
  // Big money
  "billion", "trillion", "raises $", "funding round",
  "series a", "series b", "series c", "acquisition", "merger", "ipo",
  // Geopolitical
  "breaking", "emergency", "crisis", "war", "geopolit",
  "nation", "country", "government", "central bank",
  // Corporate treasury / adoption
  "treasury", "reserve", "purchase", "buys bitcoin", "adds bitcoin",
  "tokeniz", "license", "policy"
];

// ─── RSS Feeds ─────────────────────────────────────────────────────────────
const FEEDS = [
  // Macro / TradFi
  { url: "https://feeds.marketwatch.com/marketwatch/marketpulse/", category: "MACRO" },
  { url: "https://feeds.marketwatch.com/marketwatch/topstories/", category: "MACRO" },
  { url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", category: "MACRO" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", category: "MACRO" },
  { url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", category: "MACRO" },
  { url: "https://finance.yahoo.com/news/rssindex", category: "MACRO" },
  // Crypto
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", category: "CRYPTO" },
  { url: "https://cointelegraph.com/rss", category: "CRYPTO" },
  { url: "https://www.theblock.co/rss.xml", category: "CRYPTO" },
  { url: "https://decrypt.co/feed", category: "CRYPTO" },
  { url: "https://news.bitcoin.com/feed/", category: "CRYPTO" },
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
  const cutoff = Date.now() - 4 * 60 * 60 * 1000; // last 4 hours (safe buffer for 2hr schedule)

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
   - Fed decisions, CPI/NFP/GDP/ISM/PMI/jobless claims prints
   - Interest rate moves, FOMC statements
   - Major exchange hacks or exploits ($10M+)
   - Big funding rounds ($100M+) for crypto or fintech
   - Regulatory actions: SEC, CFTC, government crypto bills, bans, approvals
   - Spot ETF approvals or rejections
   - Major protocol upgrades, policy changes or announcements (Hyperliquid, Uniswap, Aave etc)
   - Chain outages or major DeFi exploits
   - Bank failures or major financial institution collapses
   - Geopolitical events moving markets
   - Mega cap earnings beats/misses (Apple, Tesla, Nvidia, Microsoft, Google, Meta, Amazon)
   - Major Nvidia/NVDA news (new chip, earnings, export restrictions)
   - Stablecoin depegs
   - Nation-state Bitcoin adoption or bans
   - Major corporate treasury Bitcoin purchases
   - Major crypto exchange news (Coinbase, Binance, OKX, Bybit, Kraken)
   - BlackRock or Fidelity crypto moves

   NOT MAJOR (skip these):
   - Price predictions and opinions ("Saylor thinks BTC hits 80k")
   - Analyst ratings changes or price targets
   - Minor altcoin news
   - Opinion pieces or editorials
   - Rehashed old news
   - Minor company updates
   - Celebrity crypto takes
   - "Top stocks to watch" type content
   - Macro/inflation/central bank data from minor economies — ONLY cover:
     US (Fed), UK (Bank of England), Eurozone (ECB), China (PBOC), Japan (BOJ)
     Everything else (Australia, Canada, NZ, India, Brazil etc) = NOT MAJOR, score 3 or below

2. If score >= 7, write a tweet using ONE of these three exact formats:

   ── FORMAT A: BREAKING NEWS (score 9-10) ──
   Use when news is truly breaking and market-moving.
   🚨 must be first character. Blank line between [ BREAKING ] and the news.
   Example:
   "🚨 [ BREAKING ]\n\nFED CUTS RATES 50BPS. FIRST CUT IN 4 YEARS"

   ── FORMAT B: EARNINGS / MACRO DATA ──
   Use for earnings reports and macro data prints (CPI, NFP, GDP, retail sales etc).
   ONLY tweet when the ACTUAL DATA HAS BEEN RELEASED. Never tweet previews or anticipation.
   Title on first line, blank line, then structured data lines.
   STRICT RULES:
   - Always include exact numbers with estimates. NEVER say "BEAT" or "MISS" without numbers
   - Max 3 data lines
   - Each data line MUST be under 35 characters to avoid mobile wrapping
   - Keep labels short: CPI not HEADLINE CPI, REV not REVENUE
   - NO markdown links. NO brackets around tickers. Plain $TICKER only
   - NO dashes anywhere
   - US CPI exact format must be:
   "U.S CPI\n\nCPI: +X.X% YoY vs +X.X% EST\nCORE CPI: +X.X% YoY vs +X.X% EST"
   - US NFP exact format:
   "U.S JOBS REPORT\n\nNFP: +177K vs EST +133K\nUNEMPLOYMENT: 4.2% vs EST 4.3%"
   Example earnings:
   "ALPHABET $GOOGL EARNINGS\n\nEPS: $2.81 vs EST $2.01\nREV: $90.2B vs EST $89.1B\nCLOUD: $12.3B vs EST $12.2B"
   "APPLE $AAPL EARNINGS\n\nEPS: $1.65 vs EST $1.61\nREV: $95.4B vs EST $94.2B\nGUIDANCE: +14% vs EST +5%"
   Example macro:
   "U.S CPI\n\nCPI: +2.7% YoY vs +2.7% EST\nCORE CPI: +2.6% YoY vs +2.7% EST"
   "U.S JOBS REPORT\n\nNFP: +177K vs EST +133K\nUNEMPLOYMENT: 4.2% vs EST 4.3%"

   ── FORMAT C: STANDARD NEWS (score 7-8) ──
   No prefix. Just start the tweet directly. One or two lines MAX. Short and punchy. NO dashes.
   Example:
   "ICE INVESTS IN OKX AT $25B. MAJOR TRADFI SIGNAL"
   "BYBIT HACKED FOR $1.4B. LARGEST CRYPTO HACK IN HISTORY"

   EMOJI RULES:
   - For central bank rate decisions or policy changes, start with the relevant flag:
     🇺🇸 Fed, 🇬🇧 Bank of England, 🇪🇺 ECB, 🇨🇳 PBOC, 🇯🇵 BOJ
   - Score 9-10 breaking: 🚨 [ BREAKING ] then blank line then news
   - All other news: no emoji, no prefix, just start the tweet
   - NEVER use 📊 ⚡ * or any other emoji or prefix
   - Flag emoji examples:
     "🇺🇸 FED HOLDS RATES AT 5.25%. POWELL: NO CUT UNTIL INFLATION UNDER CONTROL"
     "🇬🇧 BANK OF ENGLAND CUTS RATES 25BPS TO 4.5%"
     "🇪🇺 ECB CUTS RATES 25BPS. LAGARDE: MORE CUTS LIKELY"

   GLOBAL RULES:
   - EVERYTHING IN CAPITALS
   - No hashtags. No source. No markdown. No links. No brackets
   - Only tweet when actual data has dropped. Never preview tweets
   - Each line max 35 chars to avoid mobile wrapping on data tweets

Examples of correct JSON output:
{"score": 10, "tweet": "🚨 [ BREAKING ]\n\nSEC APPROVES SPOT ETHEREUM ETFS. BLACKROCK AND FIDELITY GREENLIT"}
{"score": 9, "tweet": "🚨 [ BREAKING ]\n\nFED CUTS RATES 50BPS. FIRST CUT IN 4 YEARS"}
{"score": 8, "tweet": "U.S CPI\n\nCPI: +2.7% YoY vs +2.7% EST\nCORE CPI: +2.6% YoY vs +2.7% EST"}
{"score": 8, "tweet": "U.S JOBS REPORT\n\nNFP: +177K vs EST +133K\nUNEMPLOYMENT: 4.2% vs EST 4.3%"}
{"score": 8, "tweet": "APPLE $AAPL EARNINGS\n\nEPS: $1.65 vs EST $1.61\nREV: $95.4B vs EST $94.2B\nGUIDANCE: +14% vs EST +5%"}
{"score": 7, "tweet": "BYBIT HACKED FOR $1.4B. LARGEST CRYPTO HACK IN HISTORY"}
{"score": 7, "tweet": "COINBASE RAISES $500M. VALUATION HITS $12B"}

Respond ONLY in this exact JSON format on a single line, nothing else:
{"score": <number>, "tweet": "<tweet text or empty string if score < 7>"}`;
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].text.trim();
    // Strip markdown fences only, preserve newlines inside tweet content
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    parsed.tweet = String(parsed.tweet || "");
    return parsed;
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
