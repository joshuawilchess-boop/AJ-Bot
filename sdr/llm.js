const MODEL = 'claude-opus-4-6';

function stripFences(text) {
  const t = String(text).trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (m ? m[1] : t).trim();
}

async function askJson(client, prompt, { system = '', maxTokens = 1024 } = {}) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }]
  });
  const raw = stripFences(res.content[0].text);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`LLM did not return valid JSON: ${raw.slice(0, 200)}`);
  }
}

module.exports = { askJson, stripFences, MODEL };
