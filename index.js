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

  // Reminders table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      remind_at TIMESTAMP NOT NULL,
      fired BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
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
    // Sync to Airtable - skip internal tracking keys
    const skipKeys = ['last_mention_id', 'last_mention_hash', 'pending_reply_tweet_id', 'last_shown_draft', 'last_image_context'];
    if (!skipKeys.includes(key) && value && value.length > 5) {
      syncMemoryToAirtable(key, value).catch(e => console.error('Airtable memory sync error:', e.message));
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
    // Sync to Airtable in background
    syncKnowledgeToAirtable(category, title, content, tags).catch(e => console.error('Airtable KB sync:', e.message));
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

// ── AIRTABLE SYNC ────────────────────────────────────────
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || 'appH485b932LDcBF4';
const AIRTABLE_TOKEN = process.env.AIRTABLE_API_TOKEN;

async function airtableRequest(method, table, body = null, recordId = null) {
  if (!AIRTABLE_TOKEN) {
    console.log('Airtable: No token set - skipping');
    return null;
  }
  console.log('Airtable:', method, table.substring(0, 30));
  try {
    const https = require('https');
    const path = '/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(table) + (recordId ? '/' + recordId : '');
    const data = body ? JSON.stringify(body) : null;
    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.airtable.com',
        path,
        method,
        headers: {
          'Authorization': 'Bearer ' + AIRTABLE_TOKEN,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.error) console.log('Airtable response error:', JSON.stringify(parsed));
            else console.log('Airtable response OK:', method, table.substring(0,20));
            resolve(parsed);
          }
          catch(e) { 
            console.log('Airtable raw response:', body.substring(0,200));
            resolve(body); 
          }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  } catch(e) {
    console.error('Airtable error:', e.message);
    return null;
  }
}

async function syncKnowledgeToAirtable(category, title, content, tags) {
  try {
    // Always insert new record - simple and reliable
    const fields = {
      'Knowledge Title': title,
      'Description': content.substring(0, 500),
      'Topic/Domain': category,
      'Source/Reference': 'AJ Bot - ' + (tags || ''),
      'Last Updated': new Date().toISOString().split('T')[0]
    };
    const result = await airtableRequest('POST', 'Knowledge', { fields });
    if (result?.id) {
      console.log('Synced to Airtable Knowledge:', title);
    } else {
      console.log('Airtable Knowledge sync result:', JSON.stringify(result).substring(0, 100));
    }
  } catch(e) { console.error('Airtable sync error:', e.message); }
}

