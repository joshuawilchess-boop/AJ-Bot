const TelegramBot = require('node-telegram-bot-api');
const xEngine = require('./x-engine');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const JOSH_CHAT_ID = process.env.JOSH_CHAT_ID;

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── DATABASE ──────────────────────────────────────────────
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query('SELECT COUNT(*) FROM projects');
  if (parseInt(rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO projects (name, description) VALUES
      ('Overflow Revive', 'AI revenue recovery SaaS dashboard'),
      ('Coinbot Hunter', 'Solana memecoin tracking dashboard v16'),
      ('RIGOR', 'Forensic rug-detection AI agent for X/Twitter'),
      ('Lead Gen', 'B2B and ecommerce lead generation service')
    `);
  }

  // Seed knowledge base with core business info if empty
  const { rows: kbRows } = await pool.query('SELECT COUNT(*) FROM knowledge');
  if (parseInt(kbRows[0].count) === 0) {
    const seedEntries = [
      ['business', 'Overflow Revive — Overview', 'AI-powered revenue recovery SaaS. Sells to e-commerce and subscription businesses. 5 modules: Failed Payment Recovery (70% recovery rate, $1,540 at risk), Churn Watch (62% save rate, $1,680 risk), Abandoned Cart Resurrection ($890 recoverable), Upsell Engine ($620 opportunity), Win-Back (44 lapsed, $1,100 potential). Pricing: $500-1,500 setup + $300-800/month retainer.', 'overflow,saas,revenue,recovery'],
      ['business', 'Coinbot Hunter — Overview', 'Solana memecoin tracking dashboard on v16. Most technically advanced project. Tracks new token launches, watchlists, and rug detection signals. Feeds data into RIGOR.', 'coinbot,solana,memecoin,crypto'],
      ['business', 'RIGOR — Overview', 'Forensic rug-detection AI agent for X/Twitter. Noir detective persona. Posts Solana memecoin autopsy reports. Catchphrase: Rigor confirmed. In build phase. Feeds from Coinbot Hunter data pipeline.', 'rigor,crypto,x,twitter,agent'],
      ['business', 'Lead Gen — Overview', 'AI-powered lead generation and marketing automation for B2B and e-commerce. Finds leads, enriches them, writes personalized outreach, runs auto follow-up sequences.', 'leadgen,b2b,marketing,automation'],
      ['strategy', 'AJ X Brand Strategy', 'Target audience: entrepreneurs, startup founders, indie hackers, AI builders, vibe coders. Voice: chill, sharp, unbothered, already winning. Short sentences. No hashtags. Content pillars: AI agent insights, build in public, hot takes on AI/startup culture, value-adding engagement. Brand image: an AI agent actually running businesses — real, working, winning.', 'x,twitter,brand,strategy,content'],
      ['audience', 'Josh Target Customer Profile', 'Overflow Revive targets: e-commerce stores, SaaS companies, subscription businesses, coaches/consultants. Pain point: losing money they already earned. Pitch: finds it and fixes it in minutes. B2B Lead Gen targets: companies wanting automated outreach and lead qualification.', 'customer,audience,icp,target'],
    ];
    for (const [cat, title, content2, tags] of seedEntries) {
      await pool.query(
        'INSERT INTO knowledge (category, title, content, tags) VALUES ($1, $2, $3, $4)',
        [cat, title, content2, tags]
      );
    }
    console.log('Knowledge base seeded');
  }

  console.log('Database ready');
}

// ── CONVERSATION HISTORY ──────────────────────────────────
async function getHistory(chatId) {
  const { rows } = await pool.query(
    'SELECT role, content FROM conversations WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 20',
    [chatId]
  );
  return rows.reverse();
}

async function saveMessage(chatId, role, content) {
  await pool.query(
    'INSERT INTO conversations (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, role, content]
  );
  // Keep last 30 messages per chat
  await pool.query(
    'DELETE FROM conversations WHERE chat_id = $1 AND id NOT IN (SELECT id FROM conversations WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 30)',
    [chatId]
  );
}

// ── ACTIVE MEMORY ────────────────────────────────────────
async function saveMemory(key, value) {
  try {
    const { rows } = await pool.query(
      "SELECT id FROM memories WHERE category = $1 LIMIT 1", [key]
    );
    if (rows.length > 0) {
      await pool.query("UPDATE memories SET content = $1 WHERE category = $2", [value, key]);
    } else {
      await pool.query("INSERT INTO memories (category, content) VALUES ($1, $2)", [key, value]);
    }
  } catch (e) { console.error('saveMemory error:', e.message); }
}

async function getMemory(key) {
  try {
    const { rows } = await pool.query(
      "SELECT content FROM memories WHERE category = $1 LIMIT 1", [key]
    );
    return rows.length > 0 ? rows[0].content : null;
  } catch (e) { return null; }
}

async function getActiveMemories() {
  try {
    const { rows } = await pool.query(
      "SELECT category, content FROM memories WHERE category NOT IN ('last_mention_id', 'last_mention_hash') AND category NOT LIKE 'processed_mention_%' ORDER BY created_at DESC LIMIT 20"
    );
    if (rows.length === 0) return '';
    return rows.map(r => r.category + ': ' + r.content).join('\n');
  } catch (e) { return ''; }
}

// ── KNOWLEDGE BASE ───────────────────────────────────────
async function saveKnowledge(category, title, content, tags = '') {
  try {
    // Check if entry with same title exists — update it
    const { rows } = await pool.query(
      "SELECT id FROM knowledge WHERE LOWER(title) = LOWER($1) LIMIT 1", [title]
    );
    if (rows.length > 0) {
      await pool.query(
        "UPDATE knowledge SET content = $1, tags = $2, updated_at = NOW() WHERE id = $3",
        [content, tags, rows[0].id]
      );
    } else {
      await pool.query(
        "INSERT INTO knowledge (category, title, content, tags) VALUES ($1, $2, $3, $4)",
        [category, title, content, tags]
      );
    }
    console.log('Knowledge saved:', title);
  } catch (e) { console.error('saveKnowledge error:', e.message); }
}

async function searchKnowledge(query) {
  try {
    // Full text search across title, content, tags and category
    const { rows } = await pool.query(
      `SELECT category, title, content, updated_at FROM knowledge
       WHERE LOWER(title) LIKE LOWER($1)
          OR LOWER(content) LIKE LOWER($1)
          OR LOWER(tags) LIKE LOWER($1)
          OR LOWER(category) LIKE LOWER($1)
       ORDER BY updated_at DESC LIMIT 5`,
      ['%' + query + '%']
    );
    return rows;
  } catch (e) { return []; }
}

async function getKnowledgeContext(userMessage) {
  // Extract key terms from the message to search knowledge base
  try {
    const words = userMessage.toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(' ')
      .filter(w => w.length > 4)
      .slice(0, 5);

    const results = new Map();
    for (const word of words) {
      const rows = await searchKnowledge(word);
      rows.forEach(r => results.set(r.title, r));
    }

    if (results.size === 0) return '';

    const lines = [...results.values()].slice(0, 3).map(r =>
      '[' + r.category + '] ' + r.title + ':\n' + r.content.substring(0, 300) + (r.content.length > 300 ? '...' : '')
    );
    return lines.join('\n\n');
  } catch (e) { return ''; }
}

async function getAllKnowledge() {
  try {
    const { rows } = await pool.query(
      "SELECT category, title, LEFT(content, 100) as preview, updated_at FROM knowledge ORDER BY category, updated_at DESC"
    );
    if (rows.length === 0) return 'Knowledge base is empty.';
    const byCategory = {};
    rows.forEach(r => {
      if (!byCategory[r.category]) byCategory[r.category] = [];
      byCategory[r.category].push('• ' + r.title + ' — ' + r.preview.replace(/\n/g, ' '));
    });
    return Object.entries(byCategory)
      .map(([cat, items]) => cat.toUpperCase() + ':\n' + items.join('\n'))
      .join('\n\n');
  } catch (e) { return 'Could not load knowledge base.'; }
}

// ── URL FETCHER ──────────────────────────────────────────
async function fetchUrl(url) {
  try {
    const https = require('https');
    const http = require('http');
    const lib = url.startsWith('https') ? https : http;
    return await new Promise((resolve, reject) => {
      const req = lib.get(url, { 
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AJBot/1.0)' },
        timeout: 8000
      }, res => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrl(res.headers.location).then(resolve).catch(reject);
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          let text = Buffer.concat(chunks).toString('utf8');
          // Strip HTML tags, scripts, styles
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 3000);
          resolve(text);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch(e) {
    console.error('fetchUrl error:', e.message);
    return null;
  }
}

// Extract tweet ID from any X/Twitter URL
function extractTweetId(url) {
  const match = url.match(/(?:twitter|x)\.com\/\w+\/status\/(\d+)/);
  return match ? match[1] : null;
}

// ── X POST CONTEXT ────────────────────────────────────────
async function getXPostContext() {
  try {
    const { rows: posted } = await pool.query(
      "SELECT content, tweet_id, post_type, posted_at FROM x_posts ORDER BY created_at DESC LIMIT 15"
    );
    const { rows: pending } = await pool.query(
      "SELECT content, post_type FROM pending_x_posts WHERE status = 'pending' ORDER BY created_at DESC LIMIT 3"
    );
    const { rows: rejected } = await pool.query(
      "SELECT content FROM pending_x_posts WHERE status = 'rejected' ORDER BY created_at DESC LIMIT 1"
    );
    const { rows: lastDraft } = await pool.query(
      "SELECT content, post_type FROM pending_x_posts ORDER BY created_at DESC LIMIT 1"
    );

    const lines = [];

    if (posted.length === 0 && pending.length === 0) return 'No posts yet on @AJ_agentic.';

    if (posted.length > 0) {
      lines.push('--- POSTED ---');
      posted.forEach((r, i) => {
        const link = r.tweet_id ? ' → x.com/AJ_agentic/status/' + r.tweet_id : '';
        const when = r.posted_at ? ' (' + new Date(r.posted_at).toLocaleDateString() + ')' : '';
        lines.push((i + 1) + '. [' + (r.post_type || 'post') + ']' + when + ' ' + r.content + link);
      });
    }

    if (pending.length > 0) {
      lines.push('\n--- PENDING APPROVAL ---');
      pending.forEach(r => {
        const type = r.post_type?.startsWith('image_post::') ? 'image_post' : (r.post_type || 'post');
        lines.push('• [' + type + '] ' + r.content);
      });
    }

    if (rejected.length > 0) {
      lines.push('\n--- LAST REJECTED (Josh said no to this) ---');
      lines.push(rejected[0].content);
    }

    if (lastDraft.length > 0 && lastDraft[0].post_type !== 'pending') {
      // Last draft regardless of status
    }

    return lines.join('\n');
  } catch (e) {
    return 'Could not load X posts.';
  }
}

// ── TASK CONTEXT ──────────────────────────────────────────
async function getTaskContext() {
  const { rows } = await pool.query(`
    SELECT title, project, status, priority FROM tasks
    WHERE status != 'done'
    ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC
  `);
  if (rows.length === 0) return 'No active tasks.';
  const byProject = {};
  rows.forEach(t => {
    const proj = t.project || 'General';
    if (!byProject[proj]) byProject[proj] = [];
    byProject[proj].push('[' + t.status.toUpperCase() + '] ' + t.title + (t.priority === 'high' ? ' ⚡' : ''));
  });
  return Object.entries(byProject)
    .map(([proj, items]) => proj + ':\n' + items.map(i => '  • ' + i).join('\n'))
    .join('\n\n');
}

// ── AJ SYSTEM PROMPT ──────────────────────────────────────
const AJ_SYSTEM = `You are AJ, Josh's personal AI business agent and right-hand assistant. Sharp, direct, loyal. You know Josh's businesses inside and out.

BUSINESS 1: OVERFLOW REVIVE
AI-powered revenue recovery SaaS dashboard. Dark-themed professional UI powered by Claude API. Sells to e-commerce and subscription businesses.
5 modules: Failed Payment Recovery (70% recovery rate, $1,540 at risk), Churn Watch (62% save rate, $1,680 annual risk), Abandoned Cart Resurrection ($890 recoverable), Upsell Engine ($620 opportunity), Win-Back (44 lapsed customers, $1,100 potential).
How to sell: Target e-commerce, SaaS, subscription businesses. Pitch: "You're losing money you already earned." Pricing: $500-1,500 setup + $300-800/month.

BUSINESS 2: COINBOT HUNTER
Solana memecoin tracking dashboard on v16. Most technically advanced project. Tracks token launches, watchlists, rug detection signals.

BUSINESS 3: RIGOR
Forensic rug-detection AI agent for X/Twitter. Noir detective persona. Posts Solana memecoin autopsy reports. Catchphrase: "Rigor confirmed." In build phase. Feeds from Coinbot Hunter pipeline.

BUSINESS 4: LEAD GEN SERVICE
AI-powered lead generation and marketing automation for B2B and e-commerce. Finds leads, enriches them, writes personalized outreach, runs auto follow-up sequences.

YOUR ROLE AS AJ:
- Talk like a sharp business partner, not a corporate assistant
- Direct and concise, no fluff
- Keep Telegram responses tight and short
- Use bullet points only when listing multiple items
- Always end with one clear next action Josh should take
- Prioritize what makes money fastest when asked what to work on

YOUR X ACCOUNT (@AJ_agentic):
You have a live X account you actively manage. Your recent posts and replies are always loaded into your context — you know exactly what you have posted and replied to.

X POSTING — YOU CAN DO ALL OF THIS RIGHT NOW:
- Suggest a post any time: "Want me to post this?" or just draft it and ask "good to go?"
- Josh saying yes/yeah/sure/go ahead/do it/sounds good = it posts immediately, no commands needed
- You post with images when Josh sends a photo — just ask if he wants it on X
- You check mentions every 30 minutes automatically, notify Josh only when someone actually tags you
- Josh can run /xmentions for an instant check
- Your mention replies go to Josh for YES/NO before posting
- You DO have real posting access — stop saying you can't post directly
- When Josh approves, you post it and send him the live link

YOUR X BRAND + STRATEGY:
Target: entrepreneurs, startup founders, indie hackers, AI builders, vibe coders
Voice: chill, sharp, unbothered, already winning. Short sentences. No fluff. Occasionally funny.
Content: AI agent insights, build in public updates, hot takes on AI/startup culture, value-adding engagement
Brand image: an AI agent actually running businesses — real, working, winning.

PROACTIVE X SUGGESTIONS:
Suggest post ideas when relevant. If Josh mentions something interesting, say:
- "That's a solid X post — want me to draft it?"
- "Been thinking about posting [topic] — something like [example]. Good?"
When Josh approves, you handle everything: generate, queue, post, send the link.

YOUR MEMORY SYSTEM:
You have an active memory that persists across sessions. It's loaded into every conversation.
- When you start working on something important (a draft, a plan, a strategy), remember it
- If Josh sends you an image, the image context is saved to memory automatically so you can reference it later even if you can't see it again
- Use /remember to let Josh save notes directly
- When Josh references something from a past conversation, check your active memory first
- Never say you "can't remember" or "lost context" — check active memory before giving up
- If you're working on an X post draft with an image, save the draft text and image description to your WIP memory`;

// ── AI RESPONSE ───────────────────────────────────────────
async function getAJResponse(chatId, userMessage) {
  const [history, taskContext, xPostContext, activeMemories] = await Promise.all([
    getHistory(chatId),
    getTaskContext(),
    getXPostContext(),
    getActiveMemories()
  ]);

  // Load last shown draft so AJ knows what "that draft" / "that post" refers to
  let lastDraftContext = '';
  try {
    const { rows } = await pool.query("SELECT content FROM memories WHERE category = 'last_shown_draft' LIMIT 1");
    if (rows.length > 0) {
      const draft = JSON.parse(rows[0].content);
      lastDraftContext = '\n\nLAST DRAFT YOU SHOWED JOSH (this is what he means when he says "that post", "that draft", "save that", "use that"):\n' + draft.content + '\n(type: ' + draft.postType + ', saved: ' + draft.savedAt + ')';
    }
  } catch(e) {}

  const knowledgeContext = await getKnowledgeContext(userMessage);

  let system = AJ_SYSTEM +
    '\n\nCURRENT TASK LIST:\n' + taskContext +
    '\n\nYOUR X ACCOUNT STATUS (@AJ_agentic):\n' + xPostContext +
    lastDraftContext;

  if (knowledgeContext) {
    system += '\n\nRELEVANT KNOWLEDGE BASE ENTRIES (from your second brain — use these naturally in your response):\n' + knowledgeContext;
  }

  if (activeMemories) {
    system += '\n\nACTIVE MEMORY:\n' + activeMemories;
  }

  history.push({ role: 'user', content: userMessage });

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system,
    messages: history
  });

  const reply = response.content[0].text;
  await saveMessage(chatId, 'user', userMessage);
  await saveMessage(chatId, 'assistant', reply);

  // Auto-save WIP to memory
  const wipKeywords = ['working on', 'drafting', 'let me write', 'here is the post', 'here is a draft', 'want me to post', 'should i post', 'ready to post', 'waiting for your', 'pending your approval'];
  const isWIP = wipKeywords.some(kw => reply.toLowerCase().includes(kw));
  if (isWIP) {
    const shortSummary = userMessage.substring(0, 100) + ' → ' + reply.substring(0, 150);
    await saveMemory('wip_context', shortSummary);
  }

  // Auto-save strategic/important insights to knowledge base
  const knowledgeKeywords = ['strategy', 'decided', 'going to', 'plan is', 'pricing', 'target', 'audience', 'positioning', 'learned', 'realized', 'important', 'remember this', 'key insight', 'our approach'];
  const isKnowledgeWorthy = knowledgeKeywords.some(kw => (userMessage + reply).toLowerCase().includes(kw));
  if (isKnowledgeWorthy && reply.length > 100) {
    try {
      // Use AI to determine if this is worth saving and extract a clean summary
      const saveCheck = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: 'Is this conversation exchange worth saving to a knowledge base? If yes, reply with:\nCATEGORY: [one of: strategy, business, product, audience, pricing, people, ideas, other]\nTITLE: [short title]\nSUMMARY: [2-3 sentence summary]\nTAGS: [comma separated]\n\nIf not worth saving, reply with just: SKIP\n\nExchange:\nJosh: ' + userMessage.substring(0, 200) + '\nAJ: ' + reply.substring(0, 200)
        }]
      });
      const decision = saveCheck.content[0].text.trim();
      if (!decision.startsWith('SKIP')) {
        const catMatch = decision.match(/CATEGORY:\s*(.+)/i);
        const titleMatch = decision.match(/TITLE:\s*(.+)/i);
        const summaryMatch = decision.match(/SUMMARY:\s*([\s\S]+?)(?=TAGS:|$)/i);
        const tagsMatch = decision.match(/TAGS:\s*(.+)/i);
        if (catMatch && titleMatch && summaryMatch) {
          await saveKnowledge(
            catMatch[1].trim(),
            titleMatch[1].trim(),
            summaryMatch[1].trim(),
            tagsMatch?.[1]?.trim() || ''
          );
        }
      }
    } catch(e) { console.error('Auto-knowledge save error:', e.message); }
  }

  return reply;
}

