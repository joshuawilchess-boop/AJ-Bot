# AJ SDR Foundation & Drafting Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a seeded e-commerce lead (a domain), AJ autonomously qualifies it, researches a true personalization hook, drafts an objection-aware cold email, runs it through an anti-generic QA gate, and queues it for Telegram approval — all visible on the dashboard. No paid/external sourcing APIs required.

**Architecture:** A new `sdr/` module directory holds focused, unit-testable units. A state-machine pipeline advances each lead one stage per tick; LLM judgment lives inside each node. All LLM and DB access is injected (a function passed in), so nodes are unit-tested with fakes — no live API/DB calls in tests. Minimal wiring into the existing `index.js` monolith (one cron, one dashboard query, one Telegram command).

**Tech Stack:** Node.js (CommonJS), `pg` (existing `pool`), `@anthropic-ai/sdk` (existing `client`, model `claude-opus-4-6`), `node-cron`, `node:test` + `node:assert` (built-in, zero new deps).

**This is Plan 1 of a sequence.** Later plans (not in this doc): Plan 2 — Store Leads + EmailFinder live adapters + Hunt cron; Plan 3 — send via Make.com + reply-watch + follow-up; Plan 4 — build-in-public X hook; Plan 5 — live Overflow dashboard integration. See `docs/superpowers/specs/2026-06-05-aj-overflow-sdr-design.md`.

---

## File Structure

```
sdr/
  llm.js            — askJson(client, prompt, {system}) → parsed JSON object (strips code fences, throws on bad JSON)
  leadsRepo.js      — makeLeadsRepo(query): create table SQL + CRUD + stage transitions
  playbook.js       — OVERFLOW_BRAIN seed text + loadPlaybook(query) / seedPlaybook(query)
  sources/
    manualSource.js — makeManualSource(repo): addByDomain(domain) → inserts a `sourced` lead
  nodes/
    qualify.js      — qualify(lead, playbook, llm) → { icp_score, notes, pass }
    research.js     — research(lead, deps) → { hook, leak_hypothesis, signals }
    draft.js        — draftEmail(lead, research, playbook, llm) → { subject, body }
    qa.js           — critique(email, lead, research, llm) → { score, pass, issues }
  pipeline.js       — makePipeline(deps): tick() advances each lead through one stage
test/
  llm.test.js
  leadsRepo.test.js
  qualify.test.js
  research.test.js
  draft.test.js
  qa.test.js
  pipeline.test.js
```

`index.js` modifications: register the leads table init, a pipeline cron, a `/api/dashboard` pipeline block, and a `/leads` Telegram command.

---

## Task 1: Test harness

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add a test script**

In `package.json`, add a `test` script. The `scripts` block becomes:

```json
  "scripts": {
    "start": "node index.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Verify the runner works with zero tests**

Run: `npm test`
Expected: exits 0 with output like `tests 0` / `pass 0` (Node's built-in runner finds no `*.test.js` yet).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add node:test runner script"
```

---

## Task 2: Leads repository

A factory `makeLeadsRepo(query)` taking an injected `query(sql, params)` function (in production, `pool.query`). This makes SQL/transition logic unit-testable with a fake that records calls.

**Files:**
- Create: `sdr/leadsRepo.js`
- Test: `test/leadsRepo.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/leadsRepo.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { makeLeadsRepo, CREATE_LEADS_TABLE, STAGES } = require('../sdr/leadsRepo');

function fakeQuery() {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ id: 1, domain: 'shop.com', stage: 'sourced' }], rowCount: 1 };
  };
  fn.calls = calls;
  return fn;
}

test('insertSourced inserts a lead in the sourced stage', async () => {
  const q = fakeQuery();
  const repo = makeLeadsRepo(q);
  const lead = await repo.insertSourced({ company: 'Shop', domain: 'shop.com', source: 'manual' });
  assert.equal(lead.domain, 'shop.com');
  assert.match(q.calls[0].sql, /INSERT INTO leads/i);
  assert.deepEqual(q.calls[0].params, ['Shop', 'shop.com', 'manual']);
});

test('advance sets stage and patch fields', async () => {
  const q = fakeQuery();
  const repo = makeLeadsRepo(q);
  await repo.advance(1, 'qualified', { icp_score: 80, qualification_notes: 'fits' });
  const { sql, params } = q.calls[0];
  assert.match(sql, /UPDATE leads SET/i);
  assert.match(sql, /stage = /i);
  assert.ok(params.includes('qualified'));
  assert.ok(params.includes(80));
  assert.ok(params.includes(1)); // id in WHERE
});

test('advance rejects an unknown stage', async () => {
  const repo = makeLeadsRepo(fakeQuery());
  await assert.rejects(() => repo.advance(1, 'bogus', {}), /unknown stage/i);
});

test('listByStage queries by stage with a limit', async () => {
  const q = fakeQuery();
  const repo = makeLeadsRepo(q);
  await repo.listByStage('sourced', 10);
  assert.match(q.calls[0].sql, /WHERE stage = \$1/i);
  assert.deepEqual(q.calls[0].params, ['sourced', 10]);
});

test('STAGES is the ordered pipeline', () => {
  assert.deepEqual(STAGES, [
    'sourced','qualified','researched','drafted','queued','sent','replied','followup','won','lost'
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/leadsRepo.test.js`
Expected: FAIL — `Cannot find module '../sdr/leadsRepo'`.