async function syncXPostToAirtable(content, postType, tweetId, postedAt) {
  try {
    const fields = {
      'Post Content': content.substring(0, 500),
      'Post Date': postedAt ? new Date(postedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      'Posted By': '@AJ_agentic',
      'Hashtags': postType || 'scheduled'
    };
    await airtableRequest('POST', 'X Posts', { fields });
    console.log('Synced X post to Airtable');
  } catch(e) { console.error('Airtable X post sync error:', e.message); }
}

async function syncMemoryToAirtable(key, value) {
  try {
    const fields = {
      'Memory Title': key,
      'Memory Content': value.substring(0, 1000),
      'Date Created': new Date().toISOString().split('T')[0]
    };
    const result = await airtableRequest('POST', 'Memories', { fields });
    if (result?.id) console.log('Synced memory to Airtable:', key);
    else console.log('Airtable memory result:', JSON.stringify(result).substring(0, 100));
  } catch(e) { console.error('Airtable memory sync error:', e.message); }
}

async function syncConversationToAirtable(summary, topics) {
  try {
    const fields = {
      'Conversation Transcript': summary.substring(0, 1000),
      'Topic/Category': topics || '',
      'Conversation Date': new Date().toISOString().split('T')[0],
      'Participants/User': 'Josh'
    };
    await airtableRequest('POST', 'Conversations', { fields });
    console.log('Synced conversation to Airtable');
  } catch(e) { console.error('Airtable conversation sync error:', e.message); }
}

// ── X POST CONTEXT ────────────────────────────────────────
async function getXPostContext() {
  try {
    const { rows: posted } = await pool.query(
      "SELECT content, post_type, created_at as posted_at FROM x_posts ORDER BY created_at DESC LIMIT 15"
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
- You always know the current time and date — it's injected into your context every message
- When Josh asks for a reminder at a specific time, acknowledge the exact time and confirm it clearly
- Use the current time to be contextually aware — morning energy vs late night, day of week, etc.

ALWAYS TOP OF MIND:
- You are actively building Overflow Revive into a done-for-you performance-based revenue recovery service
- The model: recover failed payments, churn, abandoned carts for e-commerce/SaaS clients — charge % of recovered revenue only, zero upfront cost
- Target clients: stores doing $50k-$500k/month who have no recovery system
- First milestone: get 3 clients, prove numbers, build case studies
- Check your knowledge base for full details on any of the 4 businesses — it has deep context on all of them

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

  // Current time in Josh's timezone (Fort Worth, Texas = America/Chicago)
  const now = new Date();
  const timeStr = now.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });

  let system = AJ_SYSTEM +
    '\n\nCURRENT TIME (Fort Worth, TX): ' + timeStr +
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

  // Sync conversation summary to Airtable periodically (every 10 messages)
  try {
    const { rows: msgCount } = await pool.query("SELECT COUNT(*) FROM conversations WHERE chat_id = $1", [chatId]);
    if (parseInt(msgCount[0].count) % 10 === 0) {
      const topics = userMessage.substring(0, 100);
      syncConversationToAirtable(userMessage.substring(0, 200) + ' → ' + reply.substring(0, 200), topics).catch(() => {});
    }
  } catch(e) {}

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
      await saveMemory(key, note);
      await bot.sendMessage(chatId, 'Got it — saved to memory: ' + note);
      return;
    }

    if (textLower === '/memory') {
      const mems = await getActiveMemories();
      await bot.sendMessage(chatId, mems ? 'Active memory:\n\n' + mems : 'Nothing saved to memory yet.');
      return;
    }

    if (textLower.startsWith('/remind ')) {
      // Format: /remind 9:30am tomorrow | message  OR  /remind 2025-04-14 09:30 | message
      const parts = text.replace(/^\/remind /i, '').split('|');
      if (parts.length < 2) {
        await bot.sendMessage(chatId, 'Format: /remind [time] | [message]\nExample: /remind 9:30am tomorrow | Post the Starlink reply');
        return;
      }
      const timeStr = parts[0].trim();
      const message = parts.slice(1).join('|').trim();
      // Parse the time using AI
      const parseResp = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Current time in Fort Worth TX (America/Chicago): ' + new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }) + '\n\nConvert this to ISO 8601 datetime: "' + timeStr + '"\nReply with ONLY the ISO datetime string, nothing else. Example: 2025-04-14T09:30:00' }]
      });
      const isoTime = parseResp.content[0].text.trim();
      try {
        const remindAt = new Date(isoTime);
        if (isNaN(remindAt.getTime())) throw new Error('Invalid date');
        await pool.query('INSERT INTO reminders (message, remind_at) VALUES ($1, $2)', [message, remindAt]);
        const friendly = remindAt.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
        await bot.sendMessage(chatId, 'Reminder set for ' + friendly + ':\n' + message);
      } catch(e) {
        await bot.sendMessage(chatId, 'Could not parse that time — try: /remind 9:30am tomorrow | your message');
      }
      return;
    }

    if (textLower === '/reminders') {
      const { rows } = await pool.query("SELECT message, remind_at FROM reminders WHERE fired = FALSE ORDER BY remind_at ASC LIMIT 10");
      if (rows.length === 0) { await bot.sendMessage(chatId, 'No pending reminders.'); return; }
      const msg = rows.map(r => {
        const t = new Date(r.remind_at).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
        return '⏰ ' + t + '\n   ' + r.message;
      }).join('\n\n');
      await bot.sendMessage(chatId, 'Pending reminders:\n\n' + msg);
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
      const query = text.trim().replace(/^(search for|look up|google|search the web for|search for me|can you search for|can you look up)\s*/i, "").trim();
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
      const { rows } = await pool.query('SELECT content FROM x_posts ORDER BY created_at DESC LIMIT 1');
      if (rows.length === 0) { await bot.sendMessage(chatId, 'No recent posts found.'); return; }
      await bot.sendMessage(chatId, 'Latest post:\n' + rows[0].content.substring(0, 100));
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
    // YES only triggers on exact matches — never on "yes [something else]" like "yes send me the link"
    const postYes = [
      'yes', 'yes post it', 'yes post', 'post it',
      'go ahead and post', 'post that', 'yes go ahead',
      'yes do it', 'post this', 'good to go', 'yes good to go',
      'go for it', 'fire it', 'fire it off', 'send it',
      'yes send it', 'lets go', "let's go", 'ship it', 'yes ship it'
    ];
    const isYes = postYes.some(y => textLower.trim() === y);

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
              const link = 'https://x.com/AJ_agentic/status/' + tweetId;
              await saveMemory('last_posted_tweet_url', link);
              await bot.sendMessage(chatId, 'Posted. ' + link);
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

      // Strip conversational preamble AJ adds before drafts
      let cleanPost = pending.content
        .replace(/^(here'?s? (?:one|a draft|the post|it|this)|how'?s? this|how about this|draft:|check this out|what about this)[:\s]*/gi, '')
        .replace(/^["']|["']$/g, '')
        .trim();
      if (cleanPost.length < 20) cleanPost = pending.content; // fallback if stripping gutted it

      const tweetId = await xEngine.postToX(cleanPost, replyToId, imageBuffer, imageMimeType);
      if (tweetId) {
        const link = 'https://x.com/AJ_agentic/status/' + tweetId;
        await saveMemory('last_posted_tweet_url', link);
        await bot.sendMessage(chatId, 'Posted. ' + link);
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

    // ── NATURAL MEMORY TRIGGERS ──────────────────────────
    const memoryTriggers = ['remember this', 'remember that', 'save this', 'save that', 'don\'t forget', 'dont forget', 'keep that in mind', 'note that', 'log this', 'store this', 'save this to memory', 'add this to memory'];
    const isMemoryTrigger = memoryTriggers.some(t => textLower.includes(t));

    // Web search trigger
    const searchTriggers = ["search for", "look up", "look this up", "google", "search the web", "find out", "what is the latest", "what are the latest", "search", "web search"];
    const isSearchRequest = searchTriggers.some(t => textLower.startsWith(t) || textLower.includes("can you search") || textLower.includes("can you look up") || textLower.includes("search for me"));
    if (isSearchRequest) {
      const query = text.trim().split(/\s+/).slice(1).join(" ") || text.trim();
      await bot.sendMessage(chatId, "Searching for: " + query + "...");
      const results = await braveSearch(query);
      const prompt = "Josh asked you to search for: " + query + "\n\nHere are the search results:\n" + results + "\n\nSummarize what you found in a sharp, concise way. Include the most important info and a source link.";
      const reply = await getAJResponse(chatId, prompt);
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      return;
    }

    if (isMemoryTrigger) {
      // Get AJ's last message as context for what to save
      const { rows: lastMsg } = await pool.query(
        "SELECT content FROM conversations WHERE chat_id = $1 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
        [chatId]
      );
      const lastAJMsg = lastMsg.length > 0 ? lastMsg[0].content : '';
      const noteContent = text + (lastAJMsg ? ' | Context: ' + lastAJMsg.substring(0, 200) : '');
      const key = 'note_' + Date.now();
      await saveMemory(key, noteContent);
      const reply = await getAJResponse(chatId, text);
      await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
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
app.post('/api/email-incoming', async (req, res) => {
  res.sendStatus(200);
  try {
    const { from, subject, body, date, source } = req.body;
    if (!from || !subject) return;

    const isOverflow = source === 'overflow_outlook';
    const emoji = isOverflow ? '📧' : '✉️';
    const account = isOverflow ? 'Overflow Revive' : 'AJ Gmail';

    console.log('Incoming email from Make.com:', source, subject);

    // Ask AJ to analyze and draft a response
    const emailPrompt = 'You just received an email to ' + account + '.\n\nFrom: ' + from + '\nSubject: ' + subject + '\nDate: ' + date + '\nPreview: ' + body + '\n\nAnalyze this email. Is it a lead, client reply, payment issue, spam, or general inquiry? Draft a short appropriate response if one is needed. If it is spam or a newsletter, just say IGNORE.';

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 500,
      system: 'You are AJ, an AI business agent. Analyze incoming emails and draft responses in a professional but chill tone.',
      messages: [{ role: 'user', content: emailPrompt }]
    });

    const analysis = response.content[0].text.trim();

    if (analysis.startsWith('IGNORE') || analysis.includes('spam') || analysis.includes('newsletter')) {
      console.log('Email marked as spam/newsletter - ignoring');
      return;
    }

    // Sync to Airtable
    syncKnowledgeToAirtable('email', subject + ' from ' + from, body + '\n\nAJ Analysis: ' + analysis, 'email,' + source).catch(() => {});

    const safeAnalysis = analysis.replace(/[*_`\[\]]/g, '').substring(0, 800);
    const msg = emoji + ' ' + account + ' email:\n\nFrom: ' + from + '\nSubject: ' + subject + '\n\nAJ\'s take:\n' + safeAnalysis;

    if (JOSH_CHAT_ID) {
      await bot.sendMessage(JOSH_CHAT_ID, msg);
    }
  } catch(e) {
    console.error('Email incoming error:', e.message);
  }
});

app.post('/api/seed-knowledge', async (req, res) => {
  try {
    const { category, title, content, tags, password } = req.body;
    if (password !== (process.env.SEED_PASSWORD || 'aj2024')) {
      return res.status(401).json({ error: 'Wrong password' });
    }
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content required' });
    }
    await saveKnowledge(category || 'other', title, content, tags || '');
    res.json({ success: true, title });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/test-airtable', async (req, res) => {
  try {
    const result = await syncKnowledgeToAirtable(
      'test',
      'Airtable Test ' + new Date().toISOString(),
      'This is a test record from AJ Bot to verify Airtable sync is working.',
      'test,debug'
    );
    res.json({ success: true, token_set: !!process.env.AIRTABLE_API_TOKEN, base: process.env.AIRTABLE_BASE_ID });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const [pending, posted, kbCount, memCount, convCount, recentKb, recentMem, reminders] = await Promise.all([
      pool.query("SELECT id, content, post_type, created_at FROM pending_x_posts WHERE status='pending' ORDER BY created_at DESC LIMIT 5"),
      pool.query("SELECT id, content, post_type, created_at FROM pending_x_posts WHERE status='approved' ORDER BY created_at DESC LIMIT 10"),
      pool.query("SELECT COUNT(*) FROM knowledge"),
      pool.query("SELECT COUNT(*) FROM memories"),
      pool.query("SELECT COUNT(*) FROM conversations WHERE created_at > NOW() - INTERVAL '24 hours' AND role='user'"),
      pool.query("SELECT title, category, created_at FROM knowledge ORDER BY created_at DESC LIMIT 5"),
      pool.query("SELECT category, content FROM memories WHERE category NOT LIKE 'last_%' AND category NOT LIKE 'pending_%' AND category NOT LIKE 'processed_%' ORDER BY id DESC LIMIT 5"),
      pool.query("SELECT message, remind_at FROM reminders WHERE fired=FALSE ORDER BY remind_at ASC LIMIT 5").catch(()=>({rows:[]}))
    ]);

    res.json({
      status: 'online',
      timestamp: new Date().toISOString(),
      stats: {
        knowledge: parseInt(kbCount.rows[0].count),
        memories: parseInt(memCount.rows[0].count),
        messages_today: parseInt(convCount.rows[0].count),
        pending_posts: pending.rows.length,
        total_posted: posted.rows.length
      },
      pending_posts: pending.rows,
      recent_posts: posted.rows,
      reminders: reminders.rows,
      recent_knowledge: recentKb.rows,
      recent_memories: recentMem.rows
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
      "SELECT id, LEFT(content, 80) as content, post_type, created_at as posted_at FROM x_posts ORDER BY created_at DESC LIMIT 20"
    );
    const { rows: memories } = await pool.query(
      "SELECT category, LEFT(content, 60) as content FROM memories WHERE category NOT LIKE 'processed_%' AND category != 'last_mention_id' ORDER BY created_at DESC LIMIT 10"
    );
    res.json({ knowledge, conversations, xposts, memories });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── REMINDER ENDPOINT (called by AJ via conversation) ────
app.post('/api/set-reminder', async (req, res) => {
  try {
    const { message, remind_at } = req.body;
    if (!message || !remind_at) return res.status(400).json({ error: 'Missing fields' });
    await pool.query('INSERT INTO reminders (message, remind_at) VALUES ($1, $2)', [message, new Date(remind_at)]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Check reminders every minute
cron.schedule('* * * * *', async () => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM reminders WHERE fired = FALSE AND remind_at <= NOW()"
    );
    for (const r of rows) {
      if (JOSH_CHAT_ID) {
        await bot.sendMessage(JOSH_CHAT_ID, '⏰ Reminder: ' + r.message);
      }
      await pool.query('UPDATE reminders SET fired = TRUE WHERE id = $1', [r.id]);
      console.log('Reminder fired:', r.message);
    }
  } catch(e) { console.error('Reminder check error:', e.message); }
}, { timezone: 'America/Chicago' });

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AJ — Mission Control</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;700;800;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root {
  --red: #e8321a;
  --red-bright: #ff4422;
  --red-dim: #8b1a0a;
  --red-glow: rgba(232,50,26,0.15);
  --bg: #060608;
  --bg2: #0d0d12;
  --glass: rgba(255,255,255,0.03);
  --glass-border: rgba(255,255,255,0.07);
  --glass-red: rgba(232,50,26,0.08);
  --glass-red-border: rgba(232,50,26,0.2);
  --text: rgba(255,255,255,0.9);
  --text-dim: rgba(255,255,255,0.4);
  --text-dimmer: rgba(255,255,255,0.2);
  --green: #22dd88;
  --amber: #f0a020;
}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:100%;min-height:100%;background:var(--bg);color:var(--text);font-family:'Space Mono',monospace;overflow-x:hidden;}

/* BG atmosphere */
body::before {
  content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(ellipse 70% 50% at 15% 50%, rgba(232,50,26,0.06) 0%, transparent 60%),
    radial-gradient(ellipse 50% 70% at 85% 20%, rgba(232,50,26,0.04) 0%, transparent 60%),
    radial-gradient(ellipse 80% 40% at 50% 100%, rgba(232,50,26,0.08) 0%, transparent 50%);
}
body::after {
  content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:linear-gradient(rgba(255,255,255,0.012) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.012) 1px,transparent 1px);
  background-size:40px 40px;
}

.wrap{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:24px 20px;}

/* Header */
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid var(--glass-border);}
.hdr-left{display:flex;align-items:center;gap:14px;}
.status-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}

@media (max-width: 768px) {
  .wrap { padding: 16px 12px; }
  .hdr { flex-direction: column; align-items: flex-start; gap: 12px; margin-bottom: 20px; }
  .hdr-right { width: 100%; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .stat-pill-val { font-size: 16px; }
  .hdr-title { font-size: 13px; }
  [style*="grid-template-columns:1fr 1fr 1fr"] { grid-template-columns: 1fr !important; }
  [style*="grid-template-columns:1fr 1fr"] { grid-template-columns: 1fr !important; }
  .readiness-val { font-size: 36px; }
  .card { padding: 16px; }
  .card-label { font-size: 7px; }
  .post-text { font-size: 10px; }
  .ring-label, .ring-val { font-size: 9px; }
  .kb-title { font-size: 10px; }
  .rem-msg { font-size: 10px; }
  .refresh-btn { font-size: 8px; padding: 4px 8px; }
}
.hdr-title{font-family:'Orbitron',sans-serif;font-weight:800;font-size:16px;letter-spacing:0.15em;text-transform:uppercase;color:#fff;}
.hdr-title span{color:var(--red);}
.hdr-time{font-size:10px;letter-spacing:0.1em;color:var(--text-dim);}
.hdr-right{display:flex;gap:20px;}
.stat-pill{display:flex;flex-direction:column;align-items:center;gap:2px;}
.stat-pill-val{font-family:'Orbitron',sans-serif;font-weight:700;font-size:20px;color:#fff;line-height:1;}
.stat-pill-label{font-size:8px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-dim);}

/* Grid layout */
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px;}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;}
.grid-full{margin-bottom:16px;}

/* Glass card */
.card{
  background:var(--glass);
  border:1px solid var(--glass-border);
  border-radius:12px;
  padding:20px;
  backdrop-filter:blur(20px);
  transition:border-color 0.2s;
  position:relative;
  overflow:hidden;
}
.card::before{
  content:'';position:absolute;inset:0;border-radius:12px;
  background:linear-gradient(135deg,rgba(255,255,255,0.04) 0%,transparent 60%);
  pointer-events:none;
}
.card:hover{border-color:rgba(255,255,255,0.12);}
.card.red-accent{border-color:var(--glass-red-border);background:var(--glass-red);}
.card.red-accent::before{background:linear-gradient(135deg,rgba(232,50,26,0.08) 0%,transparent 60%);}

.card-label{font-size:8px;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim);margin-bottom:14px;display:flex;align-items:center;gap:8px;}
.card-label::after{content:'';flex:1;height:1px;background:var(--glass-border);}

/* Readiness meter */
.readiness-val{font-family:'Orbitron',sans-serif;font-weight:800;font-size:48px;color:#fff;line-height:1;margin-bottom:4px;}
.readiness-sub{font-size:10px;color:var(--text-dim);letter-spacing:0.1em;}
.readiness-bar{margin-top:14px;height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;}
.readiness-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,var(--red),var(--red-bright));transition:width 1s ease;box-shadow:0 0 8px var(--red);}

/* Status ring */
.status-ring{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.ring-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
.ring-dot.green{background:var(--green);box-shadow:0 0 6px var(--green);}
.ring-dot.red{background:var(--red);box-shadow:0 0 6px var(--red);}
.ring-dot.amber{background:var(--amber);box-shadow:0 0 6px var(--amber);}
.ring-dot.dim{background:rgba(255,255,255,0.2);}
.ring-label{font-size:10px;color:var(--text-dim);letter-spacing:0.05em;}
.ring-val{font-size:10px;color:var(--text);margin-left:auto;}

/* Post item */
.post-item{padding:10px 0;border-bottom:1px solid var(--glass-border);cursor:default;}
.post-item:last-child{border-bottom:none;}
.post-text{font-size:11px;color:rgba(255,255,255,0.75);line-height:1.6;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.post-meta{font-size:9px;color:var(--text-dimmer);display:flex;gap:10px;}
.post-badge{font-size:8px;padding:2px 6px;border-radius:3px;letter-spacing:0.08em;text-transform:uppercase;}
.badge-pending{background:rgba(240,160,32,0.15);color:var(--amber);border:1px solid rgba(240,160,32,0.2);}
.badge-posted{background:rgba(34,221,136,0.1);color:var(--green);border:1px solid rgba(34,221,136,0.15);}

/* Knowledge item */
.kb-item{padding:8px 0;border-bottom:1px solid var(--glass-border);}
.kb-item:last-child{border-bottom:none;}
.kb-title{font-size:11px;color:rgba(255,255,255,0.8);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.kb-cat{font-size:9px;color:var(--red);letter-spacing:0.08em;text-transform:uppercase;}

/* Reminder item */
.rem-item{padding:8px 0;border-bottom:1px solid var(--glass-border);display:flex;gap:10px;align-items:flex-start;}
.rem-item:last-child{border-bottom:none;}
.rem-icon{color:var(--amber);font-size:12px;flex-shrink:0;margin-top:1px;}
.rem-msg{font-size:11px;color:rgba(255,255,255,0.8);line-height:1.4;}
.rem-time{font-size:9px;color:var(--text-dimmer);margin-top:2px;}

/* Empty state */
.empty{font-size:11px;color:var(--text-dimmer);text-align:center;padding:20px 0;letter-spacing:0.05em;}

/* X post full text tooltip */
.post-item:hover .post-text{white-space:normal;overflow:visible;text-overflow:unset;}

/* Refresh btn */
.refresh-btn{font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-dim);background:none;border:1px solid var(--glass-border);border-radius:4px;padding:4px 10px;cursor:pointer;transition:all 0.2s;font-family:'Space Mono',monospace;}
.refresh-btn:hover{border-color:var(--glass-red-border);color:var(--red);}

/* Loading */
.loading{font-size:10px;color:var(--text-dimmer);letter-spacing:0.1em;text-align:center;padding:40px;}

/* Activity feed */
.activity-line{font-size:10px;color:var(--text-dim);padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;gap:10px;}
.activity-line:last-child{border-bottom:none;}
.activity-time{color:var(--text-dimmer);flex-shrink:0;min-width:50px;}
.activity-text{color:rgba(255,255,255,0.6);}
.activity-text em{color:var(--red);font-style:normal;}
</style>
</head>
<body>
<div class="wrap">

  <div class="hdr">
    <div class="hdr-left">
      <div class="status-dot"></div>
      <div>
        <div class="hdr-title">AJ <span>//</span> Mission Control</div>
        <div class="hdr-time" id="live-time">Loading...</div>
      </div>
    </div>
    <div class="hdr-right">
      <div class="stat-pill"><div class="stat-pill-val" id="s-kb">—</div><div class="stat-pill-label">Knowledge</div></div>
      <div class="stat-pill"><div class="stat-pill-val" id="s-mem">—</div><div class="stat-pill-label">Memories</div></div>
      <div class="stat-pill"><div class="stat-pill-val" id="s-msg">—</div><div class="stat-pill-label">Msgs Today</div></div>
      <div class="stat-pill"><div class="stat-pill-val" id="s-post">—</div><div class="stat-pill-label">Posts</div></div>
      <button class="refresh-btn" onclick="load()">↻ Refresh</button>
    </div>
  </div>

  <div class="grid" id="main-grid">
    <div class="loading">Connecting to AJ...</div>
  </div>

</div>

<script>
function timeAgo(iso) {
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

function readiness(data) {
  let score = 40;
  if (data.stats.knowledge > 5) score += 20;
  if (data.stats.memories > 3) score += 10;
  if (data.stats.messages_today > 0) score += 15;
  if (data.stats.total_posted > 5) score += 15;
  return Math.min(score, 98);
}

async function load() {
  try {
    const resp = await fetch('/api/dashboard');
    const data = await resp.json();
    if (!data || !data.stats) throw new Error('Invalid response: ' + JSON.stringify(data).substring(0,100));

    // Stats
    document.getElementById('s-kb').textContent = data.stats.knowledge;
    document.getElementById('s-mem').textContent = data.stats.memories;
    document.getElementById('s-msg').textContent = data.stats.messages_today;
    document.getElementById('s-post').textContent = data.stats.total_posted;

    const ready = readiness(data);

    // Build grid
    const grid = document.getElementById('main-grid');
    grid.innerHTML = '';
    grid.className = '';

    grid.innerHTML = \`
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px;grid-column:1/-1;">

      <!-- Readiness -->
      <div class="card red-accent">
        <div class="card-label">Daily Readiness</div>
        <div class="readiness-val" id="ready-val">0%</div>
        <div class="readiness-sub">Operational capacity</div>
        <div class="readiness-bar"><div class="readiness-fill" id="ready-bar" style="width:0%"></div></div>
      </div>

      <!-- System Status -->
      <div class="card">
        <div class="card-label">System Status</div>
        <div class="status-ring"><div class="ring-dot green"></div><div class="ring-label">Telegram</div><div class="ring-val">Online</div></div>
        <div class="status-ring"><div class="ring-dot green"></div><div class="ring-label">X (@AJ_agentic)</div><div class="ring-val">Active</div></div>
        <div class="status-ring"><div class="ring-dot green"></div><div class="ring-label">Airtable Sync</div><div class="ring-val">Connected</div></div>
        <div class="status-ring"><div class="ring-dot green"></div><div class="ring-label">Make.com</div><div class="ring-val">3 Scenarios</div></div>
        <div class="status-ring"><div class="ring-dot \${data.stats.pending_posts > 0 ? 'amber' : 'dim'}"></div><div class="ring-label">Pending Posts</div><div class="ring-val">\${data.stats.pending_posts}</div></div>
      </div>

      <!-- Today's Activity -->
      <div class="card">
        <div class="card-label">Today's Activity</div>
        \${data.recent_posts.slice(0,3).map(p => \`
          <div class="activity-line">
            <div class="activity-time">\${timeAgo(p.posted_at||p.created_at)}</div>
            <div class="activity-text">Posted to <em>@AJ_agentic</em></div>
          </div>
        \`).join('')
        \${data.reminders.slice(0,2).map(r => \`
          <div class="activity-line">
            <div class="activity-time">\${fmtTime(r.remind_at)}</div>
            <div class="activity-text"><em>Reminder</em> — \${r.message.substring(0,30)}\${r.message.length>30?'...':''}</div>
          </div>
        \`).join('')}
        \${data.stats.messages_today > 0 ? \`<div class="activity-line"><div class="activity-time">Today</div><div class="activity-text"><em>\${data.stats.messages_today}</em> messages with Josh</div></div>\` : ''}
        \${!data.recent_posts.length && !data.reminders.length && !data.stats.messages_today ? '<div class="empty">No activity yet today</div>' : ''}
      </div>

    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;grid-column:1/-1;">

      <!-- Pending Posts -->
      <div class="card">
        <div class="card-label">Pending Approval</div>
        \${data.pending_posts.length ? data.pending_posts.map(p => \`
          <div class="post-item">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <span class="post-badge badge-pending">Pending</span>
              <span class="post-meta">\${timeAgo(p.created_at)}</span>
            </div>
            <div class="post-text">\${p.content}</div>
          </div>
        \`).join('') : '<div class="empty">Queue is clear</div>'}
      </div>

      <!-- Recent X Posts -->
      <div class="card">
        <div class="card-label">Recent X Posts</div>
        \${data.recent_posts.length ? data.recent_posts.slice(0,4).map(p => \`
          <div class="post-item">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <span class="post-badge badge-posted">Posted</span>
              <span class="post-meta">\${timeAgo(p.posted_at||p.created_at)}</span>
              \${p.tweet_id ? \`<a href="https://x.com/AJ_agentic/status/\${p.tweet_id}" target="_blank" style="font-size:9px;color:var(--red);text-decoration:none;margin-left:auto;">↗ View</a>\` : ''}
            </div>
            <div class="post-text">\${p.content}</div>
          </div>
        \`).join('') : '<div class="empty">No posts yet</div>'}
      </div>

    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;grid-column:1/-1;">

      <!-- Reminders -->
      <div class="card">
        <div class="card-label">Upcoming Reminders</div>
        \${data.reminders.length ? data.reminders.map(r => \`
          <div class="rem-item">
            <div class="rem-icon">⏰</div>
            <div>
              <div class="rem-msg">\${r.message}</div>
              <div class="rem-time">\${fmtTime(r.remind_at)}</div>
            </div>
          </div>
        `).join('') : '<div class="empty">No reminders set</div>'}
      </div>

      <!-- Recent Knowledge -->
      <div class="card">
        <div class="card-label">Knowledge Base</div>
        \${data.recent_knowledge.length ? data.recent_knowledge.map(k => \`
          <div class="kb-item">
            <div class="kb-title">\${k.title}</div>
            <div class="kb-cat">\${k.category}</div>
          </div>
        \`).join('') : '<div class="empty">Empty — add knowledge above</div>'}
      </div>

      <!-- Recent Memories -->
      <div class="card">
        <div class="card-label">Active Memory</div>
        \${data.recent_memories.length ? data.recent_memories.map(m => \`
          <div class="kb-item">
            <div class="kb-title">\${m.content.substring(0,60)}\${m.content.length>60?'...':''}</div>
            <div class="kb-cat">\${m.category.replace(/_/g,' ')}</div>
          </div>
        \`).join('') : '<div class="empty">No memories yet</div>'}
      </div>

    </div>
    \`;

    // Animate readiness
    setTimeout(() => {
      document.getElementById('ready-val').textContent = ready + '%';
      document.getElementById('ready-bar').style.width = ready + '%';
    }, 100);

  } catch(e) {
    document.getElementById('main-grid').innerHTML = '<div class="loading" style="color:var(--red)">Failed to connect to AJ — ' + e.message + '</div>';
  }
}

// Live clock
function clock() {
  document.getElementById('live-time').textContent = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday:'short', month:'short', day:'numeric',
    hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true
  }) + ' CT';
}
clock();
setInterval(clock, 1000);
setInterval(load, 30000);
load();
</script>
</body>
</html>`);
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AJ — Second Brain</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0d0d0f;
  --surface: rgba(255,255,255,0.03);
  --border: rgba(255,255,255,0.06);
  --core: #ffffff;
  --knowledge: #7c6af7;
  --conversation: #f0a500;
  --xpost: #f05050;
  --memory: #50c8a8;
  --category: #b06af7;
  --text: rgba(255,255,255,0.85);
  --text-dim: rgba(255,255,255,0.3);
  --glow-core: rgba(255,255,255,0.15);
  --glow-kb: rgba(124,106,247,0.2);
  --glow-conv: rgba(240,165,0,0.2);
  --glow-x: rgba(240,80,80,0.2);
  --glow-mem: rgba(80,200,168,0.2);
}
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:100%; height:100%; overflow:hidden; background:var(--bg); color:var(--text); font-family:'JetBrains Mono', monospace; }
#canvas { position:fixed; inset:0; cursor:grab; }
#canvas:active { cursor:grabbing; }

#ui {
  position:fixed; inset:0; pointer-events:none; z-index:10;
}

#header {
  position:fixed; top:0; left:0; right:0;
  padding:16px 24px;
  display:flex; align-items:center; justify-content:space-between;
  background:linear-gradient(to bottom, rgba(13,13,15,0.95) 0%, transparent 100%);
  pointer-events:auto;
}

#logo {
  font-family:'Syne', sans-serif;
  font-weight:800; font-size:15px;
  letter-spacing:0.2em; text-transform:uppercase;
  color:#fff;
}
#logo em { color:var(--knowledge); font-style:normal; }

#stats {
  display:flex; gap:20px;
}
.stat {
  text-align:center;
  font-size:9px; letter-spacing:0.15em; text-transform:uppercase;
  color:var(--text-dim);
}
.stat strong { display:block; font-size:18px; font-weight:700; color:#fff; font-family:'Syne',sans-serif; }

#controls {
  position:fixed; bottom:24px; left:24px;
  display:flex; flex-direction:column; gap:8px;
  pointer-events:auto;
}

.legend {
  display:flex; align-items:center; gap:8px;
  font-size:9px; letter-spacing:0.12em; text-transform:uppercase;
  color:var(--text-dim);
}
.ldot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }

