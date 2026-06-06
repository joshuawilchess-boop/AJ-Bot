const { qualify } = require('./nodes/qualify');
const { research } = require('./nodes/research');
const { draftEmail } = require('./nodes/draft');
const { critique } = require('./nodes/qa');

const BATCH = 5;

function makePipeline({ repo, playbook, fetchText, llm }) {
  async function tick() {
    // sourced -> qualify
    for (const lead of await repo.listByStage('sourced', BATCH)) {
      const r = await qualify(lead, playbook, llm);
      if (r.pass) {
        await repo.advance(lead.id, 'qualified', { icp_score: r.icp_score, qualification_notes: r.notes });
      } else {
        await repo.advance(lead.id, 'lost', { icp_score: r.icp_score, qualification_notes: r.notes });
      }
    }

    // qualified -> research
    for (const lead of await repo.listByStage('qualified', BATCH)) {
      const r = await research(lead, { fetchText, llm });
      await repo.advance(lead.id, 'researched', { research_json: r });
    }

    // researched -> draft
    for (const lead of await repo.listByStage('researched', BATCH)) {
      const r = lead.research_json || {};
      const email = await draftEmail(lead, r, playbook, llm);
      await repo.advance(lead.id, 'drafted', { draft: JSON.stringify(email) });
    }

    // drafted -> QA -> queued | stay drafted
    for (const lead of await repo.listByStage('drafted', BATCH)) {
      const email = safeParse(lead.draft);
      const r = lead.research_json || {};
      const verdict = await critique(email, lead, r, llm);
      if (verdict.pass) {
        await repo.advance(lead.id, 'queued', {});
      } else {
        await repo.advance(lead.id, 'drafted', {
          qualification_notes: 'QA failed: ' + verdict.issues.join('; ')
        });
      }
    }
  }
  return { tick };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return { subject: '', body: String(s || '') }; }
}

module.exports = { makePipeline };
