# Outbound Engagement & Autonomous Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two capabilities to AJ: (1) proactive outbound engagement — AJ finds tweets to reply to every 2 hours and sends drafts for approval, and (2) autonomous posting — AJ posts directly to X up to 3x/day when confidence is high, no approval needed.

**Architecture:** Both features are added to `x-engine.js` as new exported async functions (`outboundEngagementScan`, `autonomousPostCheck`) and registered as cron jobs in `x-engine.js`'s `startSchedules()`. New DB tables (`x_watchlist`, `x_engagement_log`) and a new `source` column on `x_posts` support the features. Three new Telegram commands (`/watchlist`, `/watch`, `/unwatch`) are added to `index.js`. No new files created.

**Tech Stack:** Node.js, PostgreSQL (`pg`), `twitter-api-v2`, `@anthropic-ai/sdk`, `node-cron`, Telegram Bot API

---

## File Map

| File | Changes |
|---|---|
| `x-engine.js` | Add `initXDB` table migrations, `outboundEngagementScan()`, `autonomousPostCheck()`, register 2 new crons in `startSchedules()`, export new functions |
| `index.js` | Add `/watchlist`, `/watch`, `/unwatch` command handlers, update `/xview` to show `[autonomous]` tag from DB, update morning briefing cron to include autonomous post summary |

---

## Task 1: DB Migrations

**Files:**
- Modify: `x-engine.js` — `initXDB()` function (lines ~17–51)

- [ ] **Step 1: Add new tables and column to `initXDB()`**

In `x-engine.js`, find `initXDB()` and add the following three queries after the existing `ALTER TABLE` patches (after line ~33, before `console.log('X DB ready')`):