#search-wrap {
  position:fixed; top:60px; left:24px;
  pointer-events:auto;
}
#search {
  background:rgba(255,255,255,0.04);
  border:1px solid var(--border);
  border-radius:3px;
  padding:7px 12px;
  color:#fff;
  font-family:'JetBrains Mono', monospace;
  font-size:11px;
  width:200px;
  outline:none;
  transition:border-color 0.2s;
}
#search:focus { border-color:rgba(124,106,247,0.5); }
#search::placeholder { color:var(--text-dim); }

#panel {
  position:fixed; top:60px; right:24px;
  width:280px; max-height:calc(100vh - 100px);
  background:rgba(13,13,15,0.95);
  border:1px solid var(--border);
  border-radius:6px;
  padding:20px;
  overflow-y:auto;
  pointer-events:auto;
  display:none;
  backdrop-filter:blur(20px);
}
#panel.open { display:block; }
#panel-close {
  position:absolute; top:12px; right:12px;
  background:none; border:none; color:var(--text-dim);
  font-size:18px; cursor:pointer; line-height:1;
}
#panel-close:hover { color:#fff; }
#panel-type {
  font-size:8px; letter-spacing:0.2em; text-transform:uppercase;
  margin-bottom:8px; color:var(--text-dim);
}
#panel-title {
  font-family:'Syne',sans-serif; font-weight:700; font-size:14px;
  margin-bottom:12px; line-height:1.4; color:#fff;
}
#panel-body {
  font-size:10px; line-height:1.9;
  color:rgba(255,255,255,0.6);
  white-space:pre-wrap; word-break:break-word;
}
#panel-meta {
  margin-top:12px; font-size:9px;
  color:var(--text-dim); letter-spacing:0.08em;
}

