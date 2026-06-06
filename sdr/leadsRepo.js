const STAGES = [
  'sourced', 'qualified', 'researched', 'drafted',
  'queued', 'sent', 'replied', 'followup', 'won', 'lost'
];

const CREATE_LEADS_TABLE = `
  CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    company TEXT,
    domain TEXT,
    contact_name TEXT,
    contact_email TEXT,
    email_status TEXT DEFAULT 'unknown',
    source TEXT,
    icp_score INT,
    qualification_notes TEXT,
    stage TEXT NOT NULL DEFAULT 'sourced',
    research_json JSONB,
    draft TEXT,
    last_action_at TIMESTAMPTZ DEFAULT NOW(),
    next_action_at TIMESTAMPTZ,
    reply_text TEXT,
    airtable_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`;

// Columns the pipeline is allowed to patch via advance().
const PATCHABLE = new Set([
  'icp_score', 'qualification_notes', 'research_json', 'draft',
  'contact_name', 'contact_email', 'email_status', 'reply_text',
  'next_action_at', 'airtable_id'
]);

function makeLeadsRepo(query) {
  return {
    async init() {
      await query(CREATE_LEADS_TABLE);
    },

    async insertSourced({ company, domain, source }) {
      const { rows } = await query(
        `INSERT INTO leads (company, domain, source, stage)
         VALUES ($1, $2, $3, 'sourced') RETURNING *`,
        [company, domain, source]
      );
      return rows[0];
    },

    async advance(id, stage, patch = {}) {
      if (!STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
      const sets = ['stage = $1', 'last_action_at = NOW()'];
      const params = [stage];
      let i = 2;
      for (const [k, v] of Object.entries(patch)) {
        if (!PATCHABLE.has(k)) continue;
        const val = k === 'research_json' && typeof v !== 'string' ? JSON.stringify(v) : v;
        sets.push(`${k} = $${i}`);
        params.push(val);
        i++;
      }
      params.push(id);
      const { rows } = await query(
        `UPDATE leads SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        params
      );
      return rows[0];
    },

    async listByStage(stage, limit = 25) {
      const { rows } = await query(
        `SELECT * FROM leads WHERE stage = $1 ORDER BY last_action_at ASC LIMIT $2`,
        [stage, limit]
      );
      return rows;
    },

    async stageCounts() {
      const { rows } = await query(
        `SELECT stage, COUNT(*)::int AS n FROM leads GROUP BY stage`
      );
      return rows.reduce((acc, r) => (acc[r.stage] = r.n, acc), {});
    }
  };
}

module.exports = { makeLeadsRepo, CREATE_LEADS_TABLE, STAGES };
