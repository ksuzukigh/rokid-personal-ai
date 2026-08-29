import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createConfirmationRelay } from './confirmation-relay.mjs';
import { ConfirmationTicketStore } from './confirmation-ticket.mjs';

const bearer = 'b'.repeat(64);
const candidate = () => ({
  candidateId: 'candidate-001', sourceTextSha256: '1'.repeat(64), disposition: 'propose_action',
  actionType: 'create_or_append_note', targetScope: 'unknown', risk: 'low', confirmationRequired: true,
  allowedNextStep: 'preview_only', executionCapability: 'none', changed: false,
  summary: '確認候補', targetHint: '試用メモ', payloadPreview: '一件追記する',
});

async function fixture() {
  const store = new ConfirmationTicketStore({ ticketIdFactory: () => 'ticket-001', tokenFactory: () => 'token-secret-001' });
  const ticket = store.issue(candidate());
  const decisions = [];
  const server = createConfirmationRelay({ store, bearer, onDecision: (value) => decisions.push(value) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { ticket, decisions, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

function request(port, path, { auth = bearer, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
      authorization: `Bearer ${auth}`, 'content-type': 'application/json', 'content-length': data.length,
    } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.once('error', reject);
    req.end(data);
  });
}

function ticketBody(ticket) {
  return {
    ticketId: ticket.ticketId,
    candidateId: ticket.candidateId,
    confirmationToken: ticket.confirmationToken,
  };
}

test('認証済みの確認一件だけをMacで記録し、実行しない', async () => {
  const f = await fixture();
  try {
    assert.equal((await request(f.port, '/v1/health')).body.ready, true);
    const result = await request(f.port, '/v1/confirm', { body: ticketBody(f.ticket) });
    assert.equal(result.status, 200);
    assert.equal(result.body.confirmationRecorded, true);
    assert.equal(result.body.protectedResourceChanged, false);
    assert.equal(f.decisions.length, 1);
    assert.equal((await request(f.port, '/v1/confirm', { body: ticketBody(f.ticket) })).status, 409);
    assert.equal(f.decisions.length, 1);
  } finally { await f.close(); }
});

test('未認証・別候補・予期外項目を拒否する', async () => {
  const f = await fixture();
  try {
    assert.equal((await request(f.port, '/v1/health', { auth: 'wrong' })).status, 401);
    assert.equal((await request(f.port, '/v1/confirm', { body: { ...ticketBody(f.ticket), candidateId: 'other' } })).status, 409);
    assert.equal((await request(f.port, '/v1/confirm', { body: { ...ticketBody(f.ticket), extra: true } })).status, 400);
    assert.equal(f.decisions.length, 0);
  } finally { await f.close(); }
});

test('取消は確認と別経路で一回だけ受ける', async () => {
  const f = await fixture();
  try {
    const result = await request(f.port, '/v1/cancel', { body: ticketBody(f.ticket) });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'cancelled');
    assert.equal(result.body.protectedResourceChanged, false);
    assert.equal((await request(f.port, '/v1/confirm', { body: ticketBody(f.ticket) })).status, 409);
  } finally { await f.close(); }
});