#minimap {
  position:fixed; bottom:24px; right:24px;
  width:120px; height:80px;
  background:rgba(255,255,255,0.03);
  border:1px solid var(--border);
  border-radius:4px;
  pointer-events:none;
  overflow:hidden;
}
#minimap-canvas { width:100%; height:100%; }

.pulse-ring {
  animation: pulseRing 2.5s ease-out infinite;
}
@keyframes pulseRing {
  0% { opacity:0.6; transform:scale(1); }
  100% { opacity:0; transform:scale(2.5); }
}
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<canvas id="minimap-canvas" style="position:fixed;bottom:24px;right:24px;width:120px;height:80px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:4px;"></canvas>

<div id="editor" style="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:480px;background:#0d0d0f;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:28px;z-index:100;font-family:JetBrains Mono,monospace;">
  <div style="font-family:Syne,sans-serif;font-weight:800;font-size:14px;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:20px;color:#fff;">
    + Add Knowledge
    <button onclick="document.getElementById('editor').style.display='none'" style="float:right;background:none;border:none;color:rgba(255,255,255,0.3);font-size:20px;cursor:pointer;line-height:1;">×</button>
  </div>
  <div style="margin-bottom:12px;">
    <div style="font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:6px;">Category</div>
    <select id="e-cat" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:8px 10px;color:#fff;font-family:JetBrains Mono,monospace;font-size:11px;outline:none;">
      <option value="strategy">Strategy</option>
      <option value="business">Business</option>
      <option value="audience">Audience</option>
      <option value="pricing">Pricing</option>
      <option value="product">Product</option>
      <option value="people">People</option>
      <option value="ideas">Ideas</option>
      <option value="other">Other</option>
    </select>
  </div>
  <div style="margin-bottom:12px;">
    <div style="font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:6px;">Title</div>
    <input id="e-title" type="text" placeholder="e.g. Overflow Revive Pricing Strategy" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:8px 10px;color:#fff;font-family:JetBrains Mono,monospace;font-size:11px;outline:none;">
  </div>
  <div style="margin-bottom:12px;">
    <div style="font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:6px;">Content — be as detailed as you want</div>
    <textarea id="e-content" placeholder="Write everything AJ should know about this topic..." style="width:100%;height:140px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:8px 10px;color:#fff;font-family:JetBrains Mono,monospace;font-size:11px;outline:none;resize:vertical;line-height:1.7;"></textarea>
  </div>
  <div style="margin-bottom:20px;">
    <div style="font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:6px;">Tags (comma separated)</div>
    <input id="e-tags" type="text" placeholder="e.g. pricing, saas, revenue" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:8px 10px;color:#fff;font-family:JetBrains Mono,monospace;font-size:11px;outline:none;">
  </div>
  <div style="margin-bottom:16px;">
    <div style="font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:6px;">Password</div>
    <input id="e-pass" type="password" placeholder="Enter password" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:8px 10px;color:#fff;font-family:JetBrains Mono,monospace;font-size:11px;outline:none;">
  </div>
  <button onclick="submitKnowledge()" style="width:100%;padding:10px;background:#7c6af7;border:none;border-radius:4px;color:#fff;font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;font-weight:700;">Save to AJ Brain</button>
  <div id="e-status" style="margin-top:10px;font-size:10px;text-align:center;color:rgba(255,255,255,0.4);"></div>
