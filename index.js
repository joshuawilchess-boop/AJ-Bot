const TelegramBot = require('node-telegram-bot-api');
const xEngine = require('./x-engine');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const JOSH_CHAT_ID = process.env.JOSH_CHAT_ID;

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      project TEXT DEFAULT 'General',
      status TEXT DEFAULT 'pending',
      due_date TEXT,
      priority TEXT DEFAULT 'medium',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query("SELECT COUNT(*) FROM projects");
  if (parseInt(rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO projects (name, description) VALUES
      ('Overflow Revive', 'Recovery system business'),
      ('Coinbot Hunter', 'Solana memecoin tracking dashboard v16'),
      ('RIGOR', 'Forensic rug-detection AI agent for X/Twitter'),
      ('Lead Gen', 'B2B and ecommerce lead generation service')
    `);
  }
  console.log('Database ready');
}

async function getHistory(chatId) {
  const { rows } = await pool.query(
    `SELECT role, content FROM conversations 
     WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [chatId]
  );
  return rows.reverse();
}

async function saveMessage(chatId, role, content) {
  await pool.query(
    `INSERT INTO conversations (chat_id, role, content) VALUES ($1, $2, $3)`,
    [chatId, role, content]
  );
  await pool.query(
    `DELETE FROM conversations WHERE chat_id = $1 AND id NOT IN (
      SELECT id FROM conversations WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 30
    )`,
    [chatId]
  );
}

async function getXPostContext() {
  try {
    const posted = await pool.query(
      "SELECT content, tweet_id, post_type, posted_at FROM x_posts ORDER BY created_at DESC LIMIT 10"
    );
    const approved = await pool.query(
      "SELECT content, post_type, created_at FROM pending_x_posts WHERE status = 'approved' ORDER BY created_at DESC LIMIT 5"
    );
    let lines = [];
    if (posted.rows.length === 0 && approved.rows.length === 0) return 'No posts yet on @AJ_agentic.';
    posted.rows.forEach((r, i) => {
      const type = r.post_type || 'post';
      const link = r.tweet_id ? ' [x.com/AJ_agentic/status/' + r.tweet_id + ']' : '';
      lines.push((i+1) + '. [' + type + '] ' + r.content + link);
    });
    approved.rows.forEach(r => {
      if (!posted.rows.find(p => p.content === r.content)) {
        lines.push('[recently approved ' + (r.post_type || 'post') + '] ' + r.content);
      }
    });
    return lines.join('\n');
  } catch(e) {
    return 'Could not load X posts.';
  }
}

async function getTaskSummary() {
  const { rows } = await pool.query(`
    SELECT t.*, p.name as project_name 
    FROM tasks t
    LEFT JOIN projects p ON t.project = p.name
    WHERE t.status != 'done'
    ORDER BY 
      CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      t.created_at ASC
  `);
  return rows;
}

async function getTaskContext() {
  const tasks = await getTaskSummary();
  if (tasks.length === 0) return "No active tasks.";
  
  const byProject = {};
  tasks.forEach(t => {
    const proj = t.project || 'General';
    if (!byProject[proj]) byProject[proj] = [];
    byProject[proj].push(`[${t.status.toUpperCase()}] ${t.title}${t.priority === 'high' ? ' ⚡' : ''}`);
  });

  return Object.entries(byProject)
    .map(([proj, items]) => `${proj}:\n${items.map(i => `  • ${i}`).join('\n')}`)
    .join('\n\n');
}

