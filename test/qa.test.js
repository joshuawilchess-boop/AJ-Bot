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
