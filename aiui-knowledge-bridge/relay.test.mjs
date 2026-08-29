import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { createKnowledgeRelay, DEFAULT_QUESTION, normalizeSessionQuestion } from './relay.mjs';

function headers(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

test('固定質問一件だけを受け、160文字以内の根拠付き回答を返す', async () => {
  const token = randomBytes(32).toString('hex');
  let pipelineOptions = null;
  const relay = createKnowledgeRelay({
    token,
    ttlMs: 15000,
    async pipeline(options) {
      pipelineOptions = options;
      return {
        transmission: { sent: [{ id: 'S1' }], totalExcerptCharacters: 321 },
        answer: {
          text: 'Rokid Controlなどを開発し、RV101実機で表示と通信を確認しました。[S1]',
          citations: [{ sourceId: 'S1', path: '検証台帳.md', section: '確認済み' }],
        },
      };
    },
  });
  const address = await relay.listen();
  const origin = `http://${address.host}:${address.port}`;
  try {
    let response = await fetch(`${origin}/v1/health`, { method: 'POST' });
    assert.equal(response.status, 401);
    response = await fetch(`${origin}/v1/health`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.deepEqual(await response.json(), { ok: true, ready: true });

    response = await fetch(`${origin}/v1/ask`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ requestId: 'knowledge_bad_01', question: '今日の天気は？' }),
    });
    assert.equal(response.status, 400);

    response = await fetch(`${origin}/v1/ask`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ requestId: 'knowledge_ok_01', question: DEFAULT_QUESTION }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.requestId, 'knowledge_ok_01');
    assert.ok(body.answer.length <= 160);
    assert.deepEqual(body.sources, [{ sourceId: 'S1', path: '検証台帳.md', section: '確認済み' }]);
    assert.equal(pipelineOptions.answerCharacterLimit, 160);
    assert.equal(pipelineOptions.perFileLimit, 2);
    assert.equal(pipelineOptions.signal.aborted, false);

    response = await fetch(`${origin}/v1/ask`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ requestId: 'knowledge_ok_02', question: DEFAULT_QUESTION }),
    });
    assert.equal(response.status, 409);
  } finally {
    await relay.close();
  }
});

test('同じ要求IDの取消で実行中処理を停止する', async () => {
  const token = randomBytes(32).toString('hex');
  let receivedSignal = null;
  const relay = createKnowledgeRelay({
    token,
    ttlMs: 15000,
    pipeline: ({ signal }) => {
      receivedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  const address = await relay.listen();
  const origin = `http://${address.host}:${address.port}`;
  try {
    const pending = fetch(`${origin}/v1/ask`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ requestId: 'knowledge_cancel_01', question: DEFAULT_QUESTION }),
    });
    while (!receivedSignal) await new Promise((resolve) => setTimeout(resolve, 5));

    let response = await fetch(`${origin}/v1/cancel`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ requestId: 'wrong_cancel_01' }),
    });
    assert.equal(response.status, 409);
    assert.equal(receivedSignal.aborted, false);

    response = await fetch(`${origin}/v1/cancel`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ requestId: 'knowledge_cancel_01' }),
    });
    assert.equal(response.status, 200);
    assert.equal(receivedSignal.aborted, true);
    const original = await pending;
    assert.equal(original.status, 409);
    assert.equal((await original.json()).error, 'cancelled');
  } finally {
    await relay.close();
  }
});

test('セッション開始時に選んだ自由質問だけを一回受ける', async () => {
  const token = randomBytes(32).toString('hex');
  const expectedQuestion = 'ねえ、Rokidの個人AIづくり、今どこまで進んでいて次は何をするの？';
  let receivedQuestion = null;
  const relay = createKnowledgeRelay({
    token,
    expectedQuestion,
    ttlMs: 15000,
    async pipeline({ question }) {
      receivedQuestion = question;
      return {
        transmission: { sent: [{ id: 'S1' }], totalExcerptCharacters: 100 },
        answer: {
          text: '固定経路の一往復に合格し、次は自由な言い方の入口です。[S1]',
          citations: [{ sourceId: 'S1', path: '検証台帳.md', section: '確認済み' }],
        },
      };
    },
  });
  const address = await relay.listen();
  const origin = `http://${address.host}:${address.port}`;
  try {
    let response = await fetch(`${origin}/v1/ask`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ requestId: 'free_question_bad_01', question: DEFAULT_QUESTION }),
    });
    assert.equal(response.status, 400);

    response = await fetch(`${origin}/v1/ask`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ requestId: 'free_question_ok_01', question: expectedQuestion }),
    });
    assert.equal(response.status, 200);
    assert.equal(receivedQuestion, expectedQuestion);
  } finally {
    await relay.close();
  }
});

test('自由質問は長さと制御文字を拒否する', () => {
  assert.throws(() => normalizeSessionQuestion(''), /1 to 240/);
  assert.throws(() => normalizeSessionQuestion('a'.repeat(241)), /1 to 240/);
  assert.throws(() => normalizeSessionQuestion('一行目\n二行目'), /control characters/);
  assert.equal(normalizeSessionQuestion('  Ｒｏｋｉｄの進捗は？  '), 'Rokidの進捗は?');
});

test('受け口は固定保管庫、一回質問、読み取り専用パイプラインだけを持つ', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./relay.mjs', import.meta.url), 'utf8');
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /\/path\/to\/your\/ObsidianVault/);
  assert.match(source, /answerCharacterLimit: 160/);
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|renameSync|unlinkSync/);
  assert.doesNotMatch(source, /RECORD_AUDIO|RecorderManager|camera|purchase|delete/);
});