- [ ] **Step 3: Write the implementation**

```js
// sdr/leadsRepo.js
const STAGES = [
  'sourced', 'qualified', 'researched', 'drafted',
  'queued', 'sent', 'replied', 'followup', 'won', 'lost'
];

const CREATE_LEADS_TABLE = `
  CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    company TEXT,
    domain TEXT,
    contact_name TEXT,
    contact_email TEXT,
    email_status TEXT DEFAULT 'unknown',
    source TEXT,
    icp_score INT,
    qualification_notes TEXT,
    stage TEXT NOT NULL DEFAULT 'sourced',
    research_json JSONB,
    draft TEXT,
    last_action_at TIMESTAMPTZ DEFAULT NOW(),
    next_action_at TIMESTAMPTZ,
    reply_text TEXT,
    airtable_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`;

// Columns the pipeline is allowed to patch via advance().
const PATCHABLE = new Set([
  'icp_score', 'qualification_notes', 'research_json', 'draft',
  'contact_name', 'contact_email', 'email_status', 'reply_text',
  'next_action_at', 'airtable_id'
]);

function makeLeadsRepo(query) {
  return {
    async init() {
      await query(CREATE_LEADS_TABLE);
    },

    async insertSourced({ company, domain, source }) {
      const { rows } = await query(
        `INSERT INTO leads (company, domain, source, stage)
         VALUES ($1, $2, $3, 'sourced') RETURNING *`,
        [company, domain, source]
      );
      return rows[0];
    },

    async advance(id, stage, patch = {}) {
      if (!STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
      const sets = ['stage = $1', 'last_action_at = NOW()'];
      const params = [stage];
      let i = 2;
      for (const [k, v] of Object.entries(patch)) {
        if (!PATCHABLE.has(k)) continue;
        const val = k === 'research_json' && typeof v !== 'string' ? JSON.stringify(v) : v;
        sets.push(`${k} = $${i}`);
        params.push(val);
        i++;
      }
      params.push(id);
      const { rows } = await query(
        `UPDATE leads SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        params
      );
      return rows[0];
    },

    async listByStage(stage, limit = 25) {
      const { rows } = await query(
        `SELECT * FROM leads WHERE stage = $1 ORDER BY last_action_at ASC LIMIT $2`,
        [stage, limit]
      );
      return rows;
    },

    async stageCounts() {
      const { rows } = await query(
        `SELECT stage, COUNT(*)::int AS n FROM leads GROUP BY stage`
      );
      return rows.reduce((acc, r) => (acc[r.stage] = r.n, acc), {});
    }
  };
}

module.exports = { makeLeadsRepo, CREATE_LEADS_TABLE, STAGES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/leadsRepo.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add sdr/leadsRepo.js test/leadsRepo.test.js
git commit -m "feat(sdr): leads repository with stage transitions"
```

---

## Task 3: LLM JSON helper

A thin wrapper that calls the Anthropic client, expects JSON back, strips ``` fences, and parses. The client is injected so tests use a fake.

**Files:**
- Create: `sdr/llm.js`
- Test: `test/llm.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/llm.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { askJson, stripFences } = require('../sdr/llm');

function fakeClient(text) {
  return { messages: { create: async () => ({ content: [{ text }] }) } };
}

test('stripFences removes ```json fences', () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('{"a":1}'), '{"a":1}');
});

test('askJson returns a parsed object', async () => {
  const client = fakeClient('```json\n{"icp_score":80}\n```');
  const out = await askJson(client, 'prompt', { system: 'sys' });
  assert.deepEqual(out, { icp_score: 80 });
});

test('askJson throws a clear error on non-JSON', async () => {
  const client = fakeClient('not json at all');
  await assert.rejects(() => askJson(client, 'p', {}), /LLM did not return valid JSON/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/llm.test.js`
Expected: FAIL — `Cannot find module '../sdr/llm'`.

- [ ] **Step 3: Write the implementation**

```js
// sdr/llm.js
const MODEL = 'claude-opus-4-6';

function stripFences(text) {
  const t = String(text).trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (m ? m[1] : t).trim();
}

async function askJson(client, prompt, { system = '', maxTokens = 1024 } = {}) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }]
  });
  const raw = stripFences(res.content[0].text);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`LLM did not return valid JSON: ${raw.slice(0, 200)}`);
  }
}

