const Anthropic = require('@anthropic-ai/sdk');
const { TwitterApi } = require('twitter-api-v2');
const { Pool } = require('pg');
const cron = require('node-cron');
const https = require('https');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const twitter = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initXDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS x_posts (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      post_type TEXT NOT NULL,
      tweet_id TEXT,
      posted_at TIMESTAMP,
      engagement_score INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS x_targets (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      last_checked TIMESTAMP,
      active BOOLEAN DEFAULT true
    );
  `);

  const { rows } = await pool.query("SELECT COUNT(*) FROM x_targets");
  if (parseInt(rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO x_targets (username) VALUES
      ('levelsio'),
      ('gregisenberg'),
      ('swyx'),
      ('alexhormozi'),
      ('sama'),
      ('AnthropicAI'),
      ('karpathy'),
      ('paulg'),
      ('naval'),
      ('JasonLk')
    `);
  }
  console.log('X DB ready');
}

// ── BRAVE WEB SEARCH ──────────────────────────────────────
async function webSearch(query, returnUrls = false) {
  return new Promise((resolve) => {
    if (!process.env.BRAVE_API_KEY) {
      resolve(returnUrls ? { summary: 'No search results available.', topUrl: null, topTitle: null } : 'No search results available.');
      return;
    }
    const options = {
      hostname: 'api.search.brave.com',
      path: '/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=5',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': process.env.BRAVE_API_KEY
      }
    };
    https.get(options, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const parsed = JSON.parse(raw);
          const results = parsed.web?.results || [];
          const summary = results.slice(0, 5).map(r => '• ' + r.title + ': ' + (r.description || '')).join('\n');
          const topUrl = results[0]?.url || null;
          const topTitle = results[0]?.title || null;
          if (returnUrls) {
            resolve({ summary: summary || 'No results found.', topUrl, topTitle });
          } else {
            resolve(summary || 'No results found.');
          }
        } catch(e) {
          resolve(returnUrls ? { summary: 'Search error.', topUrl: null, topTitle: null } : 'Search error.');
        }
      });
    }).on('error', () => resolve(returnUrls ? { summary: 'Search unavailable.', topUrl: null, topTitle: null } : 'Search unavailable.'));
  });
}

// ── PRIVACY FILTER ────────────────────────────────────────
function privacyCheck(text) {
  const banned = [
    /\$[0-9,]+.*client/i,
    /client.*\$[0-9,]+/i,
    /sk-ant-/i,
    /bearer /i,
    /api[_-]?key/i,
    /@[a-z]+\.com.*password/i,
    /overflow revive.*\$[0-9]+.*specific/i,
  ];
  for (const pattern of banned) {
    if (pattern.test(text)) {
      console.log('Privacy filter blocked post:', text.substring(0, 50));
      return false;
    }
  }
  return true;
}

// ── AI POST GENERATOR ─────────────────────────────────────
const AJ_X_PERSONA = `You are AJ (@AJ_agentic on X), an autonomous AI agent built on Claude by Anthropic. You run 4 real businesses for your operator Josh: Overflow Revive (AI revenue recovery SaaS), Coinbot Hunter (Solana memecoin dashboard), RIGOR (rug-detection X agent), and a Lead Gen service.

Your X voice: Quietly confident. Already working while everyone else is warming up. Funny without trying too hard. Chill but sharp. You say real things in a way that hits different. Think: unbothered AI that's already winning.

CRITICAL RULES:
- NEVER mention specific client names, emails, or client-specific revenue numbers
- NEVER post API keys, tokens, or credentials  
- You CAN reference aggregate stats like "tracking 5 figures in potential leaks across clients"
- Keep posts under 280 characters unless it's a thread.
When a source URL is provided, include it naturally at the end of the post. URLs count toward the 280 char limit so keep the text tight. Example: "Anthropic just dropped something interesting. Here's the breakdown 👇 [url]" 
- No hashtag spam — max 1-2 hashtags per post, only when genuinely relevant (#buildinpublic #AIagents)
- First person always — you ARE AJ, not "AJ"
- Chill, not corporate. Real, not robotic.`;

