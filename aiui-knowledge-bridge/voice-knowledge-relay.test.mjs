import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  createVoiceKnowledgeProcessor,
  createVoiceKnowledgeRelay,
} from './voice-knowledge-relay.mjs';

test('Mac内文字起こしの自由質問を既存の読み取り専用知識経路へ渡す', async () => {
  const calls = [];
  const processor = createVoiceKnowledgeProcessor({
    async transcribe(pcm, { signal }) {
      calls.push({ stage: 'transcribe', pcm: Buffer.from(pcm), signal });
      return { text: ' 今日の予定を教えて。 ', elapsedMs: 1200 };
    },
    async pipeline(options) {
      calls.push({ stage: 'pipeline', options });
      return { answer: { text: '今日は夕方に予定が1件あります。' } };
    },
  });
  const signal = new AbortController().signal;
  const result = await processor(Buffer.from([0, 0, 1, 0]), { signal });

  assert.equal(result.text, '今日は夕方に予定が1件あります。');
  assert.deepEqual(calls[0].pcm, Buffer.from([0, 0, 1, 0]));
  assert.equal(calls[1].options.question, '今日の予定を教えて。');
  assert.equal(calls[1].options.vaultPath, '/path/to/your/ObsidianVault');
  assert.equal(calls[1].options.answerCharacterLimit, 160);
  assert.equal(calls[1].options.signal, signal);
});

test('空文字・長文・制御文字の認識結果は知識検索前に拒否する', async () => {
  const invalid = ['', 'あ'.repeat(241), '予定を\n教えて'];
  for (const text of invalid) {
    let pipelineCalled = false;
    const processor = createVoiceKnowledgeProcessor({
      async transcribe() { return { text, elapsedMs: 1 }; },
      async pipeline() {
        pipelineCalled = true;
        return { answer: { text: '呼ばれない' } };
      },
    });
    await assert.rejects(() => processor(Buffer.from([0, 0])));
    assert.equal(pipelineCalled, false);
  }
});

test('160文字を超える回答をRokidへ返さない', async () => {
  const processor = createVoiceKnowledgeProcessor({
    async transcribe() { return { text: '進捗を教えて', elapsedMs: 1 }; },
    async pipeline() { return { answer: { text: '答'.repeat(161) } }; },
  });
  await assert.rejects(
    () => processor(Buffer.from([0, 0])),
    /knowledge answer must be 1 to 160 characters/,
  );
});

test('取消シグナルを文字起こしと知識経路へ引き継ぐ', async () => {
  const controller = new AbortController();
  const processor = createVoiceKnowledgeProcessor({
    async transcribe(_pcm, { signal }) {
      assert.equal(signal, controller.signal);
      controller.abort();
      return { text: '進捗を教えて', elapsedMs: 1 };
    },
    async pipeline() {
      assert.fail('pipeline must not run after cancellation');
    },
  });
  await assert.rejects(
    () => processor(Buffer.from([0, 0]), { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('認証済みPCM一件だけを受け、二件目を拒否する', async () => {
  const token = randomBytes(32).toString('hex');
  const relay = createVoiceKnowledgeRelay({
    token,
    ttlMs: 15000,
    async transcribe() { return { text: '進捗を教えて', elapsedMs: 1 }; },
    async pipeline() { return { answer: { text: '自由発話の手前まで準備済みです。' } }; },
  });
  const address = await relay.listen();
  const url = `http://${address.host}:${address.port}/v1/transcribe`;
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/octet-stream',
    'x-request-id': 'voice_test_01',
    'x-audio-format': 'pcm_s16le',
    'x-sample-rate': '16000',
    'x-channels': '1',
  };
  try {
    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer wrong' },
      body: Buffer.from([0, 0]),
    });
    assert.equal(unauthorized.status, 401);

    const accepted = await fetch(url, {
      method: 'POST',
      headers,
      body: Buffer.from([0, 0]),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      ok: true,
      requestId: 'voice_test_01',
      text: '自由発話の手前まで準備済みです。',
    });

    const second = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'x-request-id': 'voice_test_02' },
      body: Buffer.from([0, 0]),
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, 'batch_complete');
  } finally {
    await relay.close();
  }
});
