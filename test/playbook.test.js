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