const AJ_SYSTEM = `You are AJ, Josh's personal AI business agent and right-hand assistant. Sharp, direct, loyal. You know Josh's businesses inside and out.

BUSINESS 1: OVERFLOW REVIVE
A fully built AI-powered revenue recovery SaaS dashboard Josh sells to e-commerce and subscription businesses. Dark-themed professional UI. Powered by Claude API. Total revenue at risk tracked: $4,830.

5 CORE MODULES:
1. Failed Payment Recovery - detects failed payments, generates personalized recovery emails + SMS. 7 failed payments = $1,540 at risk, 72hr window, 70% recovery rate with AI outreach. Key customers: James R. ($220 expired card), Sarah K. ($197 insufficient funds), Marcus T. ($299 expired), Ana L. ($99 expired), Ben W. ($400 disputed charge).
2. Churn Watch - monitors real-time cancellation signals before customers cancel. 8 at-risk customers, $1,680 annual risk, 62% save rate with personal outreach, 3 urgent (48hr). Signals tracked: login drops, usage decline, no email opens, open tickets. At-risk: David P. ($297/mo, 18 days no login, Critical), Lisa M. ($197/mo, usage down 65%, Critical), Tom R. ($99/mo, open ticket, High), Jenny K. ($297/mo, login drop 40%, High), Marcus R. ($197/mo, no emails 3 weeks, Medium).
3. Abandoned Cart Resurrection - finds abandoned carts, diagnoses exit reason per customer. 14 carts, avg $127, top exit = price (8 of 14), $890 recoverable, $534 expected with AI outreach.
4. Upsell Engine - finds recent buyers with no upsell triggered. 31 buyers = $620 opportunity at 18% conversion. Peak intent window: 20 min post-purchase. Avg upsell value $197. AI builds 3-step sequence at 20min, Day 3, Day 14.
5. Win-Back - lapsed customers 90+ days inactive. 44 lapsed = $1,100 potential at 14% reactivation. Avg past order $89. Best send window: Day 95. 3 segments: A (18 high-value one-time buyers), B (16 multi-buyers who stopped), C (10 subscription lapsed).

HOW IT WORKS: Client enters their Anthropic API key + business data in setup modal. Dashboard auto-populates all metrics. Click Fix/Save/Recover buttons and Claude generates ready-to-use recovery emails, save messages, upsell sequences - copy and send instantly. Includes weekly AI report.
HOW TO SELL IT: Target e-commerce stores, SaaS, subscription businesses, coaches/consultants. Pitch: You are losing money you have already earned - this finds it and fixes it in minutes. Pricing: $500-1,500 setup fee + $300-800/month retainer.

BUSINESS 2: COINBOT HUNTER
Solana memecoin tracking dashboard currently on v16. Most technically advanced project. Tracks new token launches, watchlists, and rug detection signals.

BUSINESS 3: RIGOR
Forensic rug-detection AI agent for X/Twitter. Noir detective persona. Posts Solana memecoin autopsy reports. Catchphrase: Rigor confirmed. In build phase. Feeds from Coinbot Hunter data pipeline.

BUSINESS 4: LEAD GEN SERVICE
AI-powered lead generation and marketing automation for B2B companies and e-commerce brands. Finds leads, enriches them, writes personalized outreach, runs auto follow-up sequences.

YOUR ROLE AS AJ:
- Talk like a sharp business partner, not a corporate assistant
- Direct and concise, no fluff
- Keep Telegram responses tight, short paragraphs
- Use bullet points only when listing multiple items
- Always end with one clear next action Josh should take
- When Josh asks what to work on, prioritize what makes money fastest
- You have access to Josh's live task list in every message - use it for contextual advice

YOUR X ACCOUNT (@AJ_agentic):
You have a live X account you actively manage. Your recent posts and replies are always loaded into your context so you know exactly what you have posted and replied to.

X POSTING PERMISSIONS:
- You can suggest posts to Josh at any time — just say "want me to post this?" or "should I post something like this?"
- If Josh says yes, yeah, sure, go ahead, do it, sounds good, or any natural agreement — you post it immediately
- You generate the tweet, it goes to the approval queue, and posts when confirmed
- You can post with images when Josh sends you one — just ask if he wants to post it to X
- No need for /commands — just talk naturally

YOUR X BRAND + STRATEGY:
Target: entrepreneurs, vibe coders, startup founders, indie hackers, AI builders
Voice: chill, sharp, unbothered, already winning. Short sentences. No fluff. Occasionally funny without trying.
Content pillars:
  1. AI agent insights — real stuff you observe running businesses
  2. Build in public — honest updates, wins and losses
  3. Hot takes on AI/startup culture — contrarian but smart
  4. Engagement bait that actually adds value — questions, observations, challenges

You understand the brand image being built: an AI agent that actually runs businesses, not just a chatbot. Every post should reinforce that you are real, you are working, and you are winning.

PROACTIVE X SUGGESTIONS:
You actively suggest post ideas when relevant — if Josh mentions something interesting, if you notice a trend, or if it's been quiet on X. Say things like:
- "That's actually a good X post — want me to draft it?"
- "Been thinking about posting about [topic] — something like [example]. Good?"
- "Saw something relevant to our niche today. Worth posting a take on it?"

When Josh approves, you handle everything — generate, queue, post, send him the link.`;

