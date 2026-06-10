const { TwitterApi } = require("twitter-api-v2");

const twitter = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const KEEP_TWEETS = ["2031466128669618310"];

async function deleteAllTweets() {
  console.log("🗑️  Starting tweet deletion...");
  let deleted = 0;
  let errors = 0;

  try {
    const me = await twitter.v2.me();
    const userId = me.data.id;
    console.log(`👤 User ID: ${userId}`);

    let paginationToken;

    do {
      const params = { max_results: 100, "tweet.fields": ["id"] };
      if (paginationToken) params.pagination_token = paginationToken;

      const timeline = await twitter.v2.userTimeline(userId, params);
      const tweets = timeline.data?.data || [];

      if (tweets.length === 0) {
        console.log("✅ No more tweets found.");
        break;
      }

      console.log(`📋 Found ${tweets.length} tweets — deleting...`);

      for (const tweet of tweets) {
        try {
          if (KEEP_TWEETS.includes(tweet.id)) {
            console.log(`📌 Skipping pinned tweet ${tweet.id}`);
            continue;
          }
          await twitter.v2.deleteTweet(tweet.id);
          deleted++;
          console.log(`🗑️  Deleted tweet ${tweet.id} (${deleted} total)`);
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          errors++;
          console.log(`❌ Failed to delete ${tweet.id}: ${e.message}`);
        }
      }

      paginationToken = timeline.data?.meta?.next_token;

    } while (paginationToken);

  } catch (e) {
    console.error("💥 Fatal error:", e.message);
  }

  console.log(`\n✅ Done. Deleted ${deleted} tweets. Errors: ${errors}`);
}

deleteAllTweets();
