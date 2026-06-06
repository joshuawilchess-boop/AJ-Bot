function buildPrompt(lead, pageText) {
  return `You are a sales researcher. From this e-commerce store's homepage text,
find ONE true, specific personalization hook and a revenue-leak hypothesis Overflow
Revive could fix. Be concrete; never invent facts not supported by the text.

STORE: ${lead.company || lead.domain} (${lead.domain})

HOMEPAGE TEXT (may be empty):
${pageText.slice(0, 4000)}

Return ONLY JSON:
{"hook":"<specific observation true of this store>",
 "leak_hypothesis":"<the revenue leak it implies>",
 "signals":["<short signal>", "..."]}`;
}

async function research(lead, { fetchText, llm }) {
  let pageText = '';
  try {
    pageText = (await fetchText(`https://${lead.domain}`)) || '';
  } catch (e) {
    pageText = '';
  }
  const raw = await llm(buildPrompt(lead, pageText));
  return {
    hook: (raw && raw.hook) || '',
    leak_hypothesis: (raw && raw.leak_hypothesis) || '',
    signals: Array.isArray(raw && raw.signals) ? raw.signals : []
  };
}

module.exports = { research, buildPrompt };
