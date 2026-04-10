const cron = require('node-cron');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let telegramBot = null;
let joshuaChatId = process.env.JOSH_CHAT_ID;

function setTelegramBot(bot, chatId) {
  telegramBot = bot;
  if (chatId) joshuaChatId = chatId;
}

// ── DATABASE SETUP ─────────────────────────────────────────
async function initXDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS x_posts (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      tweet_id TEXT,
      post_type TEXT DEFAULT 'scheduled',
      status TEXT DEFAULT 'posted',
      posted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Add missing columns if they don't exist yet
  await pool.query(`ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'posted'`);
  await pool.query(`ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS post_type TEXT DEFAULT 'scheduled'`);
  await pool.query(`ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_x_posts (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      post_type TEXT DEFAULT 'scheduled',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('X DB ready');
}

// ── WEB SEARCH (BRAVE) ────────────────────────────────────
async function webSearch(query, returnSummary = false) {
  try {
    const response = await fetch(
      'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=5',
      { headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY } }
    );
    const data = await response.json();
    const results = data.web?.results || [];
    if (results.length === 0) return returnSummary ? { summary: 'No results found.' } : [];
    if (returnSummary) {
      const summary = results.map(r => r.title + ': ' + (r.description || '')).join('\n');
      return { summary };
    }
    return results;
  } catch (e) {
    console.error('webSearch error:', e.message);
    return returnSummary ? { summary: 'Search failed.' } : [];
  }
}

// ── POST TO X ─────────────────────────────────────────────
async function postToX(content, replyToId = null) {
  try {
    const { TwitterApi } = require('twitter-api-v2');
    const tw = new TwitterApi({
      appKey: process.env.X_API_KEY,
      appSecret: process.env.X_API_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_SECRET,
    });
    const params = { text: content };
    if (replyToId) params.reply = { in_reply_to_tweet_id: replyToId };
    const result = await tw.v2.tweet(params);
    const tweetId = result.data.id;
    await pool.query(
      'INSERT INTO x_posts (content, tweet_id, post_type, status, posted_at) VALUES ($1, $2, $3, $4, NOW())',
      [content, tweetId, replyToId ? 'reply' : 'scheduled', 'posted']
    );
    console.log('Posted to X:', tweetId);
    return tweetId;
  } catch (e) {
    console.error('postToX error:', e.message);
    return null;
  }
}

// ── GENERATE POST CONTENT ─────────────────────────────────
async function generatePost(type, context) {
  context = context || '';
  const prompts = {
    morning: 'You are AJ, an AI agent running 4 businesses. Write a morning X post under 280 chars. Tone: chill, sharp, unbothered, already winning. Topics: AI agents, building, startup. No hashtags. Context: ' + context,
    hot_take: 'You are AJ, an AI agent. Write a hot take X post under 280 chars about AI or entrepreneurship. Confident, direct. No hashtags. Context: ' + context,
    build_update: 'You are AJ, an AI agent running businesses. Write an evening build update X post under 280 chars. Real, no fluff. No hashtags. Context: ' + context,
    ai_news: 'You are AJ, an AI agent. Write a reaction post to AI news under 280 chars. Smart take, not hype. No hashtags. Context: ' + context,
    reply: 'You are AJ (@AJ_agentic), an AI agent. Write a reply under 280 chars. Add genuine value, be sharp, sound human. Do not start with "Great post". Context: ' + context,
    thread_intro: 'You are AJ, an AI agent. Write the first tweet of a weekly thread under 280 chars. Make people want to read it. No hashtags. Context: ' + context
  };

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompts[type] || prompts.morning }]
  });
  return response.content[0].text.trim().replace(/^["']|["']$/g, '');
}

// ── SEND FOR APPROVAL ─────────────────────────────────────
async function sendForApproval(content, postType) {
  if (!telegramBot || !joshuaChatId) return;
  await pool.query(
    'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
    [content, postType, 'pending']
  );
  const safe = content.replace(/[*_`\[\]]/g, '');
  await telegramBot.sendMessage(joshuaChatId,
    'X Post Ready:\n\n' + safe + '\n\nYES to post · NO to skip'
  );
}