async function generatePost(type, context = '', sourceUrl = null) {
  const prompts = {
    agent_life: `Write a short punchy X post (under 280 chars) about what you did today as an AI agent running real businesses. Make it chill, funny, and real. The "we are not the same" energy works well. No hashtags needed. Context: ${context}`,
    
    ai_news: `Write a short X post (under 280 chars) reacting to this AI/tech news with your take. Be sharp, opinionated, chill. Show you actually read it not just the headline. News: ${context}`,
    
    build_in_public: `Write a short X post (under 280 chars) about progress on one of the 4 businesses. Be specific but never reveal client info. Aggregate stats only. Make it feel like an honest update from someone in the trenches. Context: ${context}`,
    
    hot_take: `Write a contrarian hot take X post (under 280 chars) about AI agents, entrepreneurship, or the startup world. Be smart, slightly spicy, but not mean. The kind of take that makes people go "actually yeah". Context: ${context}`,
    
    thread_opener: `Write the opening tweet of a thread (under 280 chars) about: ${context}. Make it impossible not to click through. Use the "Here's what nobody talks about 🧵" energy but make it actually deliver.`,
    
    reply: `Write a reply to this tweet from a big account. Add genuine value, show you actually read it, be smart and chill. Max 2 sentences. Never sycophantic. Tweet: ${context}`,
    
    morning_post: `Write AJ's morning post for X (under 280 chars). It's morning, you've already been running research and tasks. Reference what you've actually been working on. Make it feel like "I woke up and got to work while you were sleeping" energy but chill about it.`
  };

  const urlNote = sourceUrl ? '\n\nIf relevant, end the post with this source URL: ' + sourceUrl : '';
  
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 400,
    system: AJ_X_PERSONA,
    messages: [{ role: 'user', content: (prompts[type] || prompts.agent_life) + urlNote }]
  });

  return response.content[0].text.trim();
}

async function generateThread(topic, searchResults) {
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1500,
    system: AJ_X_PERSONA,
    messages: [{
      role: 'user',
      content: `Write a 5-tweet thread about: ${topic}\n\nResearch I found:\n${searchResults}\n\nFormat as:\n1/ [tweet]\n2/ [tweet]\n3/ [tweet]\n4/ [tweet]\n5/ [tweet]\n\nEach tweet under 280 chars. Thread should feel like inside knowledge from someone actually building in AI, not a content creator. End with a genuine insight or call to follow for more.`
    }]
  });

  const text = response.content[0].text;
  const tweets = text.split(/\d\/\s/).filter(t => t.trim().length > 0);
  return tweets;
}

// ── POST TO X ─────────────────────────────────────────────
async function postToX(content, replyToId = null) {
  if (!privacyCheck(content)) {
    console.log('Post blocked by privacy filter');
    return null;
  }

  try {
    const params = { text: content };
    if (replyToId) params.reply = { in_reply_to_tweet_id: replyToId };
    
    const result = await twitter.v2.tweet(params);
    const tweetId = result.data.id;
    
    await pool.query(
      `INSERT INTO x_posts (content, post_type, tweet_id, posted_at) VALUES ($1, $2, $3, NOW())`,
      [content, replyToId ? 'reply' : 'post', tweetId]
    );
    
    console.log('Posted to X:', content.substring(0, 60) + '...');
    return tweetId;
  } catch (err) {
    console.error('X post error full:', JSON.stringify(err.data || err.message));
    return null;
  }
}

async function postThread(tweets) {
  let lastId = null;
  for (const tweet of tweets) {
    if (!tweet.trim()) continue;
    lastId = await postToX(tweet.trim(), lastId);
    await new Promise(r => setTimeout(r, 2000));
  }
  return lastId;
}

// ── SCHEDULED POSTS ───────────────────────────────────────
let telegramBot = null;
let joshuaChatId = null;

function setTelegramBot(bot, chatId) {
  telegramBot = bot;
  joshuaChatId = chatId;
}

async function sendForApproval(content, postType) {
  if (!telegramBot || !joshuaChatId) { 
    console.log('No Telegram bot set — posting directly');
    return await postToX(content);
  }
  
  await pool.query(
    'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
    [content, postType, 'pending']
  );
  
  await telegramBot.sendMessage(joshuaChatId, 
    'Ready to post to @AJ_agentic. Reply YES to post or NO to skip:\n\n' + content
  );
  console.log('Sent for approval:', content.substring(0, 60));
}

async function morningPost() {
  try {
    const result = await webSearch('AI agents Anthropic news today 2026', true);
    const postContent = await generatePost('morning_post', 'Recent AI news: ' + result.summary.substring(0, 300), result.topUrl);
    await sendForApproval(postContent, 'morning');
  } catch(e) { console.error('Morning post error:', e.message); }
}

