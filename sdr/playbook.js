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
