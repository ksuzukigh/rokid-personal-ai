import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createConversationActionRecorder,
  createConversationRecorder,
  normalizeConversationRecord,
} from './conversation-log.mjs';
import './codex-conversation-session.test.mjs';

test('私とAIの発言をJSTの日付ファイルへ追記する', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'rokid-conversation-log-'));
  const root = path.join(work, '会話記録', '私のAI');
  const record = createConversationRecorder({
    root,
    allowedParent: work,
    now: () => new Date('2026-08-25T06:34:56.000Z'),
  });
  try {
    const first = await record({
      request: '青い計画書の概要は?',
      answer: '概要は三点あります。',
      usedPreviousTurn: false,
      completed: true,
    });
    await record({
      request: 'その一点目は?',
      answer: '一点目は安全性です。',
      usedPreviousTurn: true,
      completed: true,
    });
    assert.equal(first.date, '2026-08-25');
    const text = await readFile(path.join(root, '2026-08-25.md'), 'utf8');
    assert.equal((text.match(/^# 私のAI 会話記録/gm) ?? []).length, 1);
    assert.equal((text.match(/^## 15:34:56/gm) ?? []).length, 2);
    assert.match(text, /私: 青い計画書の概要は\?/);
    assert.match(text, /AI: 概要は三点あります。/);
    assert.match(text, /状態: 完了/);
    assert.doesNotMatch(text, /質問:|回答:/);
    assert.match(text, /直前の会話: 参照した/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('原音、改行、利用者指定の保存先を会話記録に入れない', () => {
  assert.deepEqual(normalizeConversationRecord({
    request: '質問', answer: '回答', usedPreviousTurn: false, completed: true,
  }), {
    request: '質問', answer: '回答', usedPreviousTurn: false, completed: true,
  });
  assert.throws(() => normalizeConversationRecord({
    request: '質問\n改行', answer: '回答', usedPreviousTurn: false, completed: true,
  }), /control characters/);
  assert.throws(() => normalizeConversationRecord({
    request: '質問', answer: '回答', usedPreviousTurn: 'yes', completed: true,
  }), /must be boolean/);
});

test('許可フォルダ外へ向くシンボリックリンクを拒否する', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'rokid-conversation-symlink-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'rokid-conversation-outside-'));
  const root = path.join(work, '会話記録');
  try {
    await symlink(outside, root);
    const record = createConversationRecorder({ root, allowedParent: work });
    await assert.rejects(() => record({
      request: '質問', answer: '回答', usedPreviousTurn: false, completed: true,
    }), /symbolic link|outside/);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('新規文書の保存・取消結果を会話記録へ追記する', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'rokid-conversation-action-'));
  const root = path.join(work, '会話記録', '私のAI');
  const record = createConversationActionRecorder({
    root,
    allowedParent: work,
    now: () => new Date('2026-08-25T07:00:00.000Z'),
  });
  try {
    await record({ title: '青い計画書', state: 'saved' });
    await record({ title: '赤い計画書', state: 'cancelled' });
    await record({ operation: 'append_document', title: '青い計画書', state: 'appended' });
    await record({
      operation: 'replace_document_text', title: '検証台帳', state: 'text_replaced',
    });
    await record({
      operation: 'save_document_to_google_drive', title: '緑の計画書', state: 'saved_to_google_docs',
    });
    const text = await readFile(path.join(root, '2026-08-25.md'), 'utf8');
    assert.match(text, /新規文書「青い計画書」/);
    assert.match(text, /結果: 保存しました/);
    assert.match(text, /結果: 取り消しました/);
    assert.match(text, /既存文書への追記「青い計画書」/);
    assert.match(text, /結果: 追記しました/);
    assert.match(text, /既存文書の一箇所変更「検証台帳」/);
    assert.match(text, /結果: 一箇所を変更しました/);
    assert.match(text, /Googleドキュメントの新規保存「緑の計画書」/);
    assert.match(text, /結果: Googleドキュメントとして保存しました/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
