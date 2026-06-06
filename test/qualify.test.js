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
