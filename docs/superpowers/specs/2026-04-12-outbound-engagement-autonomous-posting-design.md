# AJ Bot — Outbound Engagement & Autonomous Posting Design

**Date:** 2026-04-12  
**Status:** Approved  
**Scope:** Two new features added to `x-engine.js` and `index.js`

---

## Feature 1: Outbound Engagement

### Overview

Every 2 hours, AJ scans X for tweets worth replying to using two parallel methods: topic keyword search and a curated account watchlist. Top candidates get a reply drafted and sent to Telegram for YES/NO approval — same flow as existing scheduled posts.

### Cron Schedule

```
every 2 hours — outboundEngagementScan()
```

### Topic Search

Search X for the following keywords (configurable):
- `"AI agents"`
- `"vibe coding"`
- `"startup"`
- `"Solana"`

Pull up to 10 recent tweets per keyword. Filter out:
- Retweets
- AJ's own posts (`from:AJ_agentic`)
- Tweets already in `x_engagement_log`
- Tweets from accounts replied to in the last 24h

### Watchlist Scan

Check the latest tweet from each account in `x_watchlist` table. Apply same filters as above.

### Scoring

Pass all candidates to Claude with a scoring prompt. Score each tweet 0–10 based on:
- Relevance to AJ's brand (AI, startups, building, crypto)
- Reply-worthiness (is there something sharp to say?)
- Account quality (is this someone worth engaging with?)

Pick top 1–2 tweets with score ≥ 6. Generate a reply for each. Send to Telegram for approval using existing `sendForApproval()` flow with `post_type = 'reply'`.

### New Database Tables

**`x_watchlist`**
```sql
id SERIAL PRIMARY KEY
username TEXT NOT NULL UNIQUE
added_at TIMESTAMP DEFAULT NOW()
```

**`x_engagement_log`**
```sql
id SERIAL PRIMARY KEY
tweet_id TEXT NOT NULL
author_username TEXT
reply_content TEXT
replied_at TIMESTAMP DEFAULT NOW()
```

### New Telegram Commands

| Command | Action |
|---|---|
| `/watchlist` | Show current watchlist accounts |
| `/watch @username` | Add account to watchlist |
| `/unwatch @username` | Remove account from watchlist |

---

## Feature 2: Autonomous Posting

### Overview

Every 90 minutes, AJ runs an autonomous post check. If three gates pass and Claude returns high-confidence content, AJ posts directly to X without asking for approval. Max 3 autonomous posts per day.

### Cron Schedule

```
every 90 minutes — autonomousPostCheck()
```

### Three Gates (must all pass)

1. **Daily cap gate** — count `x_posts` where `source = 'autonomous'` and `posted_at >= today`. If ≥ 3, skip.
2. **Cooldown gate** — last autonomous post must be ≥ 2 hours ago. If not, skip.
3. **Variety gate** — last two posts in `x_posts` cannot be the same `post_type`. If they match, skip.

### Post Generation & Scoring

If all gates pass:
1. Fetch trending AI/startup news via Brave search
2. Build scoring prompt for Claude — include: current time, last 5 posts (content + type), trending context, active task list
3. Claude returns JSON: `{ content, post_type, confidence }` where confidence is 1–10

### Posting Logic

| Confidence | Action |
|---|---|
| ≥ 7 | Post directly to X, log as `source = 'autonomous'` |
| 5–6 | Send to Telegram for approval (`source = 'approved'` if posted) |
| < 5 | Skip entirely |

### Database Change

Add `source` column to `x_posts`:
```sql
ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'scheduled';
```

Values: `autonomous`, `approved`, `scheduled`

### Visibility

- `/xview` will show `[autonomous]` tag on self-posted content
- AJ notifies Josh once per day with a summary of what he posted autonomously (morning briefing)

---

## Architecture Notes

Both features live in `x-engine.js` as new exported async functions:
- `outboundEngagementScan()`
- `autonomousPostCheck()`

Both are registered as cron jobs in `index.js` alongside existing crons. No new files needed. Both functions use the existing `postToX()`, `sendForApproval()`, `generatePost()`, and `webSearch()` utilities.

---

## Success Criteria

- AJ surfaces 1–2 reply candidates every 2 hours without duplicating accounts within 24h
- AJ posts autonomously up to 3x/day without any manual input when confidence ≥ 7
- All autonomous posts are clearly labeled in `/xview`
- No post goes live without passing all three gates
