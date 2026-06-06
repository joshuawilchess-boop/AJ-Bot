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
