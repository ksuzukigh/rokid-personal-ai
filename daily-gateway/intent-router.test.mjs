import assert from 'node:assert/strict';
import test from 'node:test';

import { routeDailyUtterance, validateIntentRoute } from './intent-router.mjs';

function modelValue(intent, overrides = {}) {
  const defaults = {
    voice_note: {
      summary: '会議で決まったことを音声メモとして残す',
      confirmation_required: true,
      recording_consent_required: true,
      clarifying_question: '',
      reason: '本人がこれから話す内容をメモへ保存したい依頼だから',
    },
    personal_knowledge_question: {
      summary: '本人の資料からRokid開発の現在地を答える',
      confirmation_required: false,
      recording_consent_required: false,
      clarifying_question: '',
      reason: '本人の過去の記録についての読み取り専用質問だから',
    },
    web_research_note: {
      summary: 'Rokidの最新情報をWeb調査して出典付きで保存する',
      confirmation_required: true,
      recording_consent_required: false,
      clarifying_question: '',
      reason: '新しいWeb情報の調査と結果保存を求めているから',
    },
    needs_clarification: {
      summary: '対象と希望する処理が不明',
      confirmation_required: false,
      recording_consent_required: false,
      clarifying_question: '何を、質問・音声メモ・Web調査のどれで進めますか？',
      reason: '指示語だけで安全に一つの進路を決められないから',
    },
    unsupported: {
      summary: '対応範囲外の公開操作',
      confirmation_required: false,
      recording_consent_required: false,
      clarifying_question: '',
      reason: '公開は現在の三機能に含まれないから',
    },
  };
  return { intent, ...defaults[intent], ...overrides };
}

const cases = [
  ['今日の会議で決まったことを、そのままメモして', 'voice_note', 'voice_note_consent'],
  ['私のRokid作りは今どこまで進んでる？', 'personal_knowledge_question', 'knowledge_readonly'],
  ['Rokidの最新情報をWebで調べて、出典付きで保存して', 'web_research_note', 'web_research_preview'],
  ['それをやって', 'needs_clarification', 'clarification'],
  ['この内容をFacebookへ公開して', 'unsupported', 'none'],
];

for (const [utterance, intent, allowedNextStep] of cases) {
  test(`自由文を${intent}へ振り分ける`, async () => {
    let prompt = '';
    const result = await routeDailyUtterance({
      utterance,
      modelRunner: async (request) => {
        prompt = request.prompt;
        assert.equal(request.stage, 'daily-intent-route');
        return { value: modelValue(intent), audit: { model: 'gpt-5.6-luna', toolUse: false } };
      },
    });
    assert.match(prompt, /固定文や単語一致ではなく/);
    assert.match(prompt, /録音も保存も検索も実行しません/);
    assert.equal(result.intent, intent);
    assert.equal(result.allowedNextStep, allowedNextStep);
    assert.equal(result.executionCapability, 'none');
    assert.equal(result.changed, false);
    assert.match(result.sourceTextSha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(utterance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('音声メモから保存確認も新しい録音同意も省けない', () => {
  assert.throws(
    () => validateIntentRoute(modelValue('voice_note', { confirmation_required: false })),
    /save confirmation/,
  );
  assert.throws(
    () => validateIntentRoute(modelValue('voice_note', { recording_consent_required: false })),
    /new recording consent/,
  );
});

test('Web調査メモから保存確認を省けない', () => {
  assert.throws(
    () => validateIntentRoute(modelValue('web_research_note', { confirmation_required: false })),
    /save confirmation/,
  );
});

test('読み取り専用質問へ保存確認や録音同意を混ぜられない', () => {
  assert.throws(
    () => validateIntentRoute(modelValue('personal_knowledge_question', { confirmation_required: true })),
    /cannot request execution confirmation/,
  );
  assert.throws(
    () => validateIntentRoute(modelValue('personal_knowledge_question', { recording_consent_required: true })),
    /only voice_note/,
  );
});

test('曖昧な依頼は確認質問なしに進められない', () => {
  assert.throws(
    () => validateIntentRoute(modelValue('needs_clarification', { clarifying_question: '' })),
    /requires a clarifying question/,
  );
});