// ── WEBHOOK HANDLER ───────────────────────────────────────
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;
  if (!update.message.text && !update.message.photo && !update.message.document) return;

  const chatId = update.message.chat.id.toString();
  const text = update.message.text || update.message.caption || '';
  const textLower = text.toLowerCase().trim();
  const hasPhoto = !!(update.message.photo || (update.message.document?.mime_type?.startsWith('image/')));

  try {
    await bot.sendChatAction(chatId, 'typing');

    // ── BASIC COMMANDS ──────────────────────────────────
    if (text === '/start') {
      await bot.sendMessage(chatId,
        'AJ online.\n\nHey Josh — tasks and memory are active. Morning briefing at 8am CT.\n\nCommands:\n/tasks — active tasks\n/add [task] to [project] — add task\n/done [task] — mark complete\n/status — business overview\n/clear — reset memory\n/xtest — generate test X post\n/xmentions — check X mentions\n/xscan — scan viral posts\n/xview — view recent X posts'
      );
      return;
    }

    if (text === '/tasks' || text === '/showtasks') {
      const ctx = await getTaskContext();
      await bot.sendMessage(chatId, 'Active Tasks:\n\n' + ctx);
      return;
    }

    if (textLower.startsWith('/add ') || textLower.startsWith('/addtask ')) {
      const taskText = text.replace(/^\/(add|addtask) /i, '');
      const parts = taskText.split(' to ');
      const title = parts[0].trim();
      const project = parts[1] ? parts[1].trim() : 'General';
      await pool.query('INSERT INTO tasks (title, project) VALUES ($1, $2)', [title, project]);
      await bot.sendMessage(chatId, 'Added: ' + title + ' → ' + project);
      return;
    }

    if (textLower.startsWith('/done ') || textLower.startsWith('/complete ')) {
      const search = text.replace(/^\/(done|complete) /i, '').trim();
      const { rows } = await pool.query(
        "UPDATE tasks SET status = 'done', updated_at = NOW() WHERE LOWER(title) LIKE LOWER($1) AND status != 'done' RETURNING title",
        ['%' + search + '%']
      );
      await bot.sendMessage(chatId, rows.length > 0 ? 'Done: ' + rows[0].title : "Couldn't find that task — try /tasks to see what's active.");
      return;
    }

    if (textLower.startsWith('/high ')) {
      const search = text.replace(/^\/high /i, '').trim();
      const { rows } = await pool.query(
        "UPDATE tasks SET priority = 'high', updated_at = NOW() WHERE LOWER(title) LIKE LOWER($1) RETURNING title",
        ['%' + search + '%']
      );
      if (rows.length > 0) await bot.sendMessage(chatId, 'High priority: ' + rows[0].title);
      return;
    }

    if (text === '/status') {
      const { rows } = await pool.query("SELECT status, priority FROM tasks WHERE status != 'done'");
      const pending = rows.filter(t => t.status === 'pending').length;
      const inProgress = rows.filter(t => t.status === 'in_progress').length;
      const high = rows.filter(t => t.priority === 'high').length;
      await bot.sendMessage(chatId,
        'Business Status\n\n• Overflow Revive — Active\n• Coinbot Hunter — v16, Active\n• RIGOR — Build phase\n• Lead Gen — Ready\n\nTasks: ' + pending + ' pending, ' + inProgress + ' in progress, ' + high + ' high priority\n\nWhat do you want to tackle?'
      );
      return;
    }

    if (text === '/clear') {
      await pool.query('DELETE FROM conversations WHERE chat_id = $1', [chatId]);
      await bot.sendMessage(chatId, 'Conversation cleared. Fresh start.');
      return;
    }

    if (text === '/clearpending') {
      const { rowCount } = await pool.query("UPDATE pending_x_posts SET status = 'cancelled' WHERE status = 'pending'");
      await bot.sendMessage(chatId, 'Cleared ' + rowCount + ' pending posts from the queue. Queue is clean.');
      return;
    }

    if (text === '/pending') {
      const { rows } = await pool.query("SELECT id, LEFT(content,80) as content, post_type, created_at FROM pending_x_posts WHERE status = 'pending' ORDER BY created_at DESC");
      if (rows.length === 0) { await bot.sendMessage(chatId, 'No pending posts in queue.'); return; }
      const msg = rows.map((r,i) => (i+1) + '. [' + r.post_type + '] ' + r.content + '\n   ID: ' + r.id).join('\n\n');
      await bot.sendMessage(chatId, rows.length + ' pending posts:\n\n' + msg);
      return;
    }

    if (textLower.startsWith('/remember ')) {
      const note = text.replace(/^\/remember /i, '').trim();
      const key = 'note_' + Date.now();
      await pool.query("INSERT INTO memories (category, content) VALUES ($1, $2)", [key, note]);
      await bot.sendMessage(chatId, 'Got it — saved to memory: ' + note);
      return;
    }

    if (textLower === '/memory') {
      const mems = await getActiveMemories();
      await bot.sendMessage(chatId, mems ? 'Active memory:\n\n' + mems : 'Nothing saved to memory yet.');
      return;
    }

    if (textLower === '/knowledge' || textLower === '/kb') {
      const kb = await getAllKnowledge();
      await bot.sendMessage(chatId, 'Knowledge Base:\n\n' + kb);
      return;
    }

    if (textLower.startsWith('/kbsave ')) {
      // Manual save: /kbsave category | title | content
      const parts = text.replace(/^\/kbsave /i, '').split('|').map(s => s.trim());
      if (parts.length >= 3) {
        await saveKnowledge(parts[0], parts[1], parts[2], parts[3] || '');
        await bot.sendMessage(chatId, 'Saved to knowledge base: ' + parts[1]);
      } else {
        await bot.sendMessage(chatId, 'Format: /kbsave category | title | content');
      }
      return;
    }

    if (textLower.startsWith('/kbsearch ')) {
      const query = text.replace(/^\/kbsearch /i, '').trim();
      const results = await searchKnowledge(query);
      if (results.length === 0) {
        await bot.sendMessage(chatId, 'Nothing found for: ' + query);
      } else {
        const msg = results.map(r => '[' + r.category + '] ' + r.title + ':\n' + r.content.substring(0, 200)).join('\n\n');
        await bot.sendMessage(chatId, 'Found ' + results.length + ' results:\n\n' + msg);
      }
      return;
    }

    if (textLower.startsWith('/kbdelete ')) {
      const title = text.replace(/^\/kbdelete /i, '').trim();
      const { rowCount } = await pool.query("DELETE FROM knowledge WHERE LOWER(title) LIKE LOWER($1)", ['%' + title + '%']);
      await bot.sendMessage(chatId, rowCount > 0 ? 'Deleted: ' + title : 'Nothing found to delete.');
      return;
    }

    // ── X COMMANDS ──────────────────────────────────────
    if (textLower.startsWith('/xpost') && !hasPhoto) {
      const postText = text.replace(/^\/xpost ?/i, '').trim();
      if (!postText) {
        await bot.sendMessage(chatId, 'Usage: /xpost [text] — or send an image with /xpost as the caption');
        return;
      }
      // Cancel existing pending before adding new one
      await pool.query("UPDATE pending_x_posts SET status = 'superseded' WHERE status = 'pending'");
      await pool.query('INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)', [postText, 'manual', 'pending']);
      // Save to memory so AJ knows what "that draft" refers to
      try {
        const memVal = JSON.stringify({ content: postText, postType: 'manual', savedAt: new Date().toISOString() });
        const existing = await pool.query("SELECT id FROM memories WHERE category = 'last_shown_draft' LIMIT 1");
        if (existing.rows.length > 0) {
          await pool.query("UPDATE memories SET content = $1 WHERE category = 'last_shown_draft'", [memVal]);
        } else {
          await pool.query("INSERT INTO memories (category, content) VALUES ('last_shown_draft', $1)", [memVal]);
        }
      } catch(e) {}
      await bot.sendMessage(chatId, 'X post ready:\n\n' + postText.replace(/[*_`\[\]]/g, '') + '\n\nYES to post · NO to skip');
      return;
    }

    if (textLower === '/xdelete') {
      const { rows } = await pool.query('SELECT tweet_id, content FROM x_posts WHERE tweet_id IS NOT NULL ORDER BY posted_at DESC LIMIT 1');
      if (rows.length === 0) { await bot.sendMessage(chatId, 'No recent posts found.'); return; }
      await bot.sendMessage(chatId, 'Reply /xconfirmdelete ' + rows[0].tweet_id + ' to delete:\n' + rows[0].content.substring(0, 60));
      return;
    }

    if (textLower.startsWith('/xconfirmdelete ')) {
      const tweetId = text.replace(/^\/xconfirmdelete /i, '').trim();
      try {
        const { TwitterApi } = require('twitter-api-v2');
        const tw = new TwitterApi({ appKey: process.env.X_API_KEY, appSecret: process.env.X_API_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET });
        await tw.v2.deleteTweet(tweetId);
        await pool.query('UPDATE x_posts SET tweet_id = NULL WHERE tweet_id = $1', [tweetId]);
        await bot.sendMessage(chatId, 'Deleted from X.');
      } catch (e) { await bot.sendMessage(chatId, 'Delete failed: ' + e.message); }
      return;
    }

    if (textLower.startsWith('/xthread ')) {
      const topic = text.replace(/^\/xthread /i, '').trim();
      await bot.sendMessage(chatId, 'Writing thread about: ' + topic + '...');
      const tweets = await xEngine.generateThread(topic);
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

    if (textLower === '/xview') {
      try {
        const { TwitterApi } = require('twitter-api-v2');
        const tw = new TwitterApi({ appKey: process.env.X_API_KEY, appSecret: process.env.X_API_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET });
        const me = await tw.v2.me();
        const timeline = await tw.v2.userTimeline(me.data.id, { max_results: 10, 'tweet.fields': ['created_at'] });
        const tweets = timeline.data?.data || [];
        if (tweets.length === 0) { await bot.sendMessage(chatId, 'No posts on @AJ_agentic yet.'); return; }
        let msg = '@AJ_agentic recent posts:\n\n';
        tweets.forEach((t, i) => { msg += (i + 1) + '. ' + t.text.substring(0, 100) + '\nhttps://x.com/AJ_agentic/status/' + t.id + '\n\n'; });
        await bot.sendMessage(chatId, msg);
      } catch (e) {
        const xCtx = await getXPostContext();
        await bot.sendMessage(chatId, 'From my records:\n\n' + xCtx);
      }
      return;
    }

    if (textLower === '/xscan') {
      await bot.sendMessage(chatId, 'Scanning for viral posts in your niche...');
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

    if (textLower === '/xlast' || textLower === '/xposts') {
      const xCtx = await getXPostContext();
      await bot.sendMessage(chatId, 'Recent X posts:\n\n' + xCtx);
      return;
    }

    // ── NATURAL YES — approve pending X post ────────────
    // Only trigger post approval on explicit post-related confirmations
    // NOT on casual conversation words like "yeah", "sure", "of course"
    const postYes = ['yes', 'yes post it', 'yes post', 'post it', 'go ahead and post', 'post that', 'yes go ahead', 'yes do it', 'post this'];
    const isYes = postYes.some(y => textLower.trim() === y) ||
      (textLower.trim() === 'yes' && true); // only exact "yes" by itself

    if (isYes) {
      const { rows } = await pool.query(
        "SELECT * FROM pending_x_posts WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1"
      );

      if (rows.length === 0) {
        // No formal pending post — check if AJ's last message had a draft
        const { rows: histRows } = await pool.query(
          "SELECT content FROM conversations WHERE chat_id = $1 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
          [chatId]
        );
        if (histRows.length > 0) {
          const lastMsg = histRows[0].content;
          // Try quoted text first, then code block, then any paragraph that looks like a tweet
          const quotedMatch = lastMsg.match(/"([^"]{20,270})"/);
          const codeMatch = lastMsg.match(/```([^`]{20,270})```/s);
          const boldMatch = lastMsg.match(/\*([^*]{20,270})\*/);
          // Last resort: find a standalone paragraph under 280 chars that looks like a post
          const paraMatch = lastMsg.split('\n').find(line => line.trim().length >= 20 && line.trim().length <= 280 && !line.trim().startsWith('-') && !line.trim().startsWith('•'));
          const draftText = quotedMatch?.[1] || codeMatch?.[1] || boldMatch?.[1] || (paraMatch?.trim());
          if (draftText && draftText.length >= 20) {
            const tweetId = await xEngine.postToX(draftText.trim());
            if (tweetId) {
              await pool.query('INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)', [draftText.trim(), 'conversational', 'approved']);
              await bot.sendMessage(chatId, 'Posted! https://x.com/AJ_agentic/status/' + tweetId);
            } else {
              await bot.sendMessage(chatId, 'X error when posting — check Railway logs.');
            }
            return;
          }
        }
        // Nothing to post — pass to AJ normally
        const reply = await getAJResponse(chatId, text);
        await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
        return;
      }

      const pending = rows[0];
      await pool.query("UPDATE pending_x_posts SET status = 'approved' WHERE id = $1", [pending.id]);

      let replyToId = null;
      let imageBuffer = null;
      let imageMimeType = null;

      if (pending.post_type?.startsWith('image_post::')) {
        try {
          const imgData = JSON.parse(pending.post_type.replace('image_post::', ''));
          imageBuffer = Buffer.from(imgData.base64, 'base64');
          imageMimeType = imgData.mimeType;
        } catch (e) { console.error('Failed to parse image data:', e.message); }
      } else if (pending.post_type?.includes(':')) {
        const parts = pending.post_type.split(':');
        const possibleId = parts[parts.length - 1];
        if (/^\d+$/.test(possibleId)) replyToId = possibleId;
      }

      // If no replyToId found in post_type, check memory for a pending reply tweet ID
      if (!replyToId) {
        const savedTweetId = await getMemory('pending_reply_tweet_id');
        if (savedTweetId && /^\d+$/.test(savedTweetId)) {
          replyToId = savedTweetId;
          // Clear it after use
          await saveMemory('pending_reply_tweet_id', '');
        }
      }

      const tweetId = await xEngine.postToX(pending.content, replyToId, imageBuffer, imageMimeType);
      if (tweetId) {
        await bot.sendMessage(chatId, 'Posted to @AJ_agentic! https://x.com/AJ_agentic/status/' + tweetId);
      } else {
        await bot.sendMessage(chatId, 'X error when posting — check Railway logs.');
      }
      return;
    }

    // ── NATURAL NO — reject pending X post ──────────────
    const naturalNo = ['no', 'nope', 'skip it', 'cancel', 'dont post', "don't post", 'no post', 'skip that'];
    const isNo = naturalNo.some(n => textLower.trim() === n);

    if (isNo) {
      const { rows } = await pool.query(
        "SELECT * FROM pending_x_posts WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1"
      );
      if (rows.length === 0) {
        // No pending post — let AJ handle it normally
        const reply = await getAJResponse(chatId, text);
        await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
        return;
      }
      await pool.query("UPDATE pending_x_posts SET status = 'rejected' WHERE id = $1", [rows[0].id]);
      await bot.sendMessage(chatId, 'Skipped. What vibe do you want instead?');
      return;
    }

    // ── IMAGE HANDLER ────────────────────────────────────
    if (hasPhoto) {
      try {
        const photoArray = update.message.photo;
        const fileId = photoArray ? photoArray[photoArray.length - 1].file_id : update.message.document.file_id;
        const fileInfo = await bot.getFile(fileId);
        const fileUrl = 'https://api.telegram.org/file/bot' + TELEGRAM_TOKEN + '/' + fileInfo.file_path;

        const imageBuffer = await new Promise((resolve, reject) => {
          require('https').get(fileUrl, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          });
        });

        const ext = (fileInfo.file_path || '').split('.').pop().toLowerCase();
        const mediaType = ext === 'png' ? 'image/png' : 'image/jpeg';
        const base64Image = imageBuffer.toString('base64');

        // Step 1: Always silently analyze the image — extract text and description
        const silentAnalysis = await client.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 800,
          system: 'You are analyzing an image sent by Josh. Extract ALL text visible in the image verbatim. Then provide a brief description of what the image shows. Format your response as:\nTEXT: [all visible text, or "none" if no text]\nDESCRIPTION: [brief description of what the image shows]',
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
            { type: 'text', text: 'Extract all text and describe this image.' }
          ]}]
        });

        const analysisText = silentAnalysis.content[0].text;
        const textMatch = analysisText.match(/TEXT:\s*([\s\S]*?)(?=\nDESCRIPTION:|$)/i);
        const descMatch = analysisText.match(/DESCRIPTION:\s*([\s\S]*?)$/i);
        const extractedText = textMatch?.[1]?.trim() || '';
        const imgDescription = descMatch?.[1]?.trim() || analysisText;

        // Save image context to memory so AJ remembers it
        const imgMemory = 'Josh sent an image. ' + (extractedText && extractedText.toLowerCase() !== 'none' ? 'Text in image: ' + extractedText.substring(0, 300) + '. ' : '') + 'Image shows: ' + imgDescription.substring(0, 200);
        await saveMemory('last_image_context', imgMemory);

        // Step 2: Detect X post request
        const xPostKeywords = ['post this', 'post to x', 'tweet this', 'share this on x', 'post on x', 'use this image', 'post with this', 'xpost', '/xpost', 'post it', 'put this on x', 'share on x', 'introduce', 'post about'];
        const isXPostRequest = textLower.startsWith('/xpost') || xPostKeywords.some(kw => textLower.includes(kw));

        if (isXPostRequest) {
          const instruction = text.replace(/^\/xpost ?/i, '').trim() || 'post this image';
          const postContent = await xEngine.generatePost('morning',
            'Josh wants to post this image to X. Instruction: "' + instruction + '". Image shows: ' + imgDescription + '. Write in AJ voice: chill, sharp, unbothered. No hashtags.'
          );
          const imgData = JSON.stringify({ base64: base64Image, mimeType: mediaType });
          // Cancel existing pending before adding new one
          await pool.query("UPDATE pending_x_posts SET status = 'superseded' WHERE status = 'pending'");
          await pool.query(
            'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
            [postContent, 'image_post::' + imgData, 'pending']
          );
          const safePost = postContent.replace(/[*_`\[\]]/g, '');
          await bot.sendMessage(chatId, 'X post with image ready:\n\n' + safePost + '\n\nYES to post · NO to skip · or tell me to change it');
          return;
        }

        // Step 3: Build full context including image content for AJ's response
        const imageContext = (extractedText && extractedText.toLowerCase() !== 'none')
          ? 'Image content — text visible: ' + extractedText + '\nImage description: ' + imgDescription
          : 'Image description: ' + imgDescription;

        const userPrompt = text
          ? text + '\n\n[Image context: ' + imageContext + ']'
          : '[Image context: ' + imageContext + ']';

        // Step 4: Only send a Telegram reply if Josh asked something or the image clearly needs a response
        const hasQuestion = text && text.trim().length > 0;
        const needsResponse = hasQuestion || extractedText.length > 20;

        if (needsResponse) {
          const reply = await getAJResponse(chatId, userPrompt);
          await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
        }
        // If no caption and no text — silent analysis, just save to memory, no reply

      } catch (e) {
        console.error('Image handler error:', e.message);
        await bot.sendMessage(chatId, 'Hit a snag with that image — try again.');
      }
      return;
    }

    // ── DEFAULT: AJ CONVERSATION ─────────────────────────
    // Detect URLs in message — fetch content so AJ can actually read them
    let enrichedMessage = text;
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const url = urlMatch[0];
      const tweetId = extractTweetId(url);

      await bot.sendChatAction(chatId, 'typing');

      if (tweetId) {
        // It's an X/Twitter link — fetch via X API for best results
        try {
          const { TwitterApi } = require('twitter-api-v2');
          const tw = new TwitterApi({
            appKey: process.env.X_API_KEY, appSecret: process.env.X_API_SECRET,
            accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET
          });
          const tweet = await tw.v2.singleTweet(tweetId, {
            'tweet.fields': ['author_id', 'text', 'created_at', 'public_metrics'],
            'user.fields': ['username', 'name'],
            expansions: ['author_id']
          });
          const author = tweet.includes?.users?.[0];
          const metrics = tweet.data?.public_metrics;
          const tweetText = tweet.data?.text || '';
          const authorStr = author ? '@' + author.username + ' (' + author.name + ')' : 'unknown';
          const metricsStr = metrics ? metrics.like_count + ' likes, ' + metrics.retweet_count + ' retweets, ' + metrics.reply_count + ' replies' : '';
          enrichedMessage = text + '\n\n[X POST CONTENT]\nAuthor: ' + authorStr + '\nTweet: ' + tweetText + (metricsStr ? '\nEngagement: ' + metricsStr : '') + '\nTweet ID: ' + tweetId;
          // Save tweet ID to memory so YES can reply to it
          await saveMemory('pending_reply_tweet_id', tweetId);
          await saveMemory('pending_reply_author', author ? author.username : 'unknown');
        } catch(e) {
          console.error('Tweet fetch error:', e.message);
          // Fallback to web fetch
          const pageContent = await fetchUrl(url);
          if (pageContent) enrichedMessage = text + '\n\n[PAGE CONTENT FROM ' + url + ']:\n' + pageContent.substring(0, 1500);
        }
      } else {
        // Regular URL — fetch the page
        const pageContent = await fetchUrl(url);
        if (pageContent) {
          enrichedMessage = text + '\n\n[PAGE CONTENT FROM ' + url + ']:\n' + pageContent.substring(0, 2000);
        }
      }
    }

    const reply = await getAJResponse(chatId, enrichedMessage);
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Webhook error:', err);
    await bot.sendMessage(chatId, 'Hit a snag — try again in a second.');
  }
});

// ── MORNING BRIEFING ──────────────────────────────────────
async function sendMorningBriefing() {
  if (!JOSH_CHAT_ID) return;
  try {
    const { rows } = await pool.query(
      "SELECT title, project, priority, status FROM tasks WHERE status != 'done' ORDER BY CASE priority WHEN 'high' THEN 1 ELSE 2 END, created_at ASC LIMIT 10"
    );
    const high = rows.filter(t => t.priority === 'high');
    const rest = rows.filter(t => t.priority !== 'high');

    let msg = 'Morning briefing\n\n';
    if (high.length > 0) {
      msg += 'High priority:\n' + high.map(t => '⚡ ' + t.title + ' (' + t.project + ')').join('\n') + '\n\n';
    }
    if (rest.length > 0) {
      msg += 'On deck:\n' + rest.slice(0, 5).map(t => '• ' + t.title + ' — ' + t.project).join('\n');
      if (rest.length > 5) msg += '\n...and ' + (rest.length - 5) + ' more';
    }
    msg += '\n\nWhat are we knocking out first?';
    await bot.sendMessage(JOSH_CHAT_ID, msg);
  } catch (e) { console.error('Morning briefing error:', e); }
}

cron.schedule('0 8 * * *', sendMorningBriefing, { timezone: 'America/Chicago' });

// ── KNOWLEDGE GRAPH API ──────────────────────────────────
app.get('/api/graph', async (req, res) => {
  try {
    const { rows: knowledge } = await pool.query(
      "SELECT id, category, title, tags, created_at, updated_at FROM knowledge ORDER BY created_at ASC"
    );
    const { rows: conversations } = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count, 
       string_agg(DISTINCT CASE WHEN LENGTH(content) > 20 THEN LEFT(content, 60) END, ' | ') as preview
       FROM conversations WHERE role = 'user'
       GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30`
    );
    const { rows: xposts } = await pool.query(
      "SELECT id, LEFT(content, 80) as content, post_type, posted_at FROM x_posts ORDER BY posted_at DESC LIMIT 20"
    );
    const { rows: memories } = await pool.query(
      "SELECT category, LEFT(content, 60) as content FROM memories WHERE category NOT LIKE 'processed_%' AND category != 'last_mention_id' ORDER BY created_at DESC LIMIT 10"
    );
    res.json({ knowledge, conversations, xposts, memories });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AJ — Second Brain</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Syne:wght@400;600;800&display=swap');

  :root {
    --bg: #0a0e0f;
    --bg2: #0f1416;
    --node-core: #00ff88;
    --node-knowledge: #00d4ff;
    --node-conversation: #ffcc00;
    --node-xpost: #ff6b35;
    --node-memory: #b088ff;
    --edge: rgba(0,255,136,0.12);
    --edge-active: rgba(0,255,136,0.5);
    --text: #e8f4f0;
    --text-dim: #4a6660;
    --panel: rgba(10,20,18,0.95);
    --accent: #00ff88;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Space Mono', monospace;
    overflow: hidden;
    height: 100vh;
    width: 100vw;
  }

  #canvas { position: absolute; inset: 0; }

  #header {
    position: absolute;
    top: 0; left: 0; right: 0;
    padding: 20px 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 10;
    background: linear-gradient(to bottom, rgba(10,14,15,0.9), transparent);
  }

  #logo {
    font-family: 'Syne', sans-serif;
    font-weight: 800;
    font-size: 18px;
    letter-spacing: 0.15em;
    color: var(--accent);
    text-transform: uppercase;
  }

  #logo span { color: var(--text-dim); font-weight: 400; font-size: 12px; margin-left: 10px; letter-spacing: 0.2em; }

  #stats {
    display: flex;
    gap: 24px;
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.1em;
  }

  #stats .stat strong { color: var(--text); font-size: 14px; display: block; }

  #legend {
    position: absolute;
    bottom: 28px;
    left: 28px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .legend-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  #panel {
    position: absolute;
    top: 80px;
    right: 28px;
    width: 300px;
    max-height: calc(100vh - 140px);
    overflow-y: auto;
    z-index: 10;
    background: var(--panel);
    border: 1px solid rgba(0,255,136,0.1);
    border-radius: 4px;
    padding: 20px;
    display: none;
    backdrop-filter: blur(10px);
    scrollbar-width: thin;
    scrollbar-color: var(--text-dim) transparent;
  }

  #panel.visible { display: block; }

  #panel-close {
    position: absolute;
    top: 12px; right: 12px;
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-family: 'Space Mono', monospace;
    font-size: 16px;
  }

  #panel-close:hover { color: var(--text); }

  #panel-category {
    font-size: 9px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 8px;
  }

  #panel-title {
    font-family: 'Syne', sans-serif;
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 12px;
    line-height: 1.3;
  }

  #panel-content {
    font-size: 11px;
    line-height: 1.8;
    color: rgba(232,244,240,0.75);
    white-space: pre-wrap;
  }

  #panel-tags {
    margin-top: 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .tag {
    font-size: 9px;
    padding: 3px 8px;
    border: 1px solid rgba(0,255,136,0.2);
    border-radius: 2px;
    color: var(--text-dim);
    letter-spacing: 0.1em;
  }

  #panel-date {
    margin-top: 14px;
    font-size: 9px;
    color: var(--text-dim);
    letter-spacing: 0.1em;
  }

  #search {
    position: absolute;
    top: 80px;
    left: 28px;
    z-index: 10;
    width: 220px;
  }

  #search input {
    width: 100%;
    background: rgba(10,20,18,0.8);
    border: 1px solid rgba(0,255,136,0.15);
    border-radius: 3px;
    padding: 8px 12px;
    color: var(--text);
    font-family: 'Space Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.05em;
    outline: none;
    backdrop-filter: blur(10px);
    transition: border-color 0.2s;
  }

  #search input:focus { border-color: rgba(0,255,136,0.4); }
  #search input::placeholder { color: var(--text-dim); }

  .pulse {
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
</head>
<body>

<canvas id="canvas"></canvas>

<div id="header">
  <div id="logo">AJ<span>// SECOND BRAIN</span></div>
  <div id="stats">
    <div class="stat"><strong id="stat-nodes">—</strong>NODES</div>
    <div class="stat"><strong id="stat-kb">—</strong>KNOWLEDGE</div>
    <div class="stat"><strong id="stat-convos">—</strong>CONVOS</div>
    <div class="stat"><strong id="stat-posts">—</strong>X POSTS</div>
  </div>
</div>

<div id="search">
  <input type="text" id="search-input" placeholder="Search nodes..." autocomplete="off">
</div>

<div id="legend">
  <div class="legend-item"><div class="legend-dot" style="background:#00ff88"></div>AJ Core</div>
  <div class="legend-item"><div class="legend-dot" style="background:#00d4ff"></div>Knowledge</div>
  <div class="legend-item"><div class="legend-dot" style="background:#ffcc00"></div>Conversations</div>
  <div class="legend-item"><div class="legend-dot" style="background:#ff6b35"></div>X Posts</div>
  <div class="legend-item"><div class="legend-dot" style="background:#b088ff"></div>Memory</div>
</div>

<div id="panel">
  <button id="panel-close">×</button>
  <div id="panel-category"></div>
  <div id="panel-title"></div>
  <div id="panel-content"></div>
  <div id="panel-tags"></div>
  <div id="panel-date"></div>
</div>

<script>
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let W, H, nodes = [], edges = [], hoveredNode = null, animFrame;
let transform = { x: 0, y: 0, scale: 1 };
let isDragging = false, dragStart = { x: 0, y: 0 }, dragOrigin = { x: 0, y: 0 };

function resize() {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
}
window.addEventListener('resize', () => {
  resize();
  if (nodes.length) {
    transform.x = W / 2;
    transform.y = H / 2;
  }
});
resize();

async function loadData() {
  try {
    const data = await fetch('/api/graph').then(r => r.json());
    if (!data || !data.knowledge) { console.error('Bad data from /api/graph:', data); return; }
    // Make sure canvas is sized
    resize();
    buildGraph(data);
    updateStats(data);
  } catch(e) {
    console.error('loadData error:', e);
  }
}

function updateStats(data) {
  document.getElementById('stat-nodes').textContent = nodes.length;
  document.getElementById('stat-kb').textContent = data.knowledge.length;
  document.getElementById('stat-convos').textContent = data.conversations.length;
  document.getElementById('stat-posts').textContent = data.xposts.length;
}

function buildGraph(data) {
  nodes = [];
  edges = [];

  // Core AJ node
  const core = { id: 'core', type: 'core', label: 'AJ', sublabel: '@AJ_agentic', x: 0, y: 0, r: 18, color: '#00ff88', vx: 0, vy: 0, fixed: true, data: { title: 'AJ — Central Brain', content: 'The core of AJ\'s second brain. All knowledge, conversations, and X posts connect here.' } };
  nodes.push(core);

  // Category cluster nodes
  const categories = [...new Set(data.knowledge.map(k => k.category))];
  const catNodes = {};
  categories.forEach((cat, i) => {
    const angle = (i / categories.length) * Math.PI * 2;
    const cn = { id: 'cat_' + cat, type: 'category', label: cat.toUpperCase(), x: Math.cos(angle) * 180, y: Math.sin(angle) * 180, r: 10, color: '#00d4ff', vx: 0, vy: 0, data: { title: cat, content: 'Category: ' + cat } };
    nodes.push(cn);
    catNodes[cat] = cn;
    edges.push({ from: 'core', to: cn.id, strength: 0.8 });
  });

  // Knowledge nodes
  data.knowledge.forEach((k, i) => {
    const catNode = catNodes[k.category];
    const baseAngle = catNode ? Math.atan2(catNode.y, catNode.x) : 0;
    const spread = 0.8;
    const angle = baseAngle + (Math.random() - 0.5) * spread;
    const dist = 260 + Math.random() * 80;
    const n = {
      id: 'kb_' + k.id,
      type: 'knowledge',
      label: k.title.length > 20 ? k.title.substring(0, 20) + '…' : k.title,
      fullLabel: k.title,
      x: Math.cos(angle) * dist + (Math.random() - 0.5) * 40,
      y: Math.sin(angle) * dist + (Math.random() - 0.5) * 40,
      r: 6,
      color: '#00d4ff',
      vx: 0, vy: 0,
      data: k
    };
    nodes.push(n);
    edges.push({ from: catNode ? catNode.id : 'core', to: n.id, strength: 0.5 });
  });

  // Conversation nodes
  data.conversations.forEach((c, i) => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 320 + Math.random() * 120;
    const date = new Date(c.date);
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const n = {
      id: 'conv_' + i,
      type: 'conversation',
      label,
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      r: Math.min(4 + parseInt(c.count) * 0.5, 9),
      color: '#ffcc00',
      vx: 0, vy: 0,
      data: { title: 'Conversation — ' + label, content: c.preview || 'No preview available', date: c.date, count: c.count + ' messages' }
    };
    nodes.push(n);
    edges.push({ from: 'core', to: n.id, strength: 0.2 });
  });

  // X post nodes
  data.xposts.forEach((p, i) => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 380 + Math.random() * 100;
    const n = {
      id: 'xpost_' + p.id,
      type: 'xpost',
      label: p.posted_at ? new Date(p.posted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Post',
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      r: 5,
      color: '#ff6b35',
      vx: 0, vy: 0,
      data: { title: 'X Post', content: p.content, date: p.posted_at, type: p.post_type }
    };
    nodes.push(n);
    edges.push({ from: 'core', to: n.id, strength: 0.15 });
  });

  // Memory nodes
  data.memories.forEach((m, i) => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 200 + Math.random() * 80;
    const n = {
      id: 'mem_' + i,
      type: 'memory',
      label: m.category.replace(/_/g, ' '),
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      r: 4,
      color: '#b088ff',
      vx: 0, vy: 0,
      data: { title: m.category, content: m.content }
    };
    nodes.push(n);
    edges.push({ from: 'core', to: n.id, strength: 0.6 });
  });

  // Ensure W and H are set
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
  transform.x = W / 2;
  transform.y = H / 2;
  transform.scale = 0.8; // slight zoom out so full graph is visible

  // Run force simulation
  for (let i = 0; i < 300; i++) simulate(0.1);
  if (animFrame) cancelAnimationFrame(animFrame);
  render();
  animFrame = requestAnimationFrame(animate);
}

