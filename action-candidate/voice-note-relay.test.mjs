import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { candidateFromTranscript, createVoiceNoteRelay } from './voice-note-relay.mjs';

const audioHeaders = (token, requestId = 'voice_note_01') => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/octet-stream',
  'x-request-id': requestId,
  'x-audio-format': 'pcm_s16le',
  'x-sample-rate': '16000',
  'x-channels': '1',
});

test('認識した原文をAIで言い換えず保存候補にする', () => {
  const text = '安全装置ばかりでなく、実際に使えるものを優先する。';
  const candidate = candidateFromTranscript(text, { candidateId: 'candidate-voice-1' });
  assert.equal(candidate.payloadPreview, text);
  assert.equal(candidate.actionType, 'create_or_append_note');
  assert.equal(candidate.targetHint, 'Rokid個人AIの試用メモ');
});

test('一回の音声認識後に同じ文章を表示し、確認後だけ保存する', async () => {
  const token = randomBytes(32).toString('hex');
  const applied = [];
  const decisions = [];
  const relay = createVoiceNoteRelay({
    token,
    ttlMs: 15_000,
    confirmationTtlMs: 10_000,
    async transcribe() {
      return { text: '発話した文章を、そのまま保存する。', elapsedMs: 1 };
    },
    async apply(candidate, decision) {
      applied.push({ candidate, decision });
      return { applied: true, changed: true, state: 'saved', text: '試用メモへ保存しました' };
    },
    onDecision(decision) { decisions.push(decision); },
  });
  const address = await relay.listen();
  const base = `http://${address.host}:${address.port}`;
  try {
    const audio = await fetch(`${base}/v1/transcribe`, {
      method: 'POST', headers: audioHeaders(token), body: Buffer.from([0, 0]),
    });
    assert.equal(audio.status, 200);
    const preview = await audio.json();
    assert.equal(preview.text, '発話した文章を、そのまま保存する。');
    assert.equal(applied.length, 0);

    const confirmed = await fetch(`${base}/v1/confirm-note`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ticketId: preview.ticketId,
        candidateId: preview.candidateId,
        confirmationToken: preview.confirmationToken,
      }),
    });
    assert.equal(confirmed.status, 200);
    const result = await confirmed.json();
    assert.equal(result.applied, true);
    assert.equal(result.changed, true);
    assert.equal(applied[0].candidate.payloadPreview, preview.text);
    assert.equal(decisions[0].transcript, preview.text);
  } finally { await relay.close(); }
});

test('確認前、別チケット、二重確認では保存しない', async () => {
  const token = randomBytes(32).toString('hex');
  let applyCount = 0;
  const relay = createVoiceNoteRelay({
    token,
    ttlMs: 15_000,
    async transcribe() { return { text: '一件だけ保存する', elapsedMs: 1 }; },
    async apply() { applyCount += 1; return { applied: true, changed: true }; },
  });
  const address = await relay.listen();
  const base = `http://${address.host}:${address.port}`;
  try {
    const before = await fetch(`${base}/v1/confirm-note`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(before.status, 409);
    const preview = await (await fetch(`${base}/v1/transcribe`, {
      method: 'POST', headers: audioHeaders(token), body: Buffer.from([0, 0]),
    })).json();
    const wrong = await fetch(`${base}/v1/confirm-note`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: preview.ticketId, candidateId: preview.candidateId, confirmationToken: 'wrong' }),
    });
    assert.equal(wrong.status, 409);
    assert.equal(applyCount, 0);
    const ticket = JSON.stringify({ ticketId: preview.ticketId, candidateId: preview.candidateId, confirmationToken: preview.confirmationToken });
    assert.equal((await fetch(`${base}/v1/confirm-note`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: ticket })).status, 200);
    assert.equal((await fetch(`${base}/v1/confirm-note`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: ticket })).status, 409);
    assert.equal(applyCount, 1);
  } finally { await relay.close(); }
});
