const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const JOSH_CHAT_ID = process.env.JOSH_CHAT_ID;
const AGENT_ID = process.env.AJ_AGENT_ID;
const ENVIRONMENT_ID = process.env.AJ_ENVIRONMENT_ID;

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
      session_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database ready');
}

async function getTaskSummary() {
  const { rows } = await pool.query(`
    SELECT * FROM tasks WHERE status != 'done'
    ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC
  `);
  return rows;
}

async function getTaskContext() {
  const tasks = await getTaskSummary();
  if (tasks.length === 0) return "No active tasks.";
  const byProject = {};
  tasks.forEach(t => {
    if (!byProject[t.project]) byProject[t.project] = [];
    byProject[t.project].push(`[${t.status.toUpperCase()}] ${t.title}${t.priority === 'high' ? ' ⚡' : ''}`);
  });
  return Object.entries(byProject)
    .map(([proj, items]) => `${proj}:\n${items.map(i => `  • ${i}`).join('\n')}`)
    .join('\n\n');
}

async function getOrCreateSession(chatId) {
  const { rows } = await pool.query(
    `SELECT session_id FROM conversations WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [chatId]
  );
  if (rows.length > 0 && rows[0].session_id) {
    return rows[0].session_id;
  }
  return await createNewSession(chatId);
}

async function createNewSession(chatId) {
  const session = await client.beta.sessions.create({
    agent: { type: 'agent', id: AGENT_ID },
    environment_id: ENVIRONMENT_ID,
    betas: ['managed-agents-2026-04-01'],
  });
  await pool.query(
    `INSERT INTO conversations (chat_id, session_id) VALUES ($1, $2)`,
    [chatId, session.id]
  );
  return session.id;
}

async function askAJ(sessionId, message) {
  const taskContext = await getTaskContext();
  const fullMessage = `${message}\n\n[Current task list:\n${taskContext}]`;

  let reply = '';

  try {
    const stream = client.beta.sessions.events.stream(sessionId, {
      betas: ['managed-agents-2026-04-01'],
    });

    await client.beta.sessions.events.send(sessionId, {
      events: [{
        type: 'user.message',
        content: [{ type: 'text', text: fullMessage }],
      }],
      betas: ['managed-agents-2026-04-01'],
    });

    for await (const event of await stream) {
      if (event.type === 'agent.message') {
        for (const block of event.content) {
          if (block.text) reply += block.text;
        }
      }
      if (event.type === 'session.status_idle') break;
    }
  } catch (err) {
    console.error('Session error:', err.message);
    // Session may have expired — create a new one
    if (err.message?.includes('session') || err.status === 404) {
      const newSessionId = await createNewSession('retry');
      return await askAJFresh(newSessionId, message);
    }
    throw err;
  }

  return reply || "I'm thinking — try again in a second.";
}

async function askAJFresh(sessionId, message) {
  const taskContext = await getTaskContext();
  const fullMessage = `${message}\n\n[Current task list:\n${taskContext}]`;
  let reply = '';

  const stream = client.beta.sessions.events.stream(sessionId, {
    betas: ['managed-agents-2026-04-01'],
  });

  await client.beta.sessions.events.send(sessionId, {
    events: [{
      type: 'user.message',
      content: [{ type: 'text', text: fullMessage }],
    }],
    betas: ['managed-agents-2026-04-01'],
  });

  for await (const event of await stream) {
    if (event.type === 'agent.message') {
      for (const block of event.content) {
        if (block.text) reply += block.text;
      }
    }
    if (event.type === 'session.status_idle') break;
  }

  return reply || "Got it — what else do you need?";
}

function formatTasks(tasks) {
  if (tasks.length === 0) return "No active tasks. Tell me what you're working on this week!";
  const byProject = {};
  tasks.forEach(t => {
    if (!byProject[t.project]) byProject[t.project] = [];
    byProject[t.project].push(t);
  });
  return Object.entries(byProject).map(([proj, items]) => {
    const lines = items.map(t => {
      const priority = t.priority === 'high' ? '⚡' : '•';
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
  const firstName = update.message.from.first_name || 'Josh';

  try {
    await bot.sendChatAction(chatId, 'typing');

    if (text === '/start') {
      await bot.sendMessage(chatId,
        `AJ online. 🟢\n\nHey ${firstName} — I'm now running on Anthropic's Managed Agent infrastructure. I can search the web, analyze data, and think deeper.\n\n• /tasks — active task list\n• /add [task] to [project] — add a task\n• /done [task] — mark complete\n• /status — business overview\n• /newsession — fresh start\n\nWhat do you need?`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/tasks') {
      const tasks = await getTaskSummary();
      await bot.sendMessage(chatId, `*Your Active Tasks*\n\n${formatTasks(tasks)}`, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/add ')) {
      const taskText = text.replace('/add ', '');
      const parts = taskText.split(' to ');
      const title = parts[0].trim();
      const project = parts[1] ? parts[1].trim() : 'General';
      await pool.query(`INSERT INTO tasks (title, project) VALUES ($1, $2)`, [title, project]);
      await bot.sendMessage(chatId, `✅ Added: *${title}*\nProject: ${project}`, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/done ')) {
      const search = text.replace('/done ', '').trim();
      const { rows } = await pool.query(
        `UPDATE tasks SET status = 'done', updated_at = NOW() WHERE LOWER(title) LIKE LOWER($1) AND status != 'done' RETURNING title`,
        [`%${search}%`]
      );
      if (rows.length > 0) {
        await bot.sendMessage(chatId, `🎯 Done: *${rows[0].title}*`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `Couldn't find that task. Try /tasks to see what's active.`);
      }
      return;
    }

    if (text === '/newsession') {
      await pool.query(`DELETE FROM conversations WHERE chat_id = $1`, [chatId]);
      await createNewSession(chatId);
      await bot.sendMessage(chatId, 'Fresh session started. AJ is ready.');
      return;
    }

    if (text === '/status') {
      const tasks = await getTaskSummary();
      const high = tasks.filter(t => t.priority === 'high').length;
      await bot.sendMessage(chatId,
        `*Business Status*\n\n• Overflow Revive — Active\n• Coinbot Hunter — v16, Active\n• RIGOR — Build phase\n• Lead Gen — Ready\n\n*Tasks*\n• ${tasks.length} active · ${high} high priority`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const sessionId = await getOrCreateSession(chatId);
    const reply = await askAJ(sessionId, text);
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Error:', err);
    await bot.sendMessage(chatId, "Hit a snag — try again in a second.");
  }
});

async function sendMorningBriefing() {
  if (!JOSH_CHAT_ID) return;
  try {
    const sessionId = await createNewSession('morning-briefing');
    const tasks = await getTaskSummary();
    const high = tasks.filter(t => t.priority === 'high');
    let prompt = `Morning briefing time. Give Josh a sharp, concise Wednesday morning briefing covering: 1) What to focus on today across all 4 businesses to make the most money 2) Any market intel worth knowing 3) One clear action to take before noon.`;
    if (high.length > 0) {
      prompt += ` High priority tasks: ${high.map(t => t.title).join(', ')}.`;
    }
    const reply = await askAJFresh(sessionId, prompt);
    await bot.sendMessage(JOSH_CHAT_ID, `☀️ *Morning Briefing*\n\n${reply}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Morning briefing error:', err);
  }
}

async function sendEveningCheckIn() {
  if (!JOSH_CHAT_ID) return;
  try {
    const tasks = await getTaskSummary();
    await bot.sendMessage(JOSH_CHAT_ID,
      `🌙 *Evening Check-in*\n\nYou've got ${tasks.length} active tasks. Anything to mark done today? Reply /done [task name]`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Evening check-in error:', err);
  }
}

cron.schedule('0 8 * * *', sendMorningBriefing, { timezone: 'America/Chicago' });
cron.schedule('0 20 * * *', sendEveningCheckIn, { timezone: 'America/Chicago' });

app.get('/', (req, res) => res.send('AJ v3 — Managed Agent — Online'));

app.listen(PORT, async () => {
  await initDB();
  console.log(`AJ v3 running on port ${PORT}`);
  if (WEBHOOK_URL) {
    await bot.setWebHook(`${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`);
    console.log(`Webhook set`);
  }
});