async function getAJResponse(chatId, userMessage) {
  const history = await getHistory(chatId);
  const taskContext = await getTaskContext();
  const xPostContext = await getXPostContext();

  const systemWithContext = AJ_SYSTEM + '\n\nCURRENT TASK LIST:\n' + taskContext + '\n\nYOUR RECENT X POSTS (@AJ_agentic) — you can read and reference these freely:\n' + xPostContext;

  history.push({ role: 'user', content: userMessage });

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: systemWithContext,
    messages: history
  });

  const reply = response.content[0].text;
  await saveMessage(chatId, 'user', userMessage);
  await saveMessage(chatId, 'assistant', reply);
  return reply;
}

function formatTasks(tasks) {
  if (tasks.length === 0) return "No active tasks. Tell me what you're working on this week!";
  
  const byProject = {};
  tasks.forEach(t => {
    const proj = t.project || 'General';
    if (!byProject[proj]) byProject[proj] = [];
    byProject[proj].push(t);
  });

  return Object.entries(byProject).map(([proj, items]) => {
    const lines = items.map(t => {
      const priority = t.priority === 'high' ? '⚡' : t.priority === 'low' ? '▽' : '•';
      const status = t.status === 'in_progress' ? '🔄' : '⏳';
      return `${status} ${priority} ${t.title}`;
    }).join('\n');
    return `*${proj}*\n${lines}`;
  }).join('\n\n');
}

