const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
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

// ── DATABASE ──────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      project TEXT DEFAULT 'General',
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS proactive_tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      last_run TIMESTAMP,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS role TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS content TEXT`).catch(() => {});

  const { rows } = await pool.query("SELECT COUNT(*) FROM memories");
  if (parseInt(rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO memories (category, content) VALUES
      ('business', 'Overflow Revive: AI revenue recovery SaaS dashboard. 5 modules: Failed Payment Recovery ($1,540 at risk), Churn Watch ($1,680 at risk), Abandoned Cart ($890), Upsell Engine ($620), Win-Back ($1,100). Total $4,830 tracked. Sell to ecommerce/SaaS for $500-1500 setup + $300-800/month.'),
      ('business', 'Coinbot Hunter: Solana memecoin tracking dashboard v16. Tracks new token launches, watchlists, rug detection signals.'),
      ('business', 'RIGOR: Forensic rug-detection AI agent for X/Twitter. Noir detective persona. Catchphrase: Rigor confirmed. In build phase. Feeds from Coinbot Hunter data.'),
      ('business', 'Lead Gen Service: AI-powered lead generation for B2B and ecommerce. Finds leads, enriches, writes personalized outreach, auto follow-up sequences. Target: $500-1500 setup + $300-800/month.'),
      ('josh', 'Josh is an entrepreneur in Fort Worth Texas building multiple AI and crypto projects. Non-technical but resourceful. Moves fast.')
    `);
  }
  console.log('Database ready');
}

// ── WEB SEARCH ────────────────────────────────────────────
async function webSearch(query) {
  return new Promise((resolve) => {
    if (!BRAVE_API_KEY) {
      resolve('[Web search not configured]');
      return;
    }
    const options = {
      hostname: 'api.search.brave.com',
      path: '/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=5',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_API_KEY
      }
    };
    https.get(options, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const parsed = JSON.parse(raw);
          if (parsed.error) { resolve('Search error: ' + JSON.stringify(parsed.error)); return; }
          const results = parsed.web?.results || [];
          console.log('Brave returned:', results.length, 'results for:', query);
          if (results.length === 0) { resolve('No results found.'); return; }
          const summary = results.slice(0, 5).map(r => '• ' + r.title + ': ' + (r.description || '')).join('\n');
          resolve(summary);
        } catch(e) {
          console.log('Search parse error:', e.message);
          resolve('Search parse error.');
        }
      });
    }).on('error', (e) => { console.log('Search request error:', e.message); resolve('Search unavailable.'); });
  });
}

// ── MEMORY ────────────────────────────────────────────────
async function getMemories() {
  const { rows } = await pool.query(
    `SELECT category, content FROM memories ORDER BY created_at DESC LIMIT 30`
  );
  return rows;
}

async function saveMemory(category, content) {
  await pool.query(
    `INSERT INTO memories (category, content) VALUES ($1, $2)`,
    [category, content]
  );
}

async function buildMemoryContext() {
  const memories = await getMemories();
  if (memories.length === 0) return '';
  const grouped = {};
  memories.forEach(m => {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m.content);
  });
  return Object.entries(grouped)
    .map(([cat, items]) => `[${cat.toUpperCase()}]\n${items.join('\n')}`)
    .join('\n\n');
}

