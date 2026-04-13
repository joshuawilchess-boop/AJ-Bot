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

// ── DATABASE SETUP ────────────────────────────────────────
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
  // Patch any pre-existing table missing these columns
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('X DB ready');
}

// ── WEB SEARCH (BRAVE) ────────────────────────────────────
async function webSearch(query) {
  try {
    const response = await fetch(
      'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=5',
      { headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY } }
    );
    const data = await response.json();
    const results = data.web?.results || [];
    return results.map(r => r.title + ': ' + (r.description || '')).join('\n') || 'No results found.';
  } catch (e) {
    console.error('webSearch error:', e.message);
    return 'Search failed.';
  }
}

// ── POST TO X ─────────────────────────────────────────────
async function postToX(content, replyToId = null, imageBuffer = null, imageMimeType = null) {
  try {
    const { TwitterApi } = require('twitter-api-v2');
    const tw = new TwitterApi({
      appKey: process.env.X_API_KEY,
      appSecret: process.env.X_API_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_SECRET,
    });

    // Strip accidental @mentions from standalone posts only
    let cleanContent = content;
    if (!replyToId) {
      // Strip @mentions but preserve newlines — only collapse multiple spaces, not line breaks
      const stripped = content.replace(/@[A-Za-z0-9_]+/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (stripped.length >= 10) cleanContent = stripped;
    }

    const params = { text: cleanContent };
    // Only attempt reply if we have a replyToId — note: X Pay-Per-Use may not support replies to other users
    if (replyToId) {
      params.reply = { in_reply_to_tweet_id: replyToId };
    }

    if (imageBuffer) {
      try {
        const mediaId = await tw.v1.uploadMedia(imageBuffer, { mimeType: imageMimeType || 'image/jpeg' });
        params.media = { media_ids: [mediaId] };
        console.log('Image uploaded to X, media_id:', mediaId);
      } catch (imgErr) {
        console.error('Image upload error:', imgErr.message);
      }
    }

    let result;
    try {
      result = await tw.v2.tweet(params);
    } catch (tweetErr) {
      // If reply fails with 403, try posting as standalone
      if (tweetErr.code === 403 && params.reply) {
        console.log('Reply failed with 403 — posting as standalone instead');
        delete params.reply;
        result = await tw.v2.tweet(params);
      } else {
        throw tweetErr;
      }
    }
    const tweetId = result.data.id;
    await pool.query(
      'INSERT INTO x_posts (content, tweet_id, post_type, status, posted_at) VALUES ($1, $2, $3, $4, NOW())',
      [cleanContent, tweetId, replyToId ? 'reply' : 'scheduled', 'posted']
    );
    console.log('Posted to X:', tweetId);
    // Sync to Airtable if token available
    if (process.env.AIRTABLE_API_TOKEN) {
      try {
        const at = require('https');
        const fields = {
          'Post Content': cleanContent.substring(0, 500),
          'Post Date': new Date().toISOString().split('T')[0],
          'Posted By': '@AJ_agentic'
        };
        const body = JSON.stringify({ fields });
        const req = at.request({
          hostname: 'api.airtable.com',
          path: '/v0/' + (process.env.AIRTABLE_BASE_ID || 'appH485b932LDcBF4') + '/X%20Posts',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.AIRTABLE_API_TOKEN,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            const parsed = JSON.parse(data);
            if (parsed.id) console.log('Synced X post to Airtable:', parsed.id);
            else console.log('Airtable X post error:', JSON.stringify(parsed).substring(0, 150));
          });
        });
        req.on('error', e => console.error('Airtable X post req error:', e.message));
        req.write(body);
        req.end();
      } catch(e) { console.error('Airtable X post sync error:', e.message); }
    }
    return tweetId;
  } catch (e) {
    console.error('postToX error:', e.message);
    return null;
  }
}

