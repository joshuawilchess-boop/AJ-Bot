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