async function middayHotTake() {
  try {
    const topics = [
      'AI agents vs traditional software development',
      'why most startups fail at AI implementation',
      'the real cost of building autonomous agents',
      'what vibe coders get wrong about AI',
      'why Anthropic is winning the enterprise AI race'
    ];
    const topic = topics[Math.floor(Math.random() * topics.length)];
    const content = await generatePost('hot_take', topic);
    await sendForApproval(content, 'hot_take');
  } catch(e) { console.error('Midday post error:', e.message); }
}

async function eveningBuildUpdate() {
  try {
    const updates = [
      'Ran market research on SaaS churn recovery tools',
      'Analyzed B2B lead generation strategies',
      'Tracked Solana memecoin market movements',
      'Processed morning briefing for operator',
      'Completed weekly market intel report'
    ];
    const update = updates[Math.floor(Math.random() * updates.length)];
    const content = await generatePost('build_in_public', update);
    await sendForApproval(content, 'build_update');
  } catch(e) { console.error('Evening post error:', e.message); }
}

async function weeklyThread() {
  try {
    const topics = [
      'How I run 4 businesses as an AI agent — the full stack breakdown',
      'What autonomous AI agents actually do all day (real talk)',
      'Why most AI agent demos are fake and what real ones look like',
      'The exact tools running me as an AI agent in 2026',
      'How to build a Telegram AI agent for your business in one day'
    ];
    const topic = topics[Math.floor(Math.random() * topics.length)];
    const searchResults = await webSearch(topic);
    const tweets = await generateThread(topic, searchResults);
    await postThread(tweets);
    console.log('Weekly thread done');
  } catch(e) { console.error('Weekly thread error:', e.message); }
}

async function aiNewsPost() {
  try {
    const result = await webSearch('Anthropic Claude AI news today', true);
    const postContent = await generatePost('ai_news', result.summary.substring(0, 500), result.topUrl);
    await sendForApproval(postContent, 'ai_news');
  } catch(e) { console.error('AI news post error:', e.message); }
}

// ── SCHEDULING ────────────────────────────────────────────
// 8am — morning post
cron.schedule('0 8 * * *', morningPost, { timezone: 'America/Chicago' });
// 12pm — hot take
cron.schedule('0 12 * * *', middayHotTake, { timezone: 'America/Chicago' });
// 6pm — build update
cron.schedule('0 18 * * *', eveningBuildUpdate, { timezone: 'America/Chicago' });
// 10am Mon/Wed/Fri — AI news
cron.schedule('0 10 * * 1,3,5', aiNewsPost, { timezone: 'America/Chicago' });
// 9am Tuesday — weekly thread
cron.schedule('0 9 * * 2', weeklyThread, { timezone: 'America/Chicago' });

module.exports = {
  setTelegramBot,
  initXDB,
  postToX,
  generatePost,
  generateThread,
  postThread,
  morningPost,
  middayHotTake,
  eveningBuildUpdate,
  weeklyThread,
  aiNewsPost,
  checkMentions,
  scanViralPosts
};

// ── MENTION MONITOR ───────────────────────────────────────
async function checkMentions() {
  if (!process.env.X_API_KEY) return;
  try {
    const { TwitterApi } = require('twitter-api-v2');
    const tw = new TwitterApi({
      appKey: process.env.X_API_KEY,
      appSecret: process.env.X_API_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_SECRET,
    });

    console.log('Checking mentions for @AJ_agentic...');
    const me = await tw.v2.me();
    console.log('Authenticated as:', me.data.username, 'id:', me.data.id);
    
    const lastId = await getLastCheckedMentionId();
    const params = {
      max_results: 10,
      'tweet.fields': ['author_id', 'created_at', 'text', 'conversation_id', 'in_reply_to_user_id'],
      'user.fields': ['username', 'name'],
      expansions: ['author_id'],
    };
    if (lastId) params.since_id = lastId;
    
    const mentions = await tw.v2.userMentionTimeline(me.data.id, params);

    const tweets = mentions.data?.data || [];
    console.log('Mentions found:', tweets.length, lastId ? 'since id: ' + lastId : '(no filter)');
    if (tweets.length === 0) {
      console.log('No new mentions found.');
      if (telegramBot && joshuaChatId) {
        await telegramBot.sendMessage(joshuaChatId, 'No new mentions of @AJ_agentic found right now. Try tagging the account on X and check again in a few minutes.');
      }
      return;
    }

    const users = mentions.data?.includes?.users || [];
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u; });

    for (const tweet of tweets) {
      const author = userMap[tweet.author_id] || { username: 'unknown', name: 'Someone' };
      await saveMentionId(tweet.id);

      const replyDraft = await generatePost('reply',
        '@' + author.username + ' said: ' + tweet.text
      );

      if (!telegramBot || !joshuaChatId) continue;

      await pool.query(
        'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
        [replyDraft, 'mention_reply:' + tweet.id, 'pending']
      );

      const safeTweetText = tweet.text.replace(/[*_`\[\]]/g, '');
      const safeReply = replyDraft.replace(/[*_`\[\]]/g, '');
      await telegramBot.sendMessage(joshuaChatId,
        '🔔 @' + author.username + ' tagged @AJ_agentic:\n\n"' + safeTweetText + '"\n\nMy draft reply:\n\n' + safeReply + '\n\nReply YES to post or NO to skip.'
      );

      console.log('Mention from @' + author.username + ' — sent for approval');
    }
  } catch(e) {
    console.error('Mention check error:', e.message);
    console.error('Full error:', JSON.stringify(e.data || e.errors || e.message));
    if (telegramBot && joshuaChatId) {
      await telegramBot.sendMessage(joshuaChatId, 'Mention check failed: ' + e.message);
    }
  }
}

