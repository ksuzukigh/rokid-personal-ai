import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfirmationTicketStore } from './confirmation-ticket.mjs';

function candidate(overrides = {}) {
  return {
    candidateId: 'candidate-001',
    sourceTextSha256: '1'.repeat(64),
    disposition: 'propose_action',
    actionType: 'create_or_append_note',
    targetScope: 'unknown',
    risk: 'low',
    confirmationRequired: true,
    allowedNextStep: 'preview_only',
    executionCapability: 'none',
    changed: false,
    summary: '記録候補',
    targetHint: '試用メモ',
    payloadPreview: '機密な本文の見本',
    ...overrides,
  };
}

function fixture(options = {}) {
  let now = 1_000_000;
  let ticketSequence = 0;
  let tokenSequence = 0;
  const store = new ConfirmationTicketStore({
    clock: () => now,
    ttlMs: options.ttlMs ?? 15_000,
    ticketIdFactory: () => `ticket-${++ticketSequence}`,
    tokenFactory: () => `secret-token-${++tokenSequence}`,
  });
  return { store, advance: (duration) => { now += duration; } };
}

test('実行不能で確認必須の候補だけに一回確認券を出す', () => {
  const { store } = fixture();
  const ticket = store.issue(candidate());
  assert.equal(ticket.ticketId, 'ticket-1');
  assert.equal(ticket.confirmationToken, 'secret-token-1');
  assert.equal(ticket.allowedNextStep, 'confirmation_only');
  assert.equal(ticket.executionCapability, 'none');
  assert.throws(() => store.issue(candidate({ candidateId: 'candidate-002' })), /only one/);
  assert.throws(() => fixture().store.issue(candidate({ executionCapability: 'write' })), /unexecuted/);
  assert.throws(() => fixture().store.issue(candidate({ confirmationRequired: false })), /unexecuted/);
});

test('同じ候補・正しい秘密値の一回だけ確認し、操作は実行しない', () => {
  const { store } = fixture();
  const ticket = store.issue(candidate());
  const first = store.confirm(ticket);
  assert.deepEqual(first, {
    accepted: true,
    status: 'confirmed',
    ticketId: 'ticket-1',
    candidateId: 'candidate-001',
    candidateDigest: ticket.candidateDigest,
    confirmationRecorded: true,
    protectedResourceChanged: false,
    allowedNextStep: 'record_only',
    executionCapability: 'none',
  });
  const duplicate = store.confirm(ticket);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'confirmed');
  assert.equal(duplicate.protectedResourceChanged, false);
});

test('別候補と不正秘密値を拒否し、正しい確認券は消費しない', () => {
  const { store } = fixture();
  const ticket = store.issue(candidate());
  assert.equal(store.confirm({ ...ticket, candidateId: 'candidate-other' }).reason, 'invalid_ticket');
  assert.equal(store.confirm({ ...ticket, confirmationToken: 'wrong' }).reason, 'invalid_ticket');
  assert.equal(store.confirm(ticket).accepted, true);
});

test('取消後と期限切れ後の確認を拒否する', () => {
  const cancelled = fixture();
  const cancelTicket = cancelled.store.issue(candidate());
  assert.equal(cancelled.store.cancel(cancelTicket).status, 'cancelled');
  assert.equal(cancelled.store.confirm(cancelTicket).reason, 'cancelled');

  const expired = fixture({ ttlMs: 1_000 });
  const expiredTicket = expired.store.issue(candidate());
  expired.advance(1_000);
  assert.equal(expired.store.confirm(expiredTicket).reason, 'expired');
  const replacement = expired.store.issue(candidate({ candidateId: 'candidate-002' }));
  assert.equal(replacement.ticketId, 'ticket-2');
});

test('監査記録に秘密値と候補本文を残さない', () => {
  const { store } = fixture();
  const ticket = store.issue(candidate());
  store.confirm(ticket);
  const serialized = JSON.stringify(store.auditRecords());
  assert.doesNotMatch(serialized, /secret-token/);
  assert.doesNotMatch(serialized, /機密な本文/);
  assert.match(serialized, /candidateDigest/);
  assert.match(serialized, /confirmed/);
});

test('確認券は候補の表示内容までハッシュへ結び付ける', () => {
  const first = fixture().store.issue(candidate());
  const changedSummary = fixture().store.issue(candidate({ summary: '別の要約' }));
  const changedTarget = fixture().store.issue(candidate({ targetHint: '別の対象' }));
  const changedPayload = fixture().store.issue(candidate({ payloadPreview: '別の本文' }));
  assert.notEqual(first.candidateDigest, changedSummary.candidateDigest);
  assert.notEqual(first.candidateDigest, changedTarget.candidateDigest);
  assert.notEqual(first.candidateDigest, changedPayload.candidateDigest);
});

