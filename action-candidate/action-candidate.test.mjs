import assert from 'node:assert/strict';
import test from 'node:test';

import { buildActionCandidate, validateActionCandidate } from './action-candidate.mjs';

function validNote(overrides = {}) {
  return {
    disposition: 'propose_action',
    action_type: 'create_or_append_note',
    summary: 'Rokid個人AIの実音声成功を記録する候補',
    target_scope: 'obsidian',
    target_hint: 'Rokid個人AIの検証記録',
    payload_preview: '利用者の実音声からObsidian回答をRV101へ戻す一往復に合格した。',
    risk: 'low',
    confirmation_required: true,
    unresolved_questions: [],
    reason: '後で進捗を振り返れるよう記録を残す依頼だから',
    ...overrides,
  };
}

test('自由文を実行不能な確認前候補として返す', async () => {
  let prompt = '';
  const result = await buildActionCandidate({
    utterance: '今日のRokid個人AIの実音声成功を、あとで振り返れるようにメモしておいて',
    modelRunner: async (request) => {
      prompt = request.prompt;
      assert.equal(request.stage, 'action-candidate');
      return { value: validNote(), audit: { model: 'gpt-5.6-luna', toolUse: false } };
    },
  });
  assert.match(prompt, /単語一致や固定コマンドではなく/);
  assert.equal(result.disposition, 'propose_action');
  assert.equal(result.actionType, 'create_or_append_note');
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.allowedNextStep, 'preview_only');
  assert.equal(result.executionCapability, 'none');
  assert.equal(result.changed, false);
  assert.match(result.sourceTextSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /メモしておいて/);
});

test('AIが確認不要とした操作候補を拒否する', () => {
  assert.throws(
    () => validateActionCandidate(validNote({ confirmation_required: false })),
    /requires confirmation/,
  );
});

test('公開・削除・購入・予定登録を低危険度にはできない', () => {
  for (const actionType of ['send_or_publish', 'delete', 'purchase', 'schedule']) {
    assert.throws(
      () => validateActionCandidate(validNote({ action_type: actionType, risk: 'low' })),
      /risk must be at least high/,
    );
  }
});

test('対象ヒントへ絶対パスやURIを混ぜられない', () => {
  assert.throws(
    () => validateActionCandidate(validNote({ target_hint: '/outside/allowed/secret.md' })),
    /human-readable hint/,
  );
  assert.throws(
    () => validateActionCandidate(validNote({ target_hint: 'https://example.com' })),
    /human-readable hint/,
  );
});

test('曖昧な依頼は操作候補にせず確認事項として返せる', async () => {
  const result = await buildActionCandidate({
    utterance: 'さっきのことをいい感じにしておいて',
    modelRunner: async () => ({
      value: {
        disposition: 'clarify',
        action_type: 'none',
        summary: '対象と希望する処理が不明',
        target_scope: 'unknown',
        target_hint: '',
        payload_preview: '',
        risk: 'none',
        confirmation_required: false,
        unresolved_questions: ['何を、どこへ、どう残したいですか？'],
        reason: '対象と操作内容を特定できないため',
      },
      audit: { model: 'gpt-5.6-luna', toolUse: false },
    }),
  });
  assert.equal(result.disposition, 'clarify');
  assert.equal(result.executionCapability, 'none');
  assert.equal(result.changed, false);
});
