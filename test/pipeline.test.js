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

test('tick on a drafted lead that fails QA is parked in lost with issues', async () => {
  const repo = repoWith({ drafted: [{ id: 4, domain: 'd.com', draft: 'hi', research_json: { hook: 'h' } }] });
  const pipe = makePipeline({
    repo, playbook: 'P', fetchText: async () => '',
    llm: async () => ({ score: 30, issues: ['too generic'] })
  });
  await pipe.tick();
  const parked = repo.advanced.find(a => a.stage === 'lost');
  assert.ok(parked, 'expected the QA-failed lead to be parked in lost');
  assert.match(parked.patch.qualification_notes, /too generic/);
});

test('tick researches a qualified lead and drafts a researched lead', async () => {
  const repo = repoWith({
    qualified: [{ id: 5, domain: 'e.com' }],
    researched: [{ id: 6, domain: 'f.com', research_json: { hook: 'no win-back flow', leak_hypothesis: 'lost buyers', signals: [] } }]
  });
  const pipe = makePipeline({
    repo, playbook: 'P',
    fetchText: async () => 'homepage text',
    llm: async () => ({
      // research output shape
      hook: 'no upsell', leak_hypothesis: 'leak', signals: [],
      // draft output shape (same fake serves both calls)
      subject: 's', body: 'b'
    })
  });
  await pipe.tick();
  const researched = repo.advanced.find(a => a.id === 5 && a.stage === 'researched');
  assert.ok(researched, 'qualified lead should advance to researched');
  assert.ok(researched.patch.research_json, 'research_json should be set');
  const drafted = repo.advanced.find(a => a.id === 6 && a.stage === 'drafted');
  assert.ok(drafted, 'researched lead should advance to drafted');
  assert.ok(drafted.patch.draft, 'draft should be set');
});