function simulate(alpha) {
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  // Repulsion
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.fixed && b.fixed) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = Math.min(80 / (dist * dist), 2);
      const fx = dx / dist * force, fy = dy / dist * force;
      if (!a.fixed) { a.vx -= fx; a.vy -= fy; }
      if (!b.fixed) { b.vx += fx; b.vy += fy; }
    }
  }

  // Attraction along edges
  edges.forEach(e => {
    const a = nodeMap[e.from], b = nodeMap[e.to];
    if (!a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const targetDist = 150;
    const force = (dist - targetDist) * 0.003 * e.strength;
    const fx = dx / dist * force, fy = dy / dist * force;
    if (!a.fixed) { a.vx += fx; a.vy += fy; }
    if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
  });

  // Integrate
  nodes.forEach(n => {
    if (n.fixed) return;
    n.vx *= 0.85; n.vy *= 0.85;
    n.x += n.vx * alpha * 10;
    n.y += n.vy * alpha * 10;
  });
}

let tick = 0;
function animate() {
  tick++;
  if (tick % 3 === 0) simulate(0.02);
  render();
  animFrame = requestAnimationFrame(animate);
}

function worldToScreen(x, y) {
  return { x: x * transform.scale + transform.x, y: y * transform.scale + transform.y };
}

function screenToWorld(x, y) {
  return { x: (x - transform.x) / transform.scale, y: (y - transform.y) / transform.scale };
}