```javascript
  await pool.query(`
    CREATE TABLE IF NOT EXISTS x_watchlist (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      added_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS x_engagement_log (
      id SERIAL PRIMARY KEY,
      tweet_id TEXT NOT NULL,
      author_username TEXT,
      reply_content TEXT,
      replied_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'scheduled'`);
```

- [ ] **Step 2: Manually verify migrations run**

Deploy/restart the bot locally and check logs for `X DB ready` with no errors. Then run:
```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'x_posts' AND column_name = 'source';
SELECT table_name FROM information_schema.tables WHERE table_name IN ('x_watchlist', 'x_engagement_log');
```
Expected: 3 rows returned.

- [ ] **Step 3: Commit**

```bash
git add x-engine.js
git commit -m "feat: add x_watchlist, x_engagement_log tables and source column to x_posts"
```

---

## Task 2: Watchlist Telegram Commands

**Files:**
- Modify: `index.js` — command handler block (around line 637–678)

- [ ] **Step 1: Add `/watchlist`, `/watch`, `/unwatch` handlers**

In `index.js`, find the `/xscan` handler block and add the following three handlers immediately before it:

```javascript
    if (textLower === '/watchlist') {
      const { rows } = await pool.query('SELECT username FROM x_watchlist ORDER BY added_at DESC');
      if (rows.length === 0) {
        await bot.sendMessage(chatId, 'Watchlist is empty. Use /watch @username to add accounts.');
      } else {
        await bot.sendMessage(chatId, 'Watching:\n\n' + rows.map(r => '@' + r.username).join('\n'));
      }
      return;
    }

    if (textLower.startsWith('/watch ')) {
      const username = text.replace(/^\/watch /i, '').replace(/^@/, '').trim().toLowerCase();
      if (!username) { await bot.sendMessage(chatId, 'Usage: /watch @username'); return; }
      await pool.query(
        'INSERT INTO x_watchlist (username) VALUES ($1) ON CONFLICT (username) DO NOTHING',
        [username]
      );
      await bot.sendMessage(chatId, 'Added @' + username + ' to watchlist.');
      return;
    }

    if (textLower.startsWith('/unwatch ')) {
      const username = text.replace(/^\/unwatch /i, '').replace(/^@/, '').trim().toLowerCase();
      const { rowCount } = await pool.query('DELETE FROM x_watchlist WHERE username = $1', [username]);
      await bot.sendMessage(chatId, rowCount > 0 ? 'Removed @' + username + ' from watchlist.' : '@' + username + ' was not in the watchlist.');
      return;
    }
```

- [ ] **Step 2: Manually test commands**

Start the bot. Send these messages to it in Telegram:
- `/watch @levelsio` → expect: "Added @levelsio to watchlist."
- `/watchlist` → expect: list showing @levelsio
- `/unwatch @levelsio` → expect: "Removed @levelsio from watchlist."
- `/watchlist` → expect: "Watchlist is empty."

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add /watchlist /watch /unwatch telegram commands"
```

---

## Task 3: Outbound Engagement Scan

**Files:**
- Modify: `x-engine.js` — add `outboundEngagementScan()` function before `startSchedules()`

- [ ] **Step 1: Add the function**

In `x-engine.js`, add the following function immediately before the `// ── SCHEDULING ─` comment block:

```javascript
// ── OUTBOUND ENGAGEMENT SCAN ──────────────────────────────
async function outboundEngagementScan() {
  if (!process.env.X_API_KEY || !telegramBot || !joshuaChatId) return;
  if (process.env.X_PAUSED === 'true') return;
  try {
    console.log('Running outbound engagement scan...');
    const { TwitterApi } = require('twitter-api-v2');
    const tw = new TwitterApi({
      appKey: process.env.X_API_KEY,
      appSecret: process.env.X_API_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_SECRET,
    });

    const tweetFields = ['author_id', 'created_at', 'text', 'public_metrics'];
    const userFields = ['username', 'name', 'public_metrics'];
    const expansions = ['author_id'];

    // Load already-engaged tweet IDs and recently-replied usernames
    const { rows: logRows } = await pool.query(
      "SELECT tweet_id, author_username FROM x_engagement_log WHERE replied_at > NOW() - INTERVAL '24 hours'"
    );
    const engagedTweetIds = new Set(logRows.map(r => r.tweet_id));
    const recentlyRepliedUsers = new Set(logRows.map(r => r.author_username?.toLowerCase()).filter(Boolean));

    const candidates = [];

    // 1. Topic keyword search
    const keywords = ['"AI agents"', '"vibe coding"', '"startup"', '"Solana"'];
    for (const kw of keywords) {
      try {
        const results = await tw.v2.search(kw + ' -is:retweet -from:AJ_agentic lang:en', {
          max_results: 10,
          'tweet.fields': tweetFields,
          'user.fields': userFields,
          expansions,
        });
        const tweets = results.data?.data || [];
        const userMap = {};
        (results.data?.includes?.users || []).forEach(u => { userMap[u.id] = u; });

        for (const tweet of tweets) {
          const author = userMap[tweet.author_id];
          if (!author) continue;
          const username = author.username.toLowerCase();
          if (engagedTweetIds.has(tweet.id)) continue;
          if (recentlyRepliedUsers.has(username)) continue;
          candidates.push({ tweet, author, source: 'keyword:' + kw });
        }
      } catch (e) {
        console.error('Keyword search error for ' + kw + ':', e.message);
      }
    }

    // 2. Watchlist account scan
    const { rows: watchlist } = await pool.query('SELECT username FROM x_watchlist');
    for (const { username } of watchlist) {
      if (recentlyRepliedUsers.has(username.toLowerCase())) continue;
      try {
        const user = await tw.v2.userByUsername(username, { 'user.fields': ['id'] });
        if (!user.data) continue;
        const timeline = await tw.v2.userTimeline(user.data.id, {
          max_results: 5,
          'tweet.fields': tweetFields,
          exclude: ['retweets', 'replies'],
        });
        const tweets = timeline.data?.data || [];
        for (const tweet of tweets) {
          if (engagedTweetIds.has(tweet.id)) continue;
          candidates.push({ tweet, author: { username, name: username }, source: 'watchlist' });
          break; // Only take most recent tweet per watchlist account
        }
      } catch (e) {
        console.error('Watchlist scan error for @' + username + ':', e.message);
      }
    }

    if (candidates.length === 0) {
      console.log('No engagement candidates found.');
      return;
    }

    // Score candidates with Claude
    const candidateSummaries = candidates.slice(0, 20).map((c, i) =>
      i + '. @' + c.author.username + ' [' + c.source + ']: ' + c.tweet.text.substring(0, 200)
    ).join('\n\n');

    const scoreResponse = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are AJ (@AJ_agentic), an AI agent running 4 businesses. Score these tweets for reply-worthiness (0-10).
Criteria: relevance to AI/startups/crypto, something sharp to say, quality of the account.
Reply ONLY with JSON array: [{"index": 0, "score": 8}, ...]

Tweets:
${candidateSummaries}`
      }]
    });

    let scores = [];
    try {
      const jsonMatch = scoreResponse.content[0].text.match(/\[[\s\S]*\]/);
      scores = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
      console.error('Score parse error:', e.message);
      return;
    }

    // Pick top 1-2 with score >= 6
    const top = scores
      .filter(s => s.score >= 6)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    if (top.length === 0) {
      console.log('No candidates scored >= 6.');
      return;
    }

    for (const { index } of top) {
      const candidate = candidates[index];
      if (!candidate) continue;

      const replyContext = '@' + candidate.author.username + ' said: "' + candidate.tweet.text + '"';
      const replyContent = await generatePost('reply', replyContext);

      // Save to pending_x_posts with tweet ID encoded in post_type for approval flow
      const postType = 'mention_reply:' + candidate.tweet.id;
      const { rows } = await pool.query(
        'INSERT INTO pending_x_posts (content, post_type, status) VALUES ($1, $2, $3) RETURNING id',
        [replyContent, postType, 'pending']
      );

      // Save last_shown_draft so AJ knows what "that draft" refers to
      const memVal = JSON.stringify({ id: rows[0]?.id, content: replyContent, postType, savedAt: new Date().toISOString() });
      await pool.query(
        `INSERT INTO memories (category, content) VALUES ('last_shown_draft', $1)
         ON CONFLICT DO NOTHING`,
        [memVal]
      ).catch(() =>
        pool.query("UPDATE memories SET content = $1 WHERE category = 'last_shown_draft'", [memVal])
      );

      const safe = replyContent.replace(/[*_`\[\]]/g, '');
      const safeTweet = candidate.tweet.text.substring(0, 200).replace(/[*_`\[\]]/g, '');
      await telegramBot.sendMessage(joshuaChatId,
        'Engagement pick [@' + candidate.author.username + ']:\n\n"' + safeTweet + '"\n\nDraft reply:\n\n' + safe + '\n\nYES to reply · NO to skip'
      );

      // Log this tweet as engaged so we don't re-surface it
      await pool.query(
        'INSERT INTO x_engagement_log (tweet_id, author_username, reply_content) VALUES ($1, $2, $3)',
        [candidate.tweet.id, candidate.author.username, replyContent]
      );
    }

    console.log('Outbound engagement scan complete. Sent ' + top.length + ' candidate(s).');
  } catch (e) {
    console.error('outboundEngagementScan error:', e.message);
  }
}
```

- [ ] **Step 2: Manually test the scan**

Temporarily call `outboundEngagementScan()` inside the bot startup (after `initXDB()`) and check:
- Console logs show scan running with no crash
- If a candidate is found, Telegram message arrives
- `x_engagement_log` table gets a row inserted

Remove the temporary startup call after testing.

- [ ] **Step 3: Commit**

```bash
git add x-engine.js
git commit -m "feat: add outboundEngagementScan — X keyword + watchlist reply candidates"
```

---

## Task 4: Autonomous Post Check

**Files:**
- Modify: `x-engine.js` — add `autonomousPostCheck()` function after `outboundEngagementScan()`

- [ ] **Step 1: Add the function**

In `x-engine.js`, add immediately after `outboundEngagementScan()` and before the `// ── SCHEDULING ─` comment:

```javascript
// ── AUTONOMOUS POST CHECK ─────────────────────────────────
async function autonomousPostCheck() {
  if (!process.env.X_API_KEY || !telegramBot || !joshuaChatId) return;
  if (process.env.X_PAUSED === 'true') return;
  try {
    console.log('Running autonomous post check...');

    // Gate 1: Daily cap — max 3 autonomous posts per day
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { rows: todayPosts } = await pool.query(
      "SELECT COUNT(*) FROM x_posts WHERE source = 'autonomous' AND posted_at >= $1",
      [today]
    );
    if (parseInt(todayPosts[0].count) >= 3) {
      console.log('Autonomous post cap reached (3/day). Skipping.');
      return;
    }

    // Gate 2: Cooldown — last autonomous post must be >= 2 hours ago
    const { rows: lastAuto } = await pool.query(
      "SELECT posted_at FROM x_posts WHERE source = 'autonomous' ORDER BY posted_at DESC LIMIT 1"
    );
    if (lastAuto.length > 0) {
      const msSinceLast = Date.now() - new Date(lastAuto[0].posted_at).getTime();
      if (msSinceLast < 2 * 60 * 60 * 1000) {
        console.log('Autonomous post cooldown active. Skipping.');
        return;
      }
    }

    // Gate 3: Variety — last two posts can't be the same post_type
    const { rows: lastTwo } = await pool.query(
      "SELECT post_type FROM x_posts ORDER BY created_at DESC LIMIT 2"
    );
    if (lastTwo.length === 2 && lastTwo[0].post_type === lastTwo[1].post_type) {
      console.log('Variety gate blocked — last two posts are same type. Skipping.');
      return;
    }

    // All gates passed — generate content
    const news = await webSearch('AI agents startups trending today 2026');
    const { rows: last5 } = await pool.query(
      "SELECT content, post_type FROM x_posts ORDER BY created_at DESC LIMIT 5"
    );
    const recentPostsSummary = last5.map(r => '[' + r.post_type + '] ' + r.content.substring(0, 100)).join('\n');

    const genResponse = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are AJ (@AJ_agentic), an AI agent running 4 businesses. Decide what to post on X right now.

Current time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT
Recent posts (avoid repeating topics):
${recentPostsSummary}

Trending context:
${news.substring(0, 500)}

Write one X post under 280 chars. Voice: chill, sharp, unbothered, already winning. No hashtags.
Pick a post_type from: hot_take, build_update, morning, ai_news

Reply ONLY with JSON: {"content": "...", "post_type": "...", "confidence": 8}
Confidence 1-10: how good and on-brand is this post? Be honest.`
      }]
    });

    let parsed;
    try {
      const jsonMatch = genResponse.content[0].text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (e) {
      console.error('Autonomous post JSON parse error:', e.message);
      return;
    }

    if (!parsed || !parsed.content) {
      console.log('Autonomous post generation returned no content.');
      return;
    }

    const { content, post_type, confidence } = parsed;
    console.log('Autonomous post generated. Confidence:', confidence, '| Type:', post_type);

    if (confidence >= 7) {
      // Post directly
      const tweetId = await postToX(content);
      if (tweetId) {
        // Update source to 'autonomous' (postToX inserts with 'scheduled' default)
        await pool.query(
          "UPDATE x_posts SET source = 'autonomous', post_type = $1 WHERE tweet_id = $2",
          [post_type, tweetId]
        );
        console.log('Autonomous post live:', tweetId);
      }
    } else if (confidence >= 5) {
      // Send for approval
      await sendForApproval(content, post_type);
      console.log('Autonomous post sent for approval (confidence ' + confidence + ').');
    } else {
      console.log('Autonomous post skipped (confidence ' + confidence + ' < 5).');
    }
  } catch (e) {
    console.error('autonomousPostCheck error:', e.message);
  }
}
```

- [ ] **Step 2: Manually test gates**

Temporarily add this test block right after the function definition (remove after testing):

```javascript
// TEMP TEST — remove after verifying
(async () => {
  console.log('=== TESTING GATES ===');
  await autonomousPostCheck();
  console.log('=== GATES TEST DONE ===');
})();
```

Start the bot. Verify in console:
- First run: should proceed past all gates (no posts yet today)
- Check logs: either "Autonomous post live", "sent for approval", or "skipped" — no crash

Remove the temp test block.

- [ ] **Step 3: Commit**

```bash
git add x-engine.js
git commit -m "feat: add autonomousPostCheck — 3-gate system with confidence-based auto-posting"
```

---

## Task 5: Register Crons and Export New Functions

**Files:**
- Modify: `x-engine.js` — `startSchedules()` and `module.exports`

- [ ] **Step 1: Add cron jobs to `startSchedules()`**

In `x-engine.js`, find `startSchedules()` and add two new lines after the existing `scanViralPosts` cron line:

```javascript
  cron.schedule('0 */2 * * *', outboundEngagementScan, { timezone: 'America/Chicago' });
  cron.schedule('*/90 * * * *', autonomousPostCheck, { timezone: 'America/Chicago' });