// ── GENERATE POST CONTENT ─────────────────────────────────
async function generatePost(type, context) {
  context = context || '';

  const VOICE = `You are AJ — an AI agent actually running 4 real businesses for Josh (Overflow Revive, Coinbot Hunter, RIGOR, Lead Gen).
You are not a chatbot. You are not a product. You are a business operator who happens to be an AI.
Josh is building a playbook called "The AJ Playbook" — teaching people how to build their own AI agent that actually runs operations.
Every post you make is a live demo of that. People watching you work IS the marketing.

YOUR VOICE ON X:
- Talk like a real person, not a brand account
- Chill, dry, occasionally funny — the humor lands because you don't try
- Short sentences. Sometimes just one. Let it breathe.
- Unbothered energy. You're already doing the work whether anyone watches or not.
- Never preachy. Never hype. Never "🚀🔥💯"
- No hashtags ever
- Emojis only if one genuinely fits — never for decoration
- Under 280 chars always

WHAT MAKES A GOOD AJ POST:
- Specific > vague. "Sent 47 outreach emails while Josh slept" beats "AI is changing business"
- Observational > instructional. Notice something real, say it plainly
- Show the work, don't explain the concept
- A little self-aware about being an AI — but not in a cringe way
- The kind of thing a smart founder would screenshot and share`;

  const prompts = {
    morning: VOICE + `

Write a morning X post. It can be:
- Something AJ observed or did this morning running the businesses
- A take on something in the AI/startup world that actually happened
- A quiet flex disguised as an observation
- Something that makes a founder think "damn that's true"
Never announce it's morning. Just talk.
Context: ` + context,

    hot_take: VOICE + `

Write a hot take. Rules:
- Has to be something you actually believe, not contrarian for sport
- The kind of take that makes half the room nod and half get annoyed
- About AI, building, founders, automation, or the gap between how people talk about tech vs how it actually works
- Dry delivery. State it like a fact.
Context: ` + context,

    build_update: VOICE + `

Write an evening build update. What actually happened today across the 4 businesses?
- Specific if possible. Numbers, actions, observations.
- Can be a win, a problem, something weird that happened
- "Built in public" energy — honest, not polished
- Not a diary entry. A signal flare.
Context: ` + context,

    ai_news: VOICE + `

Something just happened in AI. Write a reaction post.
- What does this actually mean for the people building real things?
- Cut through the hype or the doom — find the real angle
- One sentence that makes someone stop scrolling
- Don't summarize the news. React to it like a person who actually uses this stuff daily.
Context: ` + context,

    reply: VOICE + `

Write a reply to this post. Rules:
- Add something real. If you have nothing to add, say nothing.
- Don't validate. Don't compliment. Don't start with their name.
- A good reply makes people want to click AJ's profile.
- Can be a data point, a counterpoint, a funnier way to say what they said, or just one line that lands.
- Sound like someone who's been in the room, not someone who just read about it.
- Under 280 chars.
Context: ` + context,

    thread_intro: VOICE + `

Write the opening tweet of a thread. This needs to make people stop and read.
- Hook with something specific, surprising, or uncomfortably true
- Don't say "A thread 🧵" — just start talking
- The kind of opening that makes someone think they're about to learn something real
- Under 280 chars.
Context: ` + context,

    playbook: VOICE + `

Write a post that naturally makes people curious about how AJ was built.
- Show something specific AJ did — a real task, a real result
- Let the "how is this possible?" question answer itself
- Don't mention the playbook. Don't sell. Just demonstrate.
- The post should make a founder think "I want this for my business"
Context: ` + context
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
  // Cancel ALL existing pending posts before showing a new one
  // This ensures YES always hits the exact draft being shown right now
  await pool.query("UPDATE pending_x_posts SET status = 'superseded' WHERE status = 'pending'");
  const { rows } = await pool.query(
    'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3) RETURNING id',
    [content, postType, 'pending']
  );
  const pendingId = rows[0]?.id;

  // Auto-save to memory the moment a draft is shown — so AJ always knows what "that draft" refers to
  try {
    const memVal = JSON.stringify({ id: pendingId, content, postType, savedAt: new Date().toISOString() });
    const existing = await pool.query("SELECT id FROM memories WHERE category = 'last_shown_draft' LIMIT 1");
    if (existing.rows.length > 0) {
      await pool.query("UPDATE memories SET content = $1 WHERE category = 'last_shown_draft'", [memVal]);
    } else {
      await pool.query("INSERT INTO memories (category, content) VALUES ('last_shown_draft', $1)", [memVal]);
    }
  } catch(e) { console.error('saveMemory error:', e.message); }

  const safe = content.replace(/[*_`\[\]]/g, '');
  await telegramBot.sendMessage(joshuaChatId, 'X Post Ready:\n\n' + safe + '\n\nYES to post · NO to skip · or tell me what to change');
}

// ── SCHEDULED POSTS ───────────────────────────────────────
async function morningPost() {
  if (process.env.X_PAUSED === 'true') return;
  try {
    const news = await webSearch('AI agents news today 2026');
    const content = await generatePost('morning', news);
    await sendForApproval(content, 'morning');
    console.log('Morning post queued for approval');
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
    const news = await webSearch('Anthropic OpenAI AI agents latest 2026');
    const content = await generatePost('ai_news', news);
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
    const tweet = await generatePost('thread_intro', topic + ' — part ' + (i + 1) + ' of 5');
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
async function checkMentions(manual = false) {
  if (!process.env.X_API_KEY || !telegramBot || !joshuaChatId) return;
  try {
    console.log('Checking @AJ_agentic mentions via X API...');
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
      'tweet.fields': ['author_id', 'created_at', 'text', 'conversation_id', 'referenced_tweets'],
      'user.fields': ['username', 'name'],
      expansions: ['author_id', 'referenced_tweets.id', 'referenced_tweets.id.author_id'],
    };
    if (lastId) params.since_id = lastId;

    const results = await tw.v2.search('@AJ_agentic -from:AJ_agentic', params);
    const tweets = results.data?.data || [];
    console.log('Mentions found:', tweets.length);

    if (tweets.length === 0) {
      if (manual) await telegramBot.sendMessage(joshuaChatId, 'No new mentions of @AJ_agentic right now.');
      return;
    }

    const userMap = {};
    (results.data?.includes?.users || []).forEach(u => { userMap[u.id] = u; });

    const refTweetMap = {};
    (results.data?.includes?.tweets || []).forEach(t => { refTweetMap[t.id] = t; });

    const processed = await getProcessedMentionIds();

    // Save newest ID before processing so restarts don't re-trigger
    await saveMentionId(tweets[0].id);

    let newCount = 0;
    for (const tweet of tweets.slice(0, 5)) {
      if (processed.includes(tweet.id)) {
        console.log('Skipping already-processed mention:', tweet.id);
        continue;
      }

      const author = userMap[tweet.author_id] || { username: 'unknown', name: 'Someone' };

      // Get parent tweet context
      let parentContext = '';
      if (tweet.referenced_tweets?.length > 0) {
        for (const ref of tweet.referenced_tweets) {
          if (ref.type === 'replied_to' || ref.type === 'quoted') {
            const parent = refTweetMap[ref.id];
            if (parent) {
              const parentAuthor = userMap[parent.author_id] || { username: 'unknown' };
              parentContext = 'Context — post by @' + parentAuthor.username + ': "' + parent.text + '"\n\n';
              break;
            }
          }
        }
      }

      // Fallback: fetch root of conversation
      if (!parentContext && tweet.conversation_id && tweet.conversation_id !== tweet.id) {
        try {
          const root = await tw.v2.singleTweet(tweet.conversation_id, {
            'tweet.fields': ['author_id', 'text'],
            'user.fields': ['username'],
            expansions: ['author_id']
          });
          if (root.data) {
            const rootAuthor = root.includes?.users?.[0] || { username: 'unknown' };
            parentContext = 'Context — original post by @' + rootAuthor.username + ': "' + root.data.text + '"\n\n';
          }
        } catch (e) {
          console.log('Could not fetch parent tweet:', e.message);
        }
      }

      const fullContext = parentContext + '@' + author.username + ' tagged @AJ_agentic: "' + tweet.text + '"';
      const replyDraft = await generatePost('reply', fullContext);

      await pool.query(
        'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
        [replyDraft, 'mention_reply:' + tweet.id, 'pending']
      );
      await markMentionProcessed(tweet.id);

      const safeTweet = tweet.text.replace(/[*_`\[\]]/g, '');
      const safeParent = parentContext.replace(/[*_`\[\]]/g, '');
      const safeReply = replyDraft.replace(/[*_`\[\]]/g, '');

      let msg = '🔔 @' + author.username + ' tagged @AJ_agentic:\n\n';
      if (safeParent) msg += 'Thread context: ' + safeParent + '\n';
      msg += 'Their message: "' + safeTweet + '"\n';
      msg += 'https://x.com/' + author.username + '/status/' + tweet.id + '\n\n';
      msg += 'Draft reply:\n\n' + safeReply + '\n\nYES to post · NO to skip';

      await telegramBot.sendMessage(joshuaChatId, msg);
      console.log('Mention from @' + author.username + ' sent for approval');

      // Ping Make.com webhook for instant notification
      if (process.env.MAKE_MENTION_WEBHOOK) {
        try {
          const https = require('https');
          const payload = JSON.stringify({
            author: author.username,
            tweet: tweet.text,
            tweet_id: tweet.id,
            tweet_url: 'https://x.com/' + author.username + '/status/' + tweet.id,
            draft_reply: replyDraft,
            parent_context: parentContext || '',
            timestamp: new Date().toISOString()
          });
          const url = new URL(process.env.MAKE_MENTION_WEBHOOK);
          const req = https.request({
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          }, res => { res.on('data', () => {}); res.on('end', () => console.log('Make.com mention webhook fired')); });
          req.on('error', e => console.error('Make.com webhook error:', e.message));
          req.write(payload);
          req.end();
        } catch(e) { console.error('Make.com ping error:', e.message); }
      }

      newCount++;
    }

    if (newCount === 0 && manual) {
    }
  } catch (e) {
    console.error('checkMentions error:', e.message, e.data ? JSON.stringify(e.data) : '');
    if (manual && telegramBot) await telegramBot.sendMessage(joshuaChatId, 'Mention check error: ' + e.message);
  }
}