test('確認した新規文書候補だけに短時間の一回作成権を出す', () => {
  const { store } = fixture();
  const value = candidate({
    actionType: 'create_new_document',
    targetScope: 'obsidian',
    targetHint: '私のAI 作成文書',
    payloadPreview: '# 青い計画書\n\n安全な新規文書です。',
  });
  const ticket = store.issue(value);
  assert.equal(store.confirm(ticket).accepted, true);
  const first = store.claimCreateDocument({ ticketId: ticket.ticketId, executionId: 'execution-1', candidate: value });
  assert.equal(first.authorized, true);
  assert.equal(first.executionCapability, 'create_new_document');
  assert.equal(store.claimCreateDocument({ ticketId: ticket.ticketId, executionId: 'execution-2', candidate: value }).reason, 'already_executed');
});

test('未確認・別内容・別操作に文書作成権を出さない', () => {
  const value = candidate({
    actionType: 'create_new_document', targetScope: 'obsidian',
    targetHint: '私のAI 作成文書', payloadPreview: '# 原本\n\n本文',
  });
  const unconfirmed = fixture();
  const ticket = unconfirmed.store.issue(value);
  assert.equal(unconfirmed.store.claimCreateDocument({ ticketId: ticket.ticketId, executionId: 'execution-1', candidate: value }).reason, 'pending');
  unconfirmed.store.confirm(ticket);
  assert.equal(unconfirmed.store.claimCreateDocument({
    ticketId: ticket.ticketId,
    executionId: 'execution-2',
    candidate: { ...value, payloadPreview: '# 差し替え\n\n別本文' },
  }).reason, 'candidate_mismatch');

  const wrongAction = fixture();
  const wrongTicket = wrongAction.store.issue(candidate({ targetScope: 'obsidian' }));
  wrongAction.store.confirm(wrongTicket);
  assert.equal(wrongAction.store.claimCreateDocument({
    ticketId: wrongTicket.ticketId, executionId: 'execution-3', candidate: candidate({ targetScope: 'obsidian' }),
  }).reason, 'unsupported_action');
});

test('確認した追記候補の対象版と追加本文だけに一回追記権を出す', () => {
  const { store } = fixture();
  const value = candidate({
    actionType: 'append_document',
    targetScope: 'obsidian',
    targetHint: '私のAI 作成文書',
    payloadPreview: '追記先: 青い計画書\n\n追加本文',
    resourceVersion: 'a'.repeat(64),
  });
  const ticket = store.issue(value);
  assert.equal(store.confirm(ticket).accepted, true);
  const first = store.claimAppendDocument({
    ticketId: ticket.ticketId,
    executionId: 'execution-append-1',
    candidate: value,
  });
  assert.equal(first.authorized, true);
  assert.equal(first.executionCapability, 'append_document');
  assert.equal(store.claimAppendDocument({
    ticketId: ticket.ticketId,
    executionId: 'execution-append-2',
    candidate: value,
  }).reason, 'already_executed');
});

test('確認後に対象版を差し替えた追記候補へ権限を出さない', () => {
  const { store } = fixture();
  const value = candidate({
    actionType: 'append_document', targetScope: 'obsidian',
    payloadPreview: '追記先: 青い計画書\n\n追加本文', resourceVersion: 'a'.repeat(64),
  });
  const ticket = store.issue(value);
  store.confirm(ticket);
  assert.equal(store.claimAppendDocument({
    ticketId: ticket.ticketId,
    executionId: 'execution-append-1',
    candidate: { ...value, resourceVersion: 'b'.repeat(64) },
  }).reason, 'candidate_mismatch');
});

test('確認したGoogle Drive候補だけに専用の一回保存権を出す', () => {
  const { store } = fixture();
  const value = candidate({
    actionType: 'save_document_to_google_drive',
    targetScope: 'google_drive',
    targetHint: 'Google DriveのRokid/私のAI 保存文書(Googleドキュメント)',
    payloadPreview: '題名: 青い計画書\n\n本文:\nDriveへ保存する本文です。\n',
  });
  const ticket = store.issue(value);
  assert.equal(store.confirm(ticket).accepted, true);
  const first = store.claimSaveGoogleDriveDocument({
    ticketId: ticket.ticketId,
    executionId: 'execution-drive-1',
    candidate: value,
  });
  assert.equal(first.authorized, true);
  assert.equal(first.executionCapability, 'save_document_to_google_drive');
  assert.equal(store.claimSaveGoogleDriveDocument({
    ticketId: ticket.ticketId,
    executionId: 'execution-drive-2',
    candidate: value,
  }).reason, 'already_executed');
});

test('確認した文書の一箇所変更候補だけに一回変更権を出す', () => {
  const { store } = fixture();
  const value = candidate({
    actionType: 'replace_document_text',
    targetScope: 'obsidian',
    targetHint: '検証/検証台帳.md',
    payloadPreview: '文書: 検証台帳\n\n現在:\n未確認\n\n変更後:\n実機合格',
    resourceVersion: 'c'.repeat(64),
  });
  const ticket = store.issue(value);
  assert.equal(store.confirm(ticket).accepted, true);
  const first = store.claimReplaceDocumentText({
    ticketId: ticket.ticketId,
    executionId: 'execution-edit-1',
    candidate: value,
  });
  assert.equal(first.authorized, true);
  assert.equal(first.executionCapability, 'replace_document_text');
  assert.equal(store.claimReplaceDocumentText({
    ticketId: ticket.ticketId,
    executionId: 'execution-edit-2',
    candidate: value,
  }).reason, 'already_executed');
});
