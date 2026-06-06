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