module.exports = { askJson, stripFences, MODEL };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/llm.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add sdr/llm.js test/llm.test.js
git commit -m "feat(sdr): LLM JSON helper with fence stripping"
```

---

## Task 4: Overflow Brain / Sales Playbook

Seed text (offer, ICP rubric, objection matrix, frameworks, voice rules, spam checklist) stored in the existing `knowledge` table under `category='overflow_brain'`, plus loader/seed functions taking the injected `query`.

**Files:**
- Create: `sdr/playbook.js`
- Test: `test/playbook.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/playbook.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadPlaybook, seedPlaybook, OVERFLOW_BRAIN } = require('../sdr/playbook');

test('OVERFLOW_BRAIN contains the key sales sections', () => {
  for (const section of ['ICP', 'OBJECTION', 'FRAMEWORK', 'VOICE', 'SPAM']) {
    assert.match(OVERFLOW_BRAIN.toUpperCase(), new RegExp(section));
  }
});

test('seedPlaybook inserts only when absent', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT/i.test(sql)) return { rows: [{ n: 0 }] };
    return { rows: [], rowCount: 1 };
  };
  await seedPlaybook(query);
  assert.ok(calls.some(c => /INSERT INTO knowledge/i.test(c.sql)));
});

test('seedPlaybook is idempotent when already present', async () => {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    if (/SELECT/i.test(sql)) return { rows: [{ n: 1 }] };
    return { rows: [] };
  };
  await seedPlaybook(query);
  assert.ok(!calls.some(s => /INSERT INTO knowledge/i.test(s)));
});

