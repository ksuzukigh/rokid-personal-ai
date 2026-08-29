import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfirmationTicketStore } from '../action-candidate/confirmation-ticket.mjs';
import {
  createGoogleDriveCandidate,
  createGoogleDriveClient,
  GOOGLE_DRIVE_TARGET_HINT,
  normalizeGoogleDriveProposal,
  saveDocumentToGoogleDrive,
} from './google-drive-action.mjs';
import { createNewDocumentCoordinator } from './new-document-action.mjs';

const request = 'Google Driveに青い計画書を保存して';
const proposal = {
  title: '青い計画書',
  body: '目的は、安全にGoogle Driveへ保存することです。',
  targetHint: GOOGLE_DRIVE_TARGET_HINT,
};

function ticketInput(pending) {
  return {
    ticketId: pending.ticket.ticketId,
    candidateId: pending.ticket.candidateId,
    confirmationToken: pending.ticket.confirmationToken,
  };
}

test('Google Driveの専用保存先・題名・本文を一つの未実行候補へ結び付ける', () => {
  assert.deepEqual(normalizeGoogleDriveProposal(proposal), {
    ...proposal,
    documentText: '題名: 青い計画書\n\n本文:\n目的は、安全にGoogle Driveへ保存することです。\n',
  });
  const candidate = createGoogleDriveCandidate({ request, proposal, candidateId: 'drive-candidate-1' });
  assert.equal(candidate.actionType, 'save_document_to_google_drive');
  assert.equal(candidate.targetScope, 'google_drive');
  assert.equal(candidate.confirmationRequired, true);
  assert.equal(candidate.changed, false);
  assert.throws(() => normalizeGoogleDriveProposal({ ...proposal, targetHint: 'マイドライブ' }), /not allowed/);
  assert.throws(() => normalizeGoogleDriveProposal({ ...proposal, title: '../別名' }), /title is invalid/);
});

test('Rokid確認後だけ専用フォルダへGoogleドキュメントを一件作り、IDと本文を読み戻す', async () => {
  const store = new ConfirmationTicketStore({ ttlMs: 120_000, executionTtlMs: 15_000 });
  const candidate = createGoogleDriveCandidate({ request, proposal });
  const ticket = store.issue(candidate);
  assert.equal(store.confirm(ticket).accepted, true);
  const authorization = store.claimSaveGoogleDriveDocument({
    ticketId: ticket.ticketId,
    executionId: 'drive-execution-1',
    candidate,
  });
  const calls = [];
  let items = [];
  const result = await saveDocumentToGoogleDrive(candidate, authorization, {
    googleDriveFolderId: 'folder_test_12345',
    googleDriveClient: {
      async listFolder(folderId) { calls.push(['list', folderId]); return items; },
      async createGoogleDoc(input) {
        calls.push(['create', input]);
        items = [{ name: input.name, id: 'created_file_12345' }];
        return { id: 'created_file_12345' };
      },
      async getGoogleDocContent(documentId) {
        calls.push(['read', documentId]);
        return '目的は、安全にGoogle Driveへ保存することです。';
      },
    },
  });
  assert.equal(result.state, 'saved_to_google_docs');
  assert.equal(result.fileId, 'created_file_12345');
  assert.match(result.contentSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(calls, [
    ['list', 'folder_test_12345'],
    ['create', {
      name: '青い計画書',
      content: '目的は、安全にGoogle Driveへ保存することです。',
      parentFolderId: 'folder_test_12345',
    }],
    ['list', 'folder_test_12345'],
    ['read', 'created_file_12345'],
  ]);
});

test('同名ファイル、候補差し替え、確認の再利用ではDriveを変更しない', async () => {
  const actions = [];
  let createCalls = 0;
  const coordinator = createNewDocumentCoordinator({
    googleDriveFolderId: 'folder_test_12345',
    googleDriveClient: {
      async listFolder() { return [{ name: '青い計画書', id: 'existing_file_1' }]; },
      async createGoogleDoc() { createCalls += 1; return { id: 'should_not_exist' }; },
      async getGoogleDocContent() { throw new Error('must not read'); },
    },
    recordAction: async (entry) => { actions.push(entry); },
  });
  const pending = coordinator.proposeGoogleDrive({ request, proposal });
  const result = await coordinator.confirm(ticketInput(pending));
  assert.equal(result.status, 409);
  assert.equal(result.payload.reason, 'already_exists');
  assert.equal(createCalls, 0);
  assert.deepEqual(actions, [{
    operation: 'save_document_to_google_drive', title: '青い計画書', state: 'already_exists',
  }]);
  assert.equal((await coordinator.confirm(ticketInput(pending))).status, 409);

  const store = new ConfirmationTicketStore({ ttlMs: 120_000, executionTtlMs: 15_000 });
  const candidate = createGoogleDriveCandidate({ request, proposal });
  const ticket = store.issue(candidate);
  store.confirm(ticket);
  assert.equal(store.claimSaveGoogleDriveDocument({
    ticketId: ticket.ticketId,
    executionId: 'drive-execution-mismatch',
    candidate: { ...candidate, payloadPreview: '題名: 差し替え\n\n本文:\n別本文\n' },
  }).reason, 'candidate_mismatch');
});

test('MCP応答は一覧・Google Docs作成・内容確認だけを受け取り、許可外の道具を呼ばない', async () => {
  const calls = [];
  const client = createGoogleDriveClient({
    async callGoogleDriveTool(name, args) {
      calls.push([name, args]);
      if (name === 'listFolder') return {
        content: [{ type: 'text', text: 'Contents of folder:\n\n📄 青い計画書.md (ID: file_12345)' }],
      };
      if (name === 'createGoogleDoc') {
        return { content: [{ type: 'text', text: 'Created Google Doc: 緑の計画書\nID: file_67890' }] };
      }
      return { content: [{ type: 'text', text: '緑の計画書の本文です。' }] };
    },
  });
  assert.deepEqual(await client.listFolder('folder_12345'), [{ name: '青い計画書.md', id: 'file_12345' }]);
  assert.deepEqual(await client.createGoogleDoc({
    name: '緑の計画書', content: '緑の計画書の本文です。', parentFolderId: 'folder_12345',
  }), { id: 'file_67890' });
  assert.equal(await client.getGoogleDocContent('file_67890'), '緑の計画書の本文です。');
  assert.deepEqual(calls.map(([name]) => name), ['listFolder', 'createGoogleDoc', 'getGoogleDocContent']);
});