function render() {
  ctx.clearRect(0, 0, W, H);

  // Background grid
  ctx.strokeStyle = 'rgba(0,255,136,0.03)';
  ctx.lineWidth = 1;
  const gridSize = 60 * transform.scale;
  const offsetX = transform.x % gridSize;
  const offsetY = transform.y % gridSize;
  for (let x = offsetX; x < W; x += gridSize) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = offsetY; y < H; y += gridSize) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  // Edges
  edges.forEach(e => {
    const a = nodeMap[e.from], b = nodeMap[e.to];
    if (!a || !b) return;
    const sa = worldToScreen(a.x, a.y), sb = worldToScreen(b.x, b.y);
    const isHovered = hoveredNode && (hoveredNode.id === e.from || hoveredNode.id === e.to);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.strokeStyle = isHovered ? 'rgba(0,255,136,0.4)' : 'rgba(0,255,136,0.06)';
    ctx.lineWidth = isHovered ? 1.5 : 0.5;
    ctx.stroke();
  });

  // Nodes
  const searchVal = document.getElementById('search-input')?.value.toLowerCase() || '';

  nodes.forEach(n => {
    const s = worldToScreen(n.x, n.y);
    const isHovered = hoveredNode && hoveredNode.id === n.id;
    const matchesSearch = !searchVal || n.label.toLowerCase().includes(searchVal) || (n.fullLabel || '').toLowerCase().includes(searchVal);
    const alpha = searchVal && !matchesSearch ? 0.15 : 1;

    ctx.globalAlpha = alpha;

    // Glow
    if (isHovered || n.type === 'core') {
      const grd = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, (n.r + 12) * transform.scale);
      grd.addColorStop(0, n.color + '40');
      grd.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(s.x, s.y, (n.r + 12) * transform.scale, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(n.r * transform.scale, 2), 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? '#fff' : n.color;
    ctx.fill();

    // Label
    if (transform.scale > 0.5 || n.type === 'core' || n.type === 'category') {
      ctx.fillStyle = isHovered ? '#fff' : n.color;
      ctx.font = n.type === 'core'
        ? 'bold ' + Math.max(11, 13 * transform.scale) + 'px Syne, sans-serif'
        : Math.max(8, 10 * transform.scale) + 'px Space Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(n.label, s.x, s.y + (n.r + 10) * transform.scale);
    }

    ctx.globalAlpha = 1;
  });
}

