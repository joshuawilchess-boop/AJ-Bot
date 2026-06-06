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
