import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ConfirmationTicketStore } from './confirmation-ticket.mjs';
import { DryRunExecutionAdapter } from './dry-run-execution-adapter.mjs';

function candidate(overrides = {}) {
  return {
    candidateId: 'candidate-001',
    sourceTextSha256: '1'.repeat(64),
    disposition: 'propose_action',
    actionType: 'create_or_append_note',
    targetScope: 'obsidian',
    risk: 'low',
    confirmationRequired: true,
    allowedNextStep: 'preview_only',
    executionCapability: 'none',
    changed: false,
    summary: 'Rokid個人AIの検証結果をメモする候補',
    targetHint: 'Rokid個人AIの試用メモ',
    payloadPreview: '確認済みの検証結果を一件追記する',
    ...overrides,
  };
}

function fixture(options = {}) {
  let now = 1_000_000;
  const store = new ConfirmationTicketStore({
    clock: () => now,
    ttlMs: options.ttlMs ?? 15_000,
    dryRunTtlMs: options.dryRunTtlMs ?? 15_000,
    ticketIdFactory: () => 'ticket-001',
    tokenFactory: () => 'secret-token-001',
  });
  const adapter = new DryRunExecutionAdapter({
    store,
    simulationIdFactory: () => 'simulation-001',
  });
  return { store, adapter, advance: (duration) => { now += duration; } };
}

test('同じ候補の確認済み記録だけを一回模擬し、何も変更しない', () => {
  const f = fixture();
  const value = candidate();
  const ticket = f.store.issue(value);
  assert.equal(f.store.confirm(ticket).accepted, true);

  const result = f.adapter.simulate({ ticketId: ticket.ticketId, candidate: value });
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'simulated');
  assert.equal(result.preview.actionType, 'create_or_append_note');
  assert.equal(result.preview.targetScope, 'obsidian');
  assert.equal(result.changed, false);
  assert.equal(result.protectedResourceChanged, false);
  assert.equal(result.sideEffectCount, 0);
  assert.equal(result.executionCapability, 'none');
  assert.equal(result.allowedNextStep, 'none');

  const duplicate = f.adapter.simulate({ ticketId: ticket.ticketId, candidate: value });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'already_simulated');
  assert.equal(duplicate.changed, false);
});

test('未確認、取消、期限切れの候補は模擬にも入れない', () => {
  const pending = fixture();
  const pendingValue = candidate();
  const pendingTicket = pending.store.issue(pendingValue);
  assert.equal(pending.adapter.simulate({ ticketId: pendingTicket.ticketId, candidate: pendingValue }).reason, 'pending');

  const cancelled = fixture();
  const cancelledValue = candidate();
  const cancelledTicket = cancelled.store.issue(cancelledValue);
  cancelled.store.cancel(cancelledTicket);
  assert.equal(cancelled.adapter.simulate({ ticketId: cancelledTicket.ticketId, candidate: cancelledValue }).reason, 'cancelled');

  const expired = fixture({ ttlMs: 1_000 });
  const expiredValue = candidate();
  const expiredTicket = expired.store.issue(expiredValue);
  expired.advance(1_000);
  assert.equal(expired.adapter.simulate({ ticketId: expiredTicket.ticketId, candidate: expiredValue }).reason, 'expired');
});

test('確認から15秒を過ぎた候補は模擬せず無変更で拒否する', () => {
  const f = fixture({ ttlMs: 60_000, dryRunTtlMs: 15_000 });
  const value = candidate();
  const ticket = f.store.issue(value);
  f.store.confirm(ticket);
  f.advance(15_000);
  const result = f.adapter.simulate({ ticketId: ticket.ticketId, candidate: value });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'confirmation_expired');
  assert.equal(result.changed, false);
  assert.equal(result.protectedResourceChanged, false);
  assert.equal(result.sideEffectCount, 0);
});

test('確認後に候補本文、対象、種類を変えたら拒否する', () => {
  for (const changedCandidate of [
    candidate({ payloadPreview: '確認後に差し替えた本文' }),
    candidate({ targetHint: '確認後に差し替えた対象' }),
    candidate({ actionType: 'update_record', risk: 'medium' }),
  ]) {
    const f = fixture();
    const original = candidate();
    const ticket = f.store.issue(original);
    f.store.confirm(ticket);
    const result = f.adapter.simulate({ ticketId: ticket.ticketId, candidate: changedCandidate });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'candidate_mismatch');
    assert.equal(result.protectedResourceChanged, false);
  }
});

test('実行能力あり、確認不要、変更済みの値を拒否する', () => {
  for (const invalid of [
    candidate({ executionCapability: 'write' }),
    candidate({ confirmationRequired: false }),
    candidate({ changed: true }),
  ]) {
    const f = fixture();
    const result = f.adapter.simulate({ ticketId: 'ticket-001', candidate: invalid });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid_candidate');
    assert.equal(result.sideEffectCount, 0);
  }
});

test('不正な確認券や模擬IDの失敗でも結果は必ず無変更に閉じる', () => {
  const f = fixture();
  const value = candidate();
  const ticket = f.store.issue(value);
  f.store.confirm(ticket);
  const missing = f.adapter.simulate({ ticketId: 'missing-ticket', candidate: value });
  assert.equal(missing.accepted, false);
  assert.equal(missing.reason, 'invalid_ticket');
  assert.equal(missing.changed, false);
  assert.equal(missing.protectedResourceChanged, false);
  assert.equal(missing.sideEffectCount, 0);

  const invalidIdAdapter = new DryRunExecutionAdapter({
    store: f.store,
    simulationIdFactory: () => '',
  });
  const invalidId = invalidIdAdapter.simulate({ ticketId: ticket.ticketId, candidate: value });
  assert.equal(invalidId.accepted, false);
  assert.equal(invalidId.reason, 'invalid_simulation_id');
  assert.equal(invalidId.changed, false);
  assert.equal(invalidId.sideEffectCount, 0);
});

test('別アダプターを作り直しても同じ確認券の二重模擬を拒否する', () => {
  const f = fixture();
  const value = candidate();
  const ticket = f.store.issue(value);
  f.store.confirm(ticket);
  assert.equal(f.adapter.simulate({ ticketId: ticket.ticketId, candidate: value }).accepted, true);
  const secondAdapter = new DryRunExecutionAdapter({
    store: f.store,
    simulationIdFactory: () => 'simulation-002',
  });
  assert.equal(secondAdapter.simulate({ ticketId: ticket.ticketId, candidate: value }).reason, 'already_simulated');
});

test('監査記録へ確認秘密値と候補本文を残さない', () => {
  const f = fixture();
  const value = candidate();
  const ticket = f.store.issue(value);
  f.store.confirm(ticket);
  f.adapter.simulate({ ticketId: ticket.ticketId, candidate: value });
  const audit = JSON.stringify(f.store.auditRecords());
  assert.doesNotMatch(audit, /secret-token/);
  assert.doesNotMatch(audit, /確認済みの検証結果/);
  assert.match(audit, /simulation-001/);
  assert.match(audit, /dryRunAttemptedAt/);
});

test('模擬アダプター自身はファイル、通信、子処理の能力を読み込まない', async () => {
  const source = await readFile(new URL('./dry-run-execution-adapter.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:(?:fs|http|https|net|tls|child_process)/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\b(?:writeFile|appendFile|createWriteStream|exec|spawn)\s*\(/);
});
