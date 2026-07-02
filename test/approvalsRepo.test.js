const { test } = require('node:test');
const assert = require('node:assert');
const { makeApprovalsRepo, CREATE_APPROVALS_TABLE, KINDS } = require('../sdr/approvalsRepo');

function fakeQuery(rowsFor = () => [{ id: 1 }]) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: rowsFor(sql, params), rowCount: 1 };
  };
  fn.calls = calls;
  return fn;
}

test('CREATE_APPROVALS_TABLE is exported', () => {
  assert.match(CREATE_APPROVALS_TABLE, /CREATE TABLE IF NOT EXISTS pending_approvals/i);
  assert.match(CREATE_APPROVALS_TABLE, /lead_id\b/);
  assert.match(CREATE_APPROVALS_TABLE, /kind\b/);
});

test('KINDS lists the four approval types', () => {
  assert.deepEqual(KINDS.sort(), ['cold', 'followup_bump', 'followup_breakup', 'reply'].sort());
});

test('createPending inserts a row with status=pending and returns it', async () => {
  const q = fakeQuery((sql) => /INSERT/i.test(sql) ? [{ id: 7, status: 'pending' }] : []);
  const repo = makeApprovalsRepo(q);
  const out = await repo.createPending({
    lead_id: 42, kind: 'cold', subject: 'subj', body: 'body', in_reply_to: null
  });
  assert.equal(out.id, 7);
  assert.match(q.calls[0].sql, /INSERT INTO pending_approvals/i);
  assert.deepEqual(q.calls[0].params, [42, 'cold', 'subj', 'body', null]);
});

test('createPending rejects an unknown kind', async () => {
  const repo = makeApprovalsRepo(fakeQuery());
  await assert.rejects(
    () => repo.createPending({ lead_id: 1, kind: 'bogus', subject: 's', body: 'b' }),
    /unknown kind/i
  );
});

test('listUnnotified selects pending rows not yet notified', async () => {
  const q = fakeQuery(() => [{ id: 1 }, { id: 2 }]);
  const repo = makeApprovalsRepo(q);
  const rows = await repo.listUnnotified(10);
  assert.equal(rows.length, 2);
  assert.match(q.calls[0].sql, /WHERE status = 'pending'/i);
  assert.match(q.calls[0].sql, /AND notified = FALSE/i);
  assert.deepEqual(q.calls[0].params, [10]);
});

test('markNotified sets notified=true on the row id', async () => {
  const q = fakeQuery();
  const repo = makeApprovalsRepo(q);
  await repo.markNotified(7);
  assert.match(q.calls[0].sql, /UPDATE pending_approvals SET notified = TRUE WHERE id = \$1/i);
  assert.deepEqual(q.calls[0].params, [7]);
});

test('approve sets status=approved when row is still pending', async () => {
  const q = fakeQuery((sql) => /UPDATE/i.test(sql) ? [{ id: 7, status: 'approved' }] : []);
  const repo = makeApprovalsRepo(q);
  const row = await repo.approve(7);
  assert.equal(row.status, 'approved');
  assert.match(q.calls[0].sql, /SET status = 'approved'/i);
  assert.match(q.calls[0].sql, /WHERE id = \$1 AND status = 'pending'/i);
});

test('reject sets status=rejected when row is still pending', async () => {
  const q = fakeQuery((sql) => /UPDATE/i.test(sql) ? [{ id: 7, status: 'rejected' }] : []);
  const repo = makeApprovalsRepo(q);
  const row = await repo.reject(7);
  assert.equal(row.status, 'rejected');
});

test('markSent stores message_id and flips status to sent', async () => {
  const q = fakeQuery((sql) => /UPDATE/i.test(sql) ? [{ id: 7, status: 'sent' }] : []);
  const repo = makeApprovalsRepo(q);
  await repo.markSent(7, '<abc@outlook.com>');
  assert.match(q.calls[0].sql, /SET status = 'sent'/i);
  assert.match(q.calls[0].sql, /message_id = \$2/i);
  assert.deepEqual(q.calls[0].params, [7, '<abc@outlook.com>']);
});

test('updateDraft replaces subject and body (for /edit)', async () => {
  const q = fakeQuery();
  const repo = makeApprovalsRepo(q);
  await repo.updateDraft(7, { subject: 'new s', body: 'new b' });
  assert.match(q.calls[0].sql, /SET subject = \$2, body = \$3/i);
  assert.deepEqual(q.calls[0].params, [7, 'new s', 'new b']);
});

test('get returns a single row by id', async () => {
  const q = fakeQuery(() => [{ id: 7, lead_id: 42, kind: 'cold', subject: 's', body: 'b' }]);
  const repo = makeApprovalsRepo(q);
  const row = await repo.get(7);
  assert.equal(row.id, 7);
  assert.match(q.calls[0].sql, /SELECT .* FROM pending_approvals WHERE id = \$1/i);
});
