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