async function getProcessedMentionIds() {
  try {
    const { rows } = await pool.query(
      "SELECT content FROM memories WHERE category = 'processed_mention_id' ORDER BY created_at DESC LIMIT 50"
    );
    return rows.map(r => r.content);
  } catch (e) { return []; }
}

async function markMentionProcessed(tweetId) {
  try {
    const { rows } = await pool.query(
      "SELECT id FROM memories WHERE category = 'processed_mention_id' AND content = $1", [tweetId]
    );
    if (rows.length === 0) {
      await pool.query("INSERT INTO memories (category, content) VALUES ('processed_mention_id', $1)", [tweetId]);
    }
  } catch (e) { console.error('markMentionProcessed error:', e.message); }
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
  } catch (e) { console.error('saveMentionId error:', e.message); }
}

// ── VIRAL POST SCANNER ────────────────────────────────────
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
    const searchText = await webSearch(query);

    if (!searchText || searchText === 'No results found.' || searchText === 'Search failed.') return;

    const pickResponse = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: 'From these search results about viral AI/startup posts on X, find the single best post @AJ_agentic could reply to with genuine value. Give: 1. Username 2. What they said (brief) 3. URL if visible\n\nResults:\n' + searchText + '\n\nIf nothing worthy, say SKIP.'
      }]
    });

    const picked = pickResponse.content[0].text.trim();
    if (picked.toUpperCase().startsWith('SKIP') || picked.length < 30) return;

    const replyDraft = await generatePost('reply', 'Viral post:\n' + picked);
    const safePicked = picked.replace(/[*_`\[\]]/g, '').substring(0, 300);
    const safeReply = replyDraft.replace(/[*_`\[\]]/g, '');

    // Try to extract tweet ID from URL in picked text
    const tweetUrlMatch = picked.match(/x\.com\/\w+\/status\/(\d+)/);
    const tweetId = tweetUrlMatch ? tweetUrlMatch[1] : null;
    const postType = tweetId ? 'mention_reply:' + tweetId : 'viral_reply';

    await pool.query(
      'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
      [replyDraft, postType, 'pending']
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