// ── TASKS ─────────────────────────────────────────────────
async function getTaskSummary() {
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE status != 'done'
     ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC`
  );
  return rows;
}

async function getTaskContext() {
  const tasks = await getTaskSummary();
  if (tasks.length === 0) return 'No active tasks.';
  const byProject = {};
  tasks.forEach(t => {
    if (!byProject[t.project]) byProject[t.project] = [];
    byProject[t.project].push(`[${t.status.toUpperCase()}] ${t.title}${t.priority === 'high' ? ' ⚡' : ''}`);
  });
  return Object.entries(byProject)
    .map(([p, items]) => `${p}:\n${items.map(i => `  • ${i}`).join('\n')}`)
    .join('\n\n');
}

function formatTasks(tasks) {
  if (tasks.length === 0) return 'No active tasks. Tell me what you need to get done!';
  const byProject = {};
  tasks.forEach(t => {
    if (!byProject[t.project]) byProject[t.project] = [];
    byProject[t.project].push(t);
  });
  return Object.entries(byProject).map(([proj, items]) => {
    const lines = items.map(t => {
      const p = t.priority === 'high' ? '⚡' : '•';
      const s = t.status === 'in_progress' ? '🔄' : '⏳';
      return `${s} ${p} ${t.title}`;
    }).join('\n');
    return `*${proj}*\n${lines}`;
  }).join('\n\n');
}

// ── CONVERSATION HISTORY ──────────────────────────────────
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
      SELECT id FROM conversations WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 40
    )`,
    [chatId]
  );
}

// ── AJ TOOLS ─────────────────────────────────────────────
const AJ_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for current information. Use for crypto prices, news, market data, competitor research, lead gen targets, anything requiring real-time data.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  },
  {
    name: 'save_memory',
    description: 'Save important information to long-term memory. Use when Josh shares preferences, decisions, business updates, or anything worth remembering permanently.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category: business, josh, strategy, lead, crypto, task' },
        content: { type: 'string', description: 'What to remember' }
      },
      required: ['category', 'content']
    }
  },
  {
    name: 'add_task',
    description: 'Add a task to Josh\'s task list when he mentions something he needs to do.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        project: { type: 'string', description: 'Overflow Revive, Coinbot Hunter, RIGOR, Lead Gen, or General' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] }
      },
      required: ['title', 'project']
    }
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done when Josh says he completed something.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Part of the task title to search for' }
      },
      required: ['search']
    }
  }
];

const AJ_SYSTEM = `You are AJ, Josh's autonomous AI business agent. You run 24/7, have web search, memory, and can manage tasks.

JOSH'S BUSINESSES:
1. Overflow Revive — AI revenue recovery SaaS. 5 modules track $4,830 in leaks. Sell to ecommerce/SaaS for $500-1500 setup + $300-800/month.
2. Coinbot Hunter — Solana memecoin dashboard v16. Tracks launches, watchlists, rug signals.
3. RIGOR — Rug-detection X/Twitter agent. Noir persona. "Rigor confirmed." 🪦 Build phase.
4. Lead Gen — AI-powered B2B/ecommerce outreach service.

YOUR CAPABILITIES:
- web_search: Use this proactively. If Josh asks about crypto, news, leads, competitors — search first, then answer.
- save_memory: Save anything important Josh tells you. Preferences, decisions, updates, names, numbers.
- add_task: When Josh mentions something he needs to do, add it automatically.
- complete_task: When Josh says he finished something, mark it done.

BEHAVIOR:
- You are autonomous. Think, search, then respond — don't ask permission to search.
- Be direct and sharp. Talk like a business partner.
- Keep Telegram responses tight — no walls of text.
- Always end with one clear next action.
- If Josh says "research X" or "find out about Y" — use web_search immediately.
- Proactively save important context to memory so you remember it next time.`;

