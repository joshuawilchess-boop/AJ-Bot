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

// ── X POST CONTEXT ────────────────────────────────────────
async function getXPostContext() {
  try {
    const { rows: posted } = await pool.query(
      "SELECT content, tweet_id, post_type FROM x_posts ORDER BY created_at DESC LIMIT 10"
    );
    const { rows: approved } = await pool.query(
      "SELECT content, post_type FROM pending_x_posts WHERE status = 'approved' ORDER BY created_at DESC LIMIT 5"
    );
    if (posted.length === 0 && approved.length === 0) return 'No posts yet on @AJ_agentic.';

    const lines = [];
    posted.forEach((r, i) => {
      const link = r.tweet_id ? ' [x.com/AJ_agentic/status/' + r.tweet_id + ']' : '';
      lines.push((i + 1) + '. [' + (r.post_type || 'post') + '] ' + r.content + link);
    });
    // Add approved replies not already in posted
    approved.forEach(r => {
      if (!posted.find(p => p.content === r.content)) {
        lines.push('[approved ' + (r.post_type || 'post') + '] ' + r.content);
      }
    });
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
When Josh approves, you handle everything: generate, queue, post, send the link.`;

// ── AI RESPONSE ───────────────────────────────────────────
async function getAJResponse(chatId, userMessage) {
  const [history, taskContext, xPostContext] = await Promise.all([
    getHistory(chatId),
    getTaskContext(),
    getXPostContext()
  ]);

  const system = AJ_SYSTEM +
    '\n\nCURRENT TASK LIST:\n' + taskContext +
    '\n\nYOUR RECENT X POSTS (@AJ_agentic):\n' + xPostContext;

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
      await bot.sendMessage(chatId, 'Memory cleared. Fresh start.');
      return;
    }

    // ── X COMMANDS ──────────────────────────────────────
    if (textLower.startsWith('/xpost') && !hasPhoto) {
      const postText = text.replace(/^\/xpost ?/i, '').trim();
      if (!postText) {
        await bot.sendMessage(chatId, 'Usage: /xpost [text] — or send an image with /xpost as the caption');
        return;
      }
      await pool.query('INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)', [postText, 'manual', 'pending']);
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
    const naturalYes = ['yes', 'yeah', 'yep', 'yup', 'sure', 'go ahead', 'do it', 'post it', 'go for it', 'definitely', 'absolutely', 'of course', 'sounds good', 'looks good'];
    const isYes = naturalYes.some(y => textLower === y || textLower.startsWith(y + ' ') || textLower.endsWith(' ' + y));

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
          const quotedMatch = lastMsg.match(/"([^"]{20,270})"/);
          const codeMatch = lastMsg.match(/```([^`]{20,270})```/s);
          const draftText = quotedMatch?.[1] || codeMatch?.[1];
          if (draftText) {
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
        // Only treat as replyToId if it looks like a tweet ID (numeric)
        const possibleId = parts[parts.length - 1];
        if (/^\d+$/.test(possibleId)) replyToId = possibleId;
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
    const naturalNo = ['no', 'nope', 'nah', 'skip', 'skip it', 'cancel'];
    const isNo = naturalNo.some(n => textLower === n);

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

        // Detect X post request
        const xPostKeywords = ['post this', 'post to x', 'tweet this', 'share this on x', 'post on x', 'use this image', 'post with this', 'xpost', '/xpost', 'post it', 'put this on x', 'share on x', 'introduce', 'post about'];
        const isXPostRequest = textLower.startsWith('/xpost') || xPostKeywords.some(kw => textLower.includes(kw));

        if (isXPostRequest) {
          // Understand the image first
          const visionResponse = await client.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 300,
            system: 'Describe what this image shows in 1-2 sentences for writing an X post about it.',
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
              { type: 'text', text: 'Brief description of this image.' }
            ]}]
          });
          const imgDesc = visionResponse.content[0].text;
          const instruction = text.replace(/^\/xpost ?/i, '').trim() || 'post this image';

          const postContent = await xEngine.generatePost('morning',
            'Josh wants to post this image to X. Instruction: "' + instruction + '". Image shows: ' + imgDesc + '. Write in AJ voice: chill, sharp, unbothered. No hashtags.'
          );

          const imgData = JSON.stringify({ base64: base64Image, mimeType: mediaType });
          await pool.query(
            'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3)',
            [postContent, 'image_post::' + imgData, 'pending']
          );

          const safePost = postContent.replace(/[*_`\[\]]/g, '');
          await bot.sendMessage(chatId, 'X post with image ready:\n\n' + safePost + '\n\nYES to post · NO to skip · or tell me to change it');
          return;
        }

        // Regular image analysis
        const taskCtx = await getTaskContext();
        const visionResponse = await client.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 1500,
          system: 'You are AJ, Josh\'s personal AI business agent with full vision. Analyze whatever Josh sends — screenshots, dashboards, documents, photos. Be direct, sharp, give actionable insights. Active tasks: ' + taskCtx,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
            { type: 'text', text: text || 'What do you see? Full analysis.' }
          ]}]
        });
        await bot.sendMessage(chatId, visionResponse.content[0].text, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Image handler error:', e.message);
        await bot.sendMessage(chatId, 'Hit a snag analyzing that — try again.');
      }
      return;
    }

    // ── DEFAULT: AJ CONVERSATION ─────────────────────────
    const reply = await getAJResponse(chatId, text);
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

app.get('/', (req, res) => res.send('AJ v4 — Online'));

app.listen(PORT, async () => {
  await initDB();
  if (process.env.X_API_KEY) {
    await xEngine.initXDB();
    xEngine.setTelegramBot(bot, JOSH_CHAT_ID);
    xEngine.startSchedules();
  }
  console.log('AJ running on port ' + PORT);
  if (WEBHOOK_URL) {
    const webhookEndpoint = WEBHOOK_URL + '/webhook/' + TELEGRAM_TOKEN;
    await bot.setWebHook(webhookEndpoint);
    console.log('Webhook set: ' + webhookEndpoint);
  }
});