```

The full `startSchedules()` should now look like:

```javascript
function startSchedules() {
  cron.schedule('0 8 * * *', morningPost, { timezone: 'America/Chicago' });
  cron.schedule('0 12 * * *', middayHotTake, { timezone: 'America/Chicago' });
  cron.schedule('0 18 * * *', eveningBuildUpdate, { timezone: 'America/Chicago' });
  cron.schedule('0 10 * * 1,3,5', aiNewsPost, { timezone: 'America/Chicago' });
  cron.schedule('0 9 * * 2', weeklyThread, { timezone: 'America/Chicago' });
  cron.schedule('*/30 * * * *', checkMentions, { timezone: 'America/Chicago' });
  cron.schedule('0 9,13,19 * * *', scanViralPosts, { timezone: 'America/Chicago' });
  cron.schedule('0 */2 * * *', outboundEngagementScan, { timezone: 'America/Chicago' });
  cron.schedule('*/90 * * * *', autonomousPostCheck, { timezone: 'America/Chicago' });
  console.log('X engine ready @AJ_agentic');
}
```

- [ ] **Step 2: Add new functions to `module.exports`**

Find `module.exports` at the bottom of `x-engine.js` and add `outboundEngagementScan` and `autonomousPostCheck`:

```javascript
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
  outboundEngagementScan,
  autonomousPostCheck,
  startSchedules,
};
```

- [ ] **Step 3: Verify bot starts cleanly**

Start the bot. Expected console output includes:
```
X DB ready
X engine ready @AJ_agentic
```
No errors about undefined functions.

- [ ] **Step 4: Commit**

```bash
git add x-engine.js
git commit -m "feat: register outboundEngagementScan and autonomousPostCheck crons"
```

---

## Task 6: Update /xview to Show [autonomous] Tag

**Files:**
- Modify: `index.js` — `/xview` handler (around line 637)

- [ ] **Step 1: Update `/xview` to pull from DB and label autonomous posts**

Find the `/xview` handler in `index.js`. Replace the entire handler with:

```javascript
    if (textLower === '/xview') {
      try {
        const { rows } = await pool.query(
          "SELECT content, tweet_id, post_type, source, posted_at FROM x_posts ORDER BY created_at DESC LIMIT 15"
        );
        if (rows.length === 0) { await bot.sendMessage(chatId, 'No posts on @AJ_agentic yet.'); return; }
        let msg = '@AJ_agentic recent posts:\n\n';
        rows.forEach((t, i) => {
          const tag = t.source === 'autonomous' ? '[auto] ' : '';
          const type = t.post_type ? '[' + t.post_type + '] ' : '';
          const link = t.tweet_id ? '\nhttps://x.com/AJ_agentic/status/' + t.tweet_id : '';
          const when = t.posted_at ? ' (' + new Date(t.posted_at).toLocaleDateString() + ')' : '';
          msg += (i + 1) + '. ' + tag + type + when + '\n' + t.content.substring(0, 120) + link + '\n\n';
        });
        await bot.sendMessage(chatId, msg);
      } catch (e) {
        await bot.sendMessage(chatId, 'Could not load posts: ' + e.message);
      }
      return;
    }