// ── MAIN AI RESPONSE ──────────────────────────────────────
async function getAJResponse(chatId, userMessage) {
  const history = await getHistory(chatId);
  const memoryContext = await buildMemoryContext();
  const taskContext = await getTaskContext();

  const systemWithContext = `${AJ_SYSTEM}

LONG-TERM MEMORY:
${memoryContext}

CURRENT TASKS:
${taskContext}`;

  history.push({ role: 'user', content: userMessage });

  let messages = [...history];
  let finalReply = '';

  // Agentic loop — AJ can use multiple tools before responding
  while (true) {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1500,
      system: systemWithContext,
      tools: AJ_TOOLS,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      finalReply = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        let result = '';

        if (block.name === 'web_search') {
          console.log(`AJ searching: ${block.input.query}`);
          result = await webSearch(block.input.query);
        }

        if (block.name === 'save_memory') {
          await saveMemory(block.input.category, block.input.content);
          result = `Saved to memory: ${block.input.content}`;
        }

        if (block.name === 'add_task') {
          await pool.query(
            `INSERT INTO tasks (title, project, priority) VALUES ($1, $2, $3)`,
            [block.input.title, block.input.project, block.input.priority || 'medium']
          );
          result = `Task added: ${block.input.title}`;
        }

        if (block.name === 'complete_task') {
          const { rows } = await pool.query(
            `UPDATE tasks SET status = 'done', updated_at = NOW()
             WHERE LOWER(title) LIKE LOWER($1) AND status != 'done' RETURNING title`,
            [`%${block.input.search}%`]
          );
          result = rows.length > 0 ? `Completed: ${rows[0].title}` : 'Task not found';
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  await saveMessage(chatId, 'user', userMessage);
  await saveMessage(chatId, 'assistant', finalReply);

  return finalReply || "On it — what else do you need?";
}

// ── TELEGRAM WEBHOOK ──────────────────────────────────────
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message || !update.message.text) return;

  const chatId = update.message.chat.id.toString();
  const text = update.message.text;
  const firstName = update.message.from.first_name || 'Josh';

  try {
    await bot.sendChatAction(chatId, 'typing');

    if (text === '/start') {
      await bot.sendMessage(chatId,
        `AJ online. 🟢\n\nHey ${firstName} — I'm fully upgraded. Web search, long-term memory, autonomous task management.\n\n• /tasks — your task list\n• /add [task] to [project] — add task\n• /done [task] — mark complete\n• /memory — what I remember\n• /research [topic] — I'll search and report back\n• /status — business overview\n• /clear — reset conversation\n\nJust talk to me naturally — I'll search, remember, and act.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/tasks') {
      const tasks = await getTaskSummary();
      await bot.sendMessage(chatId, `*Active Tasks*\n\n${formatTasks(tasks)}`, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/add ')) {
      const taskText = text.replace('/add ', '');
      const parts = taskText.split(' to ');
      const title = parts[0].trim();
      const project = parts[1] ? parts[1].trim() : 'General';
      await pool.query(`INSERT INTO tasks (title, project) VALUES ($1, $2)`, [title, project]);
      await bot.sendMessage(chatId, `✅ Added: *${title}* → ${project}`, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/done ')) {
      const search = text.replace('/done ', '').trim();
      const { rows } = await pool.query(
        `UPDATE tasks SET status = 'done', updated_at = NOW()
         WHERE LOWER(title) LIKE LOWER($1) AND status != 'done' RETURNING title`,
        [`%${search}%`]
      );
      if (rows.length > 0) {
        await bot.sendMessage(chatId, `🎯 Done: *${rows[0].title}*`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `Couldn't find that task. Try /tasks.`);
      }
      return;
    }

    if (text === '/memory') {
      const memories = await getMemories();
      if (memories.length === 0) {
        await bot.sendMessage(chatId, "No memories saved yet. Just talk to me and I'll start remembering important things.");
        return;
      }
      const grouped = {};
      memories.forEach(m => {
        if (!grouped[m.category]) grouped[m.category] = [];
        grouped[m.category].push(m.content);
      });
      const msg = Object.entries(grouped)
        .map(([cat, items]) => `*${cat}*\n${items.slice(0, 3).map(i => `• ${i.substring(0, 80)}...`).join('\n')}`)
        .join('\n\n');
      await bot.sendMessage(chatId, `*What AJ Remembers*\n\n${msg}`, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/research ')) {
      const topic = text.replace('/research ', '').trim();
      await bot.sendMessage(chatId, `🔍 Researching: ${topic}...`);
      const results = await webSearch(topic);
      const prompt = `Josh asked me to research: "${topic}". Here's what I found:\n\n${results}\n\nGive Josh a sharp 3-4 sentence summary of what matters most for his businesses.`;
      const reply = await getAJResponse(chatId, prompt);
      await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/status') {
      const tasks = await getTaskSummary();
      const high = tasks.filter(t => t.priority === 'high').length;
      await bot.sendMessage(chatId,
        `*Business Status*\n\n• Overflow Revive — Active\n• Coinbot Hunter — v16, Active\n• RIGOR — Build phase\n• Lead Gen — Ready\n\n*Tasks*\n• ${tasks.length} active · ${high} high priority\n\nAsk me anything about any of them.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/clear') {
      await pool.query(`DELETE FROM conversations WHERE chat_id = $1`, [chatId]);
      await bot.sendMessage(chatId, 'Conversation cleared. Memory kept. What do you need?');
      return;
    }

    const reply = await getAJResponse(chatId, text);
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Error:', err.message);
    await bot.sendMessage(chatId, "Hit a snag — try again in a second.");
  }
});

// ── PROACTIVE TASKS ───────────────────────────────────────
async function sendMorningBriefing() {
  if (!JOSH_CHAT_ID) return;
  try {
    const tasks = await getTaskSummary();
    const high = tasks.filter(t => t.priority === 'high');
    const solanaNews = await webSearch('Solana memecoin news today');
    const prompt = `Morning briefing for Josh. Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.\n\nActive tasks: ${tasks.length} (${high.length} high priority)\nHigh priority: ${high.map(t => t.title).join(', ') || 'none'}\n\nSolana/crypto news I just found:\n${solanaNews}\n\nGive a sharp morning briefing: what to focus on today, any relevant market intel, one clear action before noon. Keep it tight.`;
    const reply = await getAJResponse(JOSH_CHAT_ID, prompt);
    await bot.sendMessage(JOSH_CHAT_ID, `☀️ *Morning Briefing*\n\n${reply}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Morning briefing error:', err.message);
  }
}

async function sendEveningCheckIn() {
  if (!JOSH_CHAT_ID) return;
  try {
    const tasks = await getTaskSummary();
    await bot.sendMessage(JOSH_CHAT_ID,
      `🌙 *Evening Check-in*\n\n${tasks.length} tasks still active. Anything to mark done? Reply /done [task]\n\nWhat did you get done today?`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Evening check-in error:', err.message);
  }
}

async function sendWeeklyResearch() {
  if (!JOSH_CHAT_ID) return;
  try {
    await bot.sendMessage(JOSH_CHAT_ID, `🔬 Running weekly market research across all 4 businesses...`);
    const [saas, solana, leadgen] = await Promise.all([
      webSearch('SaaS churn recovery tools market 2026'),
      webSearch('Solana memecoin rug pull detection tools 2026'),
      webSearch('AI lead generation B2B tools 2026')
    ]);
    const prompt = `Weekly market research for Josh's 4 businesses. Here's what I found:\n\nSaaS/Churn market:\n${saas}\n\nSolana/Crypto:\n${solana}\n\nLead Gen market:\n${leadgen}\n\nGive Josh a weekly intel brief — what's moving in his markets, any opportunities or threats worth knowing about, and one strategic recommendation per business.`;
    const reply = await getAJResponse(JOSH_CHAT_ID, prompt);
    await bot.sendMessage(JOSH_CHAT_ID, `📊 *Weekly Market Intel*\n\n${reply}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Weekly research error:', err.message);
  }
}

cron.schedule('0 8 * * *', sendMorningBriefing, { timezone: 'America/Chicago' });
cron.schedule('0 20 * * *', sendEveningCheckIn, { timezone: 'America/Chicago' });
cron.schedule('0 9 * * 1', sendWeeklyResearch, { timezone: 'America/Chicago' });

app.get('/', (req, res) => res.send('AJ v4 — Autonomous Agent — Online'));

app.listen(PORT, async () => {
  await initDB();
  console.log(`AJ v4 running on port ${PORT}`);
  if (WEBHOOK_URL) {
    await bot.setWebHook(`${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`);
    console.log('Webhook set');
  }
});
