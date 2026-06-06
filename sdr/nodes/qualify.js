const QUALIFY_THRESHOLD = 60;

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function buildPrompt(lead, playbook) {
  return `You are a B2B sales qualifier. Using the ICP rubric in the playbook below,
score how well this lead fits, 0-100.

PLAYBOOK:
${playbook}

LEAD:
company: ${lead.company || ''}
domain: ${lead.domain || ''}

Return ONLY JSON: {"icp_score": <0-100 integer>, "notes": "<one-sentence reason>"}`;
}

async function qualify(lead, playbook, llm) {
  const raw = await llm(buildPrompt(lead, playbook));
  const icp_score = clampScore(raw && raw.icp_score);
  const notes = (raw && typeof raw.notes === 'string') ? raw.notes : 'no notes';
  return { icp_score, notes, pass: icp_score >= QUALIFY_THRESHOLD };
}

module.exports = { qualify, QUALIFY_THRESHOLD, clampScore, buildPrompt };
