import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { createDailySessionReceiver, normalizeDailyUtterance } from './session-receiver.mjs';

function headers(bearer) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` };
}

async function start(options = {}) {
  const bearer = randomBytes(32).toString('hex');
  const receiver = createDailySessionReceiver({ bearer, ttlMs: 15_000, ...options });
  const address = await receiver.listen();
  return { bearer, receiver, origin: `http://${address.host}:${address.port}` };
}

test('認証した自由文一件だけを実行不能の行き先へ振り分ける', async () => {
  let received = null;
  const session = await start({
    async router(options) {
      received = options;
      return {
        intent: 'personal_knowledge_question',
        allowedNextStep: 'knowledge_readonly',
        summary: '本人資料から現在地を答える',
        confirmationRequired: false,
        recordingConsentRequired: false,
        clarifyingQuestion: '',
      };
    },
  });
  try {
    let response = await fetch(`${session.origin}/v1/health`, { method: 'POST' });
    assert.equal(response.status, 401);

    response = await fetch(`${session.origin}/v1/health`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.bearer}` },
    });
    assert.deepEqual(await response.json(), { ok: true, ready: true, active: false });

    const utterance = '私のRokid作りは今どこまで進んでる？';
    response = await fetch(`${session.origin}/v1/route`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'daily_route_01', utterance }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      ok: true,
      requestId: 'daily_route_01',
      intent: 'personal_knowledge_question',
      allowedNextStep: 'knowledge_readonly',
      summary: '本人資料から現在地を答える',
      confirmationRequired: false,
      recordingConsentRequired: false,
      clarifyingQuestion: '',
      executionCapability: 'none',
      changed: false,
    });
    assert.equal(received.utterance, '私のRokid作りは今どこまで進んでる?');
    assert.equal(received.signal.aborted, false);
    assert.doesNotMatch(JSON.stringify(body), /Rokid作り/);

    response = await fetch(`${session.origin}/v1/route`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'daily_route_02', utterance: 'もう一件' }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).changed, false);
  } finally {
    await session.receiver.close();
  }
});

test('同じ要求IDの取消だけが実行中のLuna分類を止める', async () => {
  let receivedSignal = null;
  const session = await start({
    router({ signal }) {
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
  try {
    const pending = fetch(`${session.origin}/v1/route`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'daily_cancel_01', utterance: '私の資料を調べて' }),
    });
    while (!receivedSignal) await new Promise((resolve) => setTimeout(resolve, 5));

    let response = await fetch(`${session.origin}/v1/cancel`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'wrong_cancel_01' }),
    });
    assert.equal(response.status, 409);
    assert.equal(receivedSignal.aborted, false);

    response = await fetch(`${session.origin}/v1/cancel`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'daily_cancel_01' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).changed, false);
    assert.equal(receivedSignal.aborted, true);
    const original = await pending;
    assert.equal(original.status, 409);
    assert.equal((await original.json()).error, 'cancelled');
  } finally {
    await session.receiver.close();
  }
});

test('不正な本文、余分な項目、長すぎる本文を無変更で拒否する', async () => {
  const session = await start({ router: async () => assert.fail('router must not run') });
  try {
    let response = await fetch(`${session.origin}/v1/route`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'daily_bad_01', utterance: '質問', target: '勝手な対象' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).changed, false);

    response = await fetch(`${session.origin}/v1/route`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'daily_bad_02', utterance: 'x'.repeat(2100) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).changed, false);
  } finally {
    await session.receiver.close();
  }
});

test('分類失敗時は無変更を明示して同じセッションを再利用しない', async () => {
  const session = await start({ router: async () => { throw new Error('sensitive details'); } });
  try {
    let response = await fetch(`${session.origin}/v1/route`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'daily_fail_01', utterance: '私の資料を調べて' }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.changed, false);
    assert.match(body.message, /何も変更していません/);
    assert.doesNotMatch(JSON.stringify(body), /sensitive/);

    response = await fetch(`${session.origin}/v1/route`, {
      method: 'POST', headers: headers(session.bearer),
      body: JSON.stringify({ requestId: 'daily_fail_02', utterance: '再試行' }),
    });
    assert.equal(response.status, 409);
  } finally {
    await session.receiver.close();
  }
});

test('自由文の長さと制御文字を境界で拒否する', () => {
  assert.throws(() => normalizeDailyUtterance(''), /1 to 500/);
  assert.throws(() => normalizeDailyUtterance('a'.repeat(501)), /1 to 500/);
  assert.throws(() => normalizeDailyUtterance('一行目\n二行目'), /control characters/);
  assert.equal(normalizeDailyUtterance('  Ｒｏｋｉｄの進捗は？  '), 'Rokidの進捗は?');
});

test('受け口はローカル待受と行き先判定だけを持ち、録音・保存・外部操作を持たない', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./session-receiver.mjs', import.meta.url), 'utf8');
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /routeDailyUtterance/);
  assert.match(source, /executionCapability: 'none'/);
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|RecorderManager|RECORD_AUDIO/);
  assert.doesNotMatch(source, /runKnowledgePipeline|runWebResearch|applyConfirmed|purchase|send_or_publish/);
});