test('loadPlaybook returns stored content or the default', async () => {
  const query = async () => ({ rows: [{ content: 'STORED BRAIN' }] });
  assert.equal(await loadPlaybook(query), 'STORED BRAIN');
  const empty = async () => ({ rows: [] });
  assert.equal(await loadPlaybook(empty), OVERFLOW_BRAIN);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/playbook.test.js`
Expected: FAIL — `Cannot find module '../sdr/playbook'`.

- [ ] **Step 3: Write the implementation**

```js
// sdr/playbook.js
const OVERFLOW_BRAIN = `# OVERFLOW REVIVE — SALES PLAYBOOK

## OFFER & MECHANISM
Overflow Revive is a done-for-you revenue recovery service for e-commerce brands.
We find and recover revenue the store is already losing (abandoned checkouts,
no post-purchase flows, no win-back, on-site friction). Performance-based: we are
paid a percentage of revenue we actually recover, so there is no upfront cost.

## ICP (qualification rubric)
- E-commerce store (Shopify/WooCommerce/etc.) doing roughly $50k–$500k/month.
- Sells physical or digital products direct to consumers.
- Shows at least one detectable revenue leak (see RESEARCH hooks).
- Disqualify: marketplaces, sub-$50k hobby stores, pure-service businesses,
  stores with no contactable owner/operator.
Score 0–100 on fit; >=60 passes to research.

## OBJECTION MATRIX (how AJ responds, by objection type)
- "We already run abandoned-cart / email flows" -> You're still leaving recoverable
  revenue your current setup misses; we only touch the gap, paid on what we recover.
- "We have an in-house team / agency" -> We complement them, not replace. We only get
  paid on incremental recovery on top of what they already produce.
- "Performance-based — what's the catch?" -> Aligned incentives. We lose if you lose.
  No retainer; a share of recovered revenue only.
- "We don't have a revenue problem" -> Most stores assume that. Here is the specific
  leak we spotted on your store: [research hook].
- "Just send info" -> Offer a 2-line teardown specific to their store, not a deck.
- "No budget / not interested" -> Zero upfront is the entire point; soft de-risk and
  leave the door open.

## FRAMEWORK (cold email structure)
Observation (true, specific to them) -> specific problem it causes -> relevant proof
-> one soft CTA. Under 120 words. No links on the first touch (deliverability).
Subject: short, lowercase, specific, no clickbait.

## VOICE
Founder-to-founder. Sharp, specific, concrete. No buzzwords or superlatives.
Never "I hope this email finds you well." Sound like a sharp operator, not a vendor.

## SPAM-AVOIDANCE CHECKLIST
- Must reference something true and specific to THIS store (no mail-merge feel).
- No spam-trigger words (free, guarantee, $$$, act now), minimal/zero links first touch.
- Plain text, one clear ask, includes a way to opt out on later touches.

## PROOF BANK
(Deploy selectively, only when relevant.)
- [Josh to fill: real case studies / recovery numbers.]
`;

const TITLE = 'Overflow Revive Sales Playbook';

async function seedPlaybook(query) {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS n FROM knowledge WHERE category = 'overflow_brain'"
  );
  if (rows[0].n > 0) return false;
  await query(
    `INSERT INTO knowledge (category, title, content, tags)
     VALUES ('overflow_brain', $1, $2, 'sdr,overflow,sales')`,
    [TITLE, OVERFLOW_BRAIN]
  );
  return true;
}

async function loadPlaybook(query) {
  const { rows } = await query(
    "SELECT content FROM knowledge WHERE category = 'overflow_brain' ORDER BY updated_at DESC LIMIT 1"
  );
  return rows.length ? rows[0].content : OVERFLOW_BRAIN;
}

module.exports = { OVERFLOW_BRAIN, seedPlaybook, loadPlaybook, TITLE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/playbook.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add sdr/playbook.js test/playbook.test.js
git commit -m "feat(sdr): Overflow Brain sales playbook seed + loader"
```

---

## Task 5: Manual lead source

A `LeadSource` whose v1 implementation lets Josh add a lead by domain. Establishes the interface that Plan 2's `StoreLeadsAdapter` will implement.

**Files:**
- Create: `sdr/sources/manualSource.js`
- Test: `test/manualSource.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/manualSource.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { makeManualSource } = require('../sdr/sources/manualSource');

function fakeRepo() {
  const inserted = [];
  return {
    inserted,
    insertSourced: async (lead) => { inserted.push(lead); return { id: 1, ...lead }; }
  };
}

test('addByDomain normalizes the domain and inserts a sourced lead', async () => {
  const repo = fakeRepo();
  const src = makeManualSource(repo);
  const lead = await src.addByDomain('https://Shop.com/path');
  assert.equal(repo.inserted[0].domain, 'shop.com');
  assert.equal(repo.inserted[0].source, 'manual');
  assert.equal(lead.id, 1);
});

test('addByDomain rejects an empty domain', async () => {
  const src = makeManualSource(fakeRepo());
  await assert.rejects(() => src.addByDomain('   '), /domain required/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/manualSource.test.js`
Expected: FAIL — `Cannot find module '../sdr/sources/manualSource'`.

- [ ] **Step 3: Write the implementation**

```js
// sdr/sources/manualSource.js
function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0];
  return d;
}

function makeManualSource(repo) {
  return {
    name: 'manual',
    async addByDomain(input) {
      const domain = normalizeDomain(input);
      if (!domain) throw new Error('domain required');
      return repo.insertSourced({ company: domain, domain, source: 'manual' });
    }
  };
}

module.exports = { makeManualSource, normalizeDomain };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/manualSource.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add sdr/sources/manualSource.js test/manualSource.test.js
git commit -m "feat(sdr): manual lead source (add by domain)"
```

---

## Task 6: Qualify node

`qualify(lead, playbook, llm)` where `llm` is an async `(prompt) => object`. Builds the prompt, calls llm, normalizes the result, and decides `pass` against a threshold of 60.

**Files:**
- Create: `sdr/nodes/qualify.js`
- Test: `test/qualify.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/qualify.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { qualify, QUALIFY_THRESHOLD } = require('../sdr/nodes/qualify');

const lead = { domain: 'shop.com', company: 'Shop' };

test('qualify passes a high-scoring lead', async () => {
  const llm = async () => ({ icp_score: 82, notes: 'great fit' });
  const out = await qualify(lead, 'PLAYBOOK', llm);
  assert.equal(out.pass, true);
  assert.equal(out.icp_score, 82);
  assert.equal(out.notes, 'great fit');
});

test('qualify fails a low-scoring lead', async () => {
  const llm = async () => ({ icp_score: 30, notes: 'too small' });
  const out = await qualify(lead, 'PLAYBOOK', llm);
  assert.equal(out.pass, false);
});

test('qualify clamps out-of-range scores and defaults notes', async () => {
  const llm = async () => ({ icp_score: 250 });
  const out = await qualify(lead, 'PLAYBOOK', llm);
  assert.equal(out.icp_score, 100);
  assert.equal(typeof out.notes, 'string');
});

test('qualify passes the playbook and domain into the prompt', async () => {
  let seen = '';
  const llm = async (prompt) => { seen = prompt; return { icp_score: 70 }; };
  await qualify(lead, 'MY_PLAYBOOK', llm);
  assert.match(seen, /MY_PLAYBOOK/);
  assert.match(seen, /shop\.com/);
});

test('QUALIFY_THRESHOLD is 60', () => {
  assert.equal(QUALIFY_THRESHOLD, 60);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/qualify.test.js`
Expected: FAIL — `Cannot find module '../sdr/nodes/qualify'`.

- [ ] **Step 3: Write the implementation**

```js
// sdr/nodes/qualify.js
const QUALIFY_THRESHOLD = 60;

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function buildPrompt(lead, playbook) {
  return `You are a B2B sales qualifier. Using the ICP rubric in the playbook below,
score how well this lead fits, 0-100.

PLAYBOOK:
${playbook}

LEAD:
company: ${lead.company || ''}
domain: ${lead.domain || ''}

Return ONLY JSON: {"icp_score": <0-100 integer>, "notes": "<one-sentence reason>"}`;
}

async function qualify(lead, playbook, llm) {
  const raw = await llm(buildPrompt(lead, playbook));
  const icp_score = clampScore(raw && raw.icp_score);
  const notes = (raw && typeof raw.notes === 'string') ? raw.notes : 'no notes';
  return { icp_score, notes, pass: icp_score >= QUALIFY_THRESHOLD };
}

module.exports = { qualify, QUALIFY_THRESHOLD, clampScore, buildPrompt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/qualify.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add sdr/nodes/qualify.js test/qualify.test.js
git commit -m "feat(sdr): qualify node with ICP scoring threshold"
```

---

## Task 7: Research node

`research(lead, { fetchText, llm })` fetches the store's homepage text (injected `fetchText(url)`), then asks the llm for a true personalization hook + revenue-leak hypothesis. Returns a structured object.

**Files:**
- Create: `sdr/nodes/research.js`
- Test: `test/research.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/research.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { research } = require('../sdr/nodes/research');

const lead = { domain: 'shop.com', company: 'Shop' };

test('research returns hook, leak hypothesis, and signals', async () => {
  const deps = {
    fetchText: async () => 'We sell candles. Subscribe for 10% off.',
    llm: async () => ({
      hook: 'no post-purchase upsell on the candle line',
      leak_hypothesis: 'leaving repeat revenue on the table',
      signals: ['has popup discount', 'no subscription tier']
    })
  };
  const out = await research(lead, deps);
  assert.match(out.hook, /candle/);
  assert.equal(out.leak_hypothesis, 'leaving repeat revenue on the table');
  assert.ok(Array.isArray(out.signals));
});

test('research still returns a result when the fetch fails', async () => {
  const deps = {
    fetchText: async () => { throw new Error('network'); },
    llm: async () => ({ hook: 'generic', leak_hypothesis: 'unknown', signals: [] })
  };
  const out = await research(lead, deps);
  assert.equal(out.hook, 'generic');
});

test('research feeds fetched page text into the llm prompt', async () => {
  let seen = '';
  const deps = {
    fetchText: async () => 'UNIQUE_PAGE_MARKER',
    llm: async (p) => { seen = p; return { hook: 'h', leak_hypothesis: 'l', signals: [] }; }
  };
  await research(lead, deps);
  assert.match(seen, /UNIQUE_PAGE_MARKER/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/research.test.js`
Expected: FAIL — `Cannot find module '../sdr/nodes/research'`.

- [ ] **Step 3: Write the implementation**

```js
// sdr/nodes/research.js
function buildPrompt(lead, pageText) {
  return `You are a sales researcher. From this e-commerce store's homepage text,
find ONE true, specific personalization hook and a revenue-leak hypothesis Overflow
Revive could fix. Be concrete; never invent facts not supported by the text.

STORE: ${lead.company || lead.domain} (${lead.domain})

HOMEPAGE TEXT (may be empty):
${pageText.slice(0, 4000)}

Return ONLY JSON:
{"hook":"<specific observation true of this store>",
 "leak_hypothesis":"<the revenue leak it implies>",
 "signals":["<short signal>", "..."]}`;
}

async function research(lead, { fetchText, llm }) {
  let pageText = '';
  try {
    pageText = (await fetchText(`https://${lead.domain}`)) || '';
  } catch (e) {
    pageText = '';
  }
  const raw = await llm(buildPrompt(lead, pageText));
  return {
    hook: (raw && raw.hook) || '',
    leak_hypothesis: (raw && raw.leak_hypothesis) || '',
    signals: Array.isArray(raw && raw.signals) ? raw.signals : []
  };
}

module.exports = { research, buildPrompt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/research.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add sdr/nodes/research.js test/research.test.js
git commit -m "feat(sdr): research node extracting personalization hook"
```

---

## Task 8: Draft node

`draftEmail(lead, research, playbook, llm)` produces `{ subject, body }`, grounded in the research hook + playbook frameworks/voice.

**Files:**
- Create: `sdr/nodes/draft.js`
- Test: `test/draft.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/draft.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { draftEmail } = require('../sdr/nodes/draft');

const lead = { domain: 'shop.com', company: 'Shop' };
const researchObj = { hook: 'no win-back flow', leak_hypothesis: 'lost repeat buyers', signals: [] };

test('draftEmail returns subject and body', async () => {
  const llm = async () => ({ subject: 'quick thing on shop.com', body: 'Noticed no win-back flow...' });
  const out = await draftEmail(lead, researchObj, 'PLAYBOOK', llm);
  assert.equal(out.subject, 'quick thing on shop.com');
  assert.match(out.body, /win-back/);
});

test('draftEmail injects the research hook and playbook into the prompt', async () => {
  let seen = '';
  const llm = async (p) => { seen = p; return { subject: 's', body: 'b' }; };
  await draftEmail(lead, researchObj, 'MY_PLAYBOOK', llm);
  assert.match(seen, /no win-back flow/);
  assert.match(seen, /MY_PLAYBOOK/);
});

test('draftEmail throws if the hook is empty (no generic outreach)', async () => {
  const llm = async () => ({ subject: 's', body: 'b' });
  await assert.rejects(
    () => draftEmail(lead, { hook: '', leak_hypothesis: '', signals: [] }, 'P', llm),
    /no research hook/i
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/draft.test.js`
Expected: FAIL — `Cannot find module '../sdr/nodes/draft'`.

- [ ] **Step 3: Write the implementation**

```js
// sdr/nodes/draft.js
function buildPrompt(lead, research, playbook) {
  return `You are a pro SDR writing a cold email for Overflow Revive.
Follow the FRAMEWORK, VOICE, and SPAM-AVOIDANCE rules in the playbook exactly.
Anchor the email on the specific research hook — it must read as written for THIS
store only. Under 120 words. No links.

PLAYBOOK:
${playbook}

STORE: ${lead.company || lead.domain} (${lead.domain})
RESEARCH HOOK: ${research.hook}
REVENUE LEAK: ${research.leak_hypothesis}

Return ONLY JSON: {"subject":"<short lowercase subject>","body":"<email body>"}`;
}

async function draftEmail(lead, research, playbook, llm) {
  if (!research || !research.hook || !research.hook.trim()) {
    throw new Error('no research hook — refusing to draft generic outreach');
  }
  const raw = await llm(buildPrompt(lead, research, playbook));
  return {
    subject: (raw && raw.subject) || '',
    body: (raw && raw.body) || ''
  };
}

module.exports = { draftEmail, buildPrompt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/draft.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add sdr/nodes/draft.js test/draft.test.js
git commit -m "feat(sdr): draft node anchored on research hook"
```

---

## Task 9: QA / Critique gate

`critique(email, lead, research, llm)` returns `{ score, pass, issues }`. The skeptical-founder gate; passes only at score >= 70.

**Files:**
- Create: `sdr/nodes/qa.js`
- Test: `test/qa.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/qa.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { critique, QA_THRESHOLD } = require('../sdr/nodes/qa');

const email = { subject: 's', body: 'b' };
const lead = { domain: 'shop.com' };
const researchObj = { hook: 'no win-back flow' };

test('critique passes a strong email', async () => {
  const llm = async () => ({ score: 85, issues: [] });
  const out = await critique(email, lead, researchObj, llm);
  assert.equal(out.pass, true);
  assert.equal(out.score, 85);
});

test('critique fails a generic email and returns issues', async () => {
  const llm = async () => ({ score: 40, issues: ['reads like mail-merge', 'vague ask'] });
  const out = await critique(email, lead, researchObj, llm);
  assert.equal(out.pass, false);
  assert.deepEqual(out.issues, ['reads like mail-merge', 'vague ask']);
});

test('critique clamps score and tolerates missing issues', async () => {
  const llm = async () => ({ score: -5 });
  const out = await critique(email, lead, researchObj, llm);
  assert.equal(out.score, 0);
  assert.ok(Array.isArray(out.issues));
});

test('QA_THRESHOLD is 70', () => {
  assert.equal(QA_THRESHOLD, 70);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/qa.test.js`
Expected: FAIL — `Cannot find module '../sdr/nodes/qa'`.

- [ ] **Step 3: Write the implementation**

```js
// sdr/nodes/qa.js
const QA_THRESHOLD = 70;

function clamp(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function buildPrompt(email, lead, research) {
  return `You are a busy e-commerce founder who gets 20 cold emails a day.
Critique this outreach for the store ${lead.domain}. Score 0-100 on:
1) would you reply, 2) is it specific to you (not mail-merge), 3) any spam triggers,
4) is the ask one clear low-friction step.

RESEARCH HOOK IT SHOULD USE: ${research.hook}
SUBJECT: ${email.subject}
BODY: ${email.body}

Return ONLY JSON: {"score":<0-100>,"issues":["<problem>", "..."]}`;
}

async function critique(email, lead, research, llm) {
  const raw = await llm(buildPrompt(email, lead, research));
  const score = clamp(raw && raw.score);
  const issues = Array.isArray(raw && raw.issues) ? raw.issues : [];
  return { score, issues, pass: score >= QA_THRESHOLD };
}

module.exports = { critique, QA_THRESHOLD, buildPrompt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/qa.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add sdr/nodes/qa.js test/qa.test.js
git commit -m "feat(sdr): QA critique gate (skeptical founder)"
```

---

## Task 10: Pipeline orchestrator

`makePipeline({ repo, playbook, fetchText, llm })` exposes `tick()`, advancing each lead one stage. On `drafted`, it runs QA: pass → `queued`; fail → stay `drafted` with one rewrite attempt tracked via `next_action_at` (here: simple — fail keeps it `drafted`, records issues in `qualification_notes`, and the next tick re-drafts). All side effects go through `repo`.

**Files:**
- Create: `sdr/pipeline.js`
- Test: `test/pipeline.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/pipeline.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { makePipeline } = require('../sdr/pipeline');

function repoWith(leadsByStage) {
  const advanced = [];
  return {
    advanced,
    listByStage: async (stage) => (leadsByStage[stage] || []),
    advance: async (id, stage, patch) => { advanced.push({ id, stage, patch }); return { id, stage }; }
  };
}

test('tick qualifies sourced leads and advances passers', async () => {
  const repo = repoWith({ sourced: [{ id: 1, domain: 'a.com' }] });
  const pipe = makePipeline({
    repo, playbook: 'P', fetchText: async () => '',
    llm: async () => ({ icp_score: 80, notes: 'fit' })
  });
  await pipe.tick();
  assert.equal(repo.advanced[0].stage, 'qualified');
  assert.equal(repo.advanced[0].patch.icp_score, 80);
});

test('tick drops a sourced lead that fails qualification to lost', async () => {
  const repo = repoWith({ sourced: [{ id: 2, domain: 'b.com' }] });
  const pipe = makePipeline({
    repo, playbook: 'P', fetchText: async () => '',
    llm: async () => ({ icp_score: 20 })
  });
  await pipe.tick();
  assert.equal(repo.advanced[0].stage, 'lost');
});

test('tick on a drafted lead that passes QA moves it to queued', async () => {
  const repo = repoWith({ drafted: [{ id: 3, domain: 'c.com', draft: 'hi', research_json: { hook: 'h' } }] });
  const pipe = makePipeline({
    repo, playbook: 'P', fetchText: async () => '',
    llm: async () => ({ score: 90, issues: [] })
  });
  await pipe.tick();
  const q = repo.advanced.find(a => a.stage === 'queued');
  assert.ok(q, 'expected a lead to reach queued');
});

test('tick on a drafted lead that fails QA keeps it drafted with issues', async () => {
  const repo = repoWith({ drafted: [{ id: 4, domain: 'd.com', draft: 'hi', research_json: { hook: 'h' } }] });
  const pipe = makePipeline({
    repo, playbook: 'P', fetchText: async () => '',
    llm: async () => ({ score: 30, issues: ['too generic'] })
  });
  await pipe.tick();
  const back = repo.advanced.find(a => a.stage === 'drafted');
  assert.ok(back);
  assert.match(back.patch.qualification_notes, /too generic/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pipeline.test.js`
Expected: FAIL — `Cannot find module '../sdr/pipeline'`.

- [ ] **Step 3: Write the implementation**

```js
// sdr/pipeline.js
const { qualify } = require('./nodes/qualify');
const { research } = require('./nodes/research');
const { draftEmail } = require('./nodes/draft');
const { critique } = require('./nodes/qa');

const BATCH = 5;

function makePipeline({ repo, playbook, fetchText, llm }) {
  async function tick() {
    // sourced -> qualify
    for (const lead of await repo.listByStage('sourced', BATCH)) {
      const r = await qualify(lead, playbook, llm);
      if (r.pass) {
        await repo.advance(lead.id, 'qualified', { icp_score: r.icp_score, qualification_notes: r.notes });
      } else {
        await repo.advance(lead.id, 'lost', { icp_score: r.icp_score, qualification_notes: r.notes });
      }
    }

    // qualified -> research
    for (const lead of await repo.listByStage('qualified', BATCH)) {
      const r = await research(lead, { fetchText, llm });
      await repo.advance(lead.id, 'researched', { research_json: r });
    }

    // researched -> draft
    for (const lead of await repo.listByStage('researched', BATCH)) {
      const r = lead.research_json || {};
      const email = await draftEmail(lead, r, playbook, llm);
      await repo.advance(lead.id, 'drafted', { draft: JSON.stringify(email) });
    }

    // drafted -> QA -> queued | stay drafted
    for (const lead of await repo.listByStage('drafted', BATCH)) {
      const email = safeParse(lead.draft);
      const r = lead.research_json || {};
      const verdict = await critique(email, lead, r, llm);
      if (verdict.pass) {
        await repo.advance(lead.id, 'queued', {});
      } else {
        await repo.advance(lead.id, 'drafted', {
          qualification_notes: 'QA failed: ' + verdict.issues.join('; ')
        });
      }
    }
  }
  return { tick };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return { subject: '', body: String(s || '') }; }
}

module.exports = { makePipeline };
```

> Note: the QA-fail path here re-enters `drafted`; to avoid an infinite re-draft loop in production, Plan 1 keeps it simple (one batch per tick, human can inspect repeatedly-failing leads on the dashboard). A retry counter is added in Plan 3 alongside follow-up cadence.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pipeline.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all tests across all files PASS.

- [ ] **Step 6: Commit**

```bash
git add sdr/pipeline.js test/pipeline.test.js
git commit -m "feat(sdr): pipeline orchestrator (qualify→research→draft→QA→queue)"
```

---

## Task 11: Wire into index.js

Wire the module into the running bot: init the leads table + seed the playbook on boot, register a pipeline cron, expose pipeline data on `/api/dashboard`, and add a `/leads` Telegram command (add by domain + show stage counts). Keep the LLM adapter (wraps the real `client` via `askJson`) here.

**Files:**
- Modify: `index.js` (DB init block ~line 22; after cron at ~1486; `/api/dashboard` ~1418; webhook command handling — add a new `if` branch near other text commands ~737)

- [ ] **Step 1: Add requires and a singleton wiring block**

Near the top of `index.js`, after the existing `const` requires (after line 18 where `pool` is defined), add:

```js
// ── SDR PIPELINE WIRING ──────────────────────────────────
const { makeLeadsRepo } = require('./sdr/leadsRepo');
const { seedPlaybook, loadPlaybook } = require('./sdr/playbook');
const { makeManualSource } = require('./sdr/sources/manualSource');
const { makePipeline } = require('./sdr/pipeline');
const { askJson } = require('./sdr/llm');

const leadsRepo = makeLeadsRepo((sql, params) => pool.query(sql, params));
const manualSource = makeManualSource(leadsRepo);
const sdrLlm = (prompt) => askJson(client, prompt, { maxTokens: 1024 });

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const html = await res.text();
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
             .replace(/<style[\s\S]*?<\/style>/gi, ' ')
             .replace(/<[^>]+>/g, ' ')
             .replace(/\s+/g, ' ')
             .trim();
}

async function runSdrTick() {
  const playbook = await loadPlaybook((sql, params) => pool.query(sql, params));
  const pipeline = makePipeline({ repo: leadsRepo, playbook, fetchText, llm: sdrLlm });
  await pipeline.tick();
}
```

- [ ] **Step 2: Initialize the table + seed the playbook on boot**

Inside the existing async DB-init function (the one that runs the `CREATE TABLE IF NOT EXISTS` blocks starting ~line 22), after the last table is created, add:

```js
  await leadsRepo.init();
  await seedPlaybook((sql, params) => pool.query(sql, params));
```

- [ ] **Step 3: Register the pipeline cron**

After the existing `cron.schedule('* * * * *', ...)` block (~line 1486), add:

```js
// Run the SDR pipeline every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  try { await runSdrTick(); }
  catch (e) { console.error('SDR tick error:', e.message); }
});
```

- [ ] **Step 4: Add pipeline data to /api/dashboard**

In the `/api/dashboard` handler (~line 1418), add a query to the `Promise.all` array:

```js
      pool.query("SELECT stage, COUNT(*)::int AS n FROM leads GROUP BY stage").catch(()=>({rows:[]})),
```

Bind it as the last destructured variable (e.g. `, leadStages`) and add to the `res.json(...)` object:

```js
      pipeline: leadStages.rows.reduce((a, r) => (a[r.stage] = r.n, a), {}),
```

- [ ] **Step 5: Add a `/leads` Telegram command**

Near the other text-command `if` branches in the webhook handler (~line 737, where `/` commands like the pending-list are handled), add:

```js
    if (text.startsWith('/leads')) {
      const arg = text.replace('/leads', '').trim();
      if (arg) {
        const lead = await manualSource.addByDomain(arg);
        await bot.sendMessage(chatId, `Added lead: ${lead.domain} (queued for sourcing→draft).`);
      } else {
        const counts = await leadsRepo.stageCounts();
        const lines = Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join('\n') || 'no leads yet';
        await bot.sendMessage(chatId, `SDR pipeline:\n${lines}`);
      }
      return res.sendStatus(200);
    }
```

> Match the exact variable names used in the surrounding handler for the chat id, message text, and the Telegram send call (`bot.sendMessage` / the response object). Read the lines around the existing pending-list command (~737–745) first and mirror them.

- [ ] **Step 6: Smoke-test boot locally**

Run: `node --check index.js`
Expected: exit 0 (no syntax errors).

> A full boot needs live env vars (DATABASE_URL etc.); the syntax check plus the unit suite are the Plan-1 verification. End-to-end boot is verified during execution against the real Railway/Postgres env.

- [ ] **Step 7: Run the full suite once more**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add index.js
git commit -m "feat(sdr): wire pipeline into bot (cron, dashboard, /leads command)"
```

---

## Self-Review Notes (author)

- **Spec coverage:** Overflow Brain/playbook → Task 4; `leads` table → Task 2; swappable `LeadSource` interface → Task 5 (`StoreLeadsAdapter` is Plan 2); Qualify/Research/Draft/QA nodes → Tasks 6–9; pipeline state machine → Task 10; dashboard Pipeline card data + cron + approval entry point → Task 11. Deferred to later plans (explicitly): live send (Make.com), reply-watch, follow-up cadence + QA retry counter, paid Store Leads/EmailFinder adapters, build-in-public hook, live dashboard integration.
- **Anti-generic guarantee:** enforced in code by Task 8 (draft refuses without a hook) + Task 9 (QA gate) + Task 10 (only QA-passers reach `queued`).
- **No live API/DB in tests:** every node takes injected `llm`/`fetchText`/`query`; all tests use fakes.
- **Approval boundary:** Plan 1 terminates leads at `queued` (visible on dashboard + `/leads`); approve-to-send is Plan 3, so no email leaves without the human + Make.com wiring built later.
