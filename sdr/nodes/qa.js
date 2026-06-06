const QA_THRESHOLD = 70;

function clamp(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function buildPrompt(email, lead, research) {
  return `You are a busy e-commerce founder who gets 20 cold emails a day.
Critique this outreach for the store ${lead.domain}. Score 0-100 on:
1) would you reply, 2) is it specific to you (not mail-merge), 3) any spam triggers,
4) is the ask one clear low-friction step.

RESEARCH HOOK IT SHOULD USE: ${research.hook}
SUBJECT: ${email.subject}
BODY: ${email.body}

Return ONLY JSON: {"score":<0-100>,"issues":["<problem>", "..."]}`;
}

async function critique(email, lead, research, llm) {
  const raw = await llm(buildPrompt(email, lead, research));
  const score = clamp(raw && raw.score);
  const issues = Array.isArray(raw && raw.issues) ? raw.issues : [];
  return { score, issues, pass: score >= QA_THRESHOLD };
}

module.exports = { critique, QA_THRESHOLD, buildPrompt };
