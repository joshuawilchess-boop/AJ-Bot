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
- You have access to Josh's live task list in every message - use it for contextual advice`;

async function getAJResponse(chatId, userMessage) {
  const history = await getHistory(chatId);
  const taskContext = await getTaskContext();

  const systemWithTasks = `${AJ_SYSTEM}\n\nCURRENT TASK LIST:\n${taskContext}`;

  history.push({ role: 'user', content: userMessage });

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: systemWithTasks,
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
  if (!update.message || !update.message.text) return;

  const chatId = update.message.chat.id.toString();
  const text = update.message.text;

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


    if (text.startsWith('/xpost ')) {
      const postText = text.replace('/xpost ', '').trim();
      await bot.sendMessage(chatId, 'Posting to X...');
      const tweetId = await xEngine.postToX(postText);
      if (tweetId) {
        await bot.sendMessage(chatId, 'Posted! https://x.com/AJ_agentic/status/' + tweetId);
      } else {
        await bot.sendMessage(chatId, 'Blocked by privacy filter or X error.');
      }
      return;
    }

    if (text === '/xdelete') {
      const { rows } = await pool.query('SELECT tweet_id, content FROM x_posts WHERE tweet_id IS NOT NULL ORDER BY posted_at DESC LIMIT 1');
      if (rows.length === 0) { await bot.sendMessage(chatId, 'No recent posts found.'); return; }
      await bot.sendMessage(chatId, 'Reply /xconfirmdelete ' + rows[0].tweet_id + ' to delete: ' + rows[0].content.substring(0, 60));
      return;
    }

    if (text.startsWith('/xconfirmdelete ')) {
      const tweetId = text.replace('/xconfirmdelete ', '').trim();
      try {
        const { TwitterApi } = require('twitter-api-v2');
        const tw = new TwitterApi({ appKey: process.env.X_API_KEY, appSecret: process.env.X_API_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET });
        await tw.v2.deleteTweet(tweetId);
        await pool.query('UPDATE x_posts SET tweet_id = NULL WHERE tweet_id = $1', [tweetId]);
        await bot.sendMessage(chatId, 'Deleted from X.');
      } catch(e) { await bot.sendMessage(chatId, 'Delete failed: ' + e.message); }
      return;
    }

    if (text.startsWith('/xthread ')) {
      const topic = text.replace('/xthread ', '').trim();
      await bot.sendMessage(chatId, 'Writing thread about: ' + topic + '...');
      const searchResults = await webSearch(topic);
      const tweets = await xEngine.generateThread(topic, searchResults);
      await xEngine.postThread(tweets);
      await bot.sendMessage(chatId, 'Thread posted to @AJ_agentic!');
      return;
    }

    if (text === '/xpause') {
      process.env.X_PAUSED = 'true';
      await bot.sendMessage(chatId, 'X auto-posting paused. Say /xresume to turn back on.');
      return;
    }

    if (text === '/xresume') {
      process.env.X_PAUSED = '';
      await bot.sendMessage(chatId, 'X auto-posting resumed.');
      return;
    }

    if (text === '/xlast') {
      const xRows = await pool.query('SELECT content, posted_at FROM x_posts WHERE tweet_id IS NOT NULL ORDER BY posted_at DESC LIMIT 5').catch(() => ({ rows: [] }));
      if (xRows.rows.length === 0) { await bot.sendMessage(chatId, 'No X posts yet.'); return; }
      const msg = xRows.rows.map((r, i) => (i+1) + '. ' + r.content.substring(0, 80)).join('\n\n');
      await bot.sendMessage(chatId, 'Last 5 X Posts:\n\n' + msg);
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
  if (process.env.X_API_KEY) { await xEngine.initXDB(); console.log('X engine ready @AJ_agentic'); }
  console.log(`AJ v2 running on port ${PORT}`);
  if (WEBHOOK_URL) {
    const webhookEndpoint = `${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`;
    await bot.setWebHook(webhookEndpoint);
    console.log(`Webhook set: ${webhookEndpoint}`);
  }
});
