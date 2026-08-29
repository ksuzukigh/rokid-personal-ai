import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConfirmationAix } from './prepare-confirmation-aix.mjs';

const candidate = {
  candidateId: 'candidate-001', sourceTextSha256: '1'.repeat(64), disposition: 'propose_action',
  actionType: 'create_or_append_note', targetScope: 'unknown', targetHint: 'Rokid個人AIの検証記録',
  payloadPreview: '今日、実音声で成功した。', risk: 'low', confirmationRequired: true,
  unresolvedQuestions: [], allowedNextStep: 'preview_only', executionCapability: 'none', changed: false,
};
const ticket = { ticketId: 'ticket-001', candidateId: 'candidate-001', confirmationToken: 'ticket-secret-001' };
const session = { origin: 'https://personal-ai.example.com', bearer: 'b'.repeat(64) };

test('RV101から確認・取消だけを送る一時AIXを作る', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'confirmation-aix-test-'));
  try {
    const output = path.join(work, 'confirmation.aix');
    const unpacked = path.join(work, 'unpacked');
    createConfirmationAix(candidate, ticket, session, output);
    execFileSync('/usr/bin/unzip', ['-qq', output, '-d', unpacked]);
    const page = await readFile(path.join(unpacked, 'pages/index/index.ink'), 'utf8');
    assert.match(page, /"origin":"https:\/\/personal-ai\.example\.com"/);
    assert.match(page, /SESSION\.origin\}\/v1\/confirm/);
    assert.match(page, /SESSION\.origin\}\/v1\/cancel/);
    assert.match(page, /Macが確認を受け取りました/);
    assert.match(page, /確認結果が不明です/);
    assert.match(page, /protectedResourceChanged === false/);
    assert.doesNotMatch(page, /Recorder|Audio|camera|FileSystem|writeFile|storage|purchase|publish/);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('固定名以外と実行能力あり候補を拒否する', () => {
  assert.throws(() => createConfirmationAix(candidate, ticket, { ...session, origin: 'https://example.com' }, '/tmp/rejected.aix'), /fixed/);
  assert.throws(() => createConfirmationAix({ ...candidate, executionCapability: 'write' }, ticket, session, '/tmp/rejected.aix'), /preview-only/);
});
