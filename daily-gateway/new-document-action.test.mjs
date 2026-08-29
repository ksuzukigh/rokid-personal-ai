import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDocumentCandidate,
  createNewDocumentCoordinator,
  DOCUMENT_TARGET_HINT,
  normalizeDocumentProposal,
} from './new-document-action.mjs';

const request = '私のAI 作成文書に、青い計画書を新しく作って保存して';
const proposal = {
  title: '青い計画書',
  body: '目的は、新しい計画を安全に進めることです。',
  targetHint: DOCUMENT_TARGET_HINT,
};

async function fixture(t) {
  const allowedParent = await mkdtemp(path.join(tmpdir(), 'rokid-new-document-'));
  const root = path.join(allowedParent, '作成文書', '私のAI');
  t.after(() => rm(allowedParent, { recursive: true, force: true }));
  return { allowedParent, root };
}

test('新規文書の題名・本文・固定保存先を一つの確認候補へ結び付ける', () => {
  assert.deepEqual(normalizeDocumentProposal(proposal), {
    ...proposal,
    markdown: '# 青い計画書\n\n目的は、新しい計画を安全に進めることです。\n',
  });
  const candidate = createDocumentCandidate({ request, proposal, candidateId: 'candidate-document-1' });
  assert.equal(candidate.actionType, 'create_new_document');
  assert.equal(candidate.targetScope, 'obsidian');
  assert.equal(candidate.confirmationRequired, true);
  assert.equal(candidate.changed, false);
  assert.match(candidate.payloadPreview, /^# 青い計画書/);
  assert.throws(() => normalizeDocumentProposal({ ...proposal, title: '../逃避' }), /title is invalid/);
  assert.throws(() => normalizeDocumentProposal({ ...proposal, targetHint: '別フォルダ' }), /target is not allowed/);
});

test('Rokidで確認した内容だけを0600の新規Markdownとして一回保存する', async (t) => {
  const f = await fixture(t);
  const actions = [];
  const coordinator = createNewDocumentCoordinator({
    ...f,
    recordAction: async (value) => { actions.push(value); return { recorded: true }; },
    executionIdFactory: () => 'execution-document-1',
  });
  const pending = coordinator.propose({ request, proposal });
  await assert.rejects(() => access(path.join(f.root, '青い計画書.md')));
  const result = await coordinator.confirm({
    ticketId: pending.ticket.ticketId,
    candidateId: pending.ticket.candidateId,
    confirmationToken: pending.ticket.confirmationToken,
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.applied, true);
  assert.equal(result.payload.changed, true);
  assert.equal(result.payload.actionRecorded, true);
  const file = path.join(f.root, '青い計画書.md');
  assert.equal(await readFile(file, 'utf8'), '# 青い計画書\n\n目的は、新しい計画を安全に進めることです。\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(actions, [{ operation: 'create_new_document', title: '青い計画書', state: 'saved' }]);
});

test('既存本文を残し、Rokidで確認した追加本文だけを末尾へ一回追記する', async (t) => {
  const f = await fixture(t);
  await mkdir(f.root, { recursive: true });
  const target = path.join(f.root, '青い計画書.md');
  await writeFile(target, '# 青い計画書\n\n元の本文です。\n', { mode: 0o600 });
  const actions = [];
  const coordinator = createNewDocumentCoordinator({
    ...f,
    recordAction: async (value) => { actions.push(value); return { recorded: true }; },
    executionIdFactory: () => 'execution-append-1',
  });
  const pending = await coordinator.proposeAppend({
    request: '青い計画書に進捗を追記して',
    proposal: { ...proposal, body: '進捗は予定どおりです。' },
  });
  assert.equal(pending.candidate.actionType, 'append_document');
  assert.match(pending.candidate.resourceVersion, /^[a-f0-9]{64}$/);
  assert.deepEqual(pending.response.documentProposal, {
    title: '青い計画書',
    targetHint: '私のAI 作成文書',
    preview: '進捗は予定どおりです。',
    action: 'append',
  });
  assert.equal(await readFile(target, 'utf8'), '# 青い計画書\n\n元の本文です。\n');
  const result = await coordinator.confirm({
    ticketId: pending.ticket.ticketId,
    candidateId: pending.ticket.candidateId,
    confirmationToken: pending.ticket.confirmationToken,
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.state, 'appended');
  assert.equal(result.payload.text, '「青い計画書」へ追記しました');
  assert.equal(
    await readFile(target, 'utf8'),
    '# 青い計画書\n\n元の本文です。\n\n進捗は予定どおりです。\n',
  );
  assert.deepEqual(actions, [{ operation: 'append_document', title: '青い計画書', state: 'appended' }]);
});

test('Obsidianの既存文書は現在文と変更後文をRokidで確認後に一箇所だけ変更する', async (t) => {
  const f = await fixture(t);
  const vaultRoot = path.join(f.allowedParent, '保管庫');
  const folder = path.join(vaultRoot, '検証');
  await mkdir(folder, { recursive: true });
  const target = path.join(folder, '検証台帳.md');
  await writeFile(target, '# 検証台帳\n\n状態は未確認です。\n', { mode: 0o600 });
  const actions = [];
  const coordinator = createNewDocumentCoordinator({
    vaultRoot,
    allowedParent: f.allowedParent,
    recordAction: async (value) => { actions.push(value); return { recorded: true }; },
    executionIdFactory: () => 'execution-edit-1',
  });
  const pending = await coordinator.proposeEdit({
    request: '検証台帳の未確認を実機合格へ変えて',
    proposal: {
      title: '検証台帳',
      matchText: '状態は未確認です。',
      replacementText: '状態は実機合格です。',
      targetHint: 'Obsidianの既存文書',
    },
  });
  assert.equal(pending.candidate.actionType, 'replace_document_text');
  assert.deepEqual(pending.response.documentProposal, {
    title: '検証台帳',
    targetHint: '検証/検証台帳.md',
    preview: '現在: 状態は未確認です。\n変更後: 状態は実機合格です。',
    action: 'replace_text',
  });
  assert.equal(await readFile(target, 'utf8'), '# 検証台帳\n\n状態は未確認です。\n');
  const result = await coordinator.confirm({
    ticketId: pending.ticket.ticketId,
    candidateId: pending.ticket.candidateId,
    confirmationToken: pending.ticket.confirmationToken,
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.text, '「検証台帳」の一箇所を変更しました');
  assert.equal(await readFile(target, 'utf8'), '# 検証台帳\n\n状態は実機合格です。\n');
  assert.deepEqual(actions, [{
    operation: 'replace_document_text', title: '検証台帳', state: 'text_replaced',
  }]);
});

test('確認前に対象文書が変わった場合は追記しない', async (t) => {
  const f = await fixture(t);
  await mkdir(f.root, { recursive: true });
  const target = path.join(f.root, '青い計画書.md');
  await writeFile(target, '元の本文\n');
  const coordinator = createNewDocumentCoordinator({
    ...f,
    recordAction: async () => ({ recorded: true }),
  });
  const pending = await coordinator.proposeAppend({
    request: '青い計画書に追記して',
    proposal: { ...proposal, body: '追加本文' },
  });
  await writeFile(target, '別の操作で変わった本文\n');
  const result = await coordinator.confirm({
    ticketId: pending.ticket.ticketId,
    candidateId: pending.ticket.candidateId,
    confirmationToken: pending.ticket.confirmationToken,
  });
  assert.equal(result.status, 409);
  assert.equal(result.payload.reason, 'document_changed');
  assert.equal(await readFile(target, 'utf8'), '別の操作で変わった本文\n');
});

test('存在しない題名とシンボリックリンクを追記候補にしない', async (t) => {
  const f = await fixture(t);
  const coordinator = createNewDocumentCoordinator({ ...f });
  await assert.rejects(() => coordinator.proposeAppend({
    request: '存在しない文書へ追記して',
    proposal: { ...proposal, title: '存在しない文書' },
  }), (error) => error?.code === 'DOCUMENT_NOT_FOUND');

  await mkdir(f.root, { recursive: true });
  const outside = path.join(f.allowedParent, 'outside.md');
  await writeFile(outside, '外側\n');
  await symlink(outside, path.join(f.root, '青い計画書.md'));
  await assert.rejects(() => coordinator.proposeAppend({
    request: '青い計画書へ追記して',
    proposal,
  }));
  assert.equal(await readFile(outside, 'utf8'), '外側\n');
});

test('同名文書は上書きせず、取消時もファイルを作らない', async (t) => {
  const f = await fixture(t);
  await mkdir(f.root, { recursive: true });
  const target = path.join(f.root, '青い計画書.md');
  await writeFile(target, '既存の本文\n');
  const states = [];
  const duplicate = createNewDocumentCoordinator({
    ...f,
    recordAction: async ({ state }) => { states.push(state); return { recorded: true }; },
  });
  const pending = duplicate.propose({ request, proposal });
  const result = await duplicate.confirm({
    ticketId: pending.ticket.ticketId,
    candidateId: pending.ticket.candidateId,
    confirmationToken: pending.ticket.confirmationToken,
  });
  assert.equal(result.status, 409);
  assert.equal(result.payload.reason, 'already_exists');
  assert.equal(await readFile(target, 'utf8'), '既存の本文\n');

  const cancelRoot = path.join(f.allowedParent, '取消用');
  const cancelled = createNewDocumentCoordinator({
    root: cancelRoot,
    allowedParent: f.allowedParent,
    recordAction: async ({ state }) => { states.push(state); return { recorded: true }; },
  });
  const cancelPending = cancelled.propose({ request, proposal: { ...proposal, title: '取消文書' } });
  const cancelResult = await cancelled.cancel({
    ticketId: cancelPending.ticket.ticketId,
    candidateId: cancelPending.ticket.candidateId,
    confirmationToken: cancelPending.ticket.confirmationToken,
  });
  assert.equal(cancelResult.status, 200);
  await assert.rejects(() => access(path.join(cancelRoot, '取消文書.md')));
  assert.deepEqual(states, ['already_exists', 'cancelled']);
});

test('許可親フォルダから外へ向くシンボリックリンクには何も作らない', async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'rokid-new-document-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(f.allowedParent, '作成文書'));
  const coordinator = createNewDocumentCoordinator({
    ...f,
    recordAction: async () => ({ recorded: true }),
  });
  const pending = coordinator.propose({ request, proposal });
  const result = await coordinator.confirm({
    ticketId: pending.ticket.ticketId,
    candidateId: pending.ticket.candidateId,
    confirmationToken: pending.ticket.confirmationToken,
  });
  assert.equal(result.status, 500);
  await assert.rejects(() => access(path.join(outside, '私のAI')));
});
