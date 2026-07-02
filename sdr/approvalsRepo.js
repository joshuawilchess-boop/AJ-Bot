const KINDS = ['cold', 'reply', 'followup_bump', 'followup_breakup'];

const CREATE_APPROVALS_TABLE = `
  CREATE TABLE IF NOT EXISTS pending_approvals (
    id SERIAL PRIMARY KEY,
    lead_id INT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    in_reply_to TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    notified BOOLEAN NOT NULL DEFAULT FALSE,
    message_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    decided_at TIMESTAMPTZ
  )
`;

function makeApprovalsRepo(query) {
  return {
    async init() {
      await query(CREATE_APPROVALS_TABLE);
    },

    async createPending({ lead_id, kind, subject, body, in_reply_to = null }) {
      if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
      const { rows } = await query(
        `INSERT INTO pending_approvals (lead_id, kind, subject, body, in_reply_to)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [lead_id, kind, subject, body, in_reply_to]
      );
      return rows[0];
    },

    async listUnnotified(limit = 25) {
      const { rows } = await query(
        `SELECT * FROM pending_approvals
         WHERE status = 'pending' AND notified = FALSE
         ORDER BY created_at ASC LIMIT $1`,
        [limit]
      );
      return rows;
    },

    async markNotified(id) {
      await query(
        `UPDATE pending_approvals SET notified = TRUE WHERE id = $1`,
        [id]
      );
    },

    async approve(id) {
      const { rows } = await query(
        `UPDATE pending_approvals SET status = 'approved', decided_at = NOW()
         WHERE id = $1 AND status = 'pending' RETURNING *`,
        [id]
      );
      return rows[0] || null;
    },

    async reject(id) {
      const { rows } = await query(
        `UPDATE pending_approvals SET status = 'rejected', decided_at = NOW()
         WHERE id = $1 AND status = 'pending' RETURNING *`,
        [id]
      );
      return rows[0] || null;
    },

    async markSent(id, message_id) {
      const { rows } = await query(
        `UPDATE pending_approvals SET status = 'sent', message_id = $2
         WHERE id = $1 RETURNING *`,
        [id, message_id]
      );
      return rows[0] || null;
    },

    async updateDraft(id, { subject, body }) {
      const { rows } = await query(
        `UPDATE pending_approvals SET subject = $2, body = $3
         WHERE id = $1 AND status = 'pending' RETURNING *`,
        [id, subject, body]
      );
      return rows[0] || null;
    },

    async get(id) {
      const { rows } = await query(
        `SELECT * FROM pending_approvals WHERE id = $1`,
        [id]
      );
      return rows[0] || null;
    }
  };
}

module.exports = { makeApprovalsRepo, CREATE_APPROVALS_TABLE, KINDS };