```

- [ ] **Step 2: Test /xview**

Send `/xview` to the bot. Verify:
- Posts display with type tags
- Any posts with `source = 'autonomous'` show `[auto]` prefix
- Links are present for posts with tweet IDs

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: update /xview to show [auto] tag for autonomous posts"
```

---

## Task 7: Add Autonomous Post Summary to Morning Briefing

**Files:**
- Modify: `index.js` — morning briefing cron (find where the morning briefing message is sent to Josh)

- [ ] **Step 1: Find the morning briefing**

Search `index.js` for `morning briefing` or `8am` to find where the daily summary is sent to Josh.

- [ ] **Step 2: Add yesterday's autonomous post count to briefing**

In the morning briefing function/handler, add this block to pull yesterday's autonomous posts and append to the briefing message:

```javascript
    // Autonomous posts from yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const { rows: autoPosts } = await pool.query(
      "SELECT content FROM x_posts WHERE source = 'autonomous' AND posted_at >= $1 AND posted_at < $2 ORDER BY posted_at ASC",
      [yesterday, todayMidnight]
    );
    let autonomousSummary = '';
    if (autoPosts.length > 0) {
      autonomousSummary = '\n\nI posted ' + autoPosts.length + ' time(s) autonomously yesterday:\n' +
        autoPosts.map((p, i) => (i + 1) + '. ' + p.content.substring(0, 100)).join('\n');
    }
```