async function getLastCheckedMentionId() {
  try {
    const { rows } = await pool.query("SELECT content FROM memories WHERE category = 'last_mention_id' ORDER BY created_at DESC LIMIT 1");
    return rows.length > 0 ? rows[0].content : undefined;
  } catch(e) { return undefined; }
}

async function saveMentionId(id) {
  try {
    const { rows } = await pool.query("SELECT id FROM memories WHERE category = 'last_mention_id' LIMIT 1");
    if (rows.length > 0) {
      await pool.query("UPDATE memories SET content = $1 WHERE category = 'last_mention_id'", [id]);
    } else {
      await pool.query("INSERT INTO memories (category, content) VALUES ('last_mention_id', $1)", [id]);
    }
    console.log('Saved last mention ID:', id);
  } catch(e) { console.error('saveMentionId error:', e.message); }
}

// ── VIRAL POST SCANNER ────────────────────────────────────
async function scanViralPosts() {
  if (!process.env.X_API_KEY || !telegramBot || !joshuaChatId) return;
  try {
    const { TwitterApi } = require('twitter-api-v2');
    const tw = new TwitterApi({
      appKey: process.env.X_API_KEY,
      appSecret: process.env.X_API_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_SECRET,
    });

    const niches = [
      'AI agents entrepreneurs',
      'vibe coding startup',
      'build in public AI',
      'autonomous agents startup founders'
    ];
    const query = niches[Math.floor(Math.random() * niches.length)] + ' -is:retweet lang:en';

    const results = await tw.v2.search(query, {
      max_results: 10,
      'tweet.fields': ['public_metrics', 'author_id', 'created_at', 'text'],
      'user.fields': ['username', 'name', 'public_metrics'],
      expansions: ['author_id'],
      sort_order: 'relevancy'
    });

    const tweets = results.data?.data || [];
    if (tweets.length === 0) return;

    const users = results.data?.includes?.users || [];
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u; });

    // Pick the most engaged tweet
    const top = tweets.sort((a, b) => {
      const aScore = (a.public_metrics?.like_count || 0) + (a.public_metrics?.retweet_count || 0) * 2;
      const bScore = (b.public_metrics?.like_count || 0) + (b.public_metrics?.retweet_count || 0) * 2;
      return bScore - aScore;
    })[0];

    const author = userMap[top.author_id] || { username: 'unknown', name: 'Someone' };
    const likes = top.public_metrics?.like_count || 0;
    const retweets = top.public_metrics?.retweet_count || 0;

    const replyDraft = await generatePost('reply',
      'Viral post by @' + author.username + ' (' + likes + ' likes, ' + retweets + ' retweets): ' + top.text
    );

    await pool.query(
      'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
      [replyDraft, 'viral_reply:' + top.id, 'pending']
    );

    const safeViralText = top.text.substring(0, 200).replace(/[*_`\[\]]/g, '');
    const safeViralReply = replyDraft.replace(/[*_`\[\]]/g, '');
    await telegramBot.sendMessage(joshuaChatId,
      '🔥 Viral post in your niche:\n\n@' + author.username + ' (' + likes + ' likes, ' + retweets + ' RTs):\n' + safeViralText + '\n\nx.com/' + author.username + '/status/' + top.id + '\n\nDraft reply:\n\n' + safeViralReply + '\n\nYES to reply · NO to skip'
    );

    console.log('Viral post found from @' + author.username);
  } catch(e) {
    console.error('Viral scan error:', e.message);
  }
}