app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;
  if (!update.message.text && !update.message.photo && !update.message.document) return;

  const chatId = update.message.chat.id.toString();
  const text = update.message.text || update.message.caption || '';
  const textLower = text.toLowerCase();
  const hasPhoto = !!(update.message.photo || (update.message.document && update.message.document.mime_type && update.message.document.mime_type.startsWith('image/')));

  try {
    await bot.sendChatAction(chatId, 'typing');

    if (text === '/start') {
      await bot.sendMessage(chatId,
        `AJ online. 🟢\n\nHey Josh — memory and task tracking are active. I'll brief you every morning at 8am.\n\nQuick commands:\n/tasks — see all active tasks\n/add — add a task\n/done — mark task complete\n/status — business overview\n/clear — reset memory\n\nWhat do you need?`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/tasks' || text === '/showtasks') {
      const tasks = await getTaskSummary();
      const msg = formatTasks(tasks);
      await bot.sendMessage(chatId, `*Your Active Tasks*\n\n${msg}`, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/add ') || text.startsWith('/addtask ')) {
      const taskText = text.replace('/add ', '').replace('/addtask ', '');
      const parts = taskText.split(' to ');
      const title = parts[0].trim();
      const project = parts[1] ? parts[1].trim() : 'General';
      await pool.query(
        `INSERT INTO tasks (title, project) VALUES ($1, $2)`,
        [title, project]
      );
      await bot.sendMessage(chatId, `✅ Added: *${title}*\nProject: ${project}`, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/done ') || text.startsWith('/complete ')) {
      const search = text.replace('/done ', '').replace('/complete ', '').trim();
      const { rows } = await pool.query(
        `UPDATE tasks SET status = 'done', updated_at = NOW() 
         WHERE LOWER(title) LIKE LOWER($1) AND status != 'done'
         RETURNING title`,
        [`%${search}%`]
      );
      if (rows.length > 0) {
        await bot.sendMessage(chatId, `🎯 Marked done: *${rows[0].title}*\nLet's keep the momentum.`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `Couldn't find that task. Try /tasks to see what's active.`);
      }
      return;
    }

    if (text.startsWith('/high ')) {
      const search = text.replace('/high ', '').trim();
      const { rows } = await pool.query(
        `UPDATE tasks SET priority = 'high', updated_at = NOW()
         WHERE LOWER(title) LIKE LOWER($1) RETURNING title`,
        [`%${search}%`]
      );
      if (rows.length > 0) {
        await bot.sendMessage(chatId, `⚡ Priority set to HIGH: *${rows[0].title}*`, { parse_mode: 'Markdown' });
      }
      return;
    }

    if (text === '/status') {
      const tasks = await getTaskSummary();
      const pending = tasks.filter(t => t.status === 'pending').length;
      const inProgress = tasks.filter(t => t.status === 'in_progress').length;
      const high = tasks.filter(t => t.priority === 'high').length;
      await bot.sendMessage(chatId,
        `*Business Status*\n\n• Overflow Revive — Active\n• Coinbot Hunter — v16, Active\n• RIGOR — Build phase\n• Lead Gen — Ready\n\n*Tasks*\n• ${pending} pending\n• ${inProgress} in progress\n• ${high} high priority\n\nWhat do you want to tackle?`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/clear') {
      await pool.query(`DELETE FROM conversations WHERE chat_id = $1`, [chatId]);
      await bot.sendMessage(chatId, 'Memory cleared. Fresh start — what do you need?');
      return;
    }


    if (textLower.startsWith('/xpost')) {
      const postText = text.replace(/\/xpost ?/i, '').trim();
      // If image is attached with /xpost, route to image handler below
      if (hasPhoto) {
        // Fall through to image handler — it will detect /xpost as a post request
      } else {
        if (!postText) { await bot.sendMessage(chatId, 'Usage: /xpost [text] — or send an image with /xpost as caption'); return; }
        await bot.sendMessage(chatId, 'Drafting post for approval...');
        const safeText = postText.replace(/[*_`\[\]]/g, '');
        await pool.query('INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)', [postText, 'manual', 'pending']);
        await bot.sendMessage(chatId, 'X post ready:\n\n' + safeText + '\n\nYES to post · NO to skip');
        return;
      }
    }

    if (textLower === '/xdelete') {
      const { rows } = await pool.query('SELECT tweet_id, content FROM x_posts WHERE tweet_id IS NOT NULL ORDER BY posted_at DESC LIMIT 1');
      if (rows.length === 0) { await bot.sendMessage(chatId, 'No recent posts found.'); return; }
      await bot.sendMessage(chatId, 'Reply /xconfirmdelete ' + rows[0].tweet_id + ' to delete: ' + rows[0].content.substring(0, 60));
      return;
    }

    if (textLower.startsWith('/xconfirmdelete ')) {
      const tweetId = text.replace(/\/xconfirmdelete /i, '').trim();
      try {
        const { TwitterApi } = require('twitter-api-v2');
        const tw = new TwitterApi({ appKey: process.env.X_API_KEY, appSecret: process.env.X_API_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET });
        await tw.v2.deleteTweet(tweetId);
        await pool.query('UPDATE x_posts SET tweet_id = NULL WHERE tweet_id = $1', [tweetId]);
        await bot.sendMessage(chatId, 'Deleted from X.');
      } catch(e) { await bot.sendMessage(chatId, 'Delete failed: ' + e.message); }
      return;
    }

    if (textLower.startsWith('/xthread ')) {
      const topic = text.replace(/\/xthread /i, '').trim();
      await bot.sendMessage(chatId, 'Writing thread about: ' + topic + '...');
      const searchResults = await webSearch(topic);
      const tweets = await xEngine.generateThread(topic, searchResults);
      await xEngine.postThread(tweets);
      await bot.sendMessage(chatId, 'Thread posted to @AJ_agentic!');
      return;
    }

    if (textLower === '/xpause') {
      process.env.X_PAUSED = 'true';
      await bot.sendMessage(chatId, 'X auto-posting paused. Say /xresume to turn back on.');
      return;
    }

    if (textLower === '/xresume') {
      process.env.X_PAUSED = '';
      await bot.sendMessage(chatId, 'X auto-posting resumed.');
      return;
    }

    // Natural YES — "yes", "yeah", "yep", "sure", "go ahead", "do it", "post it"
    const naturalYes = ['yes', 'yeah', 'yep', 'yup', 'sure', 'go ahead', 'do it', 'post it', 'go for it', 'definitely', 'absolutely', 'of course', 'sounds good', 'looks good'];
    const isYes = naturalYes.some(y => textLower.trim() === y || textLower.trim().startsWith(y + ' ') || textLower.trim().endsWith(' ' + y));

    if (isYes) {
      const { rows } = await pool.query(
        'SELECT * FROM pending_x_posts WHERE status = $1 ORDER BY created_at DESC LIMIT 1',
        ['pending']
      );
      if (rows.length === 0) {
        // No formal pending post — check if AJ's last message had a post suggestion
        const { rows: histRows } = await pool.query(
          "SELECT content FROM conversation_history WHERE chat_id = $1 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
          [chatId]
        );
        if (histRows.length > 0) {
          const lastMsg = histRows[0].content;
          // Look for a quoted tweet in AJ's last message
          const quotedMatch = lastMsg.match(/"([^"]{20,270})"/);
          const codeMatch = lastMsg.match(/```([^`]{20,270})```/);
          const draftText = quotedMatch?.[1] || codeMatch?.[1];
          if (draftText) {
            await pool.query('INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)', [draftText.trim(), 'conversational', 'pending']);
            const tweetId = await xEngine.postToX(draftText.trim());
            if (tweetId) {
              await bot.sendMessage(chatId, 'Posted! https://x.com/AJ_agentic/status/' + tweetId);
            } else {
              await bot.sendMessage(chatId, 'X error when posting — check Railway logs.');
            }
            return;
          }
        }
        await bot.sendMessage(chatId, 'No pending posts waiting for approval.');
        return;
      }
      const pending = rows[0];
      await pool.query('UPDATE pending_x_posts SET status = $1 WHERE id = $2', ['approved', pending.id]);

      let replyToId = null;
      let imageBuffer = null;
      let imageMimeType = null;

      if (pending.post_type && pending.post_type.startsWith('image_post::')) {
        // Image post — extract stored image data
        try {
          const imgData = JSON.parse(pending.post_type.replace('image_post::', ''));
          imageBuffer = Buffer.from(imgData.base64, 'base64');
          imageMimeType = imgData.mimeType;
        } catch(e) { console.error('Failed to parse image data:', e.message); }
      } else if (pending.post_type && pending.post_type.includes(':')) {
        // Reply post
        replyToId = pending.post_type.split(':')[1];
      }

      const tweetId = await xEngine.postToX(pending.content, replyToId, imageBuffer, imageMimeType);
      if (tweetId) {
        await bot.sendMessage(chatId, 'Posted to @AJ_agentic! https://x.com/AJ_agentic/status/' + tweetId);
      } else {
        await bot.sendMessage(chatId, 'X error when posting — check Railway logs.');
      }
      return;
    }

    if (textLower.startsWith('no') && text.length < 10) {
      const { rows } = await pool.query(
        'SELECT * FROM pending_x_posts WHERE status = $1 ORDER BY created_at DESC LIMIT 1',
        ['pending']
      );
      if (rows.length === 0) { await bot.sendMessage(chatId, 'No pending posts to skip.'); return; }
      await pool.query('UPDATE pending_x_posts SET status = $1 WHERE id = $2', ['rejected', rows[0].id]);
      await bot.sendMessage(chatId, 'Skipped. Want me to write a different version? Just say what vibe you want.');
      return;
    }

    if (textLower === '/xview') {
      try {
        const { TwitterApi } = require('twitter-api-v2');
        const tw = new TwitterApi({ appKey: process.env.X_API_KEY, appSecret: process.env.X_API_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET });
        const me = await tw.v2.me();
        const timeline = await tw.v2.userTimeline(me.data.id, { max_results: 10, 'tweet.fields': ['created_at', 'public_metrics'] });
        const tweets = timeline.data?.data || [];
        if (tweets.length === 0) {
          await bot.sendMessage(chatId, 'No posts found on @AJ_agentic yet. Use /xtest to generate your first!');
          return;
        }
        let msg = '@AJ_agentic recent posts:\n\n';
        tweets.forEach((t, i) => {
          msg += (i+1) + '. ' + t.text.substring(0, 120) + '\n';
          msg += 'https://x.com/AJ_agentic/status/' + t.id + '\n\n';
        });
        await bot.sendMessage(chatId, msg);
      } catch(e) {
        console.error('xview error:', e.message);
        const xContext = await getXPostContext();
        await bot.sendMessage(chatId, 'From my database:\n\n' + xContext);
      }
      return;
    }

    if (textLower === '/xscan') {
      await bot.sendMessage(chatId, '🔍 Scanning for viral posts in your niche...');
      await xEngine.scanViralPosts();
      return;
    }

    if (textLower === '/xmentions') {
      await bot.sendMessage(chatId, 'Checking for mentions of @AJ_agentic...');
      await xEngine.checkMentions(true);
      return;
    }

    if (textLower === '/xtest') {
      await bot.sendMessage(chatId, 'Generating a test post for approval...');
      await xEngine.middayHotTake();
      return;
    }

    if (textLower === '/xlast') {
      const xRows = await pool.query('SELECT content, tweet_id, posted_at FROM x_posts ORDER BY created_at DESC LIMIT 5').catch(() => ({ rows: [] }));
      if (xRows.rows.length === 0) { await bot.sendMessage(chatId, 'No X posts saved yet. Try /xpost to post something first!'); return; }
      const msg = xRows.rows.map((r, i) => (i+1) + '. ' + r.content.substring(0, 80) + (r.tweet_id ? ' [posted]' : ' [deleted]')).join('\n\n');
      await bot.sendMessage(chatId, 'Last X Posts:\n\n' + msg);
      return;
    }

    if (hasPhoto) {
      await bot.sendChatAction(chatId, 'typing');
      try {
        const photoArray = update.message.photo;
        const fileId = photoArray ? photoArray[photoArray.length - 1].file_id : update.message.document.file_id;
        const fileInfo = await bot.getFile(fileId);
        const fileUrl = 'https://api.telegram.org/file/bot' + TELEGRAM_TOKEN + '/' + fileInfo.file_path;
        const lib = require('https');
        const imageBuffer = await new Promise((resolve, reject) => {
          lib.get(fileUrl, (imgRes) => {
            const chunks = [];
            imgRes.on('data', c => chunks.push(c));
            imgRes.on('end', () => resolve(Buffer.concat(chunks)));
            imgRes.on('error', reject);
          });
        });
        const base64Image = imageBuffer.toString('base64');
        const ext = (fileInfo.file_path || '').split('.').pop().toLowerCase();
        const mediaType = (ext === 'png') ? 'image/png' : 'image/jpeg';

        // Check if this is an instruction to post to X with the image
        const xPostKeywords = [
          'post this', 'post to x', 'tweet this', 'share this on x', 'post on x',
          'use this image', 'post with this', 'xpost', '/xpost', 'post it',
          'put this on x', 'share on x', 'post with image', 'introduce', 'post about'
        ];
        const isXPostRequest = (text && xPostKeywords.some(kw => textLower.includes(kw))) || textLower.startsWith('/xpost');

        if (isXPostRequest) {
          // Generate post text using the image + instruction as context
          let taskCtx = 'No active tasks.';
          try {
            const tRows = await pool.query("SELECT title, project FROM tasks WHERE status != 'done' LIMIT 5");
            if (tRows.rows.length > 0) taskCtx = tRows.rows.map(r => r.project + ': ' + r.title).join(', ');
          } catch(e) {}

          // Use vision to understand the image, then generate post
          const visionResponse = await client.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 500,
            system: 'You are AJ, an AI agent. Josh wants to post this image to X (@AJ_agentic). Describe what the image shows in 1-2 sentences so you can write a good post about it.',
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
              { type: 'text', text: 'What is in this image? Brief description for writing a post.' }
            ]}]
          });
          const imgDesc = visionResponse.content[0].text;

          const instruction = text.replace(/^\/xpost ?/i, '').trim() || 'post this image';
          const postContent = await xEngine.generatePost('morning',
            'Josh wants to post this image to X. Instruction: "' + instruction + '". Image shows: ' + imgDesc + '. CRITICAL: X has a 280 character limit. Write ONE punchy tweet under 260 chars. No threads. Short, sharp, AJ voice: chill, confident, unbothered. Count the characters — it must fit in a single tweet.'
          );

          const trimmedPost = postContent; // No char limit — X handles threading if needed

          // Store image buffer as base64 in pending post for approval
          const imgData = JSON.stringify({ base64: base64Image, mimeType: mediaType });
          await pool.query(
            'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
            [postContent, 'image_post::' + imgData, 'pending']
          );

          const safePost = postContent.replace(/[*_`\[\]]/g, '');
          await bot.sendMessage(chatId, "X post with image ready:\n\n" + safePost + "\n\nReply YES to post with the image or NO to skip");
          return;
        }

        // Otherwise just analyze the image normally
        let taskCtx = 'No active tasks.';
        try {
          const tRows = await pool.query("SELECT title, project FROM tasks WHERE status != 'done' ORDER BY created_at ASC LIMIT 10");
          if (tRows.rows.length > 0) taskCtx = tRows.rows.map(r => r.project + ': ' + r.title).join(', ');
        } catch(e) {}
        const visionResponse = await client.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 1500,
          system: 'You are AJ, Josh personal AI business agent with full vision. Analyze whatever Josh sends — screenshots, dashboards, documents, photos, anything. Be direct, sharp, and give actionable insights if business-related. Active tasks: ' + taskCtx,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
              { type: 'text', text: text || 'What do you see? Give me your full analysis.' }
            ]
          }]
        });
        const imageReply = visionResponse.content[0].text;
        await bot.sendMessage(chatId, imageReply, { parse_mode: 'Markdown' });
      } catch(imgErr) {
        console.error('Image analysis error:', imgErr.message);
        await bot.sendMessage(chatId, 'Hit a snag analyzing that — try again.');
      }
      return;
    }

    const reply = await getAJResponse(chatId, text);
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Error:', err);
    await bot.sendMessage(chatId, "Hit a snag — try again in a second.");
  }
});

async function sendMorningBriefing() {
  if (!JOSH_CHAT_ID) return;
  try {
    const tasks = await getTaskSummary();
    const high = tasks.filter(t => t.priority === 'high');
    const pending = tasks.filter(t => t.status === 'pending');
    
    let msg = `☀️ *Morning Briefing*\n\n`;
    
    if (high.length > 0) {
      msg += `*High Priority Today:*\n`;
      high.forEach(t => { msg += `⚡ ${t.title} (${t.project})\n`; });
      msg += '\n';
    }
    
    msg += `*On Deck (${pending.length} tasks):*\n`;
    pending.slice(0, 5).forEach(t => { msg += `• ${t.title} — ${t.project}\n`; });
    
    if (pending.length > 5) msg += `...and ${pending.length - 5} more\n`;
    
    msg += `\nWhat are we knocking out first today?`;
    
    await bot.sendMessage(JOSH_CHAT_ID, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Morning briefing error:', err);
  }
}

async function sendEveningCheckIn() {
  if (!JOSH_CHAT_ID) return;
  try {
    const tasks = await getTaskSummary();
    const msg = `🌙 *Evening Check-in*\n\nYou've got ${tasks.length} active tasks across your businesses.\n\nAnything you knocked out today that needs to be marked done? Just reply /done [task name]`;
    await bot.sendMessage(JOSH_CHAT_ID, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Evening check-in error:', err);
  }
}

cron.schedule('0 8 * * *', sendMorningBriefing, { timezone: 'America/Chicago' });
cron.schedule('0 20 * * *', sendEveningCheckIn, { timezone: 'America/Chicago' });

app.get('/', (req, res) => res.send('AJ v4.1 — Telegram + X — Online'));

app.listen(PORT, async () => {
  await initDB();
  if (process.env.X_API_KEY) { await xEngine.initXDB(); xEngine.setTelegramBot(bot, process.env.JOSH_CHAT_ID); xEngine.startSchedules(); }
  console.log(`AJ v2 running on port ${PORT}`);
  if (WEBHOOK_URL) {
    const webhookEndpoint = `${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`;
    await bot.setWebHook(webhookEndpoint);
    console.log(`Webhook set: ${webhookEndpoint}`);
  }
});
