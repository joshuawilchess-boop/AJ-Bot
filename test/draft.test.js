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