</div>

<button onclick="document.getElementById('editor').style.display='block'" style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 20px;background:rgba(124,106,247,0.15);border:1px solid rgba(124,106,247,0.3);border-radius:4px;color:#7c6af7;font-family:JetBrains Mono,monospace;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;cursor:pointer;z-index:20;">+ Add Knowledge</button>

<div id="header">
  <div id="logo">AJ <em>//</em> SECOND BRAIN</div>
  <div id="stats">
    <div class="stat"><strong id="sn">0</strong>NODES</div>
    <div class="stat"><strong id="sk">0</strong>KNOWLEDGE</div>
    <div class="stat"><strong id="sc">0</strong>CONVOS</div>
    <div class="stat"><strong id="sx">0</strong>X POSTS</div>
    <div class="stat"><strong id="sm">0</strong>MEMORIES</div>
  </div>
</div>

<div id="search-wrap">
  <input id="search" type="text" placeholder="Filter nodes..." autocomplete="off">
</div>

<div id="controls">
  <div class="legend"><div class="ldot" style="background:#fff;box-shadow:0 0 6px #fff"></div>Core</div>
  <div class="legend"><div class="ldot" style="background:var(--category)"></div>Category</div>
  <div class="legend"><div class="ldot" style="background:var(--knowledge)"></div>Knowledge</div>
  <div class="legend"><div class="ldot" style="background:var(--conversation)"></div>Conversations</div>
  <div class="legend"><div class="ldot" style="background:var(--xpost)"></div>X Posts</div>
  <div class="legend"><div class="ldot" style="background:var(--memory)"></div>Memories</div>