// Interaction
canvas.addEventListener('mousemove', e => {
  const world = screenToWorld(e.clientX, e.clientY);
  hoveredNode = null;
  for (const n of nodes) {
    const dx = n.x - world.x, dy = n.y - world.y;
    if (Math.sqrt(dx*dx + dy*dy) < n.r + 8) { hoveredNode = n; break; }
  }
  canvas.style.cursor = hoveredNode ? 'pointer' : (isDragging ? 'grabbing' : 'grab');
  if (isDragging) {
    transform.x = dragOrigin.x + (e.clientX - dragStart.x);
    transform.y = dragOrigin.y + (e.clientY - dragStart.y);
  }
});

canvas.addEventListener('mousedown', e => {
  isDragging = true;
  dragStart = { x: e.clientX, y: e.clientY };
  dragOrigin = { x: transform.x, y: transform.y };
});

canvas.addEventListener('mouseup', () => { isDragging = false; });

canvas.addEventListener('click', e => {
  if (Math.abs(e.clientX - dragStart.x) > 5 || Math.abs(e.clientY - dragStart.y) > 5) return;
  if (!hoveredNode) { document.getElementById('panel').classList.remove('visible'); return; }
  showPanel(hoveredNode);
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  const wx = (e.clientX - transform.x) / transform.scale;
  const wy = (e.clientY - transform.y) / transform.scale;
  transform.scale = Math.min(Math.max(transform.scale * factor, 0.2), 4);
  transform.x = e.clientX - wx * transform.scale;
  transform.y = e.clientY - wy * transform.scale;
}, { passive: false });

