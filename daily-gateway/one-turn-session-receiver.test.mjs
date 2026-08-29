import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { createOneTurnSessionReceiver } from './one-turn-session-receiver.mjs';

function headers(bearer) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` };
}

async function start(options = {}) {
  const bearer = randomBytes(32).toString('hex');
  const receiver = createOneTurnSessionReceiver({ bearer, ttlMs: 15_000, ...options });
  const address = await receiver.listen();
  return { bearer, receiver, origin: `http://${address.host}:${address.port}` };
}

test('認証した自由な依頼一件へ分類なしで答える', async () => {
  let received = null;
  const session = await start({
    async agent(options) {
      received = options;
      return { answer: '読み取り結果から一文で答えました。', completed: true, unavailableReason: '' };
    },
  });
  try {
    let response = await fetch(`${session.origin}/v1/health`, { method: 'POST' });
    assert.equal(response.status, 401);
    response = await fetch(`${session.origin}/v1/health`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.bearer}` },
    });
    assert.deepEqual(await response.json(), { ok: true, ready: true, active: false });

    response = await fetch(`${session.origin}/v1/answer`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'one_turn_01', request: '最近の資料は読める？' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      requestId: 'one_turn_01',
      answer: '読み取り結果から一文で答えました。',
      completed: true,
      unavailableReason: '',
      requestHandledAs: 'free_one_turn',
      changed: false,
      ephemeral: true,
    });
    assert.equal(received.request, '最近の資料は読める?');
    assert.equal(received.signal.aborted, false);

    response = await fetch(`${session.origin}/v1/answer`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'one_turn_02', request: 'もう一件' }),
    });
    assert.equal(response.status, 409);
  } finally {
    await session.receiver.close();
  }
});

test('同じ要求IDの取消だけが実行中の回答を止める', async () => {
  let receivedSignal = null;
  const session = await start({
    agent({ signal }) {
      receivedSignal = signal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true }));
    },
  });
  try {
    const pending = fetch(`${session.origin}/v1/answer`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'one_cancel_01', request: '資料を確認して' }),
    });
    while (!receivedSignal) await new Promise((resolve) => setTimeout(resolve, 5));
    let response = await fetch(`${session.origin}/v1/cancel`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'wrong_cancel_01' }),
    });
    assert.equal(response.status, 409);
    response = await fetch(`${session.origin}/v1/cancel`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'one_cancel_01' }),
    });
    assert.equal(response.status, 200);
    assert.equal(receivedSignal.aborted, true);
    assert.equal((await pending).status, 409);
  } finally {
    await session.receiver.close();
  }
});

test('不正な本文と処理失敗を無変更で閉じる', async () => {
  const invalid = await start({ agent: async () => assert.fail('agent must not run') });
  try {
    const response = await fetch(`${invalid.origin}/v1/answer`, {
      method: 'POST', headers: headers(invalid.bearer),
      body: JSON.stringify({ requestId: 'one_bad_01', request: '質問', target: '余分' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).changed, false);
  } finally {
    await invalid.receiver.close();
  }

  const failed = await start({ agent: async () => { throw new Error('sensitive details'); } });
  try {
    const response = await fetch(`${failed.origin}/v1/answer`, {
      method: 'POST', headers: headers(failed.bearer),
      body: JSON.stringify({ requestId: 'one_fail_01', request: '資料を確認して' }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.changed, false);
    assert.match(body.message, /何も変更していません/);
    assert.doesNotMatch(JSON.stringify(body), /sensitive/);
  } finally {
    await failed.receiver.close();
  }
});

test('受け口は一問一答だけで録音・保存・分類を持たない', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./one-turn-session-receiver.mjs', import.meta.url), 'utf8');
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /answerOneTurn/);
  assert.match(source, /free_one_turn/);
  assert.doesNotMatch(source, /intent|routeDailyUtterance|voice_note|web_research_note/);
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|RecorderManager|RECORD_AUDIO/);
});
