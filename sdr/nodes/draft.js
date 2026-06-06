function buildPrompt(lead, research, playbook) {
  return `You are a pro SDR writing a cold email for Overflow Revive.
Follow the FRAMEWORK, VOICE, and SPAM-AVOIDANCE rules in the playbook exactly.
Anchor the email on the specific research hook — it must read as written for THIS
store only. Under 120 words. No links.

PLAYBOOK:
${playbook}

STORE: ${lead.company || lead.domain} (${lead.domain})
RESEARCH HOOK: ${research.hook}
REVENUE LEAK: ${research.leak_hypothesis}

Return ONLY JSON: {"subject":"<short lowercase subject>","body":"<email body>"}`;
}

async function draftEmail(lead, research, playbook, llm) {
  if (!research || !research.hook || !research.hook.trim()) {
    throw new Error('no research hook — refusing to draft generic outreach');
  }
  const raw = await llm(buildPrompt(lead, research, playbook));
  return {
    subject: (raw && raw.subject) || '',
    body: (raw && raw.body) || ''
  };
}

module.exports = { draftEmail, buildPrompt };