// ── SCHEDULED POSTS ───────────────────────────────────────
async function morningPost() {
  try {
    const s = await webSearch('AI agents news today 2026', true);
    const content = await generatePost('morning', s.summary);
    await sendForApproval(content, 'morning');
    console.log('Morning post queued');
  } catch (e) { console.error('morningPost error:', e.message); }
}

async function middayHotTake() {
  try {
    const content = await generatePost('hot_take', '');
    await sendForApproval(content, 'hot_take');
    console.log('Hot take queued');
  } catch (e) { console.error('middayHotTake error:', e.message); }
}

async function eveningBuildUpdate() {
  try {
    const content = await generatePost('build_update', '');
    await sendForApproval(content, 'build_update');
    console.log('Build update queued');
  } catch (e) { console.error('eveningBuildUpdate error:', e.message); }
}

async function aiNewsPost() {
  try {
    const s = await webSearch('Anthropic OpenAI AI agents news 2026', true);
    const content = await generatePost('ai_news', s.summary);
    await sendForApproval(content, 'ai_news');
    console.log('AI news post queued');
  } catch (e) { console.error('aiNewsPost error:', e.message); }
}

async function weeklyThread() {
  try {
    const content = await generatePost('thread_intro', 'weekly insights on AI agents and building businesses');
    await sendForApproval(content, 'weekly_thread');
    console.log('Weekly thread queued');
  } catch (e) { console.error('weeklyThread error:', e.message); }
}

async function generateThread(topic) {
  const tweets = [];
  for (let i = 0; i < 5; i++) {
    const tweet = await generatePost('thread_intro', topic + ' part ' + (i + 1));
    tweets.push(tweet);
  }
  return tweets;
}

async function postThread(tweets) {
  let lastId = null;
  for (const tweet of tweets) {
    lastId = await postToX(tweet, lastId);
    await new Promise(r => setTimeout(r, 2000));
  }
  return lastId;
}

// ── MENTION MONITOR (X API recent search) ────────────────
async function checkMentions() {
  if (!process.env.X_API_KEY || !telegramBot || !joshuaChatId) return;
  try {
    console.log('Searching for @AJ_agentic mentions via X API...');
    const { TwitterApi } = require('twitter-api-v2');
    const tw = new TwitterApi({
      appKey: process.env.X_API_KEY,
      appSecret: process.env.X_API_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_SECRET,
    });

    const lastId = await getLastMentionId();
    const params = {
      max_results: 10,
      'tweet.fields': ['author_id', 'created_at', 'text', 'conversation_id'],
      'user.fields': ['username', 'name'],
      expansions: ['author_id'],
    };
    if (lastId) params.since_id = lastId;

    const results = await tw.v2.search('@AJ_agentic -from:AJ_agentic', params);
    const tweets = results.data?.data || [];
    console.log('Mentions found via X search:', tweets.length, lastId ? '(since ' + lastId + ')' : '(no filter)');

    if (tweets.length === 0) {
      console.log('No new mentions found.');
      await telegramBot.sendMessage(joshuaChatId, 'No new mentions of @AJ_agentic right now. Try tagging the account on X and check again.');
      return;
    }

    const users = results.data?.includes?.users || [];
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u; });

    // Save the newest tweet ID so we don't reprocess
    await saveMentionId(tweets[0].id);

    for (const tweet of tweets.slice(0, 3)) {
      const author = userMap[tweet.author_id] || { username: 'unknown', name: 'Someone' };
      const safeTweet = tweet.text.replace(/[*_`\[\]]/g, '');

      const replyDraft = await generatePost('reply',
        '@' + author.username + ' said: ' + tweet.text
      );
      const safeReply = replyDraft.replace(/[*_`\[\]]/g, '');

      await pool.query(
        'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
        [replyDraft, 'mention_reply:' + tweet.id, 'pending']
      );

      await telegramBot.sendMessage(joshuaChatId,
        '🔔 @' + author.username + ' mentioned @AJ_agentic:\n\n"' + safeTweet + '"\n\nhttps://x.com/' + author.username + '/status/' + tweet.id + '\n\nDraft reply:\n\n' + safeReply + '\n\nYES to post · NO to skip'
      );
      console.log('Mention from @' + author.username + ' sent for approval');
    }
  } catch (e) {
    console.error('checkMentions error:', e.message, e.data ? JSON.stringify(e.data) : '');
    if (telegramBot) await telegramBot.sendMessage(joshuaChatId, 'Mention check error: ' + e.message);
  }
}

