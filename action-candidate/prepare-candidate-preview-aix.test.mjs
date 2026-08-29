import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCandidatePreviewAix, makeCandidatePreview } from './prepare-candidate-preview-aix.mjs';

function candidate(overrides = {}) {
  return {
    disposition: 'propose_action',
    actionType: 'create_or_append_note',
    summary: 'Rokid個人AIの実音声成功を記録する候補',
    targetHint: 'Rokid個人AIの検証記録',
    payloadPreview: '実音声からRV101回答表示まで合格した。',
    risk: 'low',
    confirmationRequired: true,
    unresolvedQuestions: [],
    allowedNextStep: 'preview_only',
    executionCapability: 'none',
    changed: false,
    ...overrides,
  };
}

test('Luna候補だけを静的AIXへ入れ確認後も実行しない', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'candidate-preview-aix-test-'));
  const output = path.join(work, 'preview.aix');
  const unpacked = path.join(work, 'unpacked');
  try {
    createCandidatePreviewAix(candidate(), output);
    execFileSync('/usr/bin/unzip', ['-qq', output, '-d', unpacked]);
    const page = await readFile(path.join(unpacked, 'pages/index/index.ink'), 'utf8');
    const agents = await readFile(path.join(unpacked, 'AGENTS.md'), 'utf8');
    assert.match(page, /メモの候補/);
    assert.match(page, /まだ保存・実行していません/);
    assert.match(page, /保存・実行していません/);
    assert.match(page, /内容を確認しました/);
    assert.match(page, /event\.code === 'Enter' \|\| event\.code === 'GlobalHook'/);
    assert.doesNotMatch(page, /<button/);
    assert.doesNotMatch(page, /https?:|Bearer|token|wx\.|request\s*\(|Recorder|Audio|camera|FileSystem|writeFile|fetch\s*\(/);
    assert.match(agents, /通信、録音、保存、書き込み、外部操作を禁止/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('実行能力あり・変更済み・確認不要の候補をAIXへ入れない', () => {
  assert.throws(() => makeCandidatePreview(candidate({ executionCapability: 'write' })), /preview-only/);
  assert.throws(() => makeCandidatePreview(candidate({ changed: true })), /preview-only/);
  assert.throws(() => makeCandidatePreview(candidate({ confirmationRequired: false })), /require confirmation/);
});

test('曖昧な候補は保存先を決めず確認質問として表示する', () => {
  const preview = makeCandidatePreview(candidate({
    disposition: 'clarify',
    actionType: 'none',
    summary: '保存先を確認してください',
    targetHint: '',
    payloadPreview: '',
    confirmationRequired: false,
    unresolvedQuestions: ['どこに残しますか？'],
  }));
  assert.equal(preview.kind, '確認が必要');
  assert.equal(preview.target, '対象: 未決定');
  assert.equal(preview.payload, '要確認: どこに残しますか?');
});