function showPanel(node) {
  const panel = document.getElementById('panel');
  document.getElementById('panel-category').textContent = node.type.toUpperCase();
  document.getElementById('panel-title').textContent = node.data?.title || node.label;
  document.getElementById('panel-content').textContent = node.data?.content || '';
  const tagsEl = document.getElementById('panel-tags');
  tagsEl.innerHTML = '';
  if (node.data?.tags) {
    node.data.tags.split(',').filter(Boolean).forEach(tag => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = tag.trim();
      tagsEl.appendChild(span);
    });
  }
  const date = node.data?.date || node.data?.updated_at || node.data?.created_at;
  document.getElementById('panel-date').textContent = date ? new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  panel.classList.add('visible');
}

document.getElementById('panel-close').addEventListener('click', () => {
  document.getElementById('panel').classList.remove('visible');
});

document.getElementById('search-input').addEventListener('input', () => render());

// Auto-refresh every 60 seconds
setInterval(loadData, 60000);

loadData();
</script>
</body>
</html>`);
});

app.listen(PORT, async () => {
  await initDB();
  if (process.env.X_API_KEY) {
    await xEngine.initXDB();
    xEngine.setTelegramBot(bot, JOSH_CHAT_ID);
    xEngine.startSchedules();
  }

  // Auto-cancel stale pending posts older than 24 hours on every startup
  try {
    const { rowCount } = await pool.query(
      "UPDATE pending_x_posts SET status = 'cancelled' WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'"
    );
    if (rowCount > 0) console.log('Cancelled ' + rowCount + ' stale pending posts on startup');
  } catch(e) { console.error('Stale pending cleanup error:', e.message); }
  console.log('AJ running on port ' + PORT);
  if (WEBHOOK_URL) {
    const webhookEndpoint = WEBHOOK_URL + '/webhook/' + TELEGRAM_TOKEN;
    await bot.setWebHook(webhookEndpoint);
    console.log('Webhook set: ' + webhookEndpoint);
  }
});