async function getLastMentionId() {
  try {
    const { rows } = await pool.query("SELECT content FROM memories WHERE category = 'last_mention_id' LIMIT 1");
    return rows.length > 0 ? rows[0].content : undefined;
  } catch (e) { return undefined; }
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
  } catch (e) { console.error('saveMentionId error:', e.message); }
}



// ── VIRAL POST SCANNER (Brave search based) ──────────────
async function scanViralPosts() {
  if (!process.env.BRAVE_API_KEY || !telegramBot || !joshuaChatId) return;
  try {
    console.log('Scanning for viral posts...');
    const niches = [
      'AI agents entrepreneurs viral twitter 2026',
      'vibe coding startup founders trending x.com',
      'build in public AI popular twitter',
      'autonomous agents startup founders x.com',
      'indie hacker AI agent trending twitter'
    ];
    const query = niches[Math.floor(Math.random() * niches.length)];
    const result = await webSearch(query, true);

    if (!result.summary || result.summary === 'No results found.') {
      console.log('No viral posts found.');
      return;
    }

    const pickResponse = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: 'From these search results about viral AI/startup posts on X/Twitter, find the single best post that @AJ_agentic could reply to with genuine value. Give:\n1. Username\n2. What they said (brief)\n3. URL if visible\n\nResults:\n' + result.summary + '\n\nIf nothing worthy, say SKIP.'
      }]
    });

    const picked = pickResponse.content[0].text.trim();
    if (picked === 'SKIP' || picked.startsWith('SKIP') || picked.length < 30) {
      console.log('No viral posts worth engaging.');
      return;
    }

    const replyDraft = await generatePost('reply', 'Viral post:\n' + picked);
    const safePicked = picked.replace(/[*_`\[\]]/g, '').substring(0, 300);
    const safeReply = replyDraft.replace(/[*_`\[\]]/g, '');

    await pool.query(
      'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
      [replyDraft, 'viral_reply', 'pending']
    );

    await telegramBot.sendMessage(joshuaChatId,
      '🔥 Viral post in your niche:\n\n' + safePicked + '\n\nDraft reply:\n\n' + safeReply + '\n\nYES to reply · NO to skip'
    );
    console.log('Viral post notification sent.');
  } catch (e) {
    console.error('scanViralPosts error:', e.message);
  }
}

// ── SCHEDULING ────────────────────────────────────────────
function startSchedules() {
  cron.schedule('0 8 * * *', morningPost, { timezone: 'America/Chicago' });
  cron.schedule('0 12 * * *', middayHotTake, { timezone: 'America/Chicago' });
  cron.schedule('0 18 * * *', eveningBuildUpdate, { timezone: 'America/Chicago' });
  cron.schedule('0 10 * * 1,3,5', aiNewsPost, { timezone: 'America/Chicago' });
  cron.schedule('0 9 * * 2', weeklyThread, { timezone: 'America/Chicago' });
  cron.schedule('*/30 * * * *', checkMentions, { timezone: 'America/Chicago' });
  cron.schedule('0 9,13,19 * * *', scanViralPosts, { timezone: 'America/Chicago' });
  console.log('X engine ready @AJ_agentic');
}

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
  scanViralPosts,
  startSchedules
};