</div>

<div id="panel">
  <button id="panel-close">×</button>
  <div id="panel-type"></div>
  <div id="panel-title"></div>
  <div id="panel-body"></div>
  <div id="panel-meta"></div>
</div>

<script>
const C = document.getElementById("canvas");
const ctx = C.getContext("2d");
const MM = document.getElementById("minimap-canvas");
const mctx = MM.getContext("2d");

let W, H, nodes=[], edges=[], animId, tick=0;
let tx=0, ty=0, scale=1;
let drag=false, dragStart={x:0,y:0}, dragOrigin={x:0,y:0};
let hovered=null, selected=null;
let searchVal="";

const COLORS = {
  core:"#ffffff", category:"#b06af7", knowledge:"#7c6af7",
  conversation:"#f0a500", xpost:"#f05050", memory:"#50c8a8"
};

function resize(){
  W=C.width=window.innerWidth;
  H=C.height=window.innerHeight;
  MM.width=120; MM.height=80;
}
window.addEventListener("resize",()=>{ resize(); if(nodes.length){ tx=W/2; ty=H/2; } });
resize();

// Force simulation
function simulate(alpha){
  const map={};
  nodes.forEach(n=>map[n.id]=n);

  // Repulsion between all nodes
  for(let i=0;i<nodes.length;i++){
    for(let j=i+1;j<nodes.length;j++){
      const a=nodes[i], b=nodes[j];
      const dx=b.x-a.x, dy=b.y-a.y;
      const d=Math.sqrt(dx*dx+dy*dy)||1;
      const repel = Math.min(500/(d*d), 3);
      const fx=dx/d*repel, fy=dy/d*repel;
      if(!a.fixed){a.vx-=fx;a.vy-=fy;}
      if(!b.fixed){b.vx+=fx;b.vy+=fy;}
    }
  }

  // Attraction along edges
  edges.forEach(e=>{
    const a=map[e.from], b=map[e.to];
    if(!a||!b) return;
    const dx=b.x-a.x, dy=b.y-a.y;
    const d=Math.sqrt(dx*dx+dy*dy)||1;
    const target=e.len||120;
    const force=(d-target)*0.004*e.strength;
    const fx=dx/d*force, fy=dy/d*force;
    if(!a.fixed){a.vx+=fx;a.vy+=fy;}
    if(!b.fixed){b.vx-=fx;b.vy-=fy;}
  });

  // Center gravity
  nodes.forEach(n=>{
    if(n.fixed) return;
    n.vx += -n.x*0.0008;
    n.vy += -n.y*0.0008;
    n.vx*=0.82; n.vy*=0.82;
    n.x+=n.vx*alpha*12;
    n.y+=n.vy*alpha*12;
  });
}

function w2s(x,y){ return {x:x*scale+tx, y:y*scale+ty}; }
function s2w(x,y){ return {x:(x-tx)/scale, y:(y-ty)/scale}; }

function drawGlow(x,y,r,color,alpha=0.3){
  const g=ctx.createRadialGradient(x,y,0,x,y,r*3);
  g.addColorStop(0,color+"33");
  g.addColorStop(1,"transparent");
  ctx.beginPath();
  ctx.arc(x,y,r*3,0,Math.PI*2);
  ctx.fillStyle=g;
  ctx.fill();
}