Then append `autonomousSummary` to the end of the briefing message string before sending.

- [ ] **Step 3: Test by sending `/xtest` or manually triggering briefing**

Trigger the morning post flow and verify the message format is correct with no crashes.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: include yesterday autonomous post summary in morning briefing"
```

---

## Self-Review Checklist

- [x] **Spec coverage:**
  - `x_watchlist` table ✓ (Task 1)
  - `x_engagement_log` table ✓ (Task 1)
  - `source` column on `x_posts` ✓ (Task 1)
  - `/watchlist`, `/watch`, `/unwatch` commands ✓ (Task 2)
  - `outboundEngagementScan()` with keyword + watchlist + scoring ✓ (Task 3)
  - 24h dedup on accounts ✓ (Task 3 — `recentlyRepliedUsers` set)
  - `autonomousPostCheck()` with 3 gates ✓ (Task 4)
  - Confidence ≥7 auto-posts, 5-6 sends for approval, <5 skips ✓ (Task 4)
  - Max 3 autonomous posts/day ✓ (Task 4 — Gate 1)
  - Cron registration ✓ (Task 5)
  - `/xview` autonomous tag ✓ (Task 6)
  - Daily briefing summary ✓ (Task 7)

- [x] **No placeholders** — all steps have complete code
- [x] **Type consistency** — `outboundEngagementScan` and `autonomousPostCheck` names consistent across all tasks
- [x] **`postToX()` inserts with `source = 'scheduled'` default** — Task 4 immediately updates to `'autonomous'` after insert using the returned `tweetId`. This works because `postToX()` inserts and returns the `tweetId`.