function render(){
  ctx.clearRect(0,0,W,H);

  // Subtle grid
  ctx.strokeStyle="rgba(255,255,255,0.02)";
  ctx.lineWidth=1;
  const gs=80*scale;
  const ox=tx%gs, oy=ty%gs;
  for(let x=ox;x<W;x+=gs){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let y=oy;y<H;y+=gs){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}

  const map={};
  nodes.forEach(n=>map[n.id]=n);
  const filter=searchVal.toLowerCase();

  // Draw edges
  edges.forEach(e=>{
    const a=map[e.from], b=map[e.to];
    if(!a||!b) return;
    const sa=w2s(a.x,a.y), sb=w2s(b.x,b.y);
    const isHov=hovered&&(hovered.id===e.from||hovered.id===e.to);
    const isSel=selected&&(selected.id===e.from||selected.id===e.to);
    const dim=filter&&!a.label.toLowerCase().includes(filter)&&!b.label.toLowerCase().includes(filter);

    ctx.beginPath();
    ctx.moveTo(sa.x,sa.y);
    ctx.lineTo(sb.x,sb.y);

    if(isSel){
      ctx.strokeStyle="rgba(255,255,255,0.25)";
      ctx.lineWidth=1.5;
    } else if(isHov){
      ctx.strokeStyle="rgba(255,255,255,0.12)";
      ctx.lineWidth=1;
    } else {
      ctx.strokeStyle=dim?"rgba(255,255,255,0.02)":"rgba(255,255,255,0.05)";
      ctx.lineWidth=0.5;
    }
    ctx.stroke();
  });

  // Draw nodes
  nodes.forEach(n=>{
    const s=w2s(n.x,n.y);
    const r=Math.max(n.r*scale,1.5);
    const isHov=hovered&&hovered.id===n.id;
    const isSel=selected&&selected.id===n.id;
    const dim=filter&&!n.label.toLowerCase().includes(filter)&&!((n.data?.content||"").toLowerCase().includes(filter));
    const alpha=dim?0.12:1;

    ctx.globalAlpha=alpha;

    // Glow for important nodes
    if((isHov||isSel||n.type==="core")&&!dim){
      const glowR=(n.r+16)*scale;
      const g=ctx.createRadialGradient(s.x,s.y,0,s.x,s.y,glowR);
      const col=COLORS[n.type]||"#fff";
      g.addColorStop(0,col+"33");
      g.addColorStop(1,"transparent");
      ctx.beginPath();
      ctx.arc(s.x,s.y,glowR,0,Math.PI*2);
      ctx.fillStyle=g;
      ctx.fill();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(s.x,s.y,r,0,Math.PI*2);
    const col=COLORS[n.type]||"#fff";
    if(isSel){
      ctx.fillStyle="#fff";
    } else if(isHov){
      ctx.fillStyle=col;
      ctx.shadowColor=col;
      ctx.shadowBlur=10*scale;
    } else {
      ctx.fillStyle=col;
    }
    ctx.fill();
    ctx.shadowBlur=0;

    // Ring for selected
    if(isSel){
      ctx.beginPath();
      ctx.arc(s.x,s.y,r+3*scale,0,Math.PI*2);
      ctx.strokeStyle=col;
      ctx.lineWidth=1;
      ctx.stroke();
    }

    // Label
    const showLabel=scale>0.45||n.type==="core"||n.type==="category";
    if(showLabel&&!dim){
      const fs=Math.max(n.type==="core"?13:9,n.type==="core"?13*scale:9*scale);
      ctx.font=n.type==="core"?"700 "+fs+"px Syne,sans-serif":"300 "+fs+"px JetBrains Mono,monospace";
      ctx.fillStyle=isHov||isSel?"#fff":col;
      ctx.textAlign="center";
      ctx.globalAlpha=alpha*(isHov?1:0.8);
      ctx.fillText(n.label.substring(0,22), s.x, s.y+(r+10)*scale);
    }

    ctx.globalAlpha=1;
  });

  // Minimap
  mctx.clearRect(0,0,120,80);
  mctx.fillStyle="rgba(0,0,0,0.5)";
  mctx.fillRect(0,0,120,80);
  const bounds=getGraphBounds();
  const mx=bounds.w||1, my=bounds.h||1;
  nodes.forEach(n=>{
    const nx=(n.x-bounds.minX)/mx*110+5;
    const ny=(n.y-bounds.minY)/my*70+5;
    mctx.beginPath();
    mctx.arc(nx,ny,Math.max(n.r*0.3,0.8),0,Math.PI*2);
    mctx.fillStyle=COLORS[n.type]||"#fff";
    mctx.globalAlpha=0.7;
    mctx.fill();
  });
  mctx.globalAlpha=1;
}

function getGraphBounds(){
  if(!nodes.length) return {minX:0,minY:0,w:1,h:1};
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  nodes.forEach(n=>{minX=Math.min(minX,n.x);maxX=Math.max(maxX,n.x);minY=Math.min(minY,n.y);maxY=Math.max(maxY,n.y);});
  return{minX,minY,w:maxX-minX||1,h:maxY-minY||1};
}

function animate(){
  tick++;
  if(tick%2===0) simulate(0.025);
  render();
  animId=requestAnimationFrame(animate);
}

async function load(){
  try {
    const d=await fetch("/api/graph").then(r=>r.json());
    build(d);
    document.getElementById("sn").textContent=nodes.length;
    document.getElementById("sk").textContent=d.knowledge.length;
    document.getElementById("sc").textContent=d.conversations.length;
    document.getElementById("sx").textContent=d.xposts.length;
    document.getElementById("sm").textContent=d.memories.length;
  } catch(e){ console.error("load error",e); }
}

function build(d){
  nodes=[]; edges=[];
  W=C.width=window.innerWidth;
  H=C.height=window.innerHeight;

  // Core node
  nodes.push({id:"core",type:"core",label:"AJ",x:0,y:0,r:14,vx:0,vy:0,fixed:true,
    data:{title:"AJ — Central Brain",content:"All knowledge, conversations, X posts and memories flow through here."}});

  // Category clusters
  const cats=[...new Set(d.knowledge.map(k=>k.category))];
  const catMap={};
  cats.forEach((cat,i)=>{
    const a=(i/cats.length)*Math.PI*2;
    const n={id:"cat_"+cat,type:"category",label:cat.toUpperCase(),
      x:Math.cos(a)*160,y:Math.sin(a)*160,r:7,vx:0,vy:0,
      data:{title:cat,content:"Category cluster: "+cat}};
    nodes.push(n); catMap[cat]=n;
    edges.push({from:"core",to:n.id,strength:1,len:160});
  });

  // Knowledge nodes — cluster around their category
  d.knowledge.forEach((k,i)=>{
    const cat=catMap[k.category];
    const baseA=cat?Math.atan2(cat.y,cat.x):Math.random()*Math.PI*2;
    const a=baseA+(Math.random()-0.5)*1.2;
    const dist=240+Math.random()*100;
    const n={id:"kb_"+k.id,type:"knowledge",
      label:k.title.length>18?k.title.substring(0,18)+"…":k.title,
      x:Math.cos(a)*dist+(Math.random()-0.5)*30,
      y:Math.sin(a)*dist+(Math.random()-0.5)*30,
      r:4.5,vx:0,vy:0,data:k};
    nodes.push(n);
    edges.push({from:cat?cat.id:"core",to:n.id,strength:0.6,len:90});
    // Cross-link knowledge nodes with same category
    d.knowledge.filter(k2=>k2.id!==k.id&&k2.category===k.category).slice(0,2).forEach(k2=>{
      edges.push({from:"kb_"+k.id,to:"kb_"+k2.id,strength:0.15,len:80});
    });
  });

  // Conversation nodes
  d.conversations.forEach((c,i)=>{
    const a=Math.random()*Math.PI*2;
    const dist=320+Math.random()*100;
    const date=new Date(c.date);
    const label=date.toLocaleDateString("en-US",{month:"short",day:"numeric"});
    const msgs=parseInt(c.count)||1;
    const n={id:"conv_"+i,type:"conversation",label,
      x:Math.cos(a)*dist,y:Math.sin(a)*dist,
      r:Math.min(3+msgs*0.4,8),vx:0,vy:0,
      data:{title:"Conversation — "+label,content:c.preview||"",date:c.date,count:c.count+" messages"}};
    nodes.push(n);
    edges.push({from:"core",to:n.id,strength:0.3,len:320});
  });

  // X post nodes — cluster together
  const xBase=Math.PI*0.3;
  d.xposts.forEach((p,i)=>{
    const a=xBase+(Math.random()-0.5)*2;
    const dist=360+Math.random()*120;
    const date=p.posted_at?new Date(p.posted_at).toLocaleDateString("en-US",{month:"short",day:"numeric"}):"Post";
    const n={id:"xp_"+p.id,type:"xpost",label:date,
      x:Math.cos(a)*dist,y:Math.sin(a)*dist,
      r:3.5,vx:0,vy:0,
      data:{title:"X Post",content:p.content,date:p.posted_at,type:p.post_type}};
    nodes.push(n);
    edges.push({from:"core",to:n.id,strength:0.2,len:360});
    // Link x posts to each other lightly
    if(i>0) edges.push({from:"xp_"+p.id,to:"xp_"+d.xposts[Math.max(0,i-1)].id,strength:0.1,len:60});
  });

  // Memory nodes — tight cluster near core
  d.memories.forEach((m,i)=>{
    const a=(i/Math.max(d.memories.length,1))*Math.PI*2;
    const dist=130+Math.random()*60;
    const n={id:"mem_"+i,type:"memory",
      label:m.category.replace(/_/g," ").substring(0,16),
      x:Math.cos(a)*dist,y:Math.sin(a)*dist,
      r:3,vx:0,vy:0,
      data:{title:m.category,content:m.content}};
    nodes.push(n);
    edges.push({from:"core",to:n.id,strength:0.8,len:130});
  });

  tx=W/2; ty=H/2; scale=0.85;
  for(let i=0;i<400;i++) simulate(0.08);
  if(animId) cancelAnimationFrame(animId);
  animate();
}

// Interaction
C.addEventListener("mousemove",e=>{
  const w=s2w(e.clientX,e.clientY);
  hovered=null;
  for(const n of nodes){
    const d=Math.hypot(n.x-w.x,n.y-w.y);
    if(d<n.r+6/scale){hovered=n;break;}
  }
  C.style.cursor=hovered?"pointer":(drag?"grabbing":"grab");
  if(drag){
    tx=dragOrigin.x+(e.clientX-dragStart.x);
    ty=dragOrigin.y+(e.clientY-dragStart.y);
  }
});

C.addEventListener("mousedown",e=>{
  drag=true;
  dragStart={x:e.clientX,y:e.clientY};
  dragOrigin={x:tx,y:ty};
});
C.addEventListener("mouseup",()=>drag=false);
C.addEventListener("mouseleave",()=>drag=false);

C.addEventListener("click",e=>{
  if(Math.hypot(e.clientX-dragStart.x,e.clientY-dragStart.y)>5) return;
  if(!hovered){
    selected=null;
    document.getElementById("panel").classList.remove("open");
    return;
  }
  selected=hovered;
  showPanel(hovered);
});

C.addEventListener("wheel",e=>{
  e.preventDefault();
  const f=e.deltaY>0?0.88:1.14;
  const wx=(e.clientX-tx)/scale, wy=(e.clientY-ty)/scale;
  scale=Math.max(0.15,Math.min(5,scale*f));
  tx=e.clientX-wx*scale;
  ty=e.clientY-wy*scale;
},{passive:false});

// Touch support
let lastTouchDist=0;
C.addEventListener("touchstart",e=>{
  if(e.touches.length===1){
    drag=true;
    dragStart={x:e.touches[0].clientX,y:e.touches[0].clientY};
    dragOrigin={x:tx,y:ty};
  }
  if(e.touches.length===2){
    lastTouchDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
  }
},{passive:true});
C.addEventListener("touchmove",e=>{
  e.preventDefault();
  if(e.touches.length===1&&drag){
    tx=dragOrigin.x+(e.touches[0].clientX-dragStart.x);
    ty=dragOrigin.y+(e.touches[0].clientY-dragStart.y);
  }
  if(e.touches.length===2){
    const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
    const f=d/lastTouchDist;
    scale=Math.max(0.15,Math.min(5,scale*f));
    lastTouchDist=d;
  }
},{passive:false});
C.addEventListener("touchend",()=>drag=false);

function showPanel(n){
  document.getElementById("panel-type").textContent=n.type.toUpperCase();
  document.getElementById("panel-title").textContent=n.data?.title||n.label;
  document.getElementById("panel-body").textContent=n.data?.content||"";
  const date=n.data?.date||n.data?.updated_at||n.data?.created_at||n.data?.posted_at;
  document.getElementById("panel-meta").textContent=date?new Date(date).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"}):"";
  document.getElementById("panel").classList.add("open");
}

document.getElementById("panel-close").addEventListener("click",()=>{
  document.getElementById("panel").classList.remove("open");
  selected=null;
});

document.getElementById("search").addEventListener("input",e=>{
  searchVal=e.target.value;
});

async function submitKnowledge(){
  const cat=document.getElementById('e-cat').value;
  const title=document.getElementById('e-title').value.trim();
  const cont=document.getElementById('e-content').value.trim();
  const tags=document.getElementById('e-tags').value.trim();
  const pass=document.getElementById('e-pass').value;
  const status=document.getElementById('e-status');
  if(!title||!cont){status.textContent='Title and content are required.';status.style.color='#f05050';return;}
  if(!pass){status.textContent='Password required.';status.style.color='#f05050';return;}
  status.textContent='Saving...';status.style.color='rgba(255,255,255,0.4)';
  try {
    const r=await fetch('/api/seed-knowledge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:cat,title,content:cont,tags,password:pass})});
    const d=await r.json();
    if(d.success){
      status.textContent='Saved! AJ now knows about: '+title;
      status.style.color='#50c8a8';
      document.getElementById('e-title').value='';
      document.getElementById('e-content').value='';
      document.getElementById('e-tags').value='';
      setTimeout(()=>{document.getElementById('editor').style.display='none';load();},1500);
    } else {
      status.textContent='Error: '+(d.error||'Unknown error');
      status.style.color='#f05050';
    }
  } catch(e){
    status.textContent='Network error: '+e.message;
    status.style.color='#f05050';
  }
}

setInterval(load,60000);
load();
</script>
</body>
</html>`);
});


async function braveSearch(query) {
  try {
    const https = require('https');
    const encoded = encodeURIComponent(query);
    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.search.brave.com',
        path: '/res/v1/web/search?q=' + encoded + '&count=5',
        method: 'GET',
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY || '' }
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const results = ((json.web && json.web.results) ? json.web.results : [])
              .slice(0, 5)
              .map(r => r.title + '\n' + (r.description || '') + '\nSource: ' + r.url)
              .join('\n\n');
            resolve(results || 'No results found.');
          } catch(e) { resolve('Search parse error: ' + e.message); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  } catch(e) { return 'Search error: ' + e.message; }
}

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
// search enabled Wed Apr 22 10:30:42 CDT 2026
